import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type pino from 'pino';
import { err, ok } from '../../core/types/result.js';
import type { TalonError } from '../../core/errors/error-types.js';
import type {
  LiveVoiceCommand,
  LiveVoiceEvent,
  LiveVoiceIncomingSessionRequest,
  LiveVoiceProvider,
  LiveVoiceSession,
  LiveVoiceSessionRequest,
  LiveVoiceSideband,
  VoiceAsyncResult,
  VoiceContextSnapshot,
  VoiceDelegationProposal,
  VoiceEventHandler,
  VoiceOutputId,
  VoiceResult,
  VoiceTranscriptFragment,
  VoiceTranscriptFragmentKind,
  VoiceUnsubscribe,
  VoiceUsageUpdate,
} from '../voice-types.js';
import {
  fragmentIdForProviderEvent,
  firstString,
  TranscriptBuffer,
  transcriptRoleForEvent,
  userContextSignature,
  type TranscriptBufferOptions,
  type TranscriptContextResult,
} from './transcript-buffer.js';
import { LiveProviderError, type LiveProviderErrorReason } from './live-provider-error.js';
import type { VoiceTelemetry } from '../voice-telemetry.js';

export const OPENAI_LIVE_API_BASE = 'https://api.openai.com';
export const OPENAI_LIVE_SESSION_PATH = '/v1/live/sessions';
export const OPENAI_LIVE_ACCEPT_SUFFIX = '/accept';
export const OPENAI_LIVE_ATTACH_SUFFIX = '/attach';
export const OPENAI_LIVE_HANGUP_SUFFIX = '/hangup';
export const DEFAULT_LIVE_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_LIVE_OPEN_TIMEOUT_MS = DEFAULT_LIVE_REQUEST_TIMEOUT_MS;
export const DEFAULT_LIVE_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_LIVE_SESSION_LIFETIME_MS = 15 * 60_000;
export const DEFAULT_MAX_PROVIDER_EVENT_BYTES = 1_000_000;
export const DEFAULT_MAX_PENDING_COMMANDS = 128;
export const DEFAULT_DELEGATION_CONTEXT_QUIET_MS = 1_000;
export const DEFAULT_DELEGATION_CONTEXT_DEADLINE_MS = 5_000;
/** Backwards-compatible name for the first-notice quiet interval. */
export const DEFAULT_DELEGATION_CONTEXT_WAIT_MS = DEFAULT_DELEGATION_CONTEXT_QUIET_MS;

export const LIVE_WEBSOCKET_OPEN = 1;

/** Minimal WebSocket surface used by the adapter and its offline fakes. */
export interface LiveWebSocket {
  readonly readyState: number;
  on(event: 'open', handler: () => void): this;
  on(event: 'message', handler: (data: unknown, isBinary?: boolean) => void): this;
  on(event: 'error', handler: (error: Error) => void): this;
  on(event: 'close', handler: (code: number, reason: unknown) => void): this;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export type LiveWebSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => LiveWebSocket;

export interface OpenAiLiveVoiceProviderOptions extends TranscriptBufferOptions {
  /** The key is supplied by the configured server; the adapter never reads env files. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly webSocketFactory?: LiveWebSocketFactory;
  readonly requestTimeoutMs?: number;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly defaultSessionLifetimeMs?: number;
  readonly maxProviderEventBytes?: number;
  readonly maxPendingCommands?: number;
  readonly telemetry?: VoiceTelemetry;
  readonly logger?: pino.Logger;
}

export type LiveSidebandFinalization = 'pending' | 'confirmed' | 'incomplete';

interface ProviderSessionState {
  readonly session: LiveVoiceSession;
  readonly expiresAt: number;
  readonly incoming: boolean;
  sideband?: OpenAiLiveVoiceSideband;
}

interface PendingCommand {
  readonly delegationId: string | null;
  readonly outputId: VoiceOutputId;
}

interface EncodedCommand {
  readonly eventId: string;
  readonly body: ProviderPayload;
  readonly pending?: PendingCommand;
}

interface DelegationPublication {
  readonly eventId: string;
  readonly sequence: number;
  readonly proposal: VoiceDelegationProposal;
  readonly requiresFreshUserTurn?: boolean;
  readonly baselineUserSignature?: string;
  readonly baselineUserIds?: readonly string[];
}

interface PendingDelegation extends DelegationPublication {
  readonly receiptAt: number;
  readonly absoluteDeadline?: number;
  quietDeadline: number;
  quietTimer: ReturnType<typeof setTimeout>;
  absoluteTimer?: ReturnType<typeof setTimeout>;
}

interface ProviderPayload {
  readonly [key: string]: unknown;
}

type VoiceContextDiagnosticReason =
  | 'missing_transcript'
  | 'truncated'
  | 'boundary_fragment'
  | 'untimed_fragment'
  | 'transcript_changed'
  | 'delegation_replay_conflict'
  | 'published_context_reuse'
  | 'quiet_pending'
  | 'absolute_expiry';

type VoiceContextDiagnosticEvent =
  | 'pending'
  | 'quiet_wait'
  | 'published'
  | 'invalidated'
  | 'retired'
  | 'closed';

type VoiceContextDiagnosticObservation = 'sideband_lifetime';

function contextSafetyKey(context: TranscriptContextResult): string {
  return `${context.uncertain ? 'unsafe' : 'safe'}:${context.reason ?? 'none'}`;
}

function canPreserveSettledFirstContext(
  pending: PendingDelegation,
  previous: TranscriptContextResult,
  refreshed: TranscriptContextResult,
  now: number,
): boolean {
  if (
    pending.absoluteDeadline === undefined ||
    pending.quietDeadline > pending.absoluteDeadline ||
    now < pending.quietDeadline
  )
    return false;
  if (
    previous.uncertain ||
    previous.reason !== undefined ||
    refreshed.uncertain ||
    refreshed.reason !== undefined
  ) {
    return false;
  }
  const previousSignature = userContextSignature(previous.snapshot);
  return (
    previousSignature !== undefined &&
    previousSignature === userContextSignature(refreshed.snapshot) &&
    contextSafetyKey(previous) === contextSafetyKey(refreshed)
  );
}

function contextChangedMeaningfully(
  previous: TranscriptContextResult,
  next: TranscriptContextResult,
): boolean {
  return (
    userContextSignature(previous.snapshot) !== userContextSignature(next.snapshot) ||
    contextSafetyKey(previous) !== contextSafetyKey(next)
  );
}

/** GPT-Live adapter using the documented Live API, never the Realtime API. */
export class OpenAiLiveVoiceProvider implements LiveVoiceProvider {
  readonly name = 'openai-live';
  readonly capabilities = {
    audio_streaming: 'supported',
    interruptions: 'supported',
    delegation: 'supported',
    notifications: 'supported',
    transcript_stability: 'supported',
    provider_acknowledgements: 'supported',
    usage_reporting: 'supported',
  } as const;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: LiveWebSocketFactory;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly openTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly defaultSessionLifetimeMs: number;
  private readonly maxProviderEventBytes: number;
  private readonly maxPendingCommands: number;
  private readonly logger: pino.Logger | undefined;
  private readonly telemetry: VoiceTelemetry | undefined;
  private readonly transcriptOptions: TranscriptBufferOptions;
  private readonly sessions = new Map<string, ProviderSessionState>();

  constructor(options: OpenAiLiveVoiceProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? OPENAI_LIVE_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url, headers): LiveWebSocket =>
        new WebSocket(url, { headers: { ...headers } }) as unknown as LiveWebSocket);
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = positiveLimit(
      options.requestTimeoutMs ?? DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.openTimeoutMs = positiveLimit(
      options.openTimeoutMs ?? DEFAULT_LIVE_OPEN_TIMEOUT_MS,
      'openTimeoutMs',
    );
    this.closeTimeoutMs = positiveLimit(
      options.closeTimeoutMs ?? DEFAULT_LIVE_CLOSE_TIMEOUT_MS,
      'closeTimeoutMs',
    );
    this.defaultSessionLifetimeMs = positiveLimit(
      options.defaultSessionLifetimeMs ?? DEFAULT_LIVE_SESSION_LIFETIME_MS,
      'defaultSessionLifetimeMs',
    );
    this.maxProviderEventBytes = positiveLimit(
      options.maxProviderEventBytes ?? DEFAULT_MAX_PROVIDER_EVENT_BYTES,
      'maxProviderEventBytes',
    );
    this.maxPendingCommands = positiveLimit(
      options.maxPendingCommands ?? DEFAULT_MAX_PENDING_COMMANDS,
      'maxPendingCommands',
    );
    this.telemetry = options.telemetry;
    this.logger = options.logger;
    this.transcriptOptions = {
      maxFragments: options.maxFragments,
      maxCharacters: options.maxCharacters,
      now: this.now,
    };
  }

  async createSession(input: LiveVoiceSessionRequest): VoiceAsyncResult<LiveVoiceSession> {
    const validationError = validateSessionRequest(input);
    if (validationError) return err(validationError);

    const configured = this.checkConfiguration();
    if (configured) return err(configured);

    if (input.transport.type !== 'webrtc') {
      return err(providerError('unsupported_transport', 'GPT-Live requires a WebRTC offer'));
    }
    const transport = input.transport;
    const voice = nonEmptyString(input.audio?.output?.voice) ? input.audio.output.voice : 'marin';
    const body = {
      session: {
        model: input.modelName,
        store: false,
        delegation: { type: input.delegationMode },
        instructions: input.instructions,
        audio: { output: { voice } },
      },
      transport: { type: 'webrtc', sdp: transport.sdp },
    };
    const response = await this.requestJson(OPENAI_LIVE_SESSION_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.isErr()) return err(response.error);

    const data = asRecord(response.value);
    const providerSessionId = data ? nestedString(data, ['session', 'id']) : undefined;
    const answer = data ? asRecord(data.transport) : undefined;
    const answerSdp = answer ? stringValue(answer.sdp) : undefined;
    const answerType = answer ? stringValue(answer.type) : undefined;
    if (!providerSessionId || !answerSdp || (answerType !== undefined && answerType !== 'webrtc')) {
      return err(
        providerError(
          'invalid_response',
          'GPT-Live session response did not contain a session ID and transport answer',
        ),
      );
    }
    if (this.sessions.has(providerSessionId)) {
      return err(providerError('invalid_response', 'GPT-Live returned a duplicate session ID'));
    }

    const expiresAt =
      finiteNumber(data?.expires_at) ??
      finiteNumber(data?.expiresAt) ??
      this.now() + this.defaultSessionLifetimeMs;
    const session: LiveVoiceSession = {
      providerSessionId,
      client: {
        transport: 'webrtc',
        sessionId: input.sessionId,
        providerSessionId,
        answer: { type: 'webrtc', sdp: answerSdp },
        expiresAt,
      },
    };
    this.sessions.set(providerSessionId, { session, expiresAt, incoming: false });
    return ok(session);
  }

  async acceptIncomingSession(
    input: LiveVoiceIncomingSessionRequest,
  ): VoiceAsyncResult<LiveVoiceSession> {
    const validationError = validateIncomingSessionRequest(input, this.now());
    if (validationError) return err(validationError);

    const configured = this.checkConfiguration();
    if (configured) return err(configured);
    if (this.sessions.has(input.providerSessionId)) {
      return err(providerError('invalid_request', 'GPT-Live session is already owned by this provider'));
    }

    const accepted = await this.requestJson(
      `${OPENAI_LIVE_SESSION_PATH}/${encodeURIComponent(input.providerSessionId)}${OPENAI_LIVE_ACCEPT_SUFFIX}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          session: {
            type: 'live',
            model: input.modelName,
            instructions: input.instructions,
            audio: { output: { voice: input.voice } },
            delegation: { type: 'client' },
            store: false,
          },
        }),
      },
      { expectedStatus: 200, emptyBody: true },
    );
    if (accepted.isErr()) return err(accepted.error);

    const session: LiveVoiceSession = {
      providerSessionId: input.providerSessionId,
      client: {
        transport: 'sip',
        sessionId: input.sessionId,
        providerSessionId: input.providerSessionId,
        answer: { type: 'sip', reference: input.providerSessionId },
        expiresAt: input.sessionExpiresAt,
      },
    };
    // Register only after the definitive accept response. An ambiguous HTTP
    // result stays unowned so the ingress attempt remains unknown and cannot
    // be retried automatically by this adapter.
    this.sessions.set(input.providerSessionId, {
      session,
      expiresAt: input.sessionExpiresAt,
      incoming: true,
    });
    return ok(session);
  }

  async attachSideband(session: LiveVoiceSession): VoiceAsyncResult<LiveVoiceSideband> {
    const state = this.sessions.get(session.providerSessionId);
    if (!state) {
      return err(
        providerError('invalid_request', 'GPT-Live session is not owned by this provider'),
      );
    }
    if (this.now() >= state.expiresAt)
      return err(providerError('session_expired', 'GPT-Live session has expired'));
    if (state.sideband) return ok(state.sideband);

    const url = `${webSocketBaseUrl(this.baseUrl)}${OPENAI_LIVE_SESSION_PATH}/${encodeURIComponent(session.providerSessionId)}${OPENAI_LIVE_ATTACH_SUFFIX}`;
    let socket: LiveWebSocket;
    try {
      socket = this.webSocketFactory(url, this.authorizationHeaders());
    } catch {
      return err(providerError('network', 'Unable to open the GPT-Live sideband connection'));
    }

    const sideband = new OpenAiLiveVoiceSideband(socket, session.providerSessionId, {
      now: this.now,
      expiresAt: state.expiresAt,
      openTimeoutMs: this.openTimeoutMs,
      closeTimeoutMs: this.closeTimeoutMs,
      maxProviderEventBytes: this.maxProviderEventBytes,
      maxPendingCommands: this.maxPendingCommands,
      callId: session.client.sessionId,
      telemetry: this.telemetry,
      logger: this.logger,
      transcriptOptions: this.transcriptOptions,
    });
    const opened = await sideband.open();
    if (opened.isErr()) return err(opened.error);
    state.sideband = sideband;
    return ok(sideband);
  }

  async closeSession(providerSessionId: string): VoiceAsyncResult<void> {
    const state = this.sessions.get(providerSessionId);
    if (!state)
      return err(
        providerError('invalid_request', 'GPT-Live session is not owned by this provider'),
      );

    let closeError: TalonError | undefined;
    if (state.incoming) {
      const hangup = await this.requestJson(
        `${OPENAI_LIVE_SESSION_PATH}/${encodeURIComponent(providerSessionId)}${OPENAI_LIVE_HANGUP_SUFFIX}`,
        { method: 'POST', headers: { Accept: 'application/json' } },
        { expectedStatus: 200, emptyBody: true },
      );
      if (hangup.isErr()) closeError = hangup.error;
      if (state.sideband) {
        const finalized = await state.sideband.waitForFinalization();
        if (finalized.isErr() && !closeError) closeError = finalized.error;
      }
      this.sessions.delete(providerSessionId);
      return closeError ? err(closeError) : ok(undefined);
    }

    if (state.sideband) {
      const closed = await state.sideband.close(true);
      if (closed.isErr()) closeError = closed.error;
    }

    const hangup = await this.requestJson(
      `${OPENAI_LIVE_SESSION_PATH}/${encodeURIComponent(providerSessionId)}${OPENAI_LIVE_HANGUP_SUFFIX}`,
      { method: 'POST', headers: { Accept: 'application/json' } },
    );
    this.sessions.delete(providerSessionId);
    if (closeError) return err(closeError);
    if (hangup.isErr()) return err(hangup.error);
    return ok(undefined);
  }

  private checkConfiguration(): LiveProviderError | undefined {
    if (!this.apiKey)
      return providerError('configuration', 'GPT-Live API credentials are not configured');
    if (typeof this.fetchImpl !== 'function')
      return providerError('configuration', 'Fetch is unavailable');
    return undefined;
  }

  private authorizationHeaders(): Readonly<Record<string, string>> {
    return { Authorization: `Bearer ${this.apiKey ?? ''}` };
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    options: { readonly expectedStatus?: number; readonly emptyBody?: boolean } = {},
  ): Promise<VoiceResult<unknown>> {
    const configured = this.checkConfiguration();
    if (configured) return err(configured);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.authorizationHeaders(), ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (
        (options.expectedStatus !== undefined && response.status !== options.expectedStatus) ||
        (options.expectedStatus === undefined && !response.ok)
      ) {
        return err(
          providerError(
            'http',
            `GPT-Live request failed with HTTP ${response.status}`,
            response.status,
          ),
        );
      }
      try {
        const body = await response.text();
        if (options.emptyBody) {
          if (body === '') return ok(undefined);
          return err(providerError('invalid_response', 'GPT-Live returned an unexpected response body'));
        }
        if (body.trim() === '') return ok(undefined);
        return ok(JSON.parse(body) as unknown);
      } catch {
        return err(providerError('invalid_response', 'GPT-Live returned a non-JSON response'));
      }
    } catch (cause) {
      if (controller.signal.aborted)
        return err(providerError('timeout', 'GPT-Live request timed out'));
      return err(
        providerError('network', 'GPT-Live request could not be completed', undefined, cause),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface OpenAiLiveVoiceSidebandOptions {
  readonly now: () => number;
  readonly expiresAt: number;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs: number;
  readonly maxProviderEventBytes: number;
  readonly maxPendingCommands: number;
  readonly callId?: string;
  readonly telemetry?: VoiceTelemetry;
  readonly logger?: pino.Logger;
  readonly transcriptOptions: TranscriptBufferOptions;
}

/** Server-side GPT-Live event connection and normalized event publisher. */
export class OpenAiLiveVoiceSideband implements LiveVoiceSideband {
  readonly providerSessionId: string;

  private readonly socket: LiveWebSocket;
  private readonly now: () => number;
  private readonly expiresAt: number;
  private readonly openTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly maxProviderEventBytes: number;
  private readonly maxPendingCommands: number;
  private readonly logger: pino.Logger | undefined;
  private readonly callId: string;
  private readonly telemetry: VoiceTelemetry | undefined;
  private readonly transcript: TranscriptBuffer;
  private readonly handlers = new Set<VoiceEventHandler<LiveVoiceEvent>>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private readonly delegationContexts = new Map<string, TranscriptContextResult>();
  private readonly delegationOffsets = new Map<string, number>();
  private readonly delegationTargets = new Map<string, string>();
  private readonly pendingDelegations = new Map<string, PendingDelegation>();
  private readonly publishedDelegations = new Set<string>();
  private readonly publishedDelegationOrder: string[] = [];
  private readonly publishedUserSignatures = new Set<string>();
  private readonly publishedUserSignatureOrder: string[] = [];
  private readonly blockedUserSignatures = new Set<string>();
  private readonly blockedUserSignatureOrder: string[] = [];
  private sequence = 0;
  private hasPublishedDelegation = false;
  private connected = false;
  private opened = false;
  private finalized = false;
  private finalization: LiveSidebandFinalization = 'pending';
  private closeRequested = false;
  private closeResult?: Promise<VoiceResult<void>>;
  private resolveClose?: (result: VoiceResult<void>) => void;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private lastUsage?: VoiceUsageUpdate;
  private readonly diagnosticCorrelationId = randomUUID();
  private readonly diagnosticStartedAt: number;
  private diagnosticsClosed = false;
  private observedDelegationCount = 0;
  constructor(
    socket: LiveWebSocket,
    providerSessionId: string,
    options: OpenAiLiveVoiceSidebandOptions,
  ) {
    this.socket = socket;
    this.providerSessionId = providerSessionId;
    this.now = options.now;
    this.expiresAt = options.expiresAt;
    this.openTimeoutMs = positiveLimit(
      options.openTimeoutMs ?? DEFAULT_LIVE_OPEN_TIMEOUT_MS,
      'openTimeoutMs',
    );
    this.closeTimeoutMs = options.closeTimeoutMs;
    this.maxProviderEventBytes = options.maxProviderEventBytes;
    this.maxPendingCommands = options.maxPendingCommands;
    this.callId = options.callId ?? providerSessionId;
    this.telemetry = options.telemetry;
    this.logger = options.logger;
    this.diagnosticStartedAt = this.now();
    this.transcript = new TranscriptBuffer(options.transcriptOptions);
    this.bindSocket();
  }

  get finalizationStatus(): LiveSidebandFinalization {
    return this.finalization;
  }

  get usage(): VoiceUsageUpdate | undefined {
    return this.lastUsage;
  }

  get transcriptBuffer(): TranscriptBuffer {
    return this.transcript;
  }

  /** Internal diagnostic correlation only; it is not part of the voice contract. */
  private getDiagnosticCorrelationId(): string {
    return this.diagnosticCorrelationId;
  }

  getContextForDelegation(providerDelegationId: string): TranscriptContextResult | undefined {
    return this.delegationContexts.get(providerDelegationId);
  }

  contextForDelegation(providerDelegationId: string): VoiceContextSnapshot | null {
    const context = this.delegationContexts.get(providerDelegationId);
    return context && !context.uncertain ? context.snapshot : null;
  }

  async open(): Promise<VoiceResult<void>> {
    if (this.opened) return ok(undefined);
    if (this.socket.readyState === LIVE_WEBSOCKET_OPEN) {
      this.opened = true;
      this.connected = true;
      return ok(undefined);
    }
    if (this.socket.readyState === 3)
      return err(providerError('network', 'GPT-Live sideband is already closed'));
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settle(err(providerError('timeout', 'GPT-Live sideband setup timed out')));
        try {
          this.socket.close(1000, 'setup timeout');
        } catch {
          this.socket.terminate?.();
        }
      }, this.openTimeoutMs);
      const settle = (result: VoiceResult<void>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      this.socket.on('open', () => {
        this.opened = true;
        this.connected = true;
        settle(ok(undefined));
      });
      this.socket.on('error', () => {
        if (!this.opened)
          settle(err(providerError('network', 'GPT-Live sideband connection failed')));
      });
      this.socket.on('close', () => {
        if (!this.opened)
          settle(err(providerError('network', 'GPT-Live sideband closed during setup')));
      });
    });
  }

  async send(command: LiveVoiceCommand): VoiceAsyncResult<void> {
    await Promise.resolve();
    const available = this.checkSendable(command.kind === 'close');
    if (available) return err(available);

    const encoded = this.encodeCommand(command);
    if (encoded.isErr()) return err(encoded.error);
    const { eventId, body, pending } = encoded.value;
    if (pending && this.pendingCommands.size >= this.maxPendingCommands) {
      return err(providerError('invalid_request', 'GPT-Live acknowledgement buffer is full'));
    }
    try {
      if (pending) this.pendingCommands.set(eventId, pending);
      this.socket.send(JSON.stringify(body));
      return ok(undefined);
    } catch {
      if (pending) this.pendingCommands.delete(eventId);
      return err(providerError('network', 'GPT-Live sideband could not send the command'));
    }
  }

  onEvent(handler: VoiceEventHandler<LiveVoiceEvent>): VoiceUnsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(graceful: boolean): VoiceAsyncResult<void> {
    if (this.closeResult) return this.closeResult;
    if (this.finalized) {
      this.retirePendingDelegations();
      this.closeSocket();
      return Promise.resolve(ok(undefined));
    }
    if (!graceful) {
      this.closeRequested = true;
      this.finalization = 'incomplete';
      this.retirePendingDelegations();
      this.closeSocket();
      return Promise.resolve(ok(undefined));
    }

    this.closeRequested = true;
    this.retirePendingDelegations();
    this.closeResult = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    this.closeTimer = setTimeout(() => {
      if (this.finalized) return;
      this.finalization = 'incomplete';
      this.closeSocket(true);
      this.resolveClose?.(
        err(providerError('finalization_incomplete', 'GPT-Live close was not finalized')),
      );
      this.resolveClose = undefined;
    }, this.closeTimeoutMs);

    void this.send({ kind: 'close' }).then((result) => {
      if (result.isErr() && !this.finalized) {
        this.finalization = 'incomplete';
        clearTimeout(this.closeTimer);
        this.resolveClose?.(err(result.error));
        this.resolveClose = undefined;
        this.closeSocket(true);
      }
    });
    return this.closeResult;
  }

  /**
   * Incoming SIP is closed by the Live hangup endpoint. The sideband must
   * remain attached until the provider emits its terminal event, so this path
   * deliberately does not send the browser/session `session.close` command.
   */
  waitForFinalization(): VoiceAsyncResult<void> {
    if (this.closeResult) return this.closeResult;
    if (this.finalized) {
      this.retirePendingDelegations();
      this.closeSocket();
      return Promise.resolve(ok(undefined));
    }

    this.closeRequested = true;
    this.retirePendingDelegations();
    this.closeResult = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    this.closeTimer = setTimeout(() => {
      if (this.finalized) return;
      this.finalization = 'incomplete';
      this.closeSocket(true);
      this.resolveClose?.(
        err(providerError('finalization_incomplete', 'GPT-Live close was not finalized')),
      );
      this.resolveClose = undefined;
    }, this.closeTimeoutMs);

    if (!this.connected || this.socket.readyState !== LIVE_WEBSOCKET_OPEN) {
      this.finalization = 'incomplete';
      clearTimeout(this.closeTimer);
      this.closeSocket(true);
      this.resolveClose?.(
        err(providerError('finalization_incomplete', 'GPT-Live sideband was not connected')),
      );
      this.resolveClose = undefined;
    }
    return this.closeResult;
  }

  private bindSocket(): void {
    this.socket.on('message', (data, isBinary) => {
      this.handleMessage(data, isBinary === true);
    });
    this.socket.on('error', () => {
      this.retirePendingDelegations();
      if (this.opened)
        this.publishError('TRANSPORT_ERROR', 'GPT-Live sideband transport failed', true);
    });
    this.socket.on('close', () => {
      this.connected = false;
      this.retirePendingDelegations();
      if (!this.finalized && this.closeRequested) {
        this.finalization = 'incomplete';
        clearTimeout(this.closeTimer);
        this.resolveClose?.(
          err(
            providerError(
              'finalization_incomplete',
              'GPT-Live sideband closed before finalization',
            ),
          ),
        );
        this.resolveClose = undefined;
      } else if (!this.finalized && !this.closeRequested) {
        this.publishError('TRANSPORT_CLOSED', 'GPT-Live sideband closed unexpectedly', true);
      }
    });
  }

  private checkSendable(allowClose = false): LiveProviderError | undefined {
    if (!this.connected || this.socket.readyState !== LIVE_WEBSOCKET_OPEN) {
      return providerError('not_connected', 'GPT-Live sideband is not connected');
    }
    if (this.now() >= this.expiresAt)
      return providerError('session_expired', 'GPT-Live session has expired');
    if (this.finalized || (this.closeRequested && !allowClose)) {
      return providerError('closed', 'GPT-Live session is closed');
    }
    return undefined;
  }

  private encodeCommand(command: LiveVoiceCommand): VoiceResult<EncodedCommand> {
    if (command.kind === 'close') {
      const eventId = randomUUID();
      return ok({ eventId, body: { type: 'session.close', event_id: eventId } });
    }
    if (command.content.trim() === '') {
      return err(providerError('invalid_request', 'GPT-Live command content must not be empty'));
    }
    if (command.content.length > this.maxProviderEventBytes) {
      return err(providerError('invalid_request', 'GPT-Live command content is too large'));
    }

    const eventId = randomUUID();
    const type =
      command.kind === 'thinking'
        ? 'session.thinking.append'
        : command.kind === 'commentary'
          ? 'session.commentary.append'
          : 'session.instructions.append';
    const body: ProviderPayload = {
      type,
      event_id: eventId,
      content: command.content,
      delegation_id: command.delegationId,
    };
    return ok({
      eventId,
      body,
      pending: { delegationId: command.delegationId, outputId: command.outputId },
    });
  }

  private handleMessage(data: unknown, isBinary: boolean): void {
    if (isBinary) {
      this.publishError(
        'INVALID_PROVIDER_EVENT',
        'GPT-Live sent an unsupported binary event',
        false,
      );
      return;
    }
    const raw = socketDataToString(data);
    if (raw === null || Buffer.byteLength(raw, 'utf8') > this.maxProviderEventBytes) {
      this.publishError('INVALID_PROVIDER_EVENT', 'GPT-Live sent an invalid event payload', false);
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      this.publishError('INVALID_PROVIDER_EVENT', 'GPT-Live sent an unparseable event', false);
      return;
    }
    const payload = asRecord(decoded);
    if (!payload) {
      this.publishError('INVALID_PROVIDER_EVENT', 'GPT-Live event was not an object', false);
      return;
    }

    const nested = payload.type === 'response.event' ? asRecord(payload.event) : undefined;
    const event = nested ? { ...nested, event_id: nested.event_id ?? payload.event_id } : payload;
    this.handleProviderEvent(event);
  }

  private handleProviderEvent(payload: ProviderPayload): void {
    const type = stringValue(payload.type);
    if (!type) {
      this.publishError('INVALID_PROVIDER_EVENT', 'GPT-Live event type is missing', false);
      return;
    }
    const eventId = firstString(payload, ['event_id', 'id']);
    if (eventId && !this.rememberEvent(eventId)) return;
    const sequence = this.nextSequence();

    if (type === 'session.started' || type === 'session.updated') return;
    if (IGNORED_PROVIDER_EVENT_TYPES.has(type)) return;
    if (type === 'error') {
      this.handleProviderError(payload, eventId ?? `provider_error_${sequence}`);
      return;
    }
    if (!eventId && (NORMALIZED_PROVIDER_EVENT_TYPES.has(type) || TRANSCRIPT_EVENT_RE.test(type))) {
      this.publishError('INVALID_PROVIDER_EVENT', 'GPT-Live normalized event ID is missing', false);
      return;
    }
    if (TRANSCRIPT_EVENT_RE.test(type)) {
      this.handleTranscript(payload, type, eventId ?? `provider_event_${sequence}`, sequence);
      return;
    }
    if (type === 'session.delegation.created') {
      this.handleDelegation(payload, eventId ?? `provider_event_${sequence}`, sequence);
      return;
    }
    if (type === 'session.usage.updated') {
      this.handleUsage(payload, eventId ?? `provider_event_${sequence}`, sequence, false);
      return;
    }
    if (type === 'session.closed') {
      this.handleClosed(payload, eventId ?? `provider_event_${sequence}`, sequence);
      return;
    }
    if (ACK_EVENT_TYPES.has(type)) {
      this.handleAcknowledgement(payload, eventId ?? `provider_event_${sequence}`, sequence);
      return;
    }

    this.publishError(
      'UNSUPPORTED_PROVIDER_EVENT',
      'GPT-Live sent an unsupported event type',
      false,
      eventId,
    );
  }

  private handleTranscript(
    payload: ProviderPayload,
    type: string,
    eventId: string,
    sequence: number,
  ): void {
    const role = transcriptRoleForEvent(type);
    if (!role) return;
    const text = transcriptText(payload, type);
    if (text === undefined) {
      this.publishError(
        'INVALID_PROVIDER_EVENT',
        'GPT-Live transcript text is missing',
        false,
        eventId,
      );
      return;
    }
    const timing = transcriptTiming(payload);
    if (timing.invalid) {
      this.publishError(
        'INVALID_PROVIDER_EVENT',
        'GPT-Live transcript timing is invalid',
        false,
        eventId,
      );
      return;
    }
    const fragment: VoiceTranscriptFragment = {
      id: fragmentIdForProviderEvent(eventId, payload),
      role,
      kind: transcriptKind(type),
      sequence,
      text,
      ...(timing.startMs !== undefined ? { startMs: timing.startMs } : {}),
      ...(timing.endMs !== undefined ? { endMs: timing.endMs } : {}),
      receivedAt: this.now(),
    };
    const appended = this.transcript.append(fragment);
    if (appended.outcome === 'duplicate') return;
    this.refreshDelegationContexts();
    this.publish({
      kind: 'transcript',
      eventId,
      sequence,
      fragment: appended.fragment,
    });
    this.resolvePendingDelegations();
  }

  private handleDelegation(payload: ProviderPayload, eventId: string, sequence: number): void {
    const delegation = asRecord(payload.delegation);
    const providerDelegationId = delegation ? firstString(delegation, ['id']) : undefined;
    const target = delegation ? firstString(delegation, ['target', 'type']) : undefined;
    const offsetMs = finiteNumber(payload.offset_ms);
    if (!providerDelegationId || offsetMs === undefined || offsetMs < 0) {
      this.publishError(
        'INVALID_PROVIDER_EVENT',
        'GPT-Live delegation ID or offset is invalid',
        false,
        eventId,
      );
      return;
    }
    const normalizedTarget = target ?? 'client';
    if (this.delegationOffsets.has(providerDelegationId)) {
      const previousOffset = this.delegationOffsets.get(providerDelegationId);
      const previousTarget = this.delegationTargets.get(providerDelegationId) ?? 'client';
      if (previousOffset !== offsetMs || previousTarget !== normalizedTarget) {
        this.retirePendingDelegation(providerDelegationId);
        const previousContext = this.delegationContexts.get(providerDelegationId);
        if (previousContext) {
          this.delegationContexts.set(providerDelegationId, {
            ...previousContext,
            uncertain: true,
            reason: 'delegation_replay_conflict',
          });
        }
        this.publishError(
          'INVALID_PROVIDER_EVENT',
          'GPT-Live replay changed an existing delegation',
          false,
          eventId,
        );
      }
      return;
    }
    if (target && target !== 'client') {
      this.publishError(
        'UNSUPPORTED_DELEGATION_TARGET',
        'GPT-Live delegation target is unsupported',
        false,
        eventId,
      );
      return;
    }

    this.telemetry?.record({
      callId: this.callId,
      stage: 'delegation_received',
      status: 'accepted',
      providerDelegationId,
    });

    const proposal: VoiceDelegationProposal = {
      providerDelegationId,
      offsetMs,
      receivedAt: this.now(),
    };
    const context = this.transcript.captureAt(offsetMs);
    this.observedDelegationCount += 1;
    this.delegationOffsets.set(providerDelegationId, offsetMs);
    this.delegationTargets.set(providerDelegationId, normalizedTarget);
    // Live can announce the first delegation before the corresponding user
    // transcript finishes; keep that first snapshot provisional until the
    // bounded timer freezes it for the service event chain.
    const requiresFreshUserTurn = this.hasPublishedDelegation;
    const waitsForContext = requiresFreshUserTurn ? this.waitsForContext(context) : true;
    const storedContext =
      waitsForContext && requiresFreshUserTurn && context.snapshot && !context.uncertain
        ? { ...context, uncertain: true, reason: 'missing_transcript' as const }
        : context;
    this.rememberDelegationContext(providerDelegationId, storedContext);
    if (waitsForContext) {
      this.schedulePendingDelegation(
        providerDelegationId,
        eventId,
        sequence,
        proposal,
        userContextSignature(context.snapshot),
        userFragmentIds(context.snapshot),
        requiresFreshUserTurn,
      );
      return;
    }
    this.publishDelegation({ eventId, sequence, proposal });
  }

  private handleUsage(
    payload: ProviderPayload,
    eventId: string,
    sequence: number,
    final: boolean,
  ): void {
    const usage = this.readUsage(payload, final);
    if (usage === null) {
      this.publishError('NON_MONOTONIC_USAGE', 'GPT-Live usage was not cumulative', false, eventId);
      return;
    }
    if (!usage) {
      this.publishError(
        'INVALID_PROVIDER_EVENT',
        'GPT-Live usage update is invalid',
        false,
        eventId,
      );
      return;
    }
    this.lastUsage = usage;
    this.publish({ kind: 'usage', eventId, sequence, update: usage });
  }

  private handleClosed(payload: ProviderPayload, eventId: string, sequence: number): void {
    const reason = firstString(payload, ['reason']) ?? 'unknown';
    const finalUsage = this.readUsage(payload, true);
    if (finalUsage === null) {
      this.publishError(
        'NON_MONOTONIC_USAGE',
        'GPT-Live final usage was not cumulative',
        false,
        eventId,
      );
    } else if (finalUsage) {
      this.lastUsage = finalUsage;
    }
    this.retirePendingDelegations();
    this.finalized = true;
    this.finalization = 'confirmed';
    clearTimeout(this.closeTimer);
    this.publish({
      kind: 'session_closed',
      eventId,
      sequence,
      reason,
      ...(finalUsage ? { usage: finalUsage } : {}),
      receivedAt: this.now(),
    });
    this.resolveClose?.(ok(undefined));
    this.resolveClose = undefined;
    this.closeSocket();
  }

  private handleAcknowledgement(payload: ProviderPayload, eventId: string, sequence: number): void {
    const clientEventId = firstString(payload, ['client_event_id']);
    if (!clientEventId) {
      this.publishError(
        'INVALID_PROVIDER_EVENT',
        'GPT-Live acknowledgement ID is missing',
        false,
        eventId,
      );
      return;
    }
    const pending = this.pendingCommands.get(clientEventId);
    if (!pending) {
      this.publishError(
        'UNKNOWN_ACKNOWLEDGEMENT',
        'GPT-Live acknowledgement did not match a command',
        false,
        eventId,
      );
      return;
    }
    this.pendingCommands.delete(clientEventId);
    if (!pending.delegationId) return;
    const providerDelegationId = firstString(payload, ['delegation_id']);
    if (providerDelegationId && providerDelegationId !== pending.delegationId) {
      this.publishError(
        'UNKNOWN_ACKNOWLEDGEMENT',
        'GPT-Live acknowledgement ID did not match its delegation',
        false,
        eventId,
      );
      return;
    }
    this.publish({
      kind: 'provider_acknowledgement',
      eventId,
      sequence,
      delegationId: pending.delegationId,
      outputId: pending.outputId,
      receivedAt: this.now(),
    });
  }

  private handleProviderError(payload: ProviderPayload, eventId: string): void {
    this.retirePendingDelegations();
    const details = asRecord(payload.error);
    const code = (details ? firstString(details, ['code', 'type']) : undefined) ?? 'PROVIDER_ERROR';
    const clientEventId = details
      ? firstString(details, ['client_event_id', 'event_id'])
      : undefined;
    if (clientEventId) this.pendingCommands.delete(clientEventId);
    this.publishError(
      code,
      'GPT-Live rejected or failed an event',
      isRetryableProviderCode(code),
      eventId,
    );
  }

  private readUsage(payload: ProviderPayload, final: boolean): VoiceUsageUpdate | null | undefined {
    const raw = asRecord(payload.usage);
    if (!raw) return undefined;
    const voiceSeconds = finiteNumber(raw.seconds) ?? finiteNumber(raw.voice_seconds);
    const inputTokens = finiteNumber(raw.input_tokens) ?? finiteNumber(raw.inputTokens);
    const outputTokens = finiteNumber(raw.output_tokens) ?? finiteNumber(raw.outputTokens);
    if (voiceSeconds === undefined && inputTokens === undefined && outputTokens === undefined)
      return undefined;
    if ([voiceSeconds, inputTokens, outputTokens].some((value) => value !== undefined && value < 0))
      return undefined;
    if (this.lastUsage) {
      if (
        (voiceSeconds !== undefined &&
          this.lastUsage.voiceSeconds !== undefined &&
          voiceSeconds < this.lastUsage.voiceSeconds) ||
        (inputTokens !== undefined &&
          this.lastUsage.inputTokens !== undefined &&
          inputTokens < this.lastUsage.inputTokens) ||
        (outputTokens !== undefined &&
          this.lastUsage.outputTokens !== undefined &&
          outputTokens < this.lastUsage.outputTokens)
      ) {
        return null;
      }
    }
    return {
      ...(voiceSeconds !== undefined || this.lastUsage?.voiceSeconds !== undefined
        ? { voiceSeconds: voiceSeconds ?? this.lastUsage?.voiceSeconds }
        : {}),
      ...(inputTokens !== undefined || this.lastUsage?.inputTokens !== undefined
        ? { inputTokens: inputTokens ?? this.lastUsage?.inputTokens }
        : {}),
      ...(outputTokens !== undefined || this.lastUsage?.outputTokens !== undefined
        ? { outputTokens: outputTokens ?? this.lastUsage?.outputTokens }
        : {}),
      receivedAt: this.now(),
      final,
    };
  }

  private publish(event: LiveVoiceEvent): void {
    for (const handler of this.handlers) {
      void Promise.resolve(handler(event)).catch(() => undefined);
    }
  }

  private publishError(code: string, message: string, retryable: boolean, eventId?: string): void {
    const sequence = this.nextSequence();
    this.publish({
      kind: 'error',
      eventId: eventId ?? `provider_error_${sequence}`,
      sequence,
      code,
      message,
      retryable,
      receivedAt: this.now(),
    });
  }

  private rememberEvent(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    while (this.seenEventOrder.length > this.maxPendingCommands * 8) {
      const oldest = this.seenEventOrder.shift();
      if (oldest) this.seenEventIds.delete(oldest);
    }
    return true;
  }

  private rememberDelegationContext(id: string, context: TranscriptContextResult): void {
    this.delegationContexts.set(id, context);
    while (this.delegationContexts.size > this.maxPendingCommands) {
      const oldest = this.delegationContexts.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.retirePendingDelegation(oldest);
      this.delegationContexts.delete(oldest);
      this.delegationOffsets.delete(oldest);
      this.delegationTargets.delete(oldest);
    }
  }

  private refreshDelegationContexts(): void {
    for (const [delegationId, offsetMs] of this.delegationOffsets) {
      const previous = this.delegationContexts.get(delegationId);
      if (!previous) continue;
      if (previous.reason === 'delegation_replay_conflict') continue;
      const refreshed = this.transcript.captureAt(offsetMs);
      const pending = this.pendingDelegations.get(delegationId);
      if (
        pending &&
        pending.requiresFreshUserTurn !== true &&
        !this.publishedDelegations.has(delegationId)
      ) {
        if (pending.absoluteDeadline !== undefined && this.now() >= pending.absoluteDeadline) {
          const now = this.now();
          if (canPreserveSettledFirstContext(pending, previous, refreshed, now)) {
            // A delayed assistant or timing callback can arrive at the hard
            // cutoff without changing the captured user request. Preserve the
            // settled candidate and let the absolute timer publish it.
            this.delegationContexts.set(delegationId, refreshed);
          } else {
            this.terminalizeUnsafeDelegationContext(delegationId, previous);
          }
          continue;
        }
        this.delegationContexts.set(delegationId, refreshed);
        if (contextChangedMeaningfully(previous, refreshed)) {
          this.resetFirstPendingQuiet(delegationId);
        }
        continue;
      }
      if (previous.uncertain) {
        if (previous.reason !== 'missing_transcript') continue;
        if (refreshed.uncertain) {
          if (this.publishedDelegations.has(delegationId)) {
            const signature = userContextSignature(refreshed.snapshot);
            if (signature) this.rememberBlockedUserSignature(signature);
          }
          this.delegationContexts.set(
            delegationId,
            refreshed.reason
              ? { ...refreshed, uncertain: true, reason: refreshed.reason }
              : { ...refreshed, uncertain: true },
          );
        } else {
          const signature = userContextSignature(refreshed.snapshot);
          if (this.publishedDelegations.has(delegationId)) {
            if (signature) this.rememberBlockedUserSignature(signature);
            this.delegationContexts.set(delegationId, {
              ...refreshed,
              uncertain: true,
              reason: 'missing_transcript',
            });
            continue;
          }
          const reusedPendingContext =
            pending?.requiresFreshUserTurn === true &&
            !hasFreshUserTurn(pending, refreshed.snapshot);
          const reusedAdmittedContext =
            pending?.requiresFreshUserTurn === true &&
            signature !== undefined &&
            this.publishedUserSignatures.has(signature);
          const blocked = signature !== undefined && this.blockedUserSignatures.has(signature);
          if (reusedPendingContext || reusedAdmittedContext || blocked) {
            this.delegationContexts.set(delegationId, {
              ...refreshed,
              uncertain: true,
              reason: 'missing_transcript',
            });
            if (this.publishedDelegations.has(delegationId) && signature) {
              this.rememberBlockedUserSignature(signature);
            }
          } else {
            this.delegationContexts.set(delegationId, refreshed);
          }
        }
        continue;
      }
      if (refreshed.uncertain) {
        this.delegationContexts.set(
          delegationId,
          refreshed.reason
            ? { ...refreshed, uncertain: true, reason: refreshed.reason }
            : { ...refreshed, uncertain: true },
        );
        continue;
      }
      if (userContextSignature(previous.snapshot) === userContextSignature(refreshed.snapshot)) {
        // Keep the admitted full snapshot stable across assistant speech and
        // timing metadata that leaves the captured user turn unchanged.
        continue;
      }
      this.delegationContexts.set(delegationId, {
        ...refreshed,
        uncertain: true,
        reason: 'transcript_changed',
      });
    }
  }

  private waitsForContext(context: TranscriptContextResult): boolean {
    if (context.uncertain || !context.snapshot) return true;
    const signature = userContextSignature(context.snapshot);
    return (
      signature === undefined ||
      this.publishedUserSignatures.has(signature) ||
      (signature !== undefined && this.blockedUserSignatures.has(signature))
    );
  }

  private schedulePendingDelegation(
    providerDelegationId: string,
    eventId: string,
    sequence: number,
    proposal: VoiceDelegationProposal,
    baselineUserSignature: string | undefined,
    baselineUserIds: readonly string[],
    requiresFreshUserTurn: boolean,
  ): void {
    this.retirePendingDelegation(providerDelegationId);
    const receiptAt = proposal.receivedAt;
    const firstNotice = requiresFreshUserTurn !== true;
    const pending: PendingDelegation = {
      eventId,
      sequence,
      proposal,
      receiptAt,
      ...(firstNotice
        ? { absoluteDeadline: receiptAt + DEFAULT_DELEGATION_CONTEXT_DEADLINE_MS }
        : {}),
      quietDeadline: receiptAt + DEFAULT_DELEGATION_CONTEXT_QUIET_MS,
      quietTimer: setTimeout(() => undefined, 0),
      requiresFreshUserTurn,
      baselineUserIds,
      ...(baselineUserSignature ? { baselineUserSignature } : {}),
    };
    this.pendingDelegations.set(providerDelegationId, pending);
    this.armPendingQuietTimer(providerDelegationId, pending);
    if (firstNotice) this.armPendingAbsoluteTimer(providerDelegationId, pending);
    const context = this.delegationContexts.get(providerDelegationId);
    this.logPendingDiagnostic(
      pending,
      'pending',
      context?.reason ?? (context?.uncertain ? 'missing_transcript' : 'quiet_pending'),
    );
  }

  private resetFirstPendingQuiet(providerDelegationId: string): void {
    const pending = this.pendingDelegations.get(providerDelegationId);
    if (
      !pending ||
      pending.requiresFreshUserTurn === true ||
      this.publishedDelegations.has(providerDelegationId)
    )
      return;
    const now = this.now();
    if (pending.absoluteDeadline !== undefined && now >= pending.absoluteDeadline) return;
    pending.quietDeadline = now + DEFAULT_DELEGATION_CONTEXT_QUIET_MS;
    this.armPendingQuietTimer(providerDelegationId, pending);
  }

  private armPendingQuietTimer(providerDelegationId: string, pending: PendingDelegation): void {
    clearTimeout(pending.quietTimer);
    const delay = Math.max(0, pending.quietDeadline - this.now());
    pending.quietTimer = setTimeout(() => {
      this.handlePendingQuietExpiry(providerDelegationId);
    }, delay);
  }

  private armPendingAbsoluteTimer(providerDelegationId: string, pending: PendingDelegation): void {
    if (pending.absoluteDeadline === undefined) return;
    clearTimeout(pending.absoluteTimer);
    const delay = Math.max(0, pending.absoluteDeadline - this.now());
    pending.absoluteTimer = setTimeout(() => {
      this.handlePendingAbsoluteExpiry(providerDelegationId);
    }, delay);
  }

  private handlePendingQuietExpiry(providerDelegationId: string): void {
    const pending = this.pendingDelegations.get(providerDelegationId);
    if (!pending) return;
    const now = this.now();
    if (now < pending.quietDeadline) {
      this.armPendingQuietTimer(providerDelegationId, pending);
      return;
    }
    if (this.finalized || this.closeRequested || !this.connected || now >= this.expiresAt) {
      this.retirePendingDelegation(providerDelegationId);
      return;
    }
    if (pending.requiresFreshUserTurn === true) {
      this.publishDelegation(pending);
      return;
    }
    const context = this.delegationContexts.get(providerDelegationId);
    if (!context || context.uncertain || context.reason !== undefined) {
      this.logPendingDiagnostic(pending, 'quiet_wait', context?.reason ?? 'missing_transcript');
      return;
    }
    if (pending.absoluteDeadline !== undefined && now >= pending.absoluteDeadline) {
      this.handlePendingAbsoluteExpiry(providerDelegationId);
      return;
    }
    this.publishDelegation(pending);
  }

  private handlePendingAbsoluteExpiry(providerDelegationId: string): void {
    const pending = this.pendingDelegations.get(providerDelegationId);
    if (!pending || pending.absoluteDeadline === undefined) return;
    const now = this.now();
    if (now < pending.absoluteDeadline) {
      this.armPendingAbsoluteTimer(providerDelegationId, pending);
      return;
    }
    if (this.finalized || this.closeRequested || !this.connected || now >= this.expiresAt) {
      this.retirePendingDelegation(providerDelegationId);
      return;
    }
    const context = this.delegationContexts.get(providerDelegationId);
    const settled =
      context !== undefined &&
      !context.uncertain &&
      context.reason === undefined &&
      pending.quietDeadline <= pending.absoluteDeadline &&
      now >= pending.quietDeadline;
    if (!settled) {
      this.terminalizeUnsafeDelegationContext(providerDelegationId, context);
      this.logPendingDiagnostic(pending, 'invalidated', 'absolute_expiry');
    }
    this.publishDelegation(pending);
  }

  private resolvePendingDelegations(): void {
    if (this.pendingDelegations.size === 0) return;
    for (const [providerDelegationId, pending] of this.pendingDelegations) {
      if (pending.requiresFreshUserTurn !== true) continue;
      if (
        this.finalized ||
        this.closeRequested ||
        !this.connected ||
        this.now() >= this.expiresAt
      ) {
        this.retirePendingDelegation(providerDelegationId);
        continue;
      }
      const context = this.delegationContexts.get(providerDelegationId);
      if (!context || context.uncertain || context.reason !== undefined) continue;
      const signature = userContextSignature(context.snapshot);
      if (
        !signature ||
        !hasFreshUserTurn(pending, context.snapshot) ||
        signature === pending.baselineUserSignature ||
        this.publishedUserSignatures.has(signature) ||
        this.blockedUserSignatures.has(signature)
      )
        continue;
      this.publishDelegation(pending);
    }
  }

  private publishDelegation(pending: DelegationPublication): void {
    const providerDelegationId = pending.proposal.providerDelegationId;
    if (
      this.publishedDelegations.has(providerDelegationId) ||
      this.finalized ||
      this.closeRequested
    ) {
      return;
    }
    const context = this.delegationContexts.get(providerDelegationId);
    const signature = userContextSignature(context?.snapshot ?? null);
    const reusesPublishedContext =
      signature !== undefined && this.publishedUserSignatures.has(signature);
    this.hasPublishedDelegation = true;
    const unsafeContext =
      !context || context.uncertain || context.reason !== undefined || !signature;
    const unsafeFreshTurn =
      pending.requiresFreshUserTurn === true &&
      (!hasFreshUserTurn(pending, context?.snapshot ?? null) ||
        signature === pending.baselineUserSignature ||
        (signature !== undefined && this.blockedUserSignatures.has(signature)));
    if (reusesPublishedContext || unsafeContext || unsafeFreshTurn) {
      this.terminalizeUnsafeDelegationContext(providerDelegationId, context);
      this.logPublicationDiagnostic(
        providerDelegationId,
        'invalidated',
        reusesPublishedContext
          ? 'published_context_reuse'
          : (context?.reason ?? 'missing_transcript'),
      );
    }
    this.rememberPublishedDelegation(providerDelegationId);
    this.retirePendingDelegation(providerDelegationId);
    const publishedContext = this.delegationContexts.get(providerDelegationId);
    if (publishedContext && !publishedContext.uncertain) {
      const signature = userContextSignature(publishedContext.snapshot);
      if (signature) this.rememberPublishedUserSignature(signature);
    }
    this.logPublicationDiagnostic(providerDelegationId, 'published', undefined);
    this.telemetry?.record({
      callId: this.callId,
      stage: 'delegation_published',
      status: 'accepted',
      providerDelegationId,
    });
    this.publish({
      kind: 'delegation',
      eventId: pending.eventId,
      sequence: pending.sequence,
      proposal: pending.proposal,
    });
  }

  private retirePendingDelegation(providerDelegationId: string): void {
    const pending = this.pendingDelegations.get(providerDelegationId);
    if (!pending) return;
    clearTimeout(pending.quietTimer);
    clearTimeout(pending.absoluteTimer);
    this.pendingDelegations.delete(providerDelegationId);
  }

  private logPendingDiagnostic(
    pending: PendingDelegation,
    event: Exclude<VoiceContextDiagnosticEvent, 'closed'>,
    reason: VoiceContextDiagnosticReason | undefined,
  ): void {
    this.logDiagnostic({
      correlationId: this.diagnosticCorrelationId,
      event,
      reason,
      elapsedMs: boundedDuration(this.now() - pending.receiptAt),
      observedDelegations: this.observedDelegationCount,
    });
  }

  private logPublicationDiagnostic(
    providerDelegationId: string,
    event: Exclude<VoiceContextDiagnosticEvent, 'closed'>,
    reason: VoiceContextDiagnosticReason | undefined,
  ): void {
    const pending = this.pendingDelegations.get(providerDelegationId);
    if (pending) {
      this.logPendingDiagnostic(pending, event, reason);
      return;
    }
    this.logDiagnostic({
      correlationId: this.diagnosticCorrelationId,
      event,
      reason,
      observedDelegations: this.observedDelegationCount,
    });
  }

  private logDiagnostic(input: {
    readonly correlationId: string;
    readonly event: VoiceContextDiagnosticEvent;
    readonly reason?: VoiceContextDiagnosticReason;
    readonly elapsedMs?: number;
    readonly observedDelegations?: number;
    readonly observation?: VoiceContextDiagnosticObservation;
    readonly availability?: 'available' | 'unavailable';
    readonly available?: boolean;
    readonly opened?: boolean;
    readonly finalized?: boolean;
    readonly closeRequested?: boolean;
    readonly observationDurationMs?: number;
  }): void {
    if (!this.logger) return;
    try {
      const fields = {
        voiceCorrelationId: input.correlationId,
        event: input.event,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
        ...(input.observedDelegations !== undefined
          ? { observedDelegations: input.observedDelegations }
          : {}),
        ...(input.observation ? { observation: input.observation } : {}),
        ...(input.availability ? { availability: input.availability } : {}),
        ...(input.available !== undefined ? { available: input.available } : {}),
        ...(input.opened !== undefined ? { opened: input.opened } : {}),
        ...(input.finalized !== undefined ? { finalized: input.finalized } : {}),
        ...(input.closeRequested !== undefined ? { closeRequested: input.closeRequested } : {}),
        ...(input.observationDurationMs !== undefined
          ? { observationDurationMs: input.observationDurationMs }
          : {}),
      };
      if (input.event === 'invalidated') {
        this.logger.warn(fields, 'voice context diagnostic');
      } else {
        this.logger.info(fields, 'voice context diagnostic');
      }
    } catch {
      // Diagnostics are observational and must never affect admission.
    }
  }

  private logCloseSummary(): void {
    if (this.diagnosticsClosed) return;
    this.diagnosticsClosed = true;
    this.logDiagnostic({
      correlationId: this.diagnosticCorrelationId,
      event: 'closed',
      observation: 'sideband_lifetime',
      observedDelegations: this.observedDelegationCount,
      availability: this.opened ? 'available' : 'unavailable',
      available: this.opened,
      opened: this.opened,
      finalized: this.finalized,
      closeRequested: this.closeRequested,
      observationDurationMs: boundedDuration(this.now() - this.diagnosticStartedAt),
    });
  }

  private rememberPublishedDelegation(providerDelegationId: string): void {
    if (this.publishedDelegations.has(providerDelegationId)) return;
    this.publishedDelegations.add(providerDelegationId);
    this.publishedDelegationOrder.push(providerDelegationId);
    while (this.publishedDelegationOrder.length > this.maxPendingCommands) {
      const oldest = this.publishedDelegationOrder.shift();
      if (oldest) this.publishedDelegations.delete(oldest);
    }
  }

  private rememberPublishedUserSignature(signature: string): void {
    if (this.publishedUserSignatures.has(signature)) return;
    this.publishedUserSignatures.add(signature);
    this.publishedUserSignatureOrder.push(signature);
    while (this.publishedUserSignatureOrder.length > this.maxPendingCommands) {
      const oldest = this.publishedUserSignatureOrder.shift();
      if (oldest) this.publishedUserSignatures.delete(oldest);
    }
  }

  private terminalizeUnsafeDelegationContext(
    providerDelegationId: string,
    context: TranscriptContextResult | undefined,
  ): void {
    const signature = userContextSignature(context?.snapshot ?? null);
    if (signature) this.rememberBlockedUserSignature(signature);
    if (!context || context.uncertain) return;
    this.delegationContexts.set(providerDelegationId, {
      ...context,
      uncertain: true,
      reason: 'missing_transcript',
    });
  }

  private rememberBlockedUserSignature(signature: string): void {
    if (this.blockedUserSignatures.has(signature)) return;
    this.blockedUserSignatures.add(signature);
    this.blockedUserSignatureOrder.push(signature);
    while (this.blockedUserSignatureOrder.length > this.maxPendingCommands) {
      const oldest = this.blockedUserSignatureOrder.shift();
      if (oldest) this.blockedUserSignatures.delete(oldest);
    }
  }

  private retirePendingDelegations(): void {
    for (const providerDelegationId of this.pendingDelegations.keys()) {
      this.retirePendingDelegation(providerDelegationId);
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private closeSocket(force = false): void {
    this.connected = false;
    this.retirePendingDelegations();
    this.logCloseSummary();
    clearTimeout(this.closeTimer);
    if (force) {
      try {
        if (this.socket.terminate) this.socket.terminate();
        else this.socket.close(1000, 'closed');
      } catch {
        try {
          this.socket.close(1000, 'closed');
        } catch {
          // The transport is already unavailable; the caller records the close failure.
        }
      }
      return;
    }
    if (this.socket.readyState !== 3) {
      try {
        this.socket.close(1000, 'closed');
      } catch {
        this.socket.terminate?.();
      }
    } else {
      this.socket.terminate?.();
    }
  }
}

export const OpenAILiveVoiceProvider = OpenAiLiveVoiceProvider;
export const OpenAiLiveProvider = OpenAiLiveVoiceProvider;

const TRANSCRIPT_EVENT_RE =
  /^session\.(input|output)_transcript\.(delta|completed|complete|correction)$/;
const NORMALIZED_PROVIDER_EVENT_TYPES = new Set([
  'session.delegation.created',
  'session.usage.updated',
  'session.closed',
  'session.commentary.appended',
  'session.thinking.appended',
  'session.instructions.appended',
  'session.instruction.appended',
]);
const ACK_EVENT_TYPES = new Set([
  'session.commentary.appended',
  'session.thinking.appended',
  'session.instructions.appended',
  'session.instruction.appended',
]);
const IGNORED_PROVIDER_EVENT_TYPES = new Set([
  'session.input_audio.muted',
  'session.input_audio.unmuted',
  'session.input_audio.append',
  'session.rate_limits.updated',
  'response.created',
  'response.done',
  'response.audio.delta',
  'response.audio.done',
  'session.output_audio.delta',
  'session.output_audio.done',
]);

function providerError(
  reason: LiveProviderErrorReason,
  message: string,
  status?: number,
  cause?: unknown,
): LiveProviderError {
  return new LiveProviderError(reason, message, status, cause instanceof Error ? cause : undefined);
}

function validateSessionRequest(input: LiveVoiceSessionRequest): LiveProviderError | undefined {
  if (
    !input ||
    typeof input !== 'object' ||
    !nonEmptyString(input.sessionId) ||
    !nonEmptyString(input.ownerId) ||
    !nonEmptyString(input.modelName) ||
    !nonEmptyString(input.instructions)
  ) {
    return providerError(
      'invalid_request',
      'GPT-Live session identity and instructions are required',
    );
  }
  if (input.delegationMode !== 'client') {
    return providerError('invalid_request', 'GPT-Live must use client delegation');
  }
  if (!input.transport || input.transport.type !== 'webrtc') {
    return providerError('unsupported_transport', 'GPT-Live adapter only supports WebRTC offers');
  }
  if (typeof input.transport.sdp !== 'string' || input.transport.sdp.length > 1_000_000) {
    return providerError('invalid_request', 'GPT-Live WebRTC offer is invalid');
  }
  return undefined;
}

function validateIncomingSessionRequest(
  input: LiveVoiceIncomingSessionRequest,
  now: number,
): LiveProviderError | undefined {
  if (
    !input ||
    typeof input !== 'object' ||
    !nonEmptyString(input.sessionId) ||
    !nonEmptyString(input.providerSessionId) ||
    !nonEmptyString(input.modelName) ||
    !nonEmptyString(input.voice) ||
    !nonEmptyString(input.instructions) ||
    input.delegationMode !== 'client' ||
    !Number.isSafeInteger(input.admissionExpiresAt) ||
    input.admissionExpiresAt <= now ||
    !Number.isSafeInteger(input.sessionExpiresAt) ||
    input.sessionExpiresAt <= now
  ) {
    return providerError(
      'invalid_request',
      'GPT-Live incoming session identity, voice, and expiry are required',
    );
  }
  return undefined;
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function asRecord(value: unknown): ProviderPayload | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as ProviderPayload;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nestedString(payload: ProviderPayload, keys: readonly string[]): string | undefined {
  let current: unknown = payload;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return stringValue(current);
}

function socketDataToString(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

function transcriptText(payload: ProviderPayload, type: string): string | undefined {
  const candidate = type.endsWith('.delta')
    ? payload.delta
    : (payload.text ?? payload.transcript ?? payload.delta);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function transcriptKind(type: string): VoiceTranscriptFragmentKind {
  if (type.endsWith('.correction')) return 'correction';
  if (type.endsWith('.completed') || type.endsWith('.complete')) return 'completed';
  return 'delta';
}

function transcriptTiming(payload: ProviderPayload): {
  readonly startMs?: number;
  readonly endMs?: number;
  readonly invalid: boolean;
} {
  const startMs = finiteNumber(payload.start_ms) ?? finiteNumber(payload.offset_ms);
  const endMs = finiteNumber(payload.end_ms);
  if (startMs !== undefined && startMs < 0) return { invalid: true };
  if (endMs !== undefined && endMs < 0) return { invalid: true };
  if (startMs !== undefined && endMs !== undefined && endMs < startMs) return { invalid: true };
  return {
    ...(startMs !== undefined ? { startMs } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
    invalid: false,
  };
}

function isRetryableProviderCode(code: string): boolean {
  const normalized = code.toLowerCase();
  return (
    normalized.includes('timeout') ||
    normalized.includes('rate') ||
    normalized.includes('server') ||
    normalized.includes('overload') ||
    normalized.includes('unavailable')
  );
}

function userFragmentIds(snapshot: VoiceContextSnapshot | null): readonly string[] {
  return (
    snapshot?.fragments
      .filter((fragment) => fragment.role === 'user')
      .map((fragment) => fragment.id) ?? []
  );
}

function hasFreshUserTurn(
  pending: Pick<PendingDelegation, 'baselineUserIds'>,
  snapshot: VoiceContextSnapshot | null,
): boolean {
  const baselineIds = new Set(pending.baselineUserIds ?? []);
  return (
    snapshot?.fragments.some(
      (fragment) =>
        fragment.role === 'user' && fragment.kind !== 'correction' && !baselineIds.has(fragment.id),
    ) ?? false
  );
}

function webSocketBaseUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`;
  return baseUrl;
}
