import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { createTestDb } from '../core/database/repositories/helpers.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import {
  DbError,
  DeliveryCancelled,
  DeliveryDeferredError,
  NonRetryableRunError,
  SignalDeliveryError,
} from '../../../src/core/errors/error-types.js';
import {
  SignalAccountStateRepository,
  SignalStateError,
} from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import {
  SIGNAL_DELIVERY_STARTED_KEY,
  SIGNAL_DELIVERY_CHECKPOINT_KEY,
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  SignalCheckpointError,
  type SignalDeliveryCheckpoint,
} from '../../../src/queue/signal-delivery-checkpoint.js';
import { SignalIdentityError } from '../../../src/channels/connectors/signal/signal-identities.js';
import { SignalSendCoordinator } from '../../../src/channels/connectors/signal/signal-send-coordinator.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';
import { parseSignalSendEvidence } from '../../../src/channels/connectors/signal/signal-wire.js';
import type { SignalRpcResult } from '../../../src/channels/connectors/signal/signal-rpc-client.js';
import {
  SignalInvocationGuard,
  type SignalInvocation,
} from '../../../src/daemon/signal-invocation-guard.js';

const account = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const target = `signal:v1:${account}:self`;
const at = 1_000_000;
const invocation: SignalInvocation = {
  deliveryId: 'explicit-1',
  purpose: 'explicit',
  accountUuid: account,
  destination: target,
};

function unknown(): SignalDeliveryError {
  return new SignalDeliveryError({
    reason: 'UNKNOWN_ACCEPTANCE',
    outcome: 'UNKNOWN',
    acceptedChunks: 0,
    currentChunkAcceptance: 'unknown',
    successCount: 0,
    failureCount: 0,
    retryScope: 'none',
  });
}

describe('SignalInvocationGuard actual queue boundary', () => {
  let db: Database.Database;
  let queue: QueueRepository;

  function enter(): SignalInvocationGuard {
    const entry = SignalInvocationGuard.enter(queue, 'queue', () => at)._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected execution fixture');
    return entry.guard;
  }

  beforeEach(() => {
    db = createTestDb();
    queue = new QueueRepository(db);
    new ChannelRepository(db)
      .insert({
        id: 'channel',
        name: 'origin',
        type: 'telegram',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    new ThreadRepository(db)
      .insert({ id: 'thread', channel_id: 'channel', external_id: 'origin-chat', metadata: '{}' })
      ._unsafeUnwrap();
    queue
      .enqueue({
        id: 'queue',
        thread_id: 'thread',
        message_id: null,
        type: 'message',
        payload: '{"untouched":true}',
        max_attempts: 3,
      })
      ._unsafeUnwrap();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (db.open) db.close();
  });

  function save(
    deliveryId = 'saved',
    kind: 'reply' | 'background' = 'reply',
    destination = target,
    chunks: readonly string[] = ['explanation'],
  ): SignalDeliveryCheckpoint {
    return queue
      .saveSignalCheckpoint(
        {
          version: 1,
          queueItemId: 'queue',
          deliveryId,
          kind,
          personaId: 'persona',
          threadId: 'thread',
          channelName: 'signal-test',
          accountUuid: account,
          destination,
          body: chunks.join(''),
          chunks,
          nextChunk: 0,
          phase: 'ready',
          currentChunkAcceptance: 'unwritten',
          acceptedChunks: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: at,
          expiresAt: at + SIGNAL_CHECKPOINT_LIFETIME_MS,
        },
        at,
      )
      ._unsafeUnwrap();
  }

  function partial(): SignalDeliveryError {
    return new SignalDeliveryError({
      reason: 'PARTIAL_ACCEPTANCE',
      outcome: 'PARTIAL',
      acceptedChunks: 0,
      currentChunkAcceptance: 'partial',
      successCount: 1,
      failureCount: 1,
      retryScope: 'none',
    });
  }

  function notSent(): SignalDeliveryError {
    return new SignalDeliveryError({
      reason: 'ACCOUNT_BUSY',
      outcome: 'NOT_SENT',
      acceptedChunks: 0,
      currentChunkAcceptance: 'unwritten',
      successCount: 0,
      failureCount: 0,
      retryScope: 'delivery_only',
    });
  }

  it('refuses a new execution seeing an actual durable producer invocation', () => {
    queue
      .markSignalDeliveryStarted(
        { version: 1, queueItemId: 'queue', deliveryId: 'old', purpose: 'explicit', startedAt: at },
        null,
        at,
      )
      ._unsafeUnwrap();
    const result = SignalInvocationGuard.enter(queue, 'queue', () => at);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(NonRetryableRunError);
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('dead_letter');
  });

  it('commits the actual marker before the invocation callback', async () => {
    const guard = enter();
    const observations: unknown[] = [];
    const result = await guard.invoke(invocation, async (context) => {
      observations.push(context, queue.inspectSignalDelivery('queue', at)._unsafeUnwrap());
      return ok(undefined);
    });
    expect(result.isOk()).toBe(true);
    expect(observations).toEqual([
      { queueItemId: 'queue', deliveryId: 'explicit-1', purpose: 'explicit' },
      {
        kind: 'invoked',
        marker: {
          version: 1,
          queueItemId: 'queue',
          deliveryId: 'explicit-1',
          purpose: 'explicit',
          startedAt: at,
        },
      },
    ]);
    expect(JSON.parse(queue.findById('queue')._unsafeUnwrap()!.payload).untouched).toBe(true);
  });

  it('keeps handled UNKNOWN typed and latches its exact target across new purpose and ID', async () => {
    const guard = enter();
    const failure = unknown();
    const first = await guard.invoke(invocation, async () => err(failure));
    const send = vi.fn(async () => ok(undefined));
    const next = await guard.invoke(
      { ...invocation, deliveryId: 'final-new-id', purpose: 'reply' },
      send,
    );
    expect(first._unsafeUnwrapErr()).toBe(failure);
    expect(next.isErr()).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('pending');
  });

  it('admits an ordinary non-Signal origin with trusted queue identity and no run yet', () => {
    const guard = enter();
    expect(guard.context('background-task-status', 'background')._unsafeUnwrap()).toEqual({
      queueItemId: 'queue',
      deliveryId: 'background-task-status',
      purpose: 'background',
    });
    expect(new RunRepository(db).findByThread('thread')._unsafeUnwrap()).toEqual([]);
    const original = new Error('ordinary provider failure');
    expect(guard.classifyFailure(original)._unsafeUnwrap()).toEqual({
      kind: 'failure',
      error: original,
    });
  });

  it.each(['[]', '{broken', '{"nested":{"__talond_signal_delivery_v1":null}}'])(
    'preserves legacy non-Signal read behavior for %s without writing a repaired payload',
    (payload) => {
      queue
        .enqueue({
          id: 'legacy',
          thread_id: 'thread',
          message_id: null,
          type: 'message',
          payload,
          max_attempts: 3,
        })
        ._unsafeUnwrap();
      expect(SignalInvocationGuard.enter(queue, 'legacy', () => at)._unsafeUnwrap().kind).toBe(
        'execution',
      );
      expect(queue.findById('legacy')._unsafeUnwrap()?.payload).toBe(payload);
    },
  );

  it.each([
    JSON.stringify({ [SIGNAL_DELIVERY_STARTED_KEY]: null }),
    JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: { body: 'private body' } }),
    '{"__talond_signal_delivery_v1":',
  ])('rejects malformed reserved durable state without raw diagnostics: %s', (payload) => {
    queue
      .enqueue({
        id: 'invalid',
        thread_id: 'thread',
        message_id: null,
        type: 'message',
        payload,
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    const failure = SignalInvocationGuard.enter(queue, 'invalid', () => at)._unsafeUnwrapErr();
    expect(failure).toBeInstanceOf(SignalCheckpointError);
    expect(failure.message).not.toContain('private body');
    expect(failure.cause).toBeUndefined();
    expect(queue.findById('invalid')._unsafeUnwrap()).toMatchObject({
      status: 'dead_letter',
      error: 'CHECKPOINT_INVALID',
      payload,
    });
  });

  it.each(['ready', 'in_flight', 'delivered', 'terminal'] as const)(
    'routes actual %s checkpoints before old markers; never grants provider execution',
    (phase) => {
      queue
        .markSignalDeliveryStarted(
          {
            version: 1,
            queueItemId: 'queue',
            deliveryId: 'old-tool',
            purpose: 'explicit',
            startedAt: at,
          },
          null,
          at,
        )
        ._unsafeUnwrap();
      let checkpoint = save();
      if (phase === 'in_flight' || phase === 'delivered') {
        const accounts = new SignalAccountStateRepository(db);
        const state = accounts.getOrCreate(account, at)._unsafeUnwrap();
        const owned = queue.beginSignalChunk(checkpoint, state.revision, at)._unsafeUnwrap();
        checkpoint =
          phase === 'in_flight'
            ? owned.checkpoint
            : queue
                .settleSignalChunk(owned, { kind: 'accepted', successCount: 1 }, at)
                ._unsafeUnwrap();
        if (phase === 'delivered')
          queue.finalizeSignalDelivery(checkpoint, () => ok(undefined), at)._unsafeUnwrap();
      } else if (phase === 'terminal') {
        checkpoint = queue
          .terminateSignalDelivery(
            checkpoint,
            new SignalDeliveryError({ ...notSent(), reason: 'TARGET_REFUSED', retryScope: 'none' }),
            at,
          )
          ._unsafeUnwrap();
      }
      expect(SignalInvocationGuard.enter(queue, 'queue', () => at)._unsafeUnwrap()).toEqual({
        kind: 'checkpoint',
        checkpoint,
      });
    },
  );

  it('returns expired saved work to delivery classification only, not to a provider', () => {
    const checkpoint = save();
    expect(
      SignalInvocationGuard.enter(queue, 'queue', () => checkpoint.expiresAt + 1)._unsafeUnwrap(),
    ).toEqual({ kind: 'checkpoint', checkpoint });
  });

  it('never grants a new execution for a completed ordinary row', () => {
    queue.complete('queue')._unsafeUnwrap();
    expect(SignalInvocationGuard.enter(queue, 'queue', () => at)._unsafeUnwrapErr()).toBeInstanceOf(
      SignalStateError,
    );
  });

  it('attaches only a real foreground run later and persists that exact run identity', async () => {
    const guard = enter();
    new PersonaRepository(db)
      .insert({
        id: 'persona',
        name: 'fixture',
        model: 'fake',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
    new RunRepository(db)
      .insert({
        id: 'real-run',
        thread_id: 'thread',
        persona_id: 'persona',
        provider_name: 'fake',
        sandbox_id: null,
        session_id: null,
        status: 'running',
        parent_run_id: null,
        queue_item_id: 'queue',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        error: null,
        started_at: at,
        ended_at: null,
      })
      ._unsafeUnwrap();
    guard.attachRunId('real-run')._unsafeUnwrap();
    const seen: unknown[] = [];
    const result = await guard.invoke(invocation, async (ctx) => {
      seen.push(ctx);
      return ok(undefined);
    });
    expect(result.isOk()).toBe(true);
    expect(seen).toEqual([
      { queueItemId: 'queue', deliveryId: 'explicit-1', purpose: 'explicit', runId: 'real-run' },
    ]);
    expect(queue.inspectSignalDelivery('queue', at)._unsafeUnwrap()).toMatchObject({
      kind: 'invoked',
      marker: { runId: 'real-run' },
    });
    expect(guard.attachRunId('other-run')._unsafeUnwrapErr()).toBeInstanceOf(SignalStateError);
    expect(guard.context('background', 'background')._unsafeUnwrapErr()).toBeInstanceOf(
      SignalStateError,
    );
  });

  it('refuses invented run ownership before any callback using the actual repository validator', async () => {
    const guard = enter();
    guard.attachRunId('not-a-real-run')._unsafeUnwrap();
    const callback = vi.fn(async () => ok(undefined));
    const result = await guard.invoke(invocation, callback);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(SignalCheckpointError);
    expect(callback).not.toHaveBeenCalled();
    expect(queue.inspectSignalDelivery('queue', at)._unsafeUnwrap()).toEqual({ kind: 'ordinary' });
  });

  it('permanently cancels entry, dispatch and catch after actual operator purge; never recreates text', async () => {
    const guard = enter();
    queue.purge(['pending'])._unsafeUnwrap();
    const callback = vi.fn(async () => ok(undefined));
    expect(SignalInvocationGuard.enter(queue, 'queue', () => at)._unsafeUnwrapErr()).toBeInstanceOf(
      DeliveryCancelled,
    );
    expect((await guard.invoke(invocation, callback))._unsafeUnwrapErr()).toBeInstanceOf(
      DeliveryCancelled,
    );
    expect(guard.classifyFailure(new Error('late'))._unsafeUnwrapErr()).toBeInstanceOf(
      DeliveryCancelled,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(queue.findById('queue')._unsafeUnwrap()).toBeNull();
    expect(new MessageRepository(db).findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
  });

  it('fails closed on actual closed-SQLite inspection, not ordinary fallback', () => {
    db.close();
    const failure = SignalInvocationGuard.enter(queue, 'queue', () => at)._unsafeUnwrapErr();
    expect(failure).toBeInstanceOf(SignalStateError);
    expect(failure.message).toBe('Signal state operation failed: DATABASE');
    expect(failure.cause).toBeUndefined();
  });

  it('preserves exact producer inspection and marker write Err identities, with zero callback/provider retry permission', async () => {
    const guard = enter();
    const failure = new SignalStateError('DATABASE');
    const marker = vi.spyOn(queue, 'markSignalDeliveryStarted').mockReturnValue(err(failure));
    const callback = vi.fn(async () => ok(undefined));
    expect((await guard.invoke(invocation, callback))._unsafeUnwrapErr()).toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(queue.inspectSignalDelivery('queue', at)._unsafeUnwrap()).toEqual({ kind: 'ordinary' });
    expect(guard.classifyFailure(new Error('fresh-session candidate'))._unsafeUnwrapErr()).toBe(
      failure,
    );
    marker.mockRestore();
    const inspection = vi.spyOn(queue, 'inspectSignalDelivery').mockReturnValue(err(failure));
    expect(SignalInvocationGuard.enter(queue, 'queue', () => at)._unsafeUnwrapErr()).toBe(failure);
    expect(guard.classifyFailure(new Error('catch'))._unsafeUnwrapErr()).toBe(failure);
    inspection.mockRestore();
  });

  it('refuses actual SQLite write failure before callback and retains only state-retry authority', async () => {
    const guard = enter();
    db.pragma('query_only = ON');
    const callback = vi.fn(async () => ok(undefined));
    const failure = (await guard.invoke(invocation, callback))._unsafeUnwrapErr();
    expect(failure).toBeInstanceOf(SignalStateError);
    expect(failure).toMatchObject({ reason: 'DATABASE', cause: undefined });
    expect(callback).not.toHaveBeenCalled();
    expect(queue.inspectSignalDelivery('queue', at)._unsafeUnwrap()).toEqual({ kind: 'ordinary' });
    db.pragma('query_only = OFF');
    expect(guard.classifyFailure(new Error('must not restart provider'))._unsafeUnwrapErr()).toBe(
      failure,
    );
    expect(
      (
        await guard.invoke({ ...invocation, deliveryId: 'deliberate-after-recovery' }, callback)
      ).isOk(),
    ).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('preserves actual repository DbError Result identity instead of generic wrapping', async () => {
    const guard = enter();
    const failure = new DbError('safe test database failure');
    vi.spyOn(queue, 'findById').mockReturnValue(err(failure));
    expect(SignalInvocationGuard.enter(queue, 'queue', () => at)._unsafeUnwrapErr()).toBe(failure);
    const callback = vi.fn(async () => ok(undefined));
    expect((await guard.invoke(invocation, callback))._unsafeUnwrapErr()).toBe(failure);
    expect(callback).not.toHaveBeenCalled();
  });

  it('refuses another live guard adopting a marker committed after its ordinary entry', async () => {
    const first = enter();
    const concurrent = enter();
    await first.invoke(invocation, async () => ok(undefined));
    const before = queue.findById('queue')._unsafeUnwrap()?.payload;
    const callback = vi.fn(async () => ok(undefined));
    expect(
      (
        await concurrent.invoke({ ...invocation, deliveryId: 'other-execution' }, callback)
      )._unsafeUnwrapErr(),
    ).toBeInstanceOf(SignalStateError);
    expect(callback).not.toHaveBeenCalled();
    expect(queue.findById('queue')._unsafeUnwrap()?.payload).toBe(before);
  });

  it('honors exact prior-marker CAS conflict without callbacks or overwriting the committed marker', async () => {
    const guard = enter();
    await guard.invoke(invocation, async () => ok(undefined));
    const before = queue.inspectSignalDelivery('queue', at)._unsafeUnwrap();
    const failure = new SignalStateError('CONFLICT');
    const mark = vi.spyOn(queue, 'markSignalDeliveryStarted').mockReturnValue(err(failure));
    const callback = vi.fn(async () => ok(undefined));
    expect(
      (await guard.invoke({ ...invocation, deliveryId: 'new-id' }, callback))._unsafeUnwrapErr(),
    ).toBe(failure);
    expect(mark.mock.calls[0]?.[1]).toEqual(before.kind === 'invoked' ? before.marker : null);
    expect(callback).not.toHaveBeenCalled();
    expect(queue.inspectSignalDelivery('queue', at)._unsafeUnwrap()).toEqual(before);
  });

  it('lets a handled tool error save a healthy-origin explanation, but a reconstructed execution cannot adopt the tool marker', async () => {
    const guard = enter();
    const failure = unknown();
    expect((await guard.invoke(invocation, async () => err(failure)))._unsafeUnwrapErr()).toBe(
      failure,
    );
    // A different Signal origin remains usable; a Telegram origin never enters the Signal target gate.
    const healthy = `signal:v1:${account}:group:QQ`;
    expect(guard.checkTarget(account, healthy).isOk()).toBe(true);
    const checkpoint = save('explanation', 'reply', healthy);
    const explanation = vi.fn(async () => ok(undefined));
    expect(
      (
        await guard.invoke(
          {
            ...invocation,
            deliveryId: checkpoint.deliveryId,
            purpose: 'reply',
            destination: healthy,
          },
          explanation,
        )
      ).isOk(),
    ).toBe(true);
    expect(explanation).toHaveBeenCalledOnce();
    expect(guard.classifyFailure(new Error('stale tool catch'))._unsafeUnwrap()).toEqual({
      kind: 'checkpoint',
      checkpoint,
    });
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('pending');
    expect(SignalInvocationGuard.enter(queue, 'queue', () => at)._unsafeUnwrap()).toEqual({
      kind: 'checkpoint',
      checkpoint,
    });
  });

  it('blocks provider/fresh-session replay after a Signal call without a checkpoint', async () => {
    const guard = enter();
    await guard.invoke(invocation, async () => err(notSent()));
    const failure = guard.classifyFailure(new Error('session expired'))._unsafeUnwrap();
    expect(failure.kind).toBe('failure');
    if (failure.kind === 'failure') expect(failure.error).toBeInstanceOf(NonRetryableRunError);
    expect(queue.findById('queue')._unsafeUnwrap()).toMatchObject({
      status: 'dead_letter',
      attempts: 0,
      error: 'UNKNOWN_ACCEPTANCE',
    });
    expect(SignalInvocationGuard.enter(queue, 'queue', () => at).isErr()).toBe(true);
  });

  it.each([
    'deferred',
    'nonretryable',
    'cancelled',
    'delivery',
    'state',
    'checkpoint',
    'db',
  ] as const)(
    'retains %s identity at unhandled catch, never masks typed boundaries',
    async (kind) => {
      const guard = enter();
      await guard.invoke(invocation, async () => ok(undefined));
      const failures = {
        deferred: new DeliveryDeferredError(notSent(), at + SIGNAL_CHECKPOINT_LIFETIME_MS),
        nonretryable: new NonRetryableRunError(unknown()),
        cancelled: new DeliveryCancelled(),
        delivery: unknown(),
        state: new SignalStateError('DATABASE'),
        checkpoint: new SignalCheckpointError('INVALID'),
        db: new DbError('safe fixture'),
      };
      const result = guard.classifyFailure(failures[kind])._unsafeUnwrap();
      expect(result).toEqual({ kind: 'failure', error: failures[kind] });
      if (result.kind === 'failure') expect(result.error).toBe(failures[kind]);
    },
  );

  it('re-inspects current delivered checkpoint at catch and leaves completed finalization intact', async () => {
    const guard = enter();
    await guard.invoke(invocation, async () => ok(undefined));
    const checkpoint = save();
    const accounts = new SignalAccountStateRepository(db);
    const state = accounts.getOrCreate(account, at)._unsafeUnwrap();
    const owned = queue.beginSignalChunk(checkpoint, state.revision, at)._unsafeUnwrap();
    const delivered = queue
      .settleSignalChunk(owned, { kind: 'accepted', successCount: 1 }, at)
      ._unsafeUnwrap();
    queue.finalizeSignalDelivery(delivered, () => ok(undefined), at)._unsafeUnwrap();
    const reject = vi.spyOn(queue, 'rejectSignalReplay');
    expect(guard.classifyFailure(new NonRetryableRunError(unknown()))._unsafeUnwrap()).toEqual({
      kind: 'checkpoint',
      checkpoint: delivered,
    });
    expect(reject).not.toHaveBeenCalled();
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('completed');
  });

  it.each([
    { purpose: 'explicit', destination: target, outcome: 'PARTIAL' },
    { purpose: 'progress', destination: target, outcome: 'UNKNOWN' },
    { purpose: 'explicit', destination: `signal:v1:${account}:group:Qg`, outcome: 'UNKNOWN' },
    {
      purpose: 'progress',
      destination: `signal:v1:${account}:dm:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`,
      outcome: 'PARTIAL',
    },
  ] as const)(
    'latches $purpose $outcome at $destination across every purpose and new operation/request IDs, but only exact canonical target/account',
    async ({ purpose, destination, outcome }) => {
      const guard = enter();
      const failure = outcome === 'PARTIAL' ? partial() : unknown();
      expect(
        (
          await guard.invoke({ ...invocation, purpose, destination }, async () => err(failure))
        )._unsafeUnwrapErr(),
      ).toBe(failure);
      const callback = vi.fn(async () => ok(undefined));
      for (const nextPurpose of ['explicit', 'progress', 'reply', 'background'] as const) {
        const result = await guard.invoke(
          {
            ...invocation,
            destination,
            purpose: nextPurpose,
            accountUuid: account.toUpperCase(),
            deliveryId: `new-${nextPurpose}`,
          },
          callback,
        );
        expect(result._unsafeUnwrapErr()).toMatchObject({
          reason: 'TARGET_LATCHED',
          retryScope: 'none',
          providerRetryable: false,
        });
      }
      expect(callback).not.toHaveBeenCalled();
      const secondAccount = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      expect(guard.checkTarget(account, `signal:v1:${account}:group:QQ`).isOk()).toBe(true);
      expect(guard.checkTarget(secondAccount, `signal:v1:${secondAccount}:self`).isOk()).toBe(true);
      const different = await guard.invoke(
        { ...invocation, deliveryId: 'other-target', destination: `signal:v1:${account}:group:QQ` },
        callback,
      );
      const other = await guard.invoke(
        {
          ...invocation,
          deliveryId: 'other-account',
          accountUuid: secondAccount,
          destination: `signal:v1:${secondAccount}:self`,
        },
        callback,
      );
      expect(different.isOk()).toBe(true);
      expect(other.isOk()).toBe(true);
      expect(callback).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects noncanonical aliases and mismatched account before the callback with sanitized typed identity', async () => {
    const guard = enter();
    const callback = vi.fn(async () => ok(undefined));
    for (const destination of [
      target.toUpperCase(),
      target + ' ',
      `signal:v1:${account}:group:QR`,
      'private-dynamic-token',
    ]) {
      const failure = (
        await guard.invoke({ ...invocation, destination }, callback)
      )._unsafeUnwrapErr();
      expect(failure).toBeInstanceOf(SignalIdentityError);
      expect(failure.message).not.toContain(destination);
      expect(failure.cause).toBeUndefined();
    }
    expect(
      (
        await guard.invoke(
          { ...invocation, accountUuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
          callback,
        )
      )._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'ACCOUNT_MISMATCH' });
    expect(callback).not.toHaveBeenCalled();
  });

  it('returns NOT_SENT as a real tool error, then permits a later deliberate explicit invocation', async () => {
    const guard = enter();
    const failure = notSent();
    expect((await guard.invoke(invocation, async () => err(failure)))._unsafeUnwrapErr()).toBe(
      failure,
    );
    const callback = vi.fn(async () => ok(undefined));
    expect(
      (await guard.invoke({ ...invocation, deliveryId: 'later-deliberate' }, callback)).isOk(),
    ).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('requires the saved checkpoint before final/background callbacks, then defers only a saved safe cursor without target latching', async () => {
    const guard = enter();
    const callback = vi.fn(async () => ok(undefined));
    expect(
      (await guard.invoke({ ...invocation, purpose: 'background' }, callback))._unsafeUnwrapErr(),
    ).toBeInstanceOf(SignalStateError);
    expect(callback).not.toHaveBeenCalled();
    const ready = save('background-id', 'background');
    const result = await guard.invoke(
      { ...invocation, deliveryId: ready.deliveryId, purpose: 'background' },
      async () => err(notSent()),
    );
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(SignalDeliveryError);
    expect(guard.checkTarget(account, target).isOk()).toBe(true);
    expect(queue.inspectSignalDelivery('queue', at)._unsafeUnwrap()).toEqual({
      kind: 'checkpoint',
      checkpoint: ready,
    });
    expect(new RunRepository(db).findByThread('thread')._unsafeUnwrap()).toEqual([]);
  });

  it('keeps saved reply-level PARTIAL with earlier accepted chunks delivery-only and unlatched', async () => {
    const guard = enter();
    const initial = save('saved', 'reply', target, ['accepted first', 'unsent tail']);
    const accounts = new SignalAccountStateRepository(db);
    const state = accounts.getOrCreate(account, at)._unsafeUnwrap();
    const ownership = queue.beginSignalChunk(initial, state.revision, at)._unsafeUnwrap();
    const ready = queue
      .settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, at)
      ._unsafeUnwrap();
    expect(ready).toMatchObject({
      phase: 'ready',
      nextChunk: 1,
      acceptedChunks: 1,
      currentChunkAcceptance: 'unwritten',
    });
    // Earlier accepted chunks do not turn the proven-unsent saved current cursor into a tool latch.
    const failure = new SignalDeliveryError({
      reason: 'RATE_LIMITED',
      outcome: 'PARTIAL',
      acceptedChunks: 1,
      currentChunkAcceptance: 'unwritten',
      successCount: 1,
      failureCount: 0,
      retryScope: 'delivery_only',
    });
    const result = await guard.invoke(
      { ...invocation, deliveryId: ready.deliveryId, purpose: 'reply' },
      async () => err(failure),
    );
    expect(result._unsafeUnwrapErr()).toBe(failure);
    expect(guard.checkTarget(account, target).isOk()).toBe(true);
    expect(
      guard.classifyFailure(new DeliveryDeferredError(failure, ready.expiresAt))._unsafeUnwrap(),
    ).toEqual({ kind: 'checkpoint', checkpoint: ready });
  });

  it('closes authority at trusted execution finally without timers or a global latch', async () => {
    const guard = enter();
    guard.close();
    const callback = vi.fn(async () => ok(undefined));
    expect((await guard.invoke(invocation, callback))._unsafeUnwrapErr()).toBeInstanceOf(
      SignalStateError,
    );
    expect(guard.context('after-finally', 'explicit').isErr()).toBe(true);
    expect(guard.attachRunId('late').isErr()).toBe(true);
    expect(guard.classifyFailure(new Error('late')).isErr()).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(enter().checkTarget(account, target).isOk()).toBe(true);
  });

  it.each(['PARTIAL', 'UNKNOWN', 'NOT_SENT', 'Ok'] as const)(
    'refuses unresolved same-target overlap before marker/callback and releases only after %s classification',
    async (outcome) => {
      const guard = enter();
      let settle: ((result: Result<void, SignalDeliveryError>) => void) | undefined;
      const pending = new Promise<Result<void, SignalDeliveryError>>((resolve) => {
        settle = resolve;
      });
      const first = guard.invoke(invocation, () => pending);
      const marker = queue.findById('queue')._unsafeUnwrap()?.payload;
      const mark = vi.spyOn(queue, 'markSignalDeliveryStarted');
      const callback = vi.fn(async () => ok(undefined));
      const overlap = await guard.invoke(
        { ...invocation, deliveryId: 'new-request', purpose: 'progress' },
        callback,
      );
      expect(overlap.isErr()).toBe(true);
      expect(overlap._unsafeUnwrapErr()).toMatchObject({
        reason: 'ACCOUNT_BUSY',
        outcome: 'NOT_SENT',
        currentChunkAcceptance: 'unwritten',
        acceptedChunks: 0,
        successCount: 0,
        failureCount: 0,
        retryScope: 'delivery_only',
        providerRetryable: false,
      });
      expect(guard.checkTarget(account.toUpperCase(), target)._unsafeUnwrapErr()).toMatchObject({
        reason: 'ACCOUNT_BUSY',
      });
      expect(callback).not.toHaveBeenCalled();
      expect(mark).not.toHaveBeenCalled();
      expect(queue.findById('queue')._unsafeUnwrap()?.payload).toBe(marker);
      if (settle === undefined) throw new Error('Missing test resolver');
      settle(
        outcome === 'Ok'
          ? ok(undefined)
          : err(outcome === 'PARTIAL' ? partial() : outcome === 'UNKNOWN' ? unknown() : notSent()),
      );
      await first;
      const later = await guard.invoke({ ...invocation, deliveryId: 'deliberate-later' }, callback);
      if (outcome === 'PARTIAL' || outcome === 'UNKNOWN') {
        expect(later._unsafeUnwrapErr()).toMatchObject({ reason: 'TARGET_LATCHED' });
        expect(callback).not.toHaveBeenCalled();
      } else {
        expect(later.isOk()).toBe(true);
        expect(callback).toHaveBeenCalledOnce();
      }
    },
  );

  it('takes the exact-target admission claim synchronously before a reentrant callback and keeps different targets/accounts admitted', async () => {
    const guard = enter();
    const reentrantResults: Array<Promise<Result<void, Error>>> = [];
    const callback = vi.fn(async () => ok(undefined));
    let sameTargetCheck: Result<void, Error> | undefined;
    const secondAccount = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const result = await guard.invoke(invocation, async () => {
      sameTargetCheck = guard.checkTarget(account, target);
      reentrantResults.push(guard.invoke({ ...invocation, deliveryId: 'reentrant' }, callback));
      reentrantResults.push(
        guard.invoke(
          {
            ...invocation,
            deliveryId: 'same-account-other-target',
            destination: `signal:v1:${account}:group:QQ`,
          },
          callback,
        ),
      );
      reentrantResults.push(
        guard.invoke(
          {
            ...invocation,
            deliveryId: 'other-account',
            accountUuid: secondAccount,
            destination: `signal:v1:${secondAccount}:self`,
          },
          callback,
        ),
      );
      return ok(undefined);
    });
    expect(result.isOk()).toBe(true);
    expect(sameTargetCheck?.isErr()).toBe(true);
    expect(sameTargetCheck?._unsafeUnwrapErr()).toMatchObject({ reason: 'ACCOUNT_BUSY' });
    const resolved = await Promise.all(reentrantResults);
    expect(resolved[0]?._unsafeUnwrapErr()).toMatchObject({ reason: 'ACCOUNT_BUSY' });
    expect(resolved[1]?.isOk()).toBe(true);
    expect(resolved[2]?.isOk()).toBe(true);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('releases pre-callback write refusal, preserves thrown identity and does not reopen unclassified dispatch', async () => {
    const guard = enter();
    const failure = new SignalStateError('DATABASE');
    const mark = vi.spyOn(queue, 'markSignalDeliveryStarted').mockReturnValueOnce(err(failure));
    const callback = vi.fn(async () => ok(undefined));
    expect((await guard.invoke(invocation, callback))._unsafeUnwrapErr()).toBe(failure);
    mark.mockRestore();
    expect(guard.checkTarget(account, target).isOk()).toBe(true);
    const thrown = new Error('sanitized unexpected callback failure');
    await expect(
      guard.invoke({ ...invocation, deliveryId: 'throws' }, () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    const afterThrow = await guard.invoke(
      { ...invocation, deliveryId: 'after-unclassified-throw' },
      callback,
    );
    expect(afterThrow.isErr()).toBe(true);
    expect(afterThrow._unsafeUnwrapErr()).toMatchObject({ reason: 'TARGET_LATCHED' });
    expect(callback).not.toHaveBeenCalled();
  });

  it('retains a thrown typed NOT_SENT identity without inventing ambiguity or preventing later deliberate calls', async () => {
    const guard = enter();
    const failure = notSent();
    await expect(guard.invoke(invocation, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(guard.checkTarget(account, target).isOk()).toBe(true);
    const callback = vi.fn(async () => ok(undefined));
    expect(
      (await guard.invoke({ ...invocation, deliveryId: 'after-known-unsent' }, callback)).isOk(),
    ).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('keeps local in-flight admission scoped to one queue execution, not a global target gate', async () => {
    const guard = enter();
    let settle: ((result: Result<void, SignalDeliveryError>) => void) | undefined;
    const pending = new Promise<Result<void, SignalDeliveryError>>((resolve) => {
      settle = resolve;
    });
    const first = guard.invoke(invocation, () => pending);
    queue
      .enqueue({
        id: 'another-execution',
        thread_id: 'thread',
        message_id: null,
        type: 'collaboration',
        payload: '{}',
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    const other = SignalInvocationGuard.enter(queue, 'another-execution', () => at)._unsafeUnwrap();
    if (other.kind !== 'execution') throw new Error('Expected ordinary second execution');
    const callback = vi.fn(async () => ok(undefined));
    expect(
      (
        await other.guard.invoke(
          { ...invocation, deliveryId: 'independent-queue-operation' },
          callback,
        )
      ).isOk(),
    ).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
    expect(queue.inspectSignalDelivery('another-execution', at)._unsafeUnwrap()).toMatchObject({
      kind: 'invoked',
      marker: { queueItemId: 'another-execution' },
    });
    if (settle === undefined) throw new Error('Missing resolver');
    settle(ok(undefined));
    await first;
  });

  it('close during a live callback never reopens authority or leaks it to another execution', async () => {
    const guard = enter();
    let settle: ((result: Result<void, SignalDeliveryError>) => void) | undefined;
    const pending = new Promise<Result<void, SignalDeliveryError>>((resolve) => {
      settle = resolve;
    });
    const first = guard.invoke(invocation, () => pending);
    guard.close();
    const callback = vi.fn(async () => ok(undefined));
    expect(
      (
        await guard.invoke({ ...invocation, deliveryId: 'closed-overlap' }, callback)
      )._unsafeUnwrapErr(),
    ).toBeInstanceOf(SignalStateError);
    if (settle === undefined) throw new Error('Missing resolver');
    settle(err(unknown()));
    await first;
    expect(guard.checkTarget(account, target).isErr()).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(SignalInvocationGuard.enter(queue, 'queue', () => at).isErr()).toBe(true);
  });

  it('interoperates with actual sender marker refresh, subsequent same-live operations, NOT_SENT lease cleanup and real canonical config', async () => {
    let clock = at;
    const guardEntry = SignalInvocationGuard.enter(queue, 'queue', () => clock)._unsafeUnwrap();
    if (guardEntry.kind !== 'execution') throw new Error('Expected execution');
    const guard = guardEntry.guard;
    const accounts = new SignalAccountStateRepository(db);
    const leases = new SignalDestinationLeaseRepository(db);
    const config = SignalConfigSchema.parse({
      accountMode: 'personal',
      socketPath: '/run/signal/bridge.sock',
      account: account.toUpperCase(),
      accountUuid: account.toUpperCase(),
      deviceId: 3,
      deviceCreatedTimestamp: 200,
    });
    const observed: unknown[] = [];
    let blocked = true;
    const sender = new SignalSendCoordinator({
      queue,
      accounts,
      leases,
      now: () => clock,
      monotonicNow: () => clock,
      readiness: () => ({
        state: 'ready',
        generation: 1,
        config,
        proof: {
          status: 'verified',
          accountUuid: account,
          accountMode: 'personal',
          bridgeDeviceId: 3,
          generation: 1,
          verifiedAt: at,
          expiresAt: at + 100_000,
          humanDevices: [{ deviceId: 1, createdTimestamp: 100 }],
        },
      }),
      rpc: {
        request: async (request): Promise<SignalRpcResult> => {
          observed.push({
            method: request.method,
            state: queue.inspectSignalDelivery('queue', clock)._unsafeUnwrap(),
            reservation: accounts.findByAccount(account)._unsafeUnwrap()?.reservation,
          });
          // Source-shaped fixtures, NOT live evidence. Pinned v0.14.9 commit
          // 3997429779095ff3a2d64c877126e84fce9852aa: JsonContact.java:9-29;
          // JsonSendMessageResult.java:10-48; SendMessageResultUtils.java:43-68.
          if (request.method === 'listContacts')
            return ok({
              kind: 'result',
              value: [
                {
                  uuid: account,
                  isBlocked: blocked,
                  unregistered: false,
                  messageExpirationTime: 0,
                },
              ],
            });
          return ok({
            kind: 'send',
            evidence: parseSignalSendEvidence({
              timestamp: 1234,
              results: [
                {
                  type: 'SUCCESS',
                  recipientAddress: { uuid: account, number: null, username: null },
                },
              ],
            }),
          });
        },
      },
    });
    try {
      const firstPending = guard.invoke(invocation, (trustedDelivery) => {
        clock += 1;
        return sender.send(target, { body: 'first', trustedDelivery });
      });
      const extraSend = vi.fn(async () => ok(undefined));
      const overlap = await guard.invoke(
        { ...invocation, deliveryId: 'must-not-queue' },
        extraSend,
      );
      expect(overlap._unsafeUnwrapErr()).toMatchObject({
        reason: 'ACCOUNT_BUSY',
        outcome: 'NOT_SENT',
      });
      expect(extraSend).not.toHaveBeenCalled();
      const first = await firstPending;
      expect(first._unsafeUnwrapErr()).toMatchObject({
        reason: 'TARGET_REFUSED',
        outcome: 'NOT_SENT',
        providerRetryable: false,
      });
      expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
      expect(queue.inspectSignalDelivery('queue', clock)._unsafeUnwrap()).toMatchObject({
        kind: 'invoked',
        marker: { deliveryId: 'explicit-1', startedAt: at + 1 },
      });
      blocked = false;
      clock += 1_000;
      const second = await guard.invoke(
        { ...invocation, deliveryId: 'deliberate-second' },
        (trustedDelivery) => sender.send(target, { body: 'second', trustedDelivery }),
      );
      expect(second.isOk()).toBe(true);
      expect(observed).toHaveLength(3);
      expect(observed[2]).toMatchObject({
        method: 'send',
        state: { kind: 'invoked', marker: { deliveryId: 'deliberate-second' } },
        reservation: { queueItemId: 'queue', deliveryId: 'deliberate-second', purpose: 'explicit' },
      });
      expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
      expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
      expect(
        SignalInvocationGuard.enter(queue, 'queue', () => clock)._unsafeUnwrapErr(),
      ).toBeInstanceOf(NonRetryableRunError);
    } finally {
      guard.close();
      (await sender.drain())._unsafeUnwrap();
    }
  });
});
