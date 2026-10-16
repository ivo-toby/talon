import { err, ok, type Result } from 'neverthrow';
import type { SignalDeliveryPurpose, TrustedDeliveryContext } from '../channels/channel-types.js';
import {
  normalizeSignalUuid,
  parseSignalExternalId,
  type SignalIdentityError,
} from '../channels/connectors/signal/signal-identities.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';
import { SignalStateError } from '../core/database/repositories/signal-account-state-repository.js';
import { runResultTransaction } from '../core/database/transaction.js';
import {
  DbError,
  DeliveryCancelled,
  DeliveryDeferredError,
  NonRetryableRunError,
  SignalDeliveryError,
} from '../core/errors/error-types.js';
import {
  SignalCheckpointError,
  type SignalDeliveryCheckpoint,
  type SignalDeliveryStartedMarker,
} from '../queue/signal-delivery-checkpoint.js';
import type { SignalQueueFailure } from '../queue/signal-delivery-state.js';

export interface SignalInvocation {
  readonly deliveryId: string;
  readonly purpose: SignalDeliveryPurpose;
  readonly accountUuid: string;
  /** Already canonical, as required by the actual Signal connector. */
  readonly destination: string;
}

export type SignalInvocationGuardFailure =
  | SignalQueueFailure
  | DbError
  | NonRetryableRunError
  | SignalIdentityError
  | SignalDeliveryError;

export type SignalExecutionEntry =
  | { readonly kind: 'execution'; readonly guard: SignalInvocationGuard }
  | { readonly kind: 'checkpoint'; readonly checkpoint: SignalDeliveryCheckpoint };

export type SignalExecutionFailure =
  | { readonly kind: 'failure'; readonly error: Error }
  | { readonly kind: 'checkpoint'; readonly checkpoint: SignalDeliveryCheckpoint };

type StateFailure = SignalQueueFailure | DbError;

function atomic<T, E>(
  queue: QueueRepository,
  operation: () => Result<T, E>,
): Result<T, E | SignalStateError> {
  try {
    return runResultTransaction((callback) => queue.transaction(callback), operation);
  } catch {
    return err(new SignalStateError('DATABASE'));
  }
}

function active(queue: QueueRepository, queueItemId: string): Result<void, StateFailure> {
  return queue.findById(queueItemId).andThen((row) => {
    if (row === null) return err(new DeliveryCancelled());
    return ['pending', 'failed', 'claimed', 'processing'].includes(row.status)
      ? ok(undefined)
      : err(new SignalStateError('CONFLICT'));
  });
}

function operationKey(context: TrustedDeliveryContext): string {
  return JSON.stringify([context.deliveryId, context.purpose, context.runId ?? null]);
}

/** One trusted Runner.run execution, created BEFORE its background early return. Never recreate
 * it around a tool call or provider fresh-session retry. Queue dispatch remains the single owner
 * of an execution; possession of a persisted marker is not live execution authority. */
export class SignalInvocationGuard {
  private runId?: string;
  private closed = false;
  private readonly issued = new Set<string>();
  private readonly latched = new Set<string>();
  private readonly dispatching = new Set<string>();
  private blocked?: StateFailure;

  private constructor(
    private readonly queue: QueueRepository,
    private readonly queueItemId: string,
    private readonly now: () => number,
  ) {}

  static enter(
    queue: QueueRepository,
    queueItemId: string,
    now: () => number = Date.now,
  ): Result<SignalExecutionEntry, StateFailure | NonRetryableRunError> {
    // A rejected execution is a committed classification, not a returned Err inside the
    // transaction (which would roll the rejection back).
    return atomic<Result<SignalExecutionEntry, StateFailure | NonRetryableRunError>, StateFailure>(
      queue,
      () => {
        const state = queue.inspectSignalDelivery(queueItemId, now());
        if (state.isErr()) {
          if (!(state.error instanceof SignalCheckpointError)) return err(state.error);
          return queue.rejectSignalReplay(queueItemId, now()).map(() => err(state.error));
        }
        if (state.value.kind === 'checkpoint')
          return ok(ok({ kind: 'checkpoint', checkpoint: state.value.checkpoint }));
        if (state.value.kind === 'invoked') {
          return queue
            .rejectSignalReplay(queueItemId, now())
            .map(() => err(new NonRetryableRunError()));
        }
        return active(queue, queueItemId).map(() =>
          ok({ kind: 'execution', guard: new SignalInvocationGuard(queue, queueItemId, now) }),
        );
      },
    ).andThen((result) => result);
  }

  /** Call only after inserting the REAL foreground run. Background notifications never call this.
   * The repository validates the run's queue/thread ownership before any invocation can proceed. */
  attachRunId(runId: string): Result<void, SignalStateError> {
    if (this.closed || runId.length === 0 || (this.runId !== undefined && this.runId !== runId))
      return err(new SignalStateError('CONFLICT'));
    this.runId = runId;
    return ok(undefined);
  }

  /** IDs are allocated by trusted runner/tool code, stable for one operation, never model fields.
   * This constructs checkpoint metadata only, NOT send authority: live sends MUST use invoke. */
  context(
    deliveryId: string,
    purpose: SignalDeliveryPurpose,
  ): Result<TrustedDeliveryContext, SignalStateError> {
    if (
      this.closed ||
      deliveryId.length === 0 ||
      (purpose === 'background' && this.runId !== undefined)
    )
      return err(new SignalStateError('CONFLICT'));
    const required = { queueItemId: this.queueItemId, deliveryId, purpose };
    return ok(
      Object.freeze(this.runId === undefined ? required : { ...required, runId: this.runId }),
    );
  }

  /** Check before saving a final/background checkpoint, and again through invoke before dispatch.
   * ACCOUNT_BUSY means unresolved same-target work: do not save/dispatch around it using context().
   * Only Signal paths call this; other origin connectors keep their ordinary explanation path. */
  checkTarget(
    accountUuid: string,
    destination: string,
  ): Result<void, SignalIdentityError | SignalDeliveryError | SignalStateError> {
    if (this.closed) return err(new SignalStateError('CONFLICT'));
    return this.targetKey(accountUuid, destination).andThen((key) => {
      const latched = this.latched.has(key);
      return latched || this.dispatching.has(key)
        ? err(
            new SignalDeliveryError({
              reason: latched ? 'TARGET_LATCHED' : 'ACCOUNT_BUSY',
              outcome: 'NOT_SENT',
              acceptedChunks: 0,
              currentChunkAcceptance: 'unwritten',
              successCount: 0,
              failureCount: 0,
              retryScope: latched ? 'none' : 'delivery_only',
            }),
          )
        : ok(undefined);
    });
  }

  /** The callback is the ACTUAL connector/sender, called once, outside the transaction. No retries
   * or transport/lease logic here. Expected callback Err identity is retained, not thrown/wrapped. */
  async invoke<T, E extends Error>(
    invocation: SignalInvocation,
    send: (context: TrustedDeliveryContext) => Promise<Result<T, E>>,
  ): Promise<Result<T, E | SignalInvocationGuardFailure>> {
    const target = this.checkTarget(invocation.accountUuid, invocation.destination);
    if (target.isErr()) return err(target.error);
    const context = this.context(invocation.deliveryId, invocation.purpose);
    if (context.isErr()) return err(context.error);
    const key = this.targetKey(invocation.accountUuid, invocation.destination);
    if (key.isErr()) return err(key.error);
    // Admission only for this execution's exact target, NOT account-slot contention. No waiting
    // callback/body is retained. Distinct targets/accounts still reach the sender's existing FIFO.
    this.dispatching.add(key.value);
    let callbackEntered = false;
    try {
      const prepared = this.beforeInvocation(invocation, context.value);
      if (prepared.isErr()) {
        this.blocked = prepared.error;
        return err(prepared.error);
      }
      this.blocked = undefined;
      this.issued.add(operationKey(context.value));
      callbackEntered = true;
      const result = await send(context.value);
      if (result.isErr()) this.recordFailure(key.value, context.value.purpose, result.error);
      return result;
    } catch (cause) {
      if (callbackEntered) this.recordFailure(key.value, context.value.purpose, cause);
      throw cause;
    } finally {
      // Classification/latching happens BEFORE release, including synchronous throws/reentrancy.
      this.dispatching.delete(key.value);
    }
  }

  /** Call at unhandled provider/fresh-session catch boundaries, NOT for handled tool errors.
   * A current checkpoint always wins, including delivered/local-finalization-only work. On Err
   * retry only the local state transition, never provider work. Inspect again on every retry. */
  classifyFailure(failure: Error): Result<SignalExecutionFailure, StateFailure> {
    if (this.closed) return err(new SignalStateError('CONFLICT'));
    return atomic(this.queue, (): Result<SignalExecutionFailure, StateFailure> => {
      const current = this.queue.inspectSignalDelivery(this.queueItemId, this.now());
      if (current.isErr()) {
        if (!(current.error instanceof SignalCheckpointError)) return err(current.error);
        return this.queue
          .rejectSignalReplay(this.queueItemId, this.now())
          .map(() => ({ kind: 'failure', error: current.error }));
      }
      if (current.value.kind === 'checkpoint')
        return ok({ kind: 'checkpoint', checkpoint: current.value.checkpoint });
      if (current.value.kind === 'ordinary') {
        if (this.blocked !== undefined) return err(this.blocked);
        // Even a lost/removed marker is not permission to replay this live execution's tools.
        if (this.issued.size > 0) return err(new SignalStateError('CONFLICT'));
        return active(this.queue, this.queueItemId).map(() => ({
          kind: 'failure',
          error: failure,
        }));
      }
      return this.queue.rejectSignalReplay(this.queueItemId, this.now()).map(() => ({
        kind: 'failure',
        error:
          failure instanceof DeliveryDeferredError ||
          failure instanceof NonRetryableRunError ||
          failure instanceof DeliveryCancelled ||
          failure instanceof SignalDeliveryError ||
          failure instanceof SignalStateError ||
          failure instanceof SignalCheckpointError ||
          failure instanceof DbError
            ? failure
            : new NonRetryableRunError(),
      }));
    });
  }

  /** Runner finally owns this lifetime. Closed never reopens, even if a callback is still settling.
   * This does not cancel sender work. No global registry, timers or cross-execution latch. */
  close(): void {
    this.closed = true;
    this.issued.clear();
    this.latched.clear();
    this.dispatching.clear();
    this.blocked = undefined;
  }

  private recordFailure(key: string, purpose: SignalDeliveryPurpose, cause: unknown): void {
    // Saved reply-level PARTIAL can mean accepted earlier chunks + a proven-unsent current
    // cursor. The saved actor owns that retry. Unknown callback exceptions instead keep an
    // explicit/progress target closed without fabricating acceptance or wrapping the exception.
    if (this.closed || (purpose !== 'explicit' && purpose !== 'progress')) return;
    const failure =
      cause instanceof DeliveryDeferredError || cause instanceof NonRetryableRunError
        ? cause.deliveryError
        : cause;
    if (!(failure instanceof SignalDeliveryError) || failure.outcome !== 'NOT_SENT')
      this.latched.add(key);
  }

  private targetKey(accountUuid: string, destination: string): Result<string, SignalIdentityError> {
    return normalizeSignalUuid(accountUuid).andThen((account) =>
      parseSignalExternalId(destination, account).map(() =>
        JSON.stringify([this.queueItemId, account, destination]),
      ),
    );
  }

  private owns(marker: SignalDeliveryStartedMarker): boolean {
    // Sender.guardInvocation may refresh startedAt and replace the latest marker for ANY
    // operation already issued by this same live guard. Do not compare a stale marker snapshot.
    return marker.queueItemId === this.queueItemId && this.issued.has(operationKey(marker));
  }

  private beforeInvocation(
    invocation: SignalInvocation,
    context: TrustedDeliveryContext,
  ): Result<void, StateFailure> {
    return atomic(this.queue, () => {
      const inspected = this.queue.inspectSignalDelivery(this.queueItemId, this.now());
      if (inspected.isErr()) return err(inspected.error);
      const current = inspected.value;
      const usable = active(this.queue, this.queueItemId);
      if (usable.isErr()) return err(usable.error);
      if (current.kind === 'checkpoint') {
        const saved = current.checkpoint;
        return (context.purpose === 'reply' || context.purpose === 'background') &&
          saved.deliveryId === context.deliveryId &&
          saved.runId === context.runId &&
          saved.kind === context.purpose &&
          saved.accountUuid === invocation.accountUuid.toLowerCase() &&
          saved.destination === invocation.destination &&
          saved.phase === 'ready'
          ? ok(undefined)
          : err(new SignalStateError('CONFLICT'));
      }
      if (
        context.purpose === 'reply' ||
        context.purpose === 'background' ||
        (current.kind === 'invoked' && !this.owns(current.marker))
      )
        return err(new SignalStateError('CONFLICT'));
      return this.queue
        .markSignalDeliveryStarted(
          { version: 1, ...context, startedAt: this.now() },
          current.kind === 'invoked' ? current.marker : null,
          this.now(),
        )
        .map(() => undefined);
    });
  }
}
