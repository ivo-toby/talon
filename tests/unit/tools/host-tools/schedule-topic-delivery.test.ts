/**
 * A schedule created inside a Telegram topic must deliver back into that
 * topic.
 *
 * Real repositories over a migrated database, the real ScheduleManageHandler,
 * ChannelSendHandler and TelegramConnector; only Telegram's HTTP API is
 * stubbed. This follows the id from "schedule created in topic" all the way
 * to the `message_thread_id` Telegram receives.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { ScheduleManageHandler } from '../../../../src/tools/host-tools/schedule-manage.js';
import { ChannelSendHandler } from '../../../../src/tools/host-tools/channel-send.js';
import { TelegramConnector } from '../../../../src/channels/connectors/telegram/telegram-connector.js';
import { ChannelRegistry } from '../../../../src/channels/channel-registry.js';
import { ChannelRepository } from '../../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../../src/core/database/repositories/persona-repository.js';
import { ScheduleRepository } from '../../../../src/core/database/repositories/schedule-repository.js';
import { ThreadRepository } from '../../../../src/core/database/repositories/thread-repository.js';
import { createTestDb, uuid } from '../../core/database/repositories/helpers.js';

const CHANNEL = 'TalonMain';
const GROUP = '-1004452318413';
const TOPIC_THREAD = `${GROUP}:42`;
const DM = '8001';

describe('schedule created in a Telegram topic', () => {
  let db: Database.Database;
  let threads: ThreadRepository;
  let schedules: ScheduleRepository;
  let scheduleTool: ScheduleManageHandler;
  let sendTool: ChannelSendHandler;
  let fetchMock: ReturnType<typeof vi.fn>;
  let channelId: string;
  let personaId: string;
  const logger = pino({ level: 'silent' });

  function makeThread(externalId: string): string {
    return threads
      .insert({ id: uuid(), channel_id: channelId, external_id: externalId, metadata: '{}' })
      ._unsafeUnwrap().id;
  }

  /** Creates a schedule from `originThreadId` and returns the thread its runs execute on. */
  function createScheduleFrom(originThreadId: string): string {
    const created = scheduleTool.execute(
      { action: 'create', cronExpr: '0 9 * * *', label: 'reminder', prompt: 'remind me' },
      { runId: uuid(), threadId: originThreadId, personaId, requestId: 'req-create' },
    );
    return Promise.resolve(created).then((result) => {
      expect(result.status).toBe('success');
      const row = schedules.findByPersona(personaId)._unsafeUnwrap().at(-1)!;
      return row.thread_id as string;
    }) as unknown as string;
  }

  /** The JSON body of the sendMessage request Telegram received. */
  function lastSendBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/sendMessage')).at(-1);
    expect(call).toBeDefined();
    return JSON.parse((call![1] as { body: string }).body) as Record<string, unknown>;
  }

  beforeEach(() => {
    db = createTestDb();
    const channels = new ChannelRepository(db);
    const personas = new PersonaRepository(db);
    threads = new ThreadRepository(db);
    schedules = new ScheduleRepository(db);

    channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: CHANNEL,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    personaId = uuid();
    db.prepare(
      `INSERT INTO personas (id, name, model, created_at, updated_at) VALUES (?, 'assistant', 'm', ?, ?)`,
    ).run(personaId, Date.now(), Date.now());

    const registry = new ChannelRegistry(logger);
    registry.register(new TelegramConnector({ botToken: 'test-token' }, CHANNEL, logger));

    scheduleTool = new ScheduleManageHandler({
      scheduleRepository: schedules,
      threadRepository: threads,
      channelRepository: channels,
      personaRepository: personas,
      logger,
    });
    sendTool = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threads,
      channelRepository: channels,
      logger,
    });

    fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true, result: { message_id: 555 } }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('delivers the scheduled message into the topic it was created in', async () => {
    const scheduleThreadId = await createScheduleFrom(makeThread(TOPIC_THREAD));

    const result = await sendTool.execute(
      { channelId: CHANNEL, content: 'Time for your reminder' },
      { runId: uuid(), threadId: scheduleThreadId, personaId, requestId: 'req-fire' },
    );

    expect(result.status).toBe('success');
    expect(lastSendBody()).toMatchObject({ chat_id: GROUP, message_thread_id: 42 });
  });

  it('keeps separate schedule threads for a topic, the General chat and a private chat', async () => {
    const fromTopic = await createScheduleFrom(makeThread(TOPIC_THREAD));
    const fromGeneral = await createScheduleFrom(makeThread(GROUP));
    const fromDm = await createScheduleFrom(makeThread(DM));
    expect(new Set([fromTopic, fromGeneral, fromDm]).size).toBe(3);

    await sendTool.execute(
      { channelId: CHANNEL, content: 'general' },
      { runId: uuid(), threadId: fromGeneral, personaId, requestId: 'r1' },
    );
    expect(lastSendBody()).toMatchObject({ chat_id: GROUP });
    expect(lastSendBody()).not.toHaveProperty('message_thread_id');

    await sendTool.execute(
      { channelId: CHANNEL, content: 'dm' },
      { runId: uuid(), threadId: fromDm, personaId, requestId: 'r2' },
    );
    expect(lastSendBody()).toMatchObject({ chat_id: DM });
  });

  it('follows an explicit externalChatId away from the topic (the agent overriding the origin)', async () => {
    const scheduleThreadId = await createScheduleFrom(makeThread(TOPIC_THREAD));

    await sendTool.execute(
      { channelId: CHANNEL, content: 'x', externalChatId: DM },
      { runId: uuid(), threadId: scheduleThreadId, personaId, requestId: 'req-fire' },
    );

    expect(lastSendBody()).toMatchObject({ chat_id: DM });
    expect(lastSendBody()).not.toHaveProperty('message_thread_id');
  });
});
