import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../core/database/repositories/helpers.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { QueueRepository } from '../../../../../src/core/database/repositories/queue-repository.js';
import {
  SignalAccountStateRepository,
  SignalStateError,
} from '../../../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../../../src/core/database/repositories/signal-destination-lease-repository.js';
import {
  SignalSendCoordinator,
  type SignalSendReadiness,
} from '../../../../../src/channels/connectors/signal/signal-send-coordinator.js';
import { SignalConfigSchema } from '../../../../../src/channels/connectors/signal/signal-config.js';
import { verifySignalDevices } from '../../../../../src/channels/connectors/signal/signal-device-registry.js';
import {
  SignalRpcTransportError,
  type SignalRpcResult,
} from '../../../../../src/channels/connectors/signal/signal-rpc-client.js';
import {
  encodeSignalRpcRequest,
  parseSignalRpcFrame,
  parseSignalSendEvidence,
  type SignalRpcRequest,
} from '../../../../../src/channels/connectors/signal/signal-wire.js';
import {
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  type SignalDeliveryCheckpoint,
} from '../../../../../src/queue/signal-delivery-checkpoint.js';
import type { TrustedDeliveryContext } from '../../../../../src/channels/channel-types.js';
import { err, ok } from '../../../../../src/core/types/result.js';

const account = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const peer = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const target = `signal:v1:${account}:self`;
const groupA = `signal:v1:${account}:group:QQ`;
const groupB = `signal:v1:${account}:group:Qg`;
const dm = `signal:v1:${account}:dm:${peer}`;
const initialTime = 1_000_000;
const config = SignalConfigSchema.parse({
  accountMode: 'personal',
  socketPath: '/run/signal/bridge.sock',
  account: '+12025550123',
  accountUuid: account,
  deviceId: 3,
  deviceCreatedTimestamp: 200,
  allowedDmPeers: [peer],
  allowedGroups: ['QQ==', 'Qg=='],
  requestTimeoutMs: 120_000,
});

// Source-shaped fixtures, NOT live Signal evidence. Pinned v0.14.9 commit
// 3997429779095ff3a2d64c877126e84fce9852aa: JsonSendMessageResult.java:10-48,
// JsonRecipientAddress.java:9-15, SendMessageResultUtils.java:43-68.
function resultEntry(
  type = 'SUCCESS',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, recipientAddress: { uuid: peer, number: null, username: null }, ...extra };
}
function sendResult(entries = [resultEntry()]): SignalRpcResult {
  const frame = parseSignalRpcFrame(
    Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'fixture',
        result: { timestamp: 1234, results: entries },
      }),
    ),
  )._unsafeUnwrap();
  if (frame.kind !== 'result') throw new Error('Invalid fixture');
  return ok({ kind: 'send', evidence: parseSignalSendEvidence(frame.value) });
}
function remote(code: number, entries?: Record<string, unknown>[]): SignalRpcResult {
  // SignalJsonRpcCommandHandler.java:40-44,249-290: only error.data.response.
  const frame = parseSignalRpcFrame(
    Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'fixture',
        error: {
          code,
          message: 'private remote error',
          data: {
            response: entries === undefined ? undefined : { timestamp: 1234, results: entries },
          },
        },
      }),
    ),
  )._unsafeUnwrap();
  if (frame.kind !== 'failure') throw new Error('Invalid fixture');
  return err(frame.error);
}
function metadata(request: SignalRpcRequest): SignalRpcResult {
  if (request.method === 'listContacts')
    return ok({
      kind: 'result',
      value: [
        {
          uuid: request.params.recipient[0],
          isBlocked: false,
          unregistered: false,
          messageExpirationTime: 0,
        },
      ],
    });
  if (request.method === 'listGroups')
    return ok({
      kind: 'result',
      value: [
        {
          id: request.params.groupId?.[0] ?? '',
          isMember: true,
          isBlocked: false,
          isTerminated: false,
          messageExpirationTime: 0,
          members: [{ uuid: account, number: null, isAdmin: false }],
          pendingMembers: [],
          requestingMembers: [],
          admins: [],
          banned: [],
          permissionAddMember: 'SOURCE_ENUM_NAME',
          permissionEditDetails: 'SOURCE_ENUM_NAME',
          permissionSendMessage: 'SOURCE_ENUM_NAME',
        },
      ],
    });
  throw new Error('Unexpected metadata method');
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// All assertions are OUTSIDE transport/state callbacks that production may catch.
describe('SignalSendCoordinator integration with real migrated SQLite', () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let accounts: SignalAccountStateRepository;
  let leases: SignalDestinationLeaseRepository;
  let readiness: SignalSendReadiness;
  let sender: SignalSendCoordinator;
  let nextSend: (request: SignalRpcRequest) => SignalRpcResult | Promise<SignalRpcResult>;
  let nextMetadata: (request: SignalRpcRequest) => SignalRpcResult | Promise<SignalRpcResult>;
  let calls: {
    request: SignalRpcRequest;
    wire: string;
    at: number;
    reservation: unknown;
    checkpoint: unknown;
  }[];
  let sequence: number;

  function renew(): void {
    readiness = {
      ...readiness,
      proof: verifySignalDevices(
        readiness.config,
        [
          { id: 1, name: null, createdTimestamp: 100, lastSeenTimestamp: 1 },
          { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 1 },
        ],
        readiness.generation,
        Date.now(),
      )._unsafeUnwrap(),
    };
  }
  function reconstruct(): SignalSendCoordinator {
    return new SignalSendCoordinator({
      accounts,
      leases,
      queue,
      readiness: () => readiness,
      monotonicNow: () => performance.now(),
      rpc: {
        request: (request) => {
          const wire = encodeSignalRpcRequest(request, `request-${calls.length}`)
            ._unsafeUnwrap()
            .toString('utf8');
          calls.push({
            request,
            wire,
            at: Date.now(),
            reservation: accounts.findByAccount(account)._unsafeUnwrap()?.reservation,
            checkpoint: queue.inspectSignalDelivery('queue-1', Date.now()),
          });
          return Promise.resolve(
            request.method === 'send' ? nextSend(request) : nextMetadata(request),
          );
        },
      },
    });
  }
  function context(
    purpose: TrustedDeliveryContext['purpose'] = 'explicit',
  ): TrustedDeliveryContext {
    const id = ++sequence;
    const thread = `thread-${id}`;
    new ThreadRepository(db)
      .insert({ id: thread, channel_id: 'channel', external_id: `fixture-${id}`, metadata: '{}' })
      ._unsafeUnwrap();
    queue
      .enqueue({
        id: `queue-${id}`,
        thread_id: thread,
        message_id: null,
        type: purpose === 'background' ? 'collaboration' : 'message',
        payload: '{"untouched":true}',
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    return { queueItemId: `queue-${id}`, deliveryId: `delivery-${id}`, purpose };
  }
  function save(
    body: string,
    destination = target,
    purpose: 'reply' | 'background' = 'reply',
  ): TrustedDeliveryContext {
    const ctx = context(purpose);
    const prepared = sender.prepare(destination, { body })._unsafeUnwrap();
    queue
      .saveSignalCheckpoint(
        {
          version: 1,
          queueItemId: ctx.queueItemId,
          deliveryId: ctx.deliveryId,
          kind: purpose,
          personaId: 'persona',
          threadId: `thread-${sequence}`,
          channelName: 'signal-test',
          accountUuid: account,
          destination,
          body,
          chunks: prepared.chunks,
          nextChunk: 0,
          phase: 'ready',
          currentChunkAcceptance: 'unwritten',
          acceptedChunks: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: Date.now(),
          expiresAt: Date.now() + SIGNAL_CHECKPOINT_LIFETIME_MS,
        },
        Date.now(),
      )
      ._unsafeUnwrap();
    return ctx;
  }
  function checkpoint(ctx: TrustedDeliveryContext): SignalDeliveryCheckpoint {
    const state = queue.inspectSignalDelivery(ctx.queueItemId, Date.now())._unsafeUnwrap();
    if (state.kind !== 'checkpoint') throw new Error('Missing fixture checkpoint');
    return state.checkpoint;
  }
  function sends(): typeof calls {
    return calls.filter((call) => call.request.method === 'send');
  }
  async function flush(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.setSystemTime(initialTime);
    db = createTestDb();
    queue = new QueueRepository(db);
    accounts = new SignalAccountStateRepository(db);
    leases = new SignalDestinationLeaseRepository(db);
    new ChannelRepository(db)
      .insert({
        id: 'channel',
        type: 'signal',
        name: 'signal-test',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    readiness = {
      config,
      generation: 7,
      state: 'ready',
      proof: {
        status: 'unverified',
        accountUuid: account,
        accountMode: 'personal',
        bridgeDeviceId: 3,
        generation: 7,
      },
    };
    renew();
    nextSend = () => sendResult();
    nextMetadata = metadata;
    calls = [];
    sequence = 0;
    sender = reconstruct();
  });
  afterEach(async () => {
    sender.quiesce();
    await vi.runAllTimersAsync();
    await sender.drain();
    vi.restoreAllMocks();
    vi.useRealTimers();
    db.close();
  });

  it('settles an accepted fixed chunk into the real cursor before returning a chunk-local receipt', async () => {
    const ctx = save('a'.repeat(2000) + 'tail');
    const result = await sender.sendPreparedChunk(target, 'a'.repeat(2000), ctx);
    expect(result._unsafeUnwrap()).toEqual({
      acceptance: 'complete',
      successCount: 1,
      failureCount: 0,
    });
    expect(checkpoint(ctx)).toMatchObject({
      nextChunk: 1,
      acceptedChunks: 1,
      successCount: 1,
      phase: 'ready',
    });
    expect(sends()[0].reservation).toEqual({
      queueItemId: ctx.queueItemId,
      deliveryId: ctx.deliveryId,
      purpose: 'reply',
      startedAt: initialTime,
    });
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
    expect(leases.find(account, target)._unsafeUnwrap()?.deliveryId).toBe(ctx.deliveryId);
    expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toMatchObject({
      attempts: 0,
      max_attempts: 3,
    });
  });

  it('uses real encoder allowlists and authoritative ACI for self, DM and group sends', async () => {
    // SendCommand.java:47-67,125-142,264-281; JSONRPC manual:92-99.
    for (const destination of [target, dm, groupA]) {
      const pending = sender.send(destination, { body: '**hello**', trustedDelivery: context() });
      await advance(1000);
      expect((await pending).isOk()).toBe(true);
    }
    expect(sends().map((call) => call.request)).toEqual([
      { method: 'send', params: { account, noteToSelf: true, message: 'hello' } },
      { method: 'send', params: { account, recipient: [peer], message: 'hello' } },
      { method: 'send', params: { account, groupId: 'QQ==', message: 'hello' } },
    ]);
    expect(calls.every((call) => !call.wire.includes('+12025550123'))).toBe(true);
    expect(calls.some((call) => call.request.method === 'listDevices')).toBe(false);
  });

  it('prepares generic text once and retains original fixed saved chunks including Markdown-looking tails', async () => {
    const body = 'a'.repeat(1999) + '\n# # heading';
    const ctx = save(body);
    const pending = sender.send(target, { body, trustedDelivery: ctx });
    await advance(1000);
    expect((await pending).isOk()).toBe(true);
    expect(
      sends().map((call) => call.request.method === 'send' && call.request.params.message),
    ).toEqual(['a'.repeat(1999) + '\n', '# heading']);
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'delivered',
      acceptedChunks: 2,
      successCount: 2,
    });
  });

  it('never replays an original body after cursor advancement, and rejects a wrong fixed chunk', async () => {
    const body = 'a'.repeat(2000) + 'tail';
    const ctx = save(body);
    await sender.sendPreparedChunk(target, 'a'.repeat(2000), ctx);
    const wrong = sender.sendPreparedChunk(target, 'a'.repeat(2000), ctx);
    await advance(1000);
    expect((await wrong)._unsafeUnwrapErr()).toMatchObject({ reason: 'CHECKPOINT_INVALID' });
    expect(checkpoint(ctx).nextChunk).toBe(1);
    const tail = sender.send(target, { body, trustedDelivery: ctx });
    await advance(1000);
    expect((await tail).isOk()).toBe(true);
    expect(
      sends().map((call) => call.request.method === 'send' && call.request.params.message),
    ).toEqual(['a'.repeat(2000), 'tail']);
  });

  it('fairly interleaves two concurrent long group replies, never two active chunks', async () => {
    const bodyA = 'a'.repeat(6001);
    const bodyB = 'b'.repeat(6001);
    const a = sender.send(groupA, { body: bodyA, trustedDelivery: save(bodyA, groupA) });
    const b = sender.send(groupB, { body: bodyB, trustedDelivery: save(bodyB, groupB) });
    await advance(8000);
    expect((await a).isOk() && (await b).isOk()).toBe(true);
    expect(
      sends().map((call) => call.request.method === 'send' && call.request.params.message[0]),
    ).toEqual(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']);
    expect(
      sends().every((call, index, all) => index === 0 || call.at - all[index - 1].at >= 1000),
    ).toBe(true);
    expect(sends().every((call) => call.reservation !== null)).toBe(true);
  });

  it('keeps same-target whole messages contiguous across saved, background and explicit paths without head blockage', async () => {
    const body = 'a'.repeat(6001);
    const a = sender.send(groupA, { body, trustedDelivery: save(body, groupA) });
    const background = sender.send(groupA, {
      body: 'background',
      trustedDelivery: save('background', groupA, 'background'),
    });
    const explicit = sender.send(groupA, { body: 'e'.repeat(2001), trustedDelivery: context() });
    const other = sender.send(groupB, { body: 'other', trustedDelivery: save('other', groupB) });
    await advance(9000);
    expect(
      (await a).isOk() &&
        (await background).isOk() &&
        (await explicit).isOk() &&
        (await other).isOk(),
    ).toBe(true);
    const messages = sends().map((call) =>
      call.request.method === 'send' ? call.request.params.message : '',
    );
    expect(messages.map((message) => message[0])).toEqual(['a', 'o', 'a', 'a', 'a', 'b', 'e', 'e']);
    expect(messages.filter((message) => message.startsWith('a')).join('')).toBe(body);
    expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
  });

  it('holds the explicit outer lease across its inner chunks and releases after pre-reservation metadata failure', async () => {
    const hold = deferred<SignalRpcResult>();
    nextMetadata = () => hold.promise;
    const ctx = context('explicit');
    const pending = sender.send(groupA, { body: 'a'.repeat(2001), trustedDelivery: ctx });
    await flush();
    expect(leases.find(account, groupA)._unsafeUnwrap()?.kind).toBe('explicit');
    hold.resolve(err(new SignalRpcTransportError('TIMEOUT', true)));
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      outcome: 'NOT_SENT',
      currentChunkAcceptance: 'unwritten',
      reason: 'TARGET_LOOKUP_FAILED',
    });
    expect(sends()).toHaveLength(0);
    expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
    nextMetadata = metadata;
    expect((await sender.sendPreparedChunk(groupA, 'new', context('progress'))).isOk()).toBe(true);
    expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
  });

  it('refuses concurrent accidental context reuse instead of sharing an idempotent lease owner', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const ctx = context();
    const first = sender.sendPreparedChunk(target, 'first', ctx);
    await flush();
    const duplicate = await sender.sendPreparedChunk(groupA, 'unrelated', ctx);
    expect(duplicate._unsafeUnwrapErr().reason).toBe('CHECKPOINT_INVALID');
    hold.resolve(sendResult());
    expect((await first).isOk()).toBe(true);
    expect(sends()).toHaveLength(1);
  });

  it('requires trusted identity and rejects attachments/empty/oversize output before any RPC', async () => {
    const missing = await sender.send(target, { body: 'hello' });
    expect(missing._unsafeUnwrapErr().reason).toBe('CHECKPOINT_INVALID');
    const ctx = context();
    for (const output of [
      { body: '' },
      { body: 'x'.repeat(1_048_577) },
      {
        body: 'hello',
        attachments: [{ filename: 'x', mimeType: 'text/plain', data: '', size: 0 }],
      },
    ])
      expect((await sender.send(target, { ...output, trustedDelivery: ctx })).isErr()).toBe(true);
    expect(calls).toEqual([]);
  });

  it('enforces exactly 64 waiting operations and expires unwritten waits at 30s even behind a 120s active request', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const active = sender.sendPreparedChunk(groupA, 'active', context());
    await flush();
    const waiting = Array.from({ length: 64 }, () =>
      sender.sendPreparedChunk(groupB, 'wait', context()),
    );
    const excess = await sender.sendPreparedChunk(groupB, 'excess', context());
    expect(excess._unsafeUnwrapErr()).toMatchObject({
      reason: 'RPC_CAPACITY',
      outcome: 'NOT_SENT',
    });
    let completed = 0;
    for (const promise of waiting)
      void promise.then(() => {
        completed++;
      });
    await advance(29_999);
    expect(completed).toBe(0);
    await advance(1);
    expect(completed).toBe(64);
    expect(
      (await Promise.all(waiting)).every(
        (value) => value.isErr() && value.error.reason === 'WAIT_EXPIRED',
      ),
    ).toBe(true);
    expect(sends()).toHaveLength(1);
    hold.resolve(sendResult());
    expect((await active).isOk()).toBe(true);
  });

  it('charges the entire retained queued generic bodies/tails against the inclusive 1MiB waiting budget', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const active = sender.sendPreparedChunk(groupA, 'active', context());
    await flush();
    const contexts = Array.from({ length: 4 }, () => context());
    const waiting = contexts.map((ctx) =>
      sender.send(groupB, { body: 'x'.repeat(262_144), trustedDelivery: ctx }),
    );
    expect((await sender.sendPreparedChunk(groupB, 'x', context()))._unsafeUnwrapErr().reason).toBe(
      'RPC_CAPACITY',
    );
    expect(sender.cancelWaiter(contexts[0])).toBe(true);
    expect((await waiting[0])._unsafeUnwrapErr().reason).toBe('CANCELLED');
    const replacementCtx = context();
    const replacement = sender.send(groupB, {
      body: 'x'.repeat(262_144),
      trustedDelivery: replacementCtx,
    });
    expect((await sender.sendPreparedChunk(groupB, 'x', context()))._unsafeUnwrapErr().reason).toBe(
      'RPC_CAPACITY',
    );
    sender.quiesce();
    await Promise.all([...waiting, replacement]);
    hold.resolve(sendResult());
    await active;
  });

  it('cancels only the selected unwritten waiter, leaving the active send and other waiter intact', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const activeCtx = context();
    const active = sender.sendPreparedChunk(groupA, 'active', activeCtx);
    await flush();
    const ctx = context();
    const removed = sender.sendPreparedChunk(groupB, 'removed', ctx);
    const kept = sender.sendPreparedChunk(groupB, 'kept', context());
    expect(sender.cancelWaiter(activeCtx)).toBe(false);
    expect(sender.cancelWaiter(ctx)).toBe(true);
    expect((await removed)._unsafeUnwrapErr().reason).toBe('CANCELLED');
    nextSend = () => sendResult();
    hold.resolve(sendResult());
    await advance(1000);
    expect((await active).isOk() && (await kept).isOk()).toBe(true);
    expect(
      sends().map((call) => call.request.method === 'send' && call.request.params.message),
    ).toEqual(['active', 'kept']);
  });

  it.each([
    'expired',
    'generation',
    'device',
    'account',
    'mode',
    'unverified',
    'reconnecting',
  ] as const)(
    'waits for an actual matching proof renewal after %s rather than a boolean ready flag',
    async (kind) => {
      if (kind === 'expired')
        readiness = {
          ...readiness,
          proof: {
            ...readiness.proof,
            status: 'verified',
            verifiedAt: initialTime - 300_000,
            expiresAt: initialTime,
            humanDevices: [],
          },
        };
      if (kind === 'generation')
        readiness = { ...readiness, proof: { ...readiness.proof, generation: 6 } };
      if (kind === 'device')
        readiness = { ...readiness, proof: { ...readiness.proof, bridgeDeviceId: 4 } };
      if (kind === 'account')
        readiness = { ...readiness, proof: { ...readiness.proof, accountUuid: peer } };
      if (kind === 'mode')
        readiness = { ...readiness, proof: { ...readiness.proof, accountMode: 'dedicated' } };
      if (kind === 'unverified')
        readiness = {
          ...readiness,
          proof: {
            status: 'unverified',
            accountUuid: account,
            accountMode: 'personal',
            bridgeDeviceId: 3,
            generation: 7,
          },
        };
      if (kind === 'reconnecting') readiness = { ...readiness, state: 'reconnecting' };
      const ctx = save('saved');
      const pending = sender.sendPreparedChunk(target, 'saved', ctx);
      await advance(5000);
      expect(calls).toEqual([]);
      readiness = { ...readiness, state: 'ready' };
      renew();
      sender.readinessChanged();
      expect((await pending).isOk()).toBe(true);
      expect(sends()).toHaveLength(1);
    },
  );

  it('does not send on a generation replaced during target lookup and never revives the old instance after stop', async () => {
    const hold = deferred<SignalRpcResult>();
    nextMetadata = () => hold.promise;
    const pending = sender.sendPreparedChunk(target, 'text', context());
    await flush();
    readiness = { ...readiness, generation: 8 };
    renew();
    hold.resolve(
      metadata({
        method: 'listContacts',
        params: { account, recipient: [account], allRecipients: true },
      }),
    );
    expect((await pending)._unsafeUnwrapErr().reason).toBe('UNAVAILABLE');
    expect(sends()).toHaveLength(0);
    expect((await sender.drain()).isOk()).toBe(true);
    sender.readinessChanged();
    await advance(60_000);
    expect((await sender.sendPreparedChunk(target, 'old', context())).isErr()).toBe(true);
    expect(sends()).toHaveLength(0);
  });

  it('fetches fresh target state before every chunk, terminating only the unsent tail with honest prior counts', async () => {
    const body = 'a'.repeat(2001);
    const ctx = save(body);
    let lookups = 0;
    nextMetadata = (request) =>
      ++lookups === 1
        ? metadata(request)
        : ok({
            kind: 'result',
            value: [
              { uuid: account, isBlocked: false, unregistered: false, messageExpirationTime: 60 },
            ],
          });
    const pending = sender.send(target, { body, trustedDelivery: ctx });
    await advance(1000);
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'TARGET_REFUSED',
      outcome: 'PARTIAL',
      currentChunkAcceptance: 'unwritten',
      acceptedChunks: 1,
      successCount: 1,
    });
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'terminal',
      nextChunk: 1,
      terminalReason: 'TARGET_REFUSED',
    });
    expect(lookups).toBe(2);
    expect(sends()).toHaveLength(1);
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
  });

  it('reselects current configuration after waits instead of trusting a prepared destination', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const active = sender.sendPreparedChunk(target, 'active', context());
    await flush();
    const pending = sender.sendPreparedChunk(groupA, 'group', save('group', groupA));
    readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
    nextSend = () => sendResult();
    hold.resolve(sendResult());
    await advance(1000);
    expect((await active).isOk()).toBe(true);
    expect((await pending)._unsafeUnwrapErr().reason).toBe('TARGET_REFUSED');
    expect(sends()).toHaveLength(1);
  });

  it('persists burst-one spacing across coordinator reconstruction and a backwards wall clock', async () => {
    await sender.sendPreparedChunk(target, 'one', context());
    await sender.drain();
    sender = reconstruct();
    vi.setSystemTime(initialTime - 500);
    readiness = {
      ...readiness,
      proof: verifySignalDevices(
        config,
        [
          { id: 1, name: null, createdTimestamp: 100, lastSeenTimestamp: 1 },
          { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 1 },
        ],
        7,
        initialTime - 1000,
      )._unsafeUnwrap(),
    };
    const pending = sender.sendPreparedChunk(target, 'two', context());
    await advance(1499);
    expect(sends()).toHaveLength(1);
    await advance(1);
    expect((await pending).isOk()).toBe(true);
    expect(sends().map((call) => call.at)).toEqual([initialTime, initialTime + 1000]);
  });

  it.each([-3, -5, -6])(
    'treats metadata RPC error %s as unwritten and persists only safe observed restrictions',
    async (code) => {
      nextMetadata = () => remote(code);
      const ctx = save('text');
      const error = (await sender.sendPreparedChunk(target, 'text', ctx))._unsafeUnwrapErr();
      expect(error).toMatchObject({
        outcome: 'NOT_SENT',
        currentChunkAcceptance: 'unwritten',
        retryScope: 'delivery_only',
      });
      const state = accounts.findByAccount(account)._unsafeUnwrap();
      expect(state?.recoveryNotBefore).toBe(0);
      expect(state?.rateLimitNotBefore).toBe(code === -5 ? initialTime + 900_000 : 0);
      expect(state?.pauseKind).toBe(
        code === -6 ? 'challenge' : code === -5 ? 'rate_limit' : 'none',
      );
      expect(checkpoint(ctx).phase).toBe('ready');
      expect(sends()).toHaveLength(0);
      expect(leases.find(account, target)._unsafeUnwrap()?.deliveryId).toBe(ctx.deliveryId);
    },
  );

  it('persists rate, challenge AND UNKNOWN recovery independently with a long uncapped server delay', async () => {
    nextSend = () =>
      remote(-6, [
        resultEntry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 5_000 }),
        resultEntry('NETWORK_FAILURE'),
      ]);
    const ctx = save('text');
    const error = (await sender.sendPreparedChunk(target, 'text', ctx))._unsafeUnwrapErr();
    expect(error).toMatchObject({ outcome: 'UNKNOWN', successCount: 0, failureCount: 2 });
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      reservation: null,
      pauseKind: 'challenge',
      rateLimitNotBefore: initialTime + 5_000_000,
      recoveryNotBefore: initialTime + 60_000,
    });
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'UNKNOWN',
      failureCount: 2,
    });
    expect(JSON.stringify(error)).not.toContain('private');
  });

  it.each([undefined, 0, Number.MAX_SAFE_INTEGER, 'bad'])(
    'honors minimum/malformed/overflow rate delay %s and never loses a challenge',
    async (delay) => {
      nextSend = () =>
        sendResult([
          resultEntry(
            'RATE_LIMIT_FAILURE',
            delay === undefined ? {} : { retryAfterSeconds: delay },
          ),
        ]);
      const error = (await sender.sendPreparedChunk(target, 'text', context()))._unsafeUnwrapErr();
      expect(error.outcome).toBe(delay === 'bad' ? 'UNKNOWN' : 'NOT_SENT');
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
        reservation: null,
        rateLimitNotBefore: initialTime + 900_000,
        pauseKind:
          delay === Number.MAX_SAFE_INTEGER || delay === 'bad' ? 'challenge' : 'rate_limit',
      });
      expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
    },
  );

  it('persists all restrictions beside Ok before releasing the gate, without double-counting chunk receipts', async () => {
    nextSend = () =>
      sendResult([resultEntry('SUCCESS', { retryAfterSeconds: 5000, token: 'discard-secret' })]);
    const ctx = save('accepted');
    expect(
      (await sender.sendPreparedChunk(target, 'accepted', ctx))._unsafeUnwrap().successCount,
    ).toBe(1);
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'delivered',
      acceptedChunks: 1,
      successCount: 1,
    });
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      pauseKind: 'challenge',
      rateLimitNotBefore: initialTime + 5_000_000,
      reservation: null,
    });
    const waiting = sender.sendPreparedChunk(groupB, 'blocked', context());
    await advance(30_000);
    expect((await waiting)._unsafeUnwrapErr()).toMatchObject({
      reason: 'CHALLENGE_REQUIRED',
      outcome: 'NOT_SENT',
    });
    expect(sends()).toHaveLength(1);
  });

  it('settles whole rate refusal cumulatively with a resumable cursor and does not count receipts twice', async () => {
    const ctx = save('a'.repeat(2001));
    await sender.sendPreparedChunk(target, 'a'.repeat(2000), ctx);
    nextSend = () => sendResult([resultEntry('RATE_LIMIT_FAILURE')]);
    const second = sender.sendPreparedChunk(target, 'a', ctx);
    await advance(1000);
    expect((await second)._unsafeUnwrapErr()).toMatchObject({
      acceptedChunks: 1,
      successCount: 1,
      failureCount: 1,
      outcome: 'PARTIAL',
      currentChunkAcceptance: 'refused',
      retryScope: 'delivery_only',
    });
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'ready',
      nextChunk: 1,
      successCount: 1,
      failureCount: 1,
    });
    expect(leases.find(account, target)._unsafeUnwrap()).not.toBeNull();
  });

  it('makes contradictory error-envelope all-SUCCESS UNKNOWN, not complete/PARTIAL', async () => {
    nextSend = () => remote(-1, [resultEntry()]);
    const ctx = save('text');
    expect((await sender.sendPreparedChunk(target, 'text', ctx))._unsafeUnwrapErr()).toMatchObject({
      outcome: 'UNKNOWN',
      currentChunkAcceptance: 'unknown',
      successCount: 1,
    });
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'terminal',
      nextChunk: 0,
      terminalOutcome: 'UNKNOWN',
      successCount: 1,
    });
  });

  it('automatically expires ordinary UNKNOWN recovery for a DISTINCT next message, never replaying the terminal delivery', async () => {
    nextSend = () => err(new SignalRpcTransportError('TIMEOUT', true));
    const ctx = save('unknown');
    expect(
      (await sender.sendPreparedChunk(target, 'unknown', ctx))._unsafeUnwrapErr().outcome,
    ).toBe('UNKNOWN');
    nextSend = () => sendResult();
    const blocked = sender.sendPreparedChunk(groupB, 'distinct', context());
    await advance(30_000);
    expect((await blocked)._unsafeUnwrapErr().reason).toBe('RECOVERY_PENDING');
    await advance(30_000);
    expect((await sender.sendPreparedChunk(groupB, 'distinct', context())).isOk()).toBe(true);
    const replay = sender.sendPreparedChunk(target, 'unknown', ctx);
    await advance(1000);
    expect((await replay).isErr()).toBe(true);
    expect(
      sends().map((call) => call.request.method === 'send' && call.request.params.message),
    ).toEqual(['unknown', 'distinct']);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('recovery');
  });

  it('retries ONLY post-RPC DATABASE settlement writes with retained receipt, including all restrictions atomically', async () => {
    const original = queue.settleSignalChunk.bind(queue);
    const settle = vi
      .spyOn(queue, 'settleSignalChunk')
      .mockReturnValueOnce(err(new SignalStateError('DATABASE')))
      .mockImplementation(original);
    nextSend = () =>
      sendResult([resultEntry('SUCCESS', { retryAfterSeconds: 5000, token: 'secret' })]);
    const ctx = save('accepted');
    const pending = sender.sendPreparedChunk(target, 'accepted', ctx);
    await flush();
    expect(sends()).toHaveLength(1);
    expect(checkpoint(ctx).phase).toBe('in_flight');
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      reservation: { deliveryId: ctx.deliveryId },
      rateLimitNotBefore: 0,
      pauseKind: 'none',
    });
    await advance(250);
    expect((await pending).isOk()).toBe(true);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(sends()).toHaveLength(1);
    expect(checkpoint(ctx)).toMatchObject({ successCount: 1, nextChunk: 1 });
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      reservation: null,
      pauseKind: 'challenge',
      rateLimitNotBefore: initialTime + 5_000_000,
    });
  });

  it('does not retry non-DATABASE ownership conflicts or dispatch through uncertainty', async () => {
    const settle = vi
      .spyOn(queue, 'settleSignalChunk')
      .mockReturnValue(err(new SignalStateError('CONFLICT')));
    const ctx = save('accepted');
    expect(
      (await sender.sendPreparedChunk(target, 'accepted', ctx))._unsafeUnwrapErr(),
    ).toMatchObject({
      reason: 'STATE_WRITE_FAILED',
      outcome: 'PARTIAL',
      currentChunkAcceptance: 'complete',
      successCount: 1,
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect((await sender.drain()).isErr()).toBe(true);
    expect((await sender.sendPreparedChunk(groupB, 'no', context())).isErr()).toBe(true);
    expect(sends()).toHaveLength(1);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
  });

  it('caps failed DATABASE writes, reports drain failure and preserves recovery ownership rather than claiming idle', async () => {
    const settle = vi
      .spyOn(queue, 'settleSignalChunk')
      .mockReturnValue(err(new SignalStateError('DATABASE')));
    const ctx = save('accepted');
    const pending = sender.sendPreparedChunk(target, 'accepted', ctx);
    await advance(8000);
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'STATE_WRITE_FAILED',
      currentChunkAcceptance: 'complete',
      successCount: 1,
    });
    expect(settle).toHaveBeenCalledTimes(6);
    expect((await sender.drain())._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(sends()).toHaveLength(1);
    expect(checkpoint(ctx).phase).toBe('in_flight');
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
  });

  it('refuses bytes if guard or reservation writes fail and releases standalone invocation leases', async () => {
    const ctx = context();
    const reserve = vi
      .spyOn(accounts, 'reserveSend')
      .mockReturnValueOnce(err(new SignalStateError('DATABASE')));
    expect((await sender.sendPreparedChunk(target, 'text', ctx))._unsafeUnwrapErr().reason).toBe(
      'STATE_WRITE_FAILED',
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
    const guard = vi
      .spyOn(queue, 'markSignalDeliveryStarted')
      .mockReturnValueOnce(err(new SignalStateError('CONFLICT')));
    expect((await sender.sendPreparedChunk(target, 'new', context())).isErr()).toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(sends()).toHaveLength(0);
  });

  it('recovers a pre-reservation orphan invocation with the REAL queue recovery API, never replaying a provider', () => {
    const ctx = context();
    queue
      .markSignalDeliveryStarted({ version: 1, ...ctx, startedAt: Date.now() }, null, Date.now())
      ._unsafeUnwrap();
    leases.acquire(account, target, ctx, Date.now())._unsafeUnwrap();
    sender.quiesce();
    expect(queue.recoverSignalQueue(Date.now())._unsafeUnwrap()).toMatchObject({
      orphanLeasesReleased: 1,
      reservationsClassified: 0,
    });
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
    expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()?.status).toBe('dead_letter');
    expect(calls).toEqual([]);
  });

  it.each(['success', 'unknown'] as const)(
    'commits owned account cleanup after purge during active RPC (%s), without resurrecting row/body/history',
    async (outcome) => {
      const hold = deferred<SignalRpcResult>();
      nextSend = () => hold.promise;
      const ctx = save('a'.repeat(2001));
      const pending = sender.send(target, { body: 'a'.repeat(2001), trustedDelivery: ctx });
      await flush();
      queue
        .purge(['pending', 'failed', 'claimed', 'processing', 'completed', 'dead_letter'])
        ._unsafeUnwrap();
      hold.resolve(
        outcome === 'success' ? sendResult() : err(new SignalRpcTransportError('TIMEOUT', true)),
      );
      const error = (await pending)._unsafeUnwrapErr();
      expect(error).toMatchObject({
        reason: 'CANCELLED',
        outcome: outcome === 'success' ? 'PARTIAL' : 'UNKNOWN',
        currentChunkAcceptance: outcome === 'success' ? 'complete' : 'unknown',
        successCount: outcome === 'success' ? 1 : 0,
      });
      expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
        reservation: null,
        recoveryNotBefore: outcome === 'unknown' ? initialTime + 60_000 : 0,
      });
      expect(sends()).toHaveLength(1);
      expect(db.prepare('SELECT count(*) AS total FROM messages').get()).toEqual({ total: 0 });
    },
  );

  it('purge while deferred cannot recreate the saved body or authorize a later chunk', async () => {
    readiness = { ...readiness, state: 'reconnecting' };
    const ctx = save('text');
    const pending = sender.sendPreparedChunk(target, 'text', ctx);
    queue.purge(['pending'])._unsafeUnwrap();
    readiness = { ...readiness, state: 'ready' };
    sender.readinessChanged();
    expect((await pending)._unsafeUnwrapErr().reason).toBe('CANCELLED');
    expect(calls).toEqual([]);
    expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
  });

  it('quiesces admissions and unwritten waits while allowing a responding active RPC to settle once before drain completes', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const ctx = save('responding');
    const pending = sender.sendPreparedChunk(target, 'responding', ctx);
    await flush();
    const waiting = sender.sendPreparedChunk(groupB, 'waiting', context());
    const drained = sender.drain();
    expect((await waiting)._unsafeUnwrapErr()).toMatchObject({
      outcome: 'NOT_SENT',
      currentChunkAcceptance: 'unwritten',
    });
    expect((await sender.sendPreparedChunk(groupB, 'new', context())).isErr()).toBe(true);
    hold.resolve(sendResult());
    expect((await pending).isOk()).toBe(true);
    expect((await drained).isOk()).toBe(true);
    expect(checkpoint(ctx).phase).toBe('delivered');
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
    await advance(60_000);
    expect(sends()).toHaveLength(1);
  });

  it('forces UNKNOWN at the 30s drain cap, settles once and ignores a late success callback', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const ctx = save('a'.repeat(2001));
    const pending = sender.send(target, { body: 'a'.repeat(2001), trustedDelivery: ctx });
    await flush();
    const settled = vi.spyOn(queue, 'settleSignalChunk');
    const drained = sender.drain();
    await advance(30_000);
    expect((await pending)._unsafeUnwrapErr().outcome).toBe('UNKNOWN');
    expect((await drained).isOk()).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'terminal',
      nextChunk: 0,
      terminalOutcome: 'UNKNOWN',
    });
    hold.resolve(sendResult());
    await advance(60_000);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(sends()).toHaveLength(1);
    nextSend = () => sendResult();
    sender = reconstruct();
    renew();
    expect((await sender.sendPreparedChunk(groupB, 'distinct', context())).isOk()).toBe(true);
    expect(sends()).toHaveLength(2);
  });

  it('retains a saved proven-unwritten owner across deferral while a blocked competitor cannot prevent its return', async () => {
    nextSend = () => err(new SignalRpcTransportError('DISCONNECTED'));
    const ctx = save('a'.repeat(2001), groupA);
    expect(
      (await sender.sendPreparedChunk(groupA, 'a'.repeat(2000), ctx))._unsafeUnwrapErr(),
    ).toMatchObject({ currentChunkAcceptance: 'unwritten', retryScope: 'delivery_only' });
    expect(checkpoint(ctx).phase).toBe('ready');
    const competitor = sender.send(groupA, { body: 'competitor', trustedDelivery: context() });
    nextSend = () => sendResult();
    const resumed = sender.send(groupA, { body: 'a'.repeat(2001), trustedDelivery: ctx });
    const unrelated = sender.send(groupB, { body: 'unrelated', trustedDelivery: context() });
    await advance(5000);
    expect((await competitor).isOk() && (await resumed).isOk() && (await unrelated).isOk()).toBe(
      true,
    );
    expect(
      sends().map((call) => (call.request.method === 'send' ? call.request.params.message[0] : '')),
    ).toEqual(['a', 'a', 'u', 'a', 'c']);
    expect(checkpoint(ctx)).toMatchObject({ phase: 'delivered', successCount: 2, failureCount: 0 });
  });

  it.each(['explicit', 'progress'] as const)(
    'releases standalone %s leases on every pre-reservation failure path',
    async (purpose) => {
      for (const mode of ['malformed', 'unsafe', 'proof', 'selection', 'stop'] as const) {
        nextMetadata = (request) => {
          if (mode === 'malformed') return ok({ kind: 'result', value: [] });
          if (mode === 'unsafe')
            return ok({
              kind: 'result',
              value: [
                { uuid: account, isBlocked: true, unregistered: false, messageExpirationTime: 0 },
              ],
            });
          if (mode === 'proof') readiness = { ...readiness, state: 'reconnecting' };
          if (mode === 'selection')
            readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
          if (mode === 'stop') sender.quiesce();
          return metadata(request);
        };
        const destination = mode === 'selection' ? groupA : target;
        expect(
          (await sender.sendPreparedChunk(destination, 'text', context(purpose))).isErr(),
        ).toBe(true);
        expect(leases.find(account, destination)._unsafeUnwrap()).toBeNull();
        expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
        readiness = { ...readiness, state: 'ready', config };
        renew();
      }
      expect(sends()).toHaveLength(0);
    },
  );

  it('terminalizes expired saved work before a metadata RPC and releases its retained lease', async () => {
    const ctx = save('expired');
    leases.acquire(account, target, ctx, Date.now())._unsafeUnwrap();
    await advance(SIGNAL_CHECKPOINT_LIFETIME_MS);
    renew();
    expect(
      (await sender.sendPreparedChunk(target, 'expired', ctx))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'CHECKPOINT_EXPIRED', outcome: 'NOT_SENT', retryScope: 'none' });
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'terminal',
      terminalReason: 'CHECKPOINT_EXPIRED',
    });
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('terminalizes a newly unselected saved target even on an immediate admission refusal', async () => {
    const ctx = save('selected', groupA);
    leases.acquire(account, groupA, ctx, Date.now())._unsafeUnwrap();
    readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
    expect(
      (await sender.sendPreparedChunk(groupA, 'selected', ctx))._unsafeUnwrapErr().reason,
    ).toBe('TARGET_REFUSED');
    expect(checkpoint(ctx).phase).toBe('terminal');
    expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('uses latest-marker CAS again after metadata, refusing a completed queue row before reservation', async () => {
    const ctx = context();
    nextMetadata = (request) => {
      queue.complete(ctx.queueItemId)._unsafeUnwrap();
      return metadata(request);
    };
    const marks = vi.spyOn(queue, 'markSignalDeliveryStarted');
    expect((await sender.sendPreparedChunk(target, 'text', ctx))._unsafeUnwrapErr().reason).toBe(
      'CHECKPOINT_INVALID',
    );
    expect(marks).toHaveBeenCalledTimes(2);
    expect(sends()).toHaveLength(0);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
    expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()?.status).toBe('completed');
  });

  it('never overwrites an unrelated newer marker or payload with a stale invocation snapshot', async () => {
    const ctx = context();
    const newer = {
      version: 1 as const,
      ...ctx,
      deliveryId: 'another-real-operation',
      startedAt: Date.now(),
    };
    nextMetadata = (request) => {
      const state = queue.inspectSignalDelivery(ctx.queueItemId, Date.now())._unsafeUnwrap();
      if (state.kind !== 'invoked') throw new Error('Missing marker fixture');
      queue.markSignalDeliveryStarted(newer, state.marker, Date.now())._unsafeUnwrap();
      db.prepare(
        "UPDATE queue_items SET payload = json_set(payload, '$.concurrent', 7) WHERE id = ?",
      ).run(ctx.queueItemId);
      return metadata(request);
    };
    expect((await sender.sendPreparedChunk(target, 'text', ctx)).isOk()).toBe(true);
    const payload = JSON.parse(queue.findById(ctx.queueItemId)._unsafeUnwrap()!.payload);
    expect(payload.concurrent).toBe(7);
    expect(payload.untouched).toBe(true);
    expect(payload.__talond_signal_delivery_started_v1).toMatchObject({
      deliveryId: ctx.deliveryId,
    });
    expect(sends()).toHaveLength(1);
  });

  it('settles after an unrelated device-check revision without rejecting the real owner or repeating its RPC', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const ctx = save('text');
    const pending = sender.sendPreparedChunk(target, 'text', ctx);
    await flush();
    const before = accounts.findByAccount(account)._unsafeUnwrap()!;
    accounts.startDeviceCheck(account, before.revision, Date.now())._unsafeUnwrap();
    hold.resolve(sendResult([resultEntry(), resultEntry()]));
    expect((await pending)._unsafeUnwrap().successCount).toBe(2);
    expect(checkpoint(ctx)).toMatchObject({
      acceptedChunks: 1,
      successCount: 2,
      phase: 'delivered',
    });
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      reservation: null,
      lastDeviceCheckStart: initialTime,
    });
    expect(sends()).toHaveLength(1);
  });

  it('retries metadata restriction DATABASE writes without another lookup or accidental send recovery', async () => {
    nextMetadata = () =>
      remote(-6, [resultEntry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 5000 })]);
    const record = vi.spyOn(accounts, 'recordPause');
    record.mockReturnValueOnce(err(new SignalStateError('DATABASE')));
    const pending = sender.sendPreparedChunk(target, 'text', context());
    await flush();
    expect(calls).toHaveLength(1);
    expect(leases.find(account, target)._unsafeUnwrap()).not.toBeNull();
    await advance(250);
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      outcome: 'NOT_SENT',
      reason: 'CHALLENGE_REQUIRED',
    });
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      pauseKind: 'challenge',
      rateLimitNotBefore: initialTime + 5_000_000,
      recoveryNotBefore: 0,
    });
    expect(calls).toHaveLength(1);
    expect(sends()).toHaveLength(0);
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
  });

  it('drains only to the remaining request deadline when less than 30s remains', async () => {
    readiness = { ...readiness, config: { ...config, requestTimeoutMs: 1000 } };
    nextSend = () => new Promise<SignalRpcResult>(() => undefined);
    const ctx = save('text');
    const pending = sender.sendPreparedChunk(target, 'text', ctx);
    await flush();
    await advance(700);
    const drain = sender.drain();
    await advance(299);
    expect(checkpoint(ctx).phase).toBe('in_flight');
    await advance(1);
    expect((await pending)._unsafeUnwrapErr().outcome).toBe('UNKNOWN');
    expect((await drain).isOk()).toBe(true);
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      reservation: null,
      recoveryNotBefore: initialTime + 1000 + 60_000,
    });
  });

  it('reports bounded forced-drain database failure without clearing unresolved durable ownership', async () => {
    nextSend = () => new Promise<SignalRpcResult>(() => undefined);
    const ctx = save('text');
    const pending = sender.sendPreparedChunk(target, 'text', ctx);
    await flush();
    const settle = vi
      .spyOn(queue, 'settleSignalChunk')
      .mockReturnValue(err(new SignalStateError('DATABASE')));
    const drained = sender.drain();
    await advance(30_000);
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'STATE_WRITE_FAILED',
    });
    expect((await drained)._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(checkpoint(ctx).phase).toBe('in_flight');
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it('BLOCKER: permanent refusal terminalizes a saved waiter without changing another valid destination owner', async () => {
    const owner = save('owning saved message', groupA);
    accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
    const ownerLease = leases.acquire(account, groupA, owner, Date.now())._unsafeUnwrap();
    const ownerCheckpoint = checkpoint(owner);
    const beforeAccount = accounts.findByAccount(account)._unsafeUnwrap();
    const waiter = save('newly unselected saved message', groupA);
    readiness = { ...readiness, config: { ...config, allowedGroups: [] } };

    const result = await sender.sendPreparedChunk(groupA, 'newly unselected saved message', waiter);

    // The owning message/account/lease must be unaffected. Assertions are outside callbacks.
    expect(checkpoint(owner)).toEqual(ownerCheckpoint);
    expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(ownerLease);
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(beforeAccount);
    expect(calls).toEqual([]);
    // Historical TASK006 blocker, repaired by reviewed TASK017: terminating this ready
    // waiter must leave a DIFFERENT valid owner untouched, without rolling back the decision.
    expect(checkpoint(waiter)).toMatchObject({
      phase: 'terminal',
      terminalReason: 'TARGET_REFUSED',
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      reason: 'TARGET_REFUSED',
      outcome: 'NOT_SENT',
    });
  });

  it('defers only the cancelled saved call behind a foreign active owner, without terminalizing durable work', async () => {
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const owner = save('owner', groupA);
    const active = sender.sendPreparedChunk(groupA, 'owner', owner);
    await flush();
    const ownerLease = leases.find(account, groupA)._unsafeUnwrap();
    const accountBefore = accounts.findByAccount(account)._unsafeUnwrap();
    const waiter = save('waiter', groupA);
    const before = checkpoint(waiter);
    const removed = sender.sendPreparedChunk(groupA, 'waiter', waiter);
    const keptContext = save('kept', groupB);
    const kept = sender.sendPreparedChunk(groupB, 'kept', keptContext);
    expect(sender.cancelWaiter(owner)).toBe(false);
    expect(sender.cancelWaiter(waiter)).toBe(true);
    expect((await removed)._unsafeUnwrapErr()).toMatchObject({
      reason: 'CANCELLED',
      currentChunkAcceptance: 'unwritten',
      retryScope: 'delivery_only',
    });
    expect(checkpoint(waiter)).toEqual(before);
    expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(ownerLease);
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(accountBefore);
    nextSend = () => sendResult();
    hold.resolve(sendResult());
    await advance(1000);
    expect((await active).isOk() && (await kept).isOk()).toBe(true);
    const retry = sender.sendPreparedChunk(groupA, 'waiter', waiter);
    await advance(1000);
    expect((await retry).isOk()).toBe(true);
    expect(checkpoint(waiter).phase).toBe('delivered');
    expect(
      sends().map((call) => call.request.method === 'send' && call.request.params.message),
    ).toEqual(['owner', 'kept', 'waiter']);
  });

  it('retains the saved lease and accepted cursor when its next unwritten call is cancelled between chunks', async () => {
    const body = 'a'.repeat(2001);
    const ctx = save(body, groupA);
    const pending = sender.send(groupA, { body, trustedDelivery: ctx });
    await flush();
    const before = checkpoint(ctx);
    const leaseBefore = leases.find(account, groupA)._unsafeUnwrap();
    expect(before).toMatchObject({ phase: 'ready', nextChunk: 1, successCount: 1 });
    expect(sender.cancelWaiter(ctx)).toBe(true);
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'CANCELLED',
      outcome: 'PARTIAL',
      acceptedChunks: 1,
      successCount: 1,
      retryScope: 'delivery_only',
    });
    expect(checkpoint(ctx)).toEqual(before);
    expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(leaseBefore);
    const retry = sender.sendPreparedChunk(groupA, 'a', ctx);
    await advance(1000);
    expect((await retry).isOk()).toBe(true);
    expect(checkpoint(ctx)).toMatchObject({ phase: 'delivered', successCount: 2 });
    expect(sends()).toHaveLength(2);
  });

  it.each(['reply', 'explicit'] as const)(
    'preserves permanent Needs setup arising during metadata for %s',
    async (purpose) => {
      const hold = deferred<SignalRpcResult>();
      nextMetadata = () => hold.promise;
      const ctx = purpose === 'reply' ? save('text') : context();
      const pending = sender.sendPreparedChunk(target, 'text', ctx);
      await flush();
      readiness = { ...readiness, state: 'needs_setup' };
      hold.resolve(
        metadata({
          method: 'listContacts',
          params: { account, recipient: [account], allRecipients: true },
        }),
      );
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        reason: 'NEEDS_SETUP',
        outcome: 'NOT_SENT',
        retryScope: 'none',
      });
      if (purpose === 'reply')
        expect(checkpoint(ctx)).toMatchObject({ phase: 'terminal', terminalReason: 'NEEDS_SETUP' });
      expect(sends()).toHaveLength(0);
      expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
      expect((await sender.drain()).isOk()).toBe(true);
    },
  );

  it('preserves account replacement during metadata as a permanent saved failure', async () => {
    const hold = deferred<SignalRpcResult>();
    nextMetadata = () => hold.promise;
    const ctx = save('text');
    const pending = sender.sendPreparedChunk(target, 'text', ctx);
    await flush();
    readiness = { ...readiness, config: { ...config, account: peer, accountUuid: peer } };
    hold.resolve(
      metadata({
        method: 'listContacts',
        params: { account, recipient: [account], allRecipients: true },
      }),
    );
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'ACCOUNT_MISMATCH',
      retryScope: 'none',
      currentChunkAcceptance: 'unwritten',
    });
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'terminal',
      terminalReason: 'ACCOUNT_MISMATCH',
    });
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
    expect(sends()).toHaveLength(0);
  });

  it.each(['rate_limit', 'challenge', 'recovery'] as const)(
    'terminalizes a newly unselected queued waiter during %s without touching its foreign owner',
    async (kind) => {
      const owner = save('owner', groupA);
      const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
      accounts
        .recordPause(
          account,
          state.revision,
          kind === 'rate_limit' ? { kind, notBefore: Date.now() + 900_000 } : { kind },
          Date.now(),
        )
        ._unsafeUnwrap();
      const beforeAccount = accounts.findByAccount(account)._unsafeUnwrap();
      const ownerLease = leases.acquire(account, groupA, owner, Date.now())._unsafeUnwrap();
      const ownerCheckpoint = checkpoint(owner);
      const ctx = save('queued', groupA);
      const pending = sender.sendPreparedChunk(groupA, 'queued', ctx);
      let completed = false;
      void pending.then(() => {
        completed = true;
      });
      readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
      sender.readinessChanged();
      await advance(50);
      expect(completed).toBe(true);
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        reason: 'TARGET_REFUSED',
        retryScope: 'none',
      });
      expect(checkpoint(ctx)).toMatchObject({
        phase: 'terminal',
        terminalReason: 'TARGET_REFUSED',
      });
      expect(checkpoint(owner)).toEqual(ownerCheckpoint);
      expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(ownerLease);
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(beforeAccount);
      expect(calls).toEqual([]);
      expect((await sender.drain()).isOk()).toBe(true);
    },
  );

  it.each(['needs_setup', 'replacement'] as const)(
    'terminalizes permanent %s while challenged and foreign-leased without waiting for the account fence',
    async (change) => {
      const owner = save('owner', groupA);
      const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
      accounts
        .recordPause(account, state.revision, { kind: 'challenge' }, Date.now())
        ._unsafeUnwrap();
      const beforeAccount = accounts.findByAccount(account)._unsafeUnwrap();
      const beforeLease = leases.acquire(account, groupA, owner, Date.now())._unsafeUnwrap();
      const ctx = save('queued', groupA);
      const pending = sender.sendPreparedChunk(groupA, 'queued', ctx);
      let completed = false;
      void pending.then(() => {
        completed = true;
      });
      readiness =
        change === 'needs_setup'
          ? { ...readiness, state: 'needs_setup' }
          : { ...readiness, config: { ...config, account: peer, accountUuid: peer } };
      sender.readinessChanged();
      await advance(50);
      expect(completed).toBe(true);
      const reason = change === 'needs_setup' ? 'NEEDS_SETUP' : 'ACCOUNT_MISMATCH';
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({ reason, retryScope: 'none' });
      expect(checkpoint(ctx)).toMatchObject({ phase: 'terminal', terminalReason: reason });
      expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(beforeLease);
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(beforeAccount);
      expect(calls).toEqual([]);
      expect((await sender.drain()).isOk()).toBe(true);
    },
  );

  it.each(['rate_limit', 'challenge', 'recovery'] as const)(
    'terminalizes live expiry during %s even with stale proof and a foreign valid lease',
    async (kind) => {
      const ctx = save('expires', groupA);
      await advance(SIGNAL_CHECKPOINT_LIFETIME_MS - 200);
      const owner = save('fresh owner', groupA);
      const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
      accounts
        .recordPause(
          account,
          state.revision,
          kind === 'rate_limit' ? { kind, notBefore: Date.now() + 900_000 } : { kind },
          Date.now(),
        )
        ._unsafeUnwrap();
      const beforeAccount = accounts.findByAccount(account)._unsafeUnwrap();
      const ownerLease = leases.acquire(account, groupA, owner, Date.now())._unsafeUnwrap();
      const pending = sender.sendPreparedChunk(groupA, 'expires', ctx);
      let completed = false;
      void pending.then(() => {
        completed = true;
      });
      await advance(199);
      expect(completed).toBe(false);
      await advance(51);
      expect(completed).toBe(true);
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        reason: 'CHECKPOINT_EXPIRED',
        retryScope: 'none',
      });
      expect(checkpoint(ctx)).toMatchObject({
        phase: 'terminal',
        terminalReason: 'CHECKPOINT_EXPIRED',
      });
      expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(ownerLease);
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(beforeAccount);
      expect(calls).toEqual([]);
    },
  );

  it('expires a foreign waiter while another RPC is active, then lets that owner rejoin for its remaining chunks', async () => {
    const waiter = save('expires', groupA);
    await advance(SIGNAL_CHECKPOINT_LIFETIME_MS - 200);
    renew();
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const body = 'a'.repeat(4001);
    const owner = save(body, groupA);
    const active = sender.send(groupA, { body, trustedDelivery: owner });
    await flush();
    const accountBefore = accounts.findByAccount(account)._unsafeUnwrap();
    const leaseBefore = leases.find(account, groupA)._unsafeUnwrap();
    const removed = sender.sendPreparedChunk(groupA, 'expires', waiter);
    let completed = false;
    void removed.then(() => {
      completed = true;
    });
    await advance(250);
    expect(completed).toBe(true);
    expect((await removed)._unsafeUnwrapErr()).toMatchObject({
      reason: 'CHECKPOINT_EXPIRED',
      retryScope: 'none',
    });
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(accountBefore);
    expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(leaseBefore);
    expect(sends()).toHaveLength(1);
    nextSend = () => sendResult();
    hold.resolve(sendResult());
    await advance(3000);
    expect((await active).isOk()).toBe(true);
    expect(checkpoint(owner)).toMatchObject({ phase: 'delivered', acceptedChunks: 3 });
    expect(
      sends()
        .map((call) => call.request.method === 'send' && call.request.params.message)
        .join(''),
    ).toBe(body);
    expect((await sender.drain()).isOk()).toBe(true);
  });

  it('does not poison account dispatch on a non-DATABASE ready terminalization conflict', async () => {
    const ctx = save('refused', groupA);
    readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
    const terminate = vi
      .spyOn(queue, 'terminateSignalDelivery')
      .mockReturnValueOnce(err(new SignalStateError('CONFLICT')));
    expect((await sender.sendPreparedChunk(groupA, 'refused', ctx)).isErr()).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(checkpoint(ctx).phase).toBe('ready');
    expect((await sender.sendPreparedChunk(target, 'unrelated', context())).isOk()).toBe(true);
    expect(sends()).toHaveLength(1);
    expect((await sender.drain()).isOk()).toBe(true);
  });

  it('charges a whole retained generic saved body while its unwritten terminal DATABASE write is waiting', async () => {
    const body = 'x'.repeat(1_048_576);
    const ctx = save(body, groupA);
    readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
    vi.spyOn(queue, 'terminateSignalDelivery').mockReturnValue(
      err(new SignalStateError('DATABASE')),
    );
    const retained = sender.send(groupA, { body, trustedDelivery: ctx });
    await flush();
    const other = save('small', groupB);
    const rejected = sender.sendPreparedChunk(groupB, 'small', other);
    let completed = false;
    void rejected.then(() => {
      completed = true;
    });
    await flush();
    expect(completed).toBe(true);
    expect((await rejected)._unsafeUnwrapErr()).toMatchObject({
      reason: 'RPC_CAPACITY',
      retryScope: 'delivery_only',
    });
    expect(checkpoint(other).phase).toBe('ready');
    expect(calls).toEqual([]);
    await advance(8000);
    expect((await retained)._unsafeUnwrapErr().reason).toBe('STATE_WRITE_FAILED');
  });

  it('bounds unwritten local terminal-write waiters at 64, not only operations waiting for the account slot', async () => {
    const contexts = Array.from({ length: 65 }, () => save('small', groupA));
    readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
    vi.spyOn(queue, 'terminateSignalDelivery').mockReturnValue(
      err(new SignalStateError('DATABASE')),
    );
    const retained = contexts
      .slice(0, 64)
      .map((ctx) => sender.sendPreparedChunk(groupA, 'small', ctx));
    const rejected = sender.sendPreparedChunk(groupA, 'small', contexts[64]);
    let completed = false;
    void rejected.then(() => {
      completed = true;
    });
    await flush();
    expect(completed).toBe(true);
    expect((await rejected)._unsafeUnwrapErr()).toMatchObject({
      reason: 'RPC_CAPACITY',
      outcome: 'NOT_SENT',
    });
    expect(calls).toEqual([]);
    await advance(8000);
    expect((await Promise.all(retained)).every((result) => result.isErr())).toBe(true);
  });

  it('does not issue even a target lookup through failed account database authority, and resumes only after a successful read', async () => {
    const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
    const ctx = context();
    const read = vi
      .spyOn(accounts, 'getOrCreate')
      .mockReturnValue(err(new SignalStateError('DATABASE')));
    const pending = sender.sendPreparedChunk(target, 'text', ctx);
    await flush();
    expect(calls).toEqual([]);
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(state);
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
    read.mockRestore();
    sender.readinessChanged();
    expect((await pending).isOk()).toBe(true);
    expect(sends()).toHaveLength(1);
  });

  describe('review F1: failed lookup completion still screens current permanent authority', () => {
    for (const change of ['setup', 'replacement', 'selection', 'expiry'] as const) {
      it.each(['io', 'restrictions', 'transport'] as const)(
        `preserves ${change} after failed %s metadata, with prior counts and all observed restrictions`,
        async (kind) => {
          const ctx = save('a'.repeat(2000) + 'tail', groupA);
          await sender.sendPreparedChunk(groupA, 'a'.repeat(2000), ctx);
          await advance(change === 'expiry' ? SIGNAL_CHECKPOINT_LIFETIME_MS - 200 : 1000);
          renew();
          const hold = deferred<SignalRpcResult>();
          nextMetadata = () => hold.promise;
          const pending = sender.sendPreparedChunk(groupA, 'tail', ctx);
          await flush();
          if (change === 'setup') readiness = { ...readiness, state: 'needs_setup' };
          if (change === 'replacement')
            readiness = { ...readiness, config: { ...config, account: peer, accountUuid: peer } };
          if (change === 'selection')
            readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
          if (change === 'expiry') await advance(250);
          const detectedAt = Date.now();
          if (kind === 'restrictions')
            vi.spyOn(accounts, 'recordPause').mockReturnValueOnce(
              err(new SignalStateError('DATABASE')),
            );
          hold.resolve(
            kind === 'io'
              ? remote(-3)
              : kind === 'restrictions'
                ? remote(-6, [
                    resultEntry('RATE_LIMIT_FAILURE', {
                      retryAfterSeconds: 5000,
                      token: 'discard-secret',
                    }),
                  ])
                : err(new SignalRpcTransportError('TIMEOUT', true)),
          );
          await flush();
          if (kind === 'restrictions') {
            expect(checkpoint(ctx).phase).toBe('ready');
            await advance(250);
          }
          const reason =
            change === 'setup'
              ? 'NEEDS_SETUP'
              : change === 'replacement'
                ? 'ACCOUNT_MISMATCH'
                : change === 'selection'
                  ? 'TARGET_REFUSED'
                  : 'CHECKPOINT_EXPIRED';
          expect((await pending)._unsafeUnwrapErr()).toMatchObject({
            reason,
            outcome: 'PARTIAL',
            acceptedChunks: 1,
            successCount: 1,
            failureCount: 0,
            currentChunkAcceptance: 'unwritten',
            retryScope: 'none',
          });
          expect(checkpoint(ctx)).toMatchObject({
            phase: 'terminal',
            terminalReason: reason,
            nextChunk: 1,
            successCount: 1,
            failureCount: 0,
          });
          expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
          expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
            reservation: null,
            pauseKind: kind === 'restrictions' ? 'challenge' : 'none',
            rateLimitNotBefore: kind === 'restrictions' ? detectedAt + 5_000_000 : 0,
            recoveryNotBefore: 0,
          });
          expect(sends()).toHaveLength(1); // Only the earlier accepted chunk, never the failed lookup's chunk.
          expect(calls.filter((call) => call.request.method === 'listGroups')).toHaveLength(2);
        },
      );
    }

    it.each(['stale', 'reconnecting', 'stop'] as const)(
      'keeps failed metadata %s deferrable while committing all restrictive hints',
      async (change) => {
        const ctx = save('text', groupA);
        const hold = deferred<SignalRpcResult>();
        nextMetadata = () => hold.promise;
        const pending = sender.sendPreparedChunk(groupA, 'text', ctx);
        await flush();
        if (change === 'stale')
          readiness = {
            ...readiness,
            proof: {
              ...readiness.proof,
              status: 'verified',
              verifiedAt: initialTime - 300_000,
              expiresAt: initialTime,
              humanDevices: [],
            },
          };
        if (change === 'reconnecting') readiness = { ...readiness, state: 'reconnecting' };
        if (change === 'stop') {
          readiness = { ...readiness, state: 'needs_setup' };
          sender.quiesce();
        }
        hold.resolve(remote(-6, [resultEntry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 5000 })]));
        expect((await pending)._unsafeUnwrapErr()).toMatchObject({
          reason: change === 'stop' ? 'UNAVAILABLE' : 'CHALLENGE_REQUIRED',
          outcome: 'NOT_SENT',
          currentChunkAcceptance: 'unwritten',
          retryScope: 'delivery_only',
        });
        expect(checkpoint(ctx).phase).toBe('ready');
        expect(leases.find(account, groupA)._unsafeUnwrap()?.deliveryId).toBe(ctx.deliveryId);
        expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
          reservation: null,
          pauseKind: 'challenge',
          rateLimitNotBefore: initialTime + 5_000_000,
          recoveryNotBefore: 0,
        });
        expect(sends()).toHaveLength(0);
        expect(calls).toHaveLength(1);
      },
    );
  });

  it.each(['reply', 'explicit'] as const)(
    'review F2: bounds %s FIFO residence to30 elapsed seconds across a wall-clock rewind',
    async (purpose) => {
      readiness = { ...readiness, state: 'reconnecting' };
      const ctx = purpose === 'reply' ? save('text') : context();
      const rowBefore = queue.findById(ctx.queueItemId)._unsafeUnwrap();
      const start = performance.now();
      const pending = sender.sendPreparedChunk(target, 'text', ctx);
      let completed = false;
      void pending.then(() => {
        completed = true;
      });
      await advance(5000);
      vi.setSystemTime(Date.now() - 60_000);
      await advance(24_999);
      expect(performance.now() - start).toBe(29_999);
      expect(completed).toBe(false);
      await advance(1);
      expect(performance.now() - start).toBe(30_000);
      expect(completed).toBe(true);
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        outcome: 'NOT_SENT',
        currentChunkAcceptance: 'unwritten',
        retryScope: 'delivery_only',
      });
      const rowAfter = queue.findById(ctx.queueItemId)._unsafeUnwrap();
      expect(rowAfter?.payload).toBe(rowBefore?.payload);
      expect(rowAfter).toMatchObject({ attempts: 0, status: 'pending' });
      expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
      expect(calls).toEqual([]);
    },
  );

  it('review F2: request/drain/retry remaining duration stays monotonic after rewind, retaining failed settlement ownership', async () => {
    readiness = { ...readiness, config: { ...config, requestTimeoutMs: 1000 } };
    const ctx = save('text');
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const pending = sender.sendPreparedChunk(target, 'text', ctx);
    await flush();
    const start = performance.now();
    await advance(700);
    vi.setSystemTime(Date.now() - 60_000);
    const settle = vi
      .spyOn(queue, 'settleSignalChunk')
      .mockReturnValue(err(new SignalStateError('DATABASE')));
    const drained = sender.drain();
    let completed = false;
    void drained.then(() => {
      completed = true;
    });
    await advance(299);
    expect(completed).toBe(false);
    await advance(1);
    expect(performance.now() - start).toBe(1000);
    expect(completed).toBe(true);
    expect((await drained)._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'STATE_WRITE_FAILED',
      outcome: 'UNKNOWN',
      retryScope: 'none',
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
    expect(sends()).toHaveLength(1);
    hold.resolve(sendResult());
    await advance(8000);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(sends()).toHaveLength(1);
  });

  it.each(['rate', 'unwritten'] as const)(
    'review F3: committed purge is permanently CANCELLED after a retryable %s send outcome',
    async (kind) => {
      const ctx = save('a'.repeat(2000) + 'tail', groupA);
      await sender.sendPreparedChunk(groupA, 'a'.repeat(2000), ctx);
      await advance(1000);
      const hold = deferred<SignalRpcResult>();
      nextSend = () => hold.promise;
      const pending = sender.sendPreparedChunk(groupA, 'tail', ctx);
      await flush();
      queue
        .purge(['pending', 'failed', 'claimed', 'processing', 'completed', 'dead_letter'])
        ._unsafeUnwrap();
      hold.resolve(
        kind === 'rate'
          ? remote(-5, [
              resultEntry('RATE_LIMIT_FAILURE', {
                retryAfterSeconds: 5000,
                token: 'discard-secret',
              }),
            ])
          : err(new SignalRpcTransportError('DISCONNECTED')),
      );
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        reason: 'CANCELLED',
        outcome: 'PARTIAL',
        currentChunkAcceptance: kind === 'rate' ? 'refused' : 'unwritten',
        acceptedChunks: 1,
        successCount: 1,
        failureCount: kind === 'rate' ? 1 : 0,
        retryScope: 'none',
      });
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
        reservation: null,
        pauseKind: kind === 'rate' ? 'challenge' : 'none',
        rateLimitNotBefore: kind === 'rate' ? initialTime + 1000 + 5_000_000 : 0,
        recoveryNotBefore: 0,
      });
      expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
      expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
      expect(db.prepare('SELECT count(*) AS total FROM messages').get()).toEqual({ total: 0 });
      await advance(60_000);
      expect(sends()).toHaveLength(2); // Earlier chunk and this one attempt; never a resend or next chunk.
      expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
    },
  );

  describe('review2 R1: final saved resolution distinguishes purge from deferral and read failure', () => {
    for (const path of ['prepared', 'generic'] as const) {
      it.each(['io', 'restrictions', 'transport'] as const)(
        `permanently cancels purged ${path} tail after failed %s metadata, committing hints first`,
        async (kind) => {
          const body = 'a'.repeat(2000) + 'tail';
          const ctx = save(body, groupA);
          await sender.sendPreparedChunk(groupA, 'a'.repeat(2000), ctx);
          await advance(1000);
          const hold = deferred<SignalRpcResult>();
          nextMetadata = () => hold.promise;
          const pending =
            path === 'prepared'
              ? sender.sendPreparedChunk(groupA, 'tail', ctx)
              : sender.send(groupA, { body, trustedDelivery: ctx });
          await flush();
          queue.purge(['pending'])._unsafeUnwrap();
          const foreign = save('foreign', groupA);
          const foreignLease = leases.acquire(account, groupA, foreign, Date.now())._unsafeUnwrap();
          const foreignCheckpoint = checkpoint(foreign);
          if (kind === 'restrictions')
            vi.spyOn(accounts, 'recordPause').mockReturnValueOnce(
              err(new SignalStateError('DATABASE')),
            );
          let completed = false;
          void pending.then(() => {
            completed = true;
          });
          hold.resolve(
            kind === 'io'
              ? remote(-3)
              : kind === 'restrictions'
                ? remote(-6, [
                    resultEntry('RATE_LIMIT_FAILURE', {
                      retryAfterSeconds: 5000,
                      token: 'discard-secret',
                    }),
                  ])
                : err(new SignalRpcTransportError('TIMEOUT', true)),
          );
          await flush();
          if (kind === 'restrictions') {
            expect(completed).toBe(false);
            await advance(250);
          }
          expect((await pending)._unsafeUnwrapErr()).toMatchObject({
            reason: 'CANCELLED',
            outcome: 'PARTIAL',
            currentChunkAcceptance: 'unwritten',
            acceptedChunks: 1,
            successCount: 1,
            failureCount: 0,
            retryScope: 'none',
          });
          expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
            reservation: null,
            pauseKind: kind === 'restrictions' ? 'challenge' : 'none',
            rateLimitNotBefore: kind === 'restrictions' ? initialTime + 1000 + 5_000_000 : 0,
            recoveryNotBefore: 0,
          });
          expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
          expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(foreignLease);
          expect(checkpoint(foreign)).toEqual(foreignCheckpoint);
          expect(db.prepare('SELECT count(*) AS total FROM messages').get()).toEqual({ total: 0 });
          await advance(1000);
          expect(sends()).toHaveLength(1);
          expect(calls.filter((call) => call.request.method === 'listGroups')).toHaveLength(2);
        },
      );
    }

    for (const gate of ['reconnecting', 'rate_limit', 'challenge', 'recovery'] as const) {
      it.each(['deadline', 'callcancel', 'quiesce'] as const)(
        `resolves physical purge under ${gate} at %s permanently with retained prefix counts`,
        async (exit) => {
          const ctx = save('a'.repeat(2000) + 'tail', groupA);
          await sender.sendPreparedChunk(groupA, 'a'.repeat(2000), ctx);
          if (gate === 'reconnecting') readiness = { ...readiness, state: 'reconnecting' };
          else {
            const state = accounts.findByAccount(account)._unsafeUnwrap()!;
            accounts
              .recordPause(
                account,
                state.revision,
                gate === 'rate_limit'
                  ? { kind: gate, notBefore: Date.now() + 900_000 }
                  : { kind: gate },
                Date.now(),
              )
              ._unsafeUnwrap();
          }
          const pending = sender.sendPreparedChunk(groupA, 'tail', ctx);
          queue.purge(['pending'])._unsafeUnwrap();
          const foreign = save('foreign', groupA);
          const foreignLease = leases.acquire(account, groupA, foreign, Date.now())._unsafeUnwrap();
          const accountBefore = accounts.findByAccount(account)._unsafeUnwrap();
          if (exit === 'callcancel') expect(sender.cancelWaiter(ctx)).toBe(true);
          else if (exit === 'quiesce') sender.quiesce();
          else await advance(30_000);
          expect((await pending)._unsafeUnwrapErr()).toMatchObject({
            reason: 'CANCELLED',
            outcome: 'PARTIAL',
            currentChunkAcceptance: 'unwritten',
            acceptedChunks: 1,
            successCount: 1,
            failureCount: 0,
            retryScope: 'none',
          });
          expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(accountBefore);
          expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(foreignLease);
          expect(checkpoint(foreign).phase).toBe('ready');
          expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
          expect(db.prepare('SELECT count(*) AS total FROM messages').get()).toEqual({ total: 0 });
          expect(sends()).toHaveLength(1);
          expect(calls).toHaveLength(2);
        },
      );
    }

    it.each(['deadline', 'callcancel', 'quiesce'] as const)(
      'does not fabricate purge on an indeterminate physical read at %s',
      async (exit) => {
        const ctx = save('a'.repeat(2000) + 'tail', groupA);
        await sender.sendPreparedChunk(groupA, 'a'.repeat(2000), ctx);
        readiness = { ...readiness, state: 'reconnecting' };
        const pending = sender.sendPreparedChunk(groupA, 'tail', ctx);
        const rowBefore = queue.findById(ctx.queueItemId)._unsafeUnwrap();
        const leaseBefore = leases.find(account, groupA)._unsafeUnwrap();
        const read = vi
          .spyOn(queue, 'findById')
          .mockReturnValue(err(new SignalStateError('DATABASE')));
        if (exit === 'callcancel') expect(sender.cancelWaiter(ctx)).toBe(true);
        else if (exit === 'quiesce') sender.quiesce();
        else await advance(30_000);
        expect((await pending)._unsafeUnwrapErr()).toMatchObject({
          reason: 'STATE_WRITE_FAILED',
          outcome: 'PARTIAL',
          currentChunkAcceptance: 'unwritten',
          acceptedChunks: 1,
          successCount: 1,
          failureCount: 0,
        });
        read.mockRestore();
        expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toEqual(rowBefore);
        expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(leaseBefore);
        expect((await sender.drain())._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
        expect(sends()).toHaveLength(1);
      },
    );
  });

  it.each([0, 1])(
    'review2 R2: preserves already-settled permanent unwritten classification after %i accepted chunks',
    async (prefix) => {
      const ctx = save(prefix === 0 ? 'tail' : 'a'.repeat(2000) + 'tail', groupA);
      if (prefix === 1) {
        await sender.sendPreparedChunk(groupA, 'a'.repeat(2000), ctx);
        await advance(1000);
      }
      nextSend = () => err(new SignalRpcTransportError('INVALID_REQUEST'));
      const terminate = vi.spyOn(queue, 'terminateSignalDelivery');
      expect(
        (await sender.sendPreparedChunk(groupA, 'tail', ctx))._unsafeUnwrapErr(),
      ).toMatchObject({
        reason: 'INVALID_RESPONSE',
        outcome: prefix === 0 ? 'NOT_SENT' : 'PARTIAL',
        currentChunkAcceptance: 'unwritten',
        acceptedChunks: prefix,
        successCount: prefix,
        failureCount: 0,
        retryScope: 'none',
      });
      expect(checkpoint(ctx)).toMatchObject({
        phase: 'terminal',
        terminalReason: 'INVALID_RESPONSE',
        currentChunkAcceptance: 'unwritten',
        nextChunk: prefix,
        successCount: prefix,
      });
      expect(terminate).toHaveBeenCalledTimes(0);
      expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
      expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
      expect(sends()).toHaveLength(prefix + 1);
    },
  );

  it('review2 R2: a failed in-flight permanent-unwritten settlement cannot become a ready-only termination', async () => {
    const ctx = save('text', groupA);
    nextSend = () => err(new SignalRpcTransportError('INVALID_REQUEST'));
    const settle = vi
      .spyOn(queue, 'settleSignalChunk')
      .mockReturnValue(err(new SignalStateError('DATABASE')));
    const terminate = vi.spyOn(queue, 'terminateSignalDelivery');
    const pending = sender.sendPreparedChunk(groupA, 'text', ctx);
    await advance(8000);
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'STATE_WRITE_FAILED',
      outcome: 'NOT_SENT',
      currentChunkAcceptance: 'unwritten',
      successCount: 0,
    });
    expect(checkpoint(ctx).phase).toBe('in_flight');
    expect(settle).toHaveBeenCalledTimes(6);
    expect(terminate).toHaveBeenCalledTimes(0);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
    expect((await sender.drain())._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(sends()).toHaveLength(1);
  });

  it('review2 R2: generic rejoin resets current-chunk authority for a later local permanent refusal', async () => {
    const body = 'a'.repeat(2000) + 'tail';
    const ctx = save(body, groupA);
    const terminate = vi.spyOn(queue, 'terminateSignalDelivery');
    const pending = sender.send(groupA, { body, trustedDelivery: ctx });
    await flush();
    expect(checkpoint(ctx)).toMatchObject({ phase: 'ready', nextChunk: 1 });
    readiness = { ...readiness, config: { ...config, allowedGroups: [] } };
    sender.readinessChanged();
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'TARGET_REFUSED',
      acceptedChunks: 1,
      successCount: 1,
      retryScope: 'none',
    });
    expect(checkpoint(ctx)).toMatchObject({
      phase: 'terminal',
      terminalReason: 'TARGET_REFUSED',
      nextChunk: 1,
    });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it('review2 final resolution: purge after a settled prefix and quiesce permanently cancels only its unwritten generic tail', async () => {
    const body = 'a'.repeat(2000) + 'tail';
    const ctx = save(body, groupA);
    const original = queue.settleSignalChunk.bind(queue);
    vi.spyOn(queue, 'settleSignalChunk').mockImplementation((...args) => {
      const result = original(...args);
      if (result.isOk()) {
        queue.purge(['pending'])._unsafeUnwrap();
        sender.quiesce();
      }
      return result;
    });
    expect(
      (await sender.send(groupA, { body, trustedDelivery: ctx }))._unsafeUnwrapErr(),
    ).toMatchObject({
      reason: 'CANCELLED',
      outcome: 'PARTIAL',
      currentChunkAcceptance: 'unwritten',
      acceptedChunks: 1,
      successCount: 1,
      retryScope: 'none',
    });
    expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
    expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it('review2 final resolution: physical purge cannot masquerade as classified cancellation while in-flight settlement writes failed', async () => {
    const ctx = save('text', groupA);
    const hold = deferred<SignalRpcResult>();
    nextSend = () => hold.promise;
    const pending = sender.sendPreparedChunk(groupA, 'text', ctx);
    await flush();
    queue.purge(['pending'])._unsafeUnwrap();
    const settle = vi
      .spyOn(queue, 'settleSignalChunk')
      .mockReturnValue(err(new SignalStateError('DATABASE')));
    hold.resolve(remote(-5, [resultEntry('RATE_LIMIT_FAILURE')]));
    await advance(8000);
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'STATE_WRITE_FAILED',
      currentChunkAcceptance: 'refused',
      failureCount: 1,
    });
    expect(settle).toHaveBeenCalledTimes(6);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
    expect((await sender.drain())._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it.each(['terminal', 'cancelled'] as const)(
    'review2 R2: preserves authoritative settled %s without a redundant final presence read',
    async (outcome) => {
      const ctx = save('text', groupA);
      const hold = deferred<SignalRpcResult>();
      nextSend = () => hold.promise;
      const pending = sender.sendPreparedChunk(groupA, 'text', ctx);
      await flush();
      if (outcome === 'cancelled') queue.purge(['pending'])._unsafeUnwrap();
      const read = vi
        .spyOn(queue, 'findById')
        .mockReturnValue(err(new SignalStateError('DATABASE')));
      hold.resolve(
        err(
          new SignalRpcTransportError(outcome === 'cancelled' ? 'DISCONNECTED' : 'INVALID_REQUEST'),
        ),
      );
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        reason: outcome === 'cancelled' ? 'CANCELLED' : 'INVALID_RESPONSE',
        outcome: 'NOT_SENT',
        currentChunkAcceptance: 'unwritten',
        retryScope: 'none',
      });
      expect(read).toHaveBeenCalledTimes(0);
      read.mockRestore();
      if (outcome === 'cancelled')
        expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
      else
        expect(checkpoint(ctx)).toMatchObject({
          phase: 'terminal',
          terminalReason: 'INVALID_RESPONSE',
        });
      expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
      expect((await sender.drain()).isOk()).toBe(true);
      expect(sends()).toHaveLength(1);
    },
  );

  it.each(['purged', 'indeterminate'] as const)(
    'review2 final resolution: a settled saved deferral still resolves current physical authority when %s',
    async (authority) => {
      const ctx = save('text', groupA);
      nextSend = () => remote(-5, [resultEntry('RATE_LIMIT_FAILURE')]);
      const original = queue.settleSignalChunk.bind(queue);
      vi.spyOn(queue, 'settleSignalChunk').mockImplementation((...args) => {
        const result = original(...args);
        if (result.isOk() && authority === 'purged') queue.purge(['pending'])._unsafeUnwrap();
        return result;
      });
      const read =
        authority === 'indeterminate'
          ? vi.spyOn(queue, 'findById').mockReturnValue(err(new SignalStateError('DATABASE')))
          : undefined;
      expect(
        (await sender.sendPreparedChunk(groupA, 'text', ctx))._unsafeUnwrapErr(),
      ).toMatchObject({
        reason: authority === 'purged' ? 'CANCELLED' : 'STATE_WRITE_FAILED',
        outcome: 'NOT_SENT',
        currentChunkAcceptance: 'refused',
        acceptedChunks: 0,
        successCount: 0,
        failureCount: 1,
        retryScope: authority === 'purged' ? 'none' : 'delivery_only',
      });
      read?.mockRestore();
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
        reservation: null,
        rateLimitNotBefore: initialTime + 900_000,
        recoveryNotBefore: 0,
      });
      if (authority === 'purged') {
        expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
        expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
        expect((await sender.drain()).isOk()).toBe(true);
      } else {
        expect(checkpoint(ctx)).toMatchObject({ phase: 'ready', failureCount: 1 });
        expect(leases.find(account, groupA)._unsafeUnwrap()?.deliveryId).toBe(ctx.deliveryId);
        expect((await sender.drain())._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
      }
      expect(sends()).toHaveLength(1);
    },
  );

  for (const purpose of ['explicit', 'progress'] as const) {
    it.each(['io', 'restrictions', 'transport'] as const)(
      `review2 invocation matrix: purged ${purpose} generic tail after %s lookup preserves prior acceptance and foreign lease`,
      async (kind) => {
        const ctx = context(purpose);
        const body = 'a'.repeat(2000) + 'tail';
        const hold = deferred<SignalRpcResult>();
        let lookups = 0;
        nextMetadata = (request) => (++lookups === 1 ? metadata(request) : hold.promise);
        const pending = sender.send(groupA, { body, trustedDelivery: ctx });
        await advance(1000);
        expect(sends()).toHaveLength(1);
        queue.purge(['pending'])._unsafeUnwrap();
        const foreign = save('foreign', groupA);
        const foreignLease = leases.acquire(account, groupA, foreign, Date.now())._unsafeUnwrap();
        hold.resolve(
          kind === 'io'
            ? remote(-3)
            : kind === 'restrictions'
              ? remote(-6, [resultEntry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 5000 })])
              : err(new SignalRpcTransportError('TIMEOUT', true)),
        );
        expect((await pending)._unsafeUnwrapErr()).toMatchObject({
          reason: 'CANCELLED',
          outcome: 'PARTIAL',
          currentChunkAcceptance: 'unwritten',
          acceptedChunks: 1,
          successCount: 1,
          failureCount: 0,
          retryScope: 'none',
        });
        expect(leases.find(account, groupA)._unsafeUnwrap()).toEqual(foreignLease);
        expect(checkpoint(foreign).phase).toBe('ready');
        expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
          reservation: null,
          pauseKind: kind === 'restrictions' ? 'challenge' : 'none',
          rateLimitNotBefore: kind === 'restrictions' ? initialTime + 1000 + 5_000_000 : 0,
          recoveryNotBefore: 0,
        });
        expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
        expect((await sender.drain()).isOk()).toBe(true);
        expect(sends()).toHaveLength(1);
        expect(lookups).toBe(2);
      },
    );

    it.each(['deadline', 'callcancel', 'quiesce'] as const)(
      `review2 invocation matrix: purged gated ${purpose} call resolves %s permanently without network work`,
      async (exit) => {
        const ctx = context(purpose);
        readiness = { ...readiness, state: 'reconnecting' };
        const pending = sender.sendPreparedChunk(groupA, 'text', ctx);
        queue.purge(['pending'])._unsafeUnwrap();
        if (exit === 'callcancel') expect(sender.cancelWaiter(ctx)).toBe(true);
        else if (exit === 'quiesce') sender.quiesce();
        else await advance(30_000);
        expect((await pending)._unsafeUnwrapErr()).toMatchObject({
          reason: 'CANCELLED',
          outcome: 'NOT_SENT',
          currentChunkAcceptance: 'unwritten',
          acceptedChunks: 0,
          successCount: 0,
          failureCount: 0,
          retryScope: 'none',
        });
        expect(queue.findById(ctx.queueItemId)._unsafeUnwrap()).toBeNull();
        expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
        expect(calls).toEqual([]);
      },
    );
  }
});
