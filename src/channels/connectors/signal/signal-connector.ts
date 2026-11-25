import { performance } from 'node:perf_hooks';
import type pino from 'pino';
import type {
  AgentOutput,
  InboundEvent,
  InboundReceiptHandler,
  TrustedDeliveryContext,
} from '../../channel-types.js';
import { stripMarkdown } from '../../format/markdown-converter.js';
import {
  ChannelError,
  PipelineError,
  SignalDeliveryError,
} from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import type { SignalAccountStateRepository } from '../../../core/database/repositories/signal-account-state-repository.js';
import type { SignalDestinationLeaseRepository } from '../../../core/database/repositories/signal-destination-lease-repository.js';
import type { QueueRepository } from '../../../core/database/repositories/queue-repository.js';
import type { SignalQueueFailure } from '../../../queue/signal-delivery-state.js';
import { SIGNAL_BRIDGE_VERSION, type SignalConfig } from './signal-config.js';
import { SignalDeviceRegistry } from './signal-device-registry.js';
import {
  SignalAccountVerifier,
  SignalVerificationError,
  type SignalVerificationFailure,
  type SignalVerificationStatus,
} from './signal-account-verifier.js';
import { SignalDiagnostics } from './signal-diagnostics.js';
import { SignalInboundBuffer, type SignalBufferStatus } from './signal-inbound-buffer.js';
import type { SignalInboundContext } from './signal-inbound-policy.js';
import { normalizeSignalUuid } from './signal-identities.js';
import { SignalRpcClient, SignalRpcTransportError } from './signal-rpc-client.js';
import {
  SignalSendCoordinator,
  type SignalSendPersistenceHealth,
  type SignalSendReadiness,
} from './signal-send-coordinator.js';
import { prepareSignalText } from './signal-text.js';
import type {
  SignalChannelConnector,
  SignalChunkReceipt,
  SignalPreparedText,
} from './signal-types.js';
import {
  isSignalSubscriptionId,
  SignalRpcRemoteError,
  type SignalJsonValue,
  type SignalReceiveNotification,
} from './signal-wire.js';

export type SignalConnectorState = 'stopped' | 'reconnecting' | 'ready' | 'needs_setup';
export type SignalConnectorReason =
  | 'RECEIPT_REQUIRED'
  | 'OWNER_BUSY'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_BRIDGE_MODE'
  | 'ACCOUNT_MISMATCH'
  | 'DEVICE_METADATA_INVALID'
  | 'UNTRUSTED_SOCKET'
  | 'PROTOCOL_FAILURE_LOOP'
  | 'VERIFICATION_PENDING'
  | 'VERIFICATION_STALE'
  | 'STATE_WRITE_FAILED'
  | 'OUTBOUND_STOPPED'
  | 'DISCONNECTED';

export class SignalConnectorError extends ChannelError {
  constructor(readonly reason: SignalConnectorReason) {
    super(`Signal connector unavailable: ${reason}`);
  }
}

export type SignalConnectorRepairFailure = SignalQueueFailure | SignalVerificationFailure;
export type SignalConnectorStopFailure = SignalConnectorRepairFailure;
export interface SignalConnectorStatus {
  /** Receive lifecycle only; outboundSuspended and actual sender health distinguish send availability. */
  readonly state: SignalConnectorState;
  readonly reason?: SignalConnectorReason;
  readonly verification?: SignalVerificationStatus;
  readonly sender?: SignalSendPersistenceHealth;
  /** Local lifecycle/proof/persistence projection only; false grants no account/lease/target authority. */
  readonly outboundSuspended: boolean;
  readonly buffers?: Readonly<
    Record<'alias' | 'proof' | 'receipt', Pick<SignalBufferStatus['alias'], 'held' | 'dropped'>>
  >;
  readonly draining: boolean;
  readonly replacementAllowed: boolean;
  readonly persistenceBlocked: boolean;
}

export interface SignalConnectorDependencies {
  /** All repositories share ONE SQLite connection; preserve repository/registry object identity. */
  readonly accounts: SignalAccountStateRepository;
  readonly leases: SignalDestinationLeaseRepository;
  readonly queue: QueueRepository;
  readonly registry: SignalDeviceRegistry;
  /** Already coalesced by SignalInboundBuffer/registry. Route foreign author ACI to its existing
   * generation owner; do NOT coalesce again, construct owners, or substitute the receiving ACI. */
  readonly requestDeviceRefresh?: (accountUuid: string) => void;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly random?: () => number;
}

interface Connection {
  readonly epoch: number;
  readonly rpc: SignalRpcClient;
  readonly metadata: AbortController;
  handshake: boolean;
  subscribing: boolean;
  subscription?: number;
  subscriptionRequest?: Promise<void>;
  aliasRequest?: Promise<Result<void, ChannelError>>;
}
const owners = new WeakMap<SignalAccountStateRepository, Map<string, SignalConnector>>();
const registryOwners = new WeakMap<SignalDeviceRegistry, Map<string, SignalConnector>>();

/** One lifetime sender survives socket reconnects: its active/result gate serializes old and new
 * transport work. Stop OR actual sender poison irreversibly closes send admission; repair never
 * reopens it, while healthy receive transport stays active. Factory replacement/recovery MUST
 * await stopWithResult Ok, not ordinary stop(), callbacks, or an empty claimed-work count. */
export class SignalConnector implements SignalChannelConnector {
  readonly type = 'signal';
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly diagnostics: SignalDiagnostics;
  private receipt?: InboundReceiptHandler;
  private verifier?: SignalAccountVerifier;
  private sender?: SignalSendCoordinator;
  private buffer?: SignalInboundBuffer;
  private connection?: Connection;
  private aliases: readonly string[] = [];
  private epoch = 0;
  private state: SignalConnectorState = 'stopped';
  private reason?: SignalConnectorReason;
  private running = false;
  private stopped = false;
  private owned = false;
  private attempt?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private aliasTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelay: number;
  private protocolFailures: readonly number[] = [];
  private reactionQueued = false;
  private stopPromise?: Promise<Result<void, SignalConnectorStopFailure>>;
  private stopFailure?: SignalConnectorStopFailure;

  constructor(
    private readonly config: SignalConfig,
    readonly name: string,
    private readonly logger: Pick<pino.Logger, 'debug' | 'info' | 'warn'>,
    private readonly dependencies: SignalConnectorDependencies,
  ) {
    this.now = dependencies.now ?? Date.now;
    this.monotonicNow = dependencies.monotonicNow ?? ((): number => performance.now());
    this.reconnectDelay = config.reconnectBaseMs;
    this.diagnostics = new SignalDiagnostics(name, logger, {
      now: this.now,
      setTimer: (callback, delay): (() => void) => {
        const timer = setTimeout(callback, delay);
        timer.unref();
        return () => clearTimeout(timer);
      },
    });
  }

  /** Legacy registration remains source-compatible but cannot certify durable acceptance.
   * Signal delivers ONLY to the explicit Result-returning receipt handler. */
  onMessage(_handler: (event: InboundEvent) => void | Promise<void>): void {}

  onMessageWithReceipt(handler: InboundReceiptHandler): void {
    this.receipt = handler;
  }

  start(): Promise<void> {
    if (this.stopped || this.state === 'needs_setup') return Promise.resolve();
    if (this.running) return this.attempt ?? Promise.resolve();
    if (!this.receipt) {
      this.transition('needs_setup', 'RECEIPT_REQUIRED');
      return Promise.resolve();
    }
    const { accounts, registry } = this.dependencies;
    if (
      owners.get(accounts)?.has(this.config.accountUuid) ||
      registryOwners.get(registry)?.has(this.config.accountUuid)
    ) {
      this.transition('needs_setup', 'OWNER_BUSY');
      return Promise.resolve();
    }
    const created = SignalAccountVerifier.create({
      config: this.config,
      accounts,
      registry,
      now: this.now,
      monotonicNow: this.monotonicNow,
      onChange: () => this.scheduleReaction(),
    });
    if (created.isErr()) {
      this.transition(
        'needs_setup',
        created.error instanceof SignalVerificationError && created.error.reason === 'OWNER_BUSY'
          ? 'OWNER_BUSY'
          : 'DEVICE_METADATA_INVALID',
      );
      return Promise.resolve();
    }
    this.verifier = created.value;
    owners.set(
      accounts,
      new Map([...(owners.get(accounts) ?? []), [this.config.accountUuid, this]]),
    );
    registryOwners.set(
      registry,
      new Map([...(registryOwners.get(registry) ?? []), [this.config.accountUuid, this]]),
    );
    this.owned = true;
    this.running = true;
    this.sender = new SignalSendCoordinator({
      accounts,
      leases: this.dependencies.leases,
      queue: this.dependencies.queue,
      now: this.now,
      monotonicNow: this.monotonicNow,
      readiness: (): SignalSendReadiness => this.readiness(),
      onPersistenceChange: (): void => this.scheduleReaction(),
      rpc: {
        request: (request, options): ReturnType<SignalRpcClient['request']> =>
          this.connection
            ? this.connection.rpc.request(request, options)
            : Promise.resolve(err(new SignalRpcTransportError('DISCONNECTED'))),
      },
    });
    this.buffer = new SignalInboundBuffer({
      devices: registry,
      context: (): SignalInboundContext => {
        this.verifier?.status();
        return {
          config: this.config,
          channelName: this.name,
          generation: registry.generation,
          connectionGeneration: this.connection?.epoch ?? -1,
          subscription: this.connection?.subscription ?? NaN,
          aliases: this.aliases,
          registry: registry.snapshot(),
          now: this.now(),
        };
      },
      receipt: (event): ReturnType<InboundReceiptHandler> =>
        this.receipt?.(event) ?? err(new PipelineError('Signal receipt unavailable')),
      refreshAliases: (): Promise<Result<void, ChannelError>> => this.refreshAliases(),
      refreshDevices: (accountUuid): void => {
        if (!this.running || this.state === 'needs_setup') return;
        if (accountUuid === this.config.accountUuid) void this.verifier?.requestRefresh();
        else this.dependencies.requestDeviceRefresh?.(accountUuid);
      },
      reconnect: (): void => {
        const connection = this.connection;
        if (connection) this.disconnect(connection);
      },
      diagnostics: this.diagnostics,
      random: this.dependencies.random,
      clock: {
        now: this.now,
        setTimer: (callback, delay): (() => void) => {
          const timer = setTimeout(callback, delay);
          timer.unref();
          return () => clearTimeout(timer);
        },
      },
    });
    this.transition('reconnecting', 'VERIFICATION_PENDING');
    return this.connectAttempt();
  }

  async stop(): Promise<void> {
    await this.stopWithResult();
  }

  /** Irreversible admission stop + metadata cancellation + real sender RPC/classification/write
   * drain (remaining request deadline, capped30s), THEN transport close. Err retains ownership.
   * TASK012 must withhold replacement AND recovery on Err, including after ordinary stop(). */
  stopWithResult(): Promise<Result<void, SignalConnectorStopFailure>> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.running = false;
    this.cancelSchedules();
    this.transition('stopped');
    this.buffer?.stop();
    this.diagnostics.stop();
    this.connection?.metadata.abort();
    this.sender?.quiesce();
    const verification = this.verifier?.stop() ?? Promise.resolve(ok(undefined));
    const sending = this.sender?.drain() ?? Promise.resolve(ok(undefined));
    const promise = Promise.all([verification, sending])
      .then(([verified, sent]): Result<void, SignalConnectorStopFailure> => {
        this.connection?.rpc.stop();
        this.connection = undefined;
        const failure = sent.isErr() ? sent.error : verified.isErr() ? verified.error : undefined;
        this.stopFailure = failure;
        if (failure !== undefined) return err(failure);
        this.releaseOwner();
        return ok(undefined);
      })
      .finally(() => {
        if (this.stopPromise === promise) this.stopPromise = undefined;
      });
    this.stopPromise = promise;
    return promise;
  }

  /** DB-only repair of BOTH original owners; each enforces its own elapsed backoff/strict authority.
   * Always try both, even if one fails. Return the actual sender Err first, otherwise A's Result
   * (including post-stop STALE_CONNECTION after a committed repair). No RPC, automatic privilege
   * reassertion, admission restart or ownership release. Replacement still requires final
   * stopWithResult Ok from BOTH producers; health/count0 or this Result alone is not that gate. */
  retryStateWrites(): Result<SignalVerificationStatus, SignalConnectorRepairFailure> {
    const sending = this.sender?.retryStateWrites() ?? ok(undefined);
    const verification =
      this.verifier?.retryStateWrites() ?? err(new SignalVerificationError('STOPPED'));
    return sending.isErr() ? err(sending.error) : verification;
  }

  requestVerificationRefresh(): Promise<
    Result<SignalVerificationStatus, SignalVerificationFailure>
  > {
    return (
      this.verifier?.requestRefresh() ??
      Promise.resolve(err(new SignalVerificationError('STOPPED')))
    );
  }

  /** Authenticated local operator/CLI plumbing ONLY. The caller authenticates and supplies a NEW
   * external-resolution assertion per invocation. Never automatically re-invoke on budget/DB/CAS
   * failure: A alone retries a still-bound intent; new challenge/revision requires fresh assertion. */
  resumeChallenge(assertion: {
    readonly externalChallengeResolved: true;
  }): Promise<Result<SignalVerificationStatus, SignalVerificationFailure | SignalConnectorError>> {
    if (this.state === 'needs_setup')
      return Promise.resolve(err(new SignalConnectorError(this.reason ?? 'VERIFICATION_PENDING')));
    if (!this.running || !this.connection?.handshake || !this.verifier)
      return Promise.resolve(err(new SignalVerificationError('STALE_CONNECTION')));
    return this.verifier.resumeChallenge(assertion);
  }

  status(): SignalConnectorStatus {
    const verification = this.verifier?.status();
    const sender = this.sender?.persistenceHealth();
    const buffers = this.buffer?.status();
    const counts = (
      kind: 'alias' | 'proof' | 'receipt',
    ): Pick<SignalBufferStatus['alias'], 'held' | 'dropped'> =>
      Object.freeze({ held: buffers?.[kind].held ?? 0, dropped: buffers?.[kind].dropped ?? 0 });
    return Object.freeze({
      state: this.state,
      reason: this.state === 'ready' ? this.readyReason(verification) : this.reason,
      verification,
      sender,
      outboundSuspended: this.readiness().state !== 'ready',
      buffers: buffers
        ? Object.freeze({
            alias: counts('alias'),
            proof: counts('proof'),
            receipt: counts('receipt'),
          })
        : undefined,
      draining: this.stopPromise !== undefined,
      replacementAllowed: this.stopped && !this.owned,
      persistenceBlocked:
        this.stopFailure !== undefined ||
        verification?.state === 'suspended' ||
        sender?.state === 'blocked',
    });
  }

  prepare(
    destination: string,
    output: AgentOutput,
  ): Result<SignalPreparedText, SignalDeliveryError> {
    return prepareSignalText(destination, output, this.config.accountUuid);
  }

  send(destination: string, output: AgentOutput): Promise<Result<void, SignalDeliveryError>> {
    if (this.state === 'needs_setup') return Promise.resolve(err(this.unavailable()));
    if (this.sender) return this.sender.send(destination, output);
    const prepared = this.prepare(destination, output);
    return Promise.resolve(prepared.isErr() ? err(prepared.error) : err(this.unavailable()));
  }

  sendPreparedChunk(
    destination: string,
    chunk: string,
    context: TrustedDeliveryContext,
  ): Promise<Result<SignalChunkReceipt, SignalDeliveryError>> {
    if (this.state === 'needs_setup') return Promise.resolve(err(this.unavailable()));
    return (
      this.sender?.sendPreparedChunk(destination, chunk, context) ??
      Promise.resolve(err(this.unavailable()))
    );
  }

  cancelWaiter(context: TrustedDeliveryContext): boolean {
    return this.sender?.cancelWaiter(context) ?? false;
  }

  format(markdown: string): string {
    return stripMarkdown(markdown);
  }

  private unavailable(): SignalDeliveryError {
    return new SignalDeliveryError({
      reason: this.state === 'needs_setup' ? 'NEEDS_SETUP' : 'UNAVAILABLE',
      outcome: 'NOT_SENT',
      acceptedChunks: 0,
      currentChunkAcceptance: 'unwritten',
      successCount: 0,
      failureCount: 0,
      retryScope: this.state === 'needs_setup' ? 'none' : 'delivery_only',
    });
  }

  private readyReason(
    verification: SignalVerificationStatus | undefined,
  ): SignalConnectorReason | undefined {
    const sender = this.sender?.persistenceHealth();
    if (verification?.state === 'suspended' || sender?.state === 'blocked')
      return 'STATE_WRITE_FAILED';
    if (sender?.stopped) return 'OUTBOUND_STOPPED';
    return verification?.state === 'stale' ? 'VERIFICATION_STALE' : undefined;
  }

  private readiness(): SignalSendReadiness {
    const verification = this.verifier?.status();
    const sender = this.sender?.persistenceHealth();
    const proof = this.dependencies.registry
      .snapshot()
      .find((entry) => entry.accountUuid === this.config.accountUuid);
    return {
      config: this.config,
      generation: this.dependencies.registry.generation,
      state:
        this.state === 'needs_setup'
          ? 'needs_setup'
          : this.running &&
              this.connection?.subscription !== undefined &&
              verification?.state === 'verified' &&
              sender?.state !== 'blocked' &&
              !sender?.stopped
            ? 'ready'
            : 'reconnecting',
      proof: proof ?? {
        accountUuid: this.config.accountUuid,
        accountMode: this.config.accountMode,
        bridgeDeviceId: this.config.deviceId,
        generation: this.dependencies.registry.generation,
        status: 'unverified',
      },
    };
  }

  private current(connection: Connection): boolean {
    return this.running && this.state !== 'needs_setup' && this.connection === connection;
  }

  private connectAttempt(): Promise<void> {
    if (this.attempt) return this.attempt;
    if (!this.running || this.state === 'needs_setup' || this.connection) return Promise.resolve();
    const epoch = ++this.epoch;
    const rpc = new SignalRpcClient({
      socketPath: this.config.socketPath,
      requestTimeoutMs: this.config.requestTimeoutMs,
      onReceive: (event): void => this.receive(connection, event),
      onClose: (failure): void => this.closed(connection, failure),
    });
    const connection: Connection = {
      epoch,
      rpc,
      metadata: new AbortController(),
      handshake: false,
      subscribing: false,
    };
    this.connection = connection;
    const promise = this.handshake(connection).finally(() => {
      if (this.attempt === promise) this.attempt = undefined;
      if (this.running && !this.connection) this.scheduleReconnect();
    });
    this.attempt = promise;
    return promise;
  }

  private async handshake(connection: Connection): Promise<void> {
    const connected = await connection.rpc.connect({ signal: connection.metadata.signal });
    if (!this.current(connection)) return;
    if (connected.isErr()) {
      if (connected.error.reason === 'UNTRUSTED_SOCKET') this.needsSetup('UNTRUSTED_SOCKET');
      else this.disconnect(connection);
      return;
    }
    const version = await connection.rpc.request(
      { method: 'version' },
      { signal: connection.metadata.signal },
    );
    if (!this.current(connection)) return;
    if (version.isErr()) {
      if (
        version.error instanceof SignalRpcRemoteError &&
        version.error.remoteCode === 'METHOD_NOT_FOUND'
      )
        this.needsSetup('UNSUPPORTED_BRIDGE_MODE');
      else this.disconnect(connection);
      return;
    }
    // Pinned VersionCommand.java:60-66. Exact value, not a semver compatibility promise.
    if (
      version.value.kind !== 'result' ||
      !record(version.value.value) ||
      version.value.value.version !== SIGNAL_BRIDGE_VERSION
    ) {
      this.needsSetup('UNSUPPORTED_VERSION');
      return;
    }
    const aliases = await this.refreshAliases(connection);
    if (!this.current(connection)) return;
    if (aliases.isErr()) {
      this.disconnect(connection);
      return;
    }
    connection.handshake = true;
    this.scheduleAliases(connection);
    await this.verifier?.connect(connection.epoch, connection.rpc);
    if (this.current(connection)) await this.reconcileSubscription();
  }

  private scheduleReaction(): void {
    if (!this.running || this.reactionQueued) return;
    this.reactionQueued = true;
    queueMicrotask(() => {
      this.reactionQueued = false;
      if (this.running) void this.reconcileSubscription();
    });
  }

  private async reconcileSubscription(): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.current(connection) || !connection.handshake) return;
    const status = this.verifier?.status();
    if (status?.state === 'needs_setup') {
      this.needsSetup(
        status.reason === 'UNSUPPORTED_BRIDGE_MODE'
          ? 'UNSUPPORTED_BRIDGE_MODE'
          : 'DEVICE_METADATA_INVALID',
      );
      return;
    }
    this.buffer?.revalidate();
    this.sender?.readinessChanged();
    if (connection.subscriptionRequest) {
      await connection.subscriptionRequest;
      return;
    }
    if (connection.subscription !== undefined) {
      this.transition('ready', this.readyReason(status));
      return;
    }
    if (status?.state !== 'verified') return;
    connection.subscribing = true;
    const pending = this.subscribe(connection);
    connection.subscriptionRequest = pending;
    await pending;
    if (connection.subscriptionRequest === pending) connection.subscriptionRequest = undefined;
  }

  private async subscribe(connection: Connection): Promise<void> {
    const subscribed = await connection.rpc.request(
      { method: 'subscribeReceive', params: { account: this.config.accountUuid } },
      { signal: connection.metadata.signal },
    );
    if (!this.current(connection)) return;
    connection.subscribing = false;
    if (subscribed.isErr()) {
      if (
        subscribed.error instanceof SignalRpcRemoteError &&
        subscribed.error.remoteCode === 'METHOD_NOT_FOUND'
      )
        this.needsSetup('UNSUPPORTED_BRIDGE_MODE');
      else this.disconnect(connection);
      return;
    }
    if (subscribed.value.kind !== 'result' || !isSignalSubscriptionId(subscribed.value.value)) {
      this.disconnect(connection);
      return;
    }
    connection.subscription = subscribed.value.value;
    this.reconnectDelay = this.config.reconnectBaseMs;
    this.transition('ready', this.readyReason(this.verifier?.status()));
    this.buffer?.revalidate();
    this.sender?.readinessChanged();
  }

  private receive(connection: Connection, event: SignalReceiveNotification): void {
    if (!this.current(connection)) return;
    if (event.hasException) {
      this.diagnostics.count('RECEIVE_EXCEPTION');
      return;
    }
    // Actual SignalRpcClient dispatch resolves subscribe, then synchronously flushes ONLY
    // matching receives before our await resumes. Adopt its already-validated ID locally;
    // normalize immediately through the bounded producer, never retain another raw queue.
    if (connection.subscribing && connection.subscription === undefined)
      connection.subscription = event.subscription;
    if (connection.subscription !== event.subscription) return;
    this.buffer?.receive(
      {
        subscription: event.subscription,
        result: { account: event.account, envelope: event.envelope },
      },
      connection.epoch,
    );
  }

  private refreshAliases(connection = this.connection): Promise<Result<void, ChannelError>> {
    if (!connection || !this.current(connection))
      return Promise.resolve(err(new SignalRpcTransportError('DISCONNECTED')));
    if (connection.aliasRequest) return connection.aliasRequest;
    const promise = connection.rpc
      .request({ method: 'listAccounts' }, { signal: connection.metadata.signal })
      .then((response): Result<void, ChannelError> => {
        if (!this.current(connection)) return err(new SignalRpcTransportError('CANCELLED'));
        if (response.isErr()) {
          if (
            response.error instanceof SignalRpcRemoteError &&
            response.error.remoteCode === 'METHOD_NOT_FOUND'
          )
            this.needsSetup('UNSUPPORTED_BRIDGE_MODE');
          return err(response.error);
        }
        const aliases =
          response.value.kind === 'result' ? this.selectAliases(response.value.value) : undefined;
        if (!aliases) {
          this.needsSetup('ACCOUNT_MISMATCH');
          return err(new SignalConnectorError('ACCOUNT_MISMATCH'));
        }
        this.aliases = aliases;
        this.buffer?.revalidate();
        return ok(undefined);
      })
      .finally(() => {
        if (connection.aliasRequest === promise) connection.aliasRequest = undefined;
      });
    connection.aliasRequest = promise;
    return promise;
  }

  private selectAliases(input: SignalJsonValue): readonly string[] | undefined {
    // ListAccountsCommand.java:33-47: ONLY number (nullable) and aci; no registration/device flag.
    if (!Array.isArray(input)) return undefined;
    const rows: { readonly aci: string; readonly number: string | null }[] = [];
    for (const value of input) {
      if (!record(value)) return undefined;
      const aci = normalizeSignalUuid(value.aci);
      if (
        aci.isErr() ||
        !(
          value.number === null ||
          (typeof value.number === 'string' && /^\+[1-9][0-9]{1,14}$/.test(value.number))
        )
      )
        return undefined;
      rows.push({ aci: aci.value, number: value.number });
    }
    const pinned = rows.filter((row) => row.aci === this.config.accountUuid);
    if (pinned.length !== 1) return undefined;
    const selector = rows.filter(
      (row) => row.aci === this.config.account || row.number === this.config.account,
    );
    if (selector.some((row) => row.aci !== this.config.accountUuid)) return undefined;
    const selected = pinned[0];
    if (
      selected.number !== null &&
      rows.some((row) => row !== selected && row.number === selected.number)
    )
      return undefined;
    return Object.freeze(
      selected.number === null ? [selected.aci] : [selected.aci, selected.number],
    );
  }

  private scheduleAliases(connection: Connection): void {
    if (this.aliasTimer !== undefined) clearTimeout(this.aliasTimer);
    if (!this.current(connection)) return;
    this.aliasTimer = setTimeout(() => {
      this.aliasTimer = undefined;
      if (!this.current(connection)) return;
      void this.refreshAliases(connection).finally(() => {
        if (this.current(connection)) this.scheduleAliases(connection);
      });
    }, 60_000);
    this.aliasTimer.unref();
  }

  private closed(connection: Connection, error: SignalRpcTransportError): void {
    if (!this.current(connection)) return;
    if (error.transportCode === 'UNTRUSTED_SOCKET') {
      this.needsSetup('UNTRUSTED_SOCKET');
      return;
    }
    if (
      ['PROTOCOL_FAILURE', 'FRAME_TOO_LARGE', 'PRE_RESPONSE_OVERFLOW'].includes(error.transportCode)
    ) {
      const now = this.monotonicNow();
      this.protocolFailures = [...this.protocolFailures.filter((at) => now - at <= 300_000), now];
      if (this.protocolFailures.length >= 3) {
        this.needsSetup('PROTOCOL_FAILURE_LOOP');
        return;
      }
    }
    this.disconnect(connection);
  }

  private disconnect(connection: Connection): void {
    if (!this.current(connection)) return;
    this.connection = undefined;
    this.verifier?.invalidateConnection(connection.epoch);
    connection.metadata.abort();
    connection.rpc.stop();
    if (this.aliasTimer !== undefined) clearTimeout(this.aliasTimer);
    this.aliasTimer = undefined;
    this.aliases = [];
    this.transition('reconnecting', 'DISCONNECTED');
    this.buffer?.revalidate();
    this.sender?.readinessChanged();
    if (!this.attempt) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.state === 'needs_setup' || this.reconnectTimer !== undefined) return;
    const random = Math.max(0, Math.min(1, (this.dependencies.random ?? Math.random)()));
    const delay = Math.min(
      this.config.reconnectMaxMs,
      Math.max(this.config.reconnectBaseMs, this.reconnectDelay * (0.8 + random * 0.4)),
    );
    this.reconnectDelay = Math.min(this.config.reconnectMaxMs, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) void this.connectAttempt();
    }, delay);
    this.reconnectTimer.unref();
  }

  private needsSetup(reason: SignalConnectorReason): void {
    if (!this.running || this.state === 'needs_setup') return;
    this.transition('needs_setup', reason);
    this.cancelSchedules();
    const connection = this.connection;
    if (connection) {
      this.verifier?.invalidateConnection(connection.epoch);
      connection.metadata.abort();
    }
    this.buffer?.stop();
    this.sender?.readinessChanged();
    // Preserve a possibly written send until its actual classification/write drain settles.
    void this.sender?.drain().then((result) => {
      if (result.isErr()) this.stopFailure = result.error;
      connection?.rpc.stop();
    });
  }

  private transition(state: SignalConnectorState, reason?: SignalConnectorReason): void {
    if (this.state === state && this.reason === reason) return;
    this.state = state;
    this.reason = reason;
    this.logger.info({ channelName: this.name, state, reason }, 'Signal connector state');
  }

  private cancelSchedules(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.aliasTimer !== undefined) clearTimeout(this.aliasTimer);
    this.reconnectTimer = undefined;
    this.aliasTimer = undefined;
  }

  private releaseOwner(): void {
    const { accounts, registry } = this.dependencies;
    if (owners.get(accounts)?.get(this.config.accountUuid) === this)
      owners.get(accounts)?.delete(this.config.accountUuid);
    if (registryOwners.get(registry)?.get(this.config.accountUuid) === this)
      registryOwners.get(registry)?.delete(this.config.accountUuid);
    this.owned = false;
  }
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
