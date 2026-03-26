/**
 * Unit tests for HostToolsBridge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import type { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import type { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import { ok } from 'neverthrow';

// Mock createDatabase so it doesn't try to open a real file for the readonly connection.
// Returns an err() result so the bridge falls back to the main ctx.db connection.
vi.mock('../../../src/core/database/connection.js', async () => {
  const { err: errFn } = await import('neverthrow');
  const { DbError } = await import('../../../src/core/errors/index.js');
  return {
    createDatabase: vi.fn().mockReturnValue(errFn(new DbError('test: no real db'))),
  };
});

/** Helper: send an NDJSON request to the bridge and wait for the response. */
function sendRequest(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(request) + '\n');
    });

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      const idx = data.indexOf('\n');
      if (idx !== -1) {
        const line = data.slice(0, idx);
        client.end();
        resolve(JSON.parse(line));
      }
    });

    client.on('error', reject);
    setTimeout(() => {
      client.end();
      reject(new Error('Timeout waiting for response'));
    }, 5000);
  });
}

/** Helper: wait for the bridge socket to be ready. */
function waitForSocket(socketPath: string, maxMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      const client = createConnection(socketPath, () => {
        client.end();
        resolve();
      });
      client.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Socket not ready'));
        } else {
          setTimeout(check, 50);
        }
      });
    };
    check();
  });
}

describe('HostToolsBridge', () => {
  let bridge: HostToolsBridge;
  let mockCtx: DaemonContext;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `host-tools-bridge-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });

    const mockScheduleRepo = {
      insert: vi.fn().mockReturnValue(ok({})),
      update: vi.fn().mockReturnValue(ok({})),
      disable: vi.fn().mockReturnValue(ok(undefined)),
    } as unknown as ScheduleRepository;

    const mockChannelRegistry = {
      get: vi.fn().mockReturnValue(null),
    } as unknown as ChannelRegistry;

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    mockCtx = {
      db: {} as any,
      config: { storage: { path: ':memory:' } } as any,
      configPath: '',
      dataDir: tempDir,
      repos: {
        schedule: mockScheduleRepo,
        queue: {} as any,
        thread: {} as any,
        channel: {} as any,
        persona: {
          findById: vi.fn().mockReturnValue(ok({ id: 'test-persona', name: 'test' })),
        } as any,
        backgroundTask: {} as any,
        audit: {} as any,
        message: {} as any,
        run: {} as any,
        binding: {} as any,
        memory: {
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockReturnValue(ok([])),
          insert: vi.fn().mockReturnValue(ok({})),
          update: vi.fn().mockReturnValue(ok(null)),
          delete: vi.fn().mockReturnValue(ok(undefined)),
        } as any,
      },
      channelRegistry: mockChannelRegistry,
      queueManager: {} as any,
      scheduler: {} as any,
      personaLoader: {
        getByName: vi.fn().mockReturnValue(ok({
          config: { skills: [] },
          systemPromptContent: 'Base system prompt.',
          personalityContent: 'Friendly personality.',
          resolvedCapabilities: {
            allow: [
              'schedule.manage',
              'channel.send:*',
              'memory.access',
              'net.http',
              'db.query',
              'subagent.background',
            ],
            requireApproval: [],
          },
        })),
      } as any,
      sessionTracker: {} as any,
      threadWorkspace: {} as any,
      auditLogger: {} as any,
      skillResolver: {
        mergePromptFragments: vi.fn().mockReturnValue(''),
        collectMcpServers: vi.fn().mockReturnValue([]),
      } as any,
      loadedSkills: [],
      messagePipeline: {} as any,
      observability: {
        observe: vi.fn(async (_input, fn) => await fn({
          update: vi.fn(),
          getTraceparent: vi.fn().mockReturnValue(null),
        })),
        observeWithTraceparent: vi.fn(async (_traceparent, _input, fn) => await fn({
          update: vi.fn(),
          getTraceparent: vi.fn().mockReturnValue(null),
        })),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as any,
      backgroundAgentManager: {
        spawn: vi.fn().mockReturnValue(ok('bg-task-1')),
        listTasksForThread: vi.fn().mockReturnValue(ok([])),
        getTask: vi.fn().mockReturnValue(ok(null)),
        cancel: vi.fn().mockReturnValue(ok(false)),
        getResult: vi.fn().mockReturnValue(ok(null)),
      } as any,
      contextAssembler: {
        assemble: vi.fn().mockReturnValue({
          text: 'Previous thread summary.',
          summaryFound: true,
          recentMessageCount: 0,
          charCount: 24,
        }),
      } as any,
      hostToolsBridge: {} as any,
      logger: mockLogger as any,
    };

    mockCtx.repos.thread = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'thread-001',
          channel_id: 'channel-001',
          external_id: 'telegram-thread-001',
        }),
      ),
    } as any;
    mockCtx.repos.channel = {
      findById: vi.fn().mockReturnValue(ok({ id: 'channel-001', name: 'telegram-main' })),
    } as any;
  });

  afterEach(async () => {
    if (bridge) {
      bridge.stop();
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('start/stop', () => {
    it('starts and creates socket, reports correct path', async () => {
      bridge = new HostToolsBridge(mockCtx);
      expect(bridge.path).toBe(join(tempDir, 'host-tools.sock'));

      bridge.start();
      await waitForSocket(bridge.path);

      expect(mockCtx.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: bridge.path }),
        'host-tools-bridge: starting',
      );
    });

    it('stops cleanly', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      bridge.stop();
      // Give the close callback time to fire.
      await new Promise((r) => setTimeout(r, 100));

      expect(mockCtx.logger.info).toHaveBeenCalledWith('host-tools-bridge: stopped');
    });
  });

  describe('dispatch', () => {
    it('dispatches schedule.manage create and returns success', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'schedule_manage',
        args: {
          action: 'create',
          cronExpr: '0 9 * * *',
          label: 'Test schedule',
        },
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect(response.result).toBeDefined();
      expect((response.result as any)?.status).toBe('success');
    });

    it('dispatches background_agent spawn when the manager is present', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'background_agent',
        args: {
          action: 'spawn',
          prompt: 'Refactor the auth module',
          workingDirectory: '/workspace/repo',
        },
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect(response.result).toBeDefined();
      expect((response.result as any)?.status).toBe('success');
      expect((response.result as any)?.result).toEqual({ taskId: 'bg-task-1' });
      expect((mockCtx.backgroundAgentManager as any).spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Refactor the auth module',
          threadId: 'thread-001',
          channelName: 'telegram-main',
        }),
      );
    });

    it('returns error for unknown tool', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'unknown_tool',
        args: {},
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect((response.result as any)?.status).toBe('error');
      expect((response.result as any)?.error).toContain('not allowed');
    });

    it('returns error for malformed JSON', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const client = createConnection(bridge.path, () => {
          client.write('not valid json\n');
        });

        let data = '';
        client.on('data', (chunk) => {
          data += chunk.toString();
          const idx = data.indexOf('\n');
          if (idx !== -1) {
            client.end();
            resolve(JSON.parse(data.slice(0, idx)));
          }
        });

        client.on('error', reject);
        setTimeout(() => {
          client.end();
          reject(new Error('Timeout'));
        }, 5000);
      });

      expect(response.error).toBe('Invalid JSON');
    });

    it('dispatches memory.access to the memory handler', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'memory_access',
        args: { operation: 'list' },
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect((response.result as any)?.status).toBe('success');
      expect((response.result as any)?.result).toHaveProperty('items');
    });

    it('wraps tool dispatch in an observation using the incoming traceparent', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'schedule_manage',
        args: {
          action: 'list',
        },
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      });

      expect(mockCtx.observability.observeWithTraceparent).toHaveBeenCalledWith(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        expect.objectContaining({
          type: 'tool',
          name: 'schedule.manage',
          metadata: expect.objectContaining({
            runId: 'run-001',
            threadId: 'thread-001',
            personaId: 'persona-001',
          }),
        }),
        expect.any(Function),
      );
    });

    it('dispatches skill.load before capability checks for persona-owned skills', async () => {
      vi.mocked(mockCtx.personaLoader.getByName).mockReturnValue(ok({
        config: {
          skills: ['brainstorming'],
        },
        resolvedCapabilities: {
          allow: [],
          requireApproval: [],
        },
      } as any));
      mockCtx.loadedSkills = [
        {
          manifest: { name: 'brainstorming' },
          promptContents: ['Line 1', 'Line 2'],
        },
      ] as any;

      bridge = new HostToolsBridge(mockCtx);

      const socket = { write: vi.fn() } as unknown as ReturnType<typeof createConnection>;
      await (bridge as any).handleRequest(
        JSON.stringify({
          id: 'req-001',
          tool: 'skill.load',
          args: {
            name: 'brainstorming',
          },
          context: {
            runId: 'run-001',
            threadId: 'thread-001',
            personaId: 'persona-001',
            requestId: 'req-001',
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          },
        }),
        socket,
      );

      expect((socket.write as any).mock.calls[0]?.[0]).toContain('"status":"success"');
      expect((socket.write as any).mock.calls[0]?.[0]).toContain('Line 1\\nLine 2');
      expect(mockCtx.observability.observeWithTraceparent).not.toHaveBeenCalled();
    });

    it('traces rejected tool calls as failed tool observations', async () => {
      const update = vi.fn();
      mockCtx.observability.observeWithTraceparent = vi.fn(async (_traceparent, _input, fn) =>
        await fn({
          update,
          getTraceparent: vi.fn().mockReturnValue(null),
        }));

      bridge = new HostToolsBridge(mockCtx);

      const socket = { write: vi.fn() } as unknown as ReturnType<typeof createConnection>;

      await (bridge as any).handleRequest(
        JSON.stringify({
          id: 'req-001',
          tool: 'unknown_tool',
          args: {},
          context: {
            runId: 'run-001',
            threadId: 'thread-001',
            personaId: 'persona-001',
            requestId: 'req-001',
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          },
        }),
        socket,
      );

      expect(mockCtx.observability.observeWithTraceparent).toHaveBeenCalledWith(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        expect.objectContaining({
          type: 'tool',
          name: 'unknown_tool',
        }),
        expect.any(Function),
      );
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'ERROR',
          statusMessage: expect.stringContaining('not allowed'),
        }),
      );
      expect((socket.write as any).mock.calls[0]?.[0]).toContain('"status":"error"');
    });

    it('records a timeout as the final tool observation outcome', async () => {
      vi.useFakeTimers();
      try {
        const update = vi.fn();
        mockCtx.observability.observeWithTraceparent = vi.fn(async (_traceparent, _input, fn) =>
          await fn({
            update,
            getTraceparent: vi.fn().mockReturnValue(null),
          }));

        bridge = new HostToolsBridge(mockCtx);

        let resolveDispatch!: (result: unknown) => void;
        (bridge as any).dispatch = vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveDispatch = resolve;
            }),
        );

        const socket = { write: vi.fn() } as unknown as ReturnType<typeof createConnection>;
        const handlePromise = (bridge as any).handleRequest(
          JSON.stringify({
            id: 'req-timeout',
            tool: 'schedule_manage',
            args: { action: 'list' },
            context: {
              runId: 'run-001',
              threadId: 'thread-001',
              personaId: 'persona-001',
              requestId: 'req-timeout',
              traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            },
          }),
          socket,
        );

        await vi.advanceTimersByTimeAsync(30_000);

        expect((socket.write as any).mock.calls[0]?.[0]).toContain('"error":"Request timeout"');

        resolveDispatch({
          requestId: 'req-timeout',
          tool: 'schedule.manage',
          status: 'success',
          result: { ok: true },
        });

        await handlePromise;

        expect(update.mock.calls.at(-1)?.[0]).toEqual(
          expect.objectContaining({
            level: 'ERROR',
            statusMessage: 'Request timeout',
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
