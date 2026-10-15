import { describe, expect, it } from 'vitest';
import { SignalConfigSchema } from '../../../../../src/channels/connectors/signal/signal-config.js';
import {
  SignalDeviceRegistry,
  verifySignalDevices,
} from '../../../../../src/channels/connectors/signal/signal-device-registry.js';
import {
  evaluateSignalCandidate,
  normalizeSignalReceive,
  type SignalInboundContext,
} from '../../../../../src/channels/connectors/signal/signal-inbound-policy.js';

// Pinned signal-cli v0.14.9 / 3997429779095ff3a2d64c877126e84fce9852aa.
// Supplemental jsonrpc/SignalJsonRpcDispatcherHandler.java:164-199: manual params.subscription/result.
// JsonReceiveMessageHandler.java:23-35: account/envelope/exception.
// JsonMessageEnvelope.java:15-31,37-61: sourceUuid/sourceDevice can be null.
// JsonSyncMessage.java:20-35 + JsonSyncDataMessage.java:14-30: sent text is UNWRAPPED.
// JsonDataMessage.java:13-40: text/timestamp/timer/control field names.
// ListDevicesCommand.java:47-67: current marker only in plain output, not JSON.
// Supplemental pinned JsonGroupInfo.java:8-15: groupId is standard Base64; UPDATE vs DELIVER.
const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const peerUuid = 'cccccccc-1111-2222-3333-dddddddddddd';
const botUuid = 'eeeeeeee-1111-2222-3333-ffffffffffff';
const config = SignalConfigSchema.parse({
  accountMode: 'personal',
  socketPath: '/run/signal/bridge.sock',
  account: accountUuid,
  accountUuid,
  deviceId: 3,
  deviceCreatedTimestamp: 200,
  allowedDmPeers: [peerUuid],
  allowedSenders: [peerUuid],
  allowedGroups: ['+/8='],
});
const devices = [
  { id: 1, name: null, createdTimestamp: 1, lastSeenTimestamp: 500 },
  { id: 2, name: 'synthetic human', createdTimestamp: 100, lastSeenTimestamp: 500 },
  { id: 3, name: 'synthetic bridge', createdTimestamp: 200, lastSeenTimestamp: 500 },
];
function context(): SignalInboundContext {
  const registry = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
  registry.publish(verifySignalDevices(config, devices, 1, 1_000)._unsafeUnwrap())._unsafeUnwrap();
  return {
    config,
    channelName: 'signal-test',
    generation: 1,
    connectionGeneration: 1,
    subscription: 7,
    aliases: [accountUuid, '+12025550123'],
    registry: registry.snapshot(),
    now: 2_000,
  };
}
function receive(
  data: Record<string, unknown> = {},
  sourceUuid = accountUuid,
  sourceDevice: unknown = 2,
  sent = true,
): unknown {
  const message = { timestamp: 500, message: 'hello self', expiresInSeconds: 0, ...data };
  return {
    subscription: 7,
    result: {
      account: accountUuid,
      envelope: {
        sourceUuid,
        sourceDevice,
        timestamp: 999,
        ...(sent
          ? { syncMessage: { sentMessage: { destinationUuid: accountUuid, ...message } } }
          : { dataMessage: message }),
      },
    },
  };
}
function policy(input: unknown, ctx = context(), generation = 1) {
  return normalizeSignalReceive(input, generation, ctx).andThen((candidate) =>
    evaluateSignalCandidate(candidate, ctx),
  );
}

describe('Signal receive production admission boundary', () => {
  it('admits prefix-free personal human Note to Self and canonicalizes alternate wrappers to one key', () => {
    const sync = policy(receive())._unsafeUnwrap();
    const ordinary = policy(receive({}, accountUuid, 2, false))._unsafeUnwrap();
    expect(sync.kind).toBe('admit');
    expect(sync.event).toEqual(ordinary.event);
    expect(
      policy(receive(), { ...context(), channelName: 'renamed-channel' })._unsafeUnwrap().event
        .idempotencyKey,
    ).toBe(sync.event.idempotencyKey);
    expect(sync.event.content).toBe('hello self');
    expect(
      policy(receive({ message: '  original self text  ' }))._unsafeUnwrap().event.content,
    ).toBe('  original self text  ');
    expect(sync.event.timestamp).toBe(2_000);
    expect(sync.event.externalThreadId).toBe(`signal:v1:${accountUuid}:self`);
    expect(sync.event).not.toHaveProperty('raw');
    expect(sync.event).not.toHaveProperty('attachments');
    expect(Object.isFrozen(sync.event)).toBe(true);
    expect(Object.isFrozen(sync.candidate.destination)).toBe(true);
    expect(policy(receive({ timestamp: 501 }))._unsafeUnwrap().event.idempotencyKey).not.toBe(
      sync.event.idempotencyKey,
    );
  });

  it.each([
    ['  !talon do work', 'do work'],
    ['!talon\ndo work', 'do work'],
    ['!talonx nope', null],
    ['!Talon nope', null],
    ['!talon   ', null],
    ['hello', null],
  ])('selected incoming DM uses exact case-sensitive trigger: %j', (message, expected) => {
    const result = policy(receive({ message }, peerUuid, 1, false));
    if (expected === null) expect(result.isErr()).toBe(true);
    else expect(result._unsafeUnwrap().event.content).toBe(expected);
  });

  it('routes selected operator DM/group and incoming participants without using numbers or names', () => {
    const ctx = context();
    const dm = receive({ destinationUuid: peerUuid.toUpperCase(), message: '!talon self dm' });
    expect(policy(dm, ctx)._unsafeUnwrap().event.externalThreadId).toBe(
      `signal:v1:${accountUuid}:dm:${peerUuid}`,
    );
    const group = policy(
      receive(
        {
          message: '!talon group',
          groupInfo: { groupId: '+/8=', groupName: 'ignored', type: 'DELIVER', revision: 1 },
        },
        peerUuid,
        1,
        false,
      ),
    )._unsafeUnwrap();
    expect(group.event.externalThreadId).toBe(`signal:v1:${accountUuid}:group:-_8`);
    expect(group.event.senderId).toBe(peerUuid);
    expect(policy(receive({ message: '!talon x' }, botUuid, 1, false)).isErr()).toBe(true);
    expect(
      policy(receive({ message: '!talon x' }, peerUuid, 1, false), {
        ...ctx,
        config: { ...config, allowedSenders: [] },
      }).isErr(),
    ).toBe(true);
    expect(
      policy(receive({ destinationUuid: peerUuid, message: '!talon own' }), {
        ...ctx,
        config: { ...config, allowedDmPeers: [], allowedSenders: [] },
      }).isErr(),
    ).toBe(true);
  });

  it.each([
    'isExpirationUpdate',
    'isEndSession',
    'isProfileKeyUpdate',
    'groupCallUpdate',
    'reaction',
    'remoteDelete',
    'sticker',
    'storyContext',
    'pollCreate',
    'pollVote',
    'pollTerminate',
    'pinMessage',
    'unpinMessage',
    'adminDelete',
    'editMessage',
  ])('excludes %s before alias/proof quarantine', (field) => {
    const input = receive({
      [field]: field.startsWith('is') ? true : {},
      message: '!talon dangerous',
    });
    expect(policy(input)._unsafeUnwrapErr().reason).toBe('CONTROL');
  });

  it.each(['receiptMessage', 'typingMessage', 'callMessage', 'storyMessage', 'editMessage'])(
    'excludes envelope %s even beside ordinary text',
    (field) => {
      const input = {
        subscription: 7,
        result: {
          account: accountUuid,
          envelope: {
            sourceUuid: accountUuid,
            sourceDevice: 2,
            [field]: {},
            dataMessage: { timestamp: 500, message: 'ordinary', expiresInSeconds: 0 },
          },
        },
      };
      expect(policy(input)._unsafeUnwrapErr().reason).toBe('CONTROL');
    },
  );

  it('excludes group UPDATE, sync control and unselected groups before activation', () => {
    expect(
      policy(
        receive({
          groupInfo: { groupId: '+/8=', type: 'UPDATE', revision: 2 },
          message: '!talon update',
        }),
      )._unsafeUnwrapErr().reason,
    ).toBe('CONTROL');
    expect(
      policy(
        receive({
          groupInfo: { groupId: 'Zg==', type: 'DELIVER', revision: 1 },
          message: '!talon unselected',
        }),
      )._unsafeUnwrapErr().reason,
    ).toBe('UNSELECTED');
    expect(
      policy({
        subscription: 7,
        result: {
          account: accountUuid,
          envelope: { sourceUuid: accountUuid, sourceDevice: 2, syncMessage: { readMessages: [] } },
        },
      })._unsafeUnwrapErr().reason,
    ).toBe('CONTROL');
  });

  it.each([
    { expiresInSeconds: 10 },
    { viewOnce: true },
    { expiresInSeconds: undefined },
    { expiresInSeconds: -1 },
    { viewOnce: 'false' },
  ])('excludes ephemeral or unverifiable timers: %j', (data) => {
    expect(policy(receive(data)).isErr()).toBe(true);
  });

  it('ignores media-only, accepts accompanying ordinary text without attachment metadata', () => {
    expect(policy(receive({ message: null, attachments: [{ id: 'secret' }] })).isErr()).toBe(true);
    const event = policy(
      receive({ message: 'ordinary', attachments: [{ id: 'secret' }] }),
    )._unsafeUnwrap().event;
    expect(event.content).toBe('ordinary');
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('R2-F3 excludes repeated receive faults without account/device escalation or error leakage', () => {
    const ctx = context();
    for (let i = 0; i < 20; i++) {
      const result = normalizeSignalReceive(
        {
          subscription: 7,
          result: {
            account: accountUuid,
            exception: { message: 'secret challenge text' },
            envelope: {},
          },
        },
        1,
        ctx,
      );
      expect(result._unsafeUnwrapErr().reason).toBe('RECEIVE_EXCEPTION');
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain('secret');
    }
    expect(policy(receive(), ctx).isOk()).toBe(true);
  });

  it('rejects forged sync authorship, nested invented dataMessage, stale generations and subscriptions', () => {
    expect(policy(receive({}, peerUuid)).isErr()).toBe(true);
    expect(
      policy({
        subscription: 7,
        result: {
          account: accountUuid,
          envelope: {
            sourceUuid: accountUuid,
            sourceDevice: 2,
            syncMessage: {
              sentMessage: {
                destinationUuid: accountUuid,
                dataMessage: { timestamp: 500, message: 'invented', expiresInSeconds: 0 },
              },
            },
          },
        },
      }).isErr(),
    ).toBe(true);
    expect(policy(receive(), context(), 0)._unsafeUnwrapErr().reason).toBe('STALE_SUBSCRIPTION');
    expect(
      policy(receive(), { ...context(), connectionGeneration: 2 })._unsafeUnwrapErr().reason,
    ).toBe('STALE_SUBSCRIPTION');
    expect(policy({ subscription: 8, result: {} })._unsafeUnwrapErr().reason).toBe(
      'STALE_SUBSCRIPTION',
    );
  });

  it('R3-F1 holds only known human-device proof-dependent commands; independent peers continue', () => {
    const ctx = { ...context(), now: 302_000 };
    expect(policy(receive(), ctx)._unsafeUnwrap().kind).toBe('proof');
    expect(policy(receive({}, accountUuid, 99), ctx)._unsafeUnwrapErr().reason).toBe(
      'UNKNOWN_DEVICE',
    );
    expect(policy(receive({}, accountUuid, null), ctx).isErr()).toBe(true);
    expect(
      policy(receive({ message: '!talon peer' }, peerUuid, 1, false), ctx)._unsafeUnwrap().kind,
    ).toBe('admit');
    expect(policy(receive({ timestamp: 99 }), ctx)._unsafeUnwrapErr().reason).toBe('DEVICE_REPLAY');
    const unverified = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
    expect(
      policy(receive(), { ...ctx, registry: unverified.snapshot() })._unsafeUnwrapErr().reason,
    ).toBe('UNVERIFIED_DEVICE');
  });

  it('filters bridge output before RPC completion/restart and dedicated siblings regardless of device', () => {
    expect(
      policy(receive({ message: '!talon echo' }, accountUuid, 3))._unsafeUnwrapErr().reason,
    ).toBe('BOT_OUTPUT');
    const dedicated = SignalConfigSchema.parse({ ...config, accountMode: 'dedicated' });
    const ctx = context();
    expect(policy(receive(), { ...ctx, config: dedicated }).isErr()).toBe(true);
    const sibling = {
      ...ctx.registry[0],
      accountUuid: peerUuid,
      accountMode: 'dedicated' as const,
    };
    expect(
      policy(receive({ message: '!talon echo' }, peerUuid, 99, false), {
        ...ctx,
        registry: [...ctx.registry, sibling],
      })._unsafeUnwrapErr().reason,
    ).toBe('BOT_OUTPUT');
    const personalSibling = { ...ctx.registry[0], accountUuid: peerUuid };
    expect(
      policy(receive({ message: '!talon human' }, peerUuid, 2, false), {
        ...ctx,
        registry: [...ctx.registry, personalSibling],
      }).isOk(),
    ).toBe(true);
    expect(
      policy(receive({ message: '!talon echo' }, peerUuid, 3, false), {
        ...ctx,
        registry: [...ctx.registry, personalSibling],
      }).isErr(),
    ).toBe(true);
  });
});

describe('Signal generation/device provenance', () => {
  it('R2-F6 rejects stale-3/new-4, equal/unknown timestamps and metadata changes', () => {
    for (const createdTimestamp of [0, 200, 201]) {
      expect(
        verifySignalDevices(
          config,
          [...devices, { id: 4, name: null, createdTimestamp, lastSeenTimestamp: 500 }],
          1,
          1_000,
        ).isErr(),
      ).toBe(true);
    }
    expect(
      verifySignalDevices({ ...config, deviceCreatedTimestamp: 199 }, devices, 1, 1_000).isErr(),
    ).toBe(true);
    expect(verifySignalDevices(config, devices.slice(0, 2), 1, 1_000).isErr()).toBe(true);
  });

  it('R2-F6 coalesces advisory unknown-device requests across receivers through one generation owner', () => {
    const registry = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
    const requests: string[] = [];
    const owner = (account: string) => {
      requests.push(account);
    };
    for (let i = 0; i < 100; i++) registry.requestRefresh(accountUuid, 1_000 + i, owner);
    registry.requestRefresh(accountUuid, 60_999, owner);
    expect(requests).toEqual([accountUuid]);
    registry.requestRefresh(accountUuid, 61_000, owner);
    registry.requestRefresh(peerUuid, 61_000, owner);
    expect(requests).toEqual([accountUuid, accountUuid]);
    expect(registry.snapshot()[0].status).toBe('unverified');
  });

  it('publishes frozen atomic snapshots; starts unverified and rejects duplicate ownership/stale generation', () => {
    expect(SignalDeviceRegistry.create(1, [config, config]).isErr()).toBe(true);
    const registry = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
    const old = registry.snapshot();
    const proof = verifySignalDevices(config, devices, 1, 1_000)._unsafeUnwrap();
    registry.publish(proof)._unsafeUnwrap();
    expect(old[0].status).toBe('unverified');
    expect(registry.snapshot()[0]).toEqual(proof);
    expect(Object.isFrozen(registry.snapshot())).toBe(true);
    expect(
      proof.status === 'verified' && proof.humanDevices.map((device) => device.deviceId),
    ).toEqual([1, 2]);
    expect(registry.publish({ ...proof, generation: 0 }).isErr()).toBe(true);
    registry.invalidate(accountUuid);
    expect(registry.snapshot()[0].status).toBe('unverified');
  });
});
