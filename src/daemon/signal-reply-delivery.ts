import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type { SignalConnector } from '../channels/connectors/signal/signal-connector.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';
import type { AuditRepository } from '../core/database/repositories/audit-repository.js';
import type pino from 'pino';
import { SignalStateError } from '../core/database/repositories/signal-account-state-repository.js';
import { runResultTransaction } from '../core/database/transaction.js';
import {
  DbError,
  DeliveryCancelled,
  DeliveryDeferredError,
  NonRetryableRunError,
  SignalDeliveryError,
  type SignalDeliveryReason,
} from '../core/errors/error-types.js';
import {
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  type SignalDeliveryCheckpoint,
} from '../queue/signal-delivery-checkpoint.js';
import type { SignalDeliveryState } from '../queue/signal-delivery-state.js';
import type { SignalInvocationGuard } from './signal-invocation-guard.js';

export type SignalReplyIdentity = Pick<
  SignalDeliveryCheckpoint,
  | 'queueItemId'
  | 'deliveryId'
  | 'kind'
  | 'personaId'
  | 'threadId'
  | 'channelName'
  | 'accountUuid'
  | 'destination'
>;
export type SignalReplyPreparation = SignalReplyIdentity & Pick<SignalDeliveryCheckpoint, 'body'>;

export interface SignalReplyDeliveryDependencies {
  readonly queue: QueueRepository;
  readonly audit: AuditRepository;
  readonly logger?: Pick<pino.Logger, 'warn'>;
  /** Resolve the CURRENT named actual connector and reauthorize pinned ACI/selection, binding and
   * applicable capability rules. No cached pre-query connector. 012 must quiesce the old sender
   * before replacing authority: immutable producer waits have no caller revocation callback. */
  readonly resolve: (identity: SignalReplyIdentity) => Result<SignalConnector, Error>;
  /** Synchronous SAME-CONNECTION Result DB writes ONLY. Prepared: actual run usage/session result,
   * leaving it running; delivered: idempotent ORIGINAL full-body message then original run status.
   * Use outbound:<realRunId> / background-task:<taskId>:<status> as in AgentRunner. Background
   * has NO provider run/session. Err rolls back all writes; retry may reenter uncommitted callbacks.
   * No sessionTracker, observation emission, network, async work or external side effect here. */
  readonly persist: (
    phase: 'prepared' | 'delivered',
    checkpoint: SignalDeliveryCheckpoint,
  ) => Result<void, Error>;
  /** Best-effort context rotation only, AFTER history/run/queue commit. Not a durable outbox for
   * external observations. 010 owns live observation/sessionTracker lifetime outside SQL. */
  readonly afterFinalize?: (checkpoint: SignalDeliveryCheckpoint) => Promise<void>;
}

function databaseFailure(failure: Error): boolean {
  return failure instanceof SignalStateError
    ? failure.reason === 'DATABASE'
    : failure instanceof DbError;
}
function delay(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.min(250 * 2 ** Math.min(attempt, 6), 10_000)),
  );
}
function unsent(
  checkpoint: SignalDeliveryCheckpoint,
  reason: SignalDeliveryReason,
  retry = false,
): SignalDeliveryError {
  return new SignalDeliveryError({
    reason,
    outcome: checkpoint.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
    acceptedChunks: checkpoint.acceptedChunks,
    currentChunkAcceptance: checkpoint.currentChunkAcceptance,
    successCount: checkpoint.successCount,
    failureCount: checkpoint.failureCount,
    retryScope: retry ? 'delivery_only' : 'none',
  });
}
function terminal(checkpoint: SignalDeliveryCheckpoint): NonRetryableRunError {
  return new NonRetryableRunError(
    new SignalDeliveryError({
      reason: checkpoint.terminalReason ?? 'CHECKPOINT_INVALID',
      outcome: checkpoint.terminalOutcome ?? 'UNKNOWN',
      acceptedChunks: checkpoint.acceptedChunks,
      currentChunkAcceptance: checkpoint.currentChunkAcceptance,
      successCount: checkpoint.successCount,
      failureCount: checkpoint.failureCount,
      retryScope: 'none',
    }),
  );
}

/** Delivery ONLY, never a provider runtime. Trusted callers serialize each queue execution/actor
 * through the full awaited handler. 012 quiesces queue claims and drains handlers AND BOTH actual
 * connector stop Results before cold recovery/replacement. Health/count0 is never that authority. */
export class SignalReplyDelivery {
  constructor(private readonly dependencies: SignalReplyDeliveryDependencies) {}

  /** Retain the one generated original body/fixed preparation through initial DB failures. This
   * Promise must stay owned by the active handler; never turn a write failure into provider retry. */
  async prepare(
    input: SignalReplyPreparation,
    guard: SignalInvocationGuard,
  ): Promise<Result<SignalDeliveryCheckpoint, Error>> {
    const current = await this.read(input.queueItemId);
    if (current.isErr()) return err(current.error);
    if (current.value.kind === 'checkpoint') return ok(current.value.checkpoint);
    const allowed = guard.checkTarget(input.accountUuid, input.destination);
    if (allowed.isErr()) return err(allowed.error);
    const context = guard.context(input.deliveryId, input.kind);
    if (context.isErr()) return err(context.error);
    if (context.value.queueItemId !== input.queueItemId)
      return err(new SignalStateError('CONFLICT'));
    const resolved = this.resolve(input);
    if (resolved.isErr()) return err(resolved.error);
    const createdAt = Date.now();
    const prepared = resolved.value.prepare(input.destination, { body: input.body });
    if (prepared.isErr()) return err(prepared.error);
    const checkpoint: SignalDeliveryCheckpoint = {
      version: 1,
      ...input,
      ...(context.value.runId === undefined ? {} : { runId: context.value.runId }),
      chunks: prepared.value.chunks,
      nextChunk: 0,
      phase: 'ready',
      currentChunkAcceptance: 'unwritten',
      acceptedChunks: 0,
      successCount: 0,
      failureCount: 0,
      createdAt,
      expiresAt: createdAt + SIGNAL_CHECKPOINT_LIFETIME_MS,
    };
    for (let attempt = 0; ; attempt++) {
      const saved = this.atomic(() => {
        const latest = this.dependencies.queue.inspectSignalDelivery(input.queueItemId, Date.now());
        if (latest.isErr()) return err(latest.error);
        if (latest.value.kind === 'checkpoint') return ok(latest.value.checkpoint);
        const target = guard.checkTarget(input.accountUuid, input.destination);
        if (target.isErr()) return err(target.error);
        return this.dependencies.queue
          .saveSignalCheckpoint(checkpoint, Date.now())
          .andThen((value) => this.persist('prepared', value).map(() => value));
      });
      if (saved.isOk() || !databaseFailure(saved.error)) return saved;
      // Only the actual transition is retried; preparation, body and original TTL never change.
      await delay(attempt);
    }
  }

  /** Ignore stale snapshots: always inspect the actual row. Unknown-owner in_flight is BLOCKED,
   * not UNKNOWN authority. Only 012's quiesced public recoverSignalQueue can classify interruption. */
  async deliver(queueItemId: string, guard?: SignalInvocationGuard): Promise<Result<void, Error>> {
    for (;;) {
      const inspected = await this.read(queueItemId);
      if (inspected.isErr()) return err(inspected.error);
      if (inspected.value.kind !== 'checkpoint') return err(new SignalStateError('CONFLICT'));
      const checkpoint = inspected.value.checkpoint;
      if (checkpoint.phase === 'terminal') {
        const recorded = await this.recordTerminal(checkpoint);
        return recorded.isErr() ? err(recorded.error) : err(terminal(checkpoint));
      }
      if (checkpoint.phase === 'in_flight') return err(new SignalStateError('CONFLICT'));
      if (checkpoint.phase === 'delivered') return this.finalize(checkpoint);
      if (checkpoint.expiresAt <= Date.now()) {
        const expired = await this.terminate(checkpoint, unsent(checkpoint, 'CHECKPOINT_EXPIRED'));
        if (expired.isErr()) return expired;
        continue;
      }
      const selected = this.resolve(checkpoint);
      if (selected.isErr()) {
        const latest = await this.read(queueItemId);
        if (latest.isErr()) return err(latest.error);
        if (latest.value.kind !== 'checkpoint') return err(new SignalStateError('CONFLICT'));
        if (!isDeepStrictEqual(latest.value.checkpoint, checkpoint)) continue;
        const result = await this.refuse(checkpoint, selected.error);
        if (result.isErr()) return result;
        continue;
      }
      const connector = selected.value;
      let sent: Result<unknown, Error>;
      try {
        sent =
          guard === undefined
            ? await connector.sendPreparedChunk(
                checkpoint.destination,
                checkpoint.chunks[checkpoint.nextChunk],
                {
                  queueItemId,
                  deliveryId: checkpoint.deliveryId,
                  purpose: checkpoint.kind,
                  ...(checkpoint.runId === undefined ? {} : { runId: checkpoint.runId }),
                },
              )
            : await guard.invoke(
                {
                  deliveryId: checkpoint.deliveryId,
                  purpose: checkpoint.kind,
                  accountUuid: checkpoint.accountUuid,
                  destination: checkpoint.destination,
                },
                (context) =>
                  connector.sendPreparedChunk(
                    checkpoint.destination,
                    checkpoint.chunks[checkpoint.nextChunk],
                    context,
                  ),
              );
      } catch (cause) {
        // Never serialize an unexpected callback/RPC exception. Expected typed errors survive.
        sent = err(
          cause instanceof SignalDeliveryError ||
            cause instanceof DbError ||
            cause instanceof DeliveryCancelled
            ? cause
            : new SignalStateError('CONFLICT'),
        );
      }
      if (
        sent.isErr() &&
        sent.error instanceof SignalDeliveryError &&
        sent.error.reason === 'STATE_WRITE_FAILED'
      ) {
        // THAT original producer retains the known classification/full CAS. No new owner, RPC,
        // health-based success, global recovery or fabricated UNKNOWN is permitted here.
        const repaired = await this.repair(connector, queueItemId);
        if (repaired.isErr()) return repaired;
      }
      const latest = await this.read(queueItemId);
      if (latest.isErr()) return err(latest.error);
      if (latest.value.kind !== 'checkpoint') return err(new SignalStateError('CONFLICT'));
      const actual = latest.value.checkpoint;
      if (
        actual.phase !== 'ready' ||
        actual.deliveryId !== checkpoint.deliveryId ||
        actual.nextChunk !== checkpoint.nextChunk
      )
        continue;
      if (sent.isOk()) return err(new SignalStateError('CONFLICT')); // Receipt alone is not a saved cursor.
      const refused = await this.refuse(actual, sent.error);
      if (refused.isErr()) return refused;
    }
  }

  private resolve(identity: SignalReplyIdentity): Result<SignalConnector, Error> {
    try {
      return this.dependencies.resolve(identity);
    } catch {
      return err(new NonRetryableRunError());
    }
  }

  private persist(
    phase: 'prepared' | 'delivered',
    checkpoint: SignalDeliveryCheckpoint,
  ): Result<void, Error> {
    try {
      return this.dependencies.persist(phase, checkpoint);
    } catch {
      return err(new NonRetryableRunError());
    }
  }

  private atomic<T>(operation: () => Result<T, Error>): Result<T, Error> {
    try {
      return runResultTransaction(
        (callback) => this.dependencies.queue.transaction(callback),
        operation,
      );
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }

  private async read(queueItemId: string): Promise<Result<SignalDeliveryState, Error>> {
    for (let attempt = 0; ; attempt++) {
      const result = this.dependencies.queue.inspectSignalDelivery(queueItemId, Date.now());
      if (result.isOk() || !databaseFailure(result.error)) return result;
      await delay(attempt);
    }
  }

  private async repair(
    connector: SignalConnector,
    queueItemId: string,
  ): Promise<Result<void, Error>> {
    for (let attempt = 0; ; attempt++) {
      const result = connector.retryStateWrites();
      const current = await this.read(queueItemId);
      if (current.isErr()) return err(current.error);
      // Both actual producer Results matter. A verifier Err must not be called successful repair
      // merely because its sender's write committed or the row now reads delivered.
      if (result.isOk()) return ok(undefined);
      if (!databaseFailure(result.error)) return err(result.error);
      await delay(attempt);
    }
  }

  private async refuse(
    checkpoint: SignalDeliveryCheckpoint,
    failure: Error,
  ): Promise<Result<void, Error>> {
    if (!(failure instanceof SignalDeliveryError)) return err(failure);
    // An unavailable connector can refuse before entering its sender, with zero progress. Its
    // unwritten result describes THIS chunk; the authoritative saved cursor supplies prior counts.
    const cumulative =
      failure.currentChunkAcceptance === 'unwritten' && failure.successCount === 0
        ? new SignalDeliveryError({
            ...failure,
            outcome: checkpoint.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
            acceptedChunks: checkpoint.acceptedChunks,
            successCount: checkpoint.successCount,
            failureCount: checkpoint.failureCount,
          })
        : failure;
    if (cumulative.retryScope === 'delivery_only')
      return err(new DeliveryDeferredError(cumulative, checkpoint.expiresAt));
    if (!['unwritten', 'refused'].includes(cumulative.currentChunkAcceptance))
      return err(new SignalStateError('CONFLICT'));
    return this.terminate(checkpoint, cumulative);
  }

  private async terminate(
    checkpoint: SignalDeliveryCheckpoint,
    failure: SignalDeliveryError,
  ): Promise<Result<void, Error>> {
    for (let attempt = 0; ; attempt++) {
      const latest = await this.read(checkpoint.queueItemId);
      if (latest.isErr()) return err(latest.error);
      if (latest.value.kind !== 'checkpoint') return err(new SignalStateError('CONFLICT'));
      if (!isDeepStrictEqual(latest.value.checkpoint, checkpoint)) return ok(undefined);
      const result = this.atomic(() =>
        this.dependencies.queue
          .terminateSignalDelivery(checkpoint, failure, Date.now())
          .andThen((current) =>
            this.writeTerminalAudit(current).map((inserted) => ({ inserted, checkpoint: current })),
          ),
      );
      if (result.isOk()) {
        if (result.value.inserted) this.warnTerminal(result.value.checkpoint);
        return ok(undefined);
      }
      if (!databaseFailure(result.error)) return err(result.error);
      await delay(attempt);
    }
  }

  /** Existing public findByThread reads ALL thread audit history. No truncation is safe for dedup.
   * This records actor-observed terminal states, not an outbox for a crash before observation. */
  private writeTerminalAudit(expected: SignalDeliveryCheckpoint): Result<boolean, Error> {
    const inspected = this.dependencies.queue.inspectSignalDelivery(
      expected.queueItemId,
      Date.now(),
    );
    if (inspected.isErr()) return err(inspected.error);
    if (
      inspected.value.kind !== 'checkpoint' ||
      inspected.value.checkpoint.phase !== 'terminal' ||
      !isDeepStrictEqual(inspected.value.checkpoint, expected)
    )
      return err(new SignalStateError('CONFLICT'));
    const checkpoint = inspected.value.checkpoint;
    const id =
      'signal-reply-terminal:v1:' +
      createHash('sha256')
        .update(JSON.stringify([checkpoint.queueItemId, checkpoint.deliveryId]))
        .digest('hex');
    const entry = {
      id,
      run_id: checkpoint.runId ?? null,
      thread_id: checkpoint.threadId,
      persona_id: checkpoint.personaId,
      action: 'signal.delivery.terminal',
      tool: null,
      request_id: null,
      details: JSON.stringify({
        queueItemId: checkpoint.queueItemId,
        deliveryId: checkpoint.deliveryId,
        reason: checkpoint.terminalReason,
        outcome: checkpoint.terminalOutcome,
        acceptedChunks: checkpoint.acceptedChunks,
        successCount: checkpoint.successCount,
        failureCount: checkpoint.failureCount,
      }),
    };
    return this.dependencies.audit.findByThread(checkpoint.threadId).andThen((entries) => {
      const existing = entries.find((row) => row.id === id);
      if (existing !== undefined) {
        return isDeepStrictEqual(existing, { ...entry, created_at: existing.created_at })
          ? ok(false)
          : err(new SignalStateError('CONFLICT'));
      }
      return this.dependencies.audit.insert(entry).map(() => true);
    });
  }

  private async recordTerminal(checkpoint: SignalDeliveryCheckpoint): Promise<Result<void, Error>> {
    for (let attempt = 0; ; attempt++) {
      const result = this.atomic(() => this.writeTerminalAudit(checkpoint));
      if (result.isOk()) {
        if (result.value) this.warnTerminal(checkpoint);
        return ok(undefined);
      }
      if (!databaseFailure(result.error)) return err(result.error);
      await delay(attempt);
    }
  }

  private warnTerminal(checkpoint: SignalDeliveryCheckpoint): void {
    try {
      this.dependencies.logger?.warn(
        {
          deliveryId: checkpoint.deliveryId,
          reason: checkpoint.terminalReason,
          outcome: checkpoint.terminalOutcome,
          acceptedChunks: checkpoint.acceptedChunks,
          successCount: checkpoint.successCount,
          failureCount: checkpoint.failureCount,
        },
        'saved Signal delivery terminal',
      );
    } catch {
      /* A logging failure cannot change the committed durable audit/terminal decision. */
    }
  }

  private async finalize(checkpoint: SignalDeliveryCheckpoint): Promise<Result<void, Error>> {
    let finalized = false;
    const result = this.dependencies.queue.finalizeSignalDelivery(
      checkpoint,
      (current) =>
        this.persist('delivered', current).map(() => {
          finalized = true;
        }),
      Date.now(),
    );
    if (result.isErr()) return err(result.error);
    if (finalized) {
      try {
        await this.dependencies.afterFinalize?.(checkpoint);
      } catch {
        /* Rotation is best effort AFTER committed original history/run/queue. */
      }
    }
    return ok(undefined);
  }
}
