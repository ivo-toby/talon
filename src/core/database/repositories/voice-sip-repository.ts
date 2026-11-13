/**
 * Durable ownership boundary for incoming SIP deliveries.
 *
 * This repository never stores a webhook body, SIP header, signing secret, or
 * reusable assertion. Admission, revision allocation, and the first receipt
 * are committed together under BEGIN IMMEDIATE so a second SQLite connection
 * cannot reserve the same provider session after observing a stale count.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { allocateSharedVoiceRevision } from './voice-auth-repository.js';
import { BaseRepository } from './base-repository.js';
import type { SipVerifiedAuthorization } from '../../../voice/transports/sip/sip-authorization.js';

export const MAX_SIP_CALL_DECISIONS = 10_000;
export const MAX_SIP_DELIVERY_RECEIPTS = 50_000;
export const MAX_SIP_AUTHORITY_GRANTS = 10_000;
export const MAX_SIP_IDENTIFIER_BYTES = 256;
export const MAX_SIP_CALL_METADATA_BYTES = 4_096;
export const MAX_SIP_RECEIPT_METADATA_BYTES = 1_024;
export const SIP_SAFE_CLEANUP_LIMIT = 100;
export const SIP_SAFE_RETENTION_MS = 96 * 60 * 60 * 1_000;

export type SipCallDecisionState =
  | 'reserved'
  | 'attempted'
  | 'accepted'
  | 'rejected'
  | 'closed'
  | 'unknown';

export interface SipCallDecisionRow {
  readonly call_id: string;
  readonly provider_session_id: string;
  readonly state: SipCallDecisionState;
  readonly grant_revision: number;
  readonly event_created_at: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly attempt_marker: string | null;
  readonly attempted_at: number | null;
  readonly terminal_at: number | null;
  readonly metadata_json: string;
}

export interface SipAuthorityGrantRow {
  readonly revision: number;
  readonly call_id: string;
  readonly provider_session_id: string;
  readonly issuer: string;
  readonly key_id: string;
  readonly audience: string;
  readonly subject: string;
  readonly owner_id: string;
  readonly persona_id: string;
  readonly nonce: string;
  readonly call_binding: string;
  readonly proof_hash: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
  readonly metadata_json: string;
  readonly created_at: number;
}

export interface SipDeliveryReceiptRow {
  readonly delivery_id: string;
  readonly call_id: string;
  readonly provider_session_id: string;
  readonly state: SipCallDecisionState;
  readonly event_created_at: number;
  readonly delivery_timestamp: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly metadata_json: string;
}

export interface SipReservationInput {
  readonly callId: string;
  readonly providerSessionId: string;
  readonly deliveryId: string;
  readonly eventCreatedAt: number;
  readonly deliveryTimestamp: number;
  readonly now: number;
  readonly authorization: SipVerifiedAuthorization;
  readonly callMetadata?: Readonly<Record<string, unknown>>;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
}

export interface SipReservation {
  readonly decision: SipCallDecisionRow;
  readonly grant: SipAuthorityGrantRow;
  readonly receipt: SipDeliveryReceiptRow;
  readonly attemptMarker: string | null;
}

export interface SipAttemptResult {
  readonly reservation: SipReservation;
  readonly started: boolean;
  readonly reason?: 'authority_expired' | 'authority_revoked';
}

export type SipReservationResult =
  | { readonly outcome: 'reserved'; readonly reservation: SipReservation }
  | {
      readonly outcome: 'duplicate_delivery' | 'duplicate_session';
      readonly reservation: SipReservation;
    }
  | {
      readonly outcome: 'denied';
      readonly reason:
        | 'capacity'
        | 'metadata_limit'
        | 'invalid_identifier'
        | 'authority_reuse';
    };

export interface SipRepositoryCounts {
  readonly decisions: number;
  readonly receipts: number;
  readonly grants: number;
}

export class VoiceSipRepository extends BaseRepository {
  private savepointCounter = 0;

  public get database(): Database.Database {
    return this.db;
  }

  /** Reserve a call, authority grant, and delivery receipt atomically. */
  reserve(input: SipReservationInput): Result<SipReservationResult, DbError> {
    const validation = validateReservationInput(input);
    if (validation) return ok({ outcome: 'denied', reason: validation });
    const callMetadata = serializeMetadata(input.callMetadata ?? {});
    const receiptMetadata = serializeMetadata(input.receiptMetadata ?? {});
    if (
      callMetadata === null ||
      receiptMetadata === null ||
      byteLength(callMetadata ?? '') > MAX_SIP_CALL_METADATA_BYTES ||
      byteLength(receiptMetadata ?? '') > MAX_SIP_RECEIPT_METADATA_BYTES
    ) {
      return ok({ outcome: 'denied', reason: 'metadata_limit' });
    }

    try {
      const result = this.runImmediateTransaction(() => {
        const existingReceipt = this.findReceiptUnsafe(input.deliveryId);
        if (existingReceipt) {
          const reservation = this.findReservationUnsafe(existingReceipt.call_id);
          if (reservation) {
            return {
              outcome: 'duplicate_delivery',
              reservation,
            } satisfies SipReservationResult;
          }
        }

        const existingDecision = this.findDecisionUnsafe(input.providerSessionId);
        if (existingDecision) {
          const reservation = this.findReservationUnsafe(existingDecision.call_id);
          if (reservation) {
            return {
              outcome: 'duplicate_session',
              reservation,
            } satisfies SipReservationResult;
          }
        }

        const existingNonce = this.db
          .prepare('SELECT call_id FROM voice_sip_authority_grants WHERE nonce = ?')
          .get(input.authorization.nonce) as { call_id: string } | undefined;
        if (existingNonce) {
          return { outcome: 'denied', reason: 'authority_reuse' } satisfies SipReservationResult;
        }

        this.pruneSafeUnsafe(input.now);
        const counts = this.countsUnsafe();
        if (
          counts.decisions >= MAX_SIP_CALL_DECISIONS ||
          counts.receipts >= MAX_SIP_DELIVERY_RECEIPTS ||
          counts.grants >= MAX_SIP_AUTHORITY_GRANTS
        ) {
          return { outcome: 'denied', reason: 'capacity' } satisfies SipReservationResult;
        }

        const revision = allocateSharedVoiceRevision(this.db);
        const createdAt = input.now;
        const decision: SipCallDecisionRow = {
          call_id: input.callId,
          provider_session_id: input.providerSessionId,
          state: 'reserved',
          grant_revision: revision,
          event_created_at: input.eventCreatedAt,
          created_at: createdAt,
          updated_at: createdAt,
          attempt_marker: null,
          attempted_at: null,
          terminal_at: null,
          metadata_json: callMetadata ?? '{}',
        };
        this.db
          .prepare(
            `INSERT INTO voice_sip_call_decisions
               (call_id, provider_session_id, state, grant_revision,
                event_created_at, created_at, updated_at, attempt_marker,
                attempted_at, terminal_at, metadata_json)
             VALUES (@call_id, @provider_session_id, @state, @grant_revision,
                @event_created_at, @created_at, @updated_at, @attempt_marker,
                @attempted_at, @terminal_at, @metadata_json)`,
          )
          .run(decision);

        const grant: SipAuthorityGrantRow = {
          revision,
          call_id: input.callId,
          provider_session_id: input.providerSessionId,
          issuer: input.authorization.issuer,
          key_id: input.authorization.keyId,
          audience: input.authorization.audience,
          subject: input.authorization.subject,
          owner_id: input.authorization.principal.ownerId,
          persona_id: input.authorization.principal.personaId,
          nonce: input.authorization.nonce,
          call_binding: input.authorization.callBinding,
          proof_hash: input.authorization.proofHash,
          issued_at: input.authorization.issuedAt,
          expires_at: input.authorization.expiresAt,
          revoked_at: null,
          metadata_json: callMetadata ?? '{}',
          created_at: createdAt,
        };
        this.db
          .prepare(
            `INSERT INTO voice_sip_authority_grants
               (revision, call_id, provider_session_id, issuer, key_id,
                audience, subject, owner_id, persona_id, nonce, call_binding,
                proof_hash, issued_at, expires_at, revoked_at, metadata_json,
                created_at)
             VALUES (@revision, @call_id, @provider_session_id, @issuer, @key_id,
                @audience, @subject, @owner_id, @persona_id, @nonce,
                @call_binding, @proof_hash, @issued_at, @expires_at,
                @revoked_at, @metadata_json, @created_at)`,
          )
          .run(grant);

        const receipt: SipDeliveryReceiptRow = {
          delivery_id: input.deliveryId,
          call_id: input.callId,
          provider_session_id: input.providerSessionId,
          state: 'reserved',
          event_created_at: input.eventCreatedAt,
          delivery_timestamp: input.deliveryTimestamp,
          created_at: createdAt,
          updated_at: createdAt,
          metadata_json: receiptMetadata ?? '{}',
        };
        this.db
          .prepare(
            `INSERT INTO voice_sip_delivery_receipts
               (delivery_id, call_id, provider_session_id, state,
                event_created_at, delivery_timestamp, created_at, updated_at,
                metadata_json)
             VALUES (@delivery_id, @call_id, @provider_session_id, @state,
                @event_created_at, @delivery_timestamp, @created_at,
                @updated_at, @metadata_json)`,
          )
          .run(receipt);
        return {
          outcome: 'reserved',
          reservation: { decision, grant, receipt, attemptMarker: null },
        } satisfies SipReservationResult;
      });
      return ok(result);
    } catch (cause) {
      return err(this.dbError('reserve incoming SIP call', cause));
    }
  }

  /** Persist the one and only marker that permits an external accept. */
  markAttempt(callId: string, now: number | (() => number)): Result<SipAttemptResult | null, DbError> {
    try {
      const result = this.runImmediateTransaction(() => {
        const attemptNow = typeof now === 'function' ? now() : now;
        const decision = this.findDecisionByCallUnsafe(callId);
        if (!decision) return null;
        const reservation = this.findReservationUnsafe(callId);
        if (!reservation) return null;
        let started = false;
        let reason: SipAttemptResult['reason'];
        if (decision.state === 'reserved') {
          if (reservation.grant.revoked_at !== null) {
            reason = 'authority_revoked';
          } else if (reservation.grant.expires_at * 1_000 <= attemptNow) {
            reason = 'authority_expired';
          } else {
            const marker = randomUUID();
            const updated = this.db
              .prepare(
                `UPDATE voice_sip_call_decisions
                    SET state = 'attempted', attempt_marker = ?, attempted_at = ?, updated_at = ?
                  WHERE call_id = ? AND state = 'reserved'`,
              )
              .run(marker, attemptNow, attemptNow, callId);
            if (updated.changes === 1) {
              started = true;
              this.updateReceiptStateUnsafe(callId, 'attempted', attemptNow);
            }
          }
        }
        const latestReservation = this.findReservationUnsafe(callId);
        return latestReservation ? { reservation: latestReservation, started, reason } : null;
      });
      return ok(result);
    } catch (cause) {
      return err(this.dbError('mark incoming SIP call attempt', cause));
    }
  }

  /** Record a definitive outcome, or preserve unknown when the accept is ambiguous. */
  recordOutcome(
    callId: string,
    state: Extract<SipCallDecisionState, 'accepted' | 'rejected' | 'closed' | 'unknown'>,
    now: number,
  ): Result<SipReservation | null, DbError> {
    try {
      const result = this.runImmediateTransaction(() => {
        const decision = this.findDecisionByCallUnsafe(callId);
        if (!decision) return null;
        const allowedStates =
          state === 'closed'
            ? ['attempted', 'accepted', 'closed']
            : state === 'accepted'
              ? ['attempted', 'accepted']
              : state === 'rejected'
                ? ['attempted', 'rejected']
                : ['attempted', 'unknown'];
        if (allowedStates.includes(decision.state)) {
          const terminalAt = state === 'accepted' || state === 'unknown' ? null : now;
          const placeholders = allowedStates.map(() => '?').join(', ');
          this.db
            .prepare(
              `UPDATE voice_sip_call_decisions
                  SET state = ?, terminal_at = ?, updated_at = ?
                WHERE call_id = ? AND state IN (${placeholders})`,
            )
            .run(state, terminalAt, now, callId, ...allowedStates);
          this.updateReceiptStateUnsafe(callId, state, now);
        }
        return this.findReservationUnsafe(callId);
      });
      return ok(result);
    } catch (cause) {
      return err(this.dbError('record incoming SIP call outcome', cause));
    }
  }

  /** Convert interrupted attempt markers to unknown after a daemon restart. */
  reconcileInterruptedAttempts(now: number): Result<number, DbError> {
    try {
      const result = this.runImmediateTransaction(() => {
        const update = this.db
          .prepare(
            `UPDATE voice_sip_call_decisions
                SET state = 'unknown', terminal_at = NULL, updated_at = ?
              WHERE state = 'attempted'`,
          )
          .run(now);
        this.db
          .prepare(
            `UPDATE voice_sip_delivery_receipts
                SET state = 'unknown', updated_at = ?
              WHERE state = 'attempted'`,
          )
          .run(now);
        return update.changes;
      });
      return ok(result);
    } catch (cause) {
      return err(this.dbError('reconcile interrupted SIP attempts', cause));
    }
  }

  revokeGrant(callId: string, now: number): Result<boolean, DbError> {
    try {
      const result = this.db
        .prepare(
          `UPDATE voice_sip_authority_grants
              SET revoked_at = COALESCE(revoked_at, ?)
            WHERE call_id = ?`,
        )
        .run(now, callId);
      return ok(result.changes > 0);
    } catch (cause) {
      return err(this.dbError('revoke SIP authority grant', cause));
    }
  }

  /** Revoke every active SIP grant before a daemon policy/configuration reload. */
  revokeAllGrants(now: number): Result<number, DbError> {
    try {
      const result = this.db
        .prepare(
          `UPDATE voice_sip_authority_grants
              SET revoked_at = COALESCE(revoked_at, ?)
            WHERE revoked_at IS NULL`,
        )
        .run(now);
      return ok(result.changes);
    } catch (cause) {
      return err(this.dbError('revoke all SIP authority grants', cause));
    }
  }

  findByDeliveryId(deliveryId: string): Result<SipReservation | null, DbError> {
    try {
      return ok(this.findReservationUnsafeByReceipt(this.findReceiptUnsafe(deliveryId)));
    } catch (cause) {
      return err(this.dbError('find SIP delivery receipt', cause));
    }
  }

  findByProviderSessionId(providerSessionId: string): Result<SipReservation | null, DbError> {
    try {
      const decision = this.findDecisionUnsafe(providerSessionId);
      return ok(decision ? this.findReservationUnsafe(decision.call_id) : null);
    } catch (cause) {
      return err(this.dbError('find SIP provider session decision', cause));
    }
  }

  findByCallId(callId: string): Result<SipReservation | null, DbError> {
    try {
      return ok(this.findReservationUnsafe(callId));
    } catch (cause) {
      return err(this.dbError('find SIP call decision', cause));
    }
  }

  counts(): Result<SipRepositoryCounts, DbError> {
    try {
      return ok(this.countsUnsafe());
    } catch (cause) {
      return err(this.dbError('count SIP ingress rows', cause));
    }
  }

  /** Delete only expired, old, known-terminal call families, capped globally. */
  pruneSafe(now: number): Result<number, DbError> {
    try {
      return ok(this.runImmediateTransaction(() => this.pruneSafeUnsafe(now)));
    } catch (cause) {
      return err(this.dbError('prune safe SIP ingress rows', cause));
    }
  }

  private pruneSafeUnsafe(now: number): number {
    const cutoff = now - SIP_SAFE_RETENTION_MS;
    const cutoffEventSeconds = Math.floor(cutoff / 1_000);
    const nowSeconds = Math.floor(now / 1_000);
    const candidates = this.db
      .prepare(
        `SELECT d.call_id,
                (SELECT COUNT(*) FROM voice_sip_call_decisions d2 WHERE d2.call_id = d.call_id) AS decision_count,
                (SELECT COUNT(*) FROM voice_sip_authority_grants g2 WHERE g2.call_id = d.call_id) AS grant_count,
                (SELECT COUNT(*) FROM voice_sip_delivery_receipts r2 WHERE r2.call_id = d.call_id) AS receipt_count
           FROM voice_sip_call_decisions d
           JOIN voice_sip_authority_grants g ON g.call_id = d.call_id
          WHERE d.state IN ('accepted', 'rejected', 'closed')
            AND d.terminal_at IS NOT NULL
            AND d.terminal_at <= ?
            AND d.event_created_at <= ?
            AND (g.revoked_at IS NOT NULL OR g.expires_at <= ?)
          ORDER BY d.terminal_at ASC
          LIMIT 10000`,
      )
      .all(cutoff, cutoffEventSeconds, nowSeconds) as Array<{
      call_id: string;
      decision_count: number;
      grant_count: number;
      receipt_count: number;
    }>;
    let deleted = 0;
    for (const candidate of candidates) {
      const familySize = candidate.decision_count + candidate.grant_count + candidate.receipt_count;
      if (familySize === 0 || deleted + familySize > SIP_SAFE_CLEANUP_LIMIT) break;
      this.db
        .prepare('DELETE FROM voice_sip_delivery_receipts WHERE call_id = ?')
        .run(candidate.call_id);
      this.db
        .prepare('DELETE FROM voice_sip_authority_grants WHERE call_id = ?')
        .run(candidate.call_id);
      this.db
        .prepare('DELETE FROM voice_sip_call_decisions WHERE call_id = ?')
        .run(candidate.call_id);
      deleted += familySize;
    }
    return deleted;
  }

  private countsUnsafe(): SipRepositoryCounts {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return row.count;
    };
    return {
      decisions: count('voice_sip_call_decisions'),
      receipts: count('voice_sip_delivery_receipts'),
      grants: count('voice_sip_authority_grants'),
    };
  }

  private findDecisionUnsafe(providerSessionId: string): SipCallDecisionRow | null {
    return (
      this.db
        .prepare('SELECT * FROM voice_sip_call_decisions WHERE provider_session_id = ?')
        .get(providerSessionId) as SipCallDecisionRow | undefined
    ) ?? null;
  }

  private findDecisionByCallUnsafe(callId: string): SipCallDecisionRow | null {
    return (
      this.db.prepare('SELECT * FROM voice_sip_call_decisions WHERE call_id = ?').get(callId) as
        | SipCallDecisionRow
        | undefined
    ) ?? null;
  }

  private findReceiptUnsafe(deliveryId: string): SipDeliveryReceiptRow | null {
    return (
      this.db
        .prepare('SELECT * FROM voice_sip_delivery_receipts WHERE delivery_id = ?')
        .get(deliveryId) as SipDeliveryReceiptRow | undefined
    ) ?? null;
  }

  private findReservationUnsafe(callId: string): SipReservation | null {
    const decision = this.findDecisionByCallUnsafe(callId);
    if (!decision) return null;
    const grant = this.db
      .prepare('SELECT * FROM voice_sip_authority_grants WHERE call_id = ?')
      .get(callId) as SipAuthorityGrantRow | undefined;
    const receipt = this.db
      .prepare(
        `SELECT * FROM voice_sip_delivery_receipts
          WHERE call_id = ? ORDER BY created_at ASC LIMIT 1`,
      )
      .get(callId) as SipDeliveryReceiptRow | undefined;
    if (!grant || !receipt) return null;
    return {
      decision,
      grant,
      receipt,
      attemptMarker: decision.attempt_marker,
    };
  }

  private findReservationUnsafeByReceipt(
    receipt: SipDeliveryReceiptRow | null,
  ): SipReservation | null {
    return receipt ? this.findReservationUnsafe(receipt.call_id) : null;
  }

  private updateReceiptStateUnsafe(callId: string, state: SipCallDecisionState, now: number): void {
    this.db
      .prepare(
        `UPDATE voice_sip_delivery_receipts
            SET state = ?, updated_at = ?
          WHERE call_id = ?`,
      )
      .run(state, now, callId);
  }

  private runImmediateTransaction<T>(operation: () => T): T {
    if (this.db.inTransaction) {
      const savepoint = `voice_sip_savepoint_${this.savepointCounter += 1}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = operation();
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (cause) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // Keep the original failure as the Result error.
        }
        throw cause;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Keep the original failure as the Result error.
      }
      throw cause;
    }
  }

  private dbError(operation: string, cause: unknown): DbError {
    return new DbError(
      `Failed to ${operation}: ${String(cause)}`,
      cause instanceof Error ? cause : undefined,
    );
  }
}

function validateReservationInput(
  input: SipReservationInput,
): 'invalid_identifier' | null {
  const identifiers = [
    input.callId,
    input.providerSessionId,
    input.deliveryId,
    input.authorization.issuer,
    input.authorization.keyId,
    input.authorization.audience,
    input.authorization.subject,
    input.authorization.principal.ownerId,
    input.authorization.principal.personaId,
    input.authorization.nonce,
    input.authorization.callBinding,
    input.authorization.proofHash,
  ];
  if (identifiers.some((value) => !isBoundedIdentifier(value))) return 'invalid_identifier';
  return null;
}

function isBoundedIdentifier(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && byteLength(value) <= MAX_SIP_IDENTIFIER_BYTES;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function serializeMetadata(value: Readonly<Record<string, unknown>>): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}
