/**
 * Durable browservoice session lifecycle.
 *
 * The service is the only owner of provider sessions, transport handles and
 * voice delegation admission.  It keeps provider callbacks serialized and
 * leaves execution to the ordinary durable queue/AgentRunner path.
 */

import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { err, ok } from '../core/types/result.js';
import { PolicyError, TalonError } from '../core/errors/index.js';
import type { MessageRepository } from '../core/database/repositories/message-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import {
  DEFAULT_VOICE_HISTORY_CHARACTERS,
  DEFAULT_VOICE_HISTORY_ROWS,
  composeVoiceInstructions,
  createSharedVoiceThreadMetadata,
  createVoiceThreadExternalId,
  formatVoiceHistory,
  parseSharedVoiceThreadMetadata,
  parseVoiceMessageContent,
  voiceBackendResultIdempotencyKey,
  voiceTranscriptIdempotencyKey,
} from './voice-types.js';
import {
  VoiceAuth,
  type VoiceAuthConfig,
  type VoiceAuthLoginOptions,
  type VoiceAuthLoginResult,
  type VoiceAuthSession,
} from './voice-auth.js';
import {
  createVoiceAdapterSelection,
  requireVoiceCapabilities,
  VoiceCallAdmission,
  type VoiceAdapterSelection,
  type VoiceCallReservation,
} from './voice-adapters.js';
import { resolveExactVoiceGrant, type VoiceAuthorization } from './voice-authorization.js';
import type {
  LiveVoiceEvent,
  LiveVoiceProvider,
  LiveVoiceSideband,
  VoiceAdmissionRequest,
  VoiceAsyncResult,
  VoiceBackendBridge,
  VoiceBackendRequest,
  VoiceBackendResult,
  VoiceCloseReason,
  VoiceContextSnapshot,
  VoiceDelegationRecord,
  VoiceEventHandler,
  VoiceIncomingSessionRequest,
  VoiceNotificationRequest,
  VoiceNotificationResult,
  VoiceNotificationStatusDto,
  VoiceOwnerContext,
  VoiceOutputLifecycle,
  VoicePlaybackReport,
  VoicePolicyEvaluator,
  VoicePolicySnapshot,
  VoiceResult,
  VoiceSessionCloseRequest,
  VoiceSessionCloseResult,
  VoiceSessionCreateRequest,
  VoiceSessionCreateResult,
  VoiceSessionId,
  VoiceSessionReadProjection,
  VoiceSessionRecord,
  VoiceSessionService as VoiceSessionServiceContract,
  VoiceSessionStatusDto,
  VoiceStatusEventDto,
  VoiceSupersedeResult,
  VoiceTransport,
  VoiceTransportKind,
  VoiceTransportEvent,
  VoiceTransportHandle,
  VoiceTransportOpenRequest,
  VoiceTransportStatus,
  VoiceTranscriptFragment,
  VoiceUnsubscribe,
  VoiceUsageUpdate,
  VoiceLoginRequest,
} from './voice-types.js';
import type { VoiceStore } from './voice-types.js';
import type { VoiceTelemetry } from './voice-telemetry.js';

const DEFAULT_SESSION_LIFETIME_MS = 15 * 60 * 1000;
const DEFAULT_MAX_CONTEXT_CHARS = 32_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_VOICE_NOTIFICATION_CHARS = 16_000;
const MAX_RETAINED_VOICE_NOTIFICATIONS = 100;

type VoiceContextRejectionReason =
  | 'missing_transcript'
  | 'truncated'
  | 'boundary_fragment'
  | 'untimed_fragment'
  | 'transcript_changed'
  | 'delegation_replay_conflict'
  | 'context_too_large';

interface VoiceContextInspection {
  readonly context: VoiceContextSnapshot | null;
  readonly reason: VoiceContextRejectionReason;
}

export interface VoiceSessionServiceOptions {
  readonly store: VoiceStore;
  readonly provider: LiveVoiceProvider;
  readonly transport: VoiceTransport;
  readonly backendBridge: VoiceBackendBridge;
  readonly policy: VoicePolicyEvaluator;
  readonly threadRepository?: ThreadRepository;
  /** Existing message history is the durable notification projection. */
  readonly messageRepository?: Pick<MessageRepository, 'findLatestByThread' | 'findLatestByThreadPage'> &
    Partial<Pick<MessageRepository, 'insert' | 'upsertVoiceTranscript'>>;
  readonly channelId?: string;
  readonly personaId: string;
  readonly providerName?: string;
  readonly modelName: string;
  /** GPT-Live model; backend policy keeps using the persona modelName. */
  readonly liveModelName?: string;
  readonly instructions: string;
  readonly voiceName: string;
  readonly generation?: () => number;
  readonly capturePolicy?: (owner: VoiceOwnerContext) => VoiceResult<VoicePolicySnapshot>;
  readonly currentPolicy?: (
    owner: VoiceOwnerContext,
    session: VoiceSessionRecord,
  ) => VoiceResult<VoicePolicySnapshot>;
  /** Exact session authority check. The HTTP auth layer remains separate. */
  readonly isOwnerActive?: (owner: VoiceOwnerContext) => boolean;
  /** SIP grant check bound to the durable provider session identity. */
  readonly isIncomingOwnerActive?: (
    owner: VoiceOwnerContext,
    providerSessionId: string,
  ) => boolean;
  readonly now?: () => number;
  readonly maxSessionLifetimeMs?: number;
  readonly maxContextChars?: number;
  readonly shutdownTimeoutMs?: number;
  /** Optional operator-provided live voice rate; absent means no new estimate. */
  readonly usdPerMinute?: number;
  /** Content-free server lifecycle observations. */
  readonly telemetry?: VoiceTelemetry;
  readonly logger?: pino.Logger;
  /** Trusted server-selected transport/engine contract. */
  readonly adapterSelection?: VoiceAdapterSelection;
  /** Additional provider-owned transports, such as incoming SIP. */
  readonly transports?: ReadonlyMap<VoiceTransportKind, VoiceTransport>;
  /** Capability negotiation for each additional transport. */
  readonly adapterSelections?: ReadonlyMap<VoiceTransportKind, VoiceAdapterSelection>;
  /** Shared across all voice transports, including pending setup. */
  readonly callAdmission?: VoiceCallAdmission;
  readonly maxConcurrentSessions?: number;
  /** Optional transport-neutral exact grant authority. */
  readonly authorization?: VoiceAuthorization;
  /** Called immediately after a provider accept is durably acknowledged. */
  readonly onIncomingAccepted?: (callId: string) => VoiceResult<boolean>;
  /** Called once when an incoming SIP provider finalization is confirmed. */
  readonly onIncomingClosed?: (callId: string) => void;
}

interface SessionRuntime {
  readonly sideband: LiveVoiceSideband;
  readonly providerSessionId: string;
  readonly transport: VoiceTransport;
  readonly authority: 'browser' | 'sip';
  readonly incomingCallId?: string;
  readonly contextDiagnosticCorrelationId: string;
  unsubscribeProvider: VoiceUnsubscribe;
  unsubscribeTransport: VoiceUnsubscribe;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  eventChain: Promise<void>;
  closing: boolean;
  readonly listeners: Set<VoiceEventHandler<VoiceStatusEventDto>>;
  readonly resultUnsubscribes: Map<string, VoiceUnsubscribe>;
  readonly handledOutputIds: Set<string>;
  readonly staleDelegationIds: Set<string>;
  readonly staleNoticeSent: Set<string>;
}

interface IndexedOwnerSessions {
  readonly revisions: Map<number, VoiceAuthSession>;
}

interface BrowserTransportState {
  readonly sessionId: VoiceSessionId;
  readonly transportSessionId: string;
  status: VoiceTransportStatus;
  readonly handlers: Set<VoiceEventHandler<VoiceTransportEvent>>;
}

export interface BrowserVoiceTransportOptions {
  readonly now?: () => number;
  readonly sessionId?: () => string;
}

/** In-memory browser transport adapter for the voice lifecycle composition. */
export class BrowserVoiceTransport implements VoiceTransport {
  readonly kind = 'webrtc';
  readonly capabilities = {
    audio_streaming: 'supported',
    interruptions: 'supported',
    delegation: 'supported',
    notifications: 'supported',
    transcript_stability: 'supported',
    provider_acknowledgements: 'supported',
    playback_evidence: 'supported',
    usage_reporting: 'supported',
  } as const;

  private readonly now: () => number;
  private readonly createTransportSessionId: () => string;
  private readonly sessions = new Map<string, BrowserTransportState>();
  private readonly pendingHandlers = new Map<string, Set<VoiceEventHandler<VoiceTransportEvent>>>();

  constructor(options: BrowserVoiceTransportOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createTransportSessionId = options.sessionId ?? ((): string => `browser:${randomUUID()}`);
  }

  open(input: VoiceTransportOpenRequest): VoiceAsyncResult<VoiceTransportHandle> {
    if (input.client.transport !== this.kind || input.client.sessionId !== input.sessionId) {
      return Promise.resolve(err(new PolicyError('Browser transport descriptor does not match session')));
    }
    const existing = this.sessions.get(input.sessionId);
    if (existing && existing.status !== 'closed' && existing.status !== 'failed') {
      return Promise.resolve(err(new PolicyError('Browser voice transport is already open')));
    }

    const state: BrowserTransportState = {
      sessionId: input.sessionId,
      transportSessionId: this.createTransportSessionId(),
      status: 'connecting',
      handlers: this.pendingHandlers.get(input.sessionId) ?? new Set(),
    };
    this.pendingHandlers.delete(input.sessionId);
    this.sessions.set(input.sessionId, state);
    this.emit(state, { kind: 'status', status: 'connecting', occurredAt: this.now() });
    state.status = 'connected';
    this.emit(state, { kind: 'status', status: 'connected', occurredAt: this.now() });

    return Promise.resolve(
      ok({
        sessionId: state.sessionId,
        transportSessionId: state.transportSessionId,
        kind: this.kind,
        status: state.status,
      }),
    );
  }

  status(sessionId: VoiceSessionId): VoiceResult<VoiceTransportStatus> {
    return ok(this.sessions.get(sessionId)?.status ?? 'idle');
  }

  onEvent(
    sessionId: VoiceSessionId,
    handler: VoiceEventHandler<VoiceTransportEvent>,
  ): VoiceUnsubscribe {
    const state = this.sessions.get(sessionId);
    const handlers = state?.handlers ?? this.pendingHandlers.get(sessionId) ?? new Set();
    if (!state) this.pendingHandlers.set(sessionId, handlers);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (!state && handlers.size === 0) this.pendingHandlers.delete(sessionId);
    };
  }

  close(sessionId: VoiceSessionId, _reason: string): VoiceAsyncResult<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.status === 'closed') return Promise.resolve(ok(undefined));
    state.status = 'closing';
    this.emit(state, { kind: 'status', status: 'closing', occurredAt: this.now() });
    state.status = 'closed';
    this.emit(state, { kind: 'status', status: 'closed', occurredAt: this.now() });
    return Promise.resolve(ok(undefined));
  }

  /** Lifecycle hook for browser playback acknowledgements. */
  reportPlayback(
    sessionId: VoiceSessionId,
    outputId: string,
    status: 'playing' | 'played' | 'interrupted',
  ): VoiceResult<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.status === 'closed' || state.status === 'failed') {
      return err(new PolicyError('Browser voice transport is closed'));
    }
    this.emit(state, { kind: 'playback', outputId, status, occurredAt: this.now() });
    return ok(undefined);
  }

  private emit(state: BrowserTransportState, event: VoiceTransportEvent): void {
    for (const handler of state.handlers) {
      try {
        void Promise.resolve(handler(event)).catch(() => undefined);
      } catch {
        // A client listener cannot change durable transport state.
      }
    }
  }
}

/**
 * Composition auth wrapper. It indexes successful logins by stable owner and
 * login revision while retaining VoiceAuth's exact identity/expiry authority.
 */
export class IndexedVoiceAuth extends VoiceAuth {
  private readonly owners = new Map<string, IndexedOwnerSessions>();

  constructor(config: VoiceAuthConfig) {
    super(config);
    this.takeHydratedSessions();
  }

  override login(
    input: string | VoiceLoginRequest,
    options: VoiceAuthLoginOptions = {},
  ): VoiceResult<VoiceAuthLoginResult> {
    const result = super.login(input, options);
    if (result.isOk()) this.indexSession(result.value.session);
    return result;
  }

  override revoke(session: VoiceAuthSession): VoiceResult<void> {
    const result = super.revoke(session);
    if (result.isOk()) this.removeIndexedSession(session);
    return result;
  }

  resolveResult(owner: VoiceOwnerContext): VoiceResult<VoiceAuthSession | undefined> {
    const pruned = this.pruneRuntimeSessions();
    if (pruned.isErr()) return err(pruned.error);
    const session = this.owners.get(owner.ownerId)?.revisions.get(owner.loginRevision);
    if (!session) return ok(undefined);
    const active = this.isActiveResult(session);
    if (active.isErr()) return err(active.error);
    return ok(active.value ? session : undefined);
  }

  resolve(owner: VoiceOwnerContext): VoiceAuthSession | undefined {
    const result = this.resolveResult(owner);
    return result.isOk() ? result.value : undefined;
  }

  override invalidateRuntime(): VoiceResult<void> {
    const result = super.invalidateRuntime();
    if (result.isOk()) this.owners.clear();
    return result;
  }

  protected override onRuntimeSessionRegistered(session: VoiceAuthSession): void {
    this.indexSession(session);
  }

  protected override onRuntimeSessionRevoked(session: VoiceAuthSession): void {
    this.removeIndexedSession(session);
  }

  private indexSession(session: VoiceAuthSession): void {
    let owner = this.owners.get(session.owner.ownerId);
    if (!owner) {
      owner = { revisions: new Map() };
      this.owners.set(session.owner.ownerId, owner);
    }
    owner.revisions.set(session.owner.loginRevision, session);
  }

  private removeIndexedSession(session: VoiceAuthSession): void {
    const owner = this.owners.get(session.owner.ownerId);
    if (!owner) return;
    if (owner.revisions.get(session.owner.loginRevision) === session) {
      owner.revisions.delete(session.owner.loginRevision);
    }
    if (owner.revisions.size === 0) this.owners.delete(session.owner.ownerId);
  }

}

/** Durable VoiceSessionService implementation used by daemon composition. */
export class DurableVoiceSessionService implements VoiceSessionServiceContract {
  private readonly now: () => number;
  private readonly maxSessionLifetimeMs: number;
  private readonly maxContextChars: number;
  private readonly shutdownTimeoutMs: number;
  private readonly usdPerMinute: number | undefined;
  private readonly generation: () => number;
  private readonly telemetry: VoiceTelemetry | undefined;
  private readonly runtimes = new Map<VoiceSessionId, SessionRuntime>();
  private readonly callAdmission: VoiceCallAdmission;
  private readonly reservations = new Map<VoiceSessionId, VoiceCallReservation>();
  private readonly pendingSetupReservations = new Set<string>();
  private admissionOpen = true;
  private lifecycleGeneration = 0;

  constructor(private readonly options: VoiceSessionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxSessionLifetimeMs = positiveLimit(
      options.maxSessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS,
      'maxSessionLifetimeMs',
    );
    this.maxContextChars = positiveLimit(
      options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS,
      'maxContextChars',
    );
    this.shutdownTimeoutMs = positiveLimit(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    );
    this.usdPerMinute = optionalNonNegativeFinite(options.usdPerMinute, 'usdPerMinute');
    this.generation = options.generation ?? ((): number => this.lifecycleGeneration);
    this.telemetry = options.telemetry;
    this.callAdmission =
      options.callAdmission ?? new VoiceCallAdmission(options.maxConcurrentSessions ?? 1);
  }

  async createSession(
    owner: VoiceOwnerContext,
    input: VoiceSessionCreateRequest,
  ): VoiceAsyncResult<VoiceSessionCreateResult> {
    if (!this.admissionOpen) return err(new PolicyError('Voice session admission is closed'));
    const ownerError = this.ensureOwnerActive(owner);
    if (ownerError) return err(ownerError);
    const configuredSelection = this.options.adapterSelection;
    if (!configuredSelection) return err(new PolicyError('Voice adapter selection is required'));
    if (
      configuredSelection.transport !== this.options.transport ||
      configuredSelection.engine !== this.options.provider
    ) {
      return err(new PolicyError('Voice adapter selection does not match the active adapters'));
    }
    const actualSelection = createVoiceAdapterSelection({
      transport: this.options.transport,
      engine: this.options.provider,
      requiredCapabilities: configuredSelection.negotiation.requiredCapabilities,
    });
    if (actualSelection.isErr()) return err(actualSelection.error);
    const negotiated = requireVoiceCapabilities(actualSelection.value.negotiation);
    if (negotiated.isErr()) return err(negotiated.error);
    if (input.transport.type !== actualSelection.value.transport.kind) {
      return err(new PolicyError('Voice transport is not the configured adapter'));
    }
    const reservation = this.callAdmission.reserve(owner.ownerId);
    if (reservation.isErr()) return err(reservation.error);
    this.pendingSetupReservations.add(reservation.value.id);

    try {
      return await this.createSessionInternal(owner, input, reservation.value, {
        transport: this.options.transport,
        authority: 'browser',
      });
    } finally {
      this.pendingSetupReservations.delete(reservation.value.id);
      if (reservation.value.sessionId === undefined) {
        reservation.value.release();
      } else if (!this.runtimes.has(reservation.value.sessionId)) {
        this.releaseReservation(reservation.value.sessionId);
      }
    }
  }

  async acceptIncomingSession(
    input: VoiceIncomingSessionRequest,
  ): VoiceAsyncResult<VoiceSessionCreateResult> {
    if (!this.admissionOpen) return err(new PolicyError('Voice session admission is closed'));
    if (
      input.providerSessionId.trim() === '' ||
      input.callId.trim() === '' ||
      input.personaId.trim() === '' ||
      !Number.isSafeInteger(input.admissionExpiresAt) ||
      input.admissionExpiresAt <= this.now()
    ) {
      return err(new PolicyError('Incoming SIP session identity or expiry is invalid'));
    }
    const transport = this.options.transports?.get('sip');
    if (!transport || transport.kind !== 'sip') {
      return err(new PolicyError('Incoming SIP transport is not configured'));
    }
    if (!this.options.provider.acceptIncomingSession) {
      return err(new PolicyError('Incoming SIP acceptance is unavailable'));
    }
    if (!this.options.onIncomingAccepted || !this.options.onIncomingClosed) {
      return err(new PolicyError('Incoming SIP durable lifecycle callbacks are required'));
    }
    const ownerError = this.ensureOwnerActive(input.owner, true);
    if (ownerError) return err(ownerError);
    if (!this.options.isIncomingOwnerActive) {
      return err(new PolicyError('Incoming SIP authority check is required'));
    }
    if (!this.options.isIncomingOwnerActive(input.owner, input.providerSessionId)) {
      return err(new PolicyError('Incoming SIP authority is no longer active'));
    }
    const configuredSelection = this.options.adapterSelections?.get('sip');
    if (!configuredSelection) return err(new PolicyError('Incoming SIP adapter selection is required'));
    if (
      configuredSelection.transport !== transport ||
      configuredSelection.engine !== this.options.provider
    ) {
      return err(new PolicyError('Incoming SIP adapter selection does not match active adapters'));
    }
    const selection = createVoiceAdapterSelection({
      transport,
      engine: this.options.provider,
      requiredCapabilities: configuredSelection.negotiation.requiredCapabilities,
    });
    if (selection.isErr()) return err(selection.error);
    const negotiated = requireVoiceCapabilities(selection.value.negotiation);
    if (negotiated.isErr()) return err(negotiated.error);
    const policy = this.capturePolicy(input.owner);
    if (policy.isErr()) return err(policy.error);
    if (policy.value.personaId !== input.personaId) {
      return err(new PolicyError('Incoming SIP persona does not match the configured voice persona'));
    }
    const reservation = this.callAdmission.reserve(input.owner.ownerId);
    if (reservation.isErr()) return err(reservation.error);
    this.pendingSetupReservations.add(reservation.value.id);
    try {
      return await this.createSessionInternal(
        input.owner,
        { transport: { type: 'sip', reference: input.providerSessionId, verified: true } },
        reservation.value,
        {
          transport,
          authority: 'sip',
          incoming: {
            callId: input.callId,
            providerSessionId: input.providerSessionId,
            admissionExpiresAt: input.admissionExpiresAt,
          },
          capturedPolicy: policy.value,
        },
      );
    } finally {
      this.pendingSetupReservations.delete(reservation.value.id);
      if (reservation.value.sessionId === undefined) {
        reservation.value.release();
      } else if (!this.runtimes.has(reservation.value.sessionId)) {
        this.releaseReservation(reservation.value.sessionId);
      }
    }
  }

  private async createSessionInternal(
    owner: VoiceOwnerContext,
    input: VoiceSessionCreateRequest,
    reservation: VoiceCallReservation,
    setup: {
      readonly transport: VoiceTransport;
      readonly authority: 'browser' | 'sip';
      readonly incoming?: {
        readonly callId: string;
        readonly providerSessionId: string;
        readonly admissionExpiresAt: number;
      };
      readonly capturedPolicy?: VoicePolicySnapshot;
    },
  ): VoiceAsyncResult<VoiceSessionCreateResult> {
    const setupGeneration = this.lifecycleGeneration;
    const policy = setup.capturedPolicy ? ok(setup.capturedPolicy) : this.capturePolicy(owner);
    if (policy.isErr()) return err(policy.error);
    const beforePersist = this.ensureSetupActive(
      owner,
      setupGeneration,
      setup.authority === 'sip',
      setup.incoming?.providerSessionId,
    );
    if (beforePersist) return err(beforePersist);
    const sessionId = uuidv4();
    const threadId = this.createThread(owner.ownerId, policy.value.personaId, sessionId);
    if (threadId.isErr()) return err(threadId.error);
    const history = this.readVoiceHistory(threadId.value);
    if (history.isErr()) return err(history.error);
    const now = this.now();
    const session: VoiceSessionRecord = {
      id: sessionId,
      revision: 0,
      owner,
      personaId: policy.value.personaId,
      threadId: threadId.value,
      transport: setup.transport.kind,
      status: 'connecting',
      ...(setup.incoming ? { providerSessionId: setup.incoming.providerSessionId } : {}),
      createdAt: now,
      deadlineAt: now + this.maxSessionLifetimeMs,
      policy: policy.value,
      usage: emptyUsage(),
      finalization: { status: 'pending' },
    };
    const persisted = this.options.store.createSession(session);
    if (persisted.isErr()) return err(persisted.error);
    const bound = reservation.bind(sessionId);
    if (bound.isErr()) {
      this.failSession(sessionId, persisted.value.revision, 'voice_admission_lost');
      return err(bound.error);
    }
    this.reservations.set(sessionId, bound.value);
    this.telemetry?.startCall({
      callId: sessionId,
      threadId: threadId.value,
      personaId: policy.value.personaId,
      provider: this.options.providerName,
      model: this.options.liveModelName ?? policy.value.modelName,
      transport: setup.transport.kind,
    });
    const beforeProvider = this.ensureSetupActive(
      owner,
      setupGeneration,
      setup.authority === 'sip',
      setup.incoming?.providerSessionId,
    );
    if (beforeProvider) {
      this.failSession(sessionId, persisted.value.revision, 'voice_admission_closed');
      return err(beforeProvider);
    }
    const setupBeforeProvider = this.ensureSetupSessionOpen(sessionId);
    if (setupBeforeProvider) return err(setupBeforeProvider);

    this.telemetry?.record({
      callId: sessionId,
      stage: 'provider_setup_started',
      status: 'started',
    });
    const providerSession = setup.incoming
      ? await this.options.provider.acceptIncomingSession!({
          sessionId,
          providerSessionId: setup.incoming.providerSessionId,
          modelName: this.options.liveModelName ?? policy.value.modelName,
          voice: policy.value.voiceName,
          admissionExpiresAt: setup.incoming.admissionExpiresAt,
          sessionExpiresAt: session.deadlineAt,
          instructions: composeVoiceInstructions(this.options.instructions, history.value),
          delegationMode: 'client',
        })
      : await this.options.provider.createSession({
          sessionId,
          ownerId: owner.ownerId,
          modelName: this.options.liveModelName ?? policy.value.modelName,
          instructions: composeVoiceInstructions(this.options.instructions, history.value),
          delegationMode: 'client',
          transport: input.transport,
          audio: { output: { voice: policy.value.voiceName } },
        });
    if (providerSession.isErr()) {
      this.failSession(sessionId, persisted.value.revision, 'provider_create_failed');
      return err(providerSession.error);
    }
    const cleanupAcceptedIncoming = async (
      attachedSideband?: LiveVoiceSideband,
    ): Promise<void> => {
      await this.closeProvider(providerSession.value.providerSessionId, false);
      if (setup.incoming && isFinalizationConfirmed(attachedSideband)) {
        this.options.onIncomingClosed?.(setup.incoming.callId);
      }
    };
    if (setup.incoming) {
      const registered = this.options.onIncomingAccepted!(setup.incoming.callId);
      if (registered.isErr() || !registered.value) {
        await cleanupAcceptedIncoming();
        this.failSession(sessionId, persisted.value.revision, 'incoming_authority_lost');
        return err(
          registered.isErr()
            ? registered.error
            : new PolicyError('Incoming SIP durable acceptance was not recorded'),
        );
      }
    }
    const setupAfterProvider = this.ensureSetupSessionOpen(sessionId);
    if (setupAfterProvider) {
      if (setup.incoming) await cleanupAcceptedIncoming();
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      return err(setupAfterProvider);
    }
    const providerIdentityValid =
      (providerSession.value.client.providerSessionId === undefined ||
        providerSession.value.providerSessionId === providerSession.value.client.providerSessionId) &&
      providerSession.value.client.sessionId === sessionId &&
      providerSession.value.client.transport === setup.transport.kind;
    if (!providerIdentityValid) {
      if (setup.incoming) await cleanupAcceptedIncoming();
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, persisted.value.revision, 'provider_session_identity_mismatch');
      return err(new PolicyError('Voice provider session descriptor does not match the session'));
    }
    const activeAfterProviderCreate = this.ensureSetupActive(
      owner,
      setupGeneration,
      setup.authority === 'sip',
      setup.incoming?.providerSessionId,
    );
    if (activeAfterProviderCreate) {
      if (setup.incoming) await cleanupAcceptedIncoming();
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, persisted.value.revision, 'voice_login_revoked');
      return err(activeAfterProviderCreate);
    }

    const withProvider = this.options.store.updateSession({
      sessionId,
      expectedRevision: persisted.value.revision,
      patch: { providerSessionId: providerSession.value.providerSessionId },
      updatedAt: this.now(),
    });
    if (withProvider.isErr()) {
      if (setup.incoming) await cleanupAcceptedIncoming();
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, persisted.value.revision, 'provider_session_persist_failed');
      return err(withProvider.error);
    }
    const setupBeforeSideband = this.ensureSetupSessionOpen(sessionId);
    if (setupBeforeSideband) {
      if (setup.incoming) await cleanupAcceptedIncoming();
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      return err(setupBeforeSideband);
    }

    const sideband = await this.options.provider.attachSideband(providerSession.value);
    if (sideband.isErr()) {
      if (setup.incoming) await cleanupAcceptedIncoming();
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, withProvider.value.revision, 'provider_sideband_failed');
      return err(sideband.error);
    }
    if (sideband.value.providerSessionId !== providerSession.value.providerSessionId) {
      if (setup.incoming) await cleanupAcceptedIncoming(sideband.value);
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, withProvider.value.revision, 'provider_sideband_identity_mismatch');
      return err(new PolicyError('Voice provider sideband identity does not match the session'));
    }
    const setupAfterSideband = this.ensureSetupSessionOpen(sessionId);
    if (setupAfterSideband) {
      if (!setup.incoming) await sideband.value.close(false);
      if (setup.incoming) await cleanupAcceptedIncoming(sideband.value);
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      return err(setupAfterSideband);
    }
    this.telemetry?.record({
      callId: sessionId,
      stage: 'provider_setup_completed',
      status: 'completed',
    });
    const activeAfterSideband = this.ensureSetupActive(
      owner,
      setupGeneration,
      setup.authority === 'sip',
      setup.incoming?.providerSessionId,
    );
    if (activeAfterSideband) {
      if (setup.incoming) await cleanupAcceptedIncoming(sideband.value);
      else await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, withProvider.value.revision, 'voice_login_revoked');
      return err(activeAfterSideband);
    }

    const runtime: SessionRuntime = {
      sideband: sideband.value,
      providerSessionId: providerSession.value.providerSessionId,
      transport: setup.transport,
      authority: setup.authority,
      ...(setup.incoming ? { incomingCallId: setup.incoming.callId } : {}),
      contextDiagnosticCorrelationId: diagnosticCorrelationIdForSideband(sideband.value),
      unsubscribeProvider: () => undefined,
      unsubscribeTransport: () => undefined,
      eventChain: Promise.resolve(),
      closing: false,
      listeners: new Set(),
      resultUnsubscribes: new Map(),
      handledOutputIds: new Set(),
      staleDelegationIds: new Set(),
      staleNoticeSent: new Set(),
    };
    runtime.unsubscribeProvider = sideband.value.onEvent((event) => {
      void this.receiveProviderEvent({
        sessionId,
        providerSessionId: providerSession.value.providerSessionId,
        event,
      });
    });
    runtime.unsubscribeTransport = setup.transport.onEvent(sessionId, (event) => {
      void this.receiveTransportEvent(sessionId, event);
    });
    this.runtimes.set(sessionId, runtime);

    const transport = await setup.transport.open({
      sessionId,
      ownerId: owner.ownerId,
      client: providerSession.value.client,
    });
    if (transport.isErr()) {
      await this.closeSession(owner, sessionId, { reason: 'transport_failure' });
      return err(transport.error);
    }
    const setupAfterTransport = this.ensureSetupSessionOpen(sessionId);
    if (setupAfterTransport) {
      await setup.transport.close(sessionId, 'setup_closed');
      return err(setupAfterTransport);
    }
    if (transport.value.sessionId !== sessionId || transport.value.kind !== setup.transport.kind) {
      await this.closeSession(owner, sessionId, { reason: 'transport_failure' });
      return err(new PolicyError('Voice transport handle does not match the session'));
    }
    this.telemetry?.record({
      callId: sessionId,
      stage: 'transport_connected',
      status: 'completed',
    });
    const activeAfterTransport = this.ensureSetupActive(
      owner,
      setupGeneration,
      setup.authority === 'sip',
      setup.incoming?.providerSessionId,
    );
    if (activeAfterTransport) {
      await this.closeSession(owner, sessionId, { reason: 'logout' });
      return err(activeAfterTransport);
    }

    const connected = this.options.store.updateSession({
      sessionId,
      expectedRevision: withProvider.value.revision,
      patch: { status: 'connected', startedAt: this.now() },
      updatedAt: this.now(),
    });
    if (connected.isErr()) {
      await this.closeSession(owner, sessionId, { reason: 'transport_failure' });
      return err(connected.error);
    }
    runtime.deadlineTimer = setTimeout(() => {
      void this.closeSession(owner, sessionId, { reason: 'deadline' });
    }, Math.max(1, connected.value.deadlineAt - this.now()));
    this.publishSession(connected.value);
    return ok({ session: connected.value, client: providerSession.value.client });
  }

  status(owner: VoiceOwnerContext, sessionId: VoiceSessionId): VoiceResult<VoiceSessionStatusDto | null> {
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return err(projection.error);
    if (!projection.value) return ok(null);
    if (projection.value.session.owner.ownerId !== owner.ownerId) return ok(null);
    const ownerError = this.ensureOwnerActive(owner);
    if (ownerError) return err(ownerError);
    return this.statusDto(projection.value);
  }

  async closeSession(
    owner: VoiceOwnerContext,
    sessionId: VoiceSessionId,
    input: VoiceSessionCloseRequest,
  ): VoiceAsyncResult<VoiceSessionCloseResult> {
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return err(projection.error);
    if (!projection.value) return err(new PolicyError('Voice session was not found'));
    if (!sameOwner(projection.value.session.owner, owner)) {
      return err(new PolicyError('Voice session owner does not match'));
    }
    const current = projection.value.session;
    if (current.status === 'closed' || current.status === 'expired' || current.status === 'failed') {
      return ok({ session: current, pendingDelegation: hasPendingDelegation(projection.value) });
    }

    const closing = this.options.store.updateSession({
      sessionId,
      expectedRevision: current.revision,
      patch: { status: 'closing', closingAt: this.now() },
      updatedAt: this.now(),
    });
    if (closing.isErr()) return err(closing.error);
    this.publishSession(closing.value);
    const pendingDelegation = this.skipUnclaimed(projection.value, closeReason(input.reason));

    const runtime = this.runtimes.get(sessionId);
    if (runtime?.deadlineTimer) clearTimeout(runtime.deadlineTimer);
    if (runtime) {
      runtime.closing = true;
      runtime.unsubscribeTransport();
      if (!pendingDelegation) {
        for (const unsubscribe of runtime.resultUnsubscribes.values()) unsubscribe();
        runtime.resultUnsubscribes.clear();
      }
      if (runtime.authority === 'sip') {
        // The provider's SIP hangup endpoint owns closure. Calling the generic
        // sideband close command here would turn an incoming call into a
        // browser-style session close before final usage arrives.
      } else {
        await runtime.sideband.close(input.reason !== 'transport_failure');
      }
      runtime.unsubscribeProvider();
    }
    await (runtime?.transport ?? this.transportFor(current.transport))?.close(sessionId, input.reason);
    if (current.providerSessionId) await this.closeProvider(current.providerSessionId, input.reason !== 'transport_failure');
    if (runtime) {
      // SIP final usage arrives while closeProvider waits for session.closed.
      // Persist it only after that wait, otherwise the terminal projection can
      // permanently retain the last non-final usage update.
      const finalUsage = latestSidebandUsage(runtime.sideband);
      if (finalUsage) this.persistUsage(sessionId, finalUsage);
    }

    const latest = this.options.store.readSession(sessionId);
    if (latest.isErr()) return err(latest.error);
    const finalCurrent = latest.value?.session ?? closing.value;
    const terminalStatus = input.reason === 'deadline' ? 'expired' : input.reason === 'transport_failure' ? 'failed' : 'closed';
    const finalization = finalizationFromRuntime(runtime, latestSidebandUsage(runtime?.sideband));
    const terminal = this.options.store.updateSession({
      sessionId,
      expectedRevision: finalCurrent.revision,
      patch: {
        status: terminalStatus,
        closedAt: this.now(),
        usage: applyVoiceCost(finalCurrent.usage, this.usdPerMinute, finalization.status),
        finalization,
        ...(pendingDelegation ? {} : { activeDelegationId: undefined }),
      },
      updatedAt: this.now(),
    });
    if (terminal.isErr()) return err(terminal.error);
    this.telemetry?.finishCall(
      sessionId,
      terminalStatus === 'closed' ? 'closed' : 'incomplete',
    );
    // Keep a runtime shell while claimed/running work is unresolved so an
    // already-open status stream can receive the retained result after hangup.
    // Provider and transport listeners were removed above; only result/status
    // delivery remains until the terminal result arrives.
    this.releaseReservation(sessionId);
    this.publishSession(terminal.value);
    if (
      runtime?.authority === 'sip' &&
      runtime.incomingCallId &&
      finalization.status === 'confirmed'
    ) {
      this.options.onIncomingClosed?.(runtime.incomingCallId);
    }
    if (!pendingDelegation) this.runtimes.delete(sessionId);
    return ok({ session: terminal.value, pendingDelegation });
  }

  async notifyThread(input: VoiceNotificationRequest): VoiceAsyncResult<VoiceNotificationResult> {
    const text = input.text.trim();
    if (text.length === 0) return err(new PolicyError('Voice notification text is empty'));
    if (text.length > MAX_VOICE_NOTIFICATION_CHARS) {
      return err(new PolicyError('Voice notification text exceeds the bounded delivery limit'));
    }
    const notificationId = input.messageId?.trim() || randomUUID();

    const sessions = this.options.store.listSessions({});
    if (sessions.isErr()) return err(sessions.error);
    const matching = sessions.value
      .filter((candidate) => candidate.session.threadId === input.threadId)
      .sort((left, right) => {
        const createdAt = right.session.createdAt - left.session.createdAt;
        return createdAt !== 0 ? createdAt : right.session.id.localeCompare(left.session.id);
      });
    if (matching.length === 0) return err(new PolicyError('Voice thread was not found'));
    const projection = matching.find(
      (candidate) => {
        const runtime = this.runtimes.get(candidate.session.id);
        return (
          candidate.session.status === 'connected' &&
          candidate.session.deadlineAt > this.now() &&
          runtime !== undefined &&
          this.ensureRuntimeOwnerActive(runtime, candidate.session.owner) === undefined
        );
      },
    );
    const selectedProjection = projection ?? matching[0];
    if (!selectedProjection) return err(new PolicyError('Voice thread was not found'));
    const session = selectedProjection.session;
    const sourceRunId = input.sourceRunId?.trim() || undefined;
    let sourceDelegation: VoiceDelegationRecord | undefined;
    let sourceLookupFailed = false;
    if (sourceRunId) {
      const source = this.options.store.findDelegationByRunId(sourceRunId);
      if (source.isErr()) {
        sourceLookupFailed = true;
        this.options.logger?.warn(
          { sourceRunId, threadId: input.threadId, cause: source.error },
          'voice notification provenance lookup failed; suppressing speech',
        );
      } else {
        sourceDelegation = source.value ?? undefined;
      }
    }
    const runtime = this.runtimes.get(session.id);
    if (
      !runtime ||
      session.status !== 'connected' ||
      session.deadlineAt <= this.now()
    ) {
      return ok({ sessionId: session.id, notificationId, speechRequested: false });
    }

    let outcome: VoiceResult<VoiceNotificationResult> = ok({
      sessionId: session.id,
      notificationId,
      speechRequested: false,
    });
    const run = runtime.eventChain
      .catch(() => undefined)
      .then(async () => {
        const latest = this.options.store.findSession(session.id);
        if (latest.isErr()) {
          outcome = err(latest.error);
          return;
        }
        if (
          !latest.value ||
          latest.value.threadId !== input.threadId ||
          latest.value.status !== 'connected' ||
          latest.value.deadlineAt <= this.now() ||
          runtime.closing ||
          this.runtimes.get(session.id) !== runtime
        ) {
          outcome = ok({ sessionId: session.id, notificationId, speechRequested: false });
          return;
        }
        const activeOwnerError = this.ensureRuntimeOwnerActive(runtime, latest.value.owner);
        const sourceBelongsToCurrentSession =
          sourceDelegation !== undefined &&
          sourceDelegation.sessionId === session.id &&
          sourceDelegation.request.threadId === input.threadId;
        const suppressSpeech =
          sourceLookupFailed ||
          (sourceDelegation !== undefined &&
            (!sourceBelongsToCurrentSession ||
              runtime.staleDelegationIds.has(sourceDelegation.id) ||
              this.delegationContextInvalidated(runtime, sourceDelegation)));
        const output: VoiceNotificationStatusDto = {
          id: notificationId,
          text,
          createdAt: this.now(),
        };
        let speechRequested = false;
        if (!activeOwnerError && !suppressSpeech) {
          try {
            const sent = await runtime.sideband.send({
              kind: 'instruction',
              delegationId: null,
              content: text,
              outputId: output.id,
            });
            if (sent.isOk()) {
              speechRequested = true;
            } else {
              this.options.logger?.warn(
                { sessionId: session.id, cause: sent.error },
                'voice notification speech delivery failed; retaining text notification',
              );
            }
          } catch (cause) {
            this.options.logger?.warn(
              { sessionId: session.id, cause },
              'voice notification speech delivery threw; retaining text notification',
            );
          }
        }
        outcome = ok({ sessionId: session.id, notificationId, speechRequested });
        this.publish(runtime, {
          kind: 'notification',
          version: latest.value.revision,
          notification: output,
          occurredAt: this.now(),
        });
      });
    runtime.eventChain = run;
    await run;
    return outcome;
  }

  receiveProviderEvent(input: {
    readonly sessionId: VoiceSessionId;
    readonly providerSessionId: string;
    readonly event: LiveVoiceEvent;
  }): VoiceAsyncResult<void> {
    const runtime = this.runtimes.get(input.sessionId);
    if (!runtime || runtime.providerSessionId !== input.providerSessionId) {
      return Promise.resolve(err(new PolicyError('Voice provider session is no longer active')));
    }
    let outcome: VoiceResult<void> = ok(undefined);
    const run = runtime.eventChain
      .catch(() => undefined)
      .then(async () => {
        outcome = await this.handleProviderEvent(input.sessionId, input.event);
      });
    runtime.eventChain = run;
    return run.then(() => outcome);
  }

  reportPlayback(
    owner: VoiceOwnerContext,
    sessionId: VoiceSessionId,
    report: VoicePlaybackReport,
  ): VoiceAsyncResult<void> {
    const ownerError = this.ensureOwnerActive(owner);
    if (ownerError) return Promise.resolve(err(ownerError));
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return Promise.resolve(err(projection.error));
    if (!projection.value || !sameOwner(projection.value.session.owner, owner)) {
      return Promise.resolve(err(new PolicyError('Voice session owner does not match')));
    }
    const output = projection.value.outputs.find((candidate) => candidate.id === report.outputId);
    if (!output) return Promise.resolve(err(new PolicyError('Voice output was not found')));
    const lifecycle: VoiceOutputLifecycle = {
      ...output.lifecycle,
      playback:
        report.status === 'started'
          ? 'playing'
          : report.status === 'played'
            ? 'played'
            : 'interrupted',
    };
    const saved = this.options.store.recordOutputLifecycle({
      delegationId: output.delegationId,
      outputId: report.outputId,
      lifecycle,
    });
    if (saved.isErr()) return Promise.resolve(err(saved.error));
    this.publishDelegation(sessionId, output.delegationId);
    return Promise.resolve(ok(undefined));
  }

  subscribe(
    owner: VoiceOwnerContext,
    sessionId: VoiceSessionId,
    handler: VoiceEventHandler<VoiceStatusEventDto>,
  ): VoiceResult<VoiceUnsubscribe> {
    const ownerError = this.ensureOwnerActive(owner);
    if (ownerError) return err(ownerError);
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return err(projection.error);
    if (!projection.value || projection.value.session.owner.ownerId !== owner.ownerId) {
      return err(new PolicyError('Voice session owner does not match'));
    }
    const status = this.statusDto(projection.value);
    if (status.isErr()) return err(status.error);
    const runtime = this.runtimes.get(sessionId);
    const event: VoiceStatusEventDto = {
      kind: 'session',
      version: projection.value.session.revision,
      session: status.value,
      occurredAt: this.now(),
    };
    if (!runtime) {
      try {
        void Promise.resolve(handler(event)).catch(() => undefined);
      } catch {
        // A retained snapshot listener cannot affect the session.
      }
      return ok(() => undefined);
    }
    runtime.listeners.add(handler);
    try {
      void Promise.resolve(handler(event)).catch(() => undefined);
    } catch {
      // A status listener cannot affect the session.
    }
    return ok(() => runtime.listeners.delete(handler));
  }

  /** Begin a reload transaction before mutable persona/skill state changes. */
  closeAdmission(): void {
    this.admissionOpen = false;
  }

  openAdmission(): void {
    this.admissionOpen = true;
  }

  bumpGeneration(): number {
    this.lifecycleGeneration += 1;
    return this.lifecycleGeneration;
  }

  invalidateAuthRuntime(): void {
    // Auth is supplied as a callback so the service can also be used with a
    // non-cookie authority in tests. A reload always invalidates the callback
    // boundary by closing admission until the caller reopens it.
    this.admissionOpen = false;
  }

  async shutdown(): Promise<void> {
    this.closeAdmission();
    const projections = this.options.store.listSessions({});
    if (projections.isErr()) return;
    const sessionIds = projections.value
      .filter(
        (projection) =>
          !['closed', 'expired', 'failed'].includes(projection.session.status) ||
          hasPendingDelegation(projection),
      )
      .map((projection) => projection.session.id);
    const closes = projections.value
      .filter((projection) => !['closed', 'expired', 'failed'].includes(projection.session.status))
      .map((projection) =>
        this.closeSession(projection.session.owner, projection.session.id, { reason: 'shutdown' }),
      );
    await withTimeout(Promise.allSettled(closes), this.shutdownTimeoutMs);
    await withTimeout(this.waitForTerminalResults(sessionIds), this.shutdownTimeoutMs);
    this.telemetry?.shutdown();
  }

  private async waitForTerminalResults(sessionIds: readonly string[]): Promise<void> {
    const deadline = this.now() + this.shutdownTimeoutMs;
    for (;;) {
      let active = false;
      for (const sessionId of sessionIds) {
        const projection = this.options.store.readSession(sessionId);
        if (projection.isErr() || !projection.value) continue;
        if (projection.value.delegations.some((delegation) => delegation.status === 'claimed' || delegation.status === 'running')) {
          active = true;
          break;
        }
      }
      if (!active || this.now() >= deadline) return;
      await delay(25);
    }
  }

  private capturePolicy(owner: VoiceOwnerContext): VoiceResult<VoicePolicySnapshot> {
    if (this.options.capturePolicy) return this.options.capturePolicy(owner);
    return this.options.policy.capture({
      generation: this.generation(),
      ownerId: owner.ownerId,
      personaId: this.options.personaId,
      providerName: this.options.providerName ?? this.options.modelName,
      modelName: this.options.modelName,
      voiceName: this.options.voiceName,
      capabilityNames: [],
      allowedToolNames: [],
      allowedMcpServerNames: [],
      nativeToolNames: [],
      requireApproval: false,
      loginRevision: owner.loginRevision,
    });
  }

  private currentPolicy(
    owner: VoiceOwnerContext,
    session: VoiceSessionRecord,
  ): VoiceResult<VoicePolicySnapshot> {
    if (this.options.currentPolicy) return this.options.currentPolicy(owner, session);
    return this.capturePolicy(owner);
  }

  private transportFor(kind: VoiceTransportKind): VoiceTransport | undefined {
    if (this.options.transport.kind === kind) return this.options.transport;
    return this.options.transports?.get(kind);
  }

  private ensureOwnerActive(
    owner: VoiceOwnerContext,
    skipBrowserAuthorization = false,
  ): TalonError | undefined {
    if (this.options.authorization && !skipBrowserAuthorization) {
      const grant = resolveExactVoiceGrant(this.options.authorization, owner);
      if (grant.isErr()) return grant.error;
    }
    if (!skipBrowserAuthorization && this.options.isOwnerActive && !this.options.isOwnerActive(owner)) {
      return new PolicyError('Voice login is no longer active');
    }
    return undefined;
  }

  private ensureSetupActive(
    owner: VoiceOwnerContext,
    setupGeneration: number,
    skipBrowserAuthorization = false,
    incomingProviderSessionId?: string,
  ): TalonError | undefined {
    if (!this.admissionOpen || this.lifecycleGeneration !== setupGeneration) {
      return new PolicyError('Voice session admission is closed');
    }
    if (skipBrowserAuthorization && incomingProviderSessionId) {
      if (!this.options.isIncomingOwnerActive) {
        return new PolicyError('Incoming SIP authority check is required');
      }
      if (!this.options.isIncomingOwnerActive(owner, incomingProviderSessionId)) {
        return new PolicyError('Incoming SIP authority is no longer active');
      }
    }
    return this.ensureOwnerActive(owner, skipBrowserAuthorization);
  }

  private ensureRuntimeOwnerActive(
    runtime: SessionRuntime,
    owner: VoiceOwnerContext,
  ): TalonError | undefined {
    if (
      runtime.authority === 'sip' &&
      (!this.options.isIncomingOwnerActive ||
        !this.options.isIncomingOwnerActive(owner, runtime.providerSessionId))
    ) {
      return new PolicyError('Incoming SIP authority is no longer active');
    }
    return this.ensureOwnerActive(owner, runtime.authority === 'sip');
  }

  private ensureSetupSessionOpen(sessionId: VoiceSessionId): TalonError | undefined {
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return projection.error;
    if (!projection.value) return new PolicyError('Voice session was not found');
    if (['closing', 'closed', 'expired', 'failed'].includes(projection.value.session.status)) {
      return new PolicyError('Voice session setup was closed');
    }
    return undefined;
  }

  private createThread(ownerId: string, personaId: string, sessionId: string): VoiceResult<string> {
    if (!this.options.threadRepository || !this.options.channelId) return ok(sessionId);
    const externalId = createVoiceThreadExternalId(ownerId, personaId);
    const metadata = createSharedVoiceThreadMetadata(ownerId, personaId);
    const existing = this.options.threadRepository.findByExternalId(
      this.options.channelId,
      externalId,
    );
    if (existing.isErr()) return err(existing.error);
    if (existing.value)
      return this.validateSharedThread(
        existing.value.id,
        existing.value.metadata,
        externalId,
        ownerId,
        personaId,
      );

    const inserted = this.options.threadRepository.insert({
      id: uuidv4(),
      channel_id: this.options.channelId,
      external_id: externalId,
      metadata: JSON.stringify(metadata),
    });
    if (inserted.isOk()) return ok(inserted.value.id);

    // Another creator may have won the UNIQUE(channel_id, external_id) race.
    // Re-read and validate the winner before reusing it.
    const raced = this.options.threadRepository.findByExternalId(
      this.options.channelId,
      externalId,
    );
    if (raced.isOk() && raced.value) {
      return this.validateSharedThread(
        raced.value.id,
        raced.value.metadata,
        externalId,
        ownerId,
        personaId,
      );
    }
    return err(inserted.error);
  }

  private validateSharedThread(
    threadId: string,
    metadata: string,
    externalId: string,
    ownerId: string,
    personaId: string,
  ): VoiceResult<string> {
    const parsed = parseSharedVoiceThreadMetadata(metadata, externalId);
    if (!parsed || parsed.ownerId !== ownerId || parsed.personaId !== personaId) {
      return err(
        new PolicyError('Voice thread ownership metadata does not match the authenticated call'),
      );
    }
    return ok(threadId);
  }

  private readVoiceHistory(threadId: string): VoiceResult<string> {
    if (!this.options.messageRepository) return ok('');
    const recovered = this.recoverBackendHistory(threadId);
    if (recovered.isErr()) return err(recovered.error);
    const rows = this.options.messageRepository.findLatestByThread(
      threadId,
      DEFAULT_VOICE_HISTORY_ROWS,
    );
    if (rows.isErr()) return err(rows.error);
    return ok(
      formatVoiceHistory(rows.value, {
        maxCharacters: Math.min(this.maxContextChars, DEFAULT_VOICE_HISTORY_CHARACTERS),
      }),
    );
  }

  private recoverBackendHistory(threadId: string): VoiceResult<void> {
    const messageRepository = this.options.messageRepository;
    if (!messageRepository?.insert) return ok(undefined);
    const sessions = this.options.store.listSessions({ threadId });
    if (sessions.isErr()) return err(sessions.error);

    const candidates: Array<{
      readonly delegation: VoiceDelegationRecord;
      readonly result: VoiceBackendResult;
      readonly content: string;
    }> = [];
    for (const projection of sessions.value) {
      for (const delegation of projection.delegations) {
        const result = this.recoverableBackendResult(projection, delegation);
        if (!result) continue;
        if (result.execution === 'succeeded' && result.output.delivery === 'not_requested') {
          continue;
        }
        const content = this.backendResultContent(result);
        if (!content) continue;
        candidates.push({ delegation, result, content });
      }
    }

    candidates.sort((left, right) => {
      const occurredAt = left.result.occurredAt - right.result.occurredAt;
      return occurredAt !== 0 ? occurredAt : left.result.outputId.localeCompare(right.result.outputId);
    });
    for (const candidate of candidates.slice(-DEFAULT_VOICE_HISTORY_ROWS)) {
      const persisted = this.persistBackendResult(
        candidate.delegation,
        candidate.result,
        candidate.content,
      );
      if (persisted.isErr()) return persisted;
    }
    return ok(undefined);
  }

  private recoverableBackendResult(
    projection: VoiceSessionReadProjection,
    delegation: VoiceDelegationRecord,
  ): VoiceBackendResult | null {
    if (
      delegation.execution !== 'succeeded' &&
      delegation.execution !== 'failed' &&
      delegation.execution !== 'unknown'
    ) {
      return null;
    }
    const outputs = projection.outputs
      .filter((output) => output.delegationId === delegation.id)
      .sort((left, right) => left.createdAt - right.createdAt);
    if (delegation.execution === 'succeeded') {
      const final = outputs
        .filter((output) => output.kind === 'final' && output.lifecycle.execution === 'succeeded')
        .at(-1);
      if (!final || !final.text?.trim()) return null;
      return {
        delegationId: delegation.id,
        outputId: final.id,
        kind: 'final',
        text: final.text,
        execution: 'succeeded',
        output: final.lifecycle,
        occurredAt: final.createdAt,
      };
    }

    const latest = outputs
      .filter((output) => output.lifecycle.execution === delegation.execution)
      .at(-1);
    return {
      delegationId: delegation.id,
      outputId: latest?.id ?? `voice-terminal:${delegation.id}:${delegation.execution}`,
      kind: delegation.execution === 'failed' ? 'error' : 'unknown',
      ...(latest?.text !== undefined ? { text: latest.text } : {}),
      execution: delegation.execution,
      output: latest?.lifecycle ?? delegation.output,
      occurredAt: latest?.createdAt ?? delegation.completedAt ?? delegation.createdAt,
    };
  }

  private async handleProviderEvent(sessionId: string, event: LiveVoiceEvent): Promise<VoiceResult<void>> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return err(new PolicyError('Voice session is no longer active'));
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return err(projection.error);
    if (!projection.value) return err(new PolicyError('Voice session was not found'));
    const session = projection.value.session;
    if (
      ['closed', 'expired', 'failed'].includes(session.status) ||
      (session.status === 'closing' && event.kind !== 'usage' && event.kind !== 'session_closed')
    ) {
      return ok(undefined);
    }
    if (event.kind === 'transcript') {
      return this.handleTranscriptEvent(sessionId, runtime, event);
    }
    if (event.kind === 'usage') {
      return this.persistUsage(sessionId, event.update);
    }
    if (event.kind === 'provider_acknowledgement') {
      const internalDelegation = projection.value.delegations.find(
        (delegation) => delegation.providerDelegationId === event.delegationId,
      );
      if (!internalDelegation) return ok(undefined);
      return this.recordProviderAcknowledgement(sessionId, internalDelegation.id, event.outputId);
    }
    if (event.kind === 'session_closed') {
      if (event.usage) {
        const usage = this.persistUsage(sessionId, event.usage);
        if (usage.isErr()) return usage;
      }
      if (session.status === 'closing') return ok(undefined);
      await this.closeSession(session.owner, sessionId, { reason: 'hangup' });
      return ok(undefined);
    }
    if (event.kind === 'error') {
      this.publishError(sessionId, event.code, event.message);
      return ok(undefined);
    }
    return this.handleDelegation(sessionId, event.proposal);
  }

  private async handleTranscriptEvent(
    sessionId: string,
    runtime: SessionRuntime,
    event: Extract<LiveVoiceEvent, { readonly kind: 'transcript' }>,
  ): Promise<VoiceResult<void>> {
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return err(projection.error);
    if (!projection.value) return err(new PolicyError('Voice session was not found'));
    const persisted = this.persistTranscript(projection.value.session, event.fragment);
    if (persisted.isErr()) return err(persisted.error);

    for (const delegation of projection.value.delegations) {
      const terminalWithPendingDelivery =
        (delegation.status === 'completed' ||
          delegation.status === 'failed' ||
          delegation.status === 'unknown') &&
        this.hasUndeliveredOutput(runtime, projection.value, delegation);
      if (
        delegation.status !== 'admitted' &&
        delegation.status !== 'queued' &&
        delegation.status !== 'claimed' &&
        delegation.status !== 'running' &&
        !terminalWithPendingDelivery
      ) {
        continue;
      }
      const invalidated = this.delegationContextInvalidated(runtime, delegation);
      if (!invalidated) continue;

      if (
        delegation.status === 'claimed' ||
        delegation.status === 'running' ||
        terminalWithPendingDelivery
      ) {
        runtime.staleDelegationIds.add(delegation.id);
        await this.sendStaleNotice(runtime, delegation, terminalWithPendingDelivery);
        continue;
      }

      const skipped = this.skipInvalidatedDelegation(sessionId, delegation);
      if (skipped.isErr()) return err(skipped.error);
      if (!skipped.value) continue;
      this.publishDelegation(sessionId, skipped.value.delegation.id);
      if (skipped.value.clearedActive) this.publishSession(skipped.value.session);
      await sendClarification(
        runtime.sideband,
        delegation.providerDelegationId,
        'The transcript changed before that request could start. Please repeat it.',
      );
    }
    return ok(undefined);
  }

  private persistTranscript(
    session: VoiceSessionRecord,
    fragment: VoiceTranscriptFragment,
  ): VoiceResult<void> {
    const messageRepository = this.options.messageRepository;
    if (!messageRepository?.upsertVoiceTranscript) return ok(undefined);
    const state = fragment.kind === 'delta' ? 'incomplete' : 'completed';
    const content = JSON.stringify({
      body: fragment.text,
      voice: {
        kind: 'transcript',
        sessionId: session.id,
        fragmentId: fragment.id,
        role: fragment.role,
        state,
        sequence: fragment.sequence,
      },
    });
    const persisted = messageRepository.upsertVoiceTranscript({
      id: randomUUID(),
      thread_id: session.threadId,
      direction: fragment.role === 'user' ? 'inbound' : 'outbound',
      content,
      idempotency_key: voiceTranscriptIdempotencyKey(session.id, fragment.role, fragment.id),
      provider_id: fragment.id,
      run_id: null,
    });
    if (persisted.isErr()) return err(persisted.error);
    return ok(undefined);
  }

  private persistBackendResult(
    delegation: VoiceDelegationRecord,
    result: VoiceBackendResult,
    content: string,
  ): VoiceResult<void> {
    const messageRepository = this.options.messageRepository;
    if (!messageRepository?.insert) return ok(undefined);
    if (
      result.execution !== 'succeeded' &&
      result.execution !== 'failed' &&
      result.execution !== 'unknown'
    ) {
      return ok(undefined);
    }
    if (content.trim().length === 0) return ok(undefined);
    const resultKind =
      result.kind === 'final' || result.kind === 'error' || result.kind === 'unknown'
        ? result.kind
        : undefined;
    if (!resultKind) return ok(undefined);
    const historyOutputId =
      resultKind === 'final'
        ? result.outputId
        : `voice-terminal:${delegation.id}:${result.execution}`;
    const persisted = messageRepository.insert({
      id: randomUUID(),
      thread_id: delegation.request.threadId,
      direction: 'outbound',
      content: JSON.stringify({
        body: content,
        voice: {
          kind: 'backend_result',
          sessionId: delegation.sessionId,
          delegationId: delegation.id,
          outputId: historyOutputId,
          execution: result.execution,
          resultKind,
          verified: true,
        },
      }),
      idempotency_key: voiceBackendResultIdempotencyKey(
        delegation.sessionId,
        delegation.id,
        historyOutputId,
      ),
      provider_id: historyOutputId,
      run_id: delegation.runId ?? null,
    });
    if (persisted.isErr()) return err(persisted.error);
    return ok(undefined);
  }

  private skipInvalidatedDelegation(
    sessionId: string,
    delegation: VoiceDelegationRecord,
  ): VoiceResult<{ readonly delegation: VoiceDelegationRecord; readonly session: VoiceSessionRecord; readonly clearedActive: boolean } | null> {
    return this.options.store.runInTransaction((transaction) => {
      const current = transaction.findDelegation(delegation.id);
      if (current.isErr()) return err(current.error);
      if (
        !current.value ||
        (current.value.status !== 'admitted' && current.value.status !== 'queued')
      ) {
        return ok(null);
      }
      const skipped = transaction.skipDelegation({
        delegationId: current.value.id,
        expectedRevision: current.value.revision,
        // The frozen skip CAS has lifecycle reasons only; an invalidated
        // provider context is a non-retryable shutdown-style skip.
        reason: 'shutdown',
        skippedAt: this.now(),
      });
      if (skipped.isErr()) return err(skipped.error);
      const currentSession = transaction.findSession(sessionId);
      if (currentSession.isErr()) return err(currentSession.error);
      if (!currentSession.value) return err(new PolicyError('Voice session was not found'));
      if (currentSession.value.activeDelegationId !== current.value.id) {
        return ok({ delegation: skipped.value, session: currentSession.value, clearedActive: false });
      }
      const cleared = transaction.updateSession({
        sessionId,
        expectedRevision: currentSession.value.revision,
        patch: { activeDelegationId: undefined },
        updatedAt: this.now(),
      });
      if (cleared.isErr()) return err(cleared.error);
      return ok({ delegation: skipped.value, session: cleared.value, clearedActive: true });
    });
  }

  private async handleDelegation(
    sessionId: string,
    proposal: { readonly providerDelegationId: string; readonly offsetMs: number; readonly receivedAt: number },
  ): Promise<VoiceResult<void>> {
    const runtime = this.runtimes.get(sessionId);
    const projection = this.options.store.readSession(sessionId);
    if (!runtime) return err(new PolicyError('Voice session is no longer active'));
    if (projection.isErr()) return err(projection.error);
    if (!projection.value) return err(new PolicyError('Voice session was not found'));
    const session = projection.value.session;
    if (projection.value.delegations.some((delegation) => delegation.providerDelegationId === proposal.providerDelegationId)) {
      await sendClarification(runtime.sideband, proposal.providerDelegationId, 'I already received that request. Please make a new request if you still need help.');
      return ok(undefined);
    }
    if (session.status !== 'connected') {
      await sendClarification(runtime.sideband, proposal.providerDelegationId, 'The previous request is still being handled.');
      return ok(undefined);
    }
    if (session.deadlineAt <= this.now()) {
      await this.closeSession(session.owner, sessionId, { reason: 'deadline' });
      return ok(undefined);
    }
    const ownerError = this.ensureRuntimeOwnerActive(runtime, session.owner);
    if (ownerError) {
      await this.closeSession(session.owner, sessionId, { reason: 'logout' });
      return ok(undefined);
    }
    const contextInspection = this.inspectContextForDelegation(
      runtime.sideband,
      proposal.providerDelegationId,
    );
    const contextResult = contextInspection.context;
    if (!contextResult) {
      this.logContextRejection(runtime, contextInspection.reason);
      await sendClarification(
        runtime.sideband,
        proposal.providerDelegationId,
        'I could not capture a reliable transcript for that request. Please repeat it briefly.',
      );
      return ok(undefined);
    }
    const boundedContext = contextResult;
    const currentPolicy = this.currentPolicy(session.owner, session);
    if (currentPolicy.isErr()) {
      await sendClarification(runtime.sideband, proposal.providerDelegationId, 'This request is not currently permitted.');
      return ok(undefined);
    }
    const eligibility = this.options.policy.checkExecution({
      session,
      admitted: session.policy,
      current: currentPolicy.value,
      now: this.now(),
    });
    if (eligibility.isErr() || !eligibility.value.eligible) {
      await sendClarification(runtime.sideband, proposal.providerDelegationId, 'This request is no longer permitted.');
      return ok(undefined);
    }
    const activeDelegation = findPendingDelegation(session, projection.value.delegations);
    if (activeDelegation) {
      if (
        activeDelegation.contextVersion === boundedContext.version &&
        activeDelegation.contextDigest === boundedContext.digest
      ) {
        await sendClarification(runtime.sideband, proposal.providerDelegationId, 'The previous request is still being handled.');
        return ok(undefined);
      }
      const replacement = this.supersedePendingDelegation(
        session,
        activeDelegation,
        proposal,
        boundedContext,
      );
      if (replacement.isErr()) {
        await sendClarification(runtime.sideband, proposal.providerDelegationId, 'I could not safely update that request. Please repeat it.');
        return ok(undefined);
      }
      if (replacement.value.outcome !== 'replaced') {
        await sendClarification(runtime.sideband, proposal.providerDelegationId, 'The previous request has already started. Please wait for its result.');
        return ok(undefined);
      }
      this.publishDelegation(sessionId, replacement.value.original.id);
      this.publishDelegation(sessionId, replacement.value.replacement.id);
      return this.attachBackendResult(
        runtime,
        replacement.value.request,
        replacement.value.session,
        true,
      );
    }
    const request: VoiceBackendRequest = {
      sessionId,
      delegationId: uuidv4(),
      providerDelegationId: proposal.providerDelegationId,
      threadId: session.threadId,
      personaId: session.personaId,
      context: boundedContext,
      policy: session.policy,
      requestedAt: this.now(),
    };
    const admissionOwnerError = this.ensureRuntimeOwnerActive(runtime, session.owner);
    if (admissionOwnerError) {
      await this.closeSession(session.owner, sessionId, { reason: 'logout' });
      return ok(undefined);
    }
    const admitted = await this.options.backendBridge.admit(request);
    if (admitted.isErr()) {
      this.telemetry?.record({
        callId: sessionId,
        stage: 'admission',
        status: 'rejected',
        providerDelegationId: proposal.providerDelegationId,
      });
      await sendClarification(runtime.sideband, proposal.providerDelegationId, 'I could not safely queue that request. Please repeat it.');
      return ok(undefined);
    }
    const latest = this.options.store.readSession(sessionId);
    if (latest.isErr()) return err(latest.error);
    if (!latest.value) return err(new PolicyError('Voice session was not found'));
    const admittedDelegation = this.options.store.findDelegation(request.delegationId);
    if (admittedDelegation.isErr()) return err(admittedDelegation.error);
    if (!admittedDelegation.value) return err(new PolicyError('Voice delegation was not found'));
    const canOwnActiveDelegation =
      latest.value.session.status === 'connected' &&
      latest.value.session.deadlineAt > this.now() &&
      latest.value.session.activeDelegationId === undefined;
    if (
      !canOwnActiveDelegation &&
      (admittedDelegation.value.status === 'admitted' || admittedDelegation.value.status === 'queued')
    ) {
      const skipped = this.options.store.skipDelegation({
        delegationId: request.delegationId,
        expectedRevision: admittedDelegation.value.revision,
        reason:
          latest.value.session.status === 'connected' && latest.value.session.deadlineAt <= this.now()
            ? 'deadline'
            : 'hangup',
        skippedAt: this.now(),
      });
      if (skipped.isOk()) this.publishDelegation(sessionId, request.delegationId);
      await sendClarification(runtime.sideband, proposal.providerDelegationId, 'The voice session changed before that request could start. Please try again.');
      return ok(undefined);
    }
    let activeSession = latest.value.session;
    let ownsActiveDelegation = canOwnActiveDelegation;
    if (canOwnActiveDelegation) {
      const claimedActive = this.options.store.updateSession({
        sessionId,
        expectedRevision: latest.value.session.revision,
        patch: { activeDelegationId: request.delegationId },
        updatedAt: this.now(),
      });
      if (claimedActive.isErr()) {
        const raced = this.options.store.readSession(sessionId);
        if (raced.isErr()) return err(raced.error);
        if (!raced.value) return err(new PolicyError('Voice session was not found'));
        activeSession = raced.value.session;
        const racedDelegation = this.options.store.findDelegation(request.delegationId);
        if (racedDelegation.isErr()) return err(racedDelegation.error);
        if (!racedDelegation.value) return err(new PolicyError('Voice delegation was not found'));
        if (racedDelegation.value.status === 'admitted' || racedDelegation.value.status === 'queued') {
          const skipped = this.options.store.skipDelegation({
            delegationId: request.delegationId,
            expectedRevision: racedDelegation.value.revision,
            reason: activeSession.deadlineAt <= this.now() ? 'deadline' : 'hangup',
            skippedAt: this.now(),
          });
          if (skipped.isOk()) this.publishDelegation(sessionId, request.delegationId);
          await sendClarification(runtime.sideband, proposal.providerDelegationId, 'The voice session changed before that request could start. Please try again.');
          return ok(undefined);
        }
        if (racedDelegation.value.status === 'skipped' || racedDelegation.value.status === 'superseded') {
          await sendClarification(runtime.sideband, proposal.providerDelegationId, 'The voice session changed before that request could start. Please try again.');
          return ok(undefined);
        }
        ownsActiveDelegation = false;
      } else {
        activeSession = claimedActive.value;
      }
    }
    return this.attachBackendResult(runtime, request, activeSession, ownsActiveDelegation);
  }

  private supersedePendingDelegation(
    session: VoiceSessionRecord,
    original: VoiceDelegationRecord,
    proposal: { readonly providerDelegationId: string; readonly offsetMs: number; readonly receivedAt: number },
    context: VoiceContextSnapshot,
  ): VoiceResult<
    | {
        readonly outcome: 'replaced';
        readonly request: VoiceBackendRequest;
        readonly session: VoiceSessionRecord;
        readonly original: VoiceDelegationRecord;
        readonly replacement: VoiceDelegationRecord;
      }
    | {
        readonly outcome: 'not_replaceable';
        readonly reason: Extract<VoiceSupersedeResult, { readonly outcome: 'not_replaceable' }>['reason'];
      }
  > {
    const request: VoiceBackendRequest = {
      sessionId: session.id,
      delegationId: uuidv4(),
      providerDelegationId: proposal.providerDelegationId,
      threadId: session.threadId,
      personaId: session.personaId,
      context,
      policy: session.policy,
      requestedAt: this.now(),
    };
    const queueItemId = uuidv4();
    const replacement: VoiceDelegationRecord & { readonly supersedesDelegationId: string } = {
      id: request.delegationId,
      sessionId: session.id,
      providerDelegationId: request.providerDelegationId,
      revision: 0,
      contextVersion: context.version,
      contextDigest: context.digest,
      request,
      status: 'admitted',
      execution: 'not_started',
      output: initialOutputLifecycle(),
      queueItemId,
      supersedesDelegationId: original.id,
      createdAt: request.requestedAt,
    };
    // The original queue row and replacement reservation must commit together;
    // the bridge's ordinary admission path cannot express that CAS.
    return this.options.store.runInTransaction((transaction) => {
      const currentSession = transaction.findSession(session.id);
      if (currentSession.isErr()) return err(currentSession.error);
      if (
        !currentSession.value ||
        currentSession.value.status !== 'connected' ||
        (currentSession.value.activeDelegationId !== undefined &&
          currentSession.value.activeDelegationId !== original.id)
      ) {
        return ok({ outcome: 'not_replaceable' as const, reason: 'stale_revision' as const });
      }
      const superseded = transaction.supersedeDelegation({
        originalDelegationId: original.id,
        expectedRevision: original.revision,
        replacement,
        supersededAt: request.requestedAt,
      });
      if (superseded.isErr()) return err(superseded.error);
      if (superseded.value.outcome !== 'superseded') {
        return ok({ outcome: 'not_replaceable' as const, reason: superseded.value.reason });
      }
      const admission: VoiceAdmissionRequest = {
        delegation: replacement,
        queue: {
          queueItemId,
          threadId: request.threadId,
          delegationId: request.delegationId,
          request,
          maxAttempts: 1,
        },
      };
      const reserved = transaction.reserveDelegation(admission);
      if (reserved.isErr()) return err(reserved.error);
      const queued = transaction.enqueueVoiceWork({
        queueItemId,
        threadId: request.threadId,
        delegationId: request.delegationId,
        request,
        maxAttempts: 1,
      });
      if (queued.isErr()) return err(queued.error);
      const current = currentSession.value;
      const updatedSession = transaction.updateSession({
        sessionId: session.id,
        expectedRevision: current.revision,
        patch: { activeDelegationId: replacement.id },
        updatedAt: request.requestedAt,
      });
      if (updatedSession.isErr()) return err(updatedSession.error);
      const queuedDelegation = transaction.findDelegation(replacement.id);
      if (queuedDelegation.isErr()) return err(queuedDelegation.error);
      if (!queuedDelegation.value) return err(new PolicyError('Voice replacement was not persisted'));
      return ok({
        outcome: 'replaced' as const,
        request,
        session: updatedSession.value,
        original: superseded.value.original,
        replacement: queuedDelegation.value,
      });
    });
  }

  private attachBackendResult(
    runtime: SessionRuntime,
    request: VoiceBackendRequest,
    activeSession: VoiceSessionRecord,
    ownsActiveDelegation: boolean,
  ): VoiceAsyncResult<void> {
    const unsubscribe = this.options.backendBridge.onResult(request.delegationId, (result) => {
      void this.enqueueBackendResult(runtime, result);
    });
    runtime.resultUnsubscribes.set(request.delegationId, unsubscribe);
    const existing = this.options.backendBridge.result(request.delegationId);
    if (existing.isErr()) return Promise.resolve(err(existing.error));
    if (existing.value) void this.enqueueBackendResult(runtime, existing.value);
    if (ownsActiveDelegation) this.publishSession(activeSession);
    return Promise.resolve(ok(undefined));
  }

  private contextForDelegation(sideband: LiveVoiceSideband, providerDelegationId: string): VoiceContextSnapshot | null {
    return this.inspectContextForDelegation(sideband, providerDelegationId).context;
  }

  private inspectContextForDelegation(
    sideband: LiveVoiceSideband,
    providerDelegationId: string,
  ): VoiceContextInspection {
    const candidate = sideband as LiveVoiceSideband & {
      contextForDelegation?: (id: string) => VoiceContextSnapshot | null;
      getContextForDelegation?: (id: string) => {
        readonly snapshot: VoiceContextSnapshot | null;
        readonly uncertain: boolean;
        readonly reason?: string;
      };
    };
    const context = candidate.contextForDelegation?.(providerDelegationId) ?? null;
    let diagnosticReason: VoiceContextRejectionReason | undefined;
    try {
      const diagnostic = candidate.getContextForDelegation?.(providerDelegationId);
      if (diagnostic) diagnosticReason = contextRejectionReason(diagnostic.reason);
    } catch {
      // Diagnostics are optional and cannot change authoritative admission.
    }
    if (!context) return { context: null, reason: diagnosticReason ?? 'missing_transcript' };
    if (context.truncated) return { context: null, reason: 'truncated' };
    if (context.text.trim().length === 0) return { context: null, reason: 'missing_transcript' };
    if (context.text.length > this.maxContextChars) {
      return { context: null, reason: 'context_too_large' };
    }
    return { context, reason: 'missing_transcript' };
  }

  private logContextRejection(runtime: SessionRuntime, reason: VoiceContextRejectionReason): void {
    if (!this.options.logger) return;
    try {
      this.options.logger.warn(
        {
          voiceCorrelationId: runtime.contextDiagnosticCorrelationId,
          event: 'pre_admission_rejection',
          reason,
        },
        'voice context was not admitted',
      );
    } catch {
      // Diagnostics are observational and must never affect admission.
    }
  }

  private delegationContextInvalidated(
    runtime: SessionRuntime,
    delegation: VoiceDelegationRecord,
  ): boolean {
    const context = this.contextForDelegation(runtime.sideband, delegation.providerDelegationId);
    return !context || context.digest !== delegation.contextDigest;
  }

  private hasUndeliveredOutput(
    runtime: SessionRuntime,
    projection: VoiceSessionReadProjection,
    delegation: VoiceDelegationRecord,
  ): boolean {
    if (delegation.output.delivery === 'pending') return true;
    return projection.outputs.some(
      (output) => output.delegationId === delegation.id && !runtime.handledOutputIds.has(output.id),
    );
  }

  private enqueueBackendResult(runtime: SessionRuntime, result: VoiceBackendResult): Promise<void> {
    const run = runtime.eventChain
      .catch(() => undefined)
      .then(() => this.handleBackendResult(result))
      .catch((cause: unknown) => {
        this.options.logger?.warn({ cause, delegationId: result.delegationId }, 'voice result delivery failed');
      });
    runtime.eventChain = run;
    return run;
  }

  private async sendStaleNotice(
    runtime: SessionRuntime,
    delegation: VoiceDelegationRecord,
    completed: boolean,
  ): Promise<void> {
    if (runtime.staleNoticeSent.has(delegation.id)) return;
    const content = completed
      ? 'The earlier request finished after your correction. Its result was retained, but it was not used as the answer. Please repeat the corrected request.'
      : 'The earlier request is already running. Its result will be retained, but it will not answer your correction. Please repeat the corrected request.';
    const sent = await runtime.sideband.send({
      kind: 'instruction',
      delegationId: delegation.providerDelegationId,
      content,
      outputId: randomUUID(),
    });
    if (sent.isOk()) runtime.staleNoticeSent.add(delegation.id);
  }

  private async handleBackendResult(result: VoiceBackendResult): Promise<void> {
    const delegation = this.options.store.findDelegation(result.delegationId);
    if (delegation.isErr() || !delegation.value) return;
    const runtime = this.runtimes.get(delegation.value.sessionId);
    if (!runtime) return;
    if (runtime.handledOutputIds.has(result.outputId)) return;
    runtime.handledOutputIds.add(result.outputId);
    const stale =
      runtime.staleDelegationIds.has(delegation.value.id) ||
      this.delegationContextInvalidated(runtime, delegation.value);
    if (stale) runtime.staleDelegationIds.add(delegation.value.id);
    const outputId = result.outputId;
    const isSafeFailure = result.kind === 'error' || result.kind === 'unknown';
    const content = this.backendResultContent(result);
    const command = isSafeFailure
      ? { kind: 'instruction' as const, delegationId: delegation.value.providerDelegationId, content, outputId }
      : { kind: 'commentary' as const, delegationId: delegation.value.providerDelegationId, content, outputId };
    let sent: VoiceResult<void>;
    if (stale) {
      this.telemetry?.record({
        callId: delegation.value.sessionId,
        stage: 'output_offered',
        status: 'unknown',
        delegationId: delegation.value.id,
        providerDelegationId: delegation.value.providerDelegationId,
        outputId,
      });
      sent = ok(undefined);
    } else if (content.length > 0) {
      sent = await runtime.sideband.send(command);
      this.telemetry?.record({
        callId: delegation.value.sessionId,
        stage: 'output_offered',
        status: sent.isOk() ? 'sent' : 'failed',
        delegationId: delegation.value.id,
        providerDelegationId: delegation.value.providerDelegationId,
        outputId,
      });
    } else {
      sent = err(new PolicyError('Voice result has no deliverable text'));
    }
    if (stale) await this.sendStaleNotice(runtime, delegation.value, result.execution !== 'running');
    if (!stale) {
      const retained = this.persistBackendResult(delegation.value, result, content);
      if (retained.isErr()) {
        this.options.logger?.warn(
          { delegationId: result.delegationId, outputId: result.outputId, cause: retained.error },
          'voice backend result history persistence failed',
        );
      }
    }
    const lifecycle: VoiceOutputLifecycle = {
      ...result.output,
      delivery: stale ? 'not_requested' : sent.isOk() ? 'sent' : 'failed',
    };
    this.options.store.recordOutputLifecycle({
      delegationId: result.delegationId,
      outputId: result.outputId,
      lifecycle,
    });
    if (result.execution === 'succeeded' || result.execution === 'failed' || result.execution === 'unknown' || result.execution === 'skipped') {
      const projection = this.options.store.readSession(delegation.value.sessionId);
      if (projection.isOk() && projection.value && projection.value.session.activeDelegationId === result.delegationId) {
        const updated = this.options.store.updateSession({
          sessionId: delegation.value.sessionId,
          expectedRevision: projection.value.session.revision,
          patch: { activeDelegationId: undefined },
          updatedAt: this.now(),
        });
        if (updated.isOk()) this.publishSession(updated.value);
      }
      runtime.resultUnsubscribes.get(result.delegationId)?.();
      runtime.resultUnsubscribes.delete(result.delegationId);
    }
    this.publishDelegation(delegation.value.sessionId, result.delegationId);
    const afterResult = this.options.store.readSession(delegation.value.sessionId);
    if (
      afterResult.isOk() &&
      afterResult.value &&
      ['closed', 'expired', 'failed'].includes(afterResult.value.session.status) &&
      !hasPendingDelegation(afterResult.value)
    ) {
      this.runtimes.delete(delegation.value.sessionId);
    }
  }

  private backendResultContent(result: VoiceBackendResult): string {
    return result.kind === 'error' || result.kind === 'unknown'
      ? 'The request could not be completed safely. Please try again.'
      : result.text ?? '';
  }

  private persistUsage(sessionId: string, update: VoiceUsageUpdate): VoiceResult<void> {
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return err(projection.error);
    if (!projection.value) return err(new PolicyError('Voice session was not found'));
    const previousSeconds = projection.value.session.usage.voiceSeconds;
    if (
      update.voiceSeconds !== undefined &&
      (!Number.isFinite(update.voiceSeconds) || update.voiceSeconds < 0)
    ) {
      return ok(undefined);
    }
    if (
      update.voiceSeconds !== undefined &&
      previousSeconds !== undefined &&
      update.voiceSeconds < previousSeconds
    ) {
      return ok(undefined);
    }
    const usage = applyVoiceCost({
      ...projection.value.session.usage,
      ...(update.voiceSeconds !== undefined ? { voiceSeconds: update.voiceSeconds } : {}),
    }, this.usdPerMinute, projection.value.session.finalization.status);
    const saved = this.options.store.updateSession({
      sessionId,
      expectedRevision: projection.value.session.revision,
      patch: { usage },
      updatedAt: this.now(),
    });
    if (saved.isErr()) return err(saved.error);
    this.publishSession(saved.value);
    return ok(undefined);
  }

  private recordProviderAcknowledgement(
    sessionId: string,
    delegationId: string,
    outputId: string,
  ): VoiceResult<void> {
    const delegation = this.options.store.findDelegation(delegationId);
    if (delegation.isErr()) return err(delegation.error);
    if (!delegation.value || delegation.value.sessionId !== sessionId) return ok(undefined);
    const lifecycle: VoiceOutputLifecycle = {
      ...delegation.value.output,
      providerAcknowledgement: 'acknowledged',
      delivery: delegation.value.output.delivery === 'not_requested' ? 'acknowledged' : delegation.value.output.delivery,
    };
    const saved = this.options.store.recordOutputLifecycle({ delegationId, outputId, lifecycle });
    if (saved.isErr()) return err(saved.error);
    this.telemetry?.record({
      callId: delegation.value.sessionId,
      stage: 'provider_acknowledged',
      status: 'acknowledged',
      delegationId,
      providerDelegationId: delegation.value.providerDelegationId,
      outputId,
    });
    this.publishDelegation(sessionId, delegationId);
    return ok(undefined);
  }

  private async receiveTransportEvent(sessionId: string, event: VoiceTransportEvent): Promise<void> {
    if (event.kind === 'playback') {
      const projection = this.options.store.readSession(sessionId);
      if (projection.isErr() || !projection.value) return;
      const output = projection.value.outputs.find((candidate) => candidate.id === event.outputId);
      if (!output) return;
      this.options.store.recordOutputLifecycle({
        delegationId: output.delegationId,
        outputId: output.id,
        lifecycle: { ...output.lifecycle, playback: event.status },
      });
      this.publishDelegation(sessionId, output.delegationId);
    } else if (event.kind === 'error') {
      this.publishError(sessionId, event.code, event.message);
    } else if (event.status === 'closed' || event.status === 'failed') {
      const projection = this.options.store.readSession(sessionId);
      if (projection.isOk() && projection.value) {
        await this.closeSession(projection.value.session.owner, sessionId, { reason: 'transport_failure' });
      }
    }
  }

  private skipUnclaimed(
    projection: VoiceSessionReadProjection,
    reason: 'hangup' | 'logout' | 'deadline' | 'shutdown',
  ): boolean {
    let pending = false;
    for (const delegation of projection.delegations) {
      if (delegation.status === 'claimed' || delegation.status === 'running') {
        pending = true;
        continue;
      }
      if (delegation.status !== 'admitted' && delegation.status !== 'queued') continue;
      const skipped = this.options.store.skipDelegation({
        delegationId: delegation.id,
        expectedRevision: delegation.revision,
        reason,
        skippedAt: this.now(),
      });
      if (skipped.isOk()) this.publishDelegation(projection.session.id, delegation.id);
      else pending = true;
    }
    return pending;
  }

  private failSession(sessionId: string, revision: number, reason: string): void {
    const result = this.options.store.updateSession({
      sessionId,
      expectedRevision: revision,
      patch: { status: 'failed', closedAt: this.now(), finalization: { status: 'incomplete', providerReason: reason } },
      updatedAt: this.now(),
    });
    if (result.isOk()) this.publishSession(result.value);
    this.telemetry?.finishCall(sessionId, 'incomplete');
    this.releaseReservation(sessionId);
  }

  private releaseReservation(sessionId: VoiceSessionId): void {
    const reservation = this.reservations.get(sessionId);
    if (!reservation) return;
    if (this.pendingSetupReservations.has(reservation.id)) return;
    reservation.release();
    this.reservations.delete(sessionId);
  }

  private async closeProvider(providerSessionId: string, graceful: boolean): Promise<void> {
    try {
      const closed = await this.options.provider.closeSession(providerSessionId);
      if (closed.isErr()) {
        this.options.logger?.warn(
          { providerSessionId, graceful, cause: closed.error },
          'voice provider close returned an error',
        );
      }
    } catch (cause) {
      this.options.logger?.warn({ providerSessionId, graceful, cause }, 'voice provider close failed');
    }
  }

  private publishSession(session: VoiceSessionRecord): void {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) return;
    const projection = this.options.store.readSession(session.id);
    if (projection.isErr() || !projection.value) return;
    const status = this.statusDto(projection.value);
    if (status.isErr()) return;
    const event: VoiceStatusEventDto = {
      kind: 'session',
      version: session.revision,
      session: status.value,
      occurredAt: this.now(),
    };
    this.publish(runtime, event);
  }

  private statusDto(
    projection: VoiceSessionReadProjection,
  ): VoiceResult<VoiceSessionStatusDto> {
    const notifications = this.readNotifications(projection.session.threadId);
    if (notifications.isErr()) return err(notifications.error);
    return ok(statusDto(projection, notifications.value));
  }

  private readNotifications(threadId: string): VoiceResult<readonly VoiceNotificationStatusDto[]> {
    if (!this.options.messageRepository) return ok([]);
    const notifications: VoiceNotificationStatusDto[] = [];
    let offset = 0;
    while (notifications.length < MAX_RETAINED_VOICE_NOTIFICATIONS) {
      const rows = this.options.messageRepository.findLatestByThreadPage(
        threadId,
        MAX_RETAINED_VOICE_NOTIFICATIONS,
        offset,
      );
      if (rows.isErr()) return err(rows.error);
      const eligible = rows.value.flatMap((row) => {
        if (row.direction !== 'outbound') return [];
        const parsed = parseVoiceMessageContent(row.content);
        if (!parsed || parsed.voice) return [];
        const text = parsed.body.trim();
        if (!text) return [];
        return [{
          id: row.id,
          text: text.slice(0, MAX_VOICE_NOTIFICATION_CHARS),
          createdAt: row.created_at,
        }];
      });
      notifications.unshift(...eligible);
      if (
        rows.value.length < MAX_RETAINED_VOICE_NOTIFICATIONS ||
        notifications.length >= MAX_RETAINED_VOICE_NOTIFICATIONS
      ) {
        break;
      }
      offset += rows.value.length;
    }
    return ok(notifications.slice(-MAX_RETAINED_VOICE_NOTIFICATIONS));
  }

  private publishDelegation(sessionId: string, delegationId: string): void {
    const runtime = this.runtimes.get(sessionId);
    const projection = this.options.store.readSession(sessionId);
    if (!runtime || projection.isErr() || !projection.value) return;
    const delegation = projection.value.delegations.find((entry) => entry.id === delegationId);
    if (!delegation) return;
    this.publish(runtime, {
      kind: 'delegation',
      version: delegation.revision,
      delegation: delegationDto(delegation, projection.value),
      occurredAt: this.now(),
    });
  }

  private publishError(sessionId: string, code: string, message: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.publish(runtime, { kind: 'error', version: 0, code, message, occurredAt: this.now() });
  }

  private publish(runtime: SessionRuntime, event: VoiceStatusEventDto): void {
    for (const handler of runtime.listeners) {
      try {
        void Promise.resolve(handler(event)).catch((cause) => {
          this.options.logger?.debug({ cause }, 'voice status listener failed');
        });
      } catch (cause) {
        this.options.logger?.debug({ cause }, 'voice status listener failed');
      }
    }
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function optionalNonNegativeFinite(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

export function applyVoiceCost(
  usage: VoiceSessionRecord['usage'],
  usdPerMinute: number | undefined,
  finalizationStatus: VoiceSessionRecord['finalization']['status'],
  preserveExisting = false,
): VoiceSessionRecord['usage'] {
  if (
    preserveExisting &&
    usage.voiceCostUsd !== undefined &&
    Number.isFinite(usage.voiceCostUsd) &&
    usage.voiceCostUsd >= 0
  ) {
    return finalizationStatus === 'incomplete' && usage.voiceCostStatus !== 'incomplete'
      ? { ...usage, voiceCostStatus: 'incomplete' }
      : usage;
  }
  const estimated = estimateVoiceCost(usage.voiceSeconds, usdPerMinute);
  if (estimated === undefined) return usage;
  return {
    ...usage,
    voiceCostUsd: estimated,
    voiceCostStatus: finalizationStatus === 'incomplete' ? 'incomplete' : 'estimated',
  };
}

function estimateVoiceCost(voiceSeconds: number | undefined, usdPerMinute: number | undefined): number | undefined {
  if (
    voiceSeconds === undefined ||
    !Number.isFinite(voiceSeconds) ||
    voiceSeconds < 0 ||
    usdPerMinute === undefined ||
    !Number.isFinite(usdPerMinute) ||
    usdPerMinute < 0
  ) {
    return undefined;
  }
  const estimate = (voiceSeconds / 60) * usdPerMinute;
  return Number.isFinite(estimate) && estimate >= 0 ? Math.max(0, estimate) : undefined;
}

function sameOwner(left: VoiceOwnerContext, right: VoiceOwnerContext): boolean {
  return left.ownerId === right.ownerId && left.loginRevision === right.loginRevision;
}

function emptyUsage(): VoiceSessionRecord['usage'] {
  return {
    voiceCostStatus: 'unavailable',
    backendCostStatus: 'unavailable',
  };
}

function statusDto(
  projection: VoiceSessionReadProjection,
  notifications: readonly VoiceNotificationStatusDto[] = [],
): VoiceSessionStatusDto {
  const delegations = projection.delegations.map((delegation) => delegationDto(delegation, projection));
  return {
    id: projection.session.id,
    status: projection.session.status,
    transport: projection.session.transport,
    createdAt: projection.session.createdAt,
    ...(projection.session.startedAt !== undefined ? { startedAt: projection.session.startedAt } : {}),
    deadlineAt: projection.session.deadlineAt,
    ...(projection.session.closedAt !== undefined ? { closedAt: projection.session.closedAt } : {}),
    delegations,
    ...(projection.session.activeDelegationId
      ? { activeDelegation: delegations.find((delegation) => delegation.id === projection.session.activeDelegationId) }
      : {}),
    ...(notifications.length > 0 ? { notifications } : {}),
    usage: projection.session.usage,
    finalization: projection.session.finalization,
  };
}

function delegationDto(
  delegation: VoiceSessionReadProjection['delegations'][number],
  projection: VoiceSessionReadProjection,
): VoiceSessionStatusDto['delegations'][number] {
  const outputs = projection.outputs.filter((output) => output.delegationId === delegation.id);
  const updatedAt = Math.max(
    delegation.createdAt,
    ...outputs.map((output) => output.updatedAt),
  );
  return {
    id: delegation.id,
    revision: delegation.revision,
    status: delegation.status,
    contextVersion: delegation.contextVersion,
    execution: delegation.execution,
    output: delegation.output,
    outputs,
    createdAt: delegation.createdAt,
    updatedAt,
  };
}

function hasPendingDelegation(projection: VoiceSessionReadProjection): boolean {
  return projection.delegations.some(
    (delegation) => delegation.status === 'claimed' || delegation.status === 'running',
  );
}

function findPendingDelegation(
  session: VoiceSessionRecord,
  delegations: readonly VoiceDelegationRecord[],
): VoiceDelegationRecord | undefined {
  const active = session.activeDelegationId
    ? delegations.find((delegation) => delegation.id === session.activeDelegationId)
    : undefined;
  if (active && isPendingDelegation(active)) return active;
  return delegations.find(isPendingDelegation);
}

function isPendingDelegation(delegation: VoiceDelegationRecord): boolean {
  return (
    delegation.status === 'admitted' ||
    delegation.status === 'queued' ||
    delegation.status === 'claimed' ||
    delegation.status === 'running'
  );
}

function initialOutputLifecycle(): VoiceOutputLifecycle {
  return {
    execution: 'not_started',
    delivery: 'not_requested',
    providerAcknowledgement: 'not_sent',
    playback: 'not_started',
  };
}

function closeReason(reason: VoiceCloseReason): 'hangup' | 'logout' | 'deadline' | 'shutdown' {
  return reason === 'transport_failure' ? 'hangup' : reason;
}

function latestSidebandUsage(sideband: LiveVoiceSideband | undefined): VoiceUsageUpdate | undefined {
  const candidate = sideband as
    | (LiveVoiceSideband & { latestUsage?: VoiceUsageUpdate; usage?: VoiceUsageUpdate })
    | undefined;
  return candidate?.latestUsage ?? candidate?.usage;
}

function finalizationFromRuntime(
  runtime: SessionRuntime | undefined,
  usage: VoiceUsageUpdate | undefined,
): VoiceSessionRecord['finalization'] {
  const status = isFinalizationConfirmed(runtime?.sideband, usage) ? 'confirmed' : 'incomplete';
  return {
    status,
    ...(status === 'confirmed' ? { confirmedAt: usage?.receivedAt } : {}),
  };
}

function isFinalizationConfirmed(
  sideband: LiveVoiceSideband | undefined,
  usage = latestSidebandUsage(sideband),
): boolean {
  const candidate = sideband as
    | (LiveVoiceSideband & { finalizationStatus?: 'pending' | 'confirmed' | 'incomplete' })
    | undefined;
  return candidate?.finalizationStatus === 'confirmed' || usage?.final === true;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Sends a clarification using only the provider-owned delegation identity. */
async function sendClarification(
  sideband: LiveVoiceSideband,
  providerDelegationId: string,
  content: string,
): Promise<void> {
  await sideband.send({
    kind: 'instruction',
    delegationId: providerDelegationId,
    content,
    outputId: randomUUID(),
  });
}

function contextRejectionReason(reason: string | undefined): VoiceContextRejectionReason {
  switch (reason) {
    case 'truncated':
    case 'boundary_fragment':
    case 'untimed_fragment':
    case 'transcript_changed':
    case 'delegation_replay_conflict':
    case 'missing_transcript':
      return reason;
    default:
      return 'missing_transcript';
  }
}

function diagnosticCorrelationIdForSideband(sideband: LiveVoiceSideband): string {
  const candidate = sideband as LiveVoiceSideband & {
    getDiagnosticCorrelationId?: () => unknown;
  };
  try {
    const correlationId = candidate.getDiagnosticCorrelationId?.();
    if (typeof correlationId === 'string' && correlationId.length > 0) return correlationId;
  } catch {
    // Diagnostic correlation is optional and cannot affect admission.
  }
  return randomUUID();
}

export { DurableVoiceSessionService as VoiceSessionService };
export type { VoiceAuthConfig };
