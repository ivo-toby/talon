import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  GovernanceRepository,
  type GovernanceViolationRow,
  type RateLimitEventRow,
} from '../../../src/core/database/repositories/governance-repository.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('GovernanceRepository', () => {
  let db: Database.Database;
  let repo: GovernanceRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new GovernanceRepository(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  describe('recordRateLimitEvent', () => {
    it('inserts a rate limit event with the current timestamp', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000);

      const result = repo.recordRateLimitEvent({
        id: uuid(),
        channelId: 'channel-1',
        senderId: 'sender-1',
        eventType: 'message.inbound',
      });

      expect(result.isOk()).toBe(true);

      const row = db
        .prepare('SELECT * FROM rate_limit_events WHERE channel_id = ?')
        .get('channel-1') as RateLimitEventRow;

      expect(row.sender_id).toBe('sender-1');
      expect(row.event_type).toBe('message.inbound');
      expect(row.ts).toBe(1_000);
    });
  });

  describe('countRecentEvents', () => {
    it('counts recent events with optional sender scoping', () => {
      db.prepare(`
        INSERT INTO rate_limit_events (id, channel_id, sender_id, event_type, ts)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuid(), 'channel-1', 'sender-1', 'message.inbound', 4_000);
      db.prepare(`
        INSERT INTO rate_limit_events (id, channel_id, sender_id, event_type, ts)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuid(), 'channel-1', 'sender-2', 'message.inbound', 4_500);
      db.prepare(`
        INSERT INTO rate_limit_events (id, channel_id, sender_id, event_type, ts)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuid(), 'channel-1', 'sender-1', 'message.inbound', 2_000);
      db.prepare(`
        INSERT INTO rate_limit_events (id, channel_id, sender_id, event_type, ts)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuid(), 'channel-1', 'sender-1', 'message.outbound', 4_700);

      vi.spyOn(Date, 'now').mockReturnValue(5_000);

      expect(
        repo.countRecentEvents('channel-1', undefined, 'message.inbound', 1_500)._unsafeUnwrap(),
      ).toBe(2);
      expect(
        repo.countRecentEvents('channel-1', 'sender-1', 'message.inbound', 1_500)._unsafeUnwrap(),
      ).toBe(1);
    });
  });

  describe('pruneOldEvents', () => {
    it('deletes events older than the requested age threshold', () => {
      db.prepare(`
        INSERT INTO rate_limit_events (id, channel_id, sender_id, event_type, ts)
        VALUES (?, ?, ?, ?, ?)
      `).run('old-event', 'channel-1', 'sender-1', 'message.inbound', 1_000);
      db.prepare(`
        INSERT INTO rate_limit_events (id, channel_id, sender_id, event_type, ts)
        VALUES (?, ?, ?, ?, ?)
      `).run('fresh-event', 'channel-1', 'sender-1', 'message.inbound', 4_000);

      vi.spyOn(Date, 'now').mockReturnValue(5_000);

      const result = repo.pruneOldEvents(1_500);

      expect(result.isOk()).toBe(true);

      const rows = db
        .prepare('SELECT id FROM rate_limit_events ORDER BY ts ASC')
        .all() as Array<{ id: string }>;

      expect(rows).toEqual([{ id: 'fresh-event' }]);
    });
  });

  describe('recordViolation', () => {
    it('inserts a governance violation with nullable fields normalized', () => {
      vi.spyOn(Date, 'now').mockReturnValue(7_000);

      const result = repo.recordViolation({
        id: uuid(),
        personaId: 'persona-1',
        violation: 'rate_limit_exceeded',
        detail: { reason: 'sender exceeded channel threshold' },
        actionTaken: 'drop_message',
      });

      expect(result.isOk()).toBe(true);

      const row = db
        .prepare('SELECT * FROM governance_violations WHERE persona_id = ?')
        .get('persona-1') as GovernanceViolationRow;

      expect(row.thread_id).toBeNull();
      expect(row.run_id).toBeNull();
      expect(row.violation).toBe('rate_limit_exceeded');
      expect(row.detail).toBe('{"reason":"sender exceeded channel threshold"}');
      expect(row.action_taken).toBe('drop_message');
      expect(row.ts).toBe(7_000);
    });
  });

  describe('listViolations', () => {
    it('filters by persona and sinceTs, orders newest-first, and applies limit', () => {
      db.prepare(`
        INSERT INTO governance_violations
          (id, persona_id, thread_id, run_id, violation, detail, action_taken, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuid(), 'persona-1', null, null, 'first', null, 'warn', 2_000);
      db.prepare(`
        INSERT INTO governance_violations
          (id, persona_id, thread_id, run_id, violation, detail, action_taken, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuid(), 'persona-2', null, null, 'other-persona', null, 'warn', 3_000);
      db.prepare(`
        INSERT INTO governance_violations
          (id, persona_id, thread_id, run_id, violation, detail, action_taken, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuid(), 'persona-1', null, null, 'latest', null, 'block', 4_000);

      const rows = repo.listViolations({
        personaId: 'persona-1',
        sinceTs: 2_500,
        limit: 1,
      })._unsafeUnwrap();

      expect(rows).toHaveLength(1);
      expect(rows[0].violation).toBe('latest');
      expect(rows[0].action_taken).toBe('block');
    });
  });
});
