import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { AgentOutput, TrustedDeliveryContext } from '../../channel-types.js';
import {
  DeliveryCancelled,
  SignalDeliveryError,
  type SignalDeliveryReason,
} from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import { runResultTransaction } from '../../../core/database/transaction.js';
import {
  SignalStateError,
  type SignalAccountState,
  type SignalAccountStateRepository,
  type SignalPause,
  type SignalSendReservation,
} from '../../../core/database/repositories/signal-account-state-repository.js';
import type {
  SignalDestinationLease,
  SignalDestinationLeaseRepository,
} from '../../../core/database/repositories/signal-destination-lease-repository.js';
import type { QueueRepository } from '../../../core/database/repositories/queue-repository.js';
import type { SignalDeliveryCheckpoint } from '../../../queue/signal-delivery-checkpoint.js';
import type {
  SignalChunkOwnership,
  SignalQueueFailure,
} from '../../../queue/signal-delivery-state.js';
import type {
  SignalAccountProofSnapshot,
  SignalChunkReceipt,
  SignalPreparedDelivery,
} from './signal-types.js';
import { prepareSignalText } from './signal-text.js';
import type { SignalConfig } from './signal-config.js';
import type { SignalDestination } from './signal-identities.js';
import {
  createSignalTargetRequest,
  selectSignalTarget,
  validateSignalTargetMetadata,
} from './signal-target.js';
import {
  classifySignalSendResult,
  interpretSignalRestrictions,
  type SignalSendClassification,
  type SignalSendProgress,
} from './signal-send-result.js';
import {
  SignalRpcTransportError,
  type SignalRpcClient,
  type SignalRpcResult,
} from './signal-rpc-client.js';
import {
  SignalRpcRemoteError,
  encodeSignalRpcRequest,
  type SignalRpcRequest,
} from './signal-wire.js';

export interface SignalSendReadiness {
  readonly state: 'ready' | 'reconnecting' | 'needs_setup';
  readonly generation: number;
  readonly config: SignalConfig;
  readonly proof: SignalAccountProofSnapshot;
}

export interface SignalSendPersistenceHealth {
  readonly state: 'healthy' | 'blocked';
  readonly stopped: boolean;
  readonly pendingWrites: number;
}

export interface SignalSendCoordinatorDependencies {
  /** All three repositories MUST use the same connection; recovery/dispatch has one owner/account. */
  readonly accounts: SignalAccountStateRepository;
  readonly leases: SignalDestinationLeaseRepository;
  readonly queue: QueueRepository;
  readonly rpc: Pick<SignalRpcClient, 'request'>;
  /** Immutable current publication, synchronously read outside transactions. No IO. */
  readonly readiness: () => SignalSendReadiness;
  /** Safe epoch milliseconds for durable policy/proof/lifetime timestamps only. */
  readonly now?: () => number;
  /** Finite nondecreasing elapsed milliseconds, independent of epoch time and consistent with timers. */
  readonly monotonicNow?: () => number;
  /** Synchronous local nonthrowing hook, outside transactions. Health grants no send/replacement authority. */
  readonly onPersistenceChange?: (health: SignalSendPersistenceHealth) => void;
}

interface Operation {
  readonly destination: string;
  readonly context: TrustedDeliveryContext;
  readonly chunks: readonly string[];
  readonly bytes: number;
  readonly resolve: (result: Result<SignalChunkReceipt, SignalDeliveryError>) => void;
  readonly saved: boolean;
  index: number;
  /** Current chunk only: finalization must not retry ready-only writes after reservation. */
  chunkAuthority: 'preflight' | 'reserved' | 'settled' | 'cancelled';
  progress: SignalSendProgress;
  /** Monotonic elapsed deadline; never persisted or compared to epoch time. */
  waitDeadline: number;
  /** Immutable saved lifetime only; never a cached target/proof authorization. */
  expiresAt?: number;
  lease?: SignalDestinationLease;
}
interface Active {
  readonly operation: Operation;
  readonly done: Promise<void>;
  finish: () => void;
  /** Monotonic elapsed deadline for the active request. */
  requestDeadline?: number;
  forceRequest?: () => void;
}
interface RetainedWrite {
  readonly write: () => Result<unknown, SignalQueueFailure>;
  error?: SignalQueueFailure;
  retryAt: number;
  attempts: number;
}
const databaseFailure = (error: SignalQueueFailure): boolean =>
  error instanceof SignalStateError && error.reason === 'DATABASE';

const zero: SignalSendProgress = { acceptedChunks: 0, successCount: 0, failureCount: 0 };
// Do not retain a whole saved checkpoint/body under a small waiting-text charge.
const counts = (value: SignalSendProgress): SignalSendProgress => ({
  acceptedChunks: value.acceptedChunks,
  successCount: value.successCount,
  failureCount: value.failureCount,
});
const savedPurpose = (context: TrustedDeliveryContext): boolean =>
  context.purpose === 'reply' || context.purpose === 'background';
const key = (context: TrustedDeliveryContext): string =>
  JSON.stringify([context.queueItemId, context.deliveryId]);

function failure(
  reason: SignalDeliveryReason,
  progress: SignalSendProgress = zero,
  retry = true,
  notBefore?: number,
): SignalDeliveryError {
  return new SignalDeliveryError({
    reason,
    ...progress,
    outcome: progress.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
    currentChunkAcceptance: 'unwritten',
    retryScope: retry ? 'delivery_only' : 'none',
    notBefore,
  });
}
function observedFailure(
  reason: 'CANCELLED' | 'STATE_WRITE_FAILED',
  classification: SignalSendClassification,
  previous: SignalSendProgress,
): SignalDeliveryError {
  if (classification.result.isErr())
    return new SignalDeliveryError({
      ...classification.result.error,
      reason,
      // Committed purge is permanent, unlike call-scope cancellation or state-write failure.
      retryScope: reason === 'CANCELLED' ? 'none' : classification.result.error.retryScope,
    });
  return new SignalDeliveryError({
    reason,
    ...previous,
    successCount: previous.successCount + classification.result.value.successCount,
    outcome: 'PARTIAL',
    currentChunkAcceptance: 'complete',
    retryScope: 'none',
  });
}

/** Integration-only sender. Caller supplies unique per-operation trusted identities and serializes
 * each saved delivery (including retries). Never reuse an invocation ID for another operation.
 * No provider, verification scheduler, public resume, queue rescheduling or history finalizer here. */
export class SignalSendCoordinator implements SignalPreparedDelivery {
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly accountUuid: string;
  private readonly generation: number;
  private waiting: Operation[] = [];
  private readonly operations = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Active;
  private stopped = false;
  private fatalFailure?: SignalQueueFailure;
  private readonly retained = new Map<Operation, RetainedWrite[]>();
  // Retain the existing ONE active allocation, including exact full-checkpoint CAS/purge authority.
  // All other waiting/finishing/retained operations share the original 64 / 1MiB text charge.
  private retainedActive?: Operation;
  private repairing = false;
  private publishedHealth?: SignalSendPersistenceHealth;
  private readonly finishing = new Map<Promise<void>, Operation>();
  /** Monotonic elapsed limit for local drain/write retries. */
  private drainDeadline = Infinity;

  constructor(private readonly dependencies: SignalSendCoordinatorDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.monotonicNow = dependencies.monotonicNow ?? ((): number => performance.now());
    const initial = dependencies.readiness();
    this.accountUuid = initial.config.accountUuid;
    this.generation = initial.generation;
  }

  prepare(destination: string, output: AgentOutput): ReturnType<typeof prepareSignalText> {
    return prepareSignalText(destination, output, this.accountUuid);
  }

  /** Prepare once. This non-async frame does not retain the original output while waiting.
   * Saved callers normally use the three-argument chunk API with their actual cursor. */
  send(destination: string, output: AgentOutput): Promise<Result<void, SignalDeliveryError>> {
    const prepared = this.prepare(destination, output);
    if (prepared.isErr()) return Promise.resolve(err(prepared.error));
    const context = output.trustedDelivery;
    if (context === undefined)
      return Promise.resolve(err(failure('CHECKPOINT_INVALID', zero, false)));
    let chunks = prepared.value.chunks;
    if (savedPurpose(context)) {
      const inspected = this.dependencies.queue.inspectSignalDelivery(
        context.queueItemId,
        this.now(),
      );
      if (inspected.isErr()) return Promise.resolve(err(this.stateFailure(inspected.error)));
      if (
        inspected.value.kind !== 'checkpoint' ||
        inspected.value.checkpoint.body !== output.body ||
        !isDeepStrictEqual(inspected.value.checkpoint.chunks, chunks)
      )
        return Promise.resolve(err(failure('CHECKPOINT_INVALID', zero, false)));
      chunks = chunks.slice(inspected.value.checkpoint.nextChunk);
    }
    return this.submit(destination, chunks, context).then((result) => result.map(() => undefined));
  }

  sendPreparedChunk(
    destination: string,
    chunk: string,
    context: TrustedDeliveryContext,
  ): Promise<Result<SignalChunkReceipt, SignalDeliveryError>> {
    return this.submit(destination, [chunk], context);
  }

  /** Cancel ONLY this unwritten call, never the active RPC or durable saved delivery.
   * Saved ready work/lease remains eligible for delivery-only deferral; purge cancels durably. */
  cancelWaiter(context: TrustedDeliveryContext): boolean {
    const operation = this.waiting.find((entry) => key(entry.context) === key(context));
    if (operation === undefined) return false;
    this.waiting = this.waiting.filter((entry) => entry !== operation);
    this.finishWaiting(
      operation,
      err(failure('CANCELLED', this.latestProgress(operation), operation.saved)),
    );
    return true;
  }

  /** Publication changes may wake waits; this neither verifies nor resets persisted restrictions. */
  readinessChanged(): void {
    this.pump();
  }

  persistenceHealth(): SignalSendPersistenceHealth {
    return Object.freeze({
      state: this.retained.size === 0 && this.fatalFailure === undefined ? 'healthy' : 'blocked',
      stopped: this.stopped,
      pendingWrites: [...this.retained.values()].reduce((total, jobs) => total + jobs.length, 0),
    });
  }

  /** DB-only, one attempt per due retained stage; no timers, RPC, verification or admission restart.
   * Keep this owner until this AND a subsequent drain are Ok. Non-DATABASE conflicts stay blocked. */
  retryStateWrites(): Result<void, SignalQueueFailure> {
    if (this.repairing || this.active !== undefined || this.finishing.size > 0)
      return err(this.persistenceFailure ?? new SignalStateError('BUSY'));
    this.repairing = true;
    try {
      for (const [operation, jobs] of this.retained) {
        while (jobs.length > 0) {
          const job = jobs[0];
          if (
            (job.error !== undefined && !databaseFailure(job.error)) ||
            this.monotonicNow() < job.retryAt
          )
            break;
          const result = job.write();
          if (result.isErr() && !(result.error instanceof DeliveryCancelled)) {
            job.error = result.error;
            job.retryAt =
              this.monotonicNow() + Math.min(250 * 2 ** Math.min(job.attempts++, 6), 10_000);
            break;
          }
          jobs.shift();
        }
        if (jobs.length === 0) {
          this.retained.delete(operation);
          if (this.retainedActive === operation) this.retainedActive = undefined;
        }
      }
      return this.persistenceFailure === undefined ? ok(undefined) : err(this.persistenceFailure);
    } finally {
      this.repairing = false;
      this.publishHealth();
    }
  }

  private get persistenceFailure(): SignalQueueFailure | undefined {
    if (this.fatalFailure !== undefined) return this.fatalFailure;
    for (const jobs of this.retained.values())
      for (const job of jobs) if (job.error !== undefined) return job.error;
    return undefined;
  }

  private publishHealth(): void {
    const health = this.persistenceHealth();
    if (isDeepStrictEqual(health, this.publishedHealth)) return;
    this.publishedHealth = health;
    try {
      this.dependencies.onPersistenceChange?.(health);
    } catch {
      // Publication cannot change committed authority or discard a retained write.
    }
  }

  /** Irreversible admissions stop. Replacement must not recover/reuse this account until drain Ok. */
  quiesce(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const waiting = this.waiting;
    this.waiting = [];
    for (const operation of waiting)
      this.finishWaiting(operation, err(failure('UNAVAILABLE', this.latestProgress(operation))));
    this.publishHealth();
  }

  /** Drains RPC separately from unwritten cancellation. A failed state write is NOT idle:
   * return Err and retain durable recovery ownership; lifecycle must keep dispatch quiesced. */
  async drain(): Promise<Result<void, SignalQueueFailure>> {
    this.drainDeadline = Math.min(this.drainDeadline, this.monotonicNow() + 30_000);
    this.quiesce();
    const active = this.active;
    if (active !== undefined) {
      this.drainDeadline = Math.min(
        this.drainDeadline,
        this.monotonicNow() + 30_000,
        active.requestDeadline ?? Infinity,
      );
      const timer = setTimeout(
        () => active.forceRequest?.(),
        Math.max(0, this.drainDeadline - this.monotonicNow()),
      );
      await active.done;
      clearTimeout(timer);
    }
    await Promise.all([...this.finishing.keys()]);
    return this.persistenceFailure === undefined ? ok(undefined) : err(this.persistenceFailure);
  }

  private finishWaiting(
    operation: Operation,
    result: Result<SignalChunkReceipt, SignalDeliveryError>,
  ): void {
    // Register before execution: finish can synchronously publish a hook that repairs/drains.
    const finished = Promise.resolve().then(() => {
      operation.progress = this.latestProgress(operation);
      return this.finish(operation, result);
    });
    this.finishing.set(finished, operation);
    void finished.then(() => {
      this.finishing.delete(finished);
    });
  }

  private schedule(): void {
    if (this.stopped || this.waiting.length === 0) return;
    this.timer = setTimeout(
      () => this.pump(),
      Math.min(
        50,
        Math.max(
          1,
          Math.min(...this.waiting.map((entry) => entry.waitDeadline)) - this.monotonicNow(),
        ),
      ),
    );
  }

  private hasCapacity(bytes: number): boolean {
    const retained = [
      ...new Set([...this.waiting, ...this.finishing.values(), ...this.retained.keys()]),
    ].filter((operation) => operation !== this.retainedActive);
    return (
      retained.length < 64 &&
      retained.reduce((total, entry) => total + entry.bytes, 0) + bytes <= 1_048_576
    );
  }

  private submit(
    destination: string,
    chunks: readonly string[],
    context: TrustedDeliveryContext,
  ): Promise<Result<SignalChunkReceipt, SignalDeliveryError>> {
    if (
      context.queueItemId.length === 0 ||
      context.deliveryId.length === 0 ||
      !['reply', 'background', 'explicit', 'progress'].includes(context.purpose) ||
      this.operations.has(key(context)) ||
      chunks.length === 0
    )
      return Promise.resolve(err(failure('CHECKPOINT_INVALID', zero, false)));
    const bytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk, 'utf8'), 0);
    const operation = (resolve: Operation['resolve']): Operation => ({
      destination,
      chunks,
      bytes,
      context: Object.freeze({ ...context }),
      resolve,
      saved: savedPurpose(context),
      index: 0,
      chunkAuthority: 'preflight',
      progress: zero,
      waitDeadline: this.monotonicNow() + 30_000,
    });
    const candidate = operation(() => undefined);
    if (candidate.saved) {
      const current = this.snapshot(candidate);
      if (current.isErr()) return Promise.resolve(err(this.stateFailure(current.error)));
      if (current.value !== null) {
        candidate.progress = counts(current.value);
        candidate.expiresAt = current.value.expiresAt;
      }
    }
    const progress = candidate.progress;
    if (this.stopped || this.persistenceFailure !== undefined)
      return Promise.resolve(err(failure('UNAVAILABLE', progress)));
    // Unwritten terminal-write backoffs retain the same text as account-slot waiters.
    if (!this.hasCapacity(bytes)) return Promise.resolve(err(failure('RPC_CAPACITY', progress)));
    const selected = selectSignalTarget(destination, this.dependencies.readiness().config);
    if (selected.isErr()) {
      this.operations.add(key(context));
      return new Promise((resolve) =>
        this.finishWaiting(
          { ...candidate, resolve },
          err(failure(selected.error.reason, progress, false)),
        ),
      );
    }
    for (const chunk of chunks) {
      if (
        Buffer.from(chunk, 'utf8').toString('utf8') !== chunk ||
        encodeSignalRpcRequest(this.sendRequest(selected.value, chunk), 'validate').isErr()
      )
        return Promise.resolve(err(failure('INVALID_RESPONSE', progress, false)));
    }
    this.operations.add(key(context));
    return new Promise((resolve) => {
      this.waiting = [...this.waiting, { ...candidate, resolve }];
      this.pump();
    });
  }

  private proofFailure(): SignalDeliveryError | undefined {
    const { state, config, generation, proof } = this.dependencies.readiness();
    if (
      !Number.isSafeInteger(this.now()) ||
      this.now() < 0 ||
      !Number.isSafeInteger(this.now() + 60_000)
    )
      return failure('STATE_WRITE_FAILED', zero, false);
    if (config.accountUuid !== this.accountUuid) return failure('ACCOUNT_MISMATCH', zero, false);
    if (state === 'needs_setup') return failure('NEEDS_SETUP', zero, false);
    if (state !== 'ready' || generation !== this.generation) return failure('UNAVAILABLE');
    if (
      proof.accountUuid !== this.accountUuid ||
      proof.generation !== generation ||
      proof.accountMode !== config.accountMode ||
      proof.bridgeDeviceId !== config.deviceId ||
      proof.status !== 'verified'
    )
      return failure('VERIFICATION_PENDING');
    const now = this.now();
    if (
      !Number.isSafeInteger(proof.verifiedAt) ||
      !Number.isSafeInteger(proof.expiresAt) ||
      proof.verifiedAt < 0 ||
      proof.verifiedAt > now ||
      now >= proof.expiresAt ||
      now - proof.verifiedAt >= 300_000 ||
      proof.expiresAt - proof.verifiedAt > 300_000
    )
      return failure('VERIFICATION_STALE');
    return undefined;
  }

  private pump(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.waiting.length === 0) return;
    const now = this.now();
    // Local terminal decisions need no account slot, fresh target RPC or destination lease.
    // In particular an expired/now-unselected waiter cannot hide behind a foreign owner.
    for (const operation of [...this.waiting]) {
      const refused = this.localFailure(operation);
      if (refused !== undefined) {
        this.waiting = this.waiting.filter((entry) => entry !== operation);
        this.finishWaiting(operation, err(refused));
      }
      if (this.stopped) return;
    }
    const elapsed = this.monotonicNow();
    const expired = this.waiting.filter((operation) => elapsed >= operation.waitDeadline);
    this.waiting = this.waiting.filter((operation) => elapsed < operation.waitDeadline);
    for (const operation of expired)
      this.finishWaiting(operation, err(this.waitFailure(operation)));
    if (this.waiting.length === 0) return;
    if (this.active !== undefined) {
      this.schedule();
      return;
    }
    const proof = this.proofFailure();
    const account = this.dependencies.accounts.getOrCreate(this.accountUuid, now);
    const blocked =
      account.isErr() ||
      account.value.reservation !== null ||
      account.value.pauseKind === 'challenge' ||
      now < account.value.notBefore ||
      (account.value.lastSendStart !== null && now < account.value.lastSendStart + 1_000);
    if (proof?.retryScope !== 'delivery_only' && !blocked) {
      // Skip lease-blocked new operations so a current message can rejoin behind them.
      const operation = this.waiting.find((entry) => {
        const lease = this.dependencies.leases.find(this.accountUuid, entry.destination);
        return lease.isErr() || lease.value === null || this.owns(entry, lease.value);
      });
      if (operation !== undefined) {
        this.waiting = this.waiting.filter((entry) => entry !== operation);
        let finish = (): void => {};
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const active: Active = { operation, done, finish };
        this.active = active;
        void this.run(operation).then(async (result) => {
          if (result.isOk() && operation.index + 1 < operation.chunks.length && !this.stopped) {
            operation.index++;
            operation.chunkAuthority = 'preflight';
            operation.progress = {
              acceptedChunks: operation.progress.acceptedChunks + 1,
              successCount: operation.progress.successCount + result.value.successCount,
              failureCount: operation.progress.failureCount,
            };
            operation.waitDeadline = this.monotonicNow() + 30_000;
            if (!this.hasCapacity(operation.bytes))
              await this.finish(operation, err(failure('RPC_CAPACITY', operation.progress)));
            else this.waiting = [...this.waiting, operation];
          } else {
            const stoppedTail = result.isOk() && operation.index + 1 < operation.chunks.length;
            if (stoppedTail) {
              operation.index++;
              operation.chunkAuthority = 'preflight';
              operation.progress = {
                acceptedChunks: operation.progress.acceptedChunks + 1,
                successCount: operation.progress.successCount + result.value.successCount,
                failureCount: operation.progress.failureCount,
              };
            }
            await this.finish(
              operation,
              stoppedTail ? err(failure('UNAVAILABLE', operation.progress)) : result,
            );
          }
          this.active = undefined;
          active.finish();
          this.pump();
        });
        this.schedule();
        return;
      }
    }
    this.schedule();
  }

  private localFailure(operation: Operation): SignalDeliveryError | undefined {
    const progress = operation.progress;
    if (operation.expiresAt !== undefined && this.now() >= operation.expiresAt)
      return failure('CHECKPOINT_EXPIRED', progress, false);
    const proof = this.proofFailure();
    if (proof?.retryScope === 'none') return failure(proof.reason, progress, false);
    const selected = selectSignalTarget(
      operation.destination,
      this.dependencies.readiness().config,
    );
    return selected.isErr() ? failure(selected.error.reason, progress, false) : undefined;
  }

  private waitFailure(operation: Operation): SignalDeliveryError {
    const proof = this.proofFailure();
    const account = this.dependencies.accounts.findByAccount(this.accountUuid);
    let reason: SignalDeliveryReason = proof?.reason ?? 'WAIT_EXPIRED';
    let notBefore: number | undefined;
    if (account.isErr()) reason = 'STATE_WRITE_FAILED';
    else if (account.value !== null) {
      const state = account.value;
      notBefore = Math.max(state.notBefore, (state.lastSendStart ?? -1000) + 1000);
      if (state.pauseKind === 'challenge') reason = 'CHALLENGE_REQUIRED';
      else if (this.now() < state.notBefore)
        reason =
          state.rateLimitNotBefore >= state.recoveryNotBefore ? 'RATE_LIMITED' : 'RECOVERY_PENDING';
    }
    return failure(reason, this.latestProgress(operation), true, notBefore);
  }

  private owns(operation: Operation, lease: SignalDestinationLease): boolean {
    return (
      lease.queueItemId === operation.context.queueItemId &&
      lease.deliveryId === operation.context.deliveryId &&
      lease.kind === operation.context.purpose
    );
  }

  private latestProgress(operation: Operation): SignalSendProgress {
    if (!operation.saved) return operation.progress;
    const state = this.dependencies.queue.inspectSignalDelivery(
      operation.context.queueItemId,
      this.now(),
    );
    return state.isOk() && state.value.kind === 'checkpoint'
      ? counts(state.value.checkpoint)
      : operation.progress;
  }

  private stateFailure(
    error: SignalQueueFailure,
    progress: SignalSendProgress = zero,
  ): SignalDeliveryError {
    if (error instanceof SignalStateError) {
      if (error.reason === 'BUSY' || error.reason === 'BUDGET')
        return failure('ACCOUNT_BUSY', progress, true, error.nextAttemptAt);
      if (error.reason === 'PAUSED') {
        const latest = this.dependencies.accounts.findByAccount(this.accountUuid);
        if (latest.isErr()) return failure('STATE_WRITE_FAILED', progress);
        const state = latest.value;
        const reason =
          state?.pauseKind === 'challenge'
            ? 'CHALLENGE_REQUIRED'
            : state !== null && state.rateLimitNotBefore >= state.recoveryNotBefore
              ? 'RATE_LIMITED'
              : 'RECOVERY_PENDING';
        return failure(reason, progress, true, error.nextAttemptAt);
      }
    }
    return failure(
      error instanceof DeliveryCancelled
        ? 'CANCELLED'
        : error instanceof SignalStateError && error.reason === 'DATABASE'
          ? 'STATE_WRITE_FAILED'
          : 'CHECKPOINT_INVALID',
      progress,
      error instanceof SignalStateError && error.reason === 'DATABASE',
    );
  }

  private snapshot(
    operation: Operation,
    at = this.now(),
  ): Result<SignalDeliveryCheckpoint | null, SignalQueueFailure> {
    return this.dependencies.queue
      .inspectSignalDelivery(operation.context.queueItemId, at)
      .andThen((state) => {
        if (!operation.saved)
          return state.kind === 'checkpoint' ? err(new SignalStateError('CONFLICT')) : ok(null);
        if (state.kind !== 'checkpoint') return err(new SignalStateError('CONFLICT'));
        const checkpoint = state.checkpoint;
        if (
          checkpoint.deliveryId !== operation.context.deliveryId ||
          checkpoint.runId !== operation.context.runId ||
          checkpoint.kind !== operation.context.purpose ||
          checkpoint.accountUuid !== this.accountUuid ||
          checkpoint.destination !== operation.destination ||
          checkpoint.phase !== 'ready' ||
          checkpoint.chunks[checkpoint.nextChunk] !== operation.chunks[operation.index]
        )
          return err(new SignalStateError('CONFLICT'));
        return ok(checkpoint);
      });
  }

  private acquire(
    operation: Operation,
  ): Result<SignalDeliveryCheckpoint | null, SignalQueueFailure> {
    return this.atomic(() =>
      this.snapshot(operation).andThen((checkpoint) => {
        if (checkpoint !== null) operation.progress = counts(checkpoint);
        if (checkpoint === null) {
          const guarded = this.guardInvocation(operation);
          if (guarded.isErr()) return err(guarded.error);
        }
        return this.dependencies.leases
          .acquire(this.accountUuid, operation.destination, operation.context, this.now())
          .map((lease) => {
            operation.lease = lease;
            return checkpoint;
          });
      }),
    );
  }

  private guardInvocation(operation: Operation): Result<void, SignalQueueFailure> {
    return this.dependencies.queue
      .inspectSignalDelivery(operation.context.queueItemId, this.now())
      .andThen((current) => {
        if (current.kind === 'checkpoint') return err(new SignalStateError('CONFLICT'));
        return this.dependencies.queue
          .markSignalDeliveryStarted(
            { version: 1, ...operation.context, startedAt: this.now() },
            current.kind === 'invoked' ? current.marker : null,
            this.now(),
          )
          .map(() => undefined);
      });
  }

  private async run(
    operation: Operation,
  ): Promise<Result<SignalChunkReceipt, SignalDeliveryError>> {
    const acquired = this.acquire(operation);
    if (acquired.isErr()) {
      if (acquired.error instanceof DeliveryCancelled) operation.chunkAuthority = 'cancelled';
      return err(this.stateFailure(acquired.error, operation.progress));
    }
    if (acquired.value !== null && acquired.value.expiresAt <= this.now())
      return err(failure('CHECKPOINT_EXPIRED', operation.progress, false));
    const proof = this.proofFailure();
    if (proof !== undefined)
      return err(failure(proof.reason, operation.progress, proof.retryScope === 'delivery_only'));
    const selected = selectSignalTarget(
      operation.destination,
      this.dependencies.readiness().config,
    );
    if (selected.isErr()) return err(failure(selected.error.reason, operation.progress, false));
    const metadata = await this.request(createSignalTargetRequest(selected.value));
    if (metadata.isErr()) {
      const detectedAt = this.now();
      const restrictions =
        metadata.error instanceof SignalRpcRemoteError
          ? interpretSignalRestrictions(metadata.error, detectedAt)
          : [];
      const persisted = await this.retryWrite(operation, () =>
        this.atomic(() => this.recordRestrictions(restrictions, detectedAt)),
      );
      if (persisted.isErr()) {
        this.poison(persisted.error);
        return err(this.stateFailure(persisted.error, operation.progress));
      }
      // Restrictive evidence must commit even if current local authority became permanent.
      // An ordinary stop still defers the saved call rather than terminalizing it.
      if (this.stopped)
        return err(failure('UNAVAILABLE', operation.progress, true, persisted.value.notBefore));
      const refused = this.localFailure(operation);
      if (refused !== undefined) return err(refused);
      const reason = restrictions.some((pause) => pause.kind === 'challenge')
        ? 'CHALLENGE_REQUIRED'
        : restrictions.some((pause) => pause.kind === 'rate_limit')
          ? 'RATE_LIMITED'
          : 'TARGET_LOOKUP_FAILED';
      return err(failure(reason, operation.progress, true, persisted.value.notBefore));
    }
    if (metadata.value.kind !== 'result')
      return err(failure('TARGET_UNVERIFIABLE', operation.progress, false));
    const valid = validateSignalTargetMetadata(selected.value, metadata.value.value);
    if (valid.isErr()) return err(failure(valid.error.reason, operation.progress, false));
    // A publication/config/row can change during the read. No await between this check,
    // latest-row/full-owner CAS and calling the actual allowlisted transport.
    const latestProof = this.proofFailure();
    if (this.stopped) return err(failure('UNAVAILABLE', operation.progress));
    if (operation.expiresAt !== undefined && this.now() >= operation.expiresAt)
      return err(failure('CHECKPOINT_EXPIRED', operation.progress, false));
    if (latestProof !== undefined)
      return err(
        failure(latestProof.reason, operation.progress, latestProof.retryScope === 'delivery_only'),
      );
    const latestSelection = selectSignalTarget(
      operation.destination,
      this.dependencies.readiness().config,
    );
    if (latestSelection.isErr())
      return err(failure(latestSelection.error.reason, operation.progress, false));
    const reserved = this.atomic(() =>
      this.snapshot(operation).andThen((checkpoint) => {
        if (operation.lease === undefined) return err(new SignalStateError('CONFLICT'));
        const validLease = this.dependencies.leases.validateOwner(operation.lease);
        if (validLease.isErr()) return err(validLease.error);
        if (checkpoint === null) {
          const guarded = this.guardInvocation(operation);
          if (guarded.isErr()) return err(guarded.error);
        }
        return this.dependencies.accounts
          .getOrCreate(this.accountUuid, this.now())
          .andThen(
            (account): Result<SignalChunkOwnership | SignalAccountState, SignalQueueFailure> =>
              checkpoint === null
                ? this.dependencies.accounts.reserveSend(
                    this.accountUuid,
                    account.revision,
                    operation.context,
                    this.now(),
                  )
                : this.dependencies.queue.beginSignalChunk(
                    checkpoint,
                    account.revision,
                    this.now(),
                  ),
          );
      }),
    );
    if (reserved.isErr()) {
      if (reserved.error instanceof DeliveryCancelled) operation.chunkAuthority = 'cancelled';
      return err(this.stateFailure(reserved.error, operation.progress));
    }
    operation.chunkAuthority = 'reserved';
    const ownership = 'checkpoint' in reserved.value ? reserved.value : undefined;
    const reservation =
      ownership?.reservation ??
      ('reservation' in reserved.value ? reserved.value.reservation : null);
    if (reservation === null || reservation === undefined) {
      const conflict = new SignalStateError('CONFLICT');
      this.poison(conflict);
      return err(this.stateFailure(conflict, operation.progress));
    }
    const rpcResult = await this.request(
      this.sendRequest(latestSelection.value, operation.chunks[operation.index]),
    );
    const detectedAt = this.now();
    const classified = classifySignalSendResult(rpcResult, operation.progress, detectedAt);
    const settled = await this.retryWrite(operation, () => {
      const result = this.settle(operation, reservation, ownership, classified, detectedAt);
      if (result.isOk()) operation.chunkAuthority = 'settled';
      else if (result.error instanceof DeliveryCancelled) operation.chunkAuthority = 'cancelled';
      return result;
    });
    if (settled.isErr()) {
      if (settled.error instanceof DeliveryCancelled) operation.chunkAuthority = 'cancelled';
      else this.poison(settled.error);
      return err(
        observedFailure(
          settled.error instanceof DeliveryCancelled ? 'CANCELLED' : 'STATE_WRITE_FAILED',
          classified,
          operation.progress,
        ),
      );
    }
    operation.chunkAuthority = 'settled';
    return classified.result;
  }

  private settle(
    operation: Operation,
    owner: SignalSendReservation,
    ownership: SignalChunkOwnership | undefined,
    classified: SignalSendClassification,
    detectedAt: number,
  ): Result<void, SignalQueueFailure> {
    return this.atomic(() => {
      const current = this.dependencies.accounts.findByAccount(this.accountUuid);
      if (current.isErr()) return err(current.error);
      if (current.value === null || !isDeepStrictEqual(current.value.reservation, owner))
        return err(new SignalStateError('CONFLICT'));
      // Saved UNKNOWN settlement already records recovery. Do not apply it twice.
      const pauses =
        ownership === undefined
          ? classified.restrictions
          : classified.restrictions.filter((pause) => pause.kind !== 'recovery');
      const paused = this.recordRestrictions(pauses, detectedAt);
      if (paused.isErr()) return err(paused.error);
      if (ownership !== undefined) {
        const result = classified.result;
        const settled = this.dependencies.queue.settleSignalChunk(
          ownership,
          result.isOk()
            ? { kind: 'accepted', successCount: result.value.successCount }
            : {
                kind: result.error.retryScope === 'delivery_only' ? 'deferred' : 'terminal',
                failure: result.error,
              },
          detectedAt,
        );
        // This Err deliberately follows committed account cleanup inside TASK006. Carry it
        // as a VALUE through the outer transaction; all other errors still roll back.
        if (settled.isErr() && !(settled.error instanceof DeliveryCancelled))
          return err(settled.error);
        return ok(settled.isErr() ? settled.error : undefined);
      }
      const cleared = this.dependencies.accounts.clearReservation(
        this.accountUuid,
        paused.value.revision,
        owner,
        detectedAt,
      );
      if (cleared.isErr()) return err(cleared.error);
      const row = this.dependencies.queue.findById(operation.context.queueItemId);
      if (row.isErr()) return err(new SignalStateError('DATABASE'));
      return ok(row.value === null ? new DeliveryCancelled() : undefined);
    }).andThen((cancelled) => (cancelled === undefined ? ok(undefined) : err(cancelled)));
  }

  private recordRestrictions(
    pauses: readonly SignalPause[],
    detectedAt: number,
  ): Result<SignalAccountState, SignalQueueFailure> {
    let result = this.dependencies.accounts.getOrCreate(this.accountUuid, detectedAt);
    for (const pause of pauses)
      result = result.andThen((account) =>
        this.dependencies.accounts.recordPause(
          this.accountUuid,
          account.revision,
          pause,
          detectedAt,
        ),
      );
    return result;
  }

  private async finish(
    operation: Operation,
    result: Result<SignalChunkReceipt, SignalDeliveryError>,
  ): Promise<void> {
    let final = result;
    if (
      result.isErr() &&
      (operation.chunkAuthority === 'preflight' ||
        (operation.chunkAuthority === 'settled' && result.error.retryScope === 'delivery_only')) &&
      result.error.reason !== 'STATE_WRITE_FAILED' &&
      ['unwritten', 'refused'].includes(result.error.currentChunkAcceptance)
    ) {
      // Physical presence is independent of the epoch-sensitive checkpoint codec.
      // Keep only the boolean, not an uncharged full row/body over write backoff.
      const present = this.dependencies.queue
        .findById(operation.context.queueItemId)
        .map((row) => row !== null);
      if (present.isErr()) {
        const error = new SignalStateError('DATABASE');
        const observed = result.error;
        const detectedAt = this.now();
        this.retainWrite(
          operation,
          () => this.resolveFinalAuthority(operation, observed, detectedAt),
          error,
        );
        this.poison(error);
        final = err(new SignalDeliveryError({ ...observed, reason: 'STATE_WRITE_FAILED' }));
      } else if (!present.value) {
        operation.chunkAuthority = 'cancelled';
        final = err(
          new SignalDeliveryError({ ...result.error, reason: 'CANCELLED', retryScope: 'none' }),
        );
      } else if (
        operation.saved &&
        operation.chunkAuthority === 'preflight' &&
        result.error.retryScope === 'none' &&
        result.error.currentChunkAcceptance === 'unwritten'
      ) {
        const detectedAt = this.now();
        const terminated = await this.retryWrite(
          operation,
          () => {
            const snapshot = this.snapshot(operation, detectedAt);
            if (snapshot.isErr()) return err(snapshot.error);
            return snapshot.value === null
              ? ok(undefined)
              : this.dependencies.queue
                  .terminateSignalDelivery(snapshot.value, result.error, detectedAt)
                  .map(() => undefined);
          },
          false,
        );
        if (terminated.isErr()) {
          if (terminated.error instanceof DeliveryCancelled) {
            operation.chunkAuthority = 'cancelled';
            final = err(
              new SignalDeliveryError({ ...result.error, reason: 'CANCELLED', retryScope: 'none' }),
            );
          } else {
            // Unwritten conflicts are local; unresolved DATABASE authority still suspends.
            if (
              terminated.error instanceof SignalStateError &&
              terminated.error.reason === 'DATABASE'
            )
              this.poison(terminated.error);
            final = err(this.stateFailure(terminated.error, operation.progress));
          }
        }
      }
    }
    const ownedLease = operation.lease;
    // Confirmed queue cancellation already cascaded this invocation's lease. A foreign
    // owner may now hold that key; never release it or treat its presence as failed cleanup.
    if (!operation.saved && ownedLease !== undefined && operation.chunkAuthority !== 'cancelled') {
      const release = (): Result<void, SignalQueueFailure> =>
        operation.chunkAuthority === 'cancelled'
          ? ok(undefined)
          : this.atomic(() =>
              this.dependencies.leases
                .find(this.accountUuid, operation.destination)
                .andThen((lease) =>
                  lease === null ? ok(undefined) : this.dependencies.leases.release(ownedLease),
                ),
            );
      // Cleanup must not overtake an unresolved classification/presence decision.
      const released = this.retained.has(operation)
        ? (this.retainWrite(operation, release), ok(undefined))
        : await this.retryWrite(operation, release);
      if (released.isErr()) {
        this.poison(released.error);
        final = final.isErr()
          ? final
          : err(
              new SignalDeliveryError({
                reason: 'STATE_WRITE_FAILED',
                ...operation.progress,
                successCount: operation.progress.successCount + final.value.successCount,
                outcome: 'PARTIAL',
                currentChunkAcceptance: 'complete',
                retryScope: 'none',
              }),
            );
      }
    }
    this.operations.delete(key(operation.context));
    operation.resolve(final);
    if (this.retained.has(operation)) this.publishHealth();
  }

  private resolveFinalAuthority(
    operation: Operation,
    observed: SignalDeliveryError,
    detectedAt: number,
  ): Result<void, SignalQueueFailure> {
    const present = this.dependencies.queue
      .findById(operation.context.queueItemId)
      .map((row) => row !== null);
    if (present.isErr()) return err(new SignalStateError('DATABASE'));
    if (!present.value) {
      operation.chunkAuthority = 'cancelled';
      return ok(undefined);
    }
    if (
      operation.saved &&
      operation.chunkAuthority === 'preflight' &&
      observed.retryScope === 'none' &&
      observed.currentChunkAcceptance === 'unwritten'
    )
      return this.snapshot(operation, detectedAt).andThen((snapshot) =>
        snapshot === null
          ? ok(undefined)
          : this.dependencies.queue
              .terminateSignalDelivery(snapshot, observed, detectedAt)
              .map(() => undefined),
      );
    return ok(undefined);
  }

  private retainWrite(
    operation: Operation,
    write: RetainedWrite['write'],
    error?: SignalQueueFailure,
  ): void {
    const jobs = this.retained.get(operation) ?? [];
    jobs.push({
      write,
      error,
      retryAt: this.monotonicNow() + (error === undefined ? 0 : 250),
      attempts: 0,
    });
    this.retained.set(operation, jobs);
    if (this.active?.operation === operation) this.retainedActive = operation;
  }

  private atomic<T>(operation: () => Result<T, SignalQueueFailure>): Result<T, SignalQueueFailure> {
    try {
      return runResultTransaction((fn) => this.dependencies.accounts.transaction(fn), operation);
    } catch {
      return err(new SignalStateError('DATABASE'));
    }
  }

  private async retryWrite<T>(
    operation: Operation,
    write: () => Result<T, SignalQueueFailure>,
    retainConflict = true,
  ): Promise<Result<T, SignalQueueFailure>> {
    for (let attempt = 0; ; attempt++) {
      const result = write();
      if (
        result.isOk() ||
        !(result.error instanceof SignalStateError) ||
        result.error.reason !== 'DATABASE' ||
        attempt >= 5 ||
        this.monotonicNow() >= this.drainDeadline
      ) {
        if (
          result.isErr() &&
          !(result.error instanceof DeliveryCancelled) &&
          (retainConflict || databaseFailure(result.error))
        ) {
          this.retainWrite(operation, write, result.error);
          this.poison(result.error);
        }
        return result;
      }
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            250 * 2 ** attempt,
            2_000,
            Math.max(0, this.drainDeadline - this.monotonicNow()),
          ),
        ),
      );
    }
  }

  private poison(error: SignalQueueFailure): void {
    if (this.persistenceFailure === undefined) this.fatalFailure = error;
    this.quiesce();
  }

  private async request(request: SignalRpcRequest): Promise<SignalRpcResult> {
    const controller = new AbortController();
    const active = this.active;
    const timeout = this.dependencies.readiness().config.requestTimeoutMs;
    let force = (): void => {};
    const forced = new Promise<SignalRpcResult>((resolve) => {
      force = (): void => {
        controller.abort();
        resolve(err(new SignalRpcTransportError('TIMEOUT', request.method === 'send')));
      };
    });
    if (active !== undefined) {
      active.requestDeadline = this.monotonicNow() + timeout;
      active.forceRequest = force;
    }
    const timer = setTimeout(force, timeout);
    let result: SignalRpcResult;
    try {
      result = await Promise.race([
        this.dependencies.rpc.request(request, { signal: controller.signal }),
        forced,
      ]);
    } catch {
      result = err(new SignalRpcTransportError('DISCONNECTED', request.method === 'send'));
    }
    clearTimeout(timer);
    if (active !== undefined) {
      active.forceRequest = undefined;
      active.requestDeadline = undefined;
    }
    return result;
  }

  private sendRequest(
    destination: SignalDestination,
    message: string,
  ): Extract<SignalRpcRequest, { method: 'send' }> {
    const account = destination.accountUuid;
    return destination.kind === 'group'
      ? { method: 'send', params: { account, groupId: destination.groupId, message } }
      : destination.kind === 'dm'
        ? { method: 'send', params: { account, recipient: [destination.peerUuid], message } }
        : { method: 'send', params: { account, noteToSelf: true, message } };
  }
}
