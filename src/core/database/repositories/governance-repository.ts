/**
 * Repository for governance rate-limit and violation records.
 *
 * Persists append-only governance telemetry used by runtime policy checks.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

export interface RateLimitEventRow {
  id: string;
  channel_id: string;
  sender_id: string | null;
  event_type: string;
  ts: number;
}

/** Row shape matching the `governance_violations` table exactly. */
export interface GovernanceViolationRow {
  id: string;
  persona_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  violation: string;
  detail: string | null;
  action_taken: string;
  ts: number;
}

export interface RecordRateLimitEventInput {
  id: string;
  channelId: string;
  senderId?: string;
  eventType: string;
}

export interface RecordGovernanceViolationInput {
  id: string;
  personaId?: string;
  threadId?: string;
  runId?: string;
  violation: string;
  detail?: Record<string, unknown>;
  actionTaken: string;
}

export interface ListGovernanceViolationsFilter {
  personaId?: string;
  sinceTs?: number;
  limit?: number;
}

/** Repository for governance rate-limit and violation persistence. */
export class GovernanceRepository extends BaseRepository {
  private readonly recordRateLimitEventStmt: Database.Statement;
  private readonly countRecentChannelEventsStmt: Database.Statement;
  private readonly countRecentSenderEventsStmt: Database.Statement;
  private readonly pruneOldEventsStmt: Database.Statement;
  private readonly recordViolationStmt: Database.Statement;
  private readonly listViolationsStmt: Database.Statement;
  private readonly listViolationsByPersonaStmt: Database.Statement;
  private readonly listViolationsSinceStmt: Database.Statement;
  private readonly listViolationsByPersonaAndSinceStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.recordRateLimitEventStmt = db.prepare(`
      INSERT INTO rate_limit_events
        (id, channel_id, sender_id, event_type, ts)
      VALUES
        (@id, @channel_id, @sender_id, @event_type, @ts)
    `);

    this.countRecentChannelEventsStmt = db.prepare(`
      SELECT COUNT(*) AS count
      FROM rate_limit_events
      WHERE channel_id = @channel_id
        AND event_type = @event_type
        AND ts >= @since_ts
    `);

    this.countRecentSenderEventsStmt = db.prepare(`
      SELECT COUNT(*) AS count
      FROM rate_limit_events
      WHERE channel_id = @channel_id
        AND sender_id = @sender_id
        AND event_type = @event_type
        AND ts >= @since_ts
    `);

    this.pruneOldEventsStmt = db.prepare(`
      DELETE FROM rate_limit_events
      WHERE ts < ?
    `);

    this.recordViolationStmt = db.prepare(`
      INSERT INTO governance_violations
        (id, persona_id, thread_id, run_id, violation, detail, action_taken, ts)
      VALUES
        (@id, @persona_id, @thread_id, @run_id, @violation, @detail, @action_taken, @ts)
    `);

    this.listViolationsStmt = db.prepare(`
      SELECT * FROM governance_violations
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `);

    this.listViolationsByPersonaStmt = db.prepare(`
      SELECT * FROM governance_violations
      WHERE persona_id = ?
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `);

    this.listViolationsSinceStmt = db.prepare(`
      SELECT * FROM governance_violations
      WHERE ts >= ?
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `);

    this.listViolationsByPersonaAndSinceStmt = db.prepare(`
      SELECT * FROM governance_violations
      WHERE persona_id = ?
        AND ts >= ?
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `);
  }

  /** Records a rate-limit event at the current timestamp. */
  recordRateLimitEvent(event: RecordRateLimitEventInput): Result<void, DbError> {
    try {
      const row: RateLimitEventRow = {
        id: event.id,
        channel_id: event.channelId,
        sender_id: event.senderId ?? null,
        event_type: event.eventType,
        ts: this.now(),
      };
      this.recordRateLimitEventStmt.run(row);
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to record rate limit event: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Counts recent matching rate-limit events inside a rolling time window.
   *
   * When `senderId` is omitted, the count is scoped to the channel only.
   */
  countRecentEvents(
    channelId: string,
    senderId: string | undefined,
    eventType: string,
    windowMs: number,
  ): Result<number, DbError> {
    try {
      const sinceTs = this.now() - windowMs;
      const row = (
        senderId !== undefined
          ? this.countRecentSenderEventsStmt.get({
              channel_id: channelId,
              sender_id: senderId,
              event_type: eventType,
              since_ts: sinceTs,
            })
          : this.countRecentChannelEventsStmt.get({
              channel_id: channelId,
              event_type: eventType,
              since_ts: sinceTs,
            })
      ) as { count: number };
      return ok(row.count);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to count recent rate limit events: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Removes rate-limit events older than the supplied age window. */
  pruneOldEvents(olderThanMs: number): Result<void, DbError> {
    try {
      this.pruneOldEventsStmt.run(this.now() - olderThanMs);
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to prune old rate limit events: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Persists a governance violation at the current timestamp. */
  recordViolation(v: RecordGovernanceViolationInput): Result<void, DbError> {
    try {
      const row: GovernanceViolationRow = {
        id: v.id,
        persona_id: v.personaId ?? null,
        thread_id: v.threadId ?? null,
        run_id: v.runId ?? null,
        violation: v.violation,
        detail: v.detail === undefined ? null : JSON.stringify(v.detail),
        action_taken: v.actionTaken,
        ts: this.now(),
      };
      this.recordViolationStmt.run(row);
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to record governance violation: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Lists governance violations filtered by persona and/or lower-bound timestamp. */
  listViolations(
    filter: ListGovernanceViolationsFilter = {},
  ): Result<GovernanceViolationRow[], DbError> {
    try {
      const limit = filter.limit ?? 20;
      const { personaId, sinceTs } = filter;
      let rows: GovernanceViolationRow[];

      if (personaId !== undefined && sinceTs !== undefined) {
        rows = this.listViolationsByPersonaAndSinceStmt.all(
          personaId,
          sinceTs,
          limit,
        ) as GovernanceViolationRow[];
      } else if (personaId !== undefined) {
        rows = this.listViolationsByPersonaStmt.all(
          personaId,
          limit,
        ) as GovernanceViolationRow[];
      } else if (sinceTs !== undefined) {
        rows = this.listViolationsSinceStmt.all(
          sinceTs,
          limit,
        ) as GovernanceViolationRow[];
      } else {
        rows = this.listViolationsStmt.all(limit) as GovernanceViolationRow[];
      }

      return ok(rows);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to list governance violations: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
