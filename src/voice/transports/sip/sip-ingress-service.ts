/**
 * Provider-neutral incoming SIP admission.
 *
 * The service owns freshness, caller-proof resolution, durable deduplication,
 * and the one external-attempt marker. Task 37 can supply the acceptance
 * callback; this task never creates a provider session or performs a paid call
 * by itself.
 */

import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '../../../core/types/result.js';
import type {
  SipReservation,
  SipReservationInput,
  VoiceSipRepository,
} from '../../../core/database/repositories/voice-sip-repository.js';
import type {
  SipAuthorizationResolver,
  SipVerifiedAuthorization,
} from './sip-authorization.js';
import {
  SIP_MAX_ASSERTION_BYTES,
  SIP_MAX_IDENTIFIER_BYTES,
} from './sip-authorization.js';

export const SIP_ADMISSION_WINDOW_MS = 60_000;
export const SIP_DELIVERY_REPLAY_WINDOW_MS = 72 * 60 * 60 * 1_000;
export const SIP_MAX_PENDING_RECEIPT_WORK = 32;
export const SIP_DEFERRED_DECISION_BUDGET_MS = 5_000;

export interface SipHeader {
  readonly name: string;
  readonly value: string;
}

export interface IncomingSipEvent {
  readonly id: string;
  readonly createdAt: number;
  readonly type: 'live.transport.incoming';
  readonly data: {
    readonly type: 'sip';
    readonly sessionId: string;
    readonly sipHeaders: readonly SipHeader[];
    readonly sipMediaSecurity?: string;
  };
  readonly object?: string;
}

export interface SipDeliveryContext {
  readonly deliveryId: string;
  /** Standard Webhooks delivery timestamp, in Unix seconds. */
  readonly deliveredAt: number;
}

export interface SipCallAcceptanceRequest {
  readonly callId: string;
  readonly providerSessionId: string;
  readonly attemptMarker: string;
  readonly grant: SipReservation['grant'];
}

export type SipCallControlResult =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'rejected' }
  | { readonly outcome: 'unknown' };

export interface SipIngressServiceOptions {
  readonly repository: VoiceSipRepository;
  readonly authorization: SipAuthorizationResolver;
  readonly now?: () => number;
  readonly admissionWindowMs?: number;
  readonly deliveryReplayWindowMs?: number;
  /** Optional future TASK37 seam; absent means reserve only. */
  readonly acceptCall?: (
    input: SipCallAcceptanceRequest,
  ) => Promise<SipCallControlResult>;
}

export type SipIngressOutcome =
  | 'reserved'
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'duplicate';

export interface SipIngressResult {
  readonly outcome: SipIngressOutcome;
  readonly callId?: string;
  readonly providerSessionId?: string;
  readonly duplicate: boolean;
  readonly externalAttempted: boolean;
  readonly reservation?: SipReservation;
  readonly reason?:
    | 'admission_closed'
    | 'stale_event'
    | 'invalid_event'
    | 'delivery_expired'
    | 'authority_denied'
    | 'authority_reuse'
    | 'capacity'
    | 'metadata_limit'
    | 'invalid_identifier'
    | 'persistence_failure';
}

/** Durable, disabled-until-wired SIP admission service. */
export class SipIngressService {
  private readonly now: () => number;
  private readonly admissionWindowMs: number;
  private readonly deliveryReplayWindowMs: number;
  private admissionOpen = true;
  private pendingReceiptWork = 0;

  constructor(private readonly options: SipIngressServiceOptions) {
    this.now = options.now ?? Date.now;
    this.admissionWindowMs = boundedPositive(
      options.admissionWindowMs ?? SIP_ADMISSION_WINDOW_MS,
      SIP_ADMISSION_WINDOW_MS,
    );
    this.deliveryReplayWindowMs = boundedPositive(
      options.deliveryReplayWindowMs ?? SIP_DELIVERY_REPLAY_WINDOW_MS,
      SIP_DELIVERY_REPLAY_WINDOW_MS,
    );
  }

  closeAdmission(): void {
    this.admissionOpen = false;
  }

  openAdmission(): void {
    this.admissionOpen = true;
  }

  /** Mark in-flight external acceptance as unknown after a restart. */
  reconcileInterruptedAttempts(): Result<number, Error> {
    const result = this.options.repository.reconcileInterruptedAttempts(this.now());
    return result.isErr() ? err(result.error) : ok(result.value);
  }

  /** Revoke retained caller authority before a daemon policy/configuration reload. */
  revokeAllAuthority(): Result<number, Error> {
    const result = this.options.repository.revokeAllGrants(this.now());
    return result.isErr() ? err(result.error) : ok(result.value);
  }

  ingest(
    event: IncomingSipEvent,
    delivery: SipDeliveryContext,
  ): Promise<Result<SipIngressResult, Error>> {
    if (this.pendingReceiptWork >= SIP_MAX_PENDING_RECEIPT_WORK) {
      return Promise.resolve(ok(denied('capacity')));
    }
    this.pendingReceiptWork += 1;
    return this.ingestInternal(event, delivery).finally(() => {
      this.pendingReceiptWork -= 1;
    });
  }

  private async ingestInternal(
    event: IncomingSipEvent,
    delivery: SipDeliveryContext,
  ): Promise<Result<SipIngressResult, Error>> {
    if (!this.admissionOpen) return ok(denied('admission_closed'));
    if (!isValidEvent(event)) return ok(denied('invalid_event'));
    if (!isBoundedIdentifier(delivery.deliveryId)) return ok(denied('invalid_identifier'));

    const existingDelivery = this.options.repository.findByDeliveryId(delivery.deliveryId);
    if (existingDelivery.isErr()) return err(existingDelivery.error);
    if (existingDelivery.value) return ok(duplicateResult(existingDelivery.value));
    const existingSession = this.options.repository.findByProviderSessionId(event.data.sessionId);
    if (existingSession.isErr()) return err(existingSession.error);
    if (existingSession.value) return ok(duplicateResult(existingSession.value));

    const nowMs = this.now();
    const nowSeconds = Math.floor(nowMs / 1_000);
    const eventCreatedMs = event.createdAt * 1_000;
    if (
      !Number.isSafeInteger(event.createdAt) ||
      eventCreatedMs > nowMs + this.admissionWindowMs ||
      nowMs - eventCreatedMs > this.admissionWindowMs
    ) {
      return ok(denied('stale_event'));
    }
    if (
      !Number.isSafeInteger(delivery.deliveredAt) ||
      delivery.deliveredAt > nowSeconds + 300 ||
      nowSeconds - delivery.deliveredAt > this.deliveryReplayWindowMs / 1_000
    ) {
      return ok(denied('delivery_expired'));
    }

    const proof = extractAssertion(event.data.sipHeaders);
    if (!proof || Buffer.byteLength(proof, 'utf8') > SIP_MAX_ASSERTION_BYTES) {
      return ok(denied('authority_denied'));
    }
    const authorization = this.options.authorization.resolve({
      proof,
      providerSessionId: event.data.sessionId,
      nowSeconds,
    });
    if (authorization.isErr()) return ok(denied('authority_denied'));

    const callId = randomUUID();
    const reservationInput: SipReservationInput = {
      callId,
      providerSessionId: event.data.sessionId,
      deliveryId: delivery.deliveryId,
      eventCreatedAt: event.createdAt,
      deliveryTimestamp: delivery.deliveredAt,
      now: nowMs,
      authorization: authorization.value,
      callMetadata: {
        eventType: event.type,
        object: event.object ?? 'event',
        mediaSecurity: event.data.sipMediaSecurity ?? 'unknown',
      },
      receiptMetadata: {
        eventType: event.type,
      },
    };
    const reserved = this.options.repository.reserve(reservationInput);
    if (reserved.isErr()) return err(reserved.error);
    if (reserved.value.outcome === 'denied') {
      return ok(denied(reserved.value.reason));
    }
    const duplicate = reserved.value.outcome !== 'reserved';
    const reservation = reserved.value.reservation;
    if (duplicate) {
      return ok(duplicateResult(reservation));
    }

    if (!this.options.acceptCall) {
      return ok({
        outcome: 'reserved',
        callId: reservation.decision.call_id,
        providerSessionId: reservation.decision.provider_session_id,
        duplicate: false,
        externalAttempted: false,
        reservation,
      });
    }

    const marker = this.options.repository.markAttempt(reservation.decision.call_id, this.now);
    if (marker.isErr()) return err(marker.error);
    if (
      !marker.value ||
      !marker.value.started ||
      marker.value.reservation.decision.state !== 'attempted' ||
      !marker.value.reservation.attemptMarker
    ) {
      const reason = marker.value?.reason ? 'authority_denied' : 'persistence_failure';
      return ok({
        outcome: reason === 'authority_denied' ? 'rejected' : 'unknown',
        callId: reservation.decision.call_id,
        providerSessionId: reservation.decision.provider_session_id,
        duplicate: false,
        externalAttempted: false,
        reservation: marker.value?.reservation ?? reservation,
        reason,
      });
    }
    const attempt = marker.value.reservation;
    let control: SipCallControlResult;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deferredDecision = new Promise<SipCallControlResult>((resolve) => {
        timeout = setTimeout(
          () => resolve({ outcome: 'unknown' }),
          SIP_DEFERRED_DECISION_BUDGET_MS,
        );
      });
      control = await Promise.race([
        this.options.acceptCall({
          callId: attempt.decision.call_id,
          providerSessionId: attempt.decision.provider_session_id,
          attemptMarker: attempt.attemptMarker!,
          grant: attempt.grant,
        }),
        deferredDecision,
      ]);
    } catch {
      control = { outcome: 'unknown' };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const outcomeToRecord: SipCallControlResult['outcome'] =
      control?.outcome === 'accepted' ||
      control?.outcome === 'rejected' ||
      control?.outcome === 'unknown'
        ? control.outcome
        : 'unknown';
    const recorded = this.options.repository.recordOutcome(
      attempt.decision.call_id,
      outcomeToRecord,
      this.now(),
    );
    if (recorded.isErr()) return err(recorded.error);
    const outcome: SipIngressOutcome =
      recorded.value?.decision.state === 'accepted'
        ? 'accepted'
        : recorded.value?.decision.state === 'rejected'
          ? 'rejected'
          : 'unknown';
    return ok({
      outcome,
      callId: attempt.decision.call_id,
      providerSessionId: attempt.decision.provider_session_id,
      duplicate: false,
      externalAttempted: true,
      reservation: recorded.value ?? attempt,
    });
  }
}

function extractAssertion(headers: readonly SipHeader[]): string | null {
  const matches = headers.filter(
    (header) =>
      typeof header.name === 'string' &&
      header.name.toLowerCase() === 'x-talon-voice-assertion',
  );
  if (matches.length !== 1) return null;
  const value = matches[0]?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isValidEvent(event: IncomingSipEvent): boolean {
  return (
    !!event &&
    event.type === 'live.transport.incoming' &&
    event.data?.type === 'sip' &&
    isBoundedIdentifier(event.id) &&
    isBoundedIdentifier(event.data.sessionId) &&
    Number.isSafeInteger(event.createdAt) &&
    Array.isArray(event.data.sipHeaders) &&
    event.data.sipHeaders.every(
      (header: SipHeader) =>
        !!header &&
        isBoundedHeader(header.name, 256) &&
        isBoundedHeader(header.value, 4_096),
    ) &&
    (event.data.sipMediaSecurity === undefined ||
      isBoundedHeader(event.data.sipMediaSecurity, 256)) &&
    (event.object === undefined || isBoundedHeader(event.object, 256))
  );
}

function isBoundedIdentifier(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= SIP_MAX_IDENTIFIER_BYTES;
}

function isBoundedHeader(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function boundedPositive(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function denied(reason: SipIngressResult['reason']): SipIngressResult {
  return {
    outcome: 'rejected',
    duplicate: false,
    externalAttempted: false,
    reason,
  };
}

function duplicateResult(reservation: SipReservation): SipIngressResult {
  return {
    outcome: 'duplicate',
    callId: reservation.decision.call_id,
    providerSessionId: reservation.decision.provider_session_id,
    duplicate: true,
    externalAttempted: false,
    reservation,
  };
}

/** Exposed for server tests; caller ID and ordinary SIP headers are ignored. */
export function sipAssertionFromHeaders(headers: readonly SipHeader[]): string | null {
  return extractAssertion(headers);
}

/** Return only the stable fields safe to hand to the future adapter. */
export function toSipGrantHandle(authorization: SipVerifiedAuthorization): SipVerifiedAuthorization {
  return {
    issuer: authorization.issuer,
    keyId: authorization.keyId,
    audience: authorization.audience,
    subject: authorization.subject,
    nonce: authorization.nonce,
    callBinding: authorization.callBinding,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    version: authorization.version,
    algorithm: authorization.algorithm,
    proofHash: authorization.proofHash,
    principal: {
      ownerId: authorization.principal.ownerId,
      personaId: authorization.principal.personaId,
    },
  };
}
