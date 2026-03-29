import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { err } from 'neverthrow';
import { ExecutionEnvCheckpointRepository } from '../../../src/core/database/repositories/execution-env-checkpoint-repository.js';
import { ExecutionEnvRepository } from '../../../src/core/database/repositories/execution-env-repository.js';
import { ExecutionEnvManager } from '../../../src/execution-env/execution-env-manager.js';
import { DbError } from '../../../src/core/errors/index.js';

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

    CREATE TABLE execution_env_checkpoints (
      id          TEXT PRIMARY KEY,
      env_id      TEXT NOT NULL,
      provider    TEXT NOT NULL DEFAULT 'sprites',
      remote_ref  TEXT NOT NULL,
      label       TEXT,
      status      TEXT NOT NULL
                  CHECK (status IN ('creating', 'ready', 'failed')),
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX idx_execution_env_checkpoints_env_created
      ON execution_env_checkpoints(env_id, created_at DESC);
  `);
  return db;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

describe('ExecutionEnvManager', () => {
  let repository: ExecutionEnvRepository;
  let checkpointRepository: ExecutionEnvCheckpointRepository;
  let client: {
    create: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
    checkpoint: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    const db = createTestDb();
    repository = new ExecutionEnvRepository(db);
    checkpointRepository = new ExecutionEnvCheckpointRepository(db);
    client = {
      create: vi.fn().mockResolvedValue({ spriteId: 'sprite-123' }),
      exec: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'done',
        stderr: '',
        timedOut: false,
      }),
      upload: vi.fn().mockResolvedValue({ bytes: 128 }),
      download: vi.fn().mockResolvedValue({ bytes: 256 }),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
  });

  function createManager() {
    return new ExecutionEnvManager({
      repository,
      checkpointRepository,
      client,
      defaultWorkingDirectory: '/workspace',
      defaultExecTimeoutMs: 45_000,
      defaultResourceLimits: {
        cpus: 2,
        memoryMb: 4096,
        diskGb: 20,
      },
      logger: makeLogger(),
    });
  }

  it('creates and persists a ready execution environment', async () => {
    const manager = createManager();

    const result = await manager.create({
      threadId: 'thread-1',
      personaId: 'persona-1',
      ownerTaskId: 'task-1',
      baseSnapshot: 'node-22-bookworm',
      metadata: { purpose: 'primary' },
    });

    expect(result.isOk()).toBe(true);
    const env = result._unsafeUnwrap();
    expect(env.status).toBe('ready');
    expect(env.spriteId).toBe('sprite-123');
    expect(env.ownerTaskId).toBe('task-1');
    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: '/workspace',
        metadata: expect.objectContaining({
          threadId: 'thread-1',
          personaId: 'persona-1',
          ownerTaskId: 'task-1',
        }),
      }),
    );
  });

  it('destroys an environment and marks it destroyed in the repository', async () => {
    const manager = createManager();

    const env = (await manager.create({
      threadId: 'thread-1',
      personaId: 'persona-1',
    }))._unsafeUnwrap();

    const destroyResult = await manager.destroy(env.id);
    expect(destroyResult.isOk()).toBe(true);
    expect(client.destroy).toHaveBeenCalledWith('sprite-123');

    const stored = repository.findById(env.id)._unsafeUnwrap();
    expect(stored?.status).toBe('destroyed');
  });

  it('rejects uploads outside allowed host roots', async () => {
    const manager = createManager();

    const env = (await manager.create({
      threadId: 'thread-1',
      personaId: 'persona-1',
    }))._unsafeUnwrap();

    const uploadResult = await manager.upload({
      envId: env.id,
      sourcePath: '/etc/passwd',
      destinationPath: '/workspace/passwd',
      allowedHostRoots: ['/tmp/task-control'],
    });

    expect(uploadResult.isErr()).toBe(true);
    expect(uploadResult._unsafeUnwrapErr().message).toContain('HOST_PATH_NOT_ALLOWED');
  });

  it('uses the configured default exec timeout when none is provided', async () => {
    const manager = createManager();

    const env = (await manager.create({
      threadId: 'thread-1',
      personaId: 'persona-1',
    }))._unsafeUnwrap();

    const result = await manager.exec({
      envId: env.id,
      command: 'npm test',
    });

    expect(result.isOk()).toBe(true);
    expect(client.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 45_000,
      }),
    );
  });

  it('destroys auto-destroy environments owned by a task', async () => {
    const manager = createManager();

    const env = (await manager.create({
      threadId: 'thread-1',
      personaId: 'persona-1',
      ownerTaskId: 'task-1',
    }))._unsafeUnwrap();

    await manager.destroyOwnedByTask('task-1');

    const stored = repository.findById(env.id)._unsafeUnwrap();
    expect(stored?.status).toBe('destroyed');
  });

  it('recovers orphaned environments by destroying active auto-destroy envs', async () => {
    const manager = createManager();

    const env = (await manager.create({
      threadId: 'thread-1',
      personaId: 'persona-1',
      ownerTaskId: 'task-1',
    }))._unsafeUnwrap();

    await manager.recoverOrphanedEnvironments();

    const stored = repository.findById(env.id)._unsafeUnwrap();
    expect(stored?.status).toBe('destroyed');
  });

  it('exposes checkpoint and restore actions with not-yet-implemented errors', async () => {
    client.checkpoint.mockResolvedValue({ remoteRef: 'snap-1' });
    client.restore.mockResolvedValue(undefined);
    const manager = createManager();
    const env = (await manager.create({
      threadId: 'thread-1',
      personaId: 'persona-1',
    }))._unsafeUnwrap();

    const checkpointResult = await manager.checkpoint({
      envId: env.id,
      label: 'post-install',
    });
    expect(checkpointResult.isOk()).toBe(true);
    expect(checkpointResult._unsafeUnwrap()).toEqual(
      expect.objectContaining({
        envId: env.id,
        remoteRef: 'snap-1',
        label: 'post-install',
        status: 'ready',
      }),
    );

    const restoreResult = await manager.restore({
      envId: env.id,
      checkpointId: checkpointResult._unsafeUnwrap().id,
    });
    expect(restoreResult.isOk()).toBe(true);
    expect(restoreResult._unsafeUnwrap()).toEqual(
      expect.objectContaining({
        id: env.id,
        spriteId: 'sprite-123',
        baseSnapshot: null,
        status: 'ready',
      }),
    );
    expect(client.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        spriteId: 'sprite-123',
        remoteRef: 'snap-1',
      }),
    );
  });

  it('destroys a created sprite if repository persistence fails', async () => {
    const failingRepository = {
      create: vi.fn().mockReturnValue(err(new DbError('insert failed'))),
    };
    const manager = new ExecutionEnvManager({
      repository: failingRepository as any,
      client,
      defaultWorkingDirectory: '/workspace',
      defaultExecTimeoutMs: 45_000,
      defaultResourceLimits: {
        cpus: 2,
        memoryMb: 4096,
        diskGb: 20,
      },
      logger: makeLogger(),
    });

    const result = await manager.create({
      threadId: 'thread-1',
      personaId: 'persona-1',
    });

    expect(result.isErr()).toBe(true);
    expect(client.destroy).toHaveBeenCalledWith('sprite-123');
  });
});
