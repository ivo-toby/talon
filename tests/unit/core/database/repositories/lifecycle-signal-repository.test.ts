import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  LifecycleEventRepository,
  LifecycleSignalRepository,
} from '../../../../../src/core/database/repositories/index.js';
import { createTestDb, uuid } from './helpers.js';
import { lifecycleSignalHandoffKey } from '../../../../../src/lifecycle/handler-executor.js';

describe('LifecycleSignalRepository', () => {
  let db: Database.Database;
  let events: LifecycleEventRepository;
  let signals: LifecycleSignalRepository;

  beforeEach(() => {
    db = createTestDb();
    events = new LifecycleEventRepository(db);
    signals = new LifecycleSignalRepository(db);
  });

  afterEach(() => db.close());

  it('durably persists a causally valid signal once for a stable delivery handoff', () => {
    const eventId = uuid();
    expect(
      events
        .insert({
          version: 'v1',
          eventId,
          type: 'message.persisted.v1',
          occurredAt: '2026-07-16T12:00:00.000Z',
          context: {
            aggregate: { type: 'thread', id: uuid() },
            correlationId: uuid(),
            recursion: { depth: 0, maxDepth: 4 },
            provenance: { source: 'test' },
          },
          payload: { references: [], metadata: {} },
        })
        .isOk(),
    ).toBe(true);
    const signalId = uuid();
    const input = {
      eventId,
      handlerId: 'signal-producer',
      persona: 'assistant',
      idempotencyKey: `${eventId}:signal-producer`,
      signals: [
        {
          version: 'v1',
          type: 'behavior.feedback.detected.v1',
          signalId,
          occurredAt: '2026-07-16T12:00:01.000Z',
          context: {
            aggregate: { type: 'thread', id: uuid() },
            correlationId: uuid(),
            causationId: eventId,
            recursion: { depth: 1, maxDepth: 4 },
            provenance: { source: 'subagent' },
          },
          payload: { references: [], metadata: { verdict: 'positive' } },
        },
      ],
    };

    expect(signals.handoff(input).isOk()).toBe(true);
    expect(signals.handoff(input).isOk()).toBe(true);
    expect(
      db.prepare('SELECT signal_id, persona, handoff_key FROM lifecycle_signals').all(),
    ).toEqual([{ signal_id: signalId, persona: 'assistant', handoff_key: input.idempotencyKey }]);
  });

  it('rejects an idempotency-key collision instead of crossing persona ownership', () => {
    const eventId = uuid();
    events.insert({
      version: 'v1',
      eventId,
      type: 'message.persisted.v1',
      occurredAt: '2026-07-16T12:00:00.000Z',
      context: {
        aggregate: { type: 'thread', id: uuid() },
        correlationId: uuid(),
        recursion: { depth: 0, maxDepth: 4 },
        provenance: { source: 'test' },
      },
      payload: { references: [], metadata: {} },
    });
    const input = {
      eventId,
      handlerId: 'signal-producer',
      persona: 'assistant',
      idempotencyKey: `${eventId}:signal-producer`,
      signals: [],
    };

    expect(signals.handoff(input).isOk()).toBe(true);
    expect(signals.handoff({ ...input, persona: 'other' }).isErr()).toBe(true);
  });

  it('keeps maximum contract-valid event and handler identities idempotent within the durable key bound', () => {
    const eventId = `e${'x'.repeat(255)}`;
    const handlerId = `h${'y'.repeat(127)}`;
    const idempotencyKey = lifecycleSignalHandoffKey(eventId, handlerId);
    expect(idempotencyKey.length).toBeLessThanOrEqual(256);
    expect(
      events
        .insert({
          version: 'v1',
          eventId,
          type: 'message.persisted.v1',
          occurredAt: '2026-07-16T12:00:00.000Z',
          context: {
            aggregate: { type: 'thread', id: uuid() },
            correlationId: uuid(),
            recursion: { depth: 0, maxDepth: 4 },
            provenance: { source: 'test' },
          },
          payload: { references: [], metadata: {} },
        })
        .isOk(),
    ).toBe(true);
    const handoff = { eventId, handlerId, persona: 'assistant', idempotencyKey, signals: [] };

    expect(signals.handoff(handoff).isOk()).toBe(true);
    expect(signals.handoff(handoff).isOk()).toBe(true);
    expect(signals.handoff({ ...handoff, handlerId: 'other-handler' }).isErr()).toBe(true);
  });
});
