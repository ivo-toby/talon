/**
 * `talonctl a2a` subcommand group.
 *
 * Provides CLI access to A2A task management for testing and monitoring:
 *
 *   talonctl a2a list [--status <state>] [--target <persona>] [--limit <n>]
 *   talonctl a2a send <target-persona> <message> [--source <persona>]
 *   talonctl a2a cancel <taskId> [--reason <text>]
 *
 * The pure functions (`listA2ATasks`, `sendA2ATask`, `cancelA2ATask`) can be called
 * programmatically. The `a2aCommand()` wrapper handles config loading,
 * DB lifecycle, console output, and process.exit.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import fs from 'node:fs/promises';
import path from 'node:path';

import { A2ATaskRepository } from '../../core/database/repositories/a2a-task-repository.js';
import { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { QueueRepository } from '../../core/database/repositories/queue-repository.js';
import { A2ATaskMapper } from '../../a2a/a2a-task-mapper.js';
import { DaemonIpcClient } from '../../ipc/daemon-ipc-client.js';
import type { A2AAgentCard, A2ATaskState, A2ALimits } from '../../a2a/a2a-types.js';

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
  /** Runtime A2A limits — defaults applied when omitted. */
  limits?: A2ALimits;
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
  const { db, targetPersona, message, sourcePersona = 'cli', limits } = options;

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

  // --- Submit via A2ATaskMapper (canonical path, handles atomicity) ---------
  const taskRepo = new A2ATaskRepository(db);
  const queueRepo = new QueueRepository(db);
  const silentLogger = pino({ level: 'silent' });

  // Build a minimal synthetic agent card so the mapper can register the target.
  const syntheticCard: A2AAgentCard = {
    id: targetPersona,
    name: targetPersona,
    description: '',
    url: `/a2a/agents/${targetPersona}`,
    version: '1.0',
    skills: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    metadata: {
      personaName: targetPersona,
      model: '',
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
      internalOnly: true,
    },
  };

  const cardRegistry = new Map<string, A2AAgentCard>([[targetPersona, syntheticCard]]);
  const mapper = new A2ATaskMapper(
    taskRepo,
    queueRepo,
    threadRepo,
    personaRepo,
    cardRegistry,
    silentLogger,
    limits,
  );

  const submitResult = mapper.submitTask({
    sourcePersona,
    targetPersona,
    sourceThreadId: threadId,
    content: message,
    hopCount: 0,
  });

  if (submitResult.isErr()) {
    throw new Error(submitResult.error.message);
  }

  const { taskId, state } = submitResult.value;
  return { taskId, state, sourcePersona, targetPersona };
}

// ---------------------------------------------------------------------------
// cancelA2ATask — pure core logic (direct DB)
// ---------------------------------------------------------------------------

export interface CancelA2ATaskOptions {
  db: Database.Database;
  taskId: string;
  reason?: string;
  limits?: A2ALimits;
}

export interface CancelA2ATaskResult {
  taskId: string;
  /** false when no task with this ID exists. */
  found: boolean;
  /** true only when this call moved the task to `canceled`. */
  canceled: boolean;
  /** Final state after the call (absent when not found). */
  state?: A2ATaskState;
}

const DEFAULT_CANCEL_REASON = 'canceled via talonctl';

/**
 * Cancels an A2A task directly in the database through an A2ATaskMapper.
 *
 * This marks the task canceled and drops its pending queue item, but cannot
 * stop a run that is already in flight inside a running daemon (the abort hook
 * lives in the daemon process). Use {@link cancelA2ATaskViaDaemonOrDb} to
 * prefer the daemon.
 *
 * @throws Error on database failure.
 */
export function cancelA2ATask(options: CancelA2ATaskOptions): CancelA2ATaskResult {
  const { db, taskId, limits } = options;
  const reason = options.reason?.trim() || DEFAULT_CANCEL_REASON;

  const mapper = new A2ATaskMapper(
    new A2ATaskRepository(db),
    new QueueRepository(db),
    new ThreadRepository(db),
    new PersonaRepository(db),
    new Map<string, A2AAgentCard>(),
    pino({ level: 'silent' }),
    limits,
  );

  const before = mapper.getTaskStatus(taskId);
  if (before.isErr()) throw new Error(before.error.message);
  if (before.value === null) return { taskId, found: false, canceled: false };

  const result = mapper.cancelTask(taskId, reason);
  if (result.isErr()) throw new Error(result.error.message);

  const after = mapper.getTaskStatus(taskId);
  const state = after.isOk() && after.value ? after.value.state : before.value.state;
  return { taskId, found: true, canceled: result.value, state };
}

export interface CancelViaDaemonOptions {
  taskId: string;
  reason?: string;
  /** Daemon IPC base directory. Default: data/ipc/daemon. */
  ipcDir?: string;
  /** How long to wait for the daemon before falling back to the DB. Default: 5000. */
  timeoutMs?: number;
  /** Opens the DB for the fallback path (only called when the daemon does not answer). */
  openDatabase: () => Promise<OpenedDb> | OpenedDb;
}

export interface CancelViaDaemonResult extends CancelA2ATaskResult {
  /** `daemon`: handled in the daemon (in-flight run aborted). `database`: direct DB fallback. */
  via: 'daemon' | 'database';
}

const DEFAULT_IPC_DIR = 'data/ipc/daemon';
const DEFAULT_IPC_TIMEOUT_MS = 5_000;

/**
 * Cancels a task through the running daemon (IPC `a2a-cancel`) so an in-flight
 * run is aborted; when the daemon does not answer, falls back to a direct DB
 * cancel (no run can be in flight then).
 *
 * @throws Error when the daemon answers with a failure or the DB cancel fails.
 */
export async function cancelA2ATaskViaDaemonOrDb(
  options: CancelViaDaemonOptions,
): Promise<CancelViaDaemonResult> {
  const ipcDir = options.ipcDir ?? DEFAULT_IPC_DIR;
  const inputDir = path.join(ipcDir, 'input');
  const client = new DaemonIpcClient({
    inputDir,
    outputDir: path.join(ipcDir, 'output'),
    timeoutMs: options.timeoutMs ?? DEFAULT_IPC_TIMEOUT_MS,
  });

  const commandId = randomUUID();
  let response: Awaited<ReturnType<DaemonIpcClient['send']>> = null;
  try {
    response = await client.send({
      id: commandId,
      command: 'a2a-cancel',
      payload: {
        taskId: options.taskId,
        ...(options.reason ? { reason: options.reason } : {}),
      },
    });
  } catch {
    // Could not even write the command (no IPC dir): treat as daemon not running.
  }

  if (response !== null) {
    if (!response.success) {
      throw new Error(response.error ?? 'Unknown daemon error');
    }
    const data = (response.data ?? {}) as {
      found?: boolean;
      canceled?: boolean;
      state?: A2ATaskState;
    };
    return {
      taskId: options.taskId,
      found: data.found === true,
      canceled: data.canceled === true,
      ...(data.state !== undefined ? { state: data.state } : {}),
      via: 'daemon',
    };
  }

  // No answer: remove our unprocessed command so a daemon that starts later
  // does not replay it, then cancel directly in the DB.
  await removeUnprocessedCommand(inputDir, commandId);
  const { db, a2aLimits } = await options.openDatabase();
  try {
    const result = cancelA2ATask({
      db,
      taskId: options.taskId,
      reason: options.reason,
      limits: a2aLimits,
    });
    return { ...result, via: 'database' };
  } finally {
    db.close();
  }
}

async function removeUnprocessedCommand(inputDir: string, commandId: string): Promise<void> {
  const cleanId = commandId.replace(/-/g, '');
  try {
    for (const entry of await fs.readdir(inputDir)) {
      if (entry.includes(cleanId)) {
        await fs.unlink(path.join(inputDir, entry)).catch(() => undefined);
      }
    }
  } catch {
    // Directory missing or unreadable: nothing to clean up.
  }
}

// ---------------------------------------------------------------------------
// CLI wrappers
// ---------------------------------------------------------------------------

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

interface OpenedDb {
  db: Database.Database;
  a2aLimits: A2ALimits;
}

async function openDb(configPath: string): Promise<OpenedDb> {
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

  return { db: dbResult.value, a2aLimits: configResult.value.a2a };
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
  const { db } = await openDb(options.configPath ?? 'talond.yaml');

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
  const { db, a2aLimits } = await openDb(options.configPath ?? 'talond.yaml');

  try {
    const result = sendA2ATask({
      db,
      targetPersona: options.targetPersona,
      message: options.message,
      sourcePersona: options.sourcePersona,
      limits: a2aLimits,
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

/**
 * CLI entrypoint for `talonctl a2a cancel`.
 *
 * Tries the running daemon first (aborts an in-flight run); falls back to a
 * direct DB cancel when the daemon is not running. Exits 1 when the task does
 * not exist or on error; an already-finished task is reported with exit 0.
 */
export async function a2aCancelCommand(options: {
  configPath?: string;
  taskId: string;
  reason?: string;
  ipcDir?: string;
  timeoutMs?: number;
}): Promise<void> {
  try {
    const result = await cancelA2ATaskViaDaemonOrDb({
      taskId: options.taskId,
      reason: options.reason,
      ipcDir: options.ipcDir,
      timeoutMs: options.timeoutMs,
      openDatabase: () => openDb(options.configPath ?? 'talond.yaml'),
    });

    if (!result.found) {
      console.error(`Error: A2A task not found: ${result.taskId}`);
      process.exit(1);
      return;
    }

    if (result.canceled) {
      console.log(`Task ${result.taskId} canceled.`);
      if (result.via === 'database') {
        console.log('  Note: talond is not running; canceled in the database only.');
      }
    } else {
      console.log(`Task ${result.taskId} was not canceled: already ${result.state ?? 'finished'}.`);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
