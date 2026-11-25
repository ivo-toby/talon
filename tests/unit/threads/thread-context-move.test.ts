/**
 * moveThreadContext — moving or copying memory and history between
 * conversations, against a real migrated database and a real workspace
 * directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  moveThreadContext,
  type MoveThreadContextInput,
} from '../../../src/threads/thread-context-move.js';
import { getProviderAffinityResetAt } from '../../../src/threads/thread-metadata.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import {
  formatMoveContextPlan,
  formatMoveContextResult,
} from '../../../src/cli/commands/move-context.js';
import { ContextAssembler } from '../../../src/daemon/context-assembler.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

const CHANNEL = 'TalonMain';
const MAIN = '8001';
const TOPIC = '-1004452318413:42';
const NOW = 1_800_000_000_000;

describe('moveThreadContext', () => {
  let db: Database.Database;
  let dataDir: string;
  let threads: ThreadRepository;
  let memory: MemoryRepository;
  let messages: MessageRepository;
  let channelId: string;
  let mainThreadId: string;

  function makeThread(externalId: string, channel: string = channelId, metadata = '{}'): string {
    return threads
      .insert({ id: uuid(), channel_id: channel, external_id: externalId, metadata })
      ._unsafeUnwrap().id;
  }

  function addMemory(threadId: string, id: string, type: string, content: string): void {
    db.prepare(
      `INSERT INTO memory_items (thread_id, id, type, content, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    ).run(threadId, id, type, content, 1000, 1000);
  }

  function addMessage(threadId: string, content: string, createdAt: number): string {
    const id = uuid();
    db.prepare(
      `INSERT INTO messages (id, thread_id, direction, content, idempotency_key, run_id, created_at)
       VALUES (?, ?, 'inbound', ?, ?, 'run-1', ?)`,
    ).run(id, threadId, content, `key-${id}`, createdAt);
    return id;
  }

  function markAsImageMessage(messageId: string, threadId: string): void {
    db.prepare(
      `INSERT INTO image_admission_records (message_id, thread_id, channel, reason, created_at)
       VALUES (?, ?, ?, 'no_binding', ?)`,
    ).run(messageId, threadId, CHANNEL, 2002);
  }

  function addQueueItem(threadId: string, status: string): void {
    db.prepare(
      `INSERT INTO queue_items (id, thread_id, type, status, created_at, updated_at)
       VALUES (?, ?, 'message', ?, 1, 1)`,
    ).run(uuid(), threadId, status);
  }

  function contentsOf(threadId: string): string[] {
    return messages
      .findByThread(threadId, 100, 0)
      ._unsafeUnwrap()
      .map((row) => row.content);
  }

  function memoryOf(threadId: string): string[] {
    return memory
      .findByThread(threadId)
      ._unsafeUnwrap()
      .map((row) => row.id)
      .sort();
  }

  function threadId(externalId: string): string {
    return threads.findByExternalId(channelId, externalId)._unsafeUnwrap()!.id;
  }

  function run(overrides: Partial<MoveThreadContextInput> = {}) {
    return moveThreadContext({
      db,
      from: { channel: CHANNEL, externalId: MAIN },
      to: { channel: CHANNEL, externalId: TOPIC },
      mode: 'move',
      includeMessages: true,
      dataDir,
      now: () => NOW,
      ...overrides,
    });
  }

  function writeNotebook(thread: string, name: string, content: string): void {
    const dir = path.join(dataDir, 'threads', thread, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }

  function readNotebook(thread: string, name: string): string | null {
    const file = path.join(dataDir, 'threads', thread, 'memory', name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }

  beforeEach(() => {
    db = createTestDb();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-move-context-'));
    threads = new ThreadRepository(db);
    memory = new MemoryRepository(db);
    messages = new MessageRepository(db);
    channelId = uuid();
    new ChannelRepository(db).insert({
      id: channelId,
      type: 'telegram',
      name: CHANNEL,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    mainThreadId = makeThread(MAIN);
    addMemory(mainThreadId, 'diet', 'fact', 'Ivo eats no gluten');
    addMemory(mainThreadId, 'obs-1', 'observation', 'Weekly shop is on Saturday');
    addMessage(mainThreadId, 'what should I buy?', 2000);
    addMessage(mainThreadId, 'milk and oats', 2001);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('move', () => {
    it('moves memory and history into a topic that does not exist yet', () => {
      const result = run()._unsafeUnwrap();

      expect(result).toMatchObject({
        dryRun: false,
        targetThreadCreated: true,
        memoryItems: 2,
        memoryConflicts: 0,
        messages: 2,
        messagesKeptForImages: 0,
      });
      const topic = threadId(TOPIC);
      expect(result.targetThreadId).toBe(topic);
      expect(memoryOf(topic)).toEqual(['diet', 'obs-1']);
      expect(contentsOf(topic)).toEqual(['what should I buy?', 'milk and oats']);
    });

    it('leaves the source conversation empty', () => {
      run()._unsafeUnwrap();
      expect(memoryOf(mainThreadId)).toEqual([]);
      expect(contentsOf(mainThreadId)).toEqual([]);
    });

    it('keeps message identity, order and timestamps', () => {
      const before = messages.findByThread(mainThreadId, 100, 0)._unsafeUnwrap();
      run()._unsafeUnwrap();
      const after = messages.findByThread(threadId(TOPIC), 100, 0)._unsafeUnwrap();
      expect(after.map((row) => [row.id, row.created_at, row.idempotency_key])).toEqual(
        before.map((row) => [row.id, row.created_at, row.idempotency_key]),
      );
    });

    it('makes both conversations start a fresh session', () => {
      run()._unsafeUnwrap();
      const main = threads.findById(mainThreadId)._unsafeUnwrap()!;
      const topic = threads.findByExternalId(channelId, TOPIC)._unsafeUnwrap()!;
      expect(getProviderAffinityResetAt(main.metadata)).toBe(NOW);
      expect(getProviderAffinityResetAt(topic.metadata)).toBe(NOW);
    });

    it('preserves other metadata on an existing target', () => {
      makeThread(TOPIC, channelId, JSON.stringify({ custom: 'keep-me' }));
      run()._unsafeUnwrap();
      const topic = threads.findByExternalId(channelId, TOPIC)._unsafeUnwrap()!;
      expect(JSON.parse(topic.metadata)).toMatchObject({
        custom: 'keep-me',
        providerAffinityResetAt: NOW,
      });
    });

    it('merges into a target that already has history, without touching its rows', () => {
      const topic = makeThread(TOPIC);
      addMemory(topic, 'own-note', 'note', 'topic note');
      addMessage(topic, 'already here', 1500);

      const result = run()._unsafeUnwrap();

      expect(result.targetThreadCreated).toBe(false);
      expect(result.plan.target).toMatchObject({ memoryItems: 1, messages: 1 });
      expect(memoryOf(topic)).toEqual(['diet', 'obs-1', 'own-note']);
      expect(contentsOf(topic)).toEqual(['already here', 'what should I buy?', 'milk and oats']);
    });

    it('leaves a memory item behind when the target already has that id', () => {
      const topic = makeThread(TOPIC);
      addMemory(topic, 'diet', 'fact', 'topic version');

      const result = run()._unsafeUnwrap();

      expect(result).toMatchObject({ memoryItems: 1, memoryConflicts: 1 });
      expect(memory.findById(topic, 'diet')._unsafeUnwrap()?.content).toBe('topic version');
      expect(memoryOf(mainThreadId)).toEqual(['diet']);
    });

    it('keeps a message that owns images in the source', () => {
      markAsImageMessage(addMessage(mainThreadId, 'photo of the receipt', 2002), mainThreadId);

      const result = run()._unsafeUnwrap();

      expect(result).toMatchObject({ messages: 2, messagesKeptForImages: 1 });
      expect(result.plan.source.imageMessages).toBe(1);
      expect(contentsOf(mainThreadId)).toEqual(['photo of the receipt']);
      expect(contentsOf(threadId(TOPIC))).not.toContain('photo of the receipt');
    });

    it('moves memory only when messages are excluded', () => {
      const result = run({ includeMessages: false })._unsafeUnwrap();
      expect(result).toMatchObject({ memoryItems: 2, messages: 0 });
      expect(result.plan.source.messages).toBe(0);
      expect(contentsOf(mainThreadId)).toHaveLength(2);
      expect(contentsOf(threadId(TOPIC))).toEqual([]);
    });

    it('works across channels', () => {
      const otherChannelId = uuid();
      new ChannelRepository(db).insert({
        id: otherChannelId,
        type: 'slack',
        name: 'work-slack',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      });

      run({ to: { channel: 'work-slack', externalId: 'C123' } })._unsafeUnwrap();

      const target = threads.findByExternalId(otherChannelId, 'C123')._unsafeUnwrap()!;
      expect(memoryOf(target.id)).toEqual(['diet', 'obs-1']);
    });
  });

  describe('what the agent sees afterwards', () => {
    // The real ContextAssembler builds the context of a fresh session from
    // the database, which is what the session reset forces on the next run.
    function assembledFor(thread: string): string {
      return new ContextAssembler({ messageRepo: messages, memoryRepo: memory }).assemble(
        thread,
        20,
      ).text;
    }

    it('assembles the migrated observations and history for the topic', () => {
      run()._unsafeUnwrap();
      const context = assembledFor(threadId(TOPIC));
      expect(context).toContain('Weekly shop is on Saturday');
      expect(context).toContain('what should I buy?');
      expect(context).toContain('milk and oats');
    });

    it('assembles nothing of it for the source after a move', () => {
      run()._unsafeUnwrap();
      const context = assembledFor(mainThreadId);
      expect(context).not.toContain('Weekly shop is on Saturday');
      expect(context).not.toContain('milk and oats');
    });

    it('assembles it for both conversations after a copy', () => {
      run({ mode: 'copy' })._unsafeUnwrap();
      expect(assembledFor(threadId(TOPIC))).toContain('Weekly shop is on Saturday');
      expect(assembledFor(mainThreadId)).toContain('Weekly shop is on Saturday');
    });
  });

  describe('copy', () => {
    it('gives the topic the context and leaves the source unchanged', () => {
      const result = run({ mode: 'copy' })._unsafeUnwrap();

      expect(result).toMatchObject({ memoryItems: 2, messages: 2 });
      const topic = threadId(TOPIC);
      expect(memoryOf(topic)).toEqual(['diet', 'obs-1']);
      expect(contentsOf(topic)).toEqual(['what should I buy?', 'milk and oats']);
      expect(memoryOf(mainThreadId)).toEqual(['diet', 'obs-1']);
      expect(contentsOf(mainThreadId)).toEqual(['what should I buy?', 'milk and oats']);
    });

    it('copies messages as new rows with their original timestamps and no run link', () => {
      run({ mode: 'copy' })._unsafeUnwrap();
      const original = messages.findByThread(mainThreadId, 100, 0)._unsafeUnwrap();
      const copies = messages.findByThread(threadId(TOPIC), 100, 0)._unsafeUnwrap();

      expect(copies.map((row) => row.created_at)).toEqual(original.map((row) => row.created_at));
      expect(copies.every((row) => row.run_id === null)).toBe(true);
      expect(new Set([...copies, ...original].map((row) => row.id)).size).toBe(4);
    });

    it('is idempotent: a second copy adds nothing', () => {
      run({ mode: 'copy' })._unsafeUnwrap();
      const second = run({ mode: 'copy' })._unsafeUnwrap();

      expect(second).toMatchObject({ memoryItems: 0, messages: 0, memoryConflicts: 2 });
      expect(contentsOf(threadId(TOPIC))).toHaveLength(2);
    });

    it('resets only the target session', () => {
      run({ mode: 'copy' })._unsafeUnwrap();
      const main = threads.findById(mainThreadId)._unsafeUnwrap()!;
      const topic = threads.findByExternalId(channelId, TOPIC)._unsafeUnwrap()!;
      expect(getProviderAffinityResetAt(main.metadata)).toBeUndefined();
      expect(getProviderAffinityResetAt(topic.metadata)).toBe(NOW);
    });

    it('copies the text of a message that owns images', () => {
      markAsImageMessage(addMessage(mainThreadId, 'photo of the receipt', 2002), mainThreadId);

      const result = run({ mode: 'copy' })._unsafeUnwrap();

      expect(result).toMatchObject({ messages: 3, messagesKeptForImages: 0 });
      expect(contentsOf(threadId(TOPIC))).toContain('photo of the receipt');
    });
  });

  describe('move after an earlier copy', () => {
    it('leaves one instance of every message in the target and empties the source', () => {
      const originals = messages.findByThread(mainThreadId, 100, 0)._unsafeUnwrap();
      run({ mode: 'copy' })._unsafeUnwrap();

      const result = run()._unsafeUnwrap();

      const topic = threadId(TOPIC);
      expect(contentsOf(topic)).toEqual(['what should I buy?', 'milk and oats']);
      // The originals are what remains: real IDs, not the copies.
      expect(
        messages
          .findByThread(topic, 100, 0)
          ._unsafeUnwrap()
          .map((row) => row.id),
      ).toEqual(originals.map((row) => row.id));
      expect(contentsOf(mainThreadId)).toEqual([]);
      expect(result.messages).toBe(2);
    });

    it('treats identical memory as already there, not as a conflict', () => {
      run({ mode: 'copy' })._unsafeUnwrap();

      const result = run()._unsafeUnwrap();

      expect(result).toMatchObject({
        memoryItems: 0,
        memoryAlreadyInTarget: 2,
        memoryConflicts: 0,
      });
      expect(memoryOf(mainThreadId)).toEqual([]);
      expect(memoryOf(threadId(TOPIC))).toEqual(['diet', 'obs-1']);
    });

    it('removes the source notebook file when the target has an identical one', () => {
      writeNotebook(mainThreadId, 'facts.md', 'main facts');
      run({ mode: 'copy' })._unsafeUnwrap();

      const result = run()._unsafeUnwrap();

      expect(result).toMatchObject({ notebookFiles: 0, notebookConflicts: 0 });
      expect(readNotebook(mainThreadId, 'facts.md')).toBeNull();
      expect(readNotebook(threadId(TOPIC), 'facts.md')).toBe('main facts');
    });

    it('still reports a memory item whose content differs in the target', () => {
      run({ mode: 'copy' })._unsafeUnwrap();
      db.prepare(
        `UPDATE memory_items SET content = 'edited in topic' WHERE thread_id = ? AND id = 'diet'`,
      ).run(threadId(TOPIC));

      const result = run()._unsafeUnwrap();

      expect(result).toMatchObject({ memoryAlreadyInTarget: 1, memoryConflicts: 1 });
      expect(memoryOf(mainThreadId)).toEqual(['diet']);
    });
  });

  describe('notebook files', () => {
    it('moves notebook files and never overwrites one the target has', () => {
      const topic = makeThread(TOPIC);
      writeNotebook(mainThreadId, 'facts.md', 'main facts');
      writeNotebook(mainThreadId, 'CLAUDE.md', 'main notebook');
      writeNotebook(topic, 'CLAUDE.md', 'topic notebook');

      const result = run()._unsafeUnwrap();

      expect(result).toMatchObject({ notebookFiles: 1, notebookConflicts: 1 });
      expect(readNotebook(topic, 'facts.md')).toBe('main facts');
      expect(readNotebook(topic, 'CLAUDE.md')).toBe('topic notebook');
      expect(readNotebook(mainThreadId, 'facts.md')).toBeNull();
      expect(readNotebook(mainThreadId, 'CLAUDE.md')).toBe('main notebook');
    });

    it('copies notebook files and keeps the originals in copy mode', () => {
      writeNotebook(mainThreadId, 'facts.md', 'main facts');
      const result = run({ mode: 'copy' })._unsafeUnwrap();
      expect(result.notebookFiles).toBe(1);
      expect(readNotebook(threadId(TOPIC), 'facts.md')).toBe('main facts');
      expect(readNotebook(mainThreadId, 'facts.md')).toBe('main facts');
    });

    it('leaves files alone without a data directory', () => {
      writeNotebook(mainThreadId, 'facts.md', 'main facts');
      const result = run({ dataDir: undefined })._unsafeUnwrap();
      expect(result.notebookFiles).toBe(0);
      expect(readNotebook(mainThreadId, 'facts.md')).toBe('main facts');
    });
  });

  describe('dry run', () => {
    it('reports the plan and changes nothing', () => {
      writeNotebook(mainThreadId, 'facts.md', 'main facts');
      const result = run({ dryRun: true })._unsafeUnwrap();

      expect(result.dryRun).toBe(true);
      expect(result.plan).toEqual({
        mode: 'move',
        source: {
          threadId: mainThreadId,
          memoryItems: 2,
          memoryItemsByType: { fact: 1, observation: 1 },
          messages: 2,
          imageMessages: 0,
          notebookFiles: 1,
        },
        target: { threadId: null, memoryItems: 0, messages: 0 },
      });
      expect(threads.findByExternalId(channelId, TOPIC)._unsafeUnwrap()).toBeNull();
      expect(memoryOf(mainThreadId)).toEqual(['diet', 'obs-1']);
      expect(readNotebook(mainThreadId, 'facts.md')).toBe('main facts');
    });
  });

  describe('refusals', () => {
    it('refuses an unknown source and points at list-threads', () => {
      const result = run({ from: { channel: CHANNEL, externalId: 'nope' } });
      expect(result._unsafeUnwrapErr().message).toContain(
        'talonctl list-threads --channel TalonMain',
      );
    });

    it('refuses an unknown channel on either side', () => {
      expect(
        run({ from: { channel: 'missing', externalId: MAIN } })._unsafeUnwrapErr().message,
      ).toContain('Unknown channel: "missing"');
      expect(
        run({ to: { channel: 'missing', externalId: TOPIC } })._unsafeUnwrapErr().message,
      ).toContain('Unknown channel: "missing"');
    });

    it('refuses the same conversation as source and target', () => {
      const result = run({ to: { channel: CHANNEL, externalId: MAIN } });
      expect(result._unsafeUnwrapErr().message).toContain('same conversation');
    });

    it('refuses a schedule execution thread', () => {
      const result = run({
        to: { channel: CHANNEL, externalId: 'schedule:assistant:TalonMain:8001' },
      });
      expect(result._unsafeUnwrapErr().message).toContain('schedule execution thread');
    });

    it('refuses an empty thread id', () => {
      expect(run({ to: { channel: CHANNEL, externalId: '  ' } }).isErr()).toBe(true);
    });

    it.each(['pending', 'claimed', 'processing', 'failed'])(
      'refuses while the source has a %s queue item, and changes nothing',
      (status) => {
        addQueueItem(mainThreadId, status);

        const result = run();

        expect(result._unsafeUnwrapErr().message).toContain('queued or running');
        expect(memoryOf(mainThreadId)).toEqual(['diet', 'obs-1']);
        expect(threads.findByExternalId(channelId, TOPIC)._unsafeUnwrap()).toBeNull();
      },
    );

    it('refuses while the target is busy', () => {
      addQueueItem(makeThread(TOPIC), 'processing');
      expect(run().isErr()).toBe(true);
    });

    it('ignores finished queue items', () => {
      addQueueItem(mainThreadId, 'completed');
      expect(run().isOk()).toBe(true);
    });
  });

  describe('CLI output', () => {
    const options = { channel: CHANNEL, from: MAIN, to: TOPIC };

    it('previews a move, including what the source loses', () => {
      const plan = run({ dryRun: true })._unsafeUnwrap().plan;
      const text = formatMoveContextPlan(plan, options);
      expect(text).toContain(`Move context from "${MAIN}" (TalonMain) to "${TOPIC}" (TalonMain)`);
      expect(text).toContain('Memory items:   2 (1 fact, 1 observation)');
      expect(text).toContain('Messages:       2');
      expect(text).toContain('will be created');
      expect(text).toContain('loses this memory and history');
    });

    it('warns when the target already has history', () => {
      addMessage(makeThread(TOPIC), 'already here', 1500);
      const plan = run({ dryRun: true, mode: 'copy' })._unsafeUnwrap().plan;
      const text = formatMoveContextPlan(plan, options);
      expect(text).toContain('WARNING: the target already has 0 memory item(s) and 1 message(s)');
      expect(text).toContain('left unchanged');
    });

    it('summarises the outcome and says no restart is needed', () => {
      const text = formatMoveContextResult(run()._unsafeUnwrap());
      expect(text).toContain('Moved 2 memory item(s), 2 message(s) and 0 notebook file(s).');
      expect(text).toContain('Created the target conversation.');
      expect(text).toContain('No restart is needed.');
    });
  });
});
