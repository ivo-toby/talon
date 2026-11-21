/**
 * Small, configured voice transport/engine seam.
 *
 * This is intentionally a registry of trusted server-side factories rather
 * than a plugin framework. Browser input can name a transport only after the
 * daemon has selected it, and required unknown capabilities fail closed.
 */

import { randomUUID } from 'node:crypto';
import { PolicyError } from '../core/errors/index.js';
import { err, ok } from '../core/types/result.js';
import type {
  LiveVoiceProvider,
  VoiceCapability,
  VoiceCapabilityMap,
  VoiceCapabilityStatus,
  VoiceResult,
  VoiceTransport,
} from './voice-types.js';

/** End-to-end guarantees needed before opening a voice provider session. */
export const DEFAULT_VOICE_REQUIRED_CAPABILITIES: readonly VoiceCapability[] = [
  'audio_streaming',
  'interruptions',
  'delegation',
  'transcript_stability',
  'usage_reporting',
];

export interface VoiceCapabilityNegotiation {
  readonly status: VoiceCapabilityStatus;
  readonly requiredCapabilities: readonly VoiceCapability[];
  readonly capabilities: VoiceCapabilityMap;
  readonly unsupported: readonly VoiceCapability[];
  readonly unknown: readonly VoiceCapability[];
}

export interface VoiceAdapterFactory<T> {
  readonly name: string;
  readonly capabilities: VoiceCapabilityMap;
  create(): T;
}

export type VoiceTransportAdapterFactory = VoiceAdapterFactory<VoiceTransport>;
export type VoiceEngineAdapterFactory = VoiceAdapterFactory<LiveVoiceProvider>;

export interface VoiceAdapterSelection {
  readonly transport: VoiceTransport;
  readonly engine: LiveVoiceProvider;
  readonly transportName: string;
  readonly engineName: string;
  readonly negotiation: VoiceCapabilityNegotiation;
}

export interface VoiceAdapterSelectionInput {
  readonly transport: VoiceTransport;
  readonly engine: LiveVoiceProvider;
  readonly requiredCapabilities?: readonly VoiceCapability[];
}

/**
 * Combine transport and engine capability claims. Omitted claims remain
 * unknown, while an explicit unsupported claim wins over an unknown claim.
 */
export function negotiateVoiceCapabilities(
  transport: VoiceCapabilityMap,
  engine: VoiceCapabilityMap,
  requiredCapabilities: readonly VoiceCapability[] = DEFAULT_VOICE_REQUIRED_CAPABILITIES,
): VoiceCapabilityNegotiation {
  const capabilities = {} as Record<VoiceCapability, VoiceCapabilityStatus>;
  const unsupported: VoiceCapability[] = [];
  const unknown: VoiceCapability[] = [];

  for (const capability of requiredCapabilities) {
    const transportStatus = transport[capability] ?? 'unknown';
    const engineStatus = engine[capability] ?? 'unknown';
    const status = combineStatus(transportStatus, engineStatus);
    capabilities[capability] = status;
    if (status === 'unsupported') unsupported.push(capability);
    if (status === 'unknown') unknown.push(capability);
  }

  return {
    status: unsupported.length > 0 ? 'unsupported' : unknown.length > 0 ? 'unknown' : 'supported',
    requiredCapabilities: [...requiredCapabilities],
    capabilities,
    unsupported,
    unknown,
  };
}

/** Deny before a provider call when a required capability is unsupported/unknown. */
export function requireVoiceCapabilities(
  negotiation: VoiceCapabilityNegotiation,
): VoiceResult<void> {
  if (negotiation.status === 'supported') return ok(undefined);
  const missing = [...negotiation.unsupported, ...negotiation.unknown];
  return err(
    new PolicyError(
      `Voice transport and engine capabilities are not proven: ${missing.join(', ')}`,
    ),
  );
}

/** Build a trusted selection without invoking either factory until checks pass. */
export function createVoiceAdapterSelection(
  input: VoiceAdapterSelectionInput,
): VoiceResult<VoiceAdapterSelection> {
  const negotiation = negotiateVoiceCapabilities(
    input.transport.capabilities ?? {},
    input.engine.capabilities ?? {},
    input.requiredCapabilities,
  );
  const required = requireVoiceCapabilities(negotiation);
  if (required.isErr()) return err(required.error);
  return ok({
    transport: input.transport,
    engine: input.engine,
    transportName: input.transport.kind,
    engineName: input.engine.name,
    negotiation,
  });
}

/**
 * Resolve configured factories and negotiate before constructing an engine.
 * This keeps unsupported or unknown combinations from making a paid request.
 */
export function createConfiguredVoiceAdapters(input: {
  readonly transports: readonly VoiceTransportAdapterFactory[];
  readonly engines: readonly VoiceEngineAdapterFactory[];
  readonly transportName: string;
  readonly engineName: string;
  readonly requiredCapabilities?: readonly VoiceCapability[];
}): VoiceResult<VoiceAdapterSelection> {
  const transport = input.transports.find((candidate) => candidate.name === input.transportName);
  if (!transport) return err(new PolicyError('Configured voice transport is unavailable'));
  const engine = input.engines.find((candidate) => candidate.name === input.engineName);
  if (!engine) return err(new PolicyError('Configured voice engine is unavailable'));

  const negotiation = negotiateVoiceCapabilities(
    transport.capabilities,
    engine.capabilities,
    input.requiredCapabilities,
  );
  const required = requireVoiceCapabilities(negotiation);
  if (required.isErr()) return err(required.error);

  try {
    return ok({
      transport: transport.create(),
      engine: engine.create(),
      transportName: transport.name,
      engineName: engine.name,
      negotiation,
    });
  } catch {
    return err(new PolicyError('Configured voice adapter construction failed'));
  }
}

/** Compatibility alias for callers that describe the operation as selection. */
export const selectVoiceAdapters = createConfiguredVoiceAdapters;

/** Typed admission failure that the HTTP adapter exposes as a 429 response. */
export class VoiceCreationRateLimitError extends PolicyError {
  readonly kind = 'session_creation_rate_limited' as const;

  constructor() {
    super('Voice session creation rate limit reached');
  }
}

export interface VoiceCallReservation {
  readonly id: string;
  readonly ownerId: string;
  readonly sessionId?: string;
  bind(sessionId: string): VoiceResult<VoiceCallReservation>;
  release(): void;
}

export interface VoiceCallAdmissionOptions {
  /** Optional per-owner creation budget; omitted means no rate budget. */
  readonly maxSessionCreations?: number;
  readonly sessionCreationWindowMs?: number;
  readonly now?: () => number;
}

interface ReservationState {
  readonly id: string;
  readonly ownerId: string;
  sessionId?: string;
  released: boolean;
}

interface CreationState {
  count: number;
  startedAt: number;
}

/** Shared synchronous admission covering pending provider/transport setup. */
export class VoiceCallAdmission {
  private readonly reservations = new Map<string, ReservationState>();
  private readonly creationStates = new Map<string, CreationState>();
  private readonly maxConcurrentSessions: number;
  private readonly maxSessionCreations: number | undefined;
  private readonly sessionCreationWindowMs: number;
  private readonly now: () => number;

  constructor(maxConcurrentSessions = 1, options: VoiceCallAdmissionOptions = {}) {
    if (!Number.isSafeInteger(maxConcurrentSessions) || maxConcurrentSessions < 1) {
      throw new TypeError('maxConcurrentSessions must be a positive safe integer');
    }
    if (
      options.maxSessionCreations !== undefined &&
      (!Number.isSafeInteger(options.maxSessionCreations) || options.maxSessionCreations < 1)
    ) {
      throw new TypeError('maxSessionCreations must be a positive safe integer');
    }
    if (
      options.sessionCreationWindowMs !== undefined &&
      (!Number.isSafeInteger(options.sessionCreationWindowMs) || options.sessionCreationWindowMs < 1)
    ) {
      throw new TypeError('sessionCreationWindowMs must be a positive safe integer');
    }
    this.maxConcurrentSessions = maxConcurrentSessions;
    this.maxSessionCreations = options.maxSessionCreations;
    this.sessionCreationWindowMs = options.sessionCreationWindowMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  get limit(): number {
    return this.maxConcurrentSessions;
  }

  get size(): number {
    return this.reservations.size;
  }

  reserve(ownerId: string): VoiceResult<VoiceCallReservation> {
    if (ownerId.trim() === '') return err(new PolicyError('Voice owner is required'));
    if (this.reservations.size >= this.maxConcurrentSessions) {
      return err(new PolicyError('Voice session concurrency limit reached'));
    }
    if (!this.consumeCreation(ownerId)) {
      return err(new VoiceCreationRateLimitError());
    }
    const state: ReservationState = { id: randomUUID(), ownerId, released: false };
    this.reservations.set(state.id, state);
    return ok(this.asReservation(state));
  }

  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  hasSession(sessionId: string): boolean {
    for (const reservation of this.reservations.values()) {
      if (reservation.sessionId === sessionId) return true;
    }
    return false;
  }

  private asReservation(state: ReservationState): VoiceCallReservation {
    return {
      id: state.id,
      ownerId: state.ownerId,
      get sessionId(): string | undefined {
        return state.sessionId;
      },
      bind: (sessionId: string): VoiceResult<VoiceCallReservation> => {
        if (state.released || this.reservations.get(state.id) !== state) {
          return err(new PolicyError('Voice call reservation is no longer active'));
        }
        if (sessionId.trim() === '') return err(new PolicyError('Voice session is required'));
        if (state.sessionId !== undefined && state.sessionId !== sessionId) {
          return err(new PolicyError('Voice call reservation is already bound'));
        }
        state.sessionId = sessionId;
        return ok(this.asReservation(state));
      },
      release: (): void => {
        state.released = true;
        this.reservations.delete(state.id);
      },
    };
  }

  private consumeCreation(ownerId: string): boolean {
    if (this.maxSessionCreations === undefined) return true;
    const now = this.now();
    const current = this.creationStates.get(ownerId);
    if (!current || now - current.startedAt >= this.sessionCreationWindowMs) {
      this.creationStates.set(ownerId, { count: 1, startedAt: now });
      return true;
    }
    if (current.count >= this.maxSessionCreations) return false;
    current.count += 1;
    return true;
  }
}

export const SharedVoiceCallAdmission = VoiceCallAdmission;

function combineStatus(
  left: VoiceCapabilityStatus,
  right: VoiceCapabilityStatus,
): VoiceCapabilityStatus {
  if (left === 'unsupported' || right === 'unsupported') return 'unsupported';
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  return 'supported';
}
