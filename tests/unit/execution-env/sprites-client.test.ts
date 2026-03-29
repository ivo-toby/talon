import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecError } from '@fly/sprites';
import { SpritesClient } from '../../../src/execution-env/sprites-client.js';

const createSprite = vi.fn();
const deleteSprite = vi.fn();
const execFile = vi.fn();
const createCheckpoint = vi.fn();
const listCheckpoints = vi.fn();

vi.mock('@fly/sprites', () => {
  class MockSdkClient {
    constructor(_token: string, _options?: unknown) {}

    createSprite = createSprite;
    deleteSprite = deleteSprite;

    sprite(name: string) {
      return {
        name,
        execFile,
        createCheckpoint,
        listCheckpoints,
      };
    }
  }

  return {
    SpritesClient: MockSdkClient,
    ExecError: class MockExecError extends Error {
      result: { stdout: string; stderr: string; exitCode: number };

      constructor(message: string, result: { stdout: string; stderr: string; exitCode: number }) {
        super(message);
        this.result = result;
      }

      get exitCode() {
        return this.result.exitCode;
      }

      get stdout() {
        return this.result.stdout;
      }

      get stderr() {
        return this.result.stderr;
      }
    },
  };
});

describe('SpritesClient adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates a sprite and returns its name as spriteId', async () => {
    createSprite.mockResolvedValue({ name: 'sprite-123' });

    const client = new SpritesClient({
      enabled: true,
      token: 'sprites-token',
      apiBaseUrl: 'https://api.sprites.dev',
      workingDirectory: '/workspace',
      createTimeoutMs: 60_000,
      execTimeoutMs: 120_000,
      autoDestroyOnCompletion: true,
      resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
    } as any);

    const result = await client.create({
      baseSnapshot: 'node-22-bookworm',
      resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
      workingDirectory: '/workspace',
      metadata: { ownerTaskId: 'task-1' },
    });

    expect(result).toEqual({ spriteId: 'sprite-123' });
    expect(createSprite).toHaveBeenCalledWith(
      expect.stringMatching(/^talon-/),
      expect.objectContaining({
        cpus: 2,
        ramMB: 4096,
        storageGB: 20,
      }),
    );
  });

  it('executes commands via bash -lc and maps exec results', async () => {
    execFile.mockResolvedValue({
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
    });

    const client = new SpritesClient({
      enabled: true,
      token: 'sprites-token',
      apiBaseUrl: 'https://api.sprites.dev',
      workingDirectory: '/workspace',
      createTimeoutMs: 60_000,
      execTimeoutMs: 120_000,
      autoDestroyOnCompletion: true,
      resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
    } as any);

    const result = await client.exec({
      spriteId: 'sprite-123',
      command: 'npm test',
      cwd: '/workspace',
      timeoutMs: 45_000,
      env: { CI: '1' },
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
      timedOut: false,
    });
    expect(execFile).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'npm test'],
      expect.objectContaining({
        cwd: '/workspace',
        env: { CI: '1' },
      }),
    );
  });

  it('maps ExecError into stderr/exitCode output', async () => {
    execFile.mockRejectedValue(
      new ExecError('bad exit', {
        stdout: 'partial',
        stderr: 'boom',
        exitCode: 7,
      }),
    );

    const client = new SpritesClient({
      enabled: true,
      token: 'sprites-token',
      apiBaseUrl: 'https://api.sprites.dev',
      workingDirectory: '/workspace',
      createTimeoutMs: 60_000,
      execTimeoutMs: 120_000,
      autoDestroyOnCompletion: true,
      resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
    } as any);

    const result = await client.exec({
      spriteId: 'sprite-123',
      command: 'false',
      cwd: '/workspace',
      timeoutMs: 45_000,
    });

    expect(result).toEqual({
      exitCode: 7,
      stdout: 'partial',
      stderr: 'boom',
      timedOut: false,
    });
  });

  it('uploads file bytes through the filesystem API', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    const client = new SpritesClient({
      enabled: true,
      token: 'sprites-token',
      apiBaseUrl: 'https://api.sprites.dev',
      workingDirectory: '/workspace',
      createTimeoutMs: 60_000,
      execTimeoutMs: 120_000,
      autoDestroyOnCompletion: true,
      resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
    } as any);

    const tmp = '/tmp/sprites-upload-test.txt';
    await import('node:fs/promises').then((fs) => fs.writeFile(tmp, 'hello'));
    try {
      const result = await client.upload({
        spriteId: 'sprite-123',
        sourcePath: tmp,
        destinationPath: '/workspace/file.txt',
      });

      expect(result.bytes).toBe(5);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/v1/sprites/sprite-123/fs/write'),
        expect.objectContaining({
          method: 'PUT',
        }),
      );
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true }));
    }
  });

  it('creates a checkpoint and extracts the checkpoint id from stream output', async () => {
    createCheckpoint.mockResolvedValue(
      new Response(
        '{"type":"info","data":"Creating checkpoint..."}\n{"type":"complete","data":"Checkpoint v8 created successfully"}\n',
        { status: 200 },
      ),
    );
    listCheckpoints.mockResolvedValue([{ id: 'v8', createTime: new Date(), comment: 'post-install' }]);

    const client = new SpritesClient({
      enabled: true,
      token: 'sprites-token',
      apiBaseUrl: 'https://api.sprites.dev',
      workingDirectory: '/workspace',
      createTimeoutMs: 60_000,
      execTimeoutMs: 120_000,
      autoDestroyOnCompletion: true,
      resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
    } as any);

    const result = await client.checkpoint({
      spriteId: 'sprite-123',
      label: 'post-install',
    });

    expect(result).toEqual({ remoteRef: 'v8' });
  });

  it('restores a checkpoint in place on an existing sprite', async () => {
    const restoreCheckpoint = vi.fn().mockResolvedValue(
      new Response(
        '{"type":"info","data":"Restoring..."}\n{"type":"complete","data":"Restore complete"}\n',
        { status: 200 },
      ),
    );
    vi.mocked(createSprite).mockClear();
    const client = new SpritesClient({
      enabled: true,
      token: 'sprites-token',
      apiBaseUrl: 'https://api.sprites.dev',
      workingDirectory: '/workspace',
      createTimeoutMs: 60_000,
      execTimeoutMs: 120_000,
      autoDestroyOnCompletion: true,
      resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
    } as any);

    (client as any).client.sprite = vi.fn().mockReturnValue({
      name: 'sprite-123',
      execFile,
      createCheckpoint,
      listCheckpoints,
      restoreCheckpoint,
    });

    await expect(
      client.restore({
        spriteId: 'sprite-123',
        remoteRef: 'v8',
      }),
    ).resolves.toBeUndefined();
    expect(restoreCheckpoint).toHaveBeenCalledWith('v8');
  });
});
