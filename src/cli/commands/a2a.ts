/**
 * `talonctl a2a` subcommand group.
 *
 * Provides CLI access to A2A task management for testing and monitoring:
 *
 *   talonctl a2a list [--status <state>] [--target <persona>] [--limit <n>]
 *   talonctl a2a send <target-persona> <message> [--source <persona>]
 *
 * The pure functions (`listA2ATasks`, `sendA2ATask`) can be called
 * programmatically. The `a2aCommand()` wrapper handles config loading,
 * DB lifecycle, console output, and process.exit.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import { A2ATaskRepository } from '../../core/database/repositories/a2a-task-repository.js';
import { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { QueueRepository } from '../../core/database/repositories/queue-repository.js';
import type { A2ATaskState } from '../../a2a/a2a-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface A2ATaskInfo {
  taskId: string;
  /** First 8 chars of the task ID for display. */
  taskIdShort: string;
  sourcePersona: string;
  targetPersona: string;
  state: A2ATaskState;
  submittedAt: string;
  updatedAt: string;
}

export interface ListA2ATasksOptions {
  db: Database.Database;
  status?: string;
  targetPersona?: string;
  limit?: number;
}

export interface SendA2ATaskOptions {
  db: Database.Database;
  targetPersona: string;
  message: string;
  sourcePersona?: string;
}

export interface SendA2ATaskResult {
  taskId: string;
  state: A2ATaskState;
  sourcePersona: string;
  targetPersona: string;
}

// ---------------------------------------------------------------------------
// listA2ATasks — pure core logic
// ---------------------------------------------------------------------------

/**
 * Lists A2A tasks from the database, with optional filters.
 *
 * @throws Error on database failure.
 */
export function listA2ATasks(options: ListA2ATasksOptions): A2ATaskInfo[] {
  const { db, status, targetPersona, limit } = options;

  const repo = new A2ATaskRepository(db);
  const result = repo.findAll({ state: status, targetPersona, limit });
  if (result.isErr()) {
    throw new Error(`Database error listing A2A tasks: ${result.error.message}`);
  }

  return result.value.map((row) => ({
    taskId: row.id,
    taskIdShort: row.id.slice(0, 8),
    sourcePersona: row.source_persona,
    targetPersona: row.target_persona,
    state: row.state,
    submittedAt: new Date(row.submitted_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// sendA2ATask — pure core logic
// ---------------------------------------------------------------------------

/** Name used for the synthetic CLI channel. */
const CLI_CHANNEL_NAME = 'a2a-cli';
/** Name used for the synthetic CLI thread external ID. */
const CLI_THREAD_EXTERNAL_ID = 'a2a-cli-thread';

/**
 * Submits an A2A task from the CLI directly into the database and queue.
 *
 * Creates a synthetic "a2a-cli" channel and thread on first use if they do
 * not already exist in the database. The task is enqueued for processing by
 * the running daemon (if any).
 *
 * @throws Error if the target persona is unknown or on DB failure.
 */
export function sendA2ATask(options: SendA2ATaskOptions): SendA2ATaskResult {
  const { db, targetPersona, message, sourcePersona = 'cli' } = options;

  if (!message.trim()) {
    throw new Error('Message must not be empty');
  }

  // --- Verify target persona exists ----------------------------------------
  const personaRepo = new PersonaRepository(db);
  const personaResult = personaRepo.findByName(targetPersona);
  if (personaResult.isErr()) {
    throw new Error(`Database error looking up persona: ${personaResult.error.message}`);
  }
  if (!personaResult.value) {
    throw new Error(`Unknown target persona: "${targetPersona}"`);
  }
  const personaRow = personaResult.value;

  // --- Find or create CLI channel ------------------------------------------
  const channelRepo = new ChannelRepository(db);
  let channelId: string;

  const existingChannelResult = channelRepo.findByName(CLI_CHANNEL_NAME);
  if (existingChannelResult.isErr()) {
    throw new Error(`Database error looking up CLI channel: ${existingChannelResult.error.message}`);
  }

  if (existingChannelResult.value) {
    channelId = existingChannelResult.value.id;
  } else {
    channelId = uuidv4();
    const insertResult = channelRepo.insert({
      id: channelId,
      type: 'terminal',
      name: CLI_CHANNEL_NAME,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    if (insertResult.isErr()) {
      throw new Error(`Failed to create CLI channel: ${insertResult.error.message}`);
    }
  }

  // --- Find or create CLI thread -------------------------------------------
  const threadRepo = new ThreadRepository(db);
  let threadId: string;

  const existingThreadResult = threadRepo.findByExternalId(channelId, CLI_THREAD_EXTERNAL_ID);
  if (existingThreadResult.isErr()) {
    throw new Error(`Database error looking up CLI thread: ${existingThreadResult.error.message}`);
  }

  if (existingThreadResult.value) {
    threadId = existingThreadResult.value.id;
  } else {
    threadId = uuidv4();
    const insertResult = threadRepo.insert({
      id: threadId,
      channel_id: channelId,
      external_id: CLI_THREAD_EXTERNAL_ID,
      metadata: '{}',
    });
    if (insertResult.isErr()) {
      throw new Error(`Failed to create CLI thread: ${insertResult.error.message}`);
    }
  }

  // --- Concurrency admission check ----------------------------------------
  const taskRepo = new A2ATaskRepository(db);
  const activeResult = taskRepo.countActiveByTarget(targetPersona);
  if (activeResult.isErr()) {
    throw new Error(`Failed to check active tasks for "${targetPersona}": ${activeResult.error.message}`);
  }
  if (activeResult.value >= 1) {
    throw new Error(
      `Target persona "${targetPersona}" already has ${activeResult.value} active A2A task(s). ` +
      `Wait for it to complete before submitting a new one.`,
    );
  }

  // --- Insert A2A task and enqueue -----------------------------------------
  const queueRepo = new QueueRepository(db);

  const taskId = uuidv4();
  const now = Date.now();

  const taskPayload = {
    kind: 'a2a_task',
    taskId,
    sourcePersona,
    targetPersona,
    sourceThreadId: threadId,
    personaId: personaRow.id,
    content: message,
    hopCount: 0,
    submittedAt: now,
    metadata: {
      agentCardId: targetPersona,
      maxHops: 4,
      queueType: 'collaboration',
      source: 'cli',
    },
  };

  const insertResult = taskRepo.insertSubmitted({
    id: taskId,
    source_persona: sourcePersona,
    target_persona: targetPersona,
    thread_id: threadId,
    request_payload: JSON.stringify(taskPayload),
    hop_count: 0,
    parent_task_id: null,
    submitted_at: now,
  });

  if (insertResult.isErr()) {
    throw new Error(`Failed to create A2A task: ${insertResult.error.message}`);
  }

  // Enqueue for processing
  const enqueueResult = queueRepo.enqueue({
    id: uuidv4(),
    thread_id: threadId,
    message_id: null,
    type: 'collaboration',
    payload: JSON.stringify(taskPayload),
    max_attempts: 3,
  });

  if (enqueueResult.isErr()) {
    // Roll back: mark the task failed so the concurrency slot is released.
    taskRepo.markFailed(taskId, 'ENQUEUE_ERROR', enqueueResult.error.message);
    throw new Error(`Failed to enqueue A2A task: ${enqueueResult.error.message}`);
  }

  // Attach queue item to task (best-effort — task still runs if this fails)
  const attachResult = taskRepo.attachQueueItem(taskId, enqueueResult.value.id);
  if (attachResult.isErr()) {
    // Non-fatal: warn but don't abort — the task is already queued.
    process.stderr.write(
      `warning: failed to link queue item to task ${taskId}: ${attachResult.error.message}\n`,
    );
  }

  return {
    taskId,
    state: 'submitted',
    sourcePersona,
    targetPersona,
  };
}

// ---------------------------------------------------------------------------
// CLI wrappers
// ---------------------------------------------------------------------------

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

async function openDb(configPath: string): Promise<Database.Database> {
  const { loadConfig } = await import('../../core/config/config-loader.js');
  const { createDatabase } = await import('../../core/database/connection.js');

  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
  }

  const dbResult = createDatabase(configResult.value.storage.path);
  if (dbResult.isErr()) {
    console.error(`Error opening database: ${dbResult.error.message}`);
    process.exit(1);
  }

  return dbResult.value;
}

/**
 * CLI entrypoint for `talonctl a2a list`.
 *
 * Lists A2A tasks with optional filters and prints a formatted table.
 */
export async function a2aListCommand(options: {
  configPath?: string;
  status?: string;
  target?: string;
  limit?: number;
}): Promise<void> {
  const db = await openDb(options.configPath ?? 'talond.yaml');

  try {
    const tasks = listA2ATasks({
      db,
      status: options.status,
      targetPersona: options.target,
      limit: options.limit ?? 20,
    });

    if (tasks.length === 0) {
      console.log('No A2A tasks found.');
      return;
    }

    const header = ['TASK ID', 'SOURCE', 'TARGET', 'STATUS', 'SUBMITTED', 'UPDATED'];
    const rows = tasks.map((t) => [
      t.taskIdShort,
      truncate(t.sourcePersona, 20),
      truncate(t.targetPersona, 20),
      t.state,
      t.submittedAt,
      t.updatedAt,
    ]);

    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );

    const formatRow = (cols: string[]) =>
      cols.map((c, i) => c.padEnd(widths[i])).join('  ');

    console.log(formatRow(header));
    console.log(widths.map((w) => '─'.repeat(w)).join('  '));
    for (const row of rows) {
      console.log(formatRow(row));
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

/**
 * CLI entrypoint for `talonctl a2a send`.
 *
 * Submits a new A2A task to the target persona and prints the task ID.
 */
export async function a2aSendCommand(options: {
  configPath?: string;
  targetPersona: string;
  message: string;
  sourcePersona?: string;
}): Promise<void> {
  const db = await openDb(options.configPath ?? 'talond.yaml');

  try {
    const result = sendA2ATask({
      db,
      targetPersona: options.targetPersona,
      message: options.message,
      sourcePersona: options.sourcePersona,
    });

    console.log(`Task submitted successfully.`);
    console.log(`  Task ID : ${result.taskId}`);
    console.log(`  Status  : ${result.state}`);
    console.log(`  From    : ${result.sourcePersona}`);
    console.log(`  To      : ${result.targetPersona}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
