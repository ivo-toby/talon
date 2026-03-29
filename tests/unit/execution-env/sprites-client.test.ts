import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpritesClient } from '../../../src/execution-env/sprites-client.js';

const createSprite = vi.fn();
const deleteSprite = vi.fn();
const execFile = vi.fn();
const spawn = vi.fn();
const createSession = vi.fn();
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
        spawn,
        execFile,
        createSession,
        createCheckpoint,
        listCheckpoints,
      };
    }
  }

  return {
    SpritesClient: MockSdkClient,
    ExecError: class MockExecError extends Error {},
  };
});

function createMockCommand() {
  const command = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  command.stdout = new PassThrough();
  command.stderr = new PassThrough();
  command.kill = vi.fn();
  return command;
}

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

  it('rejects baseSnapshot until Sprites supports create-from-snapshot', async () => {
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

    await expect(
      client.create({
        baseSnapshot: 'node-22-bookworm',
        resourceLimits: { cpus: 2, memoryMb: 4096, diskGb: 20 },
        workingDirectory: '/workspace',
        metadata: { ownerTaskId: 'task-1' },
      }),
    ).rejects.toThrow(/baseSnapshot/i);

    expect(createSprite).not.toHaveBeenCalled();
  });

  it('executes commands via bash -lc and maps exec results', async () => {
    spawn.mockImplementation(() => {
      const command = createMockCommand();
      queueMicrotask(() => {
        command.stdout.write('ok\n');
        command.stdout.end();
        command.stderr.end();
        command.emit('exit', 0);
      });
      return command;
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
    expect(spawn).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'npm test'],
      expect.objectContaining({
        cwd: '/workspace',
        env: { CI: '1' },
      }),
    );
  });

  it('maps non-zero exits into stderr/exitCode output', async () => {
    spawn.mockImplementation(() => {
      const command = createMockCommand();
      queueMicrotask(() => {
        command.stdout.write('partial');
        command.stdout.end();
        command.stderr.write('boom');
        command.stderr.end();
        command.emit('exit', 7);
      });
      return command;
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

  it('enforces the per-command timeout for foreground exec', async () => {
    vi.useFakeTimers();
    const command = createMockCommand();
    spawn.mockReturnValue(command);

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

    try {
      const resultPromise = client.exec({
        spriteId: 'sprite-123',
        command: 'sleep 30',
        cwd: '/workspace',
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(resultPromise).resolves.toEqual({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
      });
      expect(command.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the real detached session id instead of a synthetic process id', async () => {
    const command = createMockCommand();
    createSession.mockImplementation(() => {
      queueMicrotask(() => {
        command.emit('message', {
          type: 'session_info',
          session_id: 1847,
        });
      });
      return command;
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
      command: 'npm run dev',
      cwd: '/workspace',
      timeoutMs: 45_000,
      detach: true,
    });

    expect(result).toEqual({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      processId: '1847',
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
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain('/v1/sprites/sprite-123/fs/write');
      expect(init).toEqual(expect.objectContaining({
        method: 'PUT',
      }));
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(tmp, { force: true }));
    }
  });

  it('rejects recursive uploads that exceed the maximum directory depth', async () => {
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

    const root = await mkdtemp(join(tmpdir(), 'sprites-upload-depth-'));
    let current = root;
    try {
      for (let depth = 0; depth < 33; depth += 1) {
        current = join(current, `d${depth}`);
        await mkdir(current);
      }
      await writeFile(join(current, 'file.txt'), 'hello');

      await expect(
        client.upload({
          spriteId: 'sprite-123',
          sourcePath: root,
          destinationPath: '/workspace/deep',
          recursive: true,
        }),
      ).rejects.toThrow(/maximum directory depth/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates a checkpoint by diffing checkpoint listings instead of parsing stream text', async () => {
    createCheckpoint.mockResolvedValue(
      new Response(
        '{"type":"info","data":"Creating checkpoint..."}\n{"type":"complete","data":"Checkpoint created successfully"}\n',
        { status: 200 },
      ),
    );
    listCheckpoints
      .mockResolvedValueOnce([{ id: 'v7', createTime: new Date(), comment: 'earlier' }])
      .mockResolvedValueOnce([
        { id: 'v7', createTime: new Date(), comment: 'earlier' },
        { id: 'v8', createTime: new Date(), comment: 'post-install' },
      ]);

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

  it('rejects restore streams that report an error', async () => {
    const restoreCheckpoint = vi.fn().mockResolvedValue(
      new Response(
        '{"type":"info","data":"Restoring..."}\n{"type":"error","data":"checkpoint not found"}\n',
        { status: 200 },
      ),
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

    (client as any).client.sprite = vi.fn().mockReturnValue({
      name: 'sprite-123',
      spawn,
      execFile,
      createSession,
      createCheckpoint,
      listCheckpoints,
      restoreCheckpoint,
    });

    await expect(
      client.restore({
        spriteId: 'sprite-123',
        remoteRef: 'v8',
      }),
    ).rejects.toThrow(/checkpoint not found/i);
  });

  it('rejects directory downloads with a clear error', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
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

    const destination = join(tmpdir(), 'sprites-download-directory-test.txt');
    await rm(destination, { force: true });

    await expect(
      client.download({
        spriteId: 'sprite-123',
        sourcePath: '/workspace/project',
        destinationPath: destination,
      }),
    ).rejects.toThrow(/directories are not supported/i);
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
      spawn,
      execFile,
      createSession,
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
