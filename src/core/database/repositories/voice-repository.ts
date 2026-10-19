/**
 * Persistence primitives for browservoice sessions, delegations, and output
 * lifecycle records.
 *
 * This repository intentionally stores normalized JSON snapshots for the
 * bounded backend request and policy. Raw audio and an unbounded transcript
 * are not part of the schema.
 */

import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';
import type {
  VoiceDelegationStatus,
  VoiceExecutionStatus,
  VoiceDeliveryStatus,
  VoicePlaybackStatus,
  VoiceSessionStatus,
} from '../../../voice/voice-types.js';

export interface VoiceSessionRow {
  id: string;
  revision: number;
  owner_id: string;
  login_revision: number;
  persona_id: string;
  thread_id: string;
  transport: string;
  status: VoiceSessionStatus;
  provider_session_id: string | null;
  created_at: number;
  started_at: number | null;
  deadline_at: number;
  closing_at: number | null;
  closed_at: number | null;
  policy_json: string;
  usage_json: string;
  finalization_json: string;
  active_delegation_id: string | null;
  record_digest: string;
  updated_at: number;
}

export interface VoiceDelegationRow {
  id: string;
  session_id: string;
  provider_delegation_id: string;
  revision: number;
  context_version: number;
  context_digest: string;
  request_json: string;
  status: VoiceDelegationStatus;
  execution_status: VoiceExecutionStatus;
  delivery_status: VoiceDeliveryStatus;
  provider_ack_status: 'not_sent' | 'sent' | 'acknowledged' | 'rejected' | 'unknown';
  playback_status: VoicePlaybackStatus;
  queue_item_id: string | null;
  run_id: string | null;
  supersedes_delegation_id: string | null;
  latest_output_id: string | null;
  error_code: string | null;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  updated_at: number;
  record_digest: string;
}

export interface VoiceOutputRow {
  id: string;
  delegation_id: string;
  kind: 'progress' | 'final';
  text: string | null;
  execution_status: VoiceExecutionStatus;
  delivery_status: VoiceDeliveryStatus;
  provider_ack_status: VoiceDelegationRow['provider_ack_status'];
  playback_status: VoicePlaybackStatus;
  created_at: number;
  updated_at: number;
  record_digest: string;
}

export interface VoiceSessionLookup {
  ownerId?: string;
  threadId?: string;
  statuses?: readonly VoiceSessionStatus[];
  before?: number;
}

/** Repository for durable browservoice rows. */
export class VoiceRepository extends BaseRepository {
  public get database(): Database.Database {
    return this.db;
  }

  insertSession(row: VoiceSessionRow): Result<VoiceSessionRow, DbError> {
    try {
      this.db
        .prepare(
          `INSERT INTO voice_sessions
             (id, revision, owner_id, login_revision, persona_id, thread_id, transport,
              status, provider_session_id, created_at, started_at, deadline_at, closing_at,
              closed_at, policy_json, usage_json, finalization_json, active_delegation_id,
              record_digest, updated_at)
           VALUES
             (@id, @revision, @owner_id, @login_revision, @persona_id, @thread_id, @transport,
              @status, @provider_session_id, @created_at, @started_at, @deadline_at, @closing_at,
              @closed_at, @policy_json, @usage_json, @finalization_json, @active_delegation_id,
              @record_digest, @updated_at)`,
        )
        .run(row);
      return ok(row);
    } catch (cause) {
      return err(this.dbError('insert voice session', cause));
    }
  }

  findSessionById(id: string): Result<VoiceSessionRow | null, DbError> {
    try {
      const row = this.db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(id) as
        | VoiceSessionRow
        | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.dbError('find voice session', cause));
    }
  }

  findSessionByProviderId(providerSessionId: string): Result<VoiceSessionRow | null, DbError> {
    try {
      const row = this.db
        .prepare('SELECT * FROM voice_sessions WHERE provider_session_id = ?')
        .get(providerSessionId) as VoiceSessionRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.dbError('find voice session by provider id', cause));
    }
  }

  findSessions(input: VoiceSessionLookup = {}): Result<VoiceSessionRow[], DbError> {
    try {
      const clauses: string[] = [];
      const params: Array<string | number> = [];

      if (input.ownerId !== undefined) {
        clauses.push('owner_id = ?');
        params.push(input.ownerId);
      }
      if (input.threadId !== undefined) {
        clauses.push('thread_id = ?');
        params.push(input.threadId);
      }
      if (input.statuses !== undefined) {
        if (input.statuses.length === 0) return ok([]);
        clauses.push(`status IN (${input.statuses.map(() => '?').join(', ')})`);
        params.push(...input.statuses);
      }
      if (input.before !== undefined) {
        clauses.push('updated_at < ?');
        params.push(input.before);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = this.db
        .prepare(`SELECT * FROM voice_sessions ${where} ORDER BY created_at ASC`)
        .all(...params) as VoiceSessionRow[];
      return ok(rows);
    } catch (cause) {
      return err(this.dbError('list voice sessions', cause));
    }
  }

  updateSession(
    row: VoiceSessionRow,
    expectedRevision: number,
  ): Result<VoiceSessionRow | null, DbError> {
    try {
      const result = this.db
        .prepare(
          `UPDATE voice_sessions
              SET revision = @revision,
                  owner_id = @owner_id,
                  login_revision = @login_revision,
                  persona_id = @persona_id,
                  thread_id = @thread_id,
                  transport = @transport,
                  status = @status,
                  provider_session_id = @provider_session_id,
                  created_at = @created_at,
                  started_at = @started_at,
                  deadline_at = @deadline_at,
                  closing_at = @closing_at,
                  closed_at = @closed_at,
                  policy_json = @policy_json,
                  usage_json = @usage_json,
                  finalization_json = @finalization_json,
                  active_delegation_id = @active_delegation_id,
                  record_digest = @record_digest,
                  updated_at = @updated_at
            WHERE id = @id AND revision = @expected_revision`,
        )
        .run({ ...row, expected_revision: expectedRevision });
      if (result.changes === 0) return ok(null);
      return this.findSessionById(row.id);
    } catch (cause) {
      return err(this.dbError('update voice session', cause));
    }
  }

  insertDelegation(row: VoiceDelegationRow): Result<VoiceDelegationRow, DbError> {
    try {
      this.db
        .prepare(
          `INSERT INTO voice_delegations
             (id, session_id, provider_delegation_id, revision, context_version, context_digest,
              request_json, status, execution_status, delivery_status, provider_ack_status,
              playback_status, queue_item_id, run_id, supersedes_delegation_id, latest_output_id,
              error_code, created_at, claimed_at, completed_at, updated_at, record_digest)
           VALUES
             (@id, @session_id, @provider_delegation_id, @revision, @context_version, @context_digest,
              @request_json, @status, @execution_status, @delivery_status, @provider_ack_status,
              @playback_status, @queue_item_id, @run_id, @supersedes_delegation_id, @latest_output_id,
              @error_code, @created_at, @claimed_at, @completed_at, @updated_at, @record_digest)`,
        )
        .run(row);
      return ok(row);
    } catch (cause) {
      return err(this.dbError('insert voice delegation', cause));
    }
  }

  findDelegationById(id: string): Result<VoiceDelegationRow | null, DbError> {
    try {
      const row = this.db.prepare('SELECT * FROM voice_delegations WHERE id = ?').get(id) as
        | VoiceDelegationRow
        | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.dbError('find voice delegation', cause));
    }
  }

  findDelegationByProviderId(
    sessionId: string,
    providerDelegationId: string,
  ): Result<VoiceDelegationRow | null, DbError> {
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM voice_delegations
            WHERE session_id = ? AND provider_delegation_id = ?`,
        )
        .get(sessionId, providerDelegationId) as VoiceDelegationRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.dbError('find voice delegation by provider id', cause));
    }
  }

  findDelegationByRunId(runId: string): Result<VoiceDelegationRow | null, DbError> {
    try {
      const row = this.db
        .prepare(
          `SELECT vd.* FROM voice_delegations vd
            LEFT JOIN runs r ON r.queue_item_id = vd.queue_item_id
            WHERE vd.run_id = ? OR r.id = ?
            ORDER BY vd.created_at DESC
            LIMIT 1`,
        )
        .get(runId, runId) as VoiceDelegationRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.dbError('find voice delegation by run id', cause));
    }
  }

  findDelegationsBySession(sessionId: string): Result<VoiceDelegationRow[], DbError> {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM voice_delegations
            WHERE session_id = ? ORDER BY created_at ASC`,
        )
        .all(sessionId) as VoiceDelegationRow[];
      return ok(rows);
    } catch (cause) {
      return err(this.dbError('list voice delegations', cause));
    }
  }

  updateDelegation(
    row: VoiceDelegationRow,
    expectedRevision?: number,
  ): Result<VoiceDelegationRow | null, DbError> {
    try {
      const predicate = expectedRevision === undefined
        ? 'id = @id'
        : 'id = @id AND revision = @expected_revision';
      const result = this.db
        .prepare(
          `UPDATE voice_delegations
              SET session_id = @session_id,
                  provider_delegation_id = @provider_delegation_id,
                  revision = @revision,
                  context_version = @context_version,
                  context_digest = @context_digest,
                  request_json = @request_json,
                  status = @status,
                  execution_status = @execution_status,
                  delivery_status = @delivery_status,
                  provider_ack_status = @provider_ack_status,
                  playback_status = @playback_status,
                  queue_item_id = @queue_item_id,
                  run_id = @run_id,
                  supersedes_delegation_id = @supersedes_delegation_id,
                  latest_output_id = @latest_output_id,
                  error_code = @error_code,
                  created_at = @created_at,
                  claimed_at = @claimed_at,
                  completed_at = @completed_at,
                  updated_at = @updated_at,
                  record_digest = @record_digest
            WHERE ${predicate}`,
        )
        .run({ ...row, expected_revision: expectedRevision });
      if (result.changes === 0) return ok(null);
      return this.findDelegationById(row.id);
    } catch (cause) {
      return err(this.dbError('update voice delegation', cause));
    }
  }

  insertOutput(row: VoiceOutputRow): Result<VoiceOutputRow, DbError> {
    try {
      this.db
        .prepare(
          `INSERT INTO voice_outputs
             (id, delegation_id, kind, text, execution_status, delivery_status,
              provider_ack_status, playback_status, created_at, updated_at, record_digest)
           VALUES
             (@id, @delegation_id, @kind, @text, @execution_status, @delivery_status,
              @provider_ack_status, @playback_status, @created_at, @updated_at, @record_digest)`,
        )
        .run(row);
      return ok(row);
    } catch (cause) {
      return err(this.dbError('insert voice output', cause));
    }
  }

  findOutputById(id: string): Result<VoiceOutputRow | null, DbError> {
    try {
      const row = this.db.prepare('SELECT * FROM voice_outputs WHERE id = ?').get(id) as
        | VoiceOutputRow
        | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.dbError('find voice output', cause));
    }
  }

  findOutputsByDelegation(delegationId: string): Result<VoiceOutputRow[], DbError> {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM voice_outputs
            WHERE delegation_id = ? ORDER BY created_at ASC`,
        )
        .all(delegationId) as VoiceOutputRow[];
      return ok(rows);
    } catch (cause) {
      return err(this.dbError('list voice outputs', cause));
    }
  }

  findOutputsBySession(sessionId: string): Result<VoiceOutputRow[], DbError> {
    try {
      const rows = this.db
        .prepare(
          `SELECT vo.* FROM voice_outputs vo
            INNER JOIN voice_delegations vd ON vd.id = vo.delegation_id
            WHERE vd.session_id = ? ORDER BY vo.created_at ASC`,
        )
        .all(sessionId) as VoiceOutputRow[];
      return ok(rows);
    } catch (cause) {
      return err(this.dbError('list voice session outputs', cause));
    }
  }

  updateOutput(row: VoiceOutputRow): Result<VoiceOutputRow | null, DbError> {
    try {
      const result = this.db
        .prepare(
          `UPDATE voice_outputs
              SET delegation_id = @delegation_id,
                  kind = @kind,
                  text = @text,
                  execution_status = @execution_status,
                  delivery_status = @delivery_status,
                  provider_ack_status = @provider_ack_status,
                  playback_status = @playback_status,
                  created_at = @created_at,
                  updated_at = @updated_at,
                  record_digest = @record_digest
            WHERE id = @id`,
        )
        .run(row);
      if (result.changes === 0) return ok(null);
      return this.findOutputById(row.id);
    } catch (cause) {
      return err(this.dbError('update voice output', cause));
    }
  }

  private dbError(operation: string, cause: unknown): DbError {
    return new DbError(
      `Failed to ${operation}: ${String(cause)}`,
      cause instanceof Error ? cause : undefined,
    );
  }
}
