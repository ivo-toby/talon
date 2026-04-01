import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('ThreadRepository', () => {
  let db: Database.Database;
  let repo: ThreadRepository;
  let channelId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new ThreadRepository(db);

    const channels = new ChannelRepository(db);
    channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeThread(overrides: Partial<Parameters<ThreadRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the thread', () => {
      const input = makeThread();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe(input.id);
    });

    it('returns err on duplicate (channel_id, external_id)', () => {
      const extId = `ext-${uuid()}`;
      repo.insert(makeThread({ external_id: extId }));
      const result = repo.insert(makeThread({ external_id: extId }));
      expect(result.isErr()).toBe(true);
    });

    it('returns err for non-existent channel_id (FK)', () => {
      expect(repo.insert(makeThread({ channel_id: uuid() })).isErr()).toBe(true);
    });
  });

  describe('findById', () => {
    it('finds by primary key', () => {
      const input = makeThread();
      repo.insert(input);
      expect(repo.findById(input.id)._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for unknown id', () => {
      expect(repo.findById(uuid())._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByExternalId', () => {
    it('finds by channel and external id', () => {
      const input = makeThread({ external_id: 'chat-123' });
      repo.insert(input);
      const result = repo.findByExternalId(channelId, 'chat-123');
      expect(result._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for unknown pair', () => {
      expect(repo.findByExternalId(uuid(), 'missing')._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByChannelId', () => {
    it('returns threads for the channel in descending updated order', () => {
      const older = makeThread({ external_id: 'chat-1' });
      const newer = makeThread({ external_id: 'chat-2' });
      repo.insert(older);
      repo.insert(newer);

      db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(100, older.id);
      db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(200, newer.id);

      const rows = repo.findByChannelId(channelId)._unsafeUnwrap();

      expect(rows.map((row) => row.external_id)).toEqual(['chat-2', 'chat-1']);
    });
  });

  describe('update', () => {
    it('updates metadata', () => {
      const input = makeThread();
      repo.insert(input);
      const result = repo.update(input.id, { metadata: '{"key":"val"}' });
      expect(result._unsafeUnwrap()?.metadata).toBe('{"key":"val"}');
    });

    it('returns null for unknown id', () => {
      expect(repo.update(uuid(), { metadata: '{}' })._unsafeUnwrap()).toBeNull();
    });

    it('returns current row when no fields given', () => {
      const input = makeThread();
      repo.insert(input);
      const result = repo.update(input.id, {});
      expect(result._unsafeUnwrap()?.id).toBe(input.id);
    });
  });
});
