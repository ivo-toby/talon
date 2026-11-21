import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  MessageRefRepository,
  MESSAGE_REF_EXCERPT_MAX_CHARS,
} from '../../../../../src/core/database/repositories/message-ref-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('MessageRefRepository', () => {
  let db: Database.Database;
  let repo: MessageRefRepository;
  let threads: ThreadRepository;
  let channelId: string;

  function makeChannel(): string {
    const id = uuid();
    new ChannelRepository(db).insert({
      id,
      type: 'telegram',
      name: `ch-${id}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    return id;
  }

  function makeThread(externalId: string, channel: string = channelId): string {
    const id = uuid();
    const inserted = threads.insert({
      id,
      channel_id: channel,
      external_id: externalId,
      metadata: '{}',
    });
    expect(inserted.isOk()).toBe(true);
    return id;
  }

  beforeEach(() => {
    db = createTestDb();
    repo = new MessageRefRepository(db);
    threads = new ThreadRepository(db);
    channelId = makeChannel();
  });

  afterEach(() => {
    db.close();
  });

  describe('record / find', () => {
    it('stores a ref and finds it by thread and external id', () => {
      const threadId = makeThread('chat-1');
      const recorded = repo.record({
        thread_id: threadId,
        external_id: '4521',
        direction: 'outbound',
        message_id: 'msg-1',
        text: 'Shall I book it?',
      });
      expect(recorded.isOk()).toBe(true);

      const found = repo.find(threadId, '4521')._unsafeUnwrap();
      expect(found).toMatchObject({
        thread_id: threadId,
        external_id: '4521',
        direction: 'outbound',
        message_id: 'msg-1',
        sender_id: null,
        excerpt: 'Shall I book it?',
      });
      expect(found?.created_at).toBeGreaterThan(0);
    });

    it('returns null for an unknown external id and for another thread', () => {
      const threadId = makeThread('chat-1');
      const otherThread = makeThread('chat-2');
      repo.record({ thread_id: threadId, external_id: '1', direction: 'inbound' });

      expect(repo.find(threadId, 'nope')._unsafeUnwrap()).toBeNull();
      expect(repo.find(otherThread, '1')._unsafeUnwrap()).toBeNull();
    });

    it('defaults message_id and sender_id to null and the excerpt to empty', () => {
      const threadId = makeThread('chat-1');
      repo.record({ thread_id: threadId, external_id: '9', direction: 'inbound' });
      expect(repo.find(threadId, '9')._unsafeUnwrap()).toMatchObject({
        message_id: null,
        sender_id: null,
        excerpt: '',
      });
    });

    it('never overwrites an existing ref (first record wins)', () => {
      const threadId = makeThread('chat-1');
      repo.record({
        thread_id: threadId,
        external_id: '7',
        direction: 'inbound',
        sender_id: 'alice',
        text: 'original',
      });
      const again = repo.record({
        thread_id: threadId,
        external_id: '7',
        direction: 'outbound',
        text: 'replacement',
      });
      expect(again.isOk()).toBe(true);
      expect(repo.find(threadId, '7')._unsafeUnwrap()).toMatchObject({
        direction: 'inbound',
        sender_id: 'alice',
        excerpt: 'original',
      });
    });

    it('truncates the stored excerpt to the bound', () => {
      const threadId = makeThread('chat-1');
      repo.record({
        thread_id: threadId,
        external_id: '8',
        direction: 'outbound',
        text: 'x'.repeat(MESSAGE_REF_EXCERPT_MAX_CHARS + 500),
      });
      expect(repo.find(threadId, '8')._unsafeUnwrap()?.excerpt).toHaveLength(
        MESSAGE_REF_EXCERPT_MAX_CHARS,
      );
    });

    it('returns err when the thread does not exist (FK)', () => {
      const result = repo.record({ thread_id: uuid(), external_id: '1', direction: 'inbound' });
      expect(result.isErr()).toBe(true);
    });

    it('removes refs when their thread is deleted', () => {
      const threadId = makeThread('chat-1');
      repo.record({ thread_id: threadId, external_id: '1', direction: 'inbound' });
      db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
      expect(repo.find(threadId, '1')._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findInChat', () => {
    it('finds a ref on the thread whose external id is the chat', () => {
      const threadId = makeThread('-100123');
      repo.record({ thread_id: threadId, external_id: '55', direction: 'outbound' });
      expect(repo.findInChat(channelId, '-100123', '55')._unsafeUnwrap()?.thread_id).toBe(threadId);
    });

    it('finds a ref on a topic sub-thread of the chat', () => {
      makeThread('-100123');
      const topicThread = makeThread('-100123:42');
      repo.record({ thread_id: topicThread, external_id: '77', direction: 'outbound' });
      expect(repo.findInChat(channelId, '-100123', '77')._unsafeUnwrap()?.thread_id).toBe(
        topicThread,
      );
    });

    it('does not match a different chat that merely shares a prefix', () => {
      const lookalike = makeThread('-1001234');
      repo.record({ thread_id: lookalike, external_id: '77', direction: 'outbound' });
      expect(repo.findInChat(channelId, '-100123', '77')._unsafeUnwrap()).toBeNull();
    });

    it('treats LIKE wildcards in a chat id literally', () => {
      const literal = makeThread('a%b');
      const other = makeThread('axxb');
      repo.record({ thread_id: other, external_id: '1', direction: 'outbound' });
      expect(repo.findInChat(channelId, 'a%b', '1')._unsafeUnwrap()).toBeNull();
      repo.record({ thread_id: literal, external_id: '1', direction: 'outbound' });
      expect(repo.findInChat(channelId, 'a%b', '1')._unsafeUnwrap()?.thread_id).toBe(literal);
    });

    it('is scoped to the channel', () => {
      const otherChannel = makeChannel();
      const foreign = makeThread('chat-1', otherChannel);
      repo.record({ thread_id: foreign, external_id: '5', direction: 'outbound' });
      expect(repo.findInChat(channelId, 'chat-1', '5')._unsafeUnwrap()).toBeNull();
      expect(repo.findInChat(otherChannel, 'chat-1', '5')._unsafeUnwrap()?.thread_id).toBe(foreign);
    });
  });

  describe('findInboundByMessageId', () => {
    it('finds the inbound ref of a stored message and ignores outbound refs', () => {
      const threadId = makeThread('chat-1');
      repo.record({
        thread_id: threadId,
        external_id: 'out-1',
        direction: 'outbound',
        message_id: 'msg-out',
      });
      repo.record({
        thread_id: threadId,
        external_id: 'in-1',
        direction: 'inbound',
        message_id: 'msg-in',
        sender_id: 'alice',
      });

      expect(repo.findInboundByMessageId('msg-in')._unsafeUnwrap()?.external_id).toBe('in-1');
      expect(repo.findInboundByMessageId('msg-out')._unsafeUnwrap()).toBeNull();
      expect(repo.findInboundByMessageId('unknown')._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findTriggerForRun', () => {
    function seedRun(options: { withMessage: boolean }): { runId: string; threadId: string } {
      const threadId = makeThread('chat-1');
      const personaId = uuid();
      const now = Date.now();
      db.prepare(
        `INSERT INTO personas (id, name, model, created_at, updated_at) VALUES (?, ?, 'm', ?, ?)`,
      ).run(personaId, `p-${personaId}`, now, now);

      let messageId: string | null = null;
      if (options.withMessage) {
        messageId = uuid();
        db.prepare(
          `INSERT INTO messages (id, thread_id, direction, content, idempotency_key, created_at)
           VALUES (?, ?, 'inbound', 'hi', ?, ?)`,
        ).run(messageId, threadId, `k-${messageId}`, now);
        repo.record({
          thread_id: threadId,
          external_id: 'tg-900',
          direction: 'inbound',
          message_id: messageId,
          sender_id: 'alice',
          text: 'hi',
        });
      }

      const queueItemId = uuid();
      db.prepare(
        `INSERT INTO queue_items (id, thread_id, message_id, type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        queueItemId,
        threadId,
        messageId,
        options.withMessage ? 'message' : 'schedule',
        now,
        now,
      );

      const runId = uuid();
      db.prepare(
        `INSERT INTO runs (id, thread_id, persona_id, status, queue_item_id, created_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      ).run(runId, threadId, personaId, queueItemId, now);
      return { runId, threadId };
    }

    it('resolves run -> queue item -> message -> inbound ref', () => {
      const { runId, threadId } = seedRun({ withMessage: true });
      expect(repo.findTriggerForRun(runId)._unsafeUnwrap()).toMatchObject({
        thread_id: threadId,
        external_id: 'tg-900',
        direction: 'inbound',
        sender_id: 'alice',
      });
    });

    it('returns null for a run whose queue item has no message', () => {
      const { runId } = seedRun({ withMessage: false });
      expect(repo.findTriggerForRun(runId)._unsafeUnwrap()).toBeNull();
    });

    it('returns null for an unknown run', () => {
      expect(repo.findTriggerForRun(uuid())._unsafeUnwrap()).toBeNull();
    });
  });
});
