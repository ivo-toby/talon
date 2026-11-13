/**
 * Unit tests for daemon lifecycle utilities.
 *
 * Tests cover:
 * - recoverFromCrash: resets claimed/processing items to pending
 * - writePidFile / removePidFile: PID file management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import pino from 'pino';

import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { recoverFromCrash, writePidFile, removePidFile } from '../../../src/daemon/lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) {
    throw new Error(`Test DB migration failed: ${result.error.message}`);
  }
  return db;
}

function createSilentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function uuid(): string {
  return uuidv4();
}

/** Seeds a channel and thread, returns threadId. */
function seedThread(db: Database.Database): string {
  const channels = new ChannelRepository(db);
  const threads = new ThreadRepository(db);

  const channelId = uuid();
  channels.insert({
    id: channelId,
    type: 'telegram',
    name: `ch-${uuid()}`,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const threadId = uuid();
  threads.insert({
    id: threadId,
    channel_id: channelId,
    external_id: `ext-${uuid()}`,
    metadata: '{}',
  });

  return threadId;
}

/** Enqueues an item and returns its id. */
function enqueueItem(
  repo: QueueRepository,
  threadId: string,
  status?: string,
): string {
  const id = uuid();
  repo.enqueue({
    id,
    thread_id: threadId,
    message_id: null,
    type: 'message',
    payload: '{}',
    max_attempts: 3,
  });

  // If a non-pending status is needed, force it via direct SQL
  if (status && status !== 'pending') {
    const db = (repo as unknown as { db: Database.Database }).db;
    db.prepare(`UPDATE queue_items SET status = ? WHERE id = ?`).run(status, id);
  }
  return id;
}

/** Enqueues a collaboration item with a caller-supplied payload and status. */
function enqueueCollaborationItem(
  repo: QueueRepository,
  threadId: string,
  payload: string,
  status: 'claimed' | 'processing',
): string {
  const id = uuid();
  repo.enqueue({
    id,
    thread_id: threadId,
    message_id: null,
    type: 'collaboration',
    payload,
    max_attempts: 1,
  });

  const db = (repo as unknown as { db: Database.Database }).db;
  db.prepare(`UPDATE queue_items SET status = ? WHERE id = ?`).run(status, id);
  return id;
}

// ---------------------------------------------------------------------------
// recoverFromCrash tests
// ---------------------------------------------------------------------------

describe('recoverFromCrash', () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let threadId: string;
  const logger = createSilentLogger();

  beforeEach(() => {
    db = createTestDb();
    queueRepo = new QueueRepository(db);
    threadId = seedThread(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resets claimed items back to pending', () => {
    const id = enqueueItem(queueRepo, threadId, 'claimed');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('resets processing items back to pending', () => {
    const id = enqueueItem(queueRepo, threadId, 'processing');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('leaves voice backend work for voice reconciliation instead of replaying it', () => {
    const id = enqueueCollaborationItem(
      queueRepo,
      threadId,
      JSON.stringify({ kind: 'voice_backend', sessionId: 'session-1', delegationId: 'delegation-1' }),
      'claimed',
    );

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('claimed');
  });

  it('leaves processing voice backend work for voice reconciliation', () => {
    const id = enqueueCollaborationItem(
      queueRepo,
      threadId,
      JSON.stringify({ kind: 'voice_backend', sessionId: 'session-2', delegationId: 'delegation-2' }),
      'processing',
    );

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('processing');
  });

  it('recovers normal collaboration work when kind is missing or null', () => {
    const missingKindId = enqueueCollaborationItem(
      queueRepo,
      threadId,
      JSON.stringify({ sessionId: 'normal-missing-kind' }),
      'claimed',
    );
    const nullKindId = enqueueCollaborationItem(
      queueRepo,
      threadId,
      JSON.stringify({ kind: null, sessionId: 'normal-null-kind' }),
      'processing',
    );

    recoverFromCrash(queueRepo, logger);

    for (const id of [missingKindId, nullKindId]) {
      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
        status: string;
      };
      expect(row.status).toBe('pending');
    }
  });

  it('recovers malformed collaboration payloads without throwing', () => {
    const id = enqueueCollaborationItem(queueRepo, threadId, '{"kind":', 'processing');

    expect(() => recoverFromCrash(queueRepo, logger)).not.toThrow();

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('resets multiple in-flight items in a single call', () => {
    const id1 = enqueueItem(queueRepo, threadId, 'claimed');
    const id2 = enqueueItem(queueRepo, threadId, 'processing');
    const id3 = enqueueItem(queueRepo, threadId, 'claimed');

    recoverFromCrash(queueRepo, logger);

    for (const id of [id1, id2, id3]) {
      const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
        status: string;
      };
      expect(row.status).toBe('pending');
    }
  });

  it('does not modify already-pending items', () => {
    const id = enqueueItem(queueRepo, threadId, 'pending');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
  });

  it('does not modify completed items', () => {
    const id = enqueueItem(queueRepo, threadId, 'completed');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('completed');
  });

  it('does not modify dead_letter items', () => {
    const id = enqueueItem(queueRepo, threadId, 'dead_letter');

    recoverFromCrash(queueRepo, logger);

    const row = db.prepare('SELECT status FROM queue_items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('dead_letter');
  });

  it('is safe to call when no in-flight items exist', () => {
    // Should not throw
    expect(() => recoverFromCrash(queueRepo, logger)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writePidFile / removePidFile tests
// ---------------------------------------------------------------------------

describe('writePidFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `talon-test-${uuid()}`);
  });

  afterEach(() => {
    // Best-effort cleanup
    try {
      removePidFile(tmpDir);
    } catch {
      // Ignore
    }
  });

  it('creates the PID file in the given data directory', () => {
    mkdirSync(tmpDir, { recursive: true });
    writePidFile(tmpDir);

    const pidPath = join(tmpDir, 'talond.pid');
    expect(existsSync(pidPath)).toBe(true);
  });

  it('writes the current process PID to the file', () => {
    mkdirSync(tmpDir, { recursive: true });
    writePidFile(tmpDir);

    const pidPath = join(tmpDir, 'talond.pid');
    const content = readFileSync(pidPath, 'utf-8');
    expect(content).toBe(String(process.pid));
  });

  it('creates the data directory if it does not exist', () => {
    // tmpDir does not exist yet
    writePidFile(tmpDir);

    const pidPath = join(tmpDir, 'talond.pid');
    expect(existsSync(pidPath)).toBe(true);
  });

  it('overwrites an existing PID file', () => {
    mkdirSync(tmpDir, { recursive: true });
    const pidPath = join(tmpDir, 'talond.pid');
    writeFileSync(pidPath, '99999', 'utf-8');

    writePidFile(tmpDir);

    const content = readFileSync(pidPath, 'utf-8');
    expect(content).toBe(String(process.pid));
  });
});

describe('removePidFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `talon-test-${uuid()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it('removes an existing PID file', () => {
    writePidFile(tmpDir);
    const pidPath = join(tmpDir, 'talond.pid');
    expect(existsSync(pidPath)).toBe(true);

    removePidFile(tmpDir);

    expect(existsSync(pidPath)).toBe(false);
  });

  it('is a no-op if the PID file does not exist', () => {
    // Should not throw
    expect(() => removePidFile(tmpDir)).not.toThrow();
  });

  it('is safe to call multiple times', () => {
    writePidFile(tmpDir);
    removePidFile(tmpDir);
    // Second call: file is already gone
    expect(() => removePidFile(tmpDir)).not.toThrow();
  });
});
