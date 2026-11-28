/**
 * channel.react against the real message ledger.
 *
 * Wires the real MessagePipeline, QueueManager and repositories over a
 * migrated SQLite database, so the path "inbound message → queue item → run →
 * channel.react" is exercised with the data the daemon actually writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ok } from 'neverthrow';
import pino from 'pino';
import { MessagePipeline } from '../../../../src/pipeline/message-pipeline.js';
import { QueueManager } from '../../../../src/queue/queue-manager.js';
import { ChannelReactHandler } from '../../../../src/tools/host-tools/channel-react.js';
import { MessageRepository } from '../../../../src/core/database/repositories/message-repository.js';
import { ThreadRepository } from '../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../src/core/database/repositories/channel-repository.js';
import { QueueRepository } from '../../../../src/core/database/repositories/queue-repository.js';
import { MessageRefRepository } from '../../../../src/core/database/repositories/message-ref-repository.js';
import type { ChannelRouter } from '../../../../src/channels/channel-router.js';
import type { ChannelRegistry } from '../../../../src/channels/channel-registry.js';
import type { AuditLogger } from '../../../../src/core/logging/audit-logger.js';
import type { InboundEvent } from '../../../../src/channels/channel-types.js';
import { createTestDb, uuid } from '../../core/database/repositories/helpers.js';

const CHANNEL_NAME = 'tg-main';
const CHAT = '8001';

describe('channel.react with the real ledger', () => {
  let db: Database.Database;
  let threads: ThreadRepository;
  let channels: ChannelRepository;
  let refs: MessageRefRepository;
  let queue: QueueManager;
  let pipeline: MessagePipeline;
  let react: ReturnType<typeof vi.fn>;
  let handler: ChannelReactHandler;
  let channelId: string;
  let personaId: string;
  let updateId: number;

  /** Delivers a user message and returns the id of the run that answers it. */
  async function deliver(telegramMessageId: string, content: string): Promise<string> {
    updateId += 1;
    const event: InboundEvent = {
      channelType: 'telegram',
      channelName: CHANNEL_NAME,
      externalThreadId: CHAT,
      senderId: 'alice',
      // Telegram's idempotency key is the update_id, NOT the message_id.
      idempotencyKey: String(900_000 + updateId),
      externalMessageId: telegramMessageId,
      content,
      timestamp: 1_700_000_000_000,
    };
    const result = await pipeline.handleInboundEvent(event);
    expect(result._unsafeUnwrap()).toBe('enqueued');

    const item = db
      .prepare('SELECT id, thread_id FROM queue_items ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as { id: string; thread_id: string };
    const runId = uuid();
    db.prepare(
      `INSERT INTO runs (id, thread_id, persona_id, status, queue_item_id, created_at)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    ).run(runId, item.thread_id, personaId, item.id, Date.now());
    return runId;
  }

  function threadId(): string {
    return threads.findByExternalId(channelId, CHAT)._unsafeUnwrap()!.id;
  }

  function context(runId: string) {
    return { runId, threadId: threadId(), personaId, requestId: 'req-1' };
  }

  beforeEach(() => {
    db = createTestDb();
    threads = new ThreadRepository(db);
    channels = new ChannelRepository(db);
    refs = new MessageRefRepository(db);
    const logger = pino({ level: 'silent' });

    channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: CHANNEL_NAME,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    personaId = uuid();
    db.prepare(
      `INSERT INTO personas (id, name, model, created_at, updated_at) VALUES (?, 'assistant', 'm', ?, ?)`,
    ).run(personaId, Date.now(), Date.now());

    queue = new QueueManager(
      new QueueRepository(db),
      threads,
      { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60000, concurrencyLimit: 1 },
      logger,
    );
    pipeline = new MessagePipeline(
      new MessageRepository(db),
      threads,
      channels,
      queue,
      { resolvePersona: vi.fn().mockReturnValue(ok(personaId)) } as unknown as ChannelRouter,
      { logChannelSend: vi.fn() } as unknown as AuditLogger,
      logger,
      null,
      refs,
    );

    react = vi.fn().mockResolvedValue(ok(undefined));
    handler = new ChannelReactHandler({
      channelRegistry: {
        get: vi.fn(() => ({ type: 'telegram', name: CHANNEL_NAME, react })),
      } as unknown as ChannelRegistry,
      threadRepository: threads,
      channelRepository: channels,
      messageRefRepository: refs,
      logger,
    });
    updateId = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('reacts to the message that started the run, by its Telegram message id', async () => {
    const runId = await deliver('4522', 'onthoud dat ik morgen naar de tandarts moet');

    const result = await handler.execute({ emoji: '👍' }, context(runId));

    expect(result.status).toBe('success');
    expect(react).toHaveBeenCalledWith(
      CHAT,
      expect.objectContaining({ externalMessageId: '4522', fromSelf: false, author: 'alice' }),
      '👍',
    );
  });

  it('refuses a Telegram update_id read from the messages table and lists the real ids', async () => {
    // The reported failure: the agent looked the id up in the database, found
    // the delivery key (an update_id), and Telegram answered "message to
    // react not found".
    const runId = await deliver('4522', 'zet hier een duimpje op');
    const stored = db
      .prepare(`SELECT idempotency_key FROM messages WHERE direction = 'inbound'`)
      .get() as { idempotency_key: string };
    const updateIdFromDb = stored.idempotency_key.split(':').pop()!;
    expect(updateIdFromDb).toBe('900001');

    const result = await handler.execute(
      { emoji: '👍', messageId: updateIdFromDb },
      context(runId),
    );

    expect(result.status).toBe('error');
    expect(react).not.toHaveBeenCalled();
    expect(result.error).toContain('id 4522 — alice: "zet hier een duimpje op"');
  });

  it('accepts the stored message id (messages.id) an agent can read from the database', async () => {
    const runId = await deliver('4522', 'eerste');
    const stored = db.prepare(`SELECT id FROM messages WHERE direction = 'inbound'`).get() as {
      id: string;
    };

    const result = await handler.execute({ emoji: '👍', messageId: stored.id }, context(runId));

    expect(result.status).toBe('success');
    expect(react.mock.calls[0][1]).toMatchObject({ externalMessageId: '4522' });
  });

  it('lists earlier user and Talon messages so an older one can be targeted', async () => {
    await deliver('4520', 'eerste bericht');
    refs.record({
      thread_id: threadId(),
      external_id: '4521',
      direction: 'outbound',
      text: 'antwoord van Talon',
    });
    const runId = await deliver('4522', 'zet een duimpje op mijn eerste bericht');

    const listing = await handler.execute({ list: true }, context(runId));
    expect(listing.result).toEqual({
      messages: [
        { messageId: '4522', from: 'alice', text: 'zet een duimpje op mijn eerste bericht' },
        { messageId: '4521', from: 'you', text: 'antwoord van Talon' },
        { messageId: '4520', from: 'alice', text: 'eerste bericht' },
      ],
    });

    const result = await handler.execute({ emoji: '👍', messageId: '4520' }, context(runId));
    expect(result.status).toBe('success');
    expect(react.mock.calls[0][1]).toMatchObject({ externalMessageId: '4520', author: 'alice' });
  });

  it('can react to a pre-ledger message once a reply header has shown its id', async () => {
    // The bot message 4000 was sent before the ledger existed; the user now
    // replies to it, so the agent sees "(id 4000)" in the header.
    updateId += 1;
    await pipeline.handleInboundEvent({
      channelType: 'telegram',
      channelName: CHANNEL_NAME,
      externalThreadId: CHAT,
      senderId: 'alice',
      idempotencyKey: String(900_000 + updateId),
      externalMessageId: '4522',
      content: 'dit bedoelde ik',
      replyTo: {
        externalMessageId: '4000',
        senderId: 'bot-1',
        fromSelf: true,
        text: 'oud bericht',
      },
      timestamp: 1_700_000_000_000,
    });

    const result = await handler.execute(
      { emoji: '👍', messageId: '4000' },
      { runId: uuid(), threadId: threadId(), personaId, requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(react.mock.calls[0][1]).toEqual({
      externalMessageId: '4000',
      fromSelf: true,
      text: 'oud bericht',
    });
  });

  it('targets the right message when several are queued', async () => {
    const firstRun = await deliver('4522', 'first');
    const secondRun = await deliver('4523', 'second');

    await handler.execute({ emoji: '👍' }, context(secondRun));
    await handler.execute({ emoji: '🔥' }, context(firstRun));

    expect(
      react.mock.calls.map((call) => (call[1] as { externalMessageId: string }).externalMessageId),
    ).toEqual(['4523', '4522']);
  });
});
