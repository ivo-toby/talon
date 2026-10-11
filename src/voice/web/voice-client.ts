import type {
  VoiceCloseReason,
  VoiceCreateSessionHttpResponse,
  VoiceDelegationStatusDto,
  VoiceErrorHttpResponse,
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
  readonly sessionId: string | null;
  readonly session: VoiceSessionStatusDto | null;
  readonly delegations: readonly VoiceDelegationStatusDto[];
  readonly outputs: readonly VoiceOutputStatusDto[];
  readonly usage: VoiceUsageSummary;
  readonly pendingDelegation: boolean;
  readonly muted: boolean;
  readonly audioBlocked: boolean;
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
  readonly localDescription: RTCSessionDescription | null;
  onconnectionstatechange: ((event: Event) => void) | null;
  ontrack: ((event: RTCTrackEvent) => void) | null;
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  close(): void;
}

export interface VoiceMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface VoiceAudioElement {
  srcObject: MediaProvider | null;
  play(): Promise<void>;
  pause(): void;
}

export interface VoiceBrowserClientOptions {
  readonly apiBase?: string;
  readonly fetch?: VoiceFetch;
  readonly eventSourceFactory?: VoiceEventSourceFactory;
  readonly peerConnectionFactory?: () => VoicePeerConnection;
  readonly mediaDevices?: VoiceMediaDevices;
  readonly audioElement?: VoiceAudioElement;
  readonly csrfToken?: () => string | null;
  readonly onStateChange?: (state: VoiceBrowserState) => void;
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

const INITIAL_STATE: VoiceBrowserState = {
  authenticated: false,
  phase: 'logged_out',
  message: 'Log in om een gesprek te beginnen.',
  errorMessage: null,
  sessionId: null,
  session: null,
  delegations: [],
  outputs: [],
  usage: INITIAL_USAGE,
  pendingDelegation: false,
  muted: false,
  audioBlocked: false,
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
  private readonly csrfToken: () => string | null;
  private readonly onStateChange: ((state: VoiceBrowserState) => void) | undefined;

  private stateValue: VoiceBrowserState = INITIAL_STATE;
  private sessionId: string | null = null;
  private peer: VoicePeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private eventSource: VoiceEventSource | null = null;
  private latestOutputId: string | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(options: VoiceBrowserClientOptions = {}) {
    this.apiBase = normalizeApiBase(options.apiBase ?? '/voice');
    this.fetcher = options.fetch ?? defaultFetch;
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
    this.peerConnectionFactory = options.peerConnectionFactory ?? defaultPeerConnectionFactory;
    this.mediaDevices = options.mediaDevices ?? defaultMediaDevices();
    this.audioElement = options.audioElement;
    this.csrfToken = options.csrfToken ?? readBrowserCsrfToken;
    this.onStateChange = options.onStateChange;
  }

  get state(): VoiceBrowserState {
    return this.stateValue;
  }

  async login(accessToken: string): Promise<void> {
    if (accessToken.trim().length === 0) {
      throw this.fail('Vul je toegangstoken in.', 'INVALID_REQUEST', false);
    }

    await this.requestJson('/login', {
      method: 'POST',
      body: { accessToken },
    });
    this.setState({
      authenticated: true,
      phase: 'ready',
      message: 'Klaar om te bellen.',
      errorMessage: null,
      sessionId: null,
      session: null,
      delegations: [],
      outputs: [],
      usage: INITIAL_USAGE,
      pendingDelegation: false,
      muted: false,
      audioBlocked: false,
    });
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
    const currentSessionId = this.sessionId;
    if (!currentSessionId) {
      this.disposeTransport();
      if (this.stateValue.authenticated) {
        this.setState({ phase: 'ready', message: 'Klaar om te bellen.' });
      }
      return;
    }

    this.setState({ phase: 'closing', message: 'Gesprek wordt afgesloten.', errorMessage: null });
    await this.reportLatestPlayback('interrupted');

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
      this.applySessionStatus(response.session, response.pendingDelegation);
    } catch (cause) {
      closeError = asVoiceBrowserError(cause, 'Het gesprek kon niet volledig worden afgesloten.');
    } finally {
      this.releaseAudioTransport();
      if (closeError || !this.stateValue.pendingDelegation) this.closeEventStream();
    }

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
        ? 'Gesprek beëindigd. Een taak wordt nog afgerond.'
        : 'Gesprek beëindigd.',
      errorMessage: null,
    });
  }

  async logout(): Promise<void> {
    if (ACTIVE_PHASES.has(this.stateValue.phase) || this.sessionId) {
      try {
        await this.hangup('logout');
      } catch {
        // Revocation below remains the authority even if session cleanup failed.
      }
    }

    try {
      await this.requestJson('/logout', { method: 'POST', csrf: true });
    } finally {
      this.disposeTransport();
      this.sessionId = null;
      this.latestOutputId = null;
      this.setState({
        authenticated: false,
        phase: 'logged_out',
        message: 'Log in om een gesprek te beginnen.',
        errorMessage: null,
        sessionId: null,
        session: null,
        delegations: [],
        outputs: [],
        usage: INITIAL_USAGE,
        pendingDelegation: false,
        muted: false,
        audioBlocked: false,
      });
    }
  }

  /** Release browser resources when the page is hidden or discarded. */
  dispose(): void {
    this.disposeTransport();
  }

  private async startCallInternal(): Promise<void> {
    if (!this.stateValue.authenticated) {
      throw this.fail('Log eerst in.', 'UNAUTHORIZED', false);
    }
    if (this.sessionId || ACTIVE_PHASES.has(this.stateValue.phase)) {
      throw this.fail('Er is al een gesprek actief.', 'SESSION_ACTIVE', false);
    }

    this.resetSessionState();
    this.setState({
      phase: 'requesting_microphone',
      message: 'Geef Talon toegang tot je microfoon.',
      errorMessage: null,
    });

    let createdSessionId: string | null = null;
    try {
      const stream = await this.mediaDevices.getUserMedia({ audio: true, video: false });
      this.localStream = stream;
      const peer = this.peerConnectionFactory();
      this.peer = peer;
      peer.ontrack = (event: RTCTrackEvent): void => {
        const remoteStream = event.streams[0];
        if (!remoteStream || !this.audioElement) return;
        this.audioElement.srcObject = remoteStream;
        void this.playAudio();
      };
      peer.onconnectionstatechange = (): void => this.handleConnectionState(peer);
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const localDescription = peer.localDescription ?? offer;
      const sdp = localDescription.sdp ?? '';
      if (sdp.trim().length === 0) {
        throw this.fail('De browser gaf geen geldige audio-aanbieding terug.', 'INVALID_SDP');
      }

      this.setState({ phase: 'connecting', message: 'Beveiligde verbinding wordt opgezet.' });
      const response = await this.requestJson<VoiceCreateSessionHttpResponse>('/sessions', {
        method: 'POST',
        csrf: true,
        body: {
          transport: { type: 'webrtc', sdp },
        },
      });
      createdSessionId = response.session.id;
      this.sessionId = response.session.id;
      this.latestOutputId = latestOutputId(response.session);
      this.applySessionStatus(response.session);
      this.openEventStream(response.session.id);
      await peer.setRemoteDescription(toRtcDescription(response.client.answer));
      if (peer.connectionState === 'connected') {
        this.handleConnectionState(peer);
      } else {
        this.setState({ phase: 'connecting', message: 'Verbonden met Talon; wacht op audio.' });
      }
    } catch (cause) {
      if (createdSessionId) {
        await this.closeCreatedSession(createdSessionId);
      }
      this.disposeTransport();
      const error = asVoiceBrowserError(cause, 'Het gesprek kon niet worden gestart.');
      this.setState({
        phase: 'failed',
        message: error.message,
        errorMessage: error.message,
      });
      throw error;
    }
  }

  private async closeCreatedSession(sessionId: string): Promise<void> {
    try {
      const response = await this.requestJson<{
        readonly session: VoiceSessionStatusDto;
        readonly pendingDelegation: boolean;
      }>(`/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
        body: { reason: 'transport_failure' satisfies VoiceCloseReason },
        csrf: true,
      });
      this.applySessionStatus(response.session, response.pendingDelegation);
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
    source.addEventListener('session', (event) => this.handleStatusEvent(event));
    source.addEventListener('delegation', (event) => this.handleStatusEvent(event));
    source.addEventListener('error', (event) => {
      const data = eventData(event);
      if (data !== null) {
        this.handleStatusEvent(event);
        return;
      }
      if (this.eventSource !== source) return;
      this.setState({
        phase: 'network_lost',
        message: 'De statusverbinding is onderbroken. Talon bewaart je taak; probeer opnieuw of hang op.',
        errorMessage: null,
      });
    });
  }

  private handleStatusEvent(event: Event): void {
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
    this.applyDelegationStatus(parsed.delegation);
  }

  private applySessionStatus(status: VoiceSessionStatusDto, pendingOverride?: boolean): void {
    this.sessionId = status.id;
    this.latestOutputId = latestOutputId(status) ?? this.latestOutputId;
    const outputs = outputsFromDelegations(status.delegations);
    const pending =
      pendingOverride ??
      status.delegations.some((delegation) => PENDING_DELEGATION_STATUSES.has(delegation.status));
    const terminal = status.status === 'closed' || status.status === 'expired' || status.status === 'failed';
    this.setState({
      sessionId: status.id,
      session: status,
      delegations: status.delegations,
      outputs,
      usage: status.usage,
      pendingDelegation: pending,
      ...(terminal ? { phase: status.status === 'failed' ? 'failed' : 'closed' } : {}),
    });
    if (terminal) {
      this.releaseAudioTransport();
      if (!pending) this.closeEventStream();
    }
  }

  private applyDelegationStatus(delegation: VoiceDelegationStatusDto): void {
    const current = this.stateValue.delegations.filter((item) => item.id !== delegation.id);
    const nextDelegations = [...current, delegation].sort((left, right) => left.createdAt - right.createdAt);
    const outputs = outputsFromDelegations(nextDelegations);
    this.latestOutputId = latestOutputIdFromOutputs(outputs) ?? this.latestOutputId;
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
      this.setState({ phase: 'connected', message: 'Je bent verbonden met Talon.', errorMessage: null });
      return;
    }
    if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      this.releaseAudioTransport();
      this.setState({
        phase: 'network_lost',
        message: 'De audioverbinding is verbroken. Je taak kan nog doorlopen; hang op wanneer je klaar bent.',
        errorMessage: null,
      });
    }
  }

  private async playAudio(): Promise<void> {
    if (!this.audioElement) return;
    try {
      await this.audioElement.play();
      this.setState({ audioBlocked: false });
      await this.reportLatestPlayback('started');
    } catch {
      this.setState({
        audioBlocked: true,
        message: 'Audio staat klaar. Tik op “Audio afspelen” om Talon te horen.',
      });
    }
  }

  private async reportLatestPlayback(status: 'started' | 'interrupted'): Promise<void> {
    if (!this.latestOutputId || !this.sessionId) return;
    try {
      await this.requestJson<void>(`/sessions/${encodeURIComponent(this.sessionId)}/playback`, {
        method: 'POST',
        csrf: true,
        body: { outputId: this.latestOutputId, status },
        expectBody: false,
      });
    } catch {
      // Playback reporting is advisory; it must never repeat backend work.
    }
  }

  private async requestJson<T = unknown>(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly body?: unknown;
      readonly csrf?: boolean;
      readonly expectBody?: boolean;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.csrf) {
      const token = this.csrfToken();
      if (!token) throw this.fail('Je browsersessie mist de CSRF-beveiliging. Log opnieuw in.', 'CSRF_DENIED');
      headers['x-csrf-token'] = token;
    }

    let response: Response;
    try {
      response = await this.fetcher(`${this.apiBase}${path}`, {
        method: options.method,
        credentials: 'include',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw this.fail('De server is niet bereikbaar. Controleer je verbinding.', 'NETWORK_ERROR');
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

  private resetSessionState(): void {
    this.disposeTransport();
    this.sessionId = null;
    this.latestOutputId = null;
    this.setState({
      phase: 'ready',
      message: 'Klaar om te bellen.',
      errorMessage: null,
      sessionId: null,
      session: null,
      delegations: [],
      outputs: [],
      usage: INITIAL_USAGE,
      pendingDelegation: false,
      muted: false,
      audioBlocked: false,
    });
  }

  private disposeTransport(): void {
    this.closeEventStream();
    this.releaseAudioTransport();
  }

  private closeEventStream(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }

  private releaseAudioTransport(): void {
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
      this.peer = null;
    }
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
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
    throw new VoiceBrowserError('Deze browser ondersteunt geen statusverbinding.', 'UNSUPPORTED_BROWSER', false);
  }
  return new EventSource(url, init);
}

function defaultPeerConnectionFactory(): VoicePeerConnection {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new VoiceBrowserError('Deze browser ondersteunt geen WebRTC-audio.', 'UNSUPPORTED_BROWSER', false);
  }
  return new RTCPeerConnection();
}

function defaultMediaDevices(): VoiceMediaDevices {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    return {
      getUserMedia: (_constraints: MediaStreamConstraints): Promise<MediaStream> =>
        Promise.reject(
          new VoiceBrowserError('Deze browser heeft geen microfooninterface.', 'UNSUPPORTED_BROWSER', false),
        ),
    };
  }
  return navigator.mediaDevices;
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

function latestOutputId(status: VoiceSessionStatusDto): string | null {
  return latestOutputIdFromOutputs(outputsFromDelegations(status.delegations));
}

function latestOutputIdFromOutputs(outputs: readonly VoiceOutputStatusDto[]): string | null {
  return outputs.length === 0 ? null : outputs[outputs.length - 1]?.id ?? null;
}

function toRtcDescription(answer: VoiceTransportAnswer): RTCSessionDescriptionInit {
  const allowedTypes: readonly RTCSdpType[] = ['offer', 'answer', 'pranswer', 'rollback'];
  if (!allowedTypes.includes(answer.type as RTCSdpType) || answer.sdp.trim().length === 0) {
    throw new VoiceBrowserError('Talon gaf geen geldige audioverbinding terug.', 'INVALID_SDP');
  }
  return { type: answer.type as RTCSdpType, sdp: answer.sdp };
}

function isVoiceStatusEvent(value: unknown): value is VoiceStatusEventDto {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'error') {
    return typeof value.message === 'string' && typeof value.code === 'string';
  }
  if (value.kind === 'session') {
    return isRecord(value.session) && Array.isArray(value.session.delegations) && isRecord(value.session.usage);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function userMessageForError(code: string, fallback?: string): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'Je sessie is verlopen. Log opnieuw in.';
    case 'CSRF_DENIED':
      return 'Je browsersessie is ongeldig. Log opnieuw in.';
    case 'SESSION_LIMIT':
      return 'Er is al een Talon-gesprek actief.';
    case 'RATE_LIMITED':
      return 'Probeer het zo opnieuw; er zijn tijdelijk te veel aanvragen.';
    case 'ORIGIN_DENIED':
      return 'Deze pagina mag geen verbinding maken met Talon.';
    case 'VOICE_ERROR':
      return 'Talon kon het voicegesprek niet verwerken.';
    default:
      return fallback ?? 'Er ging iets mis. Probeer het opnieuw.';
  }
}

function asVoiceBrowserError(cause: unknown, fallback: string): VoiceBrowserError {
  if (cause instanceof VoiceBrowserError) return cause;
  if (typeof DOMException !== 'undefined' && cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError' || cause.name === 'PermissionDeniedError') {
      return new VoiceBrowserError('Microfoontoegang is geweigerd. Geef toestemming en probeer opnieuw.', 'MICROPHONE_DENIED', false);
    }
    if (cause.name === 'NotFoundError') {
      return new VoiceBrowserError('Er is geen microfoon gevonden.', 'MICROPHONE_MISSING', false);
    }
  }
  if (cause instanceof Error && cause.message.length > 0) {
    return new VoiceBrowserError(cause.message, 'VOICE_CLIENT_ERROR');
  }
  return new VoiceBrowserError(fallback);
}
