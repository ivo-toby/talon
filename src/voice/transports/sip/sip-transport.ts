/**
 * Provider-owned incoming SIP transport.
 *
 * Media is terminated by the Live provider and the phone network. Talon only
 * tracks the verified call reference so the shared voice lifecycle can attach
 * the normal sideband and backend bridge without inventing an audio relay.
 */

import { PolicyError } from '../../../core/errors/index.js';
import { err, ok } from '../../../core/types/result.js';
import type {
  VoiceAsyncResult,
  VoiceCapabilityMap,
  VoiceEventHandler,
  VoiceResult,
  VoiceSessionId,
  VoiceTransport,
  VoiceTransportEvent,
  VoiceTransportHandle,
  VoiceTransportOpenRequest,
  VoiceTransportStatus,
  VoiceUnsubscribe,
} from '../../voice-types.js';

interface SipTransportState {
  readonly sessionId: VoiceSessionId;
  readonly reference: string;
  status: VoiceTransportStatus;
  readonly handlers: Set<VoiceEventHandler<VoiceTransportEvent>>;
}
export interface SipTransportOptions {
  readonly now?: () => number;
}
/** A lifecycle-only adapter for an already-routed incoming SIP call. */
export class SipTransport implements VoiceTransport {
  readonly kind = 'sip';
  readonly capabilities: VoiceCapabilityMap = {
    audio_streaming: 'supported',
    interruptions: 'supported',
    delegation: 'supported',
    notifications: 'supported',
    transcript_stability: 'supported',
    provider_acknowledgements: 'supported',
    usage_reporting: 'supported',
  };

  private readonly now: () => number;
  private readonly sessions = new Map<VoiceSessionId, SipTransportState>();
  private readonly pendingHandlers = new Map<VoiceSessionId, Set<VoiceEventHandler<VoiceTransportEvent>>>();

  constructor(options: SipTransportOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  open(input: VoiceTransportOpenRequest): VoiceAsyncResult<VoiceTransportHandle> {
    if (
      input.client.transport !== this.kind ||
      input.client.sessionId !== input.sessionId ||
      input.client.answer.type !== 'sip' ||
      input.client.answer.reference.trim() === ''
    ) {
      return Promise.resolve(err(new PolicyError('SIP transport descriptor does not match session')));
    }
    const existing = this.sessions.get(input.sessionId);
    if (existing && existing.status !== 'closed' && existing.status !== 'failed') {
      return Promise.resolve(err(new PolicyError('SIP voice transport is already open')));
    }

    const state: SipTransportState = {
      sessionId: input.sessionId,
      reference: input.client.answer.reference,
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
        transportSessionId: `sip:${state.reference}`,
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

  private emit(state: SipTransportState, event: VoiceTransportEvent): void {
    for (const handler of state.handlers) {
      try {
        void Promise.resolve(handler(event)).catch(() => undefined);
      } catch {
        // Listener failures cannot change durable SIP state.
      }
    }
  }
}
