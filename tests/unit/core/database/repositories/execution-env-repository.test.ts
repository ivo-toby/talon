import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ExecutionEnvRepository } from '../../../../../src/core/database/repositories/execution-env-repository.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE execution_environments (
      id                TEXT PRIMARY KEY,
      provider          TEXT NOT NULL DEFAULT 'sprites',
      sprite_id         TEXT NOT NULL UNIQUE,
      thread_id         TEXT NOT NULL,
      persona_id        TEXT NOT NULL,
      owner_task_id     TEXT,
      status            TEXT NOT NULL
                        CHECK (status IN ('creating', 'ready', 'busy', 'checkpointing', 'restoring', 'destroying', 'destroyed', 'failed')),
      working_directory TEXT NOT NULL,
      base_snapshot     TEXT,
      auto_destroy      INTEGER NOT NULL DEFAULT 1,
      cpus              REAL NOT NULL,
      memory_mb         INTEGER NOT NULL,
      disk_gb           INTEGER NOT NULL,
      metadata_json     TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      destroyed_at      INTEGER
    );

    CREATE INDEX idx_execution_env_thread_created
      ON execution_environments(thread_id, created_at DESC);
    CREATE INDEX idx_execution_env_owner_task
      ON execution_environments(owner_task_id);
  `);
  return db;
}

describe('ExecutionEnvRepository', () => {
  let db: Database.Database;
  let repo: ExecutionEnvRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ExecutionEnvRepository(db);
  });

  const baseInput = {
    id: 'env-1',
    provider: 'sprites' as const,
    spriteId: 'sprite-1',
    threadId: 'thread-1',
    personaId: 'persona-1',
    ownerTaskId: 'task-1',
    status: 'ready' as const,
    workingDirectory: '/workspace',
    baseSnapshot: 'node-22-bookworm',
    autoDestroy: true,
    resourceLimits: {
      cpus: 2,
      memoryMb: 4096,
      diskGb: 20,
    },
    metadata: {
      label: 'primary',
    },
  };

  it('creates and reads back an execution environment', () => {
    const result = repo.create(baseInput);
    expect(result.isOk()).toBe(true);

    const env = result._unsafeUnwrap();
    expect(env.id).toBe('env-1');
    expect(env.spriteId).toBe('sprite-1');
    expect(env.ownerTaskId).toBe('task-1');
    expect(env.resourceLimits.diskGb).toBe(20);
  });

  it('finds an environment by owner task id', () => {
    repo.create(baseInput);

    const env = repo.findByOwnerTaskId('task-1')._unsafeUnwrap();
    expect(env?.id).toBe('env-1');
  });

  it('updates status and marks environments destroyed', () => {
    repo.create(baseInput);

    expect(repo.updateStatus('env-1', 'busy').isOk()).toBe(true);
    expect(repo.markDestroyed('env-1').isOk()).toBe(true);

    const env = repo.findById('env-1')._unsafeUnwrap();
    expect(env?.status).toBe('destroyed');
    expect(env?.destroyedAt).toBeGreaterThan(0);
  });

  it('returns only active environments from findActive', () => {
    repo.create(baseInput);
    repo.create({
      ...baseInput,
      id: 'env-2',
      spriteId: 'sprite-2',
      ownerTaskId: null,
      status: 'busy',
    });
    repo.create({
      ...baseInput,
      id: 'env-3',
      spriteId: 'sprite-3',
      status: 'destroyed',
    });
    repo.create({
      ...baseInput,
      id: 'env-4',
      spriteId: 'sprite-4',
      status: 'failed',
    });

    const result = repo.findActive();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().map((env) => env.id).sort()).toEqual(['env-1', 'env-2']);
  });
});
