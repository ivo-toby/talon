import { describe, expect, it, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { ExecutionEnvHandler } from '../../../../src/tools/host-tools/execution-env.js';
import { ExecutionEnvError } from '../../../../src/core/errors/error-types.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

describe('ExecutionEnvHandler', () => {
  it('creates an environment owned by the background task in context', async () => {
    const manager = {
      create: vi.fn().mockResolvedValue(ok({
        id: 'env-1',
        provider: 'sprites',
        spriteId: 'sprite-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        ownerTaskId: 'task-1',
        status: 'ready',
        workingDirectory: '/workspace',
        baseSnapshot: 'node-22-bookworm',
        autoDestroy: true,
        resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
        metadata: null,
        createdAt: 1,
        updatedAt: 1,
        destroyedAt: null,
      })),
      exec: vi.fn(),
      upload: vi.fn(),
      download: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      destroy: vi.fn(),
    };

    const handler = new ExecutionEnvHandler({
      executionEnvManager: manager as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {
        action: 'create',
        baseSnapshot: 'node-22-bookworm',
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
        backgroundTaskId: 'task-1',
      },
    );

    expect(result.status).toBe('success');
    expect(manager.create).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        personaId: 'persona-1',
        ownerTaskId: 'task-1',
        baseSnapshot: 'node-22-bookworm',
      }),
    );
  });

  it('passes allowed host roots from context to upload', async () => {
    const manager = {
      create: vi.fn(),
      exec: vi.fn(),
      upload: vi.fn().mockResolvedValue(ok({
        direction: 'upload',
        envId: 'env-1',
        sourcePath: '/tmp/task-control/file.txt',
        destinationPath: '/workspace/file.txt',
        bytes: 64,
      })),
      download: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      destroy: vi.fn(),
    };

    const handler = new ExecutionEnvHandler({
      executionEnvManager: manager as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {
        action: 'upload',
        envId: 'env-1',
        sourcePath: 'file.txt',
        destinationPath: '/workspace/file.txt',
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
        allowedHostRoots: ['/tmp/task-control'],
      },
    );

    expect(result.status).toBe('success');
    expect(manager.upload).toHaveBeenCalledWith({
      envId: 'env-1',
      sourcePath: 'file.txt',
      destinationPath: '/workspace/file.txt',
      allowedHostRoots: ['/tmp/task-control'],
    });
  });

  it('returns an error when required fields are missing', async () => {
    const handler = new ExecutionEnvHandler({
      executionEnvManager: {
        create: vi.fn(),
        exec: vi.fn(),
        upload: vi.fn(),
        download: vi.fn(),
        checkpoint: vi.fn(),
        restore: vi.fn(),
        destroy: vi.fn(),
      } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {
        action: 'destroy',
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('envId');
  });

  it('surfaces manager errors', async () => {
    const handler = new ExecutionEnvHandler({
      executionEnvManager: {
        create: vi.fn(),
        exec: vi.fn(),
        upload: vi.fn(),
        download: vi.fn(),
        checkpoint: vi.fn(),
        restore: vi.fn(),
        destroy: vi.fn().mockResolvedValue(
          err(new ExecutionEnvError('execution_env: [ENV_NOT_FOUND] env "env-404" not found')),
        ),
      } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {
        action: 'destroy',
        envId: 'env-404',
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('ENV_NOT_FOUND');
  });

  it('routes checkpoint and restore actions', async () => {
    const handler = new ExecutionEnvHandler({
      executionEnvManager: {
        create: vi.fn(),
        exec: vi.fn(),
        upload: vi.fn(),
        download: vi.fn(),
        checkpoint: vi.fn().mockResolvedValue(
          err(new ExecutionEnvError('execution_env: [SPRITES_CHECKPOINT_FAILED] not yet implemented')),
        ),
        restore: vi.fn().mockResolvedValue(
          err(new ExecutionEnvError('execution_env: [SPRITES_RESTORE_FAILED] not yet implemented')),
        ),
        destroy: vi.fn(),
      } as any,
      logger: makeLogger(),
    });

    const checkpointResult = await handler.execute(
      { action: 'checkpoint', envId: 'env-1', label: 'post-install' } as any,
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );
    expect(checkpointResult.status).toBe('error');
    expect(checkpointResult.error).toContain('SPRITES_CHECKPOINT_FAILED');

    const restoreResult = await handler.execute(
      { action: 'restore', checkpointId: 'ckpt-1' } as any,
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );
    expect(restoreResult.status).toBe('error');
    expect(restoreResult.error).toContain('SPRITES_RESTORE_FAILED');
  });

  it('rejects invalid resourceLimits before calling the manager', async () => {
    const manager = {
      create: vi.fn(),
      exec: vi.fn(),
      upload: vi.fn(),
      download: vi.fn(),
      checkpoint: vi.fn(),
      restore: vi.fn(),
      destroy: vi.fn(),
    };
    const handler = new ExecutionEnvHandler({
      executionEnvManager: manager as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {
        action: 'create',
        resourceLimits: {
          cpus: -1,
        },
      } as any,
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('resourceLimits');
    expect(manager.create).not.toHaveBeenCalled();
  });
});
