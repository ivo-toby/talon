import { performance } from 'node:perf_hooks';
import { ChannelError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import { runResultTransaction } from '../../../core/database/transaction.js';
import {
  SignalStateError,
  type SignalAccountState,
  type SignalAccountStateRepository,
  type SignalPause,
} from '../../../core/database/repositories/signal-account-state-repository.js';
import type { SignalConfig } from './signal-config.js';
import {
  SignalDeviceError,
  SignalDeviceRegistry,
  verifySignalDevices,
} from './signal-device-registry.js';
import {
  type SignalRpcClient,
  type SignalRpcReply,
  SignalRpcTransportError,
} from './signal-rpc-client.js';
import { SignalRpcRemoteError } from './signal-wire.js';
import { interpretSignalRestrictions } from './signal-send-result.js';
import type { SignalAccountProofSnapshot } from './signal-types.js';

export type SignalVerificationReason =
  | 'VERIFICATION_PENDING'
  | 'VERIFICATION_STALE'
  | 'DEVICE_METADATA_INVALID'
  | 'UNSUPPORTED_BRIDGE_MODE'
  | 'STATE_WRITE_FAILED'
  | 'PAUSED'
  | 'STOPPED';

export class SignalVerificationError extends ChannelError {
  constructor(
    readonly reason:
      | 'OWNER_BUSY'
      | 'STALE_CONNECTION'
      | 'EXTERNAL_RESOLUTION_REQUIRED'
      | 'INVALID_CLOCK'
      | 'VERIFICATION_PENDING'
      | 'VERIFICATION_STALE'
      | 'STOPPED',
  ) {
    super(`Signal verification failed: ${reason}`);
  }
}

export type SignalVerificationFailure =
  | SignalVerificationError
  | SignalStateError
  | SignalDeviceError
  | SignalRpcRemoteError
  | SignalRpcTransportError;

/** Safe local status, not send authority. Proof is read separately from the shared registry. */
export interface SignalVerificationStatus {
  readonly state: 'pending' | 'verified' | 'stale' | 'needs_setup' | 'suspended' | 'stopped';
  readonly reason?: SignalVerificationReason;
  readonly checking: boolean;
  readonly nextCheckAt?: number;
}

export interface SignalAccountVerifierDependencies {
  readonly config: SignalConfig;
  readonly registry: SignalDeviceRegistry;
  /** The SAME repository object/SQLite connection must be shared by all account owners and sender. */
  readonly accounts: SignalAccountStateRepository;
  /** Synchronous, nonthrowing publication hook; revalidate buffers and wake the sender, never do IO. */
  readonly onChange?: (status: SignalVerificationStatus) => void;
  readonly now?: () => number;
  /** Independent nondecreasing elapsed clock, consistent with native timers. Never persisted. */
  readonly monotonicNow?: () => number;
}

interface Connection {
  readonly generation: number;
  readonly rpc: Pick<SignalRpcClient, 'request'>;
}
interface Active {
  readonly connection: Connection;
  readonly controller: AbortController;
  readonly promise: Promise<Result<SignalVerificationStatus, SignalVerificationFailure>>;
}
interface ResumeIntent {
  readonly connection: Connection;
  readonly revision: number;
}
interface Settlement {
  readonly connection: Connection;
  readonly result: Result<SignalAccountProofSnapshot, SignalVerificationFailure>;
  readonly restrictions: readonly SignalPause[];
  readonly observedAt: number;
  readonly observedElapsed: number;
  readonly resumeRevision?: number;
}

const owners = new WeakMap<SignalAccountStateRepository, Map<string, SignalAccountVerifier>>();
const registryOwners = new WeakMap<SignalDeviceRegistry, Map<string, SignalAccountVerifier>>();

/** One metadata scheduler, NOT a connector state machine or a send/recovery actor.
 * Construction requires trusted validated config/registry; connect requires B's exact-version,
 * selected-ACI and socket handshake. No boolean substitutes for that handshake or for the
 * sender's immutable proof checks. */
export class SignalAccountVerifier {
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private connection?: Connection;
  private highestConnection = -1;
  private active?: Active;
  private settlement?: Settlement;
  private timer?: ReturnType<typeof setTimeout>;
  private nextCheckAt = 0;
  private retryAt = 0;
  private retryDelay = 250;
  private proofElapsedExpiry = Infinity;
  private databaseFailure?: SignalStateError;
  private clockFailure?: SignalVerificationError;
  private setupReason?: 'DEVICE_METADATA_INVALID' | 'UNSUPPORTED_BRIDGE_MODE';
  private setupFailure?: SignalDeviceError | SignalRpcRemoteError;
  private paused = false;
  private resumeIntent?: ResumeIntent;
  private stopped = false;
  private lastStatus?: SignalVerificationStatus;

  private constructor(private readonly dependencies: SignalAccountVerifierDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.monotonicNow = dependencies.monotonicNow ?? ((): number => performance.now());
  }

  static create(
    dependencies: SignalAccountVerifierDependencies,
  ): Result<SignalAccountVerifier, SignalVerificationFailure> {
    const { accounts, registry, config } = dependencies;
    if (
      owners.get(accounts)?.has(config.accountUuid) ||
      registryOwners.get(registry)?.has(config.accountUuid)
    )
      return err(new SignalVerificationError('OWNER_BUSY'));
    const slot = registry.snapshot().find((proof) => proof.accountUuid === config.accountUuid);
    if (
      !slot ||
      slot.generation !== registry.generation ||
      slot.accountMode !== config.accountMode ||
      slot.bridgeDeviceId !== config.deviceId
    )
      return err(new SignalDeviceError('STALE_GENERATION'));
    const verifier = new SignalAccountVerifier(dependencies);
    const accountOwners = new Map(owners.get(accounts));
    accountOwners.set(config.accountUuid, verifier);
    owners.set(accounts, accountOwners);
    const generationOwners = new Map(registryOwners.get(registry));
    generationOwners.set(config.accountUuid, verifier);
    registryOwners.set(registry, generationOwners);
    // A replacement/restart never inherits a proof, even if its epoch TTL has not elapsed.
    registry.invalidate(config.accountUuid);
    return ok(verifier);
  }

  /** Call only AFTER this socket's exact-version/account/alias handshake. IDs strictly increase.
   * The actual RPC dependency must settle within its configured request timeout and honor abort.
   * Repeated calls for the same connection do not reset proof or the persisted budget. */
  connect(
    connectionGeneration: number,
    rpc: Pick<SignalRpcClient, 'request'>,
  ): Promise<Result<SignalVerificationStatus, SignalVerificationFailure>> {
    if (this.stopped) return Promise.resolve(err(new SignalVerificationError('STOPPED')));
    if (
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration < 0 ||
      connectionGeneration < this.highestConnection ||
      (connectionGeneration === this.highestConnection && this.connection?.rpc !== rpc)
    )
      return Promise.resolve(err(new SignalVerificationError('STALE_CONNECTION')));
    if (this.connection?.generation !== connectionGeneration) {
      this.invalidatePublication();
      this.active?.controller.abort();
      this.connection = Object.freeze({ generation: connectionGeneration, rpc });
      this.highestConnection = connectionGeneration;
      this.resumeIntent = undefined;
    }
    return this.requestRefresh();
  }

  /** Disconnect only the matching socket; old close callbacks cannot invalidate a replacement. */
  invalidateConnection(connectionGeneration: number): void {
    if (this.connection?.generation !== connectionGeneration) return;
    this.connection = undefined;
    this.resumeIntent = undefined;
    this.invalidatePublication();
    this.active?.controller.abort();
    this.publishStatus();
    this.schedule();
  }

  /** Shared-owner advisory endpoint. Other receivers route registry.requestRefresh(ACI, now,
   * ownerByAci) here; never construct another verifier or call listDevices in a send path. */
  requestRefresh(): Promise<Result<SignalVerificationStatus, SignalVerificationFailure>> {
    if (this.stopped) return Promise.resolve(err(new SignalVerificationError('STOPPED')));
    if (this.active)
      return this.active.connection === this.connection
        ? this.active.promise
        : Promise.resolve(ok(this.status()));
    if (this.databaseFailure && this.monotonicNow() < this.retryAt)
      return Promise.resolve(err(this.databaseFailure));
    const pending = this.retryStateWrites();
    if (pending.isErr()) return Promise.resolve(pending);
    if (this.setupFailure) return Promise.resolve(err(this.setupFailure));
    const connection = this.connection;
    if (!connection) return Promise.resolve(err(new SignalVerificationError('STALE_CONNECTION')));
    const resumeIntent = this.resumeIntent;
    if (resumeIntent && resumeIntent.connection !== connection) {
      this.resumeIntent = undefined;
      return Promise.resolve(err(new SignalVerificationError('STALE_CONNECTION')));
    }
    const time = this.now();
    if (!this.validClock(time)) {
      this.clockFailure = new SignalVerificationError('INVALID_CLOCK');
      this.publishStatus();
      this.schedule();
      return Promise.resolve(err(this.clockFailure));
    }
    this.clockFailure = undefined;
    const state = this.dependencies.accounts.getOrCreate(
      this.dependencies.config.accountUuid,
      time,
    );
    const started = state.andThen((current) =>
      resumeIntent
        ? this.dependencies.accounts.startChallengeResumeDeviceCheck(
            current.accountUuid,
            resumeIntent.revision,
            time,
          )
        : this.dependencies.accounts.startDeviceCheck(current.accountUuid, current.revision, time),
    );
    if (started.isErr()) {
      const failure = started.error;
      this.paused = failure.reason === 'PAUSED';
      if (failure.nextAttemptAt !== undefined) this.nextCheckAt = failure.nextAttemptAt;
      else this.nextCheckAt = time + 60_000;
      if (failure.reason === 'DATABASE' || failure.reason === 'CONFLICT') this.deferWrite(failure);
      else {
        this.databaseFailure = undefined;
        this.retryAt = 0;
        this.retryDelay = 250;
      }
      if (failure.reason !== 'BUDGET' && failure.reason !== 'DATABASE')
        this.resumeIntent = undefined;
      this.publishStatus();
      this.schedule();
      return Promise.resolve(err(failure));
    }
    this.databaseFailure = undefined;
    this.retryDelay = 250;
    this.retryAt = 0;
    this.paused = false;
    this.nextCheckAt = time + 60_000;
    const resumeRevision = resumeIntent ? started.value.revision : undefined;
    this.resumeIntent = undefined;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.check(connection, controller, resumeRevision))
      .finally(() => {
        if (this.active?.promise === promise) this.active = undefined;
        this.publishStatus();
        this.schedule();
        this.releaseStoppedOwner();
      });
    this.active = { connection, controller, promise };
    this.publishStatus();
    this.schedule();
    return promise;
  }

  /** Authenticated B/CLI ONLY, with an explicit external-resolution assertion. B must reject
   * every other connector NeedsSetup reason BEFORE calling. This is one check, not a bypass:
   * budget/DB-start waits retain only this connection's captured challenged revision.
   * A changed revision, failed authority capture or rate/recovery refusal consumes intent. */
  resumeChallenge(assertion: {
    readonly externalChallengeResolved: true;
  }): Promise<Result<SignalVerificationStatus, SignalVerificationFailure>> {
    if (assertion?.externalChallengeResolved !== true)
      return Promise.resolve(err(new SignalVerificationError('EXTERNAL_RESOLUTION_REQUIRED')));
    if (this.stopped) return Promise.resolve(err(new SignalVerificationError('STOPPED')));
    if (this.setupFailure) return Promise.resolve(err(this.setupFailure));
    if (!this.connection)
      return Promise.resolve(err(new SignalVerificationError('STALE_CONNECTION')));
    if (this.active || this.settlement) return Promise.resolve(err(new SignalStateError('BUSY')));
    // Capture before accepting intent, not later when a server budget slot opens. A fresh
    // assertion replaces the old one; a failed read cannot leave latent privileged authority.
    this.resumeIntent = undefined;
    const state = this.dependencies.accounts.findByAccount(this.dependencies.config.accountUuid);
    if (state.isErr()) {
      if (state.error.reason === 'DATABASE') this.deferWrite(state.error);
      this.publishStatus();
      this.schedule();
      return Promise.resolve(err(state.error));
    }
    if (!state.value) return Promise.resolve(err(new SignalStateError('NOT_FOUND')));
    if (state.value.pauseKind !== 'challenge')
      return Promise.resolve(err(new SignalStateError('CONFLICT')));
    this.resumeIntent = Object.freeze({
      connection: this.connection,
      revision: state.value.revision,
    });
    return this.requestRefresh();
  }

  /** Retry retained sanitized settlement ONLY, never reissue its RPC. Usable after stop when
   * stop returned Err; caller must retain this owner and withhold replacement until Ok. */
  retryStateWrites(): Result<SignalVerificationStatus, SignalVerificationFailure> {
    const pending = this.settlement;
    if (pending) {
      if (this.databaseFailure && this.monotonicNow() < this.retryAt)
        return err(this.databaseFailure);
      const settled = this.finishSettlement(pending);
      this.publishStatus();
      this.schedule();
      this.releaseStoppedOwner();
      return settled;
    }
    return ok(this.status());
  }

  status(): SignalVerificationStatus {
    const published = this.proof();
    // An epoch rewind or elapsed TTL must not revive provenance in other registry consumers.
    // Keep the known human roster for eligible proof quarantine, but expire it irreversibly.
    if (
      !this.stopped &&
      this.connection &&
      published?.status === 'verified' &&
      published.expiresAt !== 0 &&
      (this.now() < published.verifiedAt || this.monotonicNow() >= this.proofElapsedExpiry)
    )
      this.dependencies.registry.publish(Object.freeze({ ...published, expiresAt: 0 }));
    let state: SignalVerificationStatus['state'];
    let reason: SignalVerificationReason | undefined;
    if (this.stopped) {
      state = 'stopped';
      reason = 'STOPPED';
    } else if (this.setupReason) {
      state = 'needs_setup';
      reason = this.setupReason;
    } else if (this.databaseFailure || this.clockFailure) {
      state = 'suspended';
      reason = 'STATE_WRITE_FAILED';
    } else {
      const proof = this.proof();
      if (!this.connection || proof?.status !== 'verified') {
        state = 'pending';
        reason = 'VERIFICATION_PENDING';
      } else if (
        this.now() < proof.verifiedAt ||
        this.now() >= proof.expiresAt ||
        this.monotonicNow() >= this.proofElapsedExpiry
      ) {
        state = 'stale';
        reason = 'VERIFICATION_STALE';
      } else {
        state = 'verified';
        reason = this.paused ? 'PAUSED' : undefined;
      }
    }
    return Object.freeze({
      state,
      reason,
      checking: this.active !== undefined,
      nextCheckAt: this.connection ? this.nextCheckAt : undefined,
    });
  }

  /** Immediate irreversible invalidation/cancel, then await ONLY the bounded metadata request.
   * Never closes transport, clears send reservations or runs queue recovery. Err retains owner
   * for retryStateWrites; no timers/RPC/publication/clearChallenge can revive a stopped verifier. */
  async stop(): Promise<Result<void, SignalVerificationFailure>> {
    if (!this.stopped) {
      this.stopped = true;
      this.connection = undefined;
      this.resumeIntent = undefined;
      this.cancelTimer();
      if (!this.settlement) this.databaseFailure = undefined;
      this.invalidatePublication();
      this.active?.controller.abort();
      this.publishStatus();
    }
    await this.active?.promise;
    this.releaseStoppedOwner();
    return this.settlement || this.databaseFailure
      ? err(this.databaseFailure ?? new SignalStateError('DATABASE'))
      : ok(undefined);
  }

  private async check(
    connection: Connection,
    controller: AbortController,
    resumeRevision?: number,
  ): Promise<Result<SignalVerificationStatus, SignalVerificationFailure>> {
    if (!this.isCurrent(connection)) return err(new SignalVerificationError('STALE_CONNECTION'));
    let response: Result<SignalRpcReply, SignalVerificationFailure>;
    try {
      // Pinned v0.14.9 ListDevicesCommand.java:40-67 and CommandHandler.java:68-139.
      response = await connection.rpc.request(
        { method: 'listDevices', params: { account: this.dependencies.config.accountUuid } },
        { signal: controller.signal },
      );
    } catch {
      // The actual transport returns Result; a broken injected adapter grants no proof/cause.
      response = err(new SignalVerificationError('VERIFICATION_PENDING'));
    }
    const observedAt = this.now();
    const restrictions =
      response.isErr() && response.error instanceof SignalRpcRemoteError
        ? interpretSignalRestrictions(response.error, observedAt)
        : Object.freeze([]);
    const result: Result<SignalAccountProofSnapshot, SignalVerificationFailure> = response.isErr()
      ? err(response.error)
      : response.value.kind !== 'result'
        ? err(new SignalDeviceError('DEVICE_METADATA_INVALID'))
        : verifySignalDevices(
            this.dependencies.config,
            response.value.value,
            this.dependencies.registry.generation,
            observedAt,
          );
    const settlement: Settlement = {
      connection,
      result,
      restrictions,
      observedAt,
      observedElapsed: this.monotonicNow(),
      resumeRevision,
    };
    this.settlement = settlement;
    return this.finishSettlement(settlement);
  }

  private finishSettlement(
    pending: Settlement,
  ): Result<SignalVerificationStatus, SignalVerificationFailure> {
    const { accounts, config } = this.dependencies;
    const time = this.now();
    if (pending.restrictions.length > 0) {
      let written: Result<SignalAccountState, SignalStateError>;
      try {
        written = runResultTransaction(
          (fn) => accounts.transaction(fn),
          () => {
            let state = accounts.getOrCreate(config.accountUuid, pending.observedAt);
            for (const hint of pending.restrictions)
              state = state.andThen((current) =>
                accounts.recordPause(
                  config.accountUuid,
                  current.revision,
                  hint,
                  pending.observedAt,
                ),
              );
            return state;
          },
        );
      } catch {
        // Transaction entry/commit can throw before a repository can return its typed Err.
        written = err(new SignalStateError('DATABASE'));
      }
      if (written.isErr()) {
        this.deferWrite(written.error);
        this.publishStatus();
        this.schedule();
        return err(written.error);
      }
      this.paused = written.value.pauseKind === 'challenge' || time < written.value.notBefore;
      this.nextCheckAt = Math.max(this.nextCheckAt, written.value.notBefore);
    }
    if (
      pending.resumeRevision !== undefined &&
      pending.result.isOk() &&
      this.isCurrent(pending.connection)
    ) {
      const proof = pending.result.value;
      if (
        proof.status !== 'verified' ||
        time < proof.verifiedAt ||
        time >= proof.expiresAt ||
        this.monotonicNow() >= pending.observedElapsed + 300_000
      ) {
        // A delayed DB repair must not turn an expired check into a privileged clear.
        this.settlement = undefined;
        this.databaseFailure = undefined;
        this.retryAt = 0;
        this.publishStatus();
        return err(new SignalVerificationError('VERIFICATION_STALE'));
      }
      // NEVER reread a newer revision to clear using an older successful check.
      const cleared = accounts.clearChallenge(config.accountUuid, pending.resumeRevision, time);
      if (cleared.isErr()) {
        if (cleared.error.reason === 'DATABASE') {
          this.deferWrite(cleared.error);
          this.publishStatus();
          this.schedule();
          return err(cleared.error);
        }
        this.settlement = undefined;
        this.databaseFailure = undefined;
        this.publishStatus();
        return err(cleared.error);
      }
      this.paused = time < cleared.value.notBefore;
    }
    this.settlement = undefined;
    this.databaseFailure = undefined;
    this.retryAt = 0;
    this.retryDelay = 250;
    if (!this.isCurrent(pending.connection))
      return err(new SignalVerificationError('STALE_CONNECTION'));
    if (pending.result.isErr()) {
      if (pending.result.error instanceof SignalDeviceError) {
        this.setupReason = 'DEVICE_METADATA_INVALID';
        this.setupFailure = pending.result.error;
        this.invalidatePublication();
      } else if (
        pending.result.error instanceof SignalRpcRemoteError &&
        pending.result.error.remoteCode === 'METHOD_NOT_FOUND'
      ) {
        this.setupReason = 'UNSUPPORTED_BRIDGE_MODE';
        this.setupFailure = pending.result.error;
        this.invalidatePublication();
      }
      this.publishStatus();
      return err(pending.result.error);
    }
    if (!this.validClock(time) || !this.validClock(pending.observedAt)) {
      this.clockFailure = new SignalVerificationError('INVALID_CLOCK');
      this.publishStatus();
      return err(this.clockFailure);
    }
    const published = this.dependencies.registry.publish(pending.result.value);
    if (published.isErr()) return err(published.error);
    this.proofElapsedExpiry = pending.observedElapsed + 300_000;
    this.publishStatus();
    return ok(this.status());
  }

  private proof(): SignalAccountProofSnapshot | undefined {
    return this.dependencies.registry
      .snapshot()
      .find((proof) => proof.accountUuid === this.dependencies.config.accountUuid);
  }

  private validClock(time: number): boolean {
    return (
      Number.isSafeInteger(time) &&
      time >= 0 &&
      Number.isSafeInteger(time + 300_000) &&
      Number.isFinite(this.monotonicNow()) &&
      this.monotonicNow() >= 0
    );
  }

  private isCurrent(connection: Connection): boolean {
    return !this.stopped && this.connection === connection;
  }

  private invalidatePublication(): void {
    this.dependencies.registry.invalidate(this.dependencies.config.accountUuid);
    this.proofElapsedExpiry = Infinity;
  }

  private deferWrite(failure: SignalStateError): void {
    this.databaseFailure = failure;
    this.retryAt = this.monotonicNow() + this.retryDelay;
    this.retryDelay = Math.min(10_000, this.retryDelay * 2);
  }

  private publishStatus(): void {
    const status = this.status();
    if (JSON.stringify(status) === JSON.stringify(this.lastStatus)) return;
    this.lastStatus = status;
    this.dependencies.onChange?.(status);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.cancelTimer();
    if (this.stopped || (this.setupReason && !this.settlement && !this.databaseFailure)) return;
    const elapsed = this.monotonicNow();
    let delay = 60_000;
    if (this.databaseFailure) delay = Math.max(1, this.retryAt - elapsed);
    else if (this.connection && !this.setupReason && !this.clockFailure && !this.active)
      delay = Math.max(1, this.nextCheckAt - this.now());
    const proof = this.proof();
    if (proof?.status === 'verified' && this.status().state === 'verified')
      delay = Math.min(delay, proof.expiresAt - this.now(), this.proofElapsedExpiry - elapsed);
    if (!this.connection && !this.settlement && !this.databaseFailure) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.publishStatus();
        if (this.databaseFailure && this.monotonicNow() < this.retryAt) {
          this.schedule();
          return;
        }
        if (this.settlement) {
          this.retryStateWrites();
          this.schedule();
          return;
        }
        if (
          this.connection &&
          !this.active &&
          !this.setupReason &&
          (this.databaseFailure || this.now() >= this.nextCheckAt)
        )
          void this.requestRefresh();
        else this.schedule();
      },
      Math.max(1, Math.min(60_000, Number.isFinite(delay) ? delay : 60_000)),
    );
  }

  private releaseStoppedOwner(): void {
    if (!this.stopped || this.active || this.settlement) return;
    const { accounts, registry, config } = this.dependencies;
    if (owners.get(accounts)?.get(config.accountUuid) === this)
      owners.get(accounts)?.delete(config.accountUuid);
    if (registryOwners.get(registry)?.get(config.accountUuid) === this)
      registryOwners.get(registry)?.delete(config.accountUuid);
  }
}
