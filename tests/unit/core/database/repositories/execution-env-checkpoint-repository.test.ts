import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ExecutionEnvCheckpointRepository } from '../../../../../src/core/database/repositories/execution-env-checkpoint-repository.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
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

describe('ExecutionEnvCheckpointRepository', () => {
  let db: Database.Database;
  let repo: ExecutionEnvCheckpointRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ExecutionEnvCheckpointRepository(db);
  });

  it('creates and reads back a checkpoint', () => {
    const result = repo.create({
      id: 'ckpt-1',
      envId: 'env-1',
      provider: 'sprites',
      remoteRef: 'snap-1',
      label: 'post-install',
      status: 'ready',
    });

    expect(result.isOk()).toBe(true);
    const checkpoint = result._unsafeUnwrap();
    expect(checkpoint.id).toBe('ckpt-1');
    expect(checkpoint.envId).toBe('env-1');
    expect(checkpoint.remoteRef).toBe('snap-1');
    expect(checkpoint.label).toBe('post-install');
  });

  it('finds a checkpoint by id', () => {
    repo.create({
      id: 'ckpt-1',
      envId: 'env-1',
      provider: 'sprites',
      remoteRef: 'snap-1',
      label: null,
      status: 'ready',
    });

    const result = repo.findById('ckpt-1');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()?.remoteRef).toBe('snap-1');
  });

  it('lists checkpoints by env id newest first', () => {
    repo.create({
      id: 'ckpt-1',
      envId: 'env-1',
      provider: 'sprites',
      remoteRef: 'snap-1',
      label: null,
      status: 'ready',
    });
    repo.create({
      id: 'ckpt-2',
      envId: 'env-1',
      provider: 'sprites',
      remoteRef: 'snap-2',
      label: 'later',
      status: 'ready',
    });

    const result = repo.findByEnvId('env-1');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().map((checkpoint) => checkpoint.id)).toEqual(['ckpt-2', 'ckpt-1']);
  });
});
