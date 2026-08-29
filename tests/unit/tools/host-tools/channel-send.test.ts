/**
 * Unit tests for ChannelSendHandler.
 *
 * Tests cover:
 *   - Successful message send
 *   - Missing/invalid channelId
 *   - Missing/invalid content
 *   - Channel not found in registry
 *   - Connector send failure
 *   - Optional replyTo field
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { ChannelSendHandler } from '../../../../src/tools/host-tools/channel-send.js';
import type { ChannelSendArgs, ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import { ChannelError } from '../../../../src/core/errors/error-types.js';
import type { ChannelRegistry } from '../../../../src/channels/channel-registry.js';
import type { ChannelConnector } from '../../../../src/channels/channel-types.js';
import {
  LifecycleInterceptorEnvelopeSchema,
  type LifecycleInterceptorEnvelope,
} from '../../../../src/lifecycle/contracts/index.js';
import { MAX_LIFECYCLE_CONTENT_LENGTH } from '../../../../src/lifecycle/contracts/event-contract.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThreadRepo() {
  return {
    findById: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
  } as any;
}

function makeChannelRepo() {
  return {
    findByName: vi.fn().mockReturnValue(ok({
      id: 'chan-001',
      type: 'telegram',
      name: 'my-telegram',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
      created_at: 0,
      updated_at: 0,
    })),
  } as any;
}

function makeMessageRepo() {
  return {
    insert: vi.fn().mockReturnValue(ok({})),
  } as any;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeArgs(overrides: Partial<ChannelSendArgs> = {}): ChannelSendArgs {
  return {
    channelId: 'my-telegram',
    content: 'Hello from persona!',
    ...overrides,
  };
}

function makeConnector(sendResult: ReturnType<typeof ok | typeof err> = ok(undefined)): ChannelConnector {
  return {
    type: 'telegram',
    name: 'my-telegram',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(sendResult),
    format: vi.fn((s: string) => s),
  };
}

function makeRegistry(connector?: ChannelConnector): ChannelRegistry {
  return {
    get: vi.fn().mockReturnValue(connector),
    register: vi.fn(),
    unregister: vi.fn(),
    getByType: vi.fn(),
    listAll: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ChannelRegistry;
}

function makePersonaRepo() {
  return {
    findById: vi.fn().mockReturnValue(ok({ id: 'persona-001', name: 'assistant' })),
  } as any;
}

function makeLifecycleRuntime() {
  return {
    intercept: vi.fn((_invocation, input: LifecycleInterceptorEnvelope) =>
      ok({ outcome: 'allow' as const, input, signals: [] }),
    ),
    publish: vi.fn(() => ok({})),
  };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(ChannelSendHandler.manifest.name).toBe('channel.send');
  });

  it('has executionLocation set to host', () => {
    expect(ChannelSendHandler.manifest.executionLocation).toBe('host');
  });

  it('declares channel.send:* capability', () => {
    expect(ChannelSendHandler.manifest.capabilities).toContain('channel.send:*');
  });
});

// ---------------------------------------------------------------------------
// Successful execution
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — success', () => {
  it('sends a message and returns success result', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.tool).toBe('channel.send');
    expect(result.requestId).toBe('req-001');
    expect(result.result).toEqual({ channelId: 'my-telegram', sent: true });
  });

  it('calls connector.send with thread-scoped externalThreadId', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    await handler.execute(makeArgs(), makeContext({ threadId: 'thread-xyz' }));

    expect(connector.send).toHaveBeenCalledWith('ext-001', expect.objectContaining({ body: 'Hello from persona!' }));
  });

  it('passes replyTo in the output metadata', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    await handler.execute(makeArgs({ replyTo: 'msg-123' }), makeContext());

    expect(connector.send).toHaveBeenCalledWith(
      'ext-001',
      expect.objectContaining({ metadata: { replyTo: 'msg-123' } }),
    );
  });

  it('uses unknown as requestId when context.requestId is not provided', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const context = makeContext();
    delete (context as Partial<ToolExecutionContext>).requestId;
    const result = await handler.execute(makeArgs(), context);

    expect(result.requestId).toBe('unknown');
  });

  it('runs message.before_send before delivery and publishes message.sent on success', async () => {
    const lifecycleRuntime = makeLifecycleRuntime();
    lifecycleRuntime.intercept.mockImplementation((_invocation, input: LifecycleInterceptorEnvelope) =>
      ok({
        outcome: 'allow' as const,
        input: {
          ...input,
          input: {
            ...input.input,
            content: 'Lifecycle transformed',
          },
        },
        signals: [],
      }),
    );
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepo(),
      personaRepository: makePersonaRepo(),
      lifecycleRuntime: lifecycleRuntime as any,
      logger: makeLogger(),
    } as any);

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith(
      'ext-001',
      expect.objectContaining({ body: 'Lifecycle transformed' }),
    );
    expect(lifecycleRuntime.intercept).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: 'assistant',
        hook: 'message.before_send',
        itemOrigin: 'tool',
        itemType: 'message',
        messageSource: 'outbound',
      }),
      expect.objectContaining({
        hook: 'message.before_send',
        input: expect.objectContaining({
          content: 'Hello from persona!',
          recipientId: 'ext-001',
        }),
      }),
    );
    expect(lifecycleRuntime.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: 'message.sent.v1' }),
        persona: 'assistant',
        itemOrigin: 'tool',
        itemType: 'message',
        messageSource: 'outbound',
      }),
    );
  });

  it('returns an error without sending when message.before_send denies delivery', async () => {
    const lifecycleRuntime = makeLifecycleRuntime();
    lifecycleRuntime.intercept.mockReturnValue(
      ok({
        outcome: 'deny' as const,
        reason: 'blocked outbound',
        input: {
          version: 'v1',
          interceptionId: 'interception-001',
          hook: 'message.before_send',
          context: {
            aggregate: { type: 'message', id: 'message-001' },
            correlationId: 'run-001',
            recursion: { depth: 0, maxDepth: 8 },
            provenance: { source: 'tool', sourceEventIds: [], sourceReferences: [] },
          },
          input: {
            messageId: 'message-001',
            content: 'Hello from persona!',
            source: 'outbound',
            recipientId: 'ext-001',
          },
        } as LifecycleInterceptorEnvelope,
        signals: [],
      }),
    );
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepo(),
      personaRepository: makePersonaRepo(),
      lifecycleRuntime: lifecycleRuntime as any,
      logger: makeLogger(),
    } as any);

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toContain('blocked outbound');
    expect(connector.send).not.toHaveBeenCalled();
    expect(lifecycleRuntime.publish).not.toHaveBeenCalled();
  });

  it('bounds lifecycle input but sends original over-limit content when unchanged', async () => {
    const longContent = 'C'.repeat(MAX_LIFECYCLE_CONTENT_LENGTH + 1024);
    const lifecycleRuntime = makeLifecycleRuntime();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepo(),
      personaRepository: makePersonaRepo(),
      lifecycleRuntime: lifecycleRuntime as any,
      logger: makeLogger(),
    } as any);

    const result = await handler.execute(makeArgs({ content: longContent }), makeContext());

    expect(result.status).toBe('success');
    const lifecycleInput = lifecycleRuntime.intercept.mock.calls[0]![1] as LifecycleInterceptorEnvelope;
    expect(LifecycleInterceptorEnvelopeSchema.safeParse(lifecycleInput).success).toBe(true);
    expect(lifecycleInput.input.content.length).toBeLessThanOrEqual(
      MAX_LIFECYCLE_CONTENT_LENGTH,
    );
    expect(lifecycleInput.input.content).not.toBe(longContent);
    expect(connector.send).toHaveBeenCalledWith(
      'ext-001',
      expect.objectContaining({ body: longContent }),
    );
  });

  it('rejects content transforms when before_send only saw a truncated preview', async () => {
    const longContent = 'T'.repeat(MAX_LIFECYCLE_CONTENT_LENGTH + 1024);
    const lifecycleRuntime = makeLifecycleRuntime();
    lifecycleRuntime.intercept.mockImplementation((_invocation, input: LifecycleInterceptorEnvelope) =>
      ok({
        outcome: 'allow' as const,
        input: {
          ...input,
          input: {
            ...input.input,
            content: 'Unsafe transform from truncated preview',
          },
        },
        signals: [],
      }),
    );
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepo(),
      personaRepository: makePersonaRepo(),
      lifecycleRuntime: lifecycleRuntime as any,
      logger: makeLogger(),
    } as any);

    const result = await handler.execute(makeArgs({ content: longContent }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toContain('truncated preview');
    expect(connector.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Arg validation failures
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — arg validation', () => {
  it('returns error when channelId is missing', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/channelId is required/);
  });

  it('returns error when channelId is whitespace', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/channelId is required/);
  });

  it('returns error when content is missing', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ content: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/content is required/);
  });

  it('returns error when content is whitespace', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ content: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/content is required/);
  });
});

// ---------------------------------------------------------------------------
// Channel not found
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — channel not found', () => {
  it('returns error when channel is not in registry', async () => {
    const registry = makeRegistry(undefined);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: 'unknown-channel' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found in registry/);
  });
});

// ---------------------------------------------------------------------------
// Connector send failure
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — connector send failure', () => {
  it('returns error when connector.send returns an Err result', async () => {
    const channelErr = new ChannelError('Telegram API timeout');
    const connector = makeConnector(err(channelErr));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/failed to send message/);
    expect(result.error).toMatch(/Telegram API timeout/);
  });
});

// ---------------------------------------------------------------------------
// Schedule-thread delivery routing
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — schedule-thread routing', () => {
  it('delivers to the origin external_id when the thread metadata marks it as a schedule thread', async () => {
    // Dedicated schedule execution threads created by schedule.manage have
    // kind='schedule' + originExternalId set — channel.send must route to the
    // origin chat, not the synthetic schedule thread id (issue #200).
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'dedicated-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({
            kind: 'schedule',
            originExternalId: 'chat-42',
            personaName: 'assistant',
            channelName: 'telegram-main',
          }),
        }),
      ),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs(), makeContext({ threadId: 'dedicated-schedule-thread-001' }));

    expect(connector.send).toHaveBeenCalledWith(
      'chat-42',
      expect.objectContaining({ body: 'Hello from persona!' }),
    );
  });

  it('persists scheduled channel_send output to the origin live thread', async () => {
    const liveThread = {
      id: 'live-thread-001',
      channel_id: 'chan-001',
      external_id: 'chat-42',
      metadata: '{}',
      created_at: 0,
      updated_at: 0,
    };
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'dedicated-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({
            kind: 'schedule',
            originExternalId: 'chat-42',
            personaName: 'assistant',
            channelName: 'telegram-main',
          }),
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(ok(liveThread)),
      insert: vi.fn(),
    } as any;
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'Are you still joining the 16:30 sync?' }),
      makeContext({
        runId: 'run-schedule-001',
        requestId: 'tool-call-001',
        threadId: 'dedicated-schedule-thread-001',
      }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith(
      'chat-42',
      expect.objectContaining({ body: 'Are you still joining the 16:30 sync?' }),
    );
    expect(threadRepo.findByExternalId).toHaveBeenCalledWith('chan-001', 'chat-42');
    expect(messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: 'live-thread-001',
        direction: 'outbound',
        content: JSON.stringify({ body: 'Are you still joining the 16:30 sync?' }),
        idempotency_key: 'channel-send:run-schedule-001:tool-call-001',
        run_id: 'run-schedule-001',
      }),
    );
  });

  it('falls back to the thread external_id when metadata is not a schedule marker', async () => {
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'live-thread-001',
          channel_id: 'chan-001',
          external_id: 'chat-42',
          metadata: JSON.stringify({ kind: 'live' }),
        }),
      ),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs(), makeContext());

    expect(connector.send).toHaveBeenCalledWith(
      'chat-42',
      expect.any(Object),
    );
  });

  it('ignores malformed metadata JSON and falls back to the thread external_id', async () => {
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'live-thread-001',
          channel_id: 'chan-001',
          external_id: 'chat-42',
          metadata: '{not-json',
        }),
      ),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    await handler.execute(makeArgs(), makeContext());

    expect(connector.send).toHaveBeenCalledWith('chat-42', expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// Fail-loud on missing thread
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — missing thread fail-loud', () => {
  it('returns a ToolError and does not call connector.send when the thread row is missing', async () => {
    // Regression: before PR #201 review feedback, channel.send fell back
    // to context.threadId (a UUID) when the thread row was missing,
    // sending an unresolvable recipient to Telegram/Slack/Discord and
    // producing "chat not found" errors the agent paraphrased as
    // "channel unreachable — delivering inline" (silent delivery loss).
    const threadRepo = {
      findById: vi.fn().mockReturnValue(ok(null)),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(makeArgs(), makeContext({ threadId: 'missing-thread-uuid' }));

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/thread "missing-thread-uuid" not found/);
    expect(connector.send).not.toHaveBeenCalled();
  });

  it('returns a ToolError when the thread lookup itself fails', async () => {
    const { DbError } = await import('../../../../src/core/errors/error-types.js');
    const { err: errFn } = await import('neverthrow');
    const threadRepo = {
      findById: vi.fn().mockReturnValue(errFn(new DbError('db locked'))),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/failed to resolve thread/);
    expect(connector.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// externalChatId resolution
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — externalChatId resolution', () => {
  it('uses explicit externalChatId in preference to schedule-thread originExternalId', async () => {
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'dedicated-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({
            kind: 'schedule',
            originExternalId: 'chat-42',
            personaName: 'assistant',
            channelName: 'telegram-main',
          }),
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(
        ok({
          id: 'live-thread-999',
          channel_id: 'chan-001',
          external_id: 'chat-999',
          metadata: '{}',
          created_at: 0,
          updated_at: 0,
        }),
      ),
      insert: vi.fn(),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      channelRepository: makeChannelRepo(),
      messageRepository: makeMessageRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ channelId: 'my-telegram', content: 'ping', externalChatId: 'chat-999' }),
      makeContext({
        runId: 'run-001',
        requestId: 'tool-001',
        threadId: 'dedicated-schedule-thread-001',
      }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith(
      'chat-999',
      expect.objectContaining({ body: 'ping' }),
    );
    expect(threadRepo.findByExternalId).toHaveBeenCalledWith('chan-001', 'chat-999');
  });

  it('errors with a pointer to channel.list / channel.broadcast when no originExternalId and no externalChatId and synthetic thread external_id', async () => {
    const threadRepo = {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'cli-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main',
          metadata: '{}',
        }),
      ),
      findByExternalId: vi.fn(),
      insert: vi.fn(),
    } as any;
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: threadRepo,
      channelRepository: makeChannelRepo(),
      messageRepository: makeMessageRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ channelId: 'my-telegram', content: 'ping' }),
      makeContext({
        runId: 'run-001',
        requestId: 'tool-001',
        threadId: 'cli-schedule-thread-001',
      }),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/externalChatId/);
    expect(result.error).toMatch(/channel\.list|channel\.broadcast/);
    expect(connector.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Binding-gated outbound persistence
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — binding-gated persistence', () => {
  function makeBindingRepo(opts: { scoped?: any | null; default?: any | null }) {
    return {
      findByChannelAndThread: vi.fn().mockReturnValue(ok(opts.scoped ?? null)),
      findDefaultForChannel: vi.fn().mockReturnValue(ok(opts.default ?? null)),
    } as any;
  }

  function makeThreadRepoWithExternal(externalThread: any) {
    return {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'dedicated-schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(ok(externalThread)),
      insert: vi.fn(),
    } as any;
  }

  const liveThread = {
    id: 'live-thread-001',
    channel_id: 'chan-001',
    external_id: 'chat-42',
    metadata: '{}',
    created_at: 0,
    updated_at: 0,
  };

  it('persists outbound when a thread-scoped binding matches the current persona', async () => {
    const binding = {
      id: 'b1',
      channel_id: 'chan-001',
      thread_id: 'live-thread-001',
      persona_id: 'persona-001',
      is_default: 0,
      created_at: 0,
      updated_at: 0,
    };
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: binding }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'live-thread-001', direction: 'outbound' }),
    );
  });

  it('persists outbound when only a channel-default binding matches (no thread-scoped binding)', async () => {
    // Regression guard: default-bound conversations (thread_id IS NULL on
    // the binding) must still persist outbound context, mirroring
    // ChannelRouter.resolvePersona's fallback to the channel-default
    // binding.
    const defaultBinding = {
      id: 'bd',
      channel_id: 'chan-001',
      thread_id: null,
      persona_id: 'persona-001',
      is_default: 1,
      created_at: 0,
      updated_at: 0,
    };
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: null, default: defaultBinding }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi', externalChatId: 'chat-42' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', personaId: 'persona-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'live-thread-001', direction: 'outbound' }),
    );
  });

  it('skips outbound persistence when no binding exists for the target channel/thread', async () => {
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: null, default: null }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi', externalChatId: 'chat-42' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001' }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-42', expect.any(Object));
    expect(messageRepo.insert).not.toHaveBeenCalled();
  });

  it('skips outbound persistence when both scoped and default bindings belong to a different persona', async () => {
    const otherScoped = {
      id: 'b9',
      channel_id: 'chan-001',
      thread_id: 'live-thread-001',
      persona_id: 'persona-other',
      is_default: 0,
      created_at: 0,
      updated_at: 0,
    };
    const otherDefault = {
      id: 'bd2',
      channel_id: 'chan-001',
      thread_id: null,
      persona_id: 'persona-other',
      is_default: 1,
      created_at: 0,
      updated_at: 0,
    };
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: otherScoped, default: otherDefault }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi', externalChatId: 'chat-42' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', personaId: 'persona-001' }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-42', expect.any(Object));
    expect(messageRepo.insert).not.toHaveBeenCalled();
  });

  it('skips persistence when thread is scoped to a different persona even if channel-default matches current persona', async () => {
    // Mirrors ChannelRouter.resolvePersona: a thread-scoped binding for a
    // different persona blocks the current persona from claiming the
    // thread via the channel-default binding. Persistence must follow the
    // same rule or the persona would pollute a thread the router would
    // never route its inbound to.
    const otherScoped = {
      id: 'b9',
      channel_id: 'chan-001',
      thread_id: 'live-thread-001',
      persona_id: 'persona-other',
      is_default: 0,
      created_at: 0,
      updated_at: 0,
    };
    const myDefault = {
      id: 'bd3',
      channel_id: 'chan-001',
      thread_id: null,
      persona_id: 'persona-001',
      is_default: 1,
      created_at: 0,
      updated_at: 0,
    };
    const messageRepo = makeMessageRepo();
    const bindingRepo = makeBindingRepo({ scoped: otherScoped, default: myDefault });
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: bindingRepo,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi', externalChatId: 'chat-42' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', personaId: 'persona-001' }),
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith('chat-42', expect.any(Object));
    expect(bindingRepo.findDefaultForChannel).not.toHaveBeenCalled();
    expect(messageRepo.insert).not.toHaveBeenCalled();
  });
});

describe('ChannelSendHandler — cross-thread session rotation', () => {
  function makeBindingRepo(opts: { scoped?: any | null; default?: any | null }) {
    return {
      findByChannelAndThread: vi.fn().mockReturnValue(ok(opts.scoped ?? null)),
      findDefaultForChannel: vi.fn().mockReturnValue(ok(opts.default ?? null)),
    } as any;
  }

  function makeThreadRepoWithExternal(externalThread: any) {
    return {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'schedule-thread-001',
          channel_id: 'chan-001',
          external_id: 'schedule:assistant:telegram-main:chat-42',
          metadata: JSON.stringify({ kind: 'schedule', originExternalId: 'chat-42' }),
        }),
      ),
      findByExternalId: vi.fn().mockReturnValue(ok(externalThread)),
      insert: vi.fn(),
    } as any;
  }

  const liveThread = {
    id: 'live-thread-001',
    channel_id: 'chan-001',
    external_id: 'chat-42',
    metadata: '{}',
    created_at: 0,
    updated_at: 0,
  };

  const scopedBinding = {
    id: 'b1',
    channel_id: 'chan-001',
    thread_id: 'live-thread-001',
    persona_id: 'persona-001',
    is_default: 0,
    created_at: 0,
    updated_at: 0,
  };

  it('force-rotates the recipient session when the run is on a different thread (scheduled-task case)', async () => {
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const sessionTracker = { rotateSession: vi.fn() };
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: scopedBinding }),
      sessionTracker,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'What is on your plate today?' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', threadId: 'schedule-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'live-thread-001', direction: 'outbound' }),
    );
    // Recipient thread's session is rotated so the next run there starts
    // fresh and ContextAssembler injects the scheduled outbound.
    expect(sessionTracker.rotateSession).toHaveBeenCalledWith('live-thread-001');
  });

  it('does NOT rotate when the recipient thread is the same as the run thread (inline reply)', async () => {
    // Same-thread delivery: the outbound is part of the current run's own
    // conversation. The codex session for this thread already includes it
    // (the agent just generated it). Rotating would needlessly destroy
    // the session and force a cache miss on the next run.
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const sessionTracker = { rotateSession: vi.fn() };
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: scopedBinding }),
      sessionTracker,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'inline reply' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', threadId: 'live-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalled();
    expect(sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('does NOT rotate when persistence fails (message not in DB, rotation would not help)', async () => {
    const messageRepo = makeMessageRepo();
    (messageRepo.insert as any).mockReturnValue(err(new Error('disk full')));
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const sessionTracker = { rotateSession: vi.fn() };
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: scopedBinding }),
      sessionTracker,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', threadId: 'schedule-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('works without a sessionTracker (no rotation, no error)', async () => {
    const messageRepo = makeMessageRepo();
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({
      channelRegistry: registry,
      threadRepository: makeThreadRepoWithExternal(liveThread),
      channelRepository: makeChannelRepo(),
      messageRepository: messageRepo,
      bindingRepository: makeBindingRepo({ scoped: scopedBinding }),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      makeArgs({ content: 'hi' }),
      makeContext({ runId: 'run-001', requestId: 'tool-001', threadId: 'schedule-thread-001' }),
    );

    expect(result.status).toBe('success');
    expect(messageRepo.insert).toHaveBeenCalled();
  });
});
