import type {
  VoiceCloseReason,
  VoiceBrowserTelemetrySample,
  VoiceCreateSessionHttpResponse,
  VoiceDelegationStatusDto,
  VoiceErrorHttpResponse,
  VoiceGetSessionHttpResponse,
  VoiceNotificationStatusDto,
  VoiceOutputStatusDto,
  VoiceSessionStatusDto,
  VoiceStatusEventDto,
  VoiceTransportAnswer,
  VoiceUsageSummary,
} from '../voice-types.js';

export type VoiceBrowserPhase =
  | 'logged_out'
  | 'ready'
  | 'requesting_microphone'
  | 'connecting'
  | 'connected'
  | 'network_lost'
  | 'closing'
  | 'closed'
  | 'failed';

export interface VoiceBrowserState {
  readonly authenticated: boolean;
  readonly phase: VoiceBrowserPhase;
  readonly message: string;
  readonly errorMessage: string | null;
  /** The session that still owns the live transport and can be closed. */
  readonly activeSessionId: string | null;
  /** The last session whose retained results can still be displayed. */
  readonly retainedSessionId: string | null;
  readonly session: VoiceSessionStatusDto | null;
  readonly delegations: readonly VoiceDelegationStatusDto[];
  readonly notifications: readonly VoiceNotificationStatusDto[];
  readonly outputs: readonly VoiceOutputStatusDto[];
  readonly usage: VoiceUsageSummary;
  readonly pendingDelegation: boolean;
  readonly muted: boolean;
  readonly audioBlocked: boolean;
  /** Bounded local loss diagnostics for the current or most recent call. */
  readonly browserTelemetry: VoiceBrowserTelemetryDiagnostics;
}

export interface VoiceBrowserTelemetryDiagnostics {
  /** Samples whose outcome could not be known after a send attempt failed. */
  readonly unknownCount: number;
  /** Samples discarded locally before a send attempt, such as queue saturation. */
  readonly droppedCount: number;
}
export type VoiceFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface VoiceEventSource {
  readonly readyState?: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export type VoiceEventSourceFactory = (
  url: string,
  init?: EventSourceInit,
) => VoiceEventSource;

export interface VoicePeerConnection {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceGatheringState: RTCIceGatheringState;
  readonly localDescription: RTCSessionDescription | null;
  onconnectionstatechange: ((event: Event) => void) | null;
  onicegatheringstatechange: ((event: Event) => void) | null;
  ontrack: ((event: RTCTrackEvent) => void) | null;
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender;
  createDataChannel(label: string): RTCDataChannel;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  close(): void;
}

export interface VoiceMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface VoiceSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VoiceAudioElement {
  srcObject: MediaProvider | null;
  play(): Promise<void>;
  pause(): void;
}

export interface VoiceVisibilitySource {
  readonly visibilityState?: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface VoiceBrowserClientOptions {
  readonly apiBase?: string;
  readonly fetch?: VoiceFetch;
  readonly eventSourceFactory?: VoiceEventSourceFactory;
  readonly peerConnectionFactory?: () => VoicePeerConnection;
  readonly mediaDevices?: VoiceMediaDevices;
  readonly audioElement?: VoiceAudioElement;
  readonly visibilitySource?: VoiceVisibilitySource;
  readonly sessionStorage?: VoiceSessionStorage;
  readonly csrfToken?: () => string | null;
  readonly onStateChange?: (state: VoiceBrowserState) => void;
}

export interface VoiceBrowserLoginOptions {
  /** Request the fixed one-year browser grant; omitted keeps the short grant. */
  readonly rememberMe?: boolean;
}

export class VoiceBrowserError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = 'VOICE_CLIENT_ERROR', retryable = true) {
    super(message);
    this.name = 'VoiceBrowserError';
    this.code = code;
    this.retryable = retryable;
  }
}

const INITIAL_USAGE: VoiceUsageSummary = {
  voiceCostStatus: 'unavailable',
  backendCostStatus: 'unavailable',
};

const INITIAL_BROWSER_TELEMETRY: VoiceBrowserTelemetryDiagnostics = {
  unknownCount: 0,
  droppedCount: 0,
};

const INITIAL_STATE: VoiceBrowserState = {
  authenticated: false,
  phase: 'logged_out',
  message: 'Sign in to start a call.',
  errorMessage: null,
  activeSessionId: null,
  retainedSessionId: null,
  session: null,
  delegations: [],
  notifications: [],
  outputs: [],
  usage: INITIAL_USAGE,
  pendingDelegation: false,
  muted: false,
  audioBlocked: false,
  browserTelemetry: INITIAL_BROWSER_TELEMETRY,
};

const ACTIVE_PHASES: ReadonlySet<VoiceBrowserPhase> = new Set([
  'requesting_microphone',
  'connecting',
  'connected',
  'network_lost',
  'closing',
]);

const PENDING_DELEGATION_STATUSES = new Set([
  'admitted',
  'queued',
  'claimed',
  'running',
]);

const SESSION_STORAGE_KEY = 'talon.voice.session-id';
const ICE_GATHERING_TIMEOUT_MS = 10_000;
const BROWSER_TELEMETRY_MAX_SAMPLES = 256;
const BROWSER_TELEMETRY_BATCH_SIZE = 16;
const BROWSER_TELEMETRY_ABORT_MS = 2_000;
const BROWSER_TELEMETRY_CATEGORIES = ['rtc', 'audio', 'visibility', 'interruption'] as const;
const BROWSER_TELEMETRY_MAX_UNKNOWN_SAMPLES = 256;
const AUTH_RECOVERY_MESSAGE = 'Talon could not confirm your sign-in. Check your connection and try again.';
const RETAINED_SESSION_RECOVERY_MESSAGE =
  'Your sign-in is active, but the previous call could not be restored. Check your connection and try again.';

interface VoiceAuthSessionHttpResponse {
  readonly authenticated: true;
  readonly expiresAt: number;
}

class VoiceAttemptCancelledError extends Error {
  constructor() {
    super('Voice-opstart is geannuleerd.');
    this.name = 'VoiceAttemptCancelledError';
  }
}

/**
 * Small browser-side boundary for the authenticated voice HTTP API and WebRTC
 * transport. Provider events stay on the server; this client only renders
 * redacted status and retained output DTOs.
 */
export class VoiceBrowserClient {
  private readonly apiBase: string;
  private readonly fetcher: VoiceFetch;
  private readonly eventSourceFactory: VoiceEventSourceFactory;
  private readonly peerConnectionFactory: () => VoicePeerConnection;
  private readonly mediaDevices: VoiceMediaDevices;
  private readonly audioElement: VoiceAudioElement | undefined;
  private readonly visibilitySource: VoiceVisibilitySource | undefined;
  private readonly sessionStorage: VoiceSessionStorage | undefined;
  private readonly csrfToken: () => string | null;
  private readonly onStateChange: ((state: VoiceBrowserState) => void) | undefined;

  private stateValue: VoiceBrowserState = INITIAL_STATE;
  private activeSessionId: string | null = null;
  private retainedSessionId: string | null = null;
  private peer: VoicePeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private eventSource: VoiceEventSource | null = null;
  private startPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private transportConnected = false;
  private providerReady = false;
  private readonly telemetryQueue: VoiceBrowserTelemetrySample[] = [];
  private readonly telemetryUnknownCounts: Record<VoiceBrowserTelemetrySample['category'], number> = {
    rtc: 0,
    audio: 0,
    visibility: 0,
    interruption: 0,
  };
  private telemetryInFlight: Promise<void> | null = null;
  private telemetryAbortController: AbortController | null = null;
  private telemetryAbortTimer: ReturnType<typeof setTimeout> | null = null;
  private telemetryRtcStartedAt: number | undefined;
  private telemetryVisibilityAttached = false;
  private readonly visibilityListener = (): void => this.recordVisibility();
  private readonly stoppedStreams = new WeakSet<MediaStream>();
  private readonly closedPeers = new WeakSet<VoicePeerConnection>();

  constructor(options: VoiceBrowserClientOptions = {}) {
    this.apiBase = normalizeApiBase(options.apiBase ?? '/voice');
    this.fetcher = options.fetch ?? defaultFetch;
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
    this.peerConnectionFactory = options.peerConnectionFactory ?? defaultPeerConnectionFactory;
    this.mediaDevices = options.mediaDevices ?? defaultMediaDevices();
    this.audioElement = options.audioElement;
    this.visibilitySource = options.visibilitySource ?? defaultVisibilitySource();
    this.sessionStorage = options.sessionStorage ?? defaultSessionStorage();
    this.csrfToken = options.csrfToken ?? readBrowserCsrfToken;
    this.onStateChange = options.onStateChange;
  }

  get state(): VoiceBrowserState {
    return this.stateValue;
  }

  async login(accessToken: string, options: VoiceBrowserLoginOptions = {}): Promise<void> {
    if (accessToken.trim().length === 0) {
      throw this.fail('Enter your access token.', 'INVALID_REQUEST', false);
    }

    const body: { accessToken: string; rememberMe?: boolean } = { accessToken };
    if (options.rememberMe !== undefined) {
      if (typeof options.rememberMe !== 'boolean') {
        throw this.fail('Choose a valid remembered-login option.', 'INVALID_REQUEST', false);
      }
      body.rememberMe = options.rememberMe;
    }

    const generation = this.invalidateLifecycle();
    await this.requestJson('/login', {
      method: 'POST',
      body,
    });
    this.ensureCurrent(generation);
    this.setAuthenticatedReady('Ready to call.', null, true);
  }

  /** Restore one retained/live session after a page refresh using the cookie. */
  async restore(): Promise<void> {
    const generation = this.invalidateLifecycle();
    let authenticated: VoiceAuthSessionHttpResponse;
    try {
      authenticated = await this.requestAuthSession();
      this.ensureCurrent(generation);
    } catch (cause) {
      if (!this.isCurrent(generation)) return;
      if (isUnauthorizedError(cause)) {
        this.setLoggedOut();
        return;
      }
      const error = recoveryError(cause, AUTH_RECOVERY_MESSAGE);
      this.setState({ message: error.message, errorMessage: error.message });
      throw error;
    }

    if (authenticated.authenticated !== true || !Number.isFinite(authenticated.expiresAt)) {
      const error = this.fail(AUTH_RECOVERY_MESSAGE, 'AUTH_CHECK_FAILED');
      this.setState({ message: error.message, errorMessage: error.message });
      throw error;
    }

    const sessionId = this.readPersistedSession();
    if (!sessionId) {
      this.setAuthenticatedReady('Ready to call.', null);
      return;
    }

    try {
      const response = await this.requestJson<VoiceGetSessionHttpResponse>(
        `/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'GET' },
      );
      this.ensureCurrent(generation);
      this.setState({ authenticated: true, errorMessage: null });
      this.applySessionStatus(response.session);
      if (!isTerminalSession(response.session.status)) {
        this.transportConnected = false;
        this.setState({
          phase: 'network_lost',
          message: 'This call is still active. Reconnect audio or end the call.',
        });
        this.openEventStream(response.session.id);
      } else if (this.stateValue.pendingDelegation) {
        this.openEventStream(response.session.id);
        this.setState({ message: 'Call ended. A task is still completing.' });
      } else {
        this.setState({ message: 'Call ended.' });
      }
    } catch (cause) {
      if (!this.isCurrent(generation)) return;
      if (isUnauthorizedError(cause)) {
        this.setLoggedOut();
        return;
      }
      if (isNotFoundError(cause)) {
        this.clearPersistedSession();
        this.setAuthenticatedReady('Ready to call.', null);
        return;
      }
      const error = recoveryError(cause, RETAINED_SESSION_RECOVERY_MESSAGE);
      this.setAuthenticatedReady(RETAINED_SESSION_RECOVERY_MESSAGE, error.message);
      throw error;
    }
  }

  startCall(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const promise = this.startCallInternal().finally(() => {
      this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  toggleMute(): boolean {
    if (!this.localStream) return this.stateValue.muted;
    const nextMuted = !this.stateValue.muted;
    for (const track of this.localStream.getAudioTracks()) track.enabled = !nextMuted;
    this.setState({ muted: nextMuted });
    return nextMuted;
  }

  async resumeAudio(): Promise<void> {
    await this.playAudio();
  }

  async hangup(reason: VoiceCloseReason = 'hangup'): Promise<void> {
    const generation = this.invalidateLifecycle();
    const currentSessionId = this.activeSessionId;
    const capturedPeer = this.peer;
    const capturedStream = this.localStream;
    const capturedEventSource = this.eventSource;
    if (!currentSessionId) {
      this.disposeTransport();
      if (this.stateValue.authenticated) {
        this.setState({ phase: 'ready', message: 'Ready to call.' });
      }
      return;
    }

    this.setState({ phase: 'closing', message: 'Ending the call.', errorMessage: null });

    let closeError: VoiceBrowserError | null = null;
    try {
      const response = await this.requestJson<{
        readonly session: VoiceSessionStatusDto;
        readonly pendingDelegation: boolean;
      }>(`/sessions/${encodeURIComponent(currentSessionId)}/close`, {
        method: 'POST',
        body: { reason },
        csrf: true,
      });
      this.ensureCurrent(generation);
      this.applySessionStatus(response.session, response.pendingDelegation);
    } catch (cause) {
      if (cause instanceof VoiceAttemptCancelledError) {
        return;
      }
      closeError = asVoiceBrowserError(cause, 'The call could not be fully ended.');
    } finally {
      if (this.isCurrent(generation)) {
        this.releaseCapturedTransport(generation, capturedPeer, capturedStream);
        if (closeError || !this.stateValue.pendingDelegation) {
          this.closeEventStream(capturedEventSource);
        }
      }
    }

    if (!this.isCurrent(generation)) return;

    if (closeError) {
      this.setState({
        phase: 'failed',
        message: closeError.message,
        errorMessage: closeError.message,
      });
      throw closeError;
    }

    const pending = this.stateValue.pendingDelegation;
    this.setState({
      phase: 'closed',
      message: pending
        ? 'Call ended. A task is still completing.'
        : 'Call ended.',
      errorMessage: null,
    });
  }

  async logout(): Promise<void> {
    let generation = this.invalidateLifecycle();
    if (ACTIVE_PHASES.has(this.stateValue.phase) || this.activeSessionId) {
      try {
        await this.hangup('logout');
      } catch {
        // Revocation below remains the authority even if session cleanup failed.
      }
      generation = this.invalidateLifecycle();
    }

    let logoutError: VoiceBrowserError | null = null;
    try {
      await this.requestJson('/logout', { method: 'POST', csrf: true });
      this.ensureCurrent(generation);
    } catch (cause) {
      logoutError = asVoiceBrowserError(cause, 'Sign out was not completed.');
    }
    if (!this.isCurrent(generation)) return;

    this.disposeTransport();
    this.clearPersistedSession();
    this.activeSessionId = null;
    this.retainedSessionId = null;
    this.setState({
      authenticated: false,
      phase: 'logged_out',
      message: 'Sign in to start a call.',
      errorMessage: null,
      activeSessionId: null,
      retainedSessionId: null,
      session: null,
      delegations: [],
      outputs: [],
      usage: INITIAL_USAGE,
      pendingDelegation: false,
      muted: false,
      audioBlocked: false,
    });
    if (logoutError) throw logoutError;
  }

  /** Release browser resources when the page is hidden or discarded. */
  dispose(): void {
    this.invalidateLifecycle();
    this.disposeTransport();
  }

  private async startCallInternal(): Promise<void> {
    if (!this.stateValue.authenticated) {
      throw this.fail('Sign in first.', 'UNAUTHORIZED', false);
    }
    if (this.activeSessionId || ACTIVE_PHASES.has(this.stateValue.phase)) {
      throw this.fail('A call is already active.', 'SESSION_ACTIVE', false);
    }

    this.resetSessionState();
    const generation = this.invalidateLifecycle();
    this.setState({
      phase: 'requesting_microphone',
      message: 'Allow microphone access.',
      errorMessage: null,
    });

    let createdSessionId: string | null = null;
    let stream: MediaStream | null = null;
    let peer: VoicePeerConnection | null = null;
    try {
      stream = await this.mediaDevices.getUserMedia({ audio: true, video: false });
      this.ensureCurrent(generation);
      this.localStream = stream;
      peer = this.peerConnectionFactory();
      this.ensureCurrent(generation);
      this.peer = peer;
      const currentPeer = peer;
      currentPeer.ontrack = (event: RTCTrackEvent): void => {
        const remoteStream = event.streams[0];
        if (!remoteStream || !this.audioElement) return;
        this.audioElement.srcObject = remoteStream;
        void this.playAudio();
      };
      currentPeer.onconnectionstatechange = (): void => this.handleConnectionState(currentPeer);
      for (const track of stream.getAudioTracks()) currentPeer.addTrack(track, stream);
      const events = currentPeer.createDataChannel('oai-events');
      events.addEventListener('message', (event: MessageEvent): void => {
        this.handleProviderEvent(currentPeer, event);
      });

      const offer = await currentPeer.createOffer();
      this.ensureCurrent(generation);
      await currentPeer.setLocalDescription(offer);
      this.ensureCurrent(generation);
      await waitForIceGathering(currentPeer, () => this.isCurrent(generation));
      this.ensureCurrent(generation);
      const localDescription = currentPeer.localDescription ?? offer;
      const sdp = localDescription.sdp ?? '';
      if (sdp.trim().length === 0) {
        throw this.fail('The browser did not return a valid audio offer.', 'INVALID_SDP');
      }

      this.setState({ phase: 'connecting', message: 'Setting up a secure connection.' });
      const response = await this.requestJson<VoiceCreateSessionHttpResponse>('/sessions', {
        method: 'POST',
        csrf: true,
        body: {
          transport: { type: 'webrtc', sdp },
        },
      });
      createdSessionId = response.session.id;
      this.ensureCurrent(generation);
      this.activeSessionId = response.session.id;
      this.telemetryRtcStartedAt = browserNow();
      this.enqueueTelemetry({ category: 'rtc', status: 'connecting' });
      this.attachVisibilityTelemetry();
      this.applySessionStatus(response.session);
      this.openEventStream(response.session.id);
      await currentPeer.setRemoteDescription(toRtcDescription(response.client.answer));
      this.ensureCurrent(generation);
      if (currentPeer.connectionState === 'connected') {
        this.handleConnectionState(currentPeer);
      } else {
        this.setState({ phase: 'connecting', message: 'Connected to Talon; waiting for audio.' });
      }
    } catch (cause) {
      if (createdSessionId) {
        await this.closeCreatedSession(createdSessionId, generation);
      }
      this.cleanupAttempt(generation, stream, peer);
      if (!this.isCurrent(generation) || cause instanceof VoiceAttemptCancelledError) return;
      this.disposeTransport();
      const error = asVoiceBrowserError(cause, 'The call could not be started.');
      this.setState({
        phase: 'failed',
        message: error.message,
        errorMessage: error.message,
      });
      throw error;
    }
  }

  private async closeCreatedSession(sessionId: string, generation: number): Promise<void> {
    try {
      const response = await this.requestJson<{
        readonly session: VoiceSessionStatusDto;
        readonly pendingDelegation: boolean;
      }>(`/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
        body: { reason: 'transport_failure' satisfies VoiceCloseReason },
        csrf: true,
      });
      if (this.isCurrent(generation)) {
        this.applySessionStatus(response.session, response.pendingDelegation);
      }
    } catch {
      // The session deadline and server reconciler remain responsible for
      // cleanup when a transport setup failure races with an HTTP failure.
    }
  }

  private openEventStream(sessionId: string): void {
    const source = this.eventSourceFactory(
      `${this.apiBase}/sessions/${encodeURIComponent(sessionId)}/events`,
      { withCredentials: true },
    );
    this.eventSource = source;
    source.addEventListener('session', (event) => this.handleStatusEvent(event, source));
    source.addEventListener('delegation', (event) => this.handleStatusEvent(event, source));
    source.addEventListener('notification', (event) => this.handleStatusEvent(event, source));
    source.addEventListener('error', (event) => {
      const data = eventData(event);
      if (data !== null) {
        this.handleStatusEvent(event, source);
        return;
      }
      if (this.eventSource !== source) return;
      this.setState({
        phase: 'network_lost',
        message: 'The status connection was interrupted. Talon is keeping your task; try again or end the call.',
        errorMessage: null,
      });
    });
  }

  private handleStatusEvent(event: Event, source?: VoiceEventSource): void {
    if (source && this.eventSource !== source) return;
    const data = eventData(event);
    if (data === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (!isVoiceStatusEvent(parsed)) return;

    if (parsed.kind === 'error') {
      this.setState({ message: parsed.message, errorMessage: parsed.message });
      return;
    }
    if (parsed.kind === 'session') {
      this.applySessionStatus(parsed.session);
      return;
    }
    if (parsed.kind === 'notification') {
      this.applyNotification(parsed.notification);
      return;
    }
    this.applyDelegationStatus(parsed.delegation);
  }

  private applySessionStatus(status: VoiceSessionStatusDto, pendingOverride?: boolean): void {
    const terminal = isTerminalSession(status.status);
    if (terminal) {
      this.activeSessionId = null;
      this.retainedSessionId = status.id;
    } else {
      this.activeSessionId = status.id;
      this.retainedSessionId = null;
    }
    this.persistSession(status.id);
    const outputs = outputsFromDelegations(status.delegations);
    const liveNotifications = this.stateValue.session?.id === status.id
      ? this.stateValue.notifications
      : [];
    const notifications = mergeNotifications(status.notifications ?? [], liveNotifications);
    const pending =
      pendingOverride ??
      status.delegations.some((delegation) => PENDING_DELEGATION_STATUSES.has(delegation.status));
    const phase = terminal
      ? status.status === 'failed'
        ? 'failed'
        : 'closed'
      : status.status === 'connected' && this.transportConnected && this.providerReady
        ? 'connected'
        : 'connecting';
    this.setState({
      activeSessionId: this.activeSessionId,
      retainedSessionId: this.retainedSessionId,
      session: status,
      delegations: status.delegations,
      notifications,
      outputs,
      usage: status.usage,
      pendingDelegation: pending,
      phase,
    });
    if (terminal) {
      this.releaseAudioTransport();
      this.discardTelemetry();
      if (!pending) this.closeEventStream();
    }
  }

  private applyNotification(notification: VoiceNotificationStatusDto): void {
    const current = this.stateValue.notifications.filter((item) => item.id !== notification.id);
    const notifications = [...current, notification]
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(-100);
    this.setState({ notifications, message: notification.text, errorMessage: null });
  }

  private applyDelegationStatus(delegation: VoiceDelegationStatusDto): void {
    const current = this.stateValue.delegations.filter((item) => item.id !== delegation.id);
    const nextDelegations = [...current, delegation].sort((left, right) => left.createdAt - right.createdAt);
    const outputs = outputsFromDelegations(nextDelegations);
    const pending = nextDelegations.some((item) => PENDING_DELEGATION_STATUSES.has(item.status));
    this.setState({
      delegations: nextDelegations,
      outputs,
      pendingDelegation: pending,
    });
    if (!pending && this.stateValue.phase === 'closed') this.closeEventStream();
  }

  private handleConnectionState(peer: VoicePeerConnection): void {
    if (this.peer !== peer) return;
    if (peer.connectionState === 'connected') {
      const durationMs = elapsedSince(this.telemetryRtcStartedAt);
      this.enqueueTelemetry({
        category: 'rtc',
        status: 'connected',
        ...(durationMs === undefined ? {} : { durationMs }),
      });
      this.transportConnected = true;
      this.updateConnectionPhase();
      return;
    }
    if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      const durationMs = elapsedSince(this.telemetryRtcStartedAt);
      this.enqueueTelemetry({
        category: 'rtc',
        status: peer.connectionState,
        ...(durationMs === undefined ? {} : { durationMs }),
      });
      this.enqueueTelemetry({ category: 'interruption', status: 'interrupted' });
      this.transportConnected = false;
      this.releaseAudioTransport();
      this.setState({
        phase: 'network_lost',
        message: 'The audio connection was interrupted. Your task may continue; end the call when you are ready.',
        errorMessage: null,
      });
    }
  }

  private handleProviderEvent(peer: VoicePeerConnection, event: MessageEvent): void {
    if (this.peer !== peer) return;
    const data = typeof event.data === 'string' ? event.data : null;
    if (data === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.type !== 'session.started') return;
    this.providerReady = true;
    this.updateConnectionPhase();
  }

  private updateConnectionPhase(): void {
    if (this.stateValue.session?.status === 'connected' && this.transportConnected && this.providerReady) {
      this.setState({ phase: 'connected', message: 'You are connected to Talon.', errorMessage: null });
      return;
    }
    this.setState({ phase: 'connecting', message: 'Audio connection ready; Talon is confirming the session.' });
  }

  private attachVisibilityTelemetry(): void {
    if (this.telemetryVisibilityAttached || !this.visibilitySource) return;
    try {
      this.visibilitySource.addEventListener('visibilitychange', this.visibilityListener);
      this.telemetryVisibilityAttached = true;
    } catch {
      // Browser instrumentation cannot prevent a call from starting.
    }
  }

  private recordVisibility(): void {
    if (!this.activeSessionId) return;
    let visibilityState: string | undefined;
    try {
      visibilityState = this.visibilitySource?.visibilityState;
    } catch {
      visibilityState = undefined;
    }
    this.enqueueTelemetry({
      category: 'visibility',
      status:
        visibilityState === 'hidden'
          ? 'hidden'
          : visibilityState === 'visible'
            ? 'visible'
            : 'unknown',
    });
  }

  private enqueueTelemetry(sample: VoiceBrowserTelemetrySample): void {
    if (!this.activeSessionId) return;
    if (this.telemetryQueue.length >= BROWSER_TELEMETRY_MAX_SAMPLES) {
      this.recordTelemetryUnknownSample(sample, 'dropped');
      return;
    }
    this.telemetryQueue.push(sample);
    this.flushTelemetry();
  }

  private flushTelemetry(): void {
    if (this.telemetryInFlight || !this.hasPendingTelemetry() || !this.activeSessionId) return;
    const sessionId = this.activeSessionId;
    const samples = this.takeTelemetryBatch();
    let controller: AbortController;
    try {
      controller = new AbortController();
    } catch {
      this.recordTelemetryUnknown(samples);
      return;
    }
    this.telemetryAbortController = controller;
    this.telemetryAbortTimer = setTimeout(() => controller.abort(), BROWSER_TELEMETRY_ABORT_MS);
    const generation = this.lifecycleGeneration;
    const request = this.requestJson(`/sessions/${encodeURIComponent(sessionId)}/telemetry`, {
      method: 'POST',
      csrf: true,
      expectBody: false,
      signal: controller.signal,
      body: { callId: sessionId, samples },
    })
      .catch(() => {
        if (this.lifecycleGeneration === generation && this.activeSessionId === sessionId) {
          this.recordTelemetryUnknown(samples);
        }
      })
      .then(() => {
        if (this.telemetryInFlight !== request) return;
        if (this.telemetryAbortTimer) clearTimeout(this.telemetryAbortTimer);
        this.telemetryAbortTimer = null;
        if (this.telemetryAbortController === controller) this.telemetryAbortController = null;
        this.telemetryInFlight = null;
        if (this.activeSessionId && this.telemetryQueue.length > 0) this.flushTelemetry();
      });
    this.telemetryInFlight = request;
  }

  private discardTelemetry(): void {
    this.telemetryQueue.length = 0;
    this.resetTelemetryUnknownCounts();
    if (this.telemetryAbortTimer) clearTimeout(this.telemetryAbortTimer);
    this.telemetryAbortTimer = null;
    try {
      this.telemetryAbortController?.abort();
    } catch {
      // Abort support is best effort during page cleanup.
    }
    this.telemetryAbortController = null;
    this.telemetryRtcStartedAt = undefined;
    if (this.telemetryVisibilityAttached) {
      try {
        this.visibilitySource?.removeEventListener('visibilitychange', this.visibilityListener);
      } catch {
        // Browser instrumentation cannot delay transport cleanup.
      }
      this.telemetryVisibilityAttached = false;
    }
  }

  private hasPendingTelemetry(): boolean {
    if (this.telemetryQueue.length > 0) return true;
    return BROWSER_TELEMETRY_CATEGORIES.some(
      (category) => this.telemetryUnknownCounts[category] > 0,
    );
  }

  private takeTelemetryBatch(): VoiceBrowserTelemetrySample[] {
    const samples: VoiceBrowserTelemetrySample[] = [];
    for (const category of BROWSER_TELEMETRY_CATEGORIES) {
      if (samples.length >= BROWSER_TELEMETRY_BATCH_SIZE) break;
      const count = this.telemetryUnknownCounts[category];
      if (count <= 0) continue;
      const batchCount = Math.min(count, BROWSER_TELEMETRY_MAX_UNKNOWN_SAMPLES);
      this.telemetryUnknownCounts[category] -= batchCount;
      samples.push({ category, status: 'unknown', count: batchCount });
    }
    while (samples.length < BROWSER_TELEMETRY_BATCH_SIZE && this.telemetryQueue.length > 0) {
      const sample = this.telemetryQueue.shift();
      if (sample) samples.push(sample);
    }
    return samples;
  }

  private recordTelemetryUnknown(samples: readonly VoiceBrowserTelemetrySample[]): void {
    for (const sample of samples) {
      // Aggregate markers already account for an earlier loss; only newly
      // failed physical samples may be queued again.
      if (sample.status === 'unknown' && sample.count !== undefined) continue;
      this.recordTelemetryUnknownSample(sample);
    }
  }

  private recordTelemetryUnknownSample(
    sample: VoiceBrowserTelemetrySample,
    diagnostic: 'unknown' | 'dropped' = 'unknown',
  ): void {
    this.recordTelemetryDiagnostic(
      diagnostic === 'unknown' ? 'unknownCount' : 'droppedCount',
      Math.max(1, Math.min(BROWSER_TELEMETRY_MAX_UNKNOWN_SAMPLES, sample.count ?? 1)),
    );
    const total = BROWSER_TELEMETRY_CATEGORIES.reduce(
      (sum, category) => sum + this.telemetryUnknownCounts[category],
      0,
    );
    const remaining = BROWSER_TELEMETRY_MAX_UNKNOWN_SAMPLES - total;
    if (remaining <= 0) return;
    const count = Math.max(1, Math.min(BROWSER_TELEMETRY_MAX_UNKNOWN_SAMPLES, sample.count ?? 1));
    this.telemetryUnknownCounts[sample.category] += Math.min(count, remaining);
  }

  private resetTelemetryUnknownCounts(): void {
    for (const category of BROWSER_TELEMETRY_CATEGORIES) {
      this.telemetryUnknownCounts[category] = 0;
    }
  }

  private async playAudio(): Promise<void> {
    if (!this.audioElement) return;
    const generation = this.lifecycleGeneration;
    const startedAt = browserNow();
    try {
      await this.audioElement.play();
      if (!this.isCurrent(generation)) return;
      const durationMs = elapsedSince(startedAt);
      this.enqueueTelemetry({
        category: 'audio',
        status: 'play_resolved',
        ...(durationMs === undefined ? {} : { durationMs }),
      });
      this.setState({ audioBlocked: false });
    } catch {
      if (!this.isCurrent(generation)) return;
      const durationMs = elapsedSince(startedAt);
      this.enqueueTelemetry({
        category: 'audio',
        status: 'play_rejected',
        ...(durationMs === undefined ? {} : { durationMs }),
      });
      this.setState({
        audioBlocked: true,
        message: 'Audio is ready. Tap “Play audio” to hear Talon.',
      });
    }
  }

  private async requestJson<T = unknown>(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly body?: unknown;
      readonly csrf?: boolean;
      readonly expectBody?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.csrf) {
      const token = this.csrfToken();
      if (!token) throw this.fail('Your browser session is missing CSRF protection. Sign in again.', 'CSRF_DENIED');
      headers['x-csrf-token'] = token;
    }

    let response: Response;
    try {
      response = await this.fetcher(`${this.apiBase}${path}`, {
        method: options.method,
        credentials: 'include',
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw this.fail('The server is unreachable. Check your connection.', 'NETWORK_ERROR');
    }

    let payload: unknown;
    if (options.expectBody !== false && response.status !== 204) {
      try {
        payload = (await response.json()) as unknown;
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) {
      throw this.errorFromResponse(response.status, payload);
    }
    return payload as T;
  }

  private async requestAuthSession(): Promise<VoiceAuthSessionHttpResponse> {
    try {
      const response = await this.requestJson<unknown>('/auth/session', { method: 'GET' });
      if (!isVoiceAuthSessionResponse(response)) {
        throw this.fail(AUTH_RECOVERY_MESSAGE, 'AUTH_CHECK_FAILED');
      }
      return response;
    } catch (cause) {
      if (isUnauthorizedError(cause)) throw cause;
      if (cause instanceof VoiceAttemptCancelledError) throw cause;
      throw recoveryError(cause, AUTH_RECOVERY_MESSAGE);
    }
  }

  private errorFromResponse(status: number, payload: unknown): VoiceBrowserError {
    const body = isVoiceErrorResponse(payload) ? payload.error : undefined;
    const code = body?.code ?? `HTTP_${status}`;
    const message = userMessageForError(code, body?.message);
    return this.fail(message, code, status >= 500 || status === 429);
  }

  private fail(message: string, code?: string, retryable = true): VoiceBrowserError {
    return new VoiceBrowserError(message, code, retryable);
  }

  private setState(patch: Partial<VoiceBrowserState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    this.onStateChange?.(this.stateValue);
  }

  private recordTelemetryDiagnostic(
    kind: keyof VoiceBrowserTelemetryDiagnostics,
    count: number,
  ): void {
    const boundedCount = Number.isSafeInteger(count)
      ? Math.max(0, Math.min(BROWSER_TELEMETRY_MAX_UNKNOWN_SAMPLES, count))
      : 0;
    if (boundedCount === 0) return;
    const current = this.stateValue.browserTelemetry[kind];
    this.setState({
      browserTelemetry: {
        ...this.stateValue.browserTelemetry,
        [kind]: Math.min(BROWSER_TELEMETRY_MAX_UNKNOWN_SAMPLES, current + boundedCount),
      },
    });
  }

  private resetSessionState(): void {
    this.disposeTransport();
    this.activeSessionId = null;
    this.retainedSessionId = null;
    this.clearPersistedSession();
    this.transportConnected = false;
    this.providerReady = false;
    this.setState({
      phase: 'ready',
      message: 'Ready to call.',
      errorMessage: null,
      activeSessionId: null,
      retainedSessionId: null,
      session: null,
      delegations: [],
      notifications: [],
      outputs: [],
      usage: INITIAL_USAGE,
      pendingDelegation: false,
      muted: false,
      audioBlocked: false,
      browserTelemetry: INITIAL_BROWSER_TELEMETRY,
    });
  }

  private setAuthenticatedReady(message: string, errorMessage: string | null, clearPersisted = false): void {
    this.disposeTransport();
    if (clearPersisted) this.clearPersistedSession();
    this.activeSessionId = null;
    this.retainedSessionId = null;
    this.transportConnected = false;
    this.providerReady = false;
    this.setState({
      authenticated: true,
      phase: 'ready',
      message,
      errorMessage,
      activeSessionId: null,
      retainedSessionId: null,
      session: null,
      delegations: [],
      notifications: [],
      outputs: [],
      usage: INITIAL_USAGE,
      pendingDelegation: false,
      muted: false,
      audioBlocked: false,
    });
  }

  private setLoggedOut(): void {
    this.disposeTransport();
    this.clearPersistedSession();
    this.activeSessionId = null;
    this.retainedSessionId = null;
    this.setState({
      authenticated: false,
      phase: 'logged_out',
      message: 'Sign in to start a call.',
      errorMessage: null,
      activeSessionId: null,
      retainedSessionId: null,
      session: null,
      delegations: [],
      notifications: [],
      outputs: [],
      usage: INITIAL_USAGE,
      pendingDelegation: false,
      muted: false,
      audioBlocked: false,
    });
  }

  private disposeTransport(): void {
    this.discardTelemetry();
    this.closeEventStream();
    this.releaseAudioTransport();
  }

  private closeEventStream(expected?: VoiceEventSource | null): void {
    if (expected !== undefined && this.eventSource !== expected) return;
    this.eventSource?.close();
    this.eventSource = null;
  }

  private releaseAudioTransport(): void {
    const stream = this.localStream;
    this.localStream = null;
    this.stopStream(stream);
    const peer = this.peer;
    this.peer = null;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.onicegatheringstatechange = null;
      this.closePeer(peer);
    }
    this.transportConnected = false;
    this.providerReady = false;
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
    }
  }

  private invalidateLifecycle(): number {
    this.discardTelemetry();
    this.lifecycleGeneration += 1;
    return this.lifecycleGeneration;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.lifecycleGeneration;
  }

  private ensureCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new VoiceAttemptCancelledError();
  }

  private releaseCapturedTransport(
    generation: number,
    peer: VoicePeerConnection | null,
    stream: MediaStream | null,
  ): void {
    if (!this.isCurrent(generation)) return;
    if ((peer && this.peer === peer) || (stream && this.localStream === stream)) {
      this.releaseAudioTransport();
    }
  }

  private cleanupAttempt(
    generation: number,
    stream: MediaStream | null,
    peer: VoicePeerConnection | null,
  ): void {
    const ownsPeer = peer !== null && this.peer === peer;
    const ownsStream = stream !== null && this.localStream === stream;
    if (!this.isCurrent(generation) && (ownsPeer || ownsStream)) return;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.onicegatheringstatechange = null;
      this.closePeer(peer);
    }
    this.stopStream(stream);
    if (this.isCurrent(generation) && ownsPeer) this.peer = null;
    if (this.isCurrent(generation) && ownsStream) this.localStream = null;
    if (this.isCurrent(generation) && this.peer === null && this.localStream === null) {
      this.transportConnected = false;
      this.providerReady = false;
    }
  }

  private stopStream(stream: MediaStream | null): void {
    if (!stream || this.stoppedStreams.has(stream)) return;
    this.stoppedStreams.add(stream);
    for (const track of stream.getTracks()) track.stop();
  }

  private closePeer(peer: VoicePeerConnection): void {
    if (this.closedPeers.has(peer)) return;
    this.closedPeers.add(peer);
    peer.close();
  }

  private readPersistedSession(): string | null {
    try {
      const sessionId = this.sessionStorage?.getItem(SESSION_STORAGE_KEY)?.trim() ?? '';
      return sessionId.length === 0 ? null : sessionId;
    } catch {
      return null;
    }
  }

  private persistSession(sessionId: string): void {
    try {
      this.sessionStorage?.setItem(SESSION_STORAGE_KEY, sessionId);
    } catch {
      // Storage can be disabled by browser privacy settings; the cookie remains authoritative.
    }
  }

  private clearPersistedSession(): void {
    try {
      this.sessionStorage?.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Storage can be disabled by browser privacy settings.
    }
  }
}

function normalizeApiBase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '/voice';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function defaultEventSourceFactory(url: string, init?: EventSourceInit): VoiceEventSource {
  if (typeof EventSource === 'undefined') {
    throw new VoiceBrowserError('This browser does not support status updates.', 'UNSUPPORTED_BROWSER', false);
  }
  return new EventSource(url, init);
}

function defaultPeerConnectionFactory(): VoicePeerConnection {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new VoiceBrowserError('This browser does not support WebRTC audio.', 'UNSUPPORTED_BROWSER', false);
  }
  return new RTCPeerConnection();
}

function defaultMediaDevices(): VoiceMediaDevices {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    return {
      getUserMedia: (_constraints: MediaStreamConstraints): Promise<MediaStream> =>
        Promise.reject(
          new VoiceBrowserError('This browser has no microphone interface.', 'UNSUPPORTED_BROWSER', false),
        ),
    };
  }
  return navigator.mediaDevices;
}

function defaultSessionStorage(): VoiceSessionStorage | undefined {
  if (typeof sessionStorage === 'undefined') return undefined;
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

function defaultVisibilitySource(): VoiceVisibilitySource | undefined {
  if (typeof document === 'undefined') return undefined;
  return document;
}

function browserNow(): number | undefined {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function elapsedSince(startedAt: number | undefined): number | undefined {
  const now = browserNow();
  if (startedAt === undefined || now === undefined || now < startedAt) return undefined;
  return now - startedAt;
}

function readBrowserCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  return readCookie(document.cookie, 'talon_voice_csrf');
}

function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

function eventData(event: Event): string | null {
  const data = (event as Event & { readonly data?: unknown }).data;
  return typeof data === 'string' ? data : null;
}

function outputsFromDelegations(
  delegations: readonly VoiceDelegationStatusDto[],
): readonly VoiceOutputStatusDto[] {
  const byId = new Map<string, VoiceOutputStatusDto>();
  for (const delegation of delegations) {
    for (const output of delegation.outputs) byId.set(output.id, output);
  }
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt);
}

function mergeNotifications(
  persisted: readonly VoiceNotificationStatusDto[],
  live: readonly VoiceNotificationStatusDto[],
): readonly VoiceNotificationStatusDto[] {
  const byId = new Map<string, VoiceNotificationStatusDto>();
  for (const notification of [...persisted, ...live]) byId.set(notification.id, notification);
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt).slice(-100);
}

function toRtcDescription(answer: VoiceTransportAnswer): RTCSessionDescriptionInit {
  if (answer.type !== 'webrtc' || answer.sdp.trim().length === 0) {
    throw new VoiceBrowserError('Talon did not return a valid audio connection.', 'INVALID_SDP');
  }
  return { type: 'answer', sdp: answer.sdp };
}

async function waitForIceGathering(
  peer: VoicePeerConnection,
  isCurrent: () => boolean,
): Promise<void> {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const previous = peer.onicegatheringstatechange;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      peer.onicegatheringstatechange = previous;
    };
    const onState = (): void => {
      if (!isCurrent() || peer.iceGatheringState !== 'complete') return;
      finish();
      resolve();
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new VoiceBrowserError('The browser could not prepare the audio connection.', 'ICE_GATHERING_TIMEOUT'));
    }, ICE_GATHERING_TIMEOUT_MS);
    peer.onicegatheringstatechange = (event: Event): void => {
      previous?.(event);
      onState();
    };
    if (!isCurrent()) {
      finish();
      resolve();
      return;
    }
    onState();
  });
}

function isTerminalSession(status: VoiceSessionStatusDto['status']): boolean {
  return status === 'closed' || status === 'expired' || status === 'failed';
}

function isVoiceStatusEvent(value: unknown): value is VoiceStatusEventDto {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'error') {
    return typeof value.message === 'string' && typeof value.code === 'string';
  }
  if (value.kind === 'session') {
    return (
      isRecord(value.session) &&
      Array.isArray(value.session.delegations) &&
      (value.session.notifications === undefined || Array.isArray(value.session.notifications)) &&
      isRecord(value.session.usage)
    );
  }
  if (value.kind === 'notification') {
    return isRecord(value.notification) && typeof value.notification.text === 'string';
  }
  return value.kind === 'delegation' && isRecord(value.delegation) && Array.isArray(value.delegation.outputs);
}

function isVoiceErrorResponse(value: unknown): value is VoiceErrorHttpResponse {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string'
  );
}

function isVoiceAuthSessionResponse(value: unknown): value is VoiceAuthSessionHttpResponse {
  return isRecord(value) && value.authenticated === true && typeof value.expiresAt === 'number';
}

function isUnauthorizedError(cause: unknown): boolean {
  return cause instanceof VoiceBrowserError && ['UNAUTHORIZED', 'HTTP_401'].includes(cause.code);
}

function isNotFoundError(cause: unknown): boolean {
  return cause instanceof VoiceBrowserError && ['NOT_FOUND', 'HTTP_404'].includes(cause.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function userMessageForError(code: string, fallback?: string): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'Your session has expired. Sign in again.';
    case 'CSRF_DENIED':
      return 'Your browser session is invalid. Sign in again.';
    case 'SESSION_LIMIT':
      return 'A Talon call is already active.';
    case 'RATE_LIMITED':
      return 'Try again shortly; there are temporarily too many requests.';
    case 'ORIGIN_DENIED':
      return 'This page is not allowed to connect to Talon.';
    case 'VOICE_ERROR':
      return 'Talon could not process the voice call.';
    default:
      return fallback ?? 'Something went wrong. Try again.';
  }
}

function asVoiceBrowserError(cause: unknown, fallback: string): VoiceBrowserError {
  if (cause instanceof VoiceBrowserError) return cause;
  if (typeof DOMException !== 'undefined' && cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError' || cause.name === 'PermissionDeniedError') {
      return new VoiceBrowserError('Microphone access was denied. Allow access and try again.', 'MICROPHONE_DENIED', false);
    }
    if (cause.name === 'NotFoundError') {
      return new VoiceBrowserError('No microphone was found.', 'MICROPHONE_MISSING', false);
    }
  }
  if (cause instanceof Error && cause.message.length > 0) {
    return new VoiceBrowserError(cause.message, 'VOICE_CLIENT_ERROR');
  }
  return new VoiceBrowserError(fallback);
}

function recoveryError(cause: unknown, message: string): VoiceBrowserError {
  if (cause instanceof VoiceBrowserError) {
    return new VoiceBrowserError(message, cause.code, cause.retryable);
  }
  return new VoiceBrowserError(message, 'VOICE_CLIENT_ERROR');
}
