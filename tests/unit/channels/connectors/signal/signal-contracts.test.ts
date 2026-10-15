import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  SignalConfigSchema,
  parseSignalConfig,
  SIGNAL_BRIDGE_VERSION,
  SIGNAL_MAX_CHUNK_BYTES,
} from '../../../../../src/channels/connectors/signal/signal-config.js';
import {
  normalizeSignalUuid,
  normalizeSignalGroupId,
  signalGroupIdFromBase64url,
  signalGroupIdToBase64url,
  formatSignalExternalId,
  parseSignalExternalId,
  type SignalDestination,
} from '../../../../../src/channels/connectors/signal/signal-identities.js';
import type {
  SignalAccountProofSnapshot,
  SignalChunkReceipt,
  SignalInboundEvent,
  SignalPreparedDelivery,
} from '../../../../../src/channels/connectors/signal/signal-types.js';
import type {
  AgentOutput,
  ChannelConnector,
  InboundReceiptHandler,
  TrustedDeliveryContext,
} from '../../../../../src/channels/channel-types.js';
import { ok } from '../../../../../src/core/types/result.js';

// Source citations below are pinned to signal-cli v0.14.9, commit
// 3997429779095ff3a2d64c877126e84fce9852aa, not live-device evidence.
const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const peerUuid = 'cccccccc-1111-2222-3333-dddddddddddd';
const config = {
  accountMode: 'personal',
  socketPath: '/run/signal/bridge.sock',
  account: accountUuid,
  accountUuid,
  deviceId: 3,
  deviceCreatedTimestamp: 200,
};

describe('SignalConfigSchema', () => {
  it('deduplicates normalized authorization UUIDs and canonical groups', () => {
    expect(
      SignalConfigSchema.parse({
        ...config,
        allowedDmPeers: [peerUuid, peerUuid.toUpperCase()],
        allowedSenders: [peerUuid.toUpperCase()],
        allowedGroups: ['+/8=', '+/8='],
      }),
    ).toMatchObject({
      allowedDmPeers: [peerUuid],
      allowedSenders: [peerUuid],
      allowedGroups: ['+/8='],
    });
  });

  it('supports dedicated primary devices and E.164 selectors without inventing registration flags', () => {
    // src/main/java/org/asamk/signal/commands/ListAccountsCommand.java:33-47: number/aci only.
    // src/main/java/org/asamk/signal/commands/ListDevicesCommand.java:47-67:
    // the current-device marker is plain CLI, not JSON.
    const parsed = SignalConfigSchema.parse({
      ...config,
      accountMode: 'dedicated',
      account: '+12025550123',
      deviceId: 1,
      deviceCreatedTimestamp: undefined,
    });
    expect(parsed.deviceId).toBe(1);
    expect(parsed.deviceCreatedTimestamp).toBeUndefined();
  });

  it.each([
    { accountMode: undefined },
    { accountMode: 'bot' },
    { socketPath: 'relative.sock' },
    { socketPath: '/run/a\0.sock' },
    { account: 'alice' },
    { account: '+0123' },
    { account: 'PNI:aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb' },
    { account: ` ${accountUuid}` },
    { accountUuid: '{aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb}' },
    { account: peerUuid },
    { deviceId: 0 },
    { deviceId: 1.2 },
    { deviceId: Number.MAX_SAFE_INTEGER + 1 },
    { deviceCreatedTimestamp: -1 },
    { triggerPrefix: '' },
    { triggerPrefix: '  ' },
    { allowedDmPeers: ['+12025550123'] },
    { allowedSenders: ['alice'] },
    { allowedGroups: ['-_8'] },
    { requestTimeoutMs: 999 },
    { requestTimeoutMs: 120_001 },
    { requestTimeoutMs: 1_000.1 },
    { reconnectBaseMs: 99 },
    { reconnectBaseMs: 60_001 },
    { reconnectMaxMs: 99 },
    { reconnectMaxMs: 300_001 },
    { reconnectBaseMs: 2_000, reconnectMaxMs: 1_000 },
  ])('rejects invalid field values without raw data in shared errors: %j', (change) => {
    const result = parseSignalConfig({ ...config, ...change });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe('Invalid Signal configuration');
      expect(result.error.cause).toBeUndefined();
    }
  });

  it.each([
    { requestTimeoutMs: 1_000, reconnectBaseMs: 100, reconnectMaxMs: 100 },
    { requestTimeoutMs: 120_000, reconnectBaseMs: 60_000, reconnectMaxMs: 300_000 },
  ])('accepts inclusive timing bounds: %j', (change) => {
    expect(parseSignalConfig({ ...config, ...change }).isOk()).toBe(true);
  });

  it('pins the reviewed protocol version and byte ceiling, not a semver range or character limit', () => {
    // src/main/java/org/asamk/signal/commands/VersionCommand.java:60-66 emits {version}; unknown is possible.
    // lib/src/main/java/org/asamk/signal/manager/config/ServiceConfig.java:24 and
    // lib/src/main/java/org/asamk/signal/manager/internal/ManagerImpl.java:947-959
    // promote >2000 UTF-8 bytes to attachment; this is not a JS string-length limit.
    expect(SIGNAL_BRIDGE_VERSION).toBe('0.14.9');
    expect(SIGNAL_MAX_CHUNK_BYTES).toBe(2_000);
    expect(Buffer.byteLength('😀'.repeat(500), 'utf8')).toBe(SIGNAL_MAX_CHUNK_BYTES);
  });
});

describe('Signal identity codecs', () => {
  it('normalizes UUID case without accepting non-ACI keys', () => {
    expect(normalizeSignalUuid(accountUuid.toUpperCase())._unsafeUnwrap()).toBe(accountUuid);
    for (const value of [
      null,
      1,
      '',
      ` ${accountUuid}`,
      `${accountUuid}\n`,
      `{${accountUuid}}`,
      `PNI:${accountUuid}`,
      '+12025550123',
    ]) {
      expect(normalizeSignalUuid(value).isErr()).toBe(true);
    }
  });

  it('separates canonical standard Base64 from unpadded Base64url', () => {
    // src/main/java/org/asamk/signal/json/JsonGroupInfo.java:9-15: wire groupId comes from toBase64().
    expect(normalizeSignalGroupId('+/8=')._unsafeUnwrap()).toBe('+/8=');
    expect(signalGroupIdToBase64url('+/8=')._unsafeUnwrap()).toBe('-_8');
    expect(signalGroupIdFromBase64url('-_8')._unsafeUnwrap()).toBe('+/8=');
    expect(normalizeSignalGroupId('YWJj').isOk()).toBe(true); // No padding required for 3 bytes.
  });

  it.each(['', 'Zg', 'Zh==', 'Zg===', 'Zg==\n', ' Zg==', '-_8=', '+/8', '====', 'a', '😀'])(
    'rejects noncanonical wire/config group ID %j',
    (value) => {
      expect(normalizeSignalGroupId(value).isErr()).toBe(true);
    },
  );

  it.each(['', '-_8=', '+/8', '-_9', 'Z', 'Zg\n', 'Zg=='])(
    'rejects noncanonical external group ID %j',
    (value) => {
      expect(signalGroupIdFromBase64url(value).isErr()).toBe(true);
    },
  );

  it('keeps account, self, peer and group routing distinct and round trips without phone numbers', () => {
    const destinations: SignalDestination[] = [
      { kind: 'self', accountUuid },
      { kind: 'dm', accountUuid, peerUuid },
      { kind: 'group', accountUuid, groupId: '+/8=' },
      { kind: 'self', accountUuid: peerUuid },
    ];
    const ids = destinations.map((destination) =>
      formatSignalExternalId(destination)._unsafeUnwrap(),
    );
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual([
      `signal:v1:${accountUuid}:self`,
      `signal:v1:${accountUuid}:dm:${peerUuid}`,
      `signal:v1:${accountUuid}:group:-_8`,
      `signal:v1:${peerUuid}:self`,
    ]);
    destinations.forEach((destination, index) =>
      expect(parseSignalExternalId(ids[index])._unsafeUnwrap()).toEqual(destination),
    );
    expect(parseSignalExternalId(ids[0], peerUuid)._unsafeUnwrapErr().reason).toBe(
      'ACCOUNT_MISMATCH',
    );
  });

  it.each([
    `signal:v2:${accountUuid}:self`,
    `signal:v1:${accountUuid.toUpperCase()}:self`,
    `signal:v1:${accountUuid}:self:extra`,
    `signal:v1:${accountUuid}:dm:+12025550123`,
    `signal:v1:${accountUuid}:group:-_8=`,
    'secret-envelope',
  ])('rejects malformed destinations with safe diagnostics', (input) => {
    const result = parseSignalExternalId(input);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe('Signal identity rejected: INVALID_DESTINATION');
      expect(result.error.cause).toBeUndefined();
    }
  });
});

describe('Signal shared type boundaries', () => {
  it('keeps receipt registration optional for ordinary connectors', async () => {
    const handler: InboundReceiptHandler = () => ok('accepted');
    expect(
      (
        await handler({
          channelType: 'signal',
          channelName: 'test',
          externalThreadId: 'test',
          senderId: 'test',
          idempotencyKey: 'test',
          content: 'test',
          timestamp: 1,
        })
      )._unsafeUnwrap(),
    ).toBe('accepted');
    expectTypeOf<ChannelConnector['onMessageWithReceipt']>().toEqualTypeOf<
      ((handler: InboundReceiptHandler) => void) | undefined
    >();
  });

  it('separates trusted output/proof/prepared contracts from RPC and model fields', () => {
    expectTypeOf<SignalInboundEvent['raw']>().toEqualTypeOf<undefined>();
    expectTypeOf<AgentOutput['trustedDelivery']>().toEqualTypeOf<
      TrustedDeliveryContext | undefined
    >();
    expectTypeOf<SignalPreparedDelivery['prepare']>().parameter(1).toEqualTypeOf<AgentOutput>();
    expectTypeOf<SignalChunkReceipt['acceptance']>().toEqualTypeOf<'complete'>();
    const proof: SignalAccountProofSnapshot = {
      accountUuid,
      accountMode: 'personal',
      bridgeDeviceId: 3,
      generation: 1,
      status: 'verified',
      verifiedAt: 100,
      expiresAt: 300_100,
      humanDevices: [{ deviceId: 1, createdTimestamp: 1 }],
    };
    expect(proof).not.toHaveProperty('isThisDevice');
    expect(proof).not.toHaveProperty('name');
  });
});
