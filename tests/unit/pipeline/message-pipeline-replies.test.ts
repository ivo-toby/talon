/**
 * MessagePipeline — native replies, reactions and the message ledger.
 *
 * Runs against a real migrated SQLite database and real repositories (only
 * the queue, router and audit logger are mocked) so the ledger schema, its
 * queries and the pipeline are exercised together.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ok } from 'neverthrow';
import pino from 'pino';
import { MessagePipeline } from '../../../src/pipeline/message-pipeline.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { MessageRefRepository } from '../../../src/core/database/repositories/message-ref-repository.js';
import type { ChannelRouter } from '../../../src/channels/channel-router.js';
import type { QueueManager } from '../../../src/queue/queue-manager.js';
import type { AuditLogger } from '../../../src/core/logging/audit-logger.js';
import type { InboundEvent } from '../../../src/channels/channel-types.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

const CHANNEL_NAME = 'tg-main';
const CHAT = '-100123';

describe('MessagePipeline — replies and reactions', () => {
  let db: Database.Database;
  let messages: MessageRepository;
  let threads: ThreadRepository;
  let refs: MessageRefRepository;
  let channelId: string;
  let enqueue: ReturnType<typeof vi.fn>;
  let resolvePersona: ReturnType<typeof vi.fn>;
  let pipeline: MessagePipeline;
  let keyCounter: number;

  function buildPipeline(withRefs: boolean): MessagePipeline {
    return new MessagePipeline(
      messages,
      threads,
      new ChannelRepository(db),
      { enqueue } as unknown as QueueManager,
      { resolvePersona } as unknown as ChannelRouter,
      { logChannelSend: vi.fn() } as unknown as AuditLogger,
      pino({ level: 'silent' }),
      null,
      withRefs ? refs : null,
    );
  }

  function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
    keyCounter += 1;
    return {
      channelType: 'telegram',
      channelName: CHANNEL_NAME,
      externalThreadId: CHAT,
      senderId: 'alice',
      idempotencyKey: `update-${keyCounter}`,
      content: 'hello',
      timestamp: 1_700_000_000_000,
      ...overrides,
    };
  }

  /** Content of the last enqueued queue item. */
  function lastEnqueued(): { threadId: string; content: string; messageId: string } {
    const call = enqueue.mock.calls.at(-1);
    expect(call).toBeDefined();
    const [threadId, , payload] = call as [string, string, { content: string; messageId: string }];
    return { threadId, content: payload.content, messageId: payload.messageId };
  }

  function threadIdFor(externalId: string): string {
    const thread = threads.findByExternalId(channelId, externalId)._unsafeUnwrap();
    expect(thread).not.toBeNull();
    return thread!.id;
  }

  /** Seeds a message Talon sent, as the agent runner would record it. */
  function seedOutbound(externalThreadId: string, externalId: string, text: string): string {
    let thread = threads.findByExternalId(channelId, externalThreadId)._unsafeUnwrap();
    if (thread === null) {
      thread = threads
        .insert({
          id: uuid(),
          channel_id: channelId,
          external_id: externalThreadId,
          metadata: '{}',
        })
        ._unsafeUnwrap();
    }
    refs
      .record({ thread_id: thread.id, external_id: externalId, direction: 'outbound', text })
      ._unsafeUnwrap();
    return thread.id;
  }

  beforeEach(() => {
    db = createTestDb();
    messages = new MessageRepository(db);
    threads = new ThreadRepository(db);
    refs = new MessageRefRepository(db);
    channelId = uuid();
    new ChannelRepository(db).insert({
      id: channelId,
      type: 'telegram',
      name: CHANNEL_NAME,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    keyCounter = 0;
    enqueue = vi.fn().mockReturnValue(ok({ id: 'queue-item-1' }));
    resolvePersona = vi.fn().mockReturnValue(ok('persona-1'));
    pipeline = buildPipeline(true);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Ledger recording
  // -------------------------------------------------------------------------

  describe('inbound ledger', () => {
    it('records an accepted message under its provider message id', async () => {
      const result = await pipeline.handleInboundEvent(
        makeEvent({ externalMessageId: '900', content: 'book a table' }),
      );
      expect(result._unsafeUnwrap()).toBe('enqueued');

      const ref = refs.find(threadIdFor(CHAT), '900')._unsafeUnwrap();
      expect(ref).toMatchObject({
        direction: 'inbound',
        sender_id: 'alice',
        excerpt: 'book a table',
        message_id: lastEnqueued().messageId,
      });
    });

    it('records nothing for a message without a provider message id', async () => {
      await pipeline.handleInboundEvent(makeEvent());
      const count = db.prepare('SELECT COUNT(*) AS n FROM message_refs').get() as { n: number };
      expect(count.n).toBe(0);
    });

    it('still records the message when no persona is bound', async () => {
      resolvePersona.mockReturnValue(ok(null));
      const result = await pipeline.handleInboundEvent(makeEvent({ externalMessageId: '901' }));
      expect(result._unsafeUnwrap()).toBe('no_persona');
      expect(refs.find(threadIdFor(CHAT), '901')._unsafeUnwrap()).not.toBeNull();
    });

    it('does not record a duplicate delivery a second time', async () => {
      const event = makeEvent({ externalMessageId: '902' });
      await pipeline.handleInboundEvent(event);
      const second = await pipeline.handleInboundEvent(event);
      expect(second._unsafeUnwrap()).toBe('duplicate');
      const count = db.prepare('SELECT COUNT(*) AS n FROM message_refs').get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('works without a ledger: the message is enqueued unchanged', async () => {
      pipeline = buildPipeline(false);
      const result = await pipeline.handleInboundEvent(
        makeEvent({ externalMessageId: '903', content: 'plain' }),
      );
      expect(result._unsafeUnwrap()).toBe('enqueued');
      expect(lastEnqueued().content).toBe('plain');
    });
  });

  // -------------------------------------------------------------------------
  // Reply context
  // -------------------------------------------------------------------------

  describe('reply context', () => {
    it("prefixes a reply to one of Talon's messages, resolved from the ledger", async () => {
      seedOutbound(CHAT, '4521', 'Shall I book the 14:00 slot?');

      await pipeline.handleInboundEvent(
        makeEvent({
          content: 'yes please',
          externalMessageId: '4522',
          replyTo: { externalMessageId: '4521' },
        }),
      );

      expect(lastEnqueued().content).toBe(
        '[Replying to your message (id 4521): "Shall I book the 14:00 slot?"]\nyes please',
      );
    });

    it('stores the header in the durable message and the original text in the ledger', async () => {
      seedOutbound(CHAT, '4521', 'Shall I book it?');
      await pipeline.handleInboundEvent(
        makeEvent({
          content: 'yes',
          externalMessageId: '4522',
          replyTo: { externalMessageId: '4521' },
        }),
      );

      const stored = messages.findById(lastEnqueued().messageId)._unsafeUnwrap();
      expect(stored?.content).toBe('[Replying to your message (id 4521): "Shall I book it?"]\nyes');
      expect(refs.find(threadIdFor(CHAT), '4522')._unsafeUnwrap()?.excerpt).toBe('yes');
    });

    it('prefers the quote the connector delivered over the ledger excerpt', async () => {
      seedOutbound(CHAT, '10', 'Option A is cheaper. Option B is faster.');
      await pipeline.handleInboundEvent(
        makeEvent({
          content: 'this one',
          replyTo: { externalMessageId: '10', text: 'Option B is faster.' },
        }),
      );
      expect(lastEnqueued().content).toBe(
        '[Replying to your message (id 10): "Option B is faster."]\nthis one',
      );
    });

    it('trusts the ledger over the connector for who sent the target', async () => {
      // A WhatsApp Web account is shared with its owner: only a recorded
      // outbound message is known to be Talon's.
      const first = makeEvent({ content: 'my own note', externalMessageId: '20' });
      await pipeline.handleInboundEvent(first);

      await pipeline.handleInboundEvent(
        makeEvent({
          content: 'see above',
          replyTo: { externalMessageId: '20', fromSelf: true },
        }),
      );
      expect(lastEnqueued().content).toBe(
        '[Replying to their own earlier message (id 20): "my own note"]\nsee above',
      );
    });

    it("names another participant when the target is someone else's message", async () => {
      await pipeline.handleInboundEvent(
        makeEvent({ senderId: 'bob', content: 'lunch at 12?', externalMessageId: '30' }),
      );
      await pipeline.handleInboundEvent(
        makeEvent({ senderId: 'alice', content: 'ok', replyTo: { externalMessageId: '30' } }),
      );
      expect(lastEnqueued().content).toBe(
        '[Replying to a message from bob (id 30): "lunch at 12?"]\nok',
      );
    });

    it('renders a target the ledger does not know from the connector data alone', async () => {
      await pipeline.handleInboundEvent(
        makeEvent({
          content: 'what about this?',
          replyTo: { externalMessageId: '1', fromSelf: true, text: 'old message' },
        }),
      );
      expect(lastEnqueued().content).toBe(
        '[Replying to your message (id 1): "old message"]\nwhat about this?',
      );
    });

    it('renders an unknown target with no data as "an earlier message"', async () => {
      await pipeline.handleInboundEvent(
        makeEvent({ content: 'and this?', replyTo: { externalMessageId: 'wamid.X' } }),
      );
      expect(lastEnqueued().content).toBe(
        '[Replying to an earlier message (id wamid.X)]\nand this?',
      );
    });

    it('adds a target the ledger did not know, so the id shown in the header is usable', async () => {
      await pipeline.handleInboundEvent(
        makeEvent({
          content: 'what about this?',
          replyTo: {
            externalMessageId: '1',
            senderId: 'bot-9',
            fromSelf: true,
            text: 'old message',
          },
        }),
      );
      expect(refs.find(threadIdFor(CHAT), '1')._unsafeUnwrap()).toMatchObject({
        direction: 'outbound',
        message_id: null,
        sender_id: null,
        excerpt: 'old message',
      });
    });

    it("records an unknown target as inbound unless the provider says it is Talon's", async () => {
      await pipeline.handleInboundEvent(
        makeEvent({
          content: 'and this?',
          replyTo: { externalMessageId: 'wamid.X', senderId: 'bob' },
        }),
      );
      expect(refs.find(threadIdFor(CHAT), 'wamid.X')._unsafeUnwrap()).toMatchObject({
        direction: 'inbound',
        sender_id: 'bob',
        excerpt: '',
      });
    });

    it('never overwrites a target the ledger already knows', async () => {
      seedOutbound(CHAT, '4521', 'the original text');
      await pipeline.handleInboundEvent(
        makeEvent({
          content: 'ok',
          replyTo: { externalMessageId: '4521', senderId: 'someone', text: 'a partial quote' },
        }),
      );
      expect(refs.find(threadIdFor(CHAT), '4521')._unsafeUnwrap()).toMatchObject({
        direction: 'outbound',
        sender_id: null,
        excerpt: 'the original text',
      });
    });

    it('leaves a message without a reply untouched', async () => {
      await pipeline.handleInboundEvent(makeEvent({ content: 'no reply here' }));
      expect(lastEnqueued().content).toBe('no reply here');
    });
  });

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  describe('reactions', () => {
    function reactionEvent(
      targetMessageId: string,
      emoji: string,
      chat: string = CHAT,
    ): InboundEvent {
      return makeEvent({
        externalThreadId: chat,
        content: '',
        reaction: { targetMessageId, emoji },
      });
    }

    it("forwards a reaction on one of Talon's messages as a message on that thread", async () => {
      const threadId = seedOutbound(CHAT, '4521', 'Shall I book the 14:00 slot?');

      const result = await pipeline.handleInboundEvent(reactionEvent('4521', '👍'));
      expect(result._unsafeUnwrap()).toBe('enqueued');

      const enqueued = lastEnqueued();
      expect(enqueued.threadId).toBe(threadId);
      expect(enqueued.content.split('\n')[0]).toBe(
        '[Reaction: the user reacted with 👍 to your message (id 4521): "Shall I book the 14:00 slot?"]',
      );
      expect(enqueued.content).toContain('NO_REPLY');

      const stored = messages.findById(enqueued.messageId)._unsafeUnwrap();
      expect(stored).toMatchObject({
        thread_id: threadId,
        direction: 'inbound',
        provider_id: 'alice',
        content: enqueued.content,
      });
    });

    it('resolves a reaction to the topic thread the message lives in', async () => {
      const topicThread = seedOutbound(`${CHAT}:42`, '77', 'Deployed.');
      const result = await pipeline.handleInboundEvent(reactionEvent('77', '🎉'));
      expect(result._unsafeUnwrap()).toBe('enqueued');
      expect(lastEnqueued().threadId).toBe(topicThread);
    });

    it('ignores a reaction on a message Talon did not send', async () => {
      await pipeline.handleInboundEvent(
        makeEvent({ externalMessageId: '50', content: 'user text' }),
      );
      enqueue.mockClear();

      const result = await pipeline.handleInboundEvent(reactionEvent('50', '👍'));
      expect(result._unsafeUnwrap()).toBe('ignored');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('ignores a reaction on a message the ledger has never seen', async () => {
      const result = await pipeline.handleInboundEvent(reactionEvent('99999', '👍'));
      expect(result._unsafeUnwrap()).toBe('ignored');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('never creates a thread for a reaction', async () => {
      await pipeline.handleInboundEvent(reactionEvent('1', '👍', 'brand-new-chat'));
      expect(threads.findByExternalId(channelId, 'brand-new-chat')._unsafeUnwrap()).toBeNull();
    });

    it('ignores a removed reaction', async () => {
      seedOutbound(CHAT, '4521', 'text');
      const result = await pipeline.handleInboundEvent(reactionEvent('4521', ''));
      expect(result._unsafeUnwrap()).toBe('ignored');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('ignores a reaction from another chat that reuses the same message id', async () => {
      seedOutbound(CHAT, '4521', 'text');
      const result = await pipeline.handleInboundEvent(reactionEvent('4521', '👍', '-100999'));
      expect(result._unsafeUnwrap()).toBe('ignored');
    });

    it('deduplicates a redelivered reaction', async () => {
      seedOutbound(CHAT, '4521', 'text');
      const event = reactionEvent('4521', '👍');
      expect((await pipeline.handleInboundEvent(event))._unsafeUnwrap()).toBe('enqueued');
      expect((await pipeline.handleInboundEvent(event))._unsafeUnwrap()).toBe('duplicate');
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('persists but does not enqueue a reaction on a thread without a persona', async () => {
      seedOutbound(CHAT, '4521', 'text');
      resolvePersona.mockReturnValue(ok(null));
      const result = await pipeline.handleInboundEvent(reactionEvent('4521', '👍'));
      expect(result._unsafeUnwrap()).toBe('no_persona');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('ignores every reaction when there is no ledger', async () => {
      seedOutbound(CHAT, '4521', 'text');
      pipeline = buildPipeline(false);
      const result = await pipeline.handleInboundEvent(reactionEvent('4521', '👍'));
      expect(result._unsafeUnwrap()).toBe('ignored');
    });

    it('does not record a ledger ref for the reaction itself', async () => {
      seedOutbound(CHAT, '4521', 'text');
      await pipeline.handleInboundEvent(reactionEvent('4521', '👍'));
      const count = db.prepare('SELECT COUNT(*) AS n FROM message_refs').get() as { n: number };
      expect(count.n).toBe(1);
    });
  });
});
