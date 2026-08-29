/** Durable, idempotent handoff storage for validated lifecycle signals. */

import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { err, ok, type Result } from 'neverthrow';

import { DbError } from '../../errors/index.js';
import {
  LifecycleSignalEnvelopeSchema,
  type LifecycleSignalEnvelope,
} from '../../../lifecycle/contracts/index.js';
import { BaseRepository } from './base-repository.js';

export interface LifecycleSignalHandoffInput {
  readonly eventId: string;
  readonly handlerId: string;
  readonly persona: string;
  readonly idempotencyKey: string;
  readonly signals: readonly unknown[];
}

export interface LifecycleSignalRow {
  signal_id: string;
  handoff_key: string;
  persona: string;
  version: 'v1';
  type: string;
  context: string;
  payload: string;
  occurred_at: string;
  created_at: number;
}

function sameHandoff(
  row: { event_id: string; handler_id: string; persona: string },
  input: LifecycleSignalHandoffInput,
): boolean {
  return (
    row.event_id === input.eventId &&
    row.handler_id === input.handlerId &&
    row.persona === input.persona
  );
}

/** Signals are committed atomically before the originating delivery completes. */
export class LifecycleSignalRepository extends BaseRepository {
  private readonly findHandoffStmt: Database.Statement;
  private readonly insertHandoffStmt: Database.Statement;
  private readonly insertSignalStmt: Database.Statement;
  private readonly countSignalsStmt: Database.Statement;
  private readonly findSignalsStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.findHandoffStmt = db.prepare(`
      SELECT event_id, handler_id, persona FROM lifecycle_signal_handoffs WHERE idempotency_key = ?
    `);
    this.insertHandoffStmt = db.prepare(`
      INSERT INTO lifecycle_signal_handoffs (idempotency_key, event_id, handler_id, persona, created_at)
      VALUES (@idempotency_key, @event_id, @handler_id, @persona, @created_at)
    `);
    this.insertSignalStmt = db.prepare(`
      INSERT INTO lifecycle_signals
        (signal_id, handoff_key, persona, version, type, context, payload, occurred_at, created_at)
      VALUES
        (@signal_id, @handoff_key, @persona, @version, @type, @context, @payload, @occurred_at, @created_at)
    `);
    this.countSignalsStmt = db.prepare(`
      SELECT COUNT(*) AS count FROM lifecycle_signals WHERE handoff_key = ?
    `);
    this.findSignalsStmt = db.prepare(`
      SELECT signal_id, handoff_key, persona, version, type, context, payload, occurred_at, created_at
      FROM lifecycle_signals
      WHERE handoff_key = ?
    `);
  }

  handoff(input: LifecycleSignalHandoffInput): Result<void, DbError> {
    const signals = this.parseSignals(input.signals);
    if (!signals || input.persona.length === 0) {
      return err(new DbError('Failed to persist lifecycle signal handoff: invalid signal handoff'));
    }
    try {
      const write = this.db.transaction(() => {
        const existing = this.findHandoffStmt.get(input.idempotencyKey) as
          | { event_id: string; handler_id: string; persona: string }
          | undefined;
        if (existing) {
          if (!sameHandoff(existing, input)) {
            throw new Error('lifecycle signal handoff idempotency key collision');
          }
          const count = this.countSignalsStmt.get(input.idempotencyKey) as { count: number };
          if (count.count !== signals.length) {
            throw new Error('lifecycle signal handoff is incomplete');
          }
          const rows = this.findSignalsStmt.all(input.idempotencyKey) as LifecycleSignalRow[];
          if (!sameSignals(rows, signals)) {
            throw new Error('lifecycle signal handoff content mismatch');
          }
          return;
        }
        const createdAt = this.now();
        this.insertHandoffStmt.run({
          idempotency_key: input.idempotencyKey,
          event_id: input.eventId,
          handler_id: input.handlerId,
          persona: input.persona,
          created_at: createdAt,
        });
        for (const signal of signals) {
          this.insertSignalStmt.run({
            signal_id: signal.signalId,
            handoff_key: input.idempotencyKey,
            persona: input.persona,
            version: signal.version,
            type: signal.type,
            context: JSON.stringify(signal.context),
            payload: JSON.stringify(signal.payload),
            occurred_at: signal.occurredAt,
            created_at: createdAt,
          });
        }
      });
      write();
      return ok(undefined);
    } catch {
      return err(new DbError('Failed to persist lifecycle signal handoff'));
    }
  }

  private parseSignals(signals: readonly unknown[]): LifecycleSignalEnvelope[] | undefined {
    if (signals.length > 32) return undefined;
    const parsed: LifecycleSignalEnvelope[] = [];
    const ids = new Set<string>();
    for (const signal of signals) {
      const candidate = LifecycleSignalEnvelopeSchema.safeParse(signal);
      if (!candidate.success || ids.has(candidate.data.signalId)) return undefined;
      ids.add(candidate.data.signalId);
      parsed.push(candidate.data);
    }
    return parsed;
  }
}

function sameSignals(
  rows: readonly LifecycleSignalRow[],
  signals: readonly LifecycleSignalEnvelope[],
): boolean {
  if (rows.length !== signals.length) return false;
  const rowsById = new Map(rows.map((row) => [row.signal_id, row]));
  if (rowsById.size !== rows.length) return false;

  for (const signal of signals) {
    const row = rowsById.get(signal.signalId);
    if (!row || !sameSignal(row, signal)) return false;
  }
  return true;
}

function sameSignal(row: LifecycleSignalRow, signal: LifecycleSignalEnvelope): boolean {
  if (
    row.version !== signal.version ||
    row.type !== signal.type ||
    row.occurred_at !== signal.occurredAt
  ) {
    return false;
  }

  try {
    return (
      isDeepStrictEqual(JSON.parse(row.context), toJsonValue(signal.context)) &&
      isDeepStrictEqual(JSON.parse(row.payload), toJsonValue(signal.payload))
    );
  } catch {
    return false;
  }
}

function toJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
