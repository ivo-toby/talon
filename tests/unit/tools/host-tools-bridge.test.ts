/**
 * Unit tests for HostToolsBridge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import type {
  ImageLookupServices,
} from '../../../src/tools/host-tools-bridge.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import type { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import type { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import type {
  ImageLookupAccess,
  ImageLookupFindings,
  ImagePage,
} from '../../../src/tools/host-tools/image-lookup.js';
import type {
  FindingPage,
  FindingRecord,
  FindingRow,
} from '../../../src/core/database/repositories/finding-repository.js';
import { DbError } from '../../../src/core/errors/error-types.js';
import type {
  ImageAccessError,
  ImageAvailability,
  ImageDescriptor,
} from '../../../src/images/image-types.js';
import { ok, err, type Result } from 'neverthrow';

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

// ---------------------------------------------------------------------------
// image.lookup fixtures (deterministic port fakes; no database, no pixels)
// ---------------------------------------------------------------------------

function makeImageDescriptor(overrides: Partial<ImageDescriptor> = {}): ImageDescriptor {
  return {
    imageId: 'img-0001',
    threadId: 'thread-001',
    messageId: 'msg-0001',
    ordinal: 0,
    receivedAt: 1_700_000_100_000,
    expiresAt: 1_700_003_700_000,
    state: 'available',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    dimensions: { width: 1600, height: 1200 },
    ...overrides,
  } as ImageDescriptor;
}

function available(descriptor: ImageDescriptor): Result<ImageAvailability, ImageAccessError> {
  return ok({ state: 'available', available: true, expiresAt: descriptor.expiresAt });
}

/** Minimal Image port fake: one descriptor, never opens a file. */
function makeImageAccess(descriptor: ImageDescriptor): ImageLookupAccess {
  const access: Partial<ImageLookupAccess> = {
    getAvailability: vi
      .fn()
      .mockImplementation((): Promise<Result<ImageAvailability, ImageAccessError>> =>
        Promise.resolve(available(descriptor)),
      ),
    resolveImage: vi
      .fn()
      .mockImplementation((): Promise<Result<ImageDescriptor, ImageAccessError>> =>
        Promise.resolve(ok(descriptor)),
      ),
    // A text lookup must never open a file; reaching this fake is a failure.
    fetchInspectionBytes: vi
      .fn()
      .mockImplementation((): Promise<Result<never, ImageAccessError>> =>
        Promise.resolve(err({ code: 'storage_failed', message: 'pixel load is forbidden' })),
      ),
    findThreadPage: vi
      .fn()
      .mockImplementation((): Promise<Result<ImagePage, ImageAccessError>> =>
        Promise.resolve(ok({ images: [descriptor], nextAnchor: null })),
      ),
  };
  return access as ImageLookupAccess;
}

function makeFindingRecord(): FindingRecord {
  const finding = {
    id: 'fnd-0001',
    run_id: 'run-001',
    thread_id: 'thread-001',
    question: 'What does the dialog say?',
    answer: 'It reports a disk quota error.',
    extracted_text: 'DISK_QUOTA_EXCEEDED',
    uncertainty: null,
    model_name: 'claude-haiku-4-5-20251001',
    usage_input_tokens: 1200,
    usage_output_tokens: 64,
    usage_cache_read_tokens: null,
    usage_cache_write_tokens: null,
    created_at: 1_700_000_200_000,
  } as FindingRow;
  return { finding, imageIds: ['img-0001'] };
}

function makeFindingsPort(record: FindingRecord): ImageLookupFindings {
  const findings: Partial<ImageLookupFindings> = {
    findPage: vi
      .fn()
      .mockReturnValue(ok<FindingPage, DbError>({ findings: [record], nextAnchor: null })),
    findByIdInThread: vi.fn().mockImplementation(
      (findingId: string, threadId: string): Result<FindingRecord | null, DbError> =>
        findingId === record.finding.id && threadId === 'thread-001'
          ? ok(record)
          : ok(null),
    ),
  };
  return findings as ImageLookupFindings;
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

  describe('image.lookup exposure and dispatch', () => {
    const grantImageRead = (): void => {
      vi.mocked(mockCtx.personaLoader.getByName).mockReturnValue(ok({
        config: { skills: [] },
        resolvedCapabilities: {
          allow: ['image.read:thread'],
          requireApproval: [],
        },
      } as any));
    };

    const imageServices = (): ImageLookupServices => ({
      images: makeImageAccess(makeImageDescriptor()),
      findings: makeFindingsPort(makeFindingRecord()),
    });

    it('dispatches image_lookup (MCP name) to the injected services and returns the descriptor', async () => {
      grantImageRead();
      bridge = new HostToolsBridge(mockCtx, imageServices());
      registerActiveRunAuth();
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'image_lookup',
        args: { operation: 'get_image', imageId: 'img-0001' },
        bridgeSecret: validBridgeSecret,
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-image-lookup',
        },
      });

      expect((response.result as any)?.status).toBe('success');
      expect((response.result as any)?.result).toEqual({
        image: expect.objectContaining({ imageId: 'img-0001', state: 'available' }),
      });
    });

    it('also dispatches the internal name image.lookup, still capability-gated', async () => {
      grantImageRead();
      bridge = new HostToolsBridge(mockCtx, imageServices());
      registerActiveRunAuth();
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'image.lookup',
        args: { operation: 'list_findings' },
        bridgeSecret: validBridgeSecret,
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-image-lookup-internal',
        },
      });

      expect((response.result as any)?.status).toBe('success');
      expect((response.result as any)?.result).toEqual({
        findings: [
          expect.objectContaining({ findingId: 'fnd-0001', question: expect.any(String) }),
        ],
        nextCursor: null,
      });
    });

    it('denies image_lookup for a persona without image.read (no capability = no tool)', async () => {
      // mockCtx.personaLoader grants schedule/channel/memory/net/db/execution/
      // background — but NOT image.read:thread.
      bridge = new HostToolsBridge(mockCtx, imageServices());
      registerActiveRunAuth();
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'image_lookup',
        args: { operation: 'list_images' },
        bridgeSecret: validBridgeSecret,
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-image-lookup-denied',
        },
      });

      expect((response.result as any)?.status).toBe('error');
      expect((response.result as any)?.error).toContain('not allowed');
    });

    it('denies the internal name image.lookup the same way (no bypass by name)', async () => {
      bridge = new HostToolsBridge(mockCtx, imageServices());
      registerActiveRunAuth();
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'image.lookup',
        args: { operation: 'list_images' },
        bridgeSecret: validBridgeSecret,
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-image-lookup-denied-internal',
        },
      });

      expect((response.result as any)?.status).toBe('error');
      expect((response.result as any)?.error).toContain('not allowed');
    });

    it('exposes image.lookup under requireApproval and still dispatches it', async () => {
      vi.mocked(mockCtx.personaLoader.getByName).mockReturnValue(ok({
        config: { skills: [] },
        resolvedCapabilities: {
          allow: [],
          requireApproval: ['image.read:thread'],
        },
      } as any));
      bridge = new HostToolsBridge(mockCtx, imageServices());
      registerActiveRunAuth();
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'image_lookup',
        args: { operation: 'get_finding', findingId: 'fnd-0001' },
        bridgeSecret: validBridgeSecret,
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-image-lookup-approval',
        },
      });

      expect((response.result as any)?.status).toBe('success');
      expect((response.result as any)?.result).toEqual({
        finding: expect.objectContaining({ findingId: 'fnd-0001', answer: expect.any(String) }),
      });
    });

    it('fails explicitly when the persona has image.read but no lookup services are wired', async () => {
      grantImageRead();
      // No second constructor argument: the final wiring (TASK-019) has not run.
      bridge = new HostToolsBridge(mockCtx);
      registerActiveRunAuth();
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'image_lookup',
        args: { operation: 'list_images' },
        bridgeSecret: validBridgeSecret,
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-image-lookup-missing-service',
        },
      });

      const result = response.result as any;
      expect(result?.status).toBe('error');
      expect(result?.error).toContain('not initialized');
      // No fabricated empty success.
      expect(result?.result).toBeUndefined();
      expect(result?.result?.images).toBeUndefined();
    });

    it('re-checks the capability in-handler even when the bridge gate is bypassed', async () => {
      // Persona without image.read, but call the handler entry directly (the
      // internal dispatch path) with services present. The handler must still
      // refuse: capability is re-validated per call, not trusted from exposure.
      bridge = new HostToolsBridge(mockCtx, imageServices());

      const result = await (bridge as any).dispatch(
        'image.lookup',
        { operation: 'list_images' },
        {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-image-lookup-recheck',
        },
      );

      expect(result.status).toBe('error');
      expect(result.error).toContain('image.read:thread');
    });
  });
});
