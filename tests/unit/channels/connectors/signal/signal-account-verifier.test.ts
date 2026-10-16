import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { err, ok } from '../../../../../src/core/types/result.js';
import { createDatabase } from '../../../../../src/core/database/connection.js';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';
import {
  SignalAccountStateRepository,
  SignalStateError,
  type SignalPause,
} from '../../../../../src/core/database/repositories/signal-account-state-repository.js';
import {
  SignalConfigSchema,
  type SignalConfig,
} from '../../../../../src/channels/connectors/signal/signal-config.js';
import { SignalDeviceRegistry } from '../../../../../src/channels/connectors/signal/signal-device-registry.js';
import {
  SignalAccountVerifier,
  SignalVerificationError,
  type SignalAccountVerifierDependencies,
  type SignalVerificationStatus,
} from '../../../../../src/channels/connectors/signal/signal-account-verifier.js';
import {
  SignalRpcTransportError,
  type SignalRpcResult,
} from '../../../../../src/channels/connectors/signal/signal-rpc-client.js';
import {
  encodeSignalRpcRequest,
  parseSignalRpcFrame,
  type SignalRpcRequest,
} from '../../../../../src/channels/connectors/signal/signal-wire.js';
import {
  evaluateSignalCandidate,
  type SignalInboundContext,
} from '../../../../../src/channels/connectors/signal/signal-inbound-policy.js';

// Source contracts ONLY, not live Signal proof. All upstream citations pin v0.14.9,
// commit 3997429779095ff3a2d64c877126e84fce9852aa (immutable dispatch + supplement).
// ListDevicesCommand.java:40-67: getLinkedDevices; id/name/createdTimestamp/lastSeenTimestamp;
// no JSON current-device marker. ManagerImpl.java:483-504: server getDevices and absent created => 0.
// SignalJsonRpcCommandHandler.java:68-139: params.account manager selection/removal.
// JsonRpcResponse.java:13-46,75-105: result/error/ID and -32601.
const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const otherUuid = 'cccccccc-1111-2222-3333-dddddddddddd';
const now = 1_000_000;
const config = SignalConfigSchema.parse({
  accountMode: 'personal',
  socketPath: '/run/signal/bridge.sock',
  account: '+12025550123',
  accountUuid,
  deviceId: 3,
  deviceCreatedTimestamp: 200,
});
const devices = [
  { id: 1, name: null, createdTimestamp: 1, lastSeenTimestamp: 500 },
  { id: 2, name: 'synthetic human', createdTimestamp: 100, lastSeenTimestamp: 500 },
  { id: 3, name: 'synthetic bridge', createdTimestamp: 200, lastSeenTimestamp: 500 },
];
function result(value: unknown = devices): SignalRpcResult {
  const parsed = parseSignalRpcFrame(
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'fixture', result: value })),
  )._unsafeUnwrap();
  if (parsed.kind !== 'result') throw new Error('Invalid fixture');
  return ok({ kind: 'result', value: parsed.value });
}
function remote(code: number, results?: readonly unknown[]): SignalRpcResult {
  // CommandHandler.java:40-44,249-290: typed codes + error.data.response.
  // JsonSendMessageResult.java:10-48: retryAfterSeconds/token; JsonRecipientAddress.java:9-15.
  const frame = parseSignalRpcFrame(
    Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'fixture',
        error: {
          code,
          message: 'private unlink account token text',
          data: { response: { timestamp: 123456789, results }, secret: 'private-data' },
        },
      }),
    ),
  )._unsafeUnwrap();
  if (frame.kind !== 'failure') throw new Error('Invalid fixture');
  return err(frame.error);
}
function entry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipientAddress: { uuid: otherUuid, number: null, username: null },
    type: 'RATE_LIMIT_FAILURE',
    ...extra,
  };
}
function deferred(): {
  readonly promise: Promise<SignalRpcResult>;
  readonly resolve: (reply: SignalRpcResult) => void;
} {
  let resolve: (reply: SignalRpcResult) => void = () => {};
  const promise = new Promise<SignalRpcResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SignalAccountVerifier', () => {
  let db: Database.Database;
  let accounts: SignalAccountStateRepository;
  let registry: SignalDeviceRegistry;
  let verifiers: SignalAccountVerifier[];
  let changes: SignalVerificationStatus[];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(now);
    db = createDatabase(':memory:')._unsafeUnwrap();
    runMigrations(
      db,
      join(import.meta.dirname, '../../../../../src/core/database/migrations'),
    )._unsafeUnwrap();
    accounts = new SignalAccountStateRepository(db);
    registry = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
    verifiers = [];
    changes = [];
  });
  afterEach(async () => {
    for (const verifier of verifiers) await verifier.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    db.close();
  });

  function create(
    overrides: Partial<SignalAccountVerifierDependencies> = {},
  ): SignalAccountVerifier {
    const verifier = SignalAccountVerifier.create({
      config,
      accounts,
      registry,
      monotonicNow: () => performance.now(),
      onChange: (status) => {
        changes.push(status);
      },
      ...overrides,
    })._unsafeUnwrap();
    verifiers.push(verifier);
    return verifier;
  }
  function rpc(reply: () => SignalRpcResult | Promise<SignalRpcResult> = result) {
    const starts: (number | null | undefined)[] = [];
    const frames: string[] = [];
    const request = vi.fn(
      (
        input: SignalRpcRequest,
        _options?: { readonly signal?: AbortSignal },
      ): Promise<SignalRpcResult> => {
        starts.push(accounts.findByAccount(accountUuid)._unsafeUnwrap()?.lastDeviceCheckStart);
        frames.push(encodeSignalRpcRequest(input, 'fixture')._unsafeUnwrap().toString());
        return Promise.resolve(reply());
      },
    );
    return { request, starts, frames };
  }
  function state() {
    return accounts.findByAccount(accountUuid)._unsafeUnwrap()!;
  }
  function pause(hint: SignalPause): void {
    const current = accounts.getOrCreate(accountUuid, Date.now())._unsafeUnwrap();
    accounts.recordPause(accountUuid, current.revision, hint, Date.now())._unsafeUnwrap();
  }
  function failWrites(column: 'revision' | 'challenge' = 'revision'): void {
    db.exec(`CREATE TRIGGER fail_verifier_write BEFORE UPDATE OF ${column} ON signal_account_state
      BEGIN SELECT RAISE(ABORT, 'private SQL value'); END`);
  }

  it('commits the real account check-start BEFORE pinned-ACI listDevices and publishes immutable proof', async () => {
    const transport = rpc();
    const verifier = create();
    const checked = await verifier.connect(1, transport);
    expect(checked.isOk()).toBe(true);
    expect(transport.starts).toEqual([now]);
    expect(state()).toMatchObject({
      revision: 1,
      lastDeviceCheckStart: now,
      reservation: null,
      pauseKind: 'none',
    });
    expect(transport.frames).toEqual([
      `${JSON.stringify({ jsonrpc: '2.0', id: 'fixture', method: 'listDevices', params: { account: accountUuid } })}\n`,
    ]);
    const proof = registry.snapshot()[0];
    expect(proof).toMatchObject({
      status: 'verified',
      generation: 1,
      verifiedAt: now,
      expiresAt: now + 300_000,
      humanDevices: [
        { deviceId: 1, createdTimestamp: 1 },
        { deviceId: 2, createdTimestamp: 100 },
      ],
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(JSON.stringify(proof)).not.toMatch(/synthetic|lastSeen|name|isThisDevice/);
    expect(verifier.status()).toMatchObject({ state: 'verified', checking: false });
  });

  it('shares one known in-flight request and persisted 60-second budget under start/advisory/refresh bursts', async () => {
    const held = deferred();
    const transport = rpc(() => held.promise);
    const verifier = create();
    const first = verifier.connect(1, transport);
    await Promise.resolve();
    for (let i = 0; i < 100; i++) {
      expect(verifier.requestRefresh()).toBe(first);
      registry.requestRefresh(accountUuid, Date.now(), () => {
        void verifier.requestRefresh();
      });
    }
    await vi.advanceTimersByTimeAsync(180_000);
    expect(transport.starts).toEqual([now]);
    expect(state().revision).toBe(1);
    held.resolve(result());
    expect((await first).isOk()).toBe(true);
    transport.request.mockImplementation(async () => result());
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(state()).toMatchObject({ lastDeviceCheckStart: now + 180_001, revision: 2 });
    for (let i = 0; i < 100; i++) await verifier.requestRefresh();
    expect(transport.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(transport.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.request).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('enforces unique registry/account ownership, including replacement while a stopped request is still known', async () => {
    const held = deferred();
    const transport = rpc(() => held.promise);
    const verifier = create();
    const check = verifier.connect(1, transport);
    await Promise.resolve();
    const otherRegistry = SignalDeviceRegistry.create(2, [config])._unsafeUnwrap();
    expect(
      SignalAccountVerifier.create({
        config,
        accounts,
        registry: otherRegistry,
      })._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'OWNER_BUSY' });
    expect(
      SignalAccountVerifier.create({
        config,
        accounts: new SignalAccountStateRepository(db),
        registry,
      })._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'OWNER_BUSY' });
    const stopping = verifier.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.request).toHaveBeenCalledOnce();
    expect(
      SignalAccountVerifier.create({ config, accounts, registry: otherRegistry }).isErr(),
    ).toBe(true);
    held.resolve(result());
    expect((await check)._unsafeUnwrapErr()).toMatchObject({ reason: 'STALE_CONNECTION' });
    expect((await stopping).isOk()).toBe(true);
    const replacement = create({ registry: otherRegistry });
    expect(replacement.status().state).toBe('pending');
    expect(otherRegistry.snapshot()[0].status).toBe('unverified');
  });

  it('retains the persisted budget through reconstructed repository/verifier generations and epoch rewind', async () => {
    const transport = rpc();
    const verifier = create();
    await verifier.connect(1, transport);
    await verifier.stop();
    accounts = new SignalAccountStateRepository(db);
    registry = SignalDeviceRegistry.create(2, [config])._unsafeUnwrap();
    const replacement = create();
    vi.setSystemTime(now - 100_000);
    expect((await replacement.connect(1, transport))._unsafeUnwrapErr()).toMatchObject({
      reason: 'BUDGET',
      nextAttemptAt: now + 60_000,
    });
    await vi.advanceTimersByTimeAsync(159_999);
    expect(transport.request).toHaveBeenCalledOnce();
    expect(registry.snapshot()[0].status).toBe('unverified');
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(state().lastDeviceCheckStart).toBe(now + 60_000);
    expect(registry.snapshot()[0]).toMatchObject({ generation: 2, status: 'verified' });
  });

  it('does not call RPC when getOrCreate or committed check-start fails, retries writes with bounded backoff', async () => {
    const transport = rpc();
    const verifier = create();
    failWrites();
    const failure = (await verifier.connect(1, transport))._unsafeUnwrapErr();
    expect(failure).toBeInstanceOf(SignalStateError);
    expect(failure).toMatchObject({ reason: 'DATABASE' });
    expect(state()).toMatchObject({ revision: 0, lastDeviceCheckStart: null });
    expect(verifier.status().state).toBe('suspended');
    expect(transport.request).not.toHaveBeenCalled();
    const updates = vi.spyOn(accounts, 'startDeviceCheck');
    for (let i = 0; i < 100; i++) await verifier.requestRefresh();
    expect(updates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(updates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toHaveBeenCalledOnce();
    db.exec('DROP TRIGGER fail_verifier_write');
    await vi.advanceTimersByTimeAsync(499);
    expect(transport.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.starts).toEqual([now + 750]);
    expect(verifier.status().state).toBe('verified');
  });

  it('fails closed on account creation failure before any server request', async () => {
    db.exec(
      `CREATE TRIGGER fail_create BEFORE INSERT ON signal_account_state BEGIN SELECT RAISE(ABORT, 'private'); END`,
    );
    const transport = rpc();
    const verifier = create();
    expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toMatchObject({
      reason: 'DATABASE',
    });
    expect(transport.request).not.toHaveBeenCalled();
    expect(accounts.findByAccount(accountUuid)._unsafeUnwrap()).toBeNull();
    expect(verifier.status().state).toBe('suspended');
    db.exec('DROP TRIGGER fail_create');
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.starts).toEqual([now + 250]);
  });

  it.each(['rate_limit', 'recovery', 'challenge'] as const)(
    'honors persisted %s without RPC or reservation changes',
    async (kind) => {
      pause(kind === 'rate_limit' ? { kind, notBefore: now + 2_000_000 } : { kind });
      const prior = state();
      const transport = rpc();
      const verifier = create();
      expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toMatchObject({
        reason: 'PAUSED',
      });
      expect(transport.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(kind === 'challenge' ? 180_000 : prior.notBefore - now - 1);
      expect(transport.request).not.toHaveBeenCalled();
      expect(state()).toEqual(prior);
      if (kind !== 'challenge') {
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.request).toHaveBeenCalledOnce();
        expect(state().pauseKind).toBe(kind); // Historical pause cause is not an active deadline.
        expect(verifier.status().state).toBe('verified');
      }
      expect(state().reservation).toBeNull();
    },
  );

  it('requires fresh proof per connection; late callbacks and stale invalidations cannot publish or dispatch', async () => {
    const held = deferred();
    const firstRpc = rpc(() => held.promise);
    const verifier = create();
    const first = verifier.connect(1, firstRpc);
    await Promise.resolve();
    verifier.invalidateConnection(1);
    const nextRpc = rpc();
    await verifier.connect(2, nextRpc);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(nextRpc.request).not.toHaveBeenCalled();
    held.resolve(result());
    expect((await first)._unsafeUnwrapErr()).toMatchObject({ reason: 'STALE_CONNECTION' });
    expect(registry.snapshot()[0].status).toBe('unverified');
    await vi.advanceTimersByTimeAsync(1);
    expect(nextRpc.request).toHaveBeenCalledOnce();
    expect(verifier.status().state).toBe('verified');
    verifier.invalidateConnection(1);
    expect(verifier.status().state).toBe('verified');
    verifier.invalidateConnection(2);
    expect(registry.snapshot()[0].status).toBe('unverified');
    expect((await verifier.connect(1, firstRpc))._unsafeUnwrapErr()).toMatchObject({
      reason: 'STALE_CONNECTION',
    });
  });

  it('does not reuse an unexpired proof on reconnect at the next persisted budget slot', async () => {
    const transport = rpc();
    const verifier = create();
    await verifier.connect(1, transport);
    const original = registry.snapshot();
    await vi.advanceTimersByTimeAsync(1000);
    verifier.invalidateConnection(1);
    expect((await verifier.connect(2, transport))._unsafeUnwrapErr()).toMatchObject({
      reason: 'BUDGET',
    });
    expect(original[0].status).toBe('verified');
    expect(registry.snapshot()[0].status).toBe('unverified');
    expect(verifier.status().state).toBe('pending');
    await vi.advanceTimersByTimeAsync(58_999);
    expect(transport.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.starts).toEqual([now, now + 60_000]);
    expect(verifier.status().state).toBe('verified');
  });

  it.each([-3, -1, -4, -32602, -32603, 123])(
    'preserves cached proof and transport through transient/refused metadata %s, never guesses unlink',
    async (code) => {
      let response = result();
      const transport = rpc(() => response);
      const verifier = create();
      await verifier.connect(1, transport);
      const old = registry.snapshot();
      response = remote(code);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(transport.request).toHaveBeenCalledTimes(2);
      expect(registry.snapshot()).toBe(old);
      expect(verifier.status().state).toBe('verified');
      expect(state()).toMatchObject({ pauseKind: 'none', reservation: null, recoveryNotBefore: 0 });
      expect((await verifier.requestRefresh())._unsafeUnwrapErr()).toMatchObject({
        reason: 'BUDGET',
      });
    },
  );

  it('expires after five minutes while retaining proof-quarantine provenance; budgeted success renews', async () => {
    let response = result();
    const transport = rpc(() => response);
    const verifier = create();
    await verifier.connect(1, transport);
    const original = registry.snapshot();
    response = err(new SignalRpcTransportError('TIMEOUT', true));
    await vi.advanceTimersByTimeAsync(299_999);
    expect(verifier.status().state).toBe('verified');
    expect(registry.snapshot()).toBe(original);
    await vi.advanceTimersByTimeAsync(1);
    expect(verifier.status()).toMatchObject({ state: 'stale', reason: 'VERIFICATION_STALE' });
    expect(changes.some((status) => status.state === 'stale')).toBe(true);
    expect(registry.snapshot()[0]).toMatchObject({
      status: 'verified',
      humanDevices: [
        { deviceId: 1, createdTimestamp: 1 },
        { deviceId: 2, createdTimestamp: 100 },
      ],
    });
    expect(transport.request).toHaveBeenCalledTimes(6);
    expect(state()).toMatchObject({ reservation: null, pauseKind: 'none', recoveryNotBefore: 0 });
    const context: SignalInboundContext = {
      config: { ...config, allowedDmPeers: [otherUuid], allowedSenders: [otherUuid] },
      channelName: 'fixture',
      generation: 1,
      connectionGeneration: 1,
      subscription: 7,
      aliases: [accountUuid],
      registry: registry.snapshot(),
      now: Date.now(),
    };
    const candidate = {
      accountAlias: accountUuid,
      authorUuid: accountUuid,
      sourceDevice: 2,
      dataTimestamp: 500,
      receivedAt: Date.now(),
      destination: { kind: 'self' as const, accountUuid },
      text: 'self',
    };
    expect(evaluateSignalCandidate(candidate, context)._unsafeUnwrap().kind).toBe('proof');
    expect(
      evaluateSignalCandidate(
        {
          ...candidate,
          authorUuid: otherUuid,
          sourceDevice: 1,
          destination: { kind: 'dm', accountUuid, peerUuid: otherUuid },
          text: '!talon external',
        },
        context,
      )._unsafeUnwrap().kind,
    ).toBe('admit');
    response = result();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(verifier.status().state).toBe('verified');
    expect(registry.snapshot()[0]).toMatchObject({ verifiedAt: now + 360_000 });
    expect(transport.request).toHaveBeenCalledTimes(7);
  });

  it('does not extend cached provenance via epoch rewind or timer delay', async () => {
    let response = result();
    const transport = rpc(() => response);
    const verifier = create();
    await verifier.connect(1, transport);
    response = err(new SignalRpcTransportError('TIMEOUT', true));
    await vi.advanceTimersByTimeAsync(120_000);
    vi.setSystemTime(now + 1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(verifier.status().state).toBe('stale');
    expect(registry.snapshot()[0]).toMatchObject({ status: 'verified', expiresAt: 0 });
    vi.setSystemTime(now - 1);
    expect(verifier.status().state).toBe('stale');
    expect(state().reservation).toBeNull();
  });

  it.each([
    ['missing bridge', devices.slice(0, 2)],
    [
      'stale-3/new-4',
      [...devices, { id: 4, name: null, createdTimestamp: 201, lastSeenTimestamp: 500 }],
    ],
    [
      'equal timestamp',
      [...devices, { id: 4, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 }],
    ],
    [
      'zero other timestamp',
      [...devices, { id: 4, name: null, createdTimestamp: 0, lastSeenTimestamp: 500 }],
    ],
    ['missing timestamp', [...devices, { id: 4, name: null, lastSeenTimestamp: 500 }]],
    [
      'changed creation',
      devices.map((device) => (device.id === 3 ? { ...device, createdTimestamp: 199 } : device)),
    ],
    [
      'zero bridge timestamp',
      devices.map((device) => (device.id === 3 ? { ...device, createdTimestamp: 0 } : device)),
    ],
    [
      'missing JSON field',
      devices.map((device) =>
        device.id === 2 ? { id: 2, createdTimestamp: 100, lastSeenTimestamp: 500 } : device,
      ),
    ],
  ])(
    'treats successful invalid roster (%s) as permanent setup failure and never schedules more RPC',
    async (_label, roster) => {
      const transport = rpc(() => result(roster));
      const verifier = create();
      expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toMatchObject({
        reason: 'DEVICE_METADATA_INVALID',
      });
      expect(verifier.status()).toMatchObject({
        state: 'needs_setup',
        reason: 'DEVICE_METADATA_INVALID',
      });
      expect(registry.snapshot()[0].status).toBe('unverified');
      await vi.advanceTimersByTimeAsync(600_000);
      expect(transport.request).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect((await verifier.resumeChallenge({ externalChallengeResolved: true })).isErr()).toBe(
        true,
      );
      expect(state().reservation).toBeNull();
    },
  );

  it('invalidates a previously good proof when a successful new roster proves absence', async () => {
    let response = result();
    const transport = rpc(() => response);
    const verifier = create();
    await verifier.connect(1, transport);
    response = result(devices.slice(0, 2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.snapshot()[0].status).toBe('unverified');
    expect(verifier.status().state).toBe('needs_setup');
  });

  it('supports dedicated primary metadata without personal newest-device rules or invented local markers', async () => {
    const dedicated: SignalConfig = SignalConfigSchema.parse({
      ...config,
      accountMode: 'dedicated',
      deviceId: 1,
      deviceCreatedTimestamp: undefined,
    });
    const dedicatedRegistry = SignalDeviceRegistry.create(1, [dedicated])._unsafeUnwrap();
    const verifier = create({ config: dedicated, registry: dedicatedRegistry });
    const transport = rpc(() =>
      result([...devices, { id: 4, name: null, createdTimestamp: 300, lastSeenTimestamp: 500 }]),
    );
    expect((await verifier.connect(1, transport)).isOk()).toBe(true);
    expect(verifier.status().state).toBe('verified');
    expect(dedicatedRegistry.snapshot()[0]).toMatchObject({
      accountMode: 'dedicated',
      bridgeDeviceId: 1,
      status: 'verified',
    });
  });

  it('maps required-method absence to unsupported bridge, retaining sanitized typed error identity', async () => {
    const response = remote(-32601);
    const transport = rpc(() => response);
    const verifier = create();
    expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toBe(
      response._unsafeUnwrapErr(),
    );
    expect(verifier.status()).toMatchObject({
      state: 'needs_setup',
      reason: 'UNSUPPORTED_BRIDGE_MODE',
    });
    expect((await verifier.requestRefresh())._unsafeUnwrapErr()).toBe(response._unsafeUnwrapErr());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(transport.request).toHaveBeenCalledOnce();
  });

  it('routes cross-account personal refresh advisories to the existing shared owner without granting proof', async () => {
    const other = { ...config, accountUuid: otherUuid, account: otherUuid };
    registry = SignalDeviceRegistry.create(1, [config, other])._unsafeUnwrap();
    const verifier = create();
    const transport = rpc();
    await verifier.connect(1, transport);
    const otherVerifier = create({ config: other });
    const otherRpc = rpc();
    await otherVerifier.connect(1, otherRpc);
    const ownerByAci = new Map([
      [accountUuid, verifier],
      [otherUuid, otherVerifier],
    ]);
    const localRefresh = vi.spyOn(verifier, 'requestRefresh');
    const authorRefresh = vi.spyOn(otherVerifier, 'requestRefresh');
    const dispatch = vi.fn((authorAccountUuid: string) => {
      void ownerByAci.get(authorAccountUuid)?.requestRefresh();
    });
    for (let i = 0; i < 100; i++) registry.requestRefresh(accountUuid, Date.now(), dispatch);
    expect(dispatch.mock.calls).toEqual([[accountUuid]]);
    expect(localRefresh).toHaveBeenCalledOnce();
    expect(authorRefresh).not.toHaveBeenCalled();
    // A message received locally can be authored by another configured personal account.
    for (let i = 0; i < 100; i++) registry.requestRefresh(otherUuid, Date.now(), dispatch);
    expect(dispatch.mock.calls).toEqual([[accountUuid], [otherUuid]]);
    expect(localRefresh).toHaveBeenCalledOnce();
    expect(authorRefresh).toHaveBeenCalledOnce();
    expect(transport.request).toHaveBeenCalledOnce();
    expect(otherRpc.request).toHaveBeenCalledOnce();
    expect(JSON.parse(otherRpc.frames[0]!)).toMatchObject({
      method: 'listDevices',
      params: { account: otherUuid },
    });
    expect(registry.snapshot().every((proof) => proof.status === 'verified')).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(otherRpc.request).toHaveBeenCalledTimes(2);
  });

  it('persists every independent metadata rate/challenge hint atomically; retries ONLY writes, suspending sends but retaining cached proof', async () => {
    let response = result();
    const transport = rpc(() => response);
    const verifier = create();
    await verifier.connect(1, transport);
    const original = registry.snapshot();
    const held = deferred();
    transport.request.mockImplementationOnce(() => held.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    failWrites('challenge'); // Fail SECOND hint, so the earlier rate write must roll back too.
    response = remote(-6, [
      entry({ retryAfterSeconds: 10_000_000 }),
      entry({ retryAfterSeconds: 'malformed', token: 42 }),
    ]);
    held.resolve(response);
    await Promise.resolve();
    await Promise.resolve();
    expect(verifier.status().state).toBe('suspended');
    expect(registry.snapshot()).toBe(original);
    expect(state()).toMatchObject({
      revision: 2,
      pauseKind: 'none',
      rateLimitNotBefore: 0,
      recoveryNotBefore: 0,
      reservation: null,
    });
    for (let i = 0; i < 100; i++) await verifier.requestRefresh();
    expect(transport.request).toHaveBeenCalledTimes(2);
    db.exec('DROP TRIGGER fail_verifier_write');
    await vi.advanceTimersByTimeAsync(250);
    expect(state()).toMatchObject({
      revision: 4,
      pauseKind: 'challenge',
      rateLimitNotBefore: now + 60_000 + 10_000_000_000,
      recoveryNotBefore: 0,
      reservation: null,
    });
    expect(verifier.status().state).toBe('verified');
    expect(registry.snapshot()).toBe(original);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(changes)).not.toMatch(
      /private|token|synthetic|aaaaaaaa|cccccccc|123456789/,
    );
  });

  it.each([
    [-5, undefined, 'rate_limit'],
    [-6, undefined, 'challenge'],
    [-3, [entry({ token: '' })], 'challenge'],
    [-1, [entry({ retryAfterSeconds: Number.MAX_SAFE_INTEGER })], 'challenge'],
  ] as const)(
    'honors sanitized remote %s restrictions without delivery UNKNOWN/recovery inventions',
    async (code, hints, kind) => {
      const response = remote(code, hints);
      const transport = rpc(() => response);
      const verifier = create();
      expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toBe(
        response._unsafeUnwrapErr(),
      );
      expect(state()).toMatchObject({ pauseKind: kind, recoveryNotBefore: 0, reservation: null });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(transport.request).toHaveBeenCalledOnce();
      expect(JSON.stringify(verifier.status())).not.toMatch(/private|token|sendEvidence|UNKNOWN/);
    },
  );

  it('requires explicit external resolution, waits for shared budget and clears ONLY the successful check-start revision', async () => {
    const transport = rpc();
    const verifier = create();
    await verifier.connect(1, transport);
    pause({ kind: 'challenge' });
    // Deliberate untyped authenticated-boundary misuse; no fallback assertion.
    // @ts-expect-error explicit trusted assertion is required
    expect((await verifier.resumeChallenge({}))._unsafeUnwrapErr()).toBeInstanceOf(
      SignalVerificationError,
    );
    expect(transport.request).toHaveBeenCalledOnce();
    expect(
      (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'BUDGET' });
    expect(state().pauseKind).toBe('challenge');
    const clear = vi.spyOn(accounts, 'clearChallenge');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(transport.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(clear.mock.calls).toEqual([[accountUuid, 3, now + 60_000]]);
    expect(state()).toMatchObject({ revision: 4, pauseKind: 'none', reservation: null });
    expect(verifier.status().state).toBe('verified');
  });

  it.each(['rate_limit', 'recovery'] as const)(
    'privileged resume never bypasses an unexpired %s fence',
    async (kind) => {
      pause({ kind: 'challenge' });
      pause(kind === 'rate_limit' ? { kind, notBefore: now + 2_000_000 } : { kind });
      const original = state();
      const transport = rpc();
      const verifier = create();
      await verifier.connect(1, transport);
      expect(
        (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'PAUSED' });
      expect(transport.request).not.toHaveBeenCalled();
      expect(state()).toEqual(original);
      await vi.advanceTimersByTimeAsync(original.notBefore - now);
      expect(transport.request).not.toHaveBeenCalled(); // Another explicit assertion is required after rate refusal.
      const checked = await verifier.resumeChallenge({ externalChallengeResolved: true });
      expect(checked.isOk()).toBe(true);
      expect(state()).toMatchObject({
        rateLimitNotBefore: original.rateLimitNotBefore,
        recoveryNotBefore: original.recoveryNotBefore,
      });
      expect(state().pauseKind).not.toBe('challenge');
    },
  );

  it.each(['new challenge', 'other state change'] as const)(
    'never rereads/retries stale resume proof after %s',
    async (change) => {
      pause({ kind: 'challenge' });
      const verifier = create();
      const held = deferred();
      const transport = rpc(() => held.promise);
      await verifier.connect(1, transport); // ordinary challenge refusal, zero RPC
      const check = verifier.resumeChallenge({ externalChallengeResolved: true });
      await Promise.resolve();
      const startRevision = state().revision;
      pause(change === 'new challenge' ? { kind: 'challenge' } : { kind: 'recovery' });
      const changed = state();
      held.resolve(result());
      const clear = vi.spyOn(accounts, 'clearChallenge');
      expect((await check)._unsafeUnwrapErr()).toMatchObject({ reason: 'CONFLICT' });
      expect(clear.mock.calls).toEqual([[accountUuid, startRevision, now]]);
      expect(state()).toEqual(changed);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(clear).toHaveBeenCalledOnce();
      expect(transport.request).toHaveBeenCalledOnce();
      expect(state().pauseKind).toBe('challenge');
    },
  );

  it.each(['device invalid', 'transient', 'new remote restriction'] as const)(
    'failed privileged proof (%s) never clears challenge',
    async (kind) => {
      pause({ kind: 'challenge' });
      const response =
        kind === 'device invalid'
          ? result(devices.slice(0, 2))
          : kind === 'transient'
            ? remote(-3)
            : remote(-6, [entry({ retryAfterSeconds: 5000 })]);
      const transport = rpc(() => response);
      const verifier = create();
      await verifier.connect(1, transport);
      const clear = vi.spyOn(accounts, 'clearChallenge');
      expect((await verifier.resumeChallenge({ externalChallengeResolved: true })).isErr()).toBe(
        true,
      );
      expect(clear).not.toHaveBeenCalled();
      expect(state()).toMatchObject({
        pauseKind: 'challenge',
        recoveryNotBefore: 0,
        reservation: null,
      });
      if (kind === 'new remote restriction')
        expect(state().rateLimitNotBefore).toBe(now + 5_000_000);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(transport.request).toHaveBeenCalledOnce();
    },
  );

  it('retries failed clear DB writes with the EXACT successful check-start revision, never its RPC', async () => {
    pause({ kind: 'challenge' });
    const transport = rpc();
    const verifier = create();
    await verifier.connect(1, transport);
    const held = deferred();
    transport.request.mockImplementationOnce(() => held.promise);
    const check = verifier.resumeChallenge({ externalChallengeResolved: true });
    await Promise.resolve();
    const checkedRevision = state().revision;
    failWrites('challenge');
    held.resolve(result());
    expect((await check)._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(verifier.status().state).toBe('suspended');
    expect(state().pauseKind).toBe('challenge');
    db.exec('DROP TRIGGER fail_verifier_write');
    pause({ kind: 'challenge' });
    const newer = state();
    const clear = vi.spyOn(accounts, 'clearChallenge');
    await vi.advanceTimersByTimeAsync(250);
    expect(clear.mock.calls).toEqual([[accountUuid, checkedRevision, now + 250]]);
    expect(state()).toEqual(newer);
    expect(transport.request).toHaveBeenCalledOnce();
  });

  it('disconnect/stop invalidates pending privileged results and cancels all scheduler work without closing sender transport', async () => {
    pause({ kind: 'challenge' });
    const held = deferred();
    const transport = { ...rpc(() => held.promise), stop: vi.fn() };
    const verifier = create();
    await verifier.connect(1, transport);
    const check = verifier.resumeChallenge({ externalChallengeResolved: true });
    await Promise.resolve();
    verifier.invalidateConnection(1);
    const stopping = verifier.stop();
    const clear = vi.spyOn(accounts, 'clearChallenge');
    held.resolve(result());
    expect((await check)._unsafeUnwrapErr()).toMatchObject({ reason: 'STALE_CONNECTION' });
    expect((await stopping).isOk()).toBe(true);
    expect(clear).not.toHaveBeenCalled();
    expect(state().pauseKind).toBe('challenge');
    expect(registry.snapshot()[0].status).toBe('unverified');
    expect(transport.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(transport.request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(verifier.status().state).toBe('stopped');
    expect((await verifier.requestRefresh())._unsafeUnwrapErr()).toMatchObject({
      reason: 'STOPPED',
    });
  });

  it('retains failed restriction writes/ownership through stop; explicit bounded write retry cannot revive RPC or clear fences', async () => {
    const held = deferred();
    const transport = rpc(() => held.promise);
    const verifier = create();
    const check = verifier.connect(1, transport);
    await Promise.resolve();
    failWrites('challenge');
    held.resolve(remote(-6, [entry({ retryAfterSeconds: 5000 })]));
    expect((await check)._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect((await verifier.stop())._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(SignalAccountVerifier.create({ config, accounts, registry }).isErr()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    db.exec('DROP TRIGGER fail_verifier_write');
    await vi.advanceTimersByTimeAsync(250);
    expect(verifier.retryStateWrites()._unsafeUnwrapErr()).toMatchObject({
      reason: 'STALE_CONNECTION',
    });
    expect((await verifier.stop()).isOk()).toBe(true);
    expect(state()).toMatchObject({ pauseKind: 'challenge', rateLimitNotBefore: now + 5_000_000 });
    expect(registry.snapshot()[0].status).toBe('unverified');
    expect(transport.request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    create();
  });

  it('repeated old stop/status callbacks cannot revoke a replacement proof or release its owner', async () => {
    const transport = rpc();
    const old = create();
    await old.connect(1, transport);
    await old.stop();
    const replacement = create();
    await vi.advanceTimersByTimeAsync(60_000);
    await replacement.connect(1, transport);
    const current = registry.snapshot();
    await old.stop();
    old.status();
    expect(registry.snapshot()).toBe(current);
    expect(replacement.status().state).toBe('verified');
    expect(
      SignalAccountVerifier.create({ config, accounts, registry })._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'OWNER_BUSY' });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it.each(['rewind', 'stall'] as const)(
    'does not clear or republish an old privileged proof after failed writes span five elapsed minutes and epoch %s',
    async (clock) => {
      pause({ kind: 'challenge' });
      let epoch = now;
      const verifier = create({ now: () => epoch });
      const transport = rpc();
      await verifier.connect(1, transport);
      const held = deferred();
      transport.request.mockImplementationOnce(() => held.promise);
      const check = verifier.resumeChallenge({ externalChallengeResolved: true });
      await Promise.resolve();
      failWrites('challenge');
      held.resolve(result());
      expect((await check)._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(verifier.status().state).toBe('suspended');
      db.exec('DROP TRIGGER fail_verifier_write');
      epoch = clock === 'rewind' ? now - 1 : now + 1;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state().pauseKind).toBe('challenge');
      expect(verifier.status().state).toBe('pending');
      expect(registry.snapshot()[0].status).toBe('unverified');
      expect(transport.request).toHaveBeenCalledOnce();
    },
  );

  it('retries successful privileged clear using the unchanged revision without repeating device verification', async () => {
    pause({ kind: 'challenge' });
    const verifier = create();
    const held = deferred();
    const transport = rpc(() => held.promise);
    await verifier.connect(1, transport);
    const check = verifier.resumeChallenge({ externalChallengeResolved: true });
    await Promise.resolve();
    const checkedRevision = state().revision;
    failWrites('challenge');
    held.resolve(result());
    expect((await check)._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(registry.snapshot()[0].status).toBe('unverified');
    db.exec('DROP TRIGGER fail_verifier_write');
    const clear = vi.spyOn(accounts, 'clearChallenge');
    await vi.advanceTimersByTimeAsync(250);
    expect(clear.mock.calls).toEqual([[accountUuid, checkedRevision, now + 250]]);
    expect(state()).toMatchObject({ revision: checkedRevision + 1, pauseKind: 'none' });
    expect(registry.snapshot()[0]).toMatchObject({ status: 'verified', verifiedAt: now });
    expect(verifier.status().state).toBe('verified');
    expect(transport.request).toHaveBeenCalledOnce();
  });

  it('the actual check-start revision CAS blocks a concurrent account change before any RPC', async () => {
    const verifier = create();
    const transport = rpc();
    const originalStart = accounts.startDeviceCheck.bind(accounts);
    vi.spyOn(accounts, 'startDeviceCheck').mockImplementationOnce((account, revision, time) => {
      accounts.recordPause(account, revision, { kind: 'challenge' }, time)._unsafeUnwrap();
      return originalStart(account, revision, time);
    });
    expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toMatchObject({
      reason: 'CONFLICT',
    });
    expect(state()).toMatchObject({
      pauseKind: 'challenge',
      revision: 1,
      lastDeviceCheckStart: null,
    });
    expect(transport.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.request).not.toHaveBeenCalled();
    expect(verifier.status().state).toBe('pending');
  });

  it('invalid trusted clocks fail closed without a hot scheduling loop or network work', async () => {
    const verifier = create({ now: () => -1 });
    const transport = rpc();
    expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toMatchObject({
      reason: 'INVALID_CLOCK',
    });
    expect(verifier.status().state).toBe('suspended');
    expect(transport.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(transport.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([remote(-3), remote(123), err(new SignalRpcTransportError('TIMEOUT', true))])(
    'initial transient metadata errors retain typed identity and pending status without guessing unlink/recovery',
    async (response) => {
      const verifier = create();
      const transport = rpc(() => response);
      expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toBe(
        response._unsafeUnwrapErr(),
      );
      expect(verifier.status().state).toBe('pending');
      expect(registry.snapshot()[0].status).toBe('unverified');
      expect(state()).toMatchObject({ pauseKind: 'none', recoveryNotBefore: 0, reservation: null });
      expect(transport.request).toHaveBeenCalledOnce();
    },
  );

  it('publishes stale status while a healthy-connection refresh is still in flight at the proof deadline', async () => {
    const verifier = create();
    let response = result();
    const transport = rpc(() => response);
    await verifier.connect(1, transport);
    response = remote(-3);
    await vi.advanceTimersByTimeAsync(240_000);
    const held = deferred();
    transport.request.mockImplementationOnce(() => held.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(verifier.status()).toMatchObject({ state: 'stale', checking: true });
    expect(changes.some((status) => status.state === 'stale')).toBe(true);
    expect(transport.request).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(transport.request).toHaveBeenCalledTimes(6);
    held.resolve(remote(-3));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('dedicated optional creation metadata is still checked exactly when supplied', async () => {
    const dedicated = {
      ...config,
      accountMode: 'dedicated' as const,
      deviceId: 1,
      deviceCreatedTimestamp: 2,
    };
    const dedicatedRegistry = SignalDeviceRegistry.create(1, [dedicated])._unsafeUnwrap();
    const verifier = create({ config: dedicated, registry: dedicatedRegistry });
    const transport = rpc();
    expect((await verifier.connect(1, transport))._unsafeUnwrapErr()).toMatchObject({
      reason: 'DEVICE_METADATA_INVALID',
    });
    expect(verifier.status().state).toBe('needs_setup');
    expect(transport.request).toHaveBeenCalledOnce();
  });

  it('sanitizes outer Result-transaction entry failure, retains all hints and retries only persistence', async () => {
    const verifier = create();
    const held = deferred();
    const transport = rpc(() => held.promise);
    const check = verifier.connect(1, transport);
    await Promise.resolve();
    const transaction = vi.spyOn(accounts, 'transaction').mockImplementationOnce(() => {
      throw new Error('private SQLite transaction entry failure');
    });
    held.resolve(remote(-6, [entry({ retryAfterSeconds: 5000 })]));
    const returned = await check.then(
      (value) => ({ value }),
      () => ({ value: undefined }),
    );
    expect(returned.value?.isErr()).toBe(true);
    expect(returned.value?._unsafeUnwrapErr()).toMatchObject({
      reason: 'DATABASE',
      cause: undefined,
    });
    expect(verifier.status().state).toBe('suspended');
    expect(state()).toMatchObject({ revision: 1, pauseKind: 'none', rateLimitNotBefore: 0 });
    await vi.advanceTimersByTimeAsync(250);
    expect(transaction.mock.calls.length).toBeGreaterThan(1);
    expect(state()).toMatchObject({
      revision: 3,
      pauseKind: 'challenge',
      rateLimitNotBefore: now + 5_000_000,
    });
    expect(transport.request).toHaveBeenCalledOnce();
    expect(JSON.stringify(changes)).not.toMatch(/private|SQLite/);
  });

  it.each(['new challenge', 'unrelated account revision'] as const)(
    'drops deferred external-resolution intent after %s BEFORE the budgeted check starts',
    async (change) => {
      const verifier = create();
      const transport = rpc();
      await verifier.connect(1, transport);
      pause({ kind: 'challenge' });
      expect(state().revision).toBe(2);
      expect(
        (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'BUDGET' });
      const clear = vi.spyOn(accounts, 'clearChallenge');
      pause(change === 'new challenge' ? { kind: 'challenge' } : { kind: 'recovery' });
      const changed = state();
      expect(changed.revision).toBe(3);
      await vi.advanceTimersByTimeAsync(60_000);
      await verifier.requestRefresh();
      expect(transport.request).toHaveBeenCalledOnce();
      expect(transport.starts).toEqual([now]);
      expect(clear).not.toHaveBeenCalled();
      expect(state()).toEqual(changed);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(transport.request).toHaveBeenCalledOnce();
      expect(clear).not.toHaveBeenCalled();
      expect(state()).toEqual(changed);
    },
  );

  it.each(['first assertion', 'replacement assertion'] as const)(
    'failed %s authority capture cannot auto-clear a challenge after DB repair',
    async (attempt) => {
      const verifier = create();
      const transport = rpc();
      await verifier.connect(1, transport);
      pause({ kind: 'challenge' });
      if (attempt === 'replacement assertion')
        expect(
          (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
        ).toMatchObject({ reason: 'BUDGET' });
      const failure = new SignalStateError('DATABASE');
      vi.spyOn(accounts, 'findByAccount').mockReturnValueOnce(err(failure));
      expect(
        (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
      ).toBe(failure);
      const clear = vi.spyOn(accounts, 'clearChallenge');
      pause({ kind: 'challenge' });
      const repaired = state();
      expect(repaired.revision).toBe(3);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(transport.request).toHaveBeenCalledOnce();
      expect(transport.starts).toEqual([now]);
      expect(clear).not.toHaveBeenCalled();
      expect(state()).toEqual(repaired);
    },
  );

  it('a fresh explicit assertion may bind a NEW challenged revision while still waiting for the shared slot', async () => {
    const verifier = create();
    const transport = rpc();
    await verifier.connect(1, transport);
    pause({ kind: 'challenge' });
    expect(
      (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'BUDGET' });
    await vi.advanceTimersByTimeAsync(10_000);
    pause({ kind: 'challenge' });
    const current = state();
    expect(current.revision).toBe(3);
    expect(
      (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'BUDGET' });
    expect(state()).toEqual(current);
    const clear = vi.spyOn(accounts, 'clearChallenge');
    await vi.advanceTimersByTimeAsync(49_999);
    expect(transport.request).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.starts).toEqual([now, now + 60_000]);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(clear.mock.calls).toEqual([[accountUuid, 4, now + 60_000]]);
    expect(state()).toMatchObject({
      revision: 5,
      pauseKind: 'none',
      lastDeviceCheckStart: now + 60_000,
      rateLimitNotBefore: current.rateLimitNotBefore,
      recoveryNotBefore: current.recoveryNotBefore,
      reservation: null,
    });
  });

  it('a fresh explicit assertion succeeds after stale waiting intent is rejected, without rebasing the old assertion', async () => {
    const verifier = create();
    const transport = rpc();
    await verifier.connect(1, transport);
    pause({ kind: 'challenge' });
    expect(
      (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'BUDGET' });
    pause({ kind: 'challenge' });
    const challenged = state();
    const clear = vi.spyOn(accounts, 'clearChallenge');
    await vi.advanceTimersByTimeAsync(60_250);
    expect(transport.request).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    expect(state()).toEqual(challenged);
    expect((await verifier.resumeChallenge({ externalChallengeResolved: true })).isOk()).toBe(true);
    expect(transport.starts).toEqual([now, now + 60_250]);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(clear.mock.calls).toEqual([[accountUuid, challenged.revision + 1, now + 60_250]]);
    expect(state()).toMatchObject({
      revision: challenged.revision + 2,
      pauseKind: 'none',
      rateLimitNotBefore: challenged.rateLimitNotBefore,
      recoveryNotBefore: challenged.recoveryNotBefore,
      reservation: null,
    });
  });

  it.each(['unchanged', 'new challenge'] as const)(
    'privileged check-start DB retry preserves the captured attestation revision when %s',
    async (change) => {
      const verifier = create();
      const transport = rpc();
      await verifier.connect(1, transport);
      pause({ kind: 'challenge' });
      await vi.advanceTimersByTimeAsync(60_000);
      const attested = state();
      failWrites();
      expect(
        (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'DATABASE' });
      expect(state()).toEqual(attested);
      db.exec('DROP TRIGGER fail_verifier_write');
      if (change === 'new challenge') pause({ kind: 'challenge' });
      const repaired = state();
      const clear = vi.spyOn(accounts, 'clearChallenge');
      await vi.advanceTimersByTimeAsync(250);
      if (change === 'new challenge') {
        expect(transport.request).toHaveBeenCalledOnce();
        expect(clear).not.toHaveBeenCalled();
        expect(state()).toEqual(repaired);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(transport.request).toHaveBeenCalledOnce();
        expect(clear).not.toHaveBeenCalled();
        expect(state()).toEqual(repaired);
      } else {
        expect(transport.starts).toEqual([now, now + 60_250]);
        expect(transport.request).toHaveBeenCalledTimes(2);
        expect(clear.mock.calls).toEqual([[accountUuid, attested.revision + 1, now + 60_250]]);
        expect(state()).toMatchObject({
          revision: attested.revision + 2,
          pauseKind: 'none',
          rateLimitNotBefore: attested.rateLimitNotBefore,
          recoveryNotBefore: attested.recoveryNotBefore,
          reservation: null,
        });
      }
    },
  );

  it('the immediate privileged start CAS uses the assertion revision, not a newer row read after capture', async () => {
    const verifier = create();
    const transport = rpc();
    await verifier.connect(1, transport);
    pause({ kind: 'challenge' });
    await vi.advanceTimersByTimeAsync(60_000);
    const originalGet = accounts.getOrCreate.bind(accounts);
    vi.spyOn(accounts, 'getOrCreate').mockImplementationOnce((account, time) => {
      pause({ kind: 'challenge' });
      return originalGet(account, time);
    });
    const clear = vi.spyOn(accounts, 'clearChallenge');
    expect(
      (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'CONFLICT' });
    const newer = state();
    expect(newer).toMatchObject({ revision: 3, pauseKind: 'challenge', lastDeviceCheckStart: now });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.request).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    expect(state()).toEqual(newer);
  });

  it.each(['disconnect', 'stop', 'new connection'] as const)(
    '%s consumes a captured privileged intent still waiting for its first check-start',
    async (event) => {
      const verifier = create();
      const transport = rpc();
      await verifier.connect(1, transport);
      pause({ kind: 'challenge' });
      expect(
        (await verifier.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'BUDGET' });
      const challenged = state();
      if (event === 'stop') await verifier.stop();
      else if (event === 'disconnect') verifier.invalidateConnection(1);
      else await verifier.connect(2, transport);
      const clear = vi.spyOn(accounts, 'clearChallenge');
      await vi.advanceTimersByTimeAsync(180_000);
      expect(transport.request).toHaveBeenCalledOnce();
      expect(clear).not.toHaveBeenCalled();
      expect(state()).toEqual(challenged);
      expect(registry.snapshot()[0].status).toBe('unverified');
    },
  );
});
