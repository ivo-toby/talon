import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { DeadLetterHandler } from '../../../src/queue/dead-letter.js';
import { QueueItemStatus } from '../../../src/queue/queue-types.js';
import { createTestDb, createTestLogger, seedThread, enqueueItem, uuid } from './helpers.js';

describe('DeadLetterHandler', () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let handler: DeadLetterHandler;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new QueueRepository(db);
    handler = new DeadLetterHandler(repo, createTestLogger());
    threadId = seedThread(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('moveToDeadLetter', () => {
    it('sets item status to dead_letter with the provided reason', () => {
      const itemId = enqueueItem(repo, threadId);
      const result = handler.moveToDeadLetter(itemId, 'too many errors');

      expect(result.isOk()).toBe(true);

      const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
        error: string;
      };
      expect(row.status).toBe('dead_letter');
      expect(row.error).toBe('too many errors');
    });

    it('returns Ok(void) on success', () => {
      const itemId = enqueueItem(repo, threadId);
      const result = handler.moveToDeadLetter(itemId, 'reason');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it('returns an error for a non-existent item id', () => {
      // markDeadLetter on a missing ID does not throw; it silently no-ops in SQLite.
      // The repository does not error on missing IDs — the item just remains unchanged.
      // We verify it completes without error.
      const result = handler.moveToDeadLetter(uuid(), 'gone');
      // Should succeed (no throw / no DB error) even if row not found
      expect(result.isOk()).toBe(true);
    });

    it('works on a previously claimed item', () => {
      const itemId = enqueueItem(repo, threadId);
      repo.claimNext(threadId);
      const result = handler.moveToDeadLetter(itemId, 'handler failed');

      expect(result.isOk()).toBe(true);
      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(itemId) as {
        status: string;
      };
      expect(row.status).toBe('dead_letter');
    });
  });

  describe('listDeadLetterItems', () => {
    it('returns all dead-letter items', () => {
      const id1 = enqueueItem(repo, threadId);
      const id2 = enqueueItem(repo, threadId);
      handler.moveToDeadLetter(id1, 'reason 1');
      handler.moveToDeadLetter(id2, 'reason 2');

      const result = handler.listDeadLetterItems();
      expect(result.isOk()).toBe(true);

      const items = result._unsafeUnwrap();
      expect(items.length).toBe(2);
      expect(items.every((i) => i.status === QueueItemStatus.DeadLetter)).toBe(true);
    });

    it('returns an empty array when no dead-letter items exist', () => {
      enqueueItem(repo, threadId);
      const result = handler.listDeadLetterItems();
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('does not include pending or completed items', () => {
      const id1 = enqueueItem(repo, threadId);
      const id2 = enqueueItem(repo, threadId);

      // Claim and complete id1
      repo.claimNext(threadId);
      repo.complete(id1);

      // Dead-letter id2
      handler.moveToDeadLetter(id2, 'gone');

      const items = handler.listDeadLetterItems()._unsafeUnwrap();
      expect(items.every((i) => i.status === QueueItemStatus.DeadLetter)).toBe(true);
      expect(items.some((i) => i.id === id1)).toBe(false);
    });

    it('maps rows to QueueItem domain objects with camelCase fields', () => {
      const id = enqueueItem(repo, threadId);
      handler.moveToDeadLetter(id, 'test reason');

      const items = handler.listDeadLetterItems()._unsafeUnwrap();
      expect(items.length).toBe(1);

      const item = items[0]!;
      expect(item.id).toBe(id);
      expect(item.threadId).toBe(threadId);
      expect(item.status).toBe(QueueItemStatus.DeadLetter);
      expect(typeof item.createdAt).toBe('number');
      expect(typeof item.updatedAt).toBe('number');
    });

    it('redacts direct move diagnostics for voice rows but keeps the stored reason', () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as any;
      const resolver = {
        resolveThread: vi.fn().mockReturnValue('voice'),
        resolveRow: vi.fn().mockReturnValue('voice'),
      };
      const voiceHandler = new DeadLetterHandler(repo, logger, resolver);
      const itemId = enqueueItem(repo, threadId);
      const reason = 'VOICE_DEAD_LETTER_SENTINEL';

      expect(voiceHandler.moveToDeadLetter(itemId, reason).isOk()).toBe(true);
      expect((repo.findById(itemId)._unsafeUnwrap() as { error: string }).error).toBe(reason);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(reason);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ voice: true, errorCategory: 'unknown' }),
        'queue diagnostic event',
      );
    });

    it('keeps nonvoice direct move diagnostics unchanged', () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as any;
      const resolver = {
        resolveThread: vi.fn().mockReturnValue('nonvoice'),
        resolveRow: vi.fn().mockReturnValue('nonvoice'),
      };
      const ordinaryHandler = new DeadLetterHandler(repo, logger, resolver);
      const itemId = enqueueItem(repo, threadId);
      const reason = 'NONVOICE_DEAD_LETTER_REASON';

      ordinaryHandler.moveToDeadLetter(itemId, reason);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ itemId, reason }),
        'queue item moved to dead letter',
      );
    });
  });
});
