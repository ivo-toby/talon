/**
 * Schedule runs reach the memory of the conversation they serve: the origin
 * resolver plus memory.access and db.query on a real migrated SQLite DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../core/database/repositories/helpers.js';
import { BaseRepository } from '../../../src/core/database/repositories/base-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { resolveScheduleOriginThread } from '../../../src/daemon/schedule-origin.js';
import { MemoryAccessHandler } from '../../../src/tools/host-tools/memory-access.js';
import { DbQueryHandler } from '../../../src/tools/host-tools/db-query.js';
import type { ToolExecutionContext } from '../../../src/tools/host-tools/channel-send.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

describe('schedule origin conversation', () => {
  let db: Database.Database;
  let threads: ThreadRepository;
  let bindings: BindingRepository;
  let memory: MemoryRepository;

  const CHANNEL = 'chan-1';
  const PERSONA = 'assistant';
  const OTHER = 'reviewer';
  const CHAT = 'chat-thread';
  const SCHEDULE = 'schedule-thread';

  const scheduleThread = {
    channel_id: CHANNEL,
    metadata: JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
  };
  const deps = () => ({ threadRepository: threads, bindingRepository: bindings });

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    threads = new ThreadRepository(db);
    bindings = new BindingRepository(db);
    memory = new MemoryRepository(db);
    new ChannelRepository(db).insert({
      id: CHANNEL,
      type: 'telegram',
      name: 'telegram-main',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    const personas = new PersonaRepository(db);
    for (const id of [PERSONA, OTHER]) {
      personas.insert({
        id,
        name: id,
        model: 'm',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      });
    }
    threads.insert({ id: CHAT, channel_id: CHANNEL, external_id: 'chat-42', metadata: '{}' });
    threads.insert({
      id: SCHEDULE,
      channel_id: CHANNEL,
      external_id: 'schedule:assistant:telegram-main:chat-42',
      metadata: scheduleThread.metadata,
    });
  });

  afterEach(() => {
    db.close();
  });

  function bindDefault(personaId: string): void {
    bindings.insert({
      id: `d-${personaId}`,
      channel_id: CHANNEL,
      thread_id: null,
      persona_id: personaId,
      is_default: 1,
    });
  }

  describe('resolveScheduleOriginThread', () => {
    it('resolves the chat when the channel default routes it to the same persona', () => {
      bindDefault(PERSONA);
      const resolved = resolveScheduleOriginThread(deps(), scheduleThread, PERSONA)._unsafeUnwrap();
      expect(resolved.thread?.id).toBe(CHAT);
    });

    it('lets a thread-scoped binding decide over the channel default', () => {
      bindDefault(PERSONA);
      bindings.insert({
        id: 'scoped',
        channel_id: CHANNEL,
        thread_id: CHAT,
        persona_id: OTHER,
        is_default: 0,
      });
      const resolved = resolveScheduleOriginThread(deps(), scheduleThread, PERSONA)._unsafeUnwrap();
      expect(resolved).toEqual({ thread: null, reason: 'persona_mismatch' });
      expect(
        resolveScheduleOriginThread(deps(), scheduleThread, OTHER)._unsafeUnwrap().thread?.id,
      ).toBe(CHAT);
    });

    it('refuses a chat routed to another persona or not routed at all', () => {
      expect(resolveScheduleOriginThread(deps(), scheduleThread, PERSONA)._unsafeUnwrap()).toEqual({
        thread: null,
        reason: 'persona_mismatch',
      });
      bindDefault(OTHER);
      expect(resolveScheduleOriginThread(deps(), scheduleThread, PERSONA)._unsafeUnwrap()).toEqual({
        thread: null,
        reason: 'persona_mismatch',
      });
    });

    it('reports a missing origin thread and ignores threads without schedule metadata', () => {
      bindDefault(PERSONA);
      const gone = {
        channel_id: CHANNEL,
        metadata: JSON.stringify({ kind: 'schedule', originExternalId: 'chat-never-spoke' }),
      };
      expect(resolveScheduleOriginThread(deps(), gone, PERSONA)._unsafeUnwrap()).toEqual({
        thread: null,
        reason: 'origin_thread_missing',
      });
      expect(
        resolveScheduleOriginThread(
          deps(),
          { channel_id: CHANNEL, metadata: '{}' },
          PERSONA,
        )._unsafeUnwrap(),
      ).toEqual({ thread: null, reason: 'not_schedule_thread' });
    });
  });

  describe('tools on a schedule run with an origin', () => {
    const scheduleContext: ToolExecutionContext = {
      runId: 'run-1',
      threadId: SCHEDULE,
      personaId: PERSONA,
      requestId: 'req-1',
      originThreadId: CHAT,
      scheduleRun: true,
    };

    beforeEach(() => {
      memory.insert({
        id: 'chat-note',
        thread_id: CHAT,
        type: 'note',
        content: 'Ivo prefers short answers',
        embedding_ref: null,
        metadata: '{}',
      });
      memory.insert({
        id: 'schedule-note',
        thread_id: SCHEDULE,
        type: 'note',
        content: 'schedule bookkeeping',
        embedding_ref: null,
        metadata: '{}',
      });
      threads.insert({
        id: 'unrelated-thread-id',
        channel_id: CHANNEL,
        external_id: 'chat-99',
        metadata: '{}',
      });
      memory.insert({
        id: 'elsewhere',
        thread_id: 'unrelated-thread-id',
        type: 'note',
        content: 'not yours',
        embedding_ref: null,
        metadata: '{}',
      });
      expect(memory.findById('unrelated-thread-id', 'elsewhere')._unsafeUnwrap()).not.toBeNull();
    });

    it('memory.access keeps a schedule on its own state by default', async () => {
      const handler = new MemoryAccessHandler({ memoryRepository: memory, logger: makeLogger() });

      const listed = await handler.execute({ operation: 'list' }, scheduleContext);
      expect(JSON.stringify(listed.result)).toContain('schedule bookkeeping');
      expect(JSON.stringify(listed.result)).not.toContain('Ivo prefers short answers');

      await handler.execute(
        { operation: 'write', key: 'heartbeat:sent', value: 'x' },
        scheduleContext,
      );
      expect(memory.findById(SCHEDULE, 'heartbeat:sent')._unsafeUnwrap()).not.toBeNull();
      expect(memory.findById(CHAT, 'heartbeat:sent')._unsafeUnwrap()).toBeNull();
    });

    it('memory.access with scope "conversation" lists, writes and deletes on the chat', async () => {
      const handler = new MemoryAccessHandler({ memoryRepository: memory, logger: makeLogger() });

      const listed = await handler.execute(
        { operation: 'list', scope: 'conversation' },
        scheduleContext,
      );
      expect(listed.status).toBe('success');
      expect(JSON.stringify(listed.result)).toContain('Ivo prefers short answers');
      expect(JSON.stringify(listed.result)).not.toContain('schedule bookkeeping');

      await handler.execute(
        { operation: 'write', key: 'groomed', value: 'merged', scope: 'conversation' },
        scheduleContext,
      );
      expect(memory.findById(CHAT, 'groomed')._unsafeUnwrap()?.content).toContain('merged');
      expect(memory.findById(SCHEDULE, 'groomed')._unsafeUnwrap()).toBeNull();

      await handler.execute(
        { operation: 'delete', key: 'chat-note', scope: 'conversation' },
        scheduleContext,
      );
      expect(memory.findById(CHAT, 'chat-note')._unsafeUnwrap()).toBeNull();
    });

    it('refuses scope "conversation" for a schedule without an origin', async () => {
      const handler = new MemoryAccessHandler({ memoryRepository: memory, logger: makeLogger() });
      const { originThreadId: _omit, ...noOrigin } = scheduleContext;

      const result = await handler.execute({ operation: 'list', scope: 'conversation' }, noOrigin);

      expect(result.status).toBe('error');
      expect(result.error).toContain('no origin conversation');
      expect(result.error).toContain('set-schedule-origin');
    });

    it('treats scope "conversation" on a chat run as the chat itself, and rejects unknown scopes', async () => {
      const handler = new MemoryAccessHandler({ memoryRepository: memory, logger: makeLogger() });
      const chatRun: ToolExecutionContext = { runId: 'r', threadId: CHAT, personaId: PERSONA };

      const listed = await handler.execute({ operation: 'list', scope: 'conversation' }, chatRun);
      expect(JSON.stringify(listed.result)).toContain('Ivo prefers short answers');

      const bad = await handler.execute({ operation: 'list', scope: 'everything' as any }, chatRun);
      expect(bad.status).toBe('error');
    });

    it('db.query reads the schedule thread and the chat, nothing else', async () => {
      const handler = new DbQueryHandler({ db, logger: makeLogger() });

      const result = await handler.execute(
        { sql: 'SELECT id, thread_id FROM memory_items ORDER BY id' },
        scheduleContext,
      );

      expect(result.status).toBe('success');
      const ids = (result.result as { rows: unknown[][] }).rows.map((r) => r[0]);
      expect(ids).toEqual(['chat-note', 'schedule-note']);
    });
  });
});
