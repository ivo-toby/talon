/**
 * Moves or copies a conversation's context from one thread to another.
 *
 * "Context" is what makes a thread remember: its memory items (facts, notes,
 * summaries, observations), its message history, and the notebook files in
 * its workspace `memory/` directory. The typical use is promoting a subject
 * out of a main chat into its own Telegram topic without the agent starting
 * from nothing there.
 *
 * What is deliberately NOT carried over:
 *
 * - **Images and Findings.** They are durable rows owned by the thread they
 *   were received in, with files under that thread's workspace. In move mode
 *   a message that owns Images therefore stays in the source thread; in copy
 *   mode its text is copied without the Images.
 * - **The message ledger (`message_refs`).** Provider message IDs belong to
 *   the chat they were sent in and mean nothing in another chat or topic.
 * - **Runs, schedules, bindings, queue items.** They describe what happened
 *   on, or is routed to, the source conversation.
 *
 * Both threads get a provider-affinity reset where their context changed
 * (the target always, the source in move mode). The provider-side session of
 * a thread still holds the old conversation; without the reset the next run
 * would resume it and never read the migrated context. The reset makes the
 * next run start a fresh session, which assembles its context from the
 * database — the same mechanism `talonctl reset-provider-affinity` uses, so
 * no daemon restart is needed.
 *
 * Everything in the database happens in one transaction. Notebook files are
 * handled after it commits and never overwrite a file the target already has.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { withProviderAffinityResetAt } from './thread-metadata.js';

/** One end of a move: a conversation addressed by channel name and external thread ID. */
export interface ThreadAddress {
  channel: string;
  externalId: string;
}

/** `move` empties the source; `copy` leaves it untouched. */
export type ThreadContextMoveMode = 'move' | 'copy';

export interface MoveThreadContextInput {
  db: Database.Database;
  from: ThreadAddress;
  to: ThreadAddress;
  mode: ThreadContextMoveMode;
  /** Carry the message history as well as the memory items. */
  includeMessages: boolean;
  /** Daemon data directory; when absent, notebook files are left alone. */
  dataDir?: string;
  /** Compute and return the plan without changing anything. */
  dryRun?: boolean;
  now?: () => number;
}

/** What a move would touch, counted before anything changes. */
export interface ThreadContextMovePlan {
  mode: ThreadContextMoveMode;
  source: {
    threadId: string;
    memoryItems: number;
    /** Memory items by type, e.g. `{ fact: 3, observation: 2 }`. */
    memoryItemsByType: Record<string, number>;
    messages: number;
    /** Messages that own Images; they stay behind in move mode. */
    imageMessages: number;
    notebookFiles: number;
  };
  target: {
    /** Null when the target conversation has no thread yet; it is created. */
    threadId: string | null;
    memoryItems: number;
    messages: number;
  };
}

export interface MoveThreadContextResult {
  plan: ThreadContextMovePlan;
  dryRun: boolean;
  targetThreadId: string | null;
  targetThreadCreated: boolean;
  /** Memory items now present in the target because of this run. */
  memoryItems: number;
  /**
   * Memory items left in place because the target already had the same ID
   * with different content.
   */
  memoryConflicts: number;
  /**
   * Move mode: memory items the target already held identically (from an
   * earlier copy), removed from the source instead of moved.
   */
  memoryAlreadyInTarget: number;
  /** Messages now present in the target because of this run. */
  messages: number;
  /** Move mode: messages left in the source because they own Images. */
  messagesKeptForImages: number;
  notebookFiles: number;
  /** Notebook files skipped because the target already had the same name. */
  notebookConflicts: number;
}

export class ThreadContextMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadContextMoveError';
  }
}

interface ThreadRow {
  id: string;
  channel_id: string;
  external_id: string;
  metadata: string | null;
}

const BUSY_STATUSES = "('pending', 'claimed', 'processing', 'failed')";

/** Messages of a thread that own image ledger rows. */
const IMAGE_MESSAGE_IDS = `
  SELECT message_id FROM images WHERE thread_id = @from
  UNION SELECT message_id FROM image_ingestions WHERE thread_id = @from
  UNION SELECT message_id FROM image_admission_records WHERE thread_id = @from
`;

function fail<T>(message: string): Result<T, ThreadContextMoveError> {
  return err(new ThreadContextMoveError(message));
}

/** Column names of a table, so row copies survive later schema additions. */
function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function resolveThread(
  db: Database.Database,
  address: ThreadAddress,
  role: 'source' | 'target',
): Result<{ channelId: string; thread: ThreadRow | null }, ThreadContextMoveError> {
  if (address.externalId.trim() === '') {
    return fail(`The ${role} thread ID is empty.`);
  }
  if (address.externalId.startsWith('schedule:')) {
    return fail(
      `"${address.externalId}" is a schedule execution thread, not a conversation; it cannot be a ${role}.`,
    );
  }
  const channel = db.prepare('SELECT id FROM channels WHERE name = ?').get(address.channel) as
    { id: string } | undefined;
  if (channel === undefined) {
    return fail(`Unknown channel: "${address.channel}"`);
  }
  const thread = db
    .prepare(
      'SELECT id, channel_id, external_id, metadata FROM threads WHERE channel_id = ? AND external_id = ?',
    )
    .get(channel.id, address.externalId) as ThreadRow | undefined;
  return ok({ channelId: channel.id, thread: thread ?? null });
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

function notebookDir(dataDir: string, threadId: string): string {
  return path.join(dataDir, 'threads', threadId, 'memory');
}

function listNotebookFiles(dataDir: string | undefined, threadId: string): string[] {
  if (dataDir === undefined) return [];
  try {
    return fs
      .readdirSync(notebookDir(dataDir, threadId), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Moves or copies memory items, messages and notebook files from the source
 * conversation to the target conversation.
 *
 * Refuses when the source does not exist, when both addresses name the same
 * conversation, and when either thread has queued or running work — moving
 * rows under a run in flight would hand it a half-migrated conversation.
 */
export function moveThreadContext(
  input: MoveThreadContextInput,
): Result<MoveThreadContextResult, ThreadContextMoveError> {
  const { db, mode, includeMessages } = input;
  const dryRun = input.dryRun === true;
  const now = input.now ? input.now() : Date.now();

  const sourceResolved = resolveThread(db, input.from, 'source');
  if (sourceResolved.isErr()) return err(sourceResolved.error);
  const source = sourceResolved.value.thread;
  if (source === null) {
    return fail(
      `No conversation "${input.from.externalId}" on channel "${input.from.channel}". ` +
        `Run \`talonctl list-threads --channel ${input.from.channel}\` to see the thread IDs.`,
    );
  }

  const targetResolved = resolveThread(db, input.to, 'target');
  if (targetResolved.isErr()) return err(targetResolved.error);
  const existingTarget = targetResolved.value.thread;
  if (existingTarget !== null && existingTarget.id === source.id) {
    return fail('Source and target are the same conversation.');
  }

  const busyThreadIds = [source.id, ...(existingTarget !== null ? [existingTarget.id] : [])];
  const busy = count(
    db,
    `SELECT COUNT(*) AS n FROM queue_items
     WHERE thread_id IN (${busyThreadIds.map(() => '?').join(', ')}) AND status IN ${BUSY_STATUSES}`,
    ...busyThreadIds,
  );
  if (busy > 0) {
    return fail(
      `${busy} queued or running item(s) on these conversations. Wait until the agent is idle there and try again.`,
    );
  }

  const memoryByType = db
    .prepare('SELECT type, COUNT(*) AS n FROM memory_items WHERE thread_id = ? GROUP BY type')
    .all(source.id) as Array<{ type: string; n: number }>;
  const plan: ThreadContextMovePlan = {
    mode,
    source: {
      threadId: source.id,
      memoryItems: memoryByType.reduce((total, row) => total + row.n, 0),
      memoryItemsByType: Object.fromEntries(memoryByType.map((row) => [row.type, row.n])),
      messages: includeMessages
        ? count(db, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', source.id)
        : 0,
      imageMessages: includeMessages
        ? count(
            db,
            `SELECT COUNT(*) AS n FROM messages WHERE thread_id = @from AND id IN (${IMAGE_MESSAGE_IDS})`,
            { from: source.id },
          )
        : 0,
      notebookFiles: listNotebookFiles(input.dataDir, source.id).length,
    },
    target: {
      threadId: existingTarget?.id ?? null,
      memoryItems:
        existingTarget !== null
          ? count(
              db,
              'SELECT COUNT(*) AS n FROM memory_items WHERE thread_id = ?',
              existingTarget.id,
            )
          : 0,
      messages:
        existingTarget !== null
          ? count(db, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', existingTarget.id)
          : 0,
    },
  };

  if (dryRun) {
    return ok({
      plan,
      dryRun: true,
      targetThreadId: existingTarget?.id ?? null,
      targetThreadCreated: false,
      memoryItems: 0,
      memoryConflicts: 0,
      memoryAlreadyInTarget: 0,
      messages: 0,
      messagesKeptForImages: 0,
      notebookFiles: 0,
      notebookConflicts: 0,
    });
  }

  let targetThreadId = existingTarget?.id ?? '';
  let memoryItems = 0;
  let memoryConflicts = 0;
  let memoryAlreadyInTarget = 0;
  let messages = 0;
  let messagesKeptForImages = 0;

  try {
    db.transaction(() => {
      let targetMetadata = existingTarget?.metadata ?? '{}';
      if (existingTarget === null) {
        targetThreadId = randomUUID();
        db.prepare(
          `INSERT INTO threads (id, channel_id, external_id, metadata, created_at, updated_at)
           VALUES (?, ?, ?, '{}', ?, ?)`,
        ).run(targetThreadId, targetResolved.value.channelId, input.to.externalId, now, now);
        targetMetadata = '{}';
      }
      const ids = { from: source.id, to: targetThreadId };

      // ---- memory items -------------------------------------------------
      if (mode === 'move') {
        memoryItems = db
          .prepare(
            `UPDATE memory_items SET thread_id = @to
             WHERE thread_id = @from
               AND id NOT IN (SELECT id FROM memory_items WHERE thread_id = @to)`,
          )
          .run(ids).changes;
        // An item the target already holds identically (an earlier --copy)
        // is the same memory, not a conflict: drop the source's duplicate so
        // a move after a copy still leaves the source empty.
        memoryAlreadyInTarget = db
          .prepare(
            `DELETE FROM memory_items
             WHERE thread_id = @from
               AND EXISTS (
                 SELECT 1 FROM memory_items t
                 WHERE t.thread_id = @to
                   AND t.id = memory_items.id
                   AND t.type = memory_items.type
                   AND t.content = memory_items.content
               )`,
          )
          .run(ids).changes;
        memoryConflicts = count(
          db,
          'SELECT COUNT(*) AS n FROM memory_items WHERE thread_id = ?',
          source.id,
        );
      } else {
        const columns = columnsOf(db, 'memory_items').filter((name) => name !== 'thread_id');
        memoryItems = db
          .prepare(
            `INSERT OR IGNORE INTO memory_items (thread_id, ${columns.join(', ')})
             SELECT @to, ${columns.join(', ')} FROM memory_items WHERE thread_id = @from`,
          )
          .run(ids).changes;
        memoryConflicts = plan.source.memoryItems - memoryItems;
      }

      // ---- messages -----------------------------------------------------
      if (includeMessages && mode === 'move') {
        // A message that an earlier --copy already placed in the target would
        // appear twice once the original arrives. Remove the copy and keep
        // the original, which carries the real ID and run link.
        db.prepare(
          `DELETE FROM messages
           WHERE thread_id = @to
             AND idempotency_key IN (
               SELECT 'context-copy:' || @to || ':' || id FROM messages
               WHERE thread_id = @from AND id NOT IN (${IMAGE_MESSAGE_IDS})
             )`,
        ).run(ids);
        messages = db
          .prepare(
            `UPDATE messages SET thread_id = @to
             WHERE thread_id = @from AND id NOT IN (${IMAGE_MESSAGE_IDS})`,
          )
          .run(ids).changes;
        messagesKeptForImages = plan.source.imageMessages;
      } else if (includeMessages) {
        // A copy is a new row: its own ID, and an idempotency key derived from
        // the original so running the same copy twice adds nothing. The run
        // link is dropped; the run belongs to the source thread.
        const columns = columnsOf(db, 'messages');
        const insert = db.prepare(
          `INSERT OR IGNORE INTO messages (${columns.join(', ')})
           VALUES (${columns.map((name) => `@${name}`).join(', ')})`,
        );
        const rows = db
          .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
          .all(source.id) as Array<Record<string, unknown>>;
        for (const row of rows) {
          messages += insert.run({
            ...row,
            id: randomUUID(),
            thread_id: targetThreadId,
            idempotency_key: `context-copy:${targetThreadId}:${String(row.id)}`,
            run_id: null,
          }).changes;
        }
      }

      // ---- fresh sessions ----------------------------------------------
      const setMetadata = db.prepare(
        'UPDATE threads SET metadata = ?, updated_at = ? WHERE id = ?',
      );
      setMetadata.run(withProviderAffinityResetAt(targetMetadata, now), now, targetThreadId);
      if (mode === 'move') {
        setMetadata.run(withProviderAffinityResetAt(source.metadata, now), now, source.id);
      }
    })();
  } catch (cause) {
    return fail(`Nothing was changed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  // ---- notebook files (after commit; never overwrite) ------------------
  let notebookFiles = 0;
  let notebookConflicts = 0;
  if (input.dataDir !== undefined) {
    const fromDir = notebookDir(input.dataDir, source.id);
    const toDir = notebookDir(input.dataDir, targetThreadId);
    for (const name of listNotebookFiles(input.dataDir, source.id)) {
      const destination = path.join(toDir, name);
      const origin = path.join(fromDir, name);
      if (fs.existsSync(destination)) {
        // Identical content is the same file (an earlier --copy), not a
        // conflict; a move then only has the source's duplicate to remove.
        if (fs.readFileSync(destination).equals(fs.readFileSync(origin))) {
          if (mode === 'move') fs.rmSync(origin);
        } else {
          notebookConflicts += 1;
        }
        continue;
      }
      fs.mkdirSync(toDir, { recursive: true });
      fs.copyFileSync(path.join(fromDir, name), destination);
      if (mode === 'move') {
        fs.rmSync(path.join(fromDir, name));
      }
      notebookFiles += 1;
    }
  }

  return ok({
    plan,
    dryRun: false,
    targetThreadId,
    targetThreadCreated: existingTarget === null,
    memoryItems,
    memoryConflicts,
    memoryAlreadyInTarget,
    messages,
    messagesKeptForImages,
    notebookFiles,
    notebookConflicts,
  });
}
