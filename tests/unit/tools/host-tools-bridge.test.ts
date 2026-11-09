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
import type { SignalToolExecutionRegistry } from '../../../src/tools/host-tools/signal-tool-execution.js';

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
  const requestWithDefaultSecret =
    request.context !== undefined && request.bridgeSecret === undefined
      ? { ...request, bridgeSecret: 'bridge-secret-001' }
      : request;
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(requestWithDefaultSecret) + '\n');
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
  const validBridgeSecret = 'bridge-secret-001';

  const registerActiveRunAuth = (): void => {
    bridge.registerRunAuthentication({
      runId: 'run-001',
      threadId: 'thread-001',
      personaId: 'persona-001',
      bridgeSecret: validBridgeSecret,
    });
  };

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
        run: {
          findById: vi.fn().mockImplementation((runId: string) => ok(
            runId === 'run-001'
              ? {
                  id: 'run-001',
                  thread_id: 'thread-001',
                  persona_id: 'persona-001',
                  provider_name: 'claude-code',
                  sandbox_id: null,
                  session_id: null,
                  status: 'running',
                  parent_run_id: null,
                  queue_item_id: null,
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_read_tokens: 0,
                  cache_write_tokens: 0,
                  cost_usd: 0,
                  error: null,
                  started_at: 1,
                  ended_at: null,
                  created_at: 1,
                }
              : null,
          )),
        } as any,
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
              'execution.env',
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
      toolInstructions: new Map(),
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
      executionEnvManager: {
        create: vi.fn().mockResolvedValue(ok({
          id: 'env-1',
          provider: 'sprites',
          spriteId: 'sprite-1',
          threadId: 'thread-001',
          personaId: 'persona-001',
          ownerTaskId: null,
          status: 'ready',
          workingDirectory: '/workspace',
          baseSnapshot: null,
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
        destroy: vi.fn().mockResolvedValue(ok(undefined)),
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
          metadata: '{}',
          created_at: 1,
          updated_at: 1,
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(ok(null)),
      findByChannelId: vi.fn().mockReturnValue(ok([])),
      insert: vi.fn().mockImplementation((row) =>
        ok({
          ...row,
          created_at: 1,
          updated_at: 1,
        }),
      ),
      update: vi.fn().mockReturnValue(ok(null)),
    } as any;
    mockCtx.repos.channel = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'channel-001',
          type: 'telegram',
          name: 'telegram-main',
          config: '{}',
          credentials_ref: null,
          enabled: 1,
          created_at: 1,
          updated_at: 1,
        }),
      ),
      findEnabled: vi.fn().mockReturnValue(ok([
        { id: 'channel-001', name: 'telegram-main' },
        { id: 'channel-002', name: 'slack-general' },
      ])),
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
    it('rejects direct bridge requests without a bridge secret', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.registerRunAuthentication({
        runId: 'run-001',
        threadId: 'thread-001',
        personaId: 'persona-001',
        bridgeSecret: validBridgeSecret,
      });
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const client = createConnection(bridge.path, () => {
          client.write(JSON.stringify({
            id: randomUUID(),
            tool: 'memory_access',
            args: {
              operation: 'list',
            },
            context: {
              runId: 'run-001',
              threadId: 'thread-001',
              personaId: 'persona-001',
              requestId: 'req-001',
            },
          }) + '\n');
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

      expect(response.error).toContain('bridge secret');
    });

    it('rejects requests whose persona does not match the authenticated run context', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.registerRunAuthentication({
        runId: 'run-001',
        threadId: 'thread-001',
        personaId: 'persona-001',
        bridgeSecret: validBridgeSecret,
      });
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'memory_access',
        args: {
          operation: 'list',
        },
        bridgeSecret: validBridgeSecret,
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-999',
          requestId: 'req-001',
        },
      });

      expect(response.error).toContain('persona');
    });

    it('accepts authenticated wrapper requests for the active run context', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.registerRunAuthentication({
        runId: 'run-001',
        threadId: 'thread-001',
        personaId: 'persona-001',
        bridgeSecret: validBridgeSecret,
      });
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'memory_access',
        args: {
          operation: 'list',
        },
        bridgeSecret: validBridgeSecret,
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect((response.result as any)?.status).toBe('success');
    });

    it('dispatches schedule.manage create and returns success', async () => {
      bridge = new HostToolsBridge(mockCtx);
      registerActiveRunAuth();
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
      registerActiveRunAuth();
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

    it('dispatches execution_env destroy when the manager is present', async () => {
      bridge = new HostToolsBridge(mockCtx);
      registerActiveRunAuth();
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'execution_env',
        args: {
          action: 'destroy',
          envId: 'env-1',
        },
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect((response.result as any)?.status).toBe('success');
      expect((response.result as any)?.result).toEqual({ destroyed: true, envId: 'env-1' });
      expect((mockCtx.executionEnvManager as any).destroy).toHaveBeenCalledWith('env-1');
    });

    it('returns error for unknown tool', async () => {
      bridge = new HostToolsBridge(mockCtx);
      registerActiveRunAuth();
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
      registerActiveRunAuth();
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
      registerActiveRunAuth();
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
      registerActiveRunAuth();

      const socket = { write: vi.fn() } as unknown as ReturnType<typeof createConnection>;
      await (bridge as any).handleRequest(
        JSON.stringify({
          id: 'req-001',
          tool: 'skill.load',
          args: {
            name: 'brainstorming',
          },
          bridgeSecret: validBridgeSecret,
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

    it('reports only loadable Talon persona skills when skill.load lookup fails', async () => {
      vi.mocked(mockCtx.personaLoader.getByName).mockReturnValue(ok({
        config: {
          skills: ['brainstorming', 'missing-from-disk'],
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
      registerActiveRunAuth();

      const socket = { write: vi.fn() } as unknown as ReturnType<typeof createConnection>;
      await (bridge as any).handleRequest(
        JSON.stringify({
          id: 'req-001',
          tool: 'skill.load',
          args: {
            name: 'missing-from-disk',
          },
          bridgeSecret: validBridgeSecret,
          context: {
            runId: 'run-001',
            threadId: 'thread-001',
            personaId: 'persona-001',
            requestId: 'req-001',
          },
        }),
        socket,
      );

      const response = JSON.parse((socket.write as any).mock.calls[0]?.[0] as string) as {
        result: { status: string; error: string };
      };

      expect(response.result.status).toBe('error');
      expect(response.result.error).toBe(
        'Talon persona skill "missing-from-disk" not found. Available Talon persona skills: brainstorming',
      );
    });

    it('traces rejected tool calls as failed tool observations', async () => {
      const update = vi.fn();
      mockCtx.observability.observeWithTraceparent = vi.fn(async (_traceparent, _input, fn) =>
        await fn({
          update,
          getTraceparent: vi.fn().mockReturnValue(null),
        }));

      bridge = new HostToolsBridge(mockCtx);
      registerActiveRunAuth();

      const socket = { write: vi.fn() } as unknown as ReturnType<typeof createConnection>;

      await (bridge as any).handleRequest(
        JSON.stringify({
          id: 'req-001',
          tool: 'unknown_tool',
          args: {},
          bridgeSecret: validBridgeSecret,
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
        registerActiveRunAuth();

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
            bridgeSecret: validBridgeSecret,
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

        await vi.advanceTimersByTimeAsync(300_000);

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

  describe('Signal generation sealing', () => {
    const generation = {
      runId: 'run-001',
      threadId: 'thread-001',
      personaId: 'persona-001',
      bridgeSecret: validBridgeSecret,
    };
    const channelSendRequest = (id: string) => ({
      id,
      tool: 'channel_send',
      args: { body: 'hello', externalChatId: 'signal:v1:aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb:self' },
      bridgeSecret: validBridgeSecret,
      context: {
        runId: 'run-001',
        threadId: 'thread-001',
        personaId: 'persona-001',
        requestId: id,
      },
    });
    const channelHandler = (instance: HostToolsBridge): { execute: (...args: unknown[]) => unknown } =>
      (instance as unknown as { channelHandler: { execute: (...args: unknown[]) => unknown } })
        .channelHandler;

    it('resolves Ok promptly when the generation never admitted a channel continuation', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);
      registerActiveRunAuth();

      const sealed = await Promise.race([
        bridge.sealSignalGeneration(generation),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
      ]);

      expect(sealed).not.toBe('timeout');
      expect(sealed).toEqual(expect.objectContaining({ isOk: expect.any(Function) }));
      expect((sealed as { isOk: () => boolean }).isOk()).toBe(true);
    });

    it('waits for an admitted channel send to settle and refuses later admissions', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);
      registerActiveRunAuth();

      let release: ((value: unknown) => void) | undefined;
      const execute = vi
        .spyOn(channelHandler(bridge), 'execute')
        .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      const admitted = sendRequest(bridge.path, channelSendRequest('admitted'));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

      let settled = false;
      const sealing = bridge.sealSignalGeneration(generation).then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);

      const refused = await sendRequest(bridge.path, channelSendRequest('late'));
      expect(refused.result).toEqual(expect.objectContaining({ status: 'error' }));
      expect(execute).toHaveBeenCalledOnce();

      release?.({ requestId: 'admitted', tool: 'channel.send', status: 'success', result: {} });
      expect((await sealing).isOk()).toBe(true);
      expect((await admitted).id).toBe('admitted');
    });

    it('does not seal the run for a generation with a different bridge secret', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);
      registerActiveRunAuth();

      const rejected = await bridge.sealSignalGeneration({
        ...generation,
        bridgeSecret: 'stale-secret',
      });
      expect(rejected.isErr()).toBe(true);

      const execute = vi.spyOn(channelHandler(bridge), 'execute').mockResolvedValue({
        requestId: 'after',
        tool: 'channel.send',
        status: 'success',
        result: {},
      });
      await sendRequest(bridge.path, channelSendRequest('after'));
      expect(execute).toHaveBeenCalledOnce();
    });

    it('keeps waiting for a channel send whose tool response already timed out', async () => {
      vi.useFakeTimers();
      try {
        bridge = new HostToolsBridge(mockCtx);
        registerActiveRunAuth();
        let release: ((value: unknown) => void) | undefined;
        const execute = vi
          .spyOn(channelHandler(bridge), 'execute')
          .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const socket = { write: vi.fn() } as unknown as ReturnType<typeof createConnection>;

        const handled = (bridge as unknown as { handleRequest: (line: string, s: unknown) => Promise<void> })
          .handleRequest(JSON.stringify(channelSendRequest('timed-out')), socket);
        for (let attempt = 0; attempt < 20 && execute.mock.calls.length === 0; attempt++) {
          await Promise.resolve();
        }
        expect(execute).toHaveBeenCalledOnce();

        // Default host-tool budget (5 minutes): the response times out while the handler still runs.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await handled;
        expect((socket.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain('Request timeout');

        let settled = false;
        const sealing = bridge.sealSignalGeneration(generation).then((result) => {
          settled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);

        release?.({ requestId: 'timed-out', tool: 'channel.send', status: 'success', result: {} });
        expect((await sealing).isOk()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('opens a fresh channel gate when the same run re-registers with a new bridge secret (fresh-session retry)', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);
      registerActiveRunAuth();
      const execute = vi.spyOn(channelHandler(bridge), 'execute').mockResolvedValue({
        requestId: 'x',
        tool: 'channel.send',
        status: 'success',
        result: {},
      });

      // Attempt one: sealed and drained before the retry, exactly as AgentRunner does.
      expect((await bridge.sealSignalGeneration(generation)).isOk()).toBe(true);
      const refused = await sendRequest(bridge.path, channelSendRequest('sealed'));
      expect(refused.result).toEqual(expect.objectContaining({ status: 'error' }));
      expect(execute).not.toHaveBeenCalled();

      // Attempt two: the same runId with a new secret is a new generation.
      const retried = { ...generation, bridgeSecret: 'bridge-secret-002' };
      bridge.registerRunAuthentication(retried);
      const sent = await sendRequest(bridge.path, {
        ...channelSendRequest('retry'),
        bridgeSecret: retried.bridgeSecret,
      });

      expect(sent.result).toEqual(expect.objectContaining({ status: 'success' }));
      expect(execute).toHaveBeenCalledOnce();

      // The new generation seals independently, and the old secret can no longer seal it.
      expect((await bridge.sealSignalGeneration(generation)).isErr()).toBe(true);
      expect((await bridge.sealSignalGeneration(retried)).isOk()).toBe(true);
      const refusedAgain = await sendRequest(bridge.path, {
        ...channelSendRequest('after-seal'),
        bridgeSecret: retried.bridgeSecret,
      });
      expect(refusedAgain.result).toEqual(expect.objectContaining({ status: 'error' }));
      expect(execute).toHaveBeenCalledOnce();
    });

    it('passes the shared Signal execution registry to the channel send and broadcast handlers', () => {
      const executions = { invoke: vi.fn() } as unknown as SignalToolExecutionRegistry;
      mockCtx.signalRuntime = { executions, sealAndDrain: vi.fn() } as unknown as DaemonContext['signalRuntime'];
      bridge = new HostToolsBridge(mockCtx);

      expect((bridge as unknown as { channelHandler: { deps: { signalExecutions?: unknown } } }).channelHandler.deps.signalExecutions).toBe(executions);
      expect((bridge as unknown as { channelBroadcastHandler: { deps: { signalExecutions?: unknown } } }).channelBroadcastHandler.deps.signalExecutions).toBe(executions);
    });
  });
});
