import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ok } from '../../../src/core/types/result.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import { registerVoiceConnector } from '../../../src/channels/channel-setup.js';
import { ChannelSendHandler } from '../../../src/tools/host-tools/channel-send.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrations = runMigrations(
    db,
    join(import.meta.dirname, '../../../src/core/database/migrations'),
  );
  if (migrations.isErr()) throw new Error(migrations.error.message);
  db.prepare(
    `INSERT INTO channels (id, type, name, config, enabled, created_at, updated_at)
     VALUES ('voice-channel', 'voice', 'browser-voice', '{}', 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, channel_id, external_id, metadata, created_at, updated_at)
     VALUES ('session-1', 'voice-channel', 'voice:session-1', ?, 1, 1)`,
  ).run(JSON.stringify({ kind: 'voice', sessionId: 'session-1' }));
  db.prepare(
    `INSERT INTO personas (id, name, model, skills, capabilities, mounts, created_at, updated_at)
     VALUES ('persona-1', 'voice-persona', 'model', '[]', '{}', '[]', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO bindings (id, channel_id, thread_id, persona_id, is_default, created_at, updated_at)
     VALUES ('binding-1', 'voice-channel', NULL, 'persona-1', 1, 1, 1)`,
  ).run();
  return db;
}

describe('channel.send through browser voice', () => {
  it('uses the registry connector and keeps normal outbound message persistence', async () => {
    const db = createDb();
    try {
      const channelRepository = new ChannelRepository(db);
      const bindingRepository = new BindingRepository(db);
      const threadRepository = new ThreadRepository(db);
      const messageRepository = new MessageRepository(db);
      const registry = new ChannelRegistry(pino({ level: 'silent' }));
      const notifications: Array<{ threadId: string; text: string }> = [];
      const registered = registerVoiceConnector({
        channelRegistry: registry,
        channelRepo: channelRepository,
        threadRepository,
        sessionService: {
          notifyThread: async (input) => {
            notifications.push(input);
            return ok({ sessionId: 'session-1', notificationId: 'message-1', speechRequested: false });
          },
        },
        logger: pino({ level: 'silent' }),
      });
      expect(registered.isOk()).toBe(true);

      const handler = new ChannelSendHandler({
        channelRegistry: registry,
        channelRepository,
        messageRepository,
        bindingRepository,
        threadRepository,
        logger: pino({ level: 'silent' }),
      });
      const sent = await handler.execute(
        { channelId: 'browser-voice', content: 'A durable background update.' },
        { runId: 'run-1', threadId: 'session-1', personaId: 'persona-1', requestId: 'request-1' },
      );

      expect(sent.status).toBe('success');
      expect(notifications).toEqual([
        { threadId: 'session-1', text: 'A durable background update.' },
      ]);
      const rows = messageRepository.findByThread('session-1', 10, 0)._unsafeUnwrap();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].content)).toEqual({ body: 'A durable background update.' });
    } finally {
      db.close();
    }
  });
});
