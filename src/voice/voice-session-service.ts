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
  VoiceAuth,
  type VoiceAuthConfig,
  type VoiceAuthLoginOptions,
  type VoiceAuthLoginResult,
  type VoiceAuthSession,
} from './voice-auth.js';
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
  VoiceTransportEvent,
  VoiceTransportHandle,
  VoiceTransportOpenRequest,
  VoiceTransportStatus,
  VoiceUnsubscribe,
  VoiceUsageUpdate,
} from './voice-types.js';
import type { VoiceStore } from './voice-types.js';

const DEFAULT_SESSION_LIFETIME_MS = 15 * 60 * 1000;
const DEFAULT_MAX_CONTEXT_CHARS = 32_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_VOICE_NOTIFICATION_CHARS = 16_000;
const MAX_RETAINED_VOICE_NOTIFICATIONS = 100;

export interface VoiceSessionServiceOptions {
  readonly store: VoiceStore;
  readonly provider: LiveVoiceProvider;
  readonly transport: VoiceTransport;
  readonly backendBridge: VoiceBackendBridge;
  readonly policy: VoicePolicyEvaluator;
  readonly threadRepository?: ThreadRepository;
  /** Existing message history is the durable notification projection. */
  readonly messageRepository?: Pick<MessageRepository, 'findLatestByThread'>;
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
  readonly now?: () => number;
  readonly maxSessionLifetimeMs?: number;
  readonly maxContextChars?: number;
  readonly shutdownTimeoutMs?: number;
  /** Optional operator-provided live voice rate; absent means no new estimate. */
  readonly usdPerMinute?: number;
  readonly logger?: pino.Logger;
}

interface SessionRuntime {
  readonly sideband: LiveVoiceSideband;
  readonly providerSessionId: string;
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

  override login(
    input: string | { readonly accessToken: string },
    options: VoiceAuthLoginOptions = {},
  ): VoiceResult<VoiceAuthLoginResult> {
    const result = super.login(input, options);
    if (result.isOk()) {
      let owner = this.owners.get(result.value.session.owner.ownerId);
      if (!owner) {
        owner = { revisions: new Map() };
        this.owners.set(result.value.session.owner.ownerId, owner);
      }
      owner.revisions.set(result.value.session.owner.loginRevision, result.value.session);
    }
    this.prune();
    return result;
  }

  override revoke(session: VoiceAuthSession): void {
    super.revoke(session);
    const owner = this.owners.get(session.owner.ownerId);
    owner?.revisions.delete(session.owner.loginRevision);
    if (owner?.revisions.size === 0) this.owners.delete(session.owner.ownerId);
  }

  resolve(owner: VoiceOwnerContext): VoiceAuthSession | undefined {
    this.prune();
    const session = this.owners.get(owner.ownerId)?.revisions.get(owner.loginRevision);
    return session && this.isActive(session) ? session : undefined;
  }

  invalidateRuntime(): void {
    for (const owner of this.owners.values()) {
      for (const session of owner.revisions.values()) super.revoke(session);
    }
    this.owners.clear();
  }

  private prune(): void {
    for (const [ownerId, owner] of this.owners) {
      for (const [revision, session] of owner.revisions) {
        if (!this.isActive(session)) owner.revisions.delete(revision);
      }
      if (owner.revisions.size === 0) this.owners.delete(ownerId);
    }
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
  private readonly runtimes = new Map<VoiceSessionId, SessionRuntime>();
  private readonly activeSessionIds = new Set<VoiceSessionId>();
  private creatingSession = false;
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
  }

  async createSession(
    owner: VoiceOwnerContext,
    input: VoiceSessionCreateRequest,
  ): VoiceAsyncResult<VoiceSessionCreateResult> {
    if (!this.admissionOpen) return err(new PolicyError('Voice session admission is closed'));
    const ownerError = this.ensureOwnerActive(owner);
    if (ownerError) return err(ownerError);
    if (this.creatingSession || this.activeSessionIds.size > 0) {
      return err(new PolicyError('Only one browser voice session may be active'));
    }
    this.creatingSession = true;

    try {
      return await this.createSessionInternal(owner, input);
    } finally {
      this.creatingSession = false;
    }
  }

  private async createSessionInternal(
    owner: VoiceOwnerContext,
    input: VoiceSessionCreateRequest,
  ): VoiceAsyncResult<VoiceSessionCreateResult> {
    const setupGeneration = this.lifecycleGeneration;
    const policy = this.capturePolicy(owner);
    if (policy.isErr()) return err(policy.error);
    const beforePersist = this.ensureSetupActive(owner, setupGeneration);
    if (beforePersist) return err(beforePersist);
    const sessionId = uuidv4();
    const threadId = this.createThread(sessionId);
    if (threadId.isErr()) return err(threadId.error);
    const now = this.now();
    const session: VoiceSessionRecord = {
      id: sessionId,
      revision: 0,
      owner,
      personaId: policy.value.personaId,
      threadId: threadId.value,
      transport: this.options.transport.kind,
      status: 'connecting',
      createdAt: now,
      deadlineAt: now + this.maxSessionLifetimeMs,
      policy: policy.value,
      usage: emptyUsage(),
      finalization: { status: 'pending' },
    };
    const persisted = this.options.store.createSession(session);
    if (persisted.isErr()) return err(persisted.error);
    this.activeSessionIds.add(sessionId);
    const beforeProvider = this.ensureSetupActive(owner, setupGeneration);
    if (beforeProvider) {
      this.failSession(sessionId, persisted.value.revision, 'voice_admission_closed');
      return err(beforeProvider);
    }

    const providerSession = await this.options.provider.createSession({
      sessionId,
      ownerId: owner.ownerId,
      modelName: this.options.liveModelName ?? policy.value.modelName,
      instructions: this.options.instructions,
      delegationMode: 'client',
      transport: input.transport,
      audio: { output: { voice: policy.value.voiceName } },
    });
    if (providerSession.isErr()) {
      this.failSession(sessionId, persisted.value.revision, 'provider_create_failed');
      return err(providerSession.error);
    }
    const providerIdentityValid =
      providerSession.value.providerSessionId === providerSession.value.client.providerSessionId &&
      providerSession.value.client.sessionId === sessionId &&
      providerSession.value.client.transport === this.options.transport.kind;
    if (!providerIdentityValid) {
      await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, persisted.value.revision, 'provider_session_identity_mismatch');
      return err(new PolicyError('Voice provider session descriptor does not match the session'));
    }
    const activeAfterProviderCreate = this.ensureSetupActive(owner, setupGeneration);
    if (activeAfterProviderCreate) {
      await this.closeProvider(providerSession.value.providerSessionId, false);
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
      await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, persisted.value.revision, 'provider_session_persist_failed');
      this.activeSessionIds.delete(sessionId);
      return err(withProvider.error);
    }

    const sideband = await this.options.provider.attachSideband(providerSession.value);
    if (sideband.isErr()) {
      await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, withProvider.value.revision, 'provider_sideband_failed');
      return err(sideband.error);
    }
    if (sideband.value.providerSessionId !== providerSession.value.providerSessionId) {
      await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, withProvider.value.revision, 'provider_sideband_identity_mismatch');
      return err(new PolicyError('Voice provider sideband identity does not match the session'));
    }
    const activeAfterSideband = this.ensureSetupActive(owner, setupGeneration);
    if (activeAfterSideband) {
      await this.closeProvider(providerSession.value.providerSessionId, false);
      this.failSession(sessionId, withProvider.value.revision, 'voice_login_revoked');
      return err(activeAfterSideband);
    }

    const runtime: SessionRuntime = {
      sideband: sideband.value,
      providerSessionId: providerSession.value.providerSessionId,
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
    runtime.unsubscribeTransport = this.options.transport.onEvent(sessionId, (event) => {
      void this.receiveTransportEvent(sessionId, event);
    });
    this.runtimes.set(sessionId, runtime);

    const transport = await this.options.transport.open({
      sessionId,
      ownerId: owner.ownerId,
      client: providerSession.value.client,
    });
    if (transport.isErr()) {
      await this.closeSession(owner, sessionId, { reason: 'transport_failure' });
      return err(transport.error);
    }
    if (transport.value.sessionId !== sessionId || transport.value.kind !== this.options.transport.kind) {
      await this.closeSession(owner, sessionId, { reason: 'transport_failure' });
      return err(new PolicyError('Voice transport handle does not match the session'));
    }
    const activeAfterTransport = this.ensureSetupActive(owner, setupGeneration);
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
      await runtime.sideband.close(input.reason !== 'transport_failure');
      const finalUsage = latestSidebandUsage(runtime.sideband);
      if (finalUsage) this.persistUsage(sessionId, finalUsage);
      runtime.unsubscribeProvider();
    }
    await this.options.transport.close(sessionId, input.reason);
    if (current.providerSessionId) await this.closeProvider(current.providerSessionId, input.reason !== 'transport_failure');

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
    // Keep a runtime shell while claimed/running work is unresolved so an
    // already-open status stream can receive the retained result after hangup.
    // Provider and transport listeners were removed above; only result/status
    // delivery remains until the terminal result arrives.
    this.activeSessionIds.delete(sessionId);
    this.publishSession(terminal.value);
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
    const projection = sessions.value.find((candidate) => candidate.session.threadId === input.threadId);
    if (!projection) return err(new PolicyError('Voice thread was not found'));
    const session = projection.session;
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
        const activeOwnerError = this.ensureOwnerActive(latest.value.owner);
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

  private ensureOwnerActive(owner: VoiceOwnerContext): TalonError | undefined {
    if (this.options.isOwnerActive && !this.options.isOwnerActive(owner)) {
      return new PolicyError('Voice login is no longer active');
    }
    return undefined;
  }

  private ensureSetupActive(owner: VoiceOwnerContext, setupGeneration: number): TalonError | undefined {
    if (!this.admissionOpen || this.lifecycleGeneration !== setupGeneration) {
      return new PolicyError('Voice session admission is closed');
    }
    return this.ensureOwnerActive(owner);
  }

  private createThread(sessionId: string): VoiceResult<string> {
    if (!this.options.threadRepository || !this.options.channelId) return ok(sessionId);
    const inserted = this.options.threadRepository.insert({
      id: sessionId,
      channel_id: this.options.channelId,
      external_id: `voice:${sessionId}`,
      metadata: JSON.stringify({ kind: 'voice', sessionId }),
    });
    if (inserted.isErr()) return err(inserted.error);
    return ok(inserted.value.id);
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
    _event: Extract<LiveVoiceEvent, { readonly kind: 'transcript' }>,
  ): Promise<VoiceResult<void>> {
    const projection = this.options.store.readSession(sessionId);
    if (projection.isErr()) return err(projection.error);
    if (!projection.value) return err(new PolicyError('Voice session was not found'));

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
    const ownerError = this.ensureOwnerActive(session.owner);
    if (ownerError) {
      await this.closeSession(session.owner, sessionId, { reason: 'logout' });
      return ok(undefined);
    }
    const contextResult = this.contextForDelegation(runtime.sideband, proposal.providerDelegationId);
    if (!contextResult) {
      await sendClarification(runtime.sideband, proposal.providerDelegationId, 'I could not establish the request context safely. Please repeat that.');
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
    const admissionOwnerError = this.ensureOwnerActive(session.owner);
    if (admissionOwnerError) {
      await this.closeSession(session.owner, sessionId, { reason: 'logout' });
      return ok(undefined);
    }
    const admitted = await this.options.backendBridge.admit(request);
    if (admitted.isErr()) {
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
    const candidate = sideband as LiveVoiceSideband & {
      contextForDelegation?: (id: string) => VoiceContextSnapshot | null;
    };
    const context = candidate.contextForDelegation?.(providerDelegationId);
    if (!context || context.truncated || context.text.trim().length === 0 || context.text.length > this.maxContextChars) return null;
    return context;
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
    const content = isSafeFailure
      ? 'The request could not be completed safely. Please try again.'
      : result.text ?? '';
    const command = isSafeFailure
      ? { kind: 'instruction' as const, delegationId: delegation.value.providerDelegationId, content, outputId }
      : { kind: 'commentary' as const, delegationId: delegation.value.providerDelegationId, content, outputId };
    const sent = stale
      ? ok(undefined)
      : content.length > 0
        ? await runtime.sideband.send(command)
        : err(new PolicyError('Voice result has no deliverable text'));
    if (stale) await this.sendStaleNotice(runtime, delegation.value, result.execution !== 'running');
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
    this.activeSessionIds.delete(sessionId);
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
    const rows = this.options.messageRepository.findLatestByThread(
      threadId,
      MAX_RETAINED_VOICE_NOTIFICATIONS,
    );
    if (rows.isErr()) return err(rows.error);
    const notifications: VoiceNotificationStatusDto[] = [];
    for (const row of rows.value) {
      if (row.direction !== 'outbound') continue;
      try {
        const parsed = JSON.parse(row.content) as unknown;
        if (!isRecord(parsed) || typeof parsed.body !== 'string') continue;
        const text = parsed.body.trim();
        if (!text) continue;
        notifications.push({
          id: row.id,
          text: text.slice(0, MAX_VOICE_NOTIFICATION_CHARS),
          createdAt: row.created_at,
        });
      } catch {
        // Malformed message rows are not voice notifications.
      }
    }
    return ok(notifications);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  const candidate = runtime?.sideband as
    | (LiveVoiceSideband & { finalizationStatus?: 'pending' | 'confirmed' | 'incomplete' })
    | undefined;
  const status = candidate?.finalizationStatus === 'confirmed' || usage?.final
    ? 'confirmed'
    : 'incomplete';
  return {
    status,
    ...(status === 'confirmed' ? { confirmedAt: usage?.receivedAt } : {}),
  };
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

export { DurableVoiceSessionService as VoiceSessionService };
export type { VoiceAuthConfig };
