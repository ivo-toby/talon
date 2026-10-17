/**
 * TASK-019 end-to-end: the shipped image subsystem driven through the real
 * daemon seams.
 *
 * Everything is the production component except two model seams (the vision
 * model and the foreground provider strategy) and the rotation summarizer:
 *
 * - file-backed SQLite (WAL) with the real repositories and migrations;
 * - the real inbound MessagePipeline + ChannelRouter + QueueManager, so an
 *   Attachment is admitted through the same path a connector uses;
 * - the real `ImageIngestionCoordinator` with the real native Sharp
 *   normalizer, writing real Normalized files;
 * - the real `ImageService` (`ImageAccess`) as the only availability
 *   authority, with a controlled clock;
 * - the real `DaemonImageContextSource` / `ImageLookupAccessAdapter`
 *   adapters that TASK-019 wires into bootstrap, the real `ContextAssembler`,
 *   `ContextRoller`, `ImageLookupHandler`, `SubAgentRunner` and
 *   `SubAgentInvokeHandler` over the SHIPPED built-in `vision` sub-agent;
 * - the real `AgentRunner` with a `ProviderRegistry` whose strategy captures
 *   the exact `AgentRunInput` the provider would receive.
 *
 * Guarantees pinned here (and nowhere else in the suite):
 *
 * - an uploaded Image reaches `available` through the pipeline and the queued
 *   payload carries no pixel bytes;
 * - an Inspection persists a canonical Finding and the foreground/tool result
 *   stays text-only;
 * - a fresh-session foreground turn replays the bounded inventory and exact
 *   Findings, a resumed text-only turn reinjects nothing, and a rotated
 *   session replays again;
 * - rotation hands the summarizer an inventory that keeps an uninspected
 *   Image discoverable;
 * - `image_lookup` pages Images, returns Findings verbatim, and is scoped to
 *   the calling thread and gated by `image.read`;
 * - controlled-time expiry deletes the Normalized file, marks the Image
 *   `unavailable (expired)`, preserves every Finding, denies a new Inspection
 *   of the dead Image, and a re-upload admits a NEW Image;
 * - an Image that expires while its message sits in the queue backlog is
 *   reported `unavailable (expired)` at delivery time, never `available`;
 * - a Finding recorded under a run that later failed stays projected and
 *   retrievable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ok, type Result } from 'neverthrow';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';

import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import {
  BindingRepository,
  ChannelRepository,
  FindingRepository,
  ImageIngestionRepository,
  ImageRepository,
  MemoryRepository,
  MessageRepository,
  PersonaRepository,
  QueueRepository,
  RunRepository,
  ScheduleRepository,
  ThreadRepository,
} from '../../../src/core/database/repositories/index.js';
import type { QueueItemRow } from '../../../src/core/database/repositories/queue-repository.js';
import { QueueManager } from '../../../src/queue/queue-manager.js';
import type { QueueItem } from '../../../src/queue/queue-types.js';
import type { AuditStore } from '../../../src/core/logging/audit-logger.js';
import { AuditLogger } from '../../../src/core/logging/audit-logger.js';
import { BaseRepository } from '../../../src/core/database/repositories/base-repository.js';
import { ImageStore } from '../../../src/images/image-store.js';
import { ImageIngestionCoordinator } from '../../../src/images/image-ingestion.js';
import { ImageService } from '../../../src/images/image-service.js';
import { IMAGE_CONTEXT_FRAMING } from '../../../src/images/image-context-projection.js';
import type { ImagesConfig } from '../../../src/core/config/config-types.js';
import type { InboundEvent } from '../../../src/channels/channel-types.js';
import { ChannelRouter } from '../../../src/channels/channel-router.js';
import { MessagePipeline } from '../../../src/pipeline/message-pipeline.js';
import { PersonaLoader } from '../../../src/personas/persona-loader.js';
import { PersonaConfigSchema } from '../../../src/core/config/config-schema.js';
import { SubAgentLoader } from '../../../src/subagents/subagent-loader.js';
import { SubAgentRunner } from '../../../src/subagents/subagent-runner.js';
import type { ModelResolver } from '../../../src/subagents/model-resolver.js';
import type { SubAgentServices } from '../../../src/subagents/subagent-types.js';
import { SubAgentInvokeHandler } from '../../../src/tools/host-tools/subagent-invoke.js';
import {
  ImageLookupHandler,
  IMAGE_LOOKUP_CAPABILITY,
} from '../../../src/tools/host-tools/image-lookup.js';
import type { ToolExecutionContext } from '../../../src/tools/host-tools/channel-send.js';
import {
  DaemonImageContextSource,
  ImageLookupAccessAdapter,
} from '../../../src/daemon/image-context-source.js';
import {
  ContextAssembler,
  EMPTY_LIVE_BLOCK,
  LIVE_IMAGE_SECTION_HEADER,
} from '../../../src/daemon/context-assembler.js';
import { ContextRoller, type SummarizerRunFn } from '../../../src/daemon/context-roller.js';
import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import { bootstrap } from '../../../src/daemon/daemon-bootstrap.js';
import type { DaemonContext } from '../../../src/daemon/daemon-types.js';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import { TALOND_BRIDGE_SECRET_ENV } from '../../../src/tools/host-tools-bridge-auth.js';
import { ProviderRegistry } from '../../../src/providers/provider-registry.js';
import type { AgentProvider } from '../../../src/providers/provider.js';
import type { AgentRunInput } from '../../../src/providers/provider.js';
import { SessionTracker } from '../../../src/sandbox/session-tracker.js';
import { ThreadWorkspace } from '../../../src/memory/thread-workspace.js';

// ---------------------------------------------------------------------------
// Vision model seam for the bootstrapped daemon
// ---------------------------------------------------------------------------

/**
 * The one place a real `bootstrap()` cannot be steered: the shipped `vision`
 * manifest pins `anthropic/...`, and `ModelResolver` builds that model through
 * `@ai-sdk/anthropic`. Everything upstream of this factory — the real
 * ModelResolver, the real SubAgentRunner, the shipped manifest, the real
 * `generateText()` call — stays live; only the SDK factory is deterministic.
 * No HTTP listener and no private-field mutation is involved.
 */
const visionSeam = vi.hoisted(() => ({
  answer: {
    answer: 'A solid blue square fills the frame.',
    extractedText: 'no visible text',
    uncertainty: 'None.',
  },
  calls: [] as LanguageModelV3CallOptions[],
}));

vi.mock('@ai-sdk/anthropic', async () => {
  const { MockLanguageModelV3 } = await import('ai/test');
  return {
    createAnthropic: () => (modelName: string) =>
      new MockLanguageModelV3({
        provider: 'anthropic',
        modelId: modelName,
        doGenerate: async (options: LanguageModelV3CallOptions) => {
          visionSeam.calls.push(options);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(visionSeam.answer) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 120, noCache: 90, cacheRead: 30, cacheWrite: 0 },
              outputTokens: { total: 42, text: 42, reasoning: 0 },
            },
            warnings: [],
          };
        },
      }),
  };
});

// ---------------------------------------------------------------------------
// Fixed world constants
// ---------------------------------------------------------------------------

/** Controlled wall clock; the only time source the image subsystem consults. */
const START = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;

const IMAGES_CONFIG: ImagesConfig = {
  maxInputBytes: 10 * 1024 * 1024,
  maxPerMessage: 5,
  maxPerInspection: 2,
  maxEdge: 4096,
  jpegQuality: 85,
  retentionHours: 24,
};

const QUEUE_CONFIG = {
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 1_000,
  concurrencyLimit: 1,
};

/** A real PNG produced by Sharp; the coordinator's real normalizer converts it. */
const SOURCE_PNG: Buffer = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 128, b: 220 } },
})
  .png()
  .toBuffer();

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const builtinSubAgentsDir = path.join(import.meta.dirname, '../../../src/subagents/default');

function migrationsDir(): string {
  return path.join(import.meta.dirname, '../../../src/core/database/migrations');
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface World {
  dataDir: string;
  db: Database.Database;
  logger: pino.Logger;
  logLines: string[];
  clock: { now: number };
  store: ImageStore;
  imageRepo: ImageRepository;
  messageRepo: MessageRepository;
  threadRepo: ThreadRepository;
  runRepo: RunRepository;
  personaRepo: PersonaRepository;
  findings: FindingRepository;
  queueRepo: QueueRepository;
  imageAccess: ImageService;
  pipeline: MessagePipeline;
  contextSource: DaemonImageContextSource;
  lookup: ImageLookupHandler;
  assembler: ContextAssembler;
  personaLoader: PersonaLoader;
  analystId: string;
  deskId: string;
  close(): void;
}

async function makeWorld(): Promise<World> {
  BaseRepository.__resetMonotonicClockForTests();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-image-e2e-'));
  const db = new Database(path.join(dataDir, 'talon.sqlite'));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  const migrated = runMigrations(db, migrationsDir());
  if (migrated.isErr()) {
    db.close();
    throw new Error(`migration failed: ${migrated.error.message}`);
  }

  const logLines: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (chunk: string) => logLines.push(chunk) });

  const clock = { now: START };

  const channelRepo = new ChannelRepository(db);
  const threadRepo = new ThreadRepository(db);
  const messageRepo = new MessageRepository(db);
  const personaRepo = new PersonaRepository(db);
  const runRepo = new RunRepository(db);
  const memoryRepo = new MemoryRepository(db);
  const scheduleRepo = new ScheduleRepository(db);
  const queueRepo = new QueueRepository(db);
  const imageRepo = new ImageRepository(db);
  const ingestionRepo = new ImageIngestionRepository(db);
  const findings = new FindingRepository(db);
  const bindingRepo = new BindingRepository(db);
  const store = new ImageStore(dataDir);

  const auditEntries: unknown[] = [];
  const auditStore: AuditStore = {
    append: (entry) => {
      auditEntries.push(entry);
    },
  };

  // Two channels: the analyst's bot and a desk bot whose persona has no
  // `image.read`, so capability denial is exercised through a real binding.
  const channelId = uuidv4();
  const deskChannelId = uuidv4();
  channelRepo
    .insert({
      id: channelId,
      type: 'telegram',
      name: 'e2e-bot',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    })
    ._unsafeUnwrap();
  channelRepo
    .insert({
      id: deskChannelId,
      type: 'telegram',
      name: 'desk-bot',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    })
    ._unsafeUnwrap();

  const analyst = PersonaConfigSchema.parse({
    name: 'analyst',
    model: 'gpt-5-codex',
    provider: 'fake-codex',
    subagents: ['vision'],
    capabilities: { allow: ['channel.send:*', 'image.read:thread', 'subagent.invoke'] },
  });
  const desk = PersonaConfigSchema.parse({
    name: 'desk',
    model: 'gpt-5-codex',
    provider: 'fake-codex',
    capabilities: { allow: ['channel.send:*'] },
  });
  const personaLoader = new PersonaLoader(personaRepo, logger);
  const loadedPersonas = (await personaLoader.loadFromConfig([analyst, desk]))._unsafeUnwrap();
  expect(loadedPersonas).toHaveLength(2);
  const analystId = personaRepo.findByName('analyst')._unsafeUnwrap()!.id;
  const deskId = personaRepo.findByName('desk')._unsafeUnwrap()!.id;

  bindingRepo
    .insert({
      id: uuidv4(),
      channel_id: channelId,
      thread_id: null,
      persona_id: analystId,
      is_default: 1,
    })
    ._unsafeUnwrap();
  bindingRepo
    .insert({
      id: uuidv4(),
      channel_id: deskChannelId,
      thread_id: null,
      persona_id: deskId,
      is_default: 1,
    })
    ._unsafeUnwrap();

  const queueManager = new QueueManager(queueRepo, threadRepo, QUEUE_CONFIG, logger);

  // Real durable ingestion with the REAL Sharp normalizer.
  const coordinator = new ImageIngestionCoordinator({
    messageRepo,
    imageRepo,
    ingestionRepo,
    queueManager,
    store,
    threadRepo,
    channelRepo,
    imagesConfig: IMAGES_CONFIG,
    logger,
    now: () => clock.now,
  });

  // The single availability authority, on the controlled clock.
  const imageAccess = new ImageService({
    imageRepo,
    store,
    logger,
    auditStore,
    now: () => clock.now,
  });

  const router = new ChannelRouter(bindingRepo, logger);
  const auditLogger = new AuditLogger(logger, auditStore);
  const pipeline = new MessagePipeline(
    messageRepo,
    threadRepo,
    channelRepo,
    queueManager,
    router,
    auditLogger,
    logger,
    coordinator,
  );

  const contextSource = new DaemonImageContextSource({
    imageRepo,
    imageAccess,
    findings,
    logger,
  });
  const lookupAccess = new ImageLookupAccessAdapter({ imageRepo, imageAccess, logger });
  const lookup = new ImageLookupHandler({
    images: lookupAccess,
    findings,
    personaRepository: personaRepo,
    personaLoader,
    logger,
  });

  const assembler = new ContextAssembler({ messageRepo, memoryRepo });

  return {
    dataDir,
    db,
    logger,
    logLines,
    clock,
    store,
    imageRepo,
    messageRepo,
    threadRepo,
    runRepo,
    personaRepo,
    findings,
    queueRepo,
    imageAccess,
    pipeline,
    contextSource,
    lookup,
    assembler,
    personaLoader,
    analystId,
    deskId,
    close(): void {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// World helpers
// ---------------------------------------------------------------------------

/** Delivers one image-bearing message through the real inbound pipeline. */
async function uploadImage(
  world: World,
  externalChatId: string,
  externalMessageId: string,
  content = 'what is in this image?',
  channelName = 'e2e-bot',
): Promise<{ threadId: string; messageId: string; imageId: string }> {
  const event: InboundEvent = {
    channelType: 'telegram',
    channelName,
    externalThreadId: externalChatId,
    senderId: 'user-1',
    content,
    idempotencyKey: externalMessageId,
    timestamp: START,
    attachments: [
      {
        filename: 'photo.png',
        mimeType: 'image/png',
        data: Buffer.from(SOURCE_PNG),
        size: SOURCE_PNG.byteLength,
      },
    ],
  };
  const admitted = await world.pipeline.handleInboundEvent(event);
  expect(admitted.isOk(), admitted.isErr() ? admitted.error.message : '').toBe(true);

  const channelId = channelIdByName(world, channelName);
  const thread = world.threadRepo.findByExternalId(channelId, externalChatId)._unsafeUnwrap();
  expect(thread).not.toBeNull();

  const messageId = storedMessageIdFor(world, channelId, externalMessageId);
  const images = world.imageRepo.findByMessage(messageId)._unsafeUnwrap();
  expect(images).toHaveLength(1);
  return { threadId: thread!.id, messageId, imageId: images[0]!.id };
}

/** Delivers one text-only message through the real inbound pipeline. */
async function sendText(
  world: World,
  externalChatId: string,
  externalMessageId: string,
  content: string,
  channelName = 'e2e-bot',
): Promise<{ threadId: string; item: QueueItem }> {
  const event: InboundEvent = {
    channelType: 'telegram',
    channelName,
    externalThreadId: externalChatId,
    senderId: 'user-1',
    content,
    idempotencyKey: externalMessageId,
    timestamp: START,
  };
  const admitted = await world.pipeline.handleInboundEvent(event);
  expect(admitted.isOk(), admitted.isErr() ? admitted.error.message : '').toBe(true);

  const item = pendingItemForMessage(
    world,
    storedMessageIdFor(world, channelIdByName(world, channelName), externalMessageId),
  );
  return { threadId: item.threadId, item };
}

function toQueueItem(row: QueueItemRow): QueueItem {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id ?? undefined,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The pending queue item that owns `messageId`, as the dequeue loop would hand it over. */
function pendingItemForMessage(world: World, messageId: string): QueueItem {
  const rows = world.queueRepo.findPending()._unsafeUnwrap();
  const row = rows.find((candidate) => candidate.message_id === messageId);
  expect(row, `no pending queue item for message ${messageId}`).toBeDefined();
  return toQueueItem(row!);
}

/** Claims the thread's next item through the repository (mirrors QueueProcessor). */
function claimNextItem(world: World, threadId: string): QueueItem {
  const row = world.queueRepo.claimNext(threadId)._unsafeUnwrap();
  expect(row).not.toBeNull();
  return toQueueItem(row!);
}

function seedRun(
  world: World,
  threadId: string,
  personaId: string,
  status: 'running' | 'failed' = 'running',
): string {
  const runId = uuidv4();
  world.runRepo
    .insert({
      id: runId,
      thread_id: threadId,
      persona_id: personaId,
      provider_name: 'fake-codex',
      status,
      sandbox_id: null,
      session_id: null,
      parent_run_id: null,
      queue_item_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: status === 'failed' ? 'provider stream aborted after tool call' : null,
      started_at: START,
      ended_at: status === 'failed' ? START + 1 : null,
    })
    ._unsafeUnwrap();
  return runId;
}

/** The pipeline stores idempotency keys scoped by channel id. */
function storedMessageIdFor(world: World, channelId: string, key: string): string {
  const row = world.db
    .prepare<[string], { id: string }>('SELECT id FROM messages WHERE idempotency_key = ?')
    .get(`${channelId}:${key}`);
  expect(row, `no stored message for idempotency key ${key}`).toBeDefined();
  return row!.id;
}

function channelIdByName(world: World, name: string): string {
  const row = world.db
    .prepare<[string], { id: string }>('SELECT id FROM channels WHERE name = ?')
    .get(name);
  expect(row, `unknown channel ${name}`).toBeDefined();
  return row!.id;
}

function toolContext(threadId: string, personaId: string, runId: string): ToolExecutionContext {
  return { runId, threadId, personaId, requestId: `req-${uuidv4()}` };
}

/** Serialized base64 of one Image's Normalized bytes, for leak assertions. */
function normalizedBase64(world: World, threadId: string, imageId: string): string {
  const target = world.store.normalizedPath(threadId, imageId)._unsafeUnwrap();
  return fs.readFileSync(target).toString('base64');
}

function readNormalized(world: World, threadId: string, imageId: string): Buffer {
  const target = world.store.normalizedPath(threadId, imageId)._unsafeUnwrap();
  return fs.readFileSync(target);
}

// ---------------------------------------------------------------------------
// Foreground provider seam (real AgentRunner around it)
// ---------------------------------------------------------------------------

interface CapturedTurn {
  prompt: string;
  systemPrompt: string;
  sessionId?: string;
}

interface AgentHarness {
  runner: AgentRunner;
  turns: CapturedTurn[];
  sends: Array<{ externalId: string; body: string }>;
  sessionTracker: SessionTracker;
}

function makeAgentHarness(
  world: World,
  options: { failWith?: string; sessionId?: string; sessionTracker?: SessionTracker } = {},
): AgentHarness {
  const turns: CapturedTurn[] = [];
  const sends: Array<{ externalId: string; body: string }> = [];
  const sessionTracker = options.sessionTracker ?? new SessionTracker();

  const provider = {
    name: 'fake-codex',
    skillLoaderTransport: 'stdio',
    createExecutionStrategy: () => ({
      type: 'cli' as const,
      supportsSessionResumption: true,
      run: async (input: AgentRunInput) => {
        turns.push({
          prompt: input.prompt,
          systemPrompt: input.systemPrompt,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        });
        if (options.failWith !== undefined) {
          throw new Error(options.failWith);
        }
        return {
          output: 'ACK',
          sessionId: options.sessionId ?? 'sess-fake-1',
          usage: { inputTokens: 1_000, outputTokens: 20 },
          isError: false,
        };
      },
    }),
    estimateContextUsage: (usage: { inputTokens?: number }) => ({
      inputTokens: usage.inputTokens ?? 0,
      metrics: { input_tokens: usage.inputTokens ?? 0 },
    }),
  } as unknown as AgentProvider;

  const providerRegistry = new ProviderRegistry(
    {
      'fake-codex': {
        enabled: true,
        command: 'fake-codex',
        contextWindowTokens: 200_000,
      },
    } as never,
    { 'fake-codex': () => provider } as never,
  );

  const workspace = new ThreadWorkspace(world.dataDir);
  const observationHandle = {
    update: (): void => {},
    end: (): void => {},
    getTraceparent: (): null => null,
  };

  const ctx = {
    db: world.db,
    configPath: '',
    dataDir: world.dataDir,
    config: {
      agentRunner: {
        defaultProvider: 'fake-codex',
        providers: {
          'fake-codex': {
            enabled: true,
            command: 'fake-codex',
            contextWindowTokens: 200_000,
          },
        },
      },
      channels: [{ type: 'telegram', name: 'e2e-bot', config: {}, enabled: true }],
    },
    repos: {
      channel: new ChannelRepository(world.db),
      thread: world.threadRepo,
      message: world.messageRepo,
      persona: world.personaRepo,
      run: world.runRepo,
      memory: new MemoryRepository(world.db),
      schedule: new ScheduleRepository(world.db),
      queue: world.queueRepo,
      binding: new BindingRepository(world.db),
      audit: {},
      a2aTask: {},
    },
    channelRegistry: {
      get: () => ({
        send: async (externalId: string, payload: { body: string }) => {
          sends.push({ externalId, body: payload.body });
          return ok(undefined);
        },
        sendTyping: async () => {},
      }),
      listAll: () => [{ name: 'e2e-bot' }],
    },
    queueManager: new QueueManager(world.queueRepo, world.threadRepo, QUEUE_CONFIG, world.logger),
    scheduler: {},
    personaLoader: world.personaLoader,
    sessionTracker,
    contextRoller: null,
    contextAssembler: world.assembler,
    threadWorkspace: workspace,
    auditLogger: new AuditLogger(world.logger),
    skillResolver: { mergePromptFragments: () => '' },
    loadedSkills: [],
    toolInstructions: new Map(),
    messagePipeline: world.pipeline,
    observability: {
      observe: async (_input: unknown, fn: (handle: unknown) => Promise<unknown>) =>
        fn(observationHandle),
      start: () => observationHandle,
      startWithTraceparent: () => observationHandle,
      observeWithTraceparent: async (
        _tp: unknown,
        _input: unknown,
        fn: (h: unknown) => Promise<unknown>,
      ) => fn(observationHandle),
      shutdown: async () => {},
    },
    hostToolsBridge: {
      path: path.join(world.dataDir, 'host-tools.sock'),
      registerRunAuthentication: () => {},
      unregisterRunAuthentication: () => {},
    },
    providerRegistry,
    backgroundAgentManager: null,
    logger: world.logger,
  } as unknown as DaemonContext;

  return {
    runner: new AgentRunner(ctx, { imageContextSource: world.contextSource }),
    turns,
    sends,
    sessionTracker,
  };
}

// ---------------------------------------------------------------------------
// Vision seam (real SubAgentRunner + shipped vision sub-agent around it)
// ---------------------------------------------------------------------------

interface VisionHarness {
  handler: SubAgentInvokeHandler;
  calls: LanguageModelV3CallOptions[];
}

async function makeVisionHarness(
  world: World,
  answer: { answer: string; extractedText?: string; uncertainty?: string },
): Promise<VisionHarness> {
  const loader = new SubAgentLoader(world.logger);
  const agents = (await loader.loadAll(builtinSubAgentsDir))._unsafeUnwrap();
  const agentMap = new Map(agents.map((agent) => [agent.manifest.name, agent]));
  expect(agentMap.has('vision')).toBe(true);

  const calls: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    provider: 'mock.vision',
    modelId: 'deterministic-vision-1',
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      calls.push(options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(answer) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 120, noCache: 90, cacheRead: 30, cacheWrite: 0 },
          outputTokens: { total: 42, text: 42, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  const services: SubAgentServices = {
    memory: new MemoryRepository(world.db),
    schedules: new ScheduleRepository(world.db),
    personas: new PersonaRepository(world.db),
    channels: new ChannelRepository(world.db),
    threads: world.threadRepo,
    messages: world.messageRepo,
    runs: world.runRepo,
    queue: world.queueRepo,
    images: world.imageAccess,
    findings: world.findings,
    imageInspectionLimits: { maxPerInspection: IMAGES_CONFIG.maxPerInspection },
    logger: world.logger,
  };

  const runner = new SubAgentRunner(
    agentMap,
    { resolve: async () => ok(model as unknown as LanguageModel) } as unknown as ModelResolver,
    services,
    world.logger,
  );

  return {
    handler: new SubAgentInvokeHandler({
      runner,
      personaLoader: world.personaLoader,
      personaRepository: world.personaRepo,
      logger: world.logger,
    }),
    calls,
  };
}

/** Runs one Inspection through the real handler and returns its tool result. */
async function inspect(
  world: World,
  harness: VisionHarness,
  threadId: string,
  personaId: string,
  runId: string,
  imageIds: string[],
  question = 'What is in this image?',
): Promise<Awaited<ReturnType<SubAgentInvokeHandler['execute']>>> {
  return harness.handler.execute(
    { name: 'vision', input: { question, imageIds } },
    toolContext(threadId, personaId, runId),
  );
}

/** Walks a model request for every JPEG byte set it carries. */
function collectPromptJpeg(call: LanguageModelV3CallOptions): Buffer[] {
  const found: Buffer[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (
        (record.type === 'image' || record.type === 'file') &&
        record.mediaType === 'image/jpeg'
      ) {
        const data = record.image ?? record.data;
        if (data instanceof Uint8Array) {
          found.push(Buffer.from(data));
        }
      }
      for (const key of Object.keys(record)) {
        if (key === 'image' || key === 'data') continue;
        walk(record[key]);
      }
    }
  };
  walk(call.prompt);
  return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('image processing end-to-end (TASK-019)', () => {
  let world: World;

  afterEach(() => {
    if (!world) return;
    world.close();
    fs.rmSync(world.dataDir, { recursive: true, force: true });
  });

  it('admits an upload into an Available Image and keeps pixel bytes out of the queue payload', async () => {
    world = await makeWorld();
    const { threadId, messageId, imageId } = await uploadImage(world, 'chat-admit', 'ext-1');

    const row = world.imageRepo.findById(imageId)._unsafeUnwrap()!;
    expect(row.state).toBe('available');
    expect(row.thread_id).toBe(threadId);
    expect(row.message_id).toBe(messageId);
    expect(row.mime_type).toBe('image/jpeg');
    expect(row.width).toBe(8);
    expect(row.height).toBe(8);

    // The Normalized file is a real JPEG written by the real normalizer.
    const normalized = readNormalized(world, threadId, imageId);
    expect([...normalized.subarray(0, 3)]).toEqual(JPEG_MAGIC);

    // The durable queue item references the Message and carries text only.
    const item = pendingItemForMessage(world, messageId);
    expect(item.threadId).toBe(threadId);
    const serializedPayload = JSON.stringify(item.payload);
    expect(serializedPayload).toContain(messageId);
    expect(serializedPayload).not.toContain(SOURCE_PNG.toString('base64'));
    expect(serializedPayload).not.toContain(normalized.toString('base64'));
    expect(serializedPayload).not.toContain(world.dataDir);

    // The context source sees the live Image on the owning message.
    const live = await world.contextSource.resolveMessageDescriptors({ threadId, messageId });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ imageId, state: 'available' });
  });

  it('inspects the Image into a canonical Finding the foreground only ever sees as text', async () => {
    world = await makeWorld();
    const { threadId, messageId, imageId } = await uploadImage(world, 'chat-inspect', 'ext-1');
    const harness = makeAgentHarness(world);
    const item = pendingItemForMessage(world, messageId);

    // The foreground turn happens first: the run row exists before the
    // Inspection, and the provider receives the live descriptor only.
    const ran = await harness.runner.run(item);
    expect(ran.isOk(), ran.isErr() ? ran.error.message : '').toBe(true);
    const runId = world.runRepo
      .findByThread(threadId)
      ._unsafeUnwrap()
      .sort((a, b) => b.started_at - a.started_at)[0]!.id;

    expect(harness.turns).toHaveLength(1);
    const turn = harness.turns[0]!;
    expect(turn.prompt).toContain(LIVE_IMAGE_SECTION_HEADER);
    expect(turn.prompt).toContain(`img ${imageId} state=available`);
    expect(turn.prompt).not.toContain(world.dataDir);
    expect(turn.prompt).not.toContain(normalizedBase64(world, threadId, imageId));

    // Now the Inspection, recorded against that real run.
    const answer = {
      answer: 'A solid blue square fills the frame.',
      extractedText: 'no visible text',
      uncertainty: 'None.',
    };
    const vision = await makeVisionHarness(world, answer);
    const toolResult = await inspect(world, vision, threadId, world.analystId, runId, [imageId]);
    expect(toolResult.status).toBe('success');

    // Real Normalized pixels reached the model exactly once.
    expect(vision.calls).toHaveLength(1);
    const jpeg = readNormalized(world, threadId, imageId);
    const carried = collectPromptJpeg(vision.calls[0]!);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.equals(jpeg)).toBe(true);

    // The tool result is text only.
    const serialized = JSON.stringify(toolResult);
    expect(serialized).not.toContain(jpeg.toString('base64'));
    expect(serialized).not.toContain(world.dataDir);

    // A canonical Finding exists with trusted provenance and is readable
    // through the same context source the foreground projection uses.
    const findings = await world.contextSource.listThreadFindings(threadId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      answer: answer.answer,
      question: 'What is in this image?',
      runId,
      threadId,
      imageIds: [imageId],
    });

    // The Finding is quoted verbatim in the next fresh-session projection.
    const projection = world.assembler.assemble(threadId, 10, {
      images: {
        live: EMPTY_LIVE_BLOCK,
        inventoryDescriptors: await world.contextSource.listThreadDescriptors(threadId),
        findings,
        imageLookupExposed: true,
      },
    });
    expect(projection.text).toContain(IMAGE_CONTEXT_FRAMING.findingSectionHeader);
    expect(projection.text).toContain(answer.answer);
    expect(projection.text).not.toContain(world.dataDir);
  });

  it('replays the inventory and Findings on a fresh session and reinjects nothing when resumed', async () => {
    world = await makeWorld();
    // Older, uninspected Image plus the Image of the message being answered.
    const older = await uploadImage(world, 'chat-replay', 'ext-older');
    const live = await uploadImage(world, 'chat-replay', 'ext-live');

    const answer = { answer: 'A blue square. Nobody asked twice.', extractedText: 'none' };
    const vision = await makeVisionHarness(world, answer);
    const runId = seedRun(world, live.threadId, world.analystId);
    const inspected = await inspect(world, vision, live.threadId, world.analystId, runId, [
      live.imageId,
    ]);
    expect(inspected.status).toBe('success');

    const sharedTracker = new SessionTracker();

    // Turn 1: fresh session on the image message.
    const first = makeAgentHarness(world, { sessionTracker: sharedTracker });
    const turn1 = await first.runner.run(pendingItemForMessage(world, live.messageId));
    expect(turn1.isOk()).toBe(true);
    expect(first.turns[0]!.sessionId).toBeUndefined();
    expect(first.turns[0]!.prompt).toContain(`img ${live.imageId} state=available`);
    expect(first.turns[0]!.systemPrompt).toContain(IMAGE_CONTEXT_FRAMING.inventorySectionHeader);
    expect(first.turns[0]!.systemPrompt).toContain(older.imageId);
    expect(first.turns[0]!.systemPrompt).toContain(IMAGE_CONTEXT_FRAMING.findingSectionHeader);
    expect(first.turns[0]!.systemPrompt).toContain(answer.answer);

    // Turn 2: text-only turn on the RESUMED session — no projection at all.
    const text = await sendText(world, 'chat-replay', 'ext-text', 'and now?');
    const resumed = makeAgentHarness(world, { sessionTracker: sharedTracker });
    const turn2 = await resumed.runner.run(text.item);
    expect(turn2.isOk()).toBe(true);
    expect(resumed.turns[0]!.sessionId).toBe('sess-fake-1');
    expect(resumed.turns[0]!.prompt).toBe('and now?');
    expect(resumed.turns[0]!.prompt).not.toContain(LIVE_IMAGE_SECTION_HEADER);
    expect(resumed.turns[0]!.systemPrompt).not.toContain(
      IMAGE_CONTEXT_FRAMING.inventorySectionHeader,
    );
    expect(resumed.turns[0]!.systemPrompt).not.toContain(
      IMAGE_CONTEXT_FRAMING.findingSectionHeader,
    );
    expect(resumed.turns[0]!.systemPrompt).not.toContain(older.imageId);
    expect(resumed.turns[0]!.systemPrompt).not.toContain(answer.answer);

    // Restart: a new runner restores the session from the database and still
    // reinjects nothing; a rotated session replays the projection again.
    const afterRestart = makeAgentHarness(world, { sessionTracker: new SessionTracker() });
    const text2 = await sendText(world, 'chat-replay', 'ext-text-2', 'still there?');
    expect((await afterRestart.runner.run(text2.item)).isOk()).toBe(true);
    expect(afterRestart.turns[0]!.sessionId).toBe('sess-fake-1');
    expect(afterRestart.turns[0]!.systemPrompt).not.toContain(
      IMAGE_CONTEXT_FRAMING.inventorySectionHeader,
    );

    afterRestart.sessionTracker.rotateSession(live.threadId);
    const text3 = await sendText(world, 'chat-replay', 'ext-text-3', 'recap?');
    expect((await afterRestart.runner.run(text3.item)).isOk()).toBe(true);
    const replay = afterRestart.turns[1]!;
    expect(replay.sessionId).toBeUndefined();
    expect(replay.systemPrompt).toContain(IMAGE_CONTEXT_FRAMING.inventorySectionHeader);
    expect(replay.systemPrompt).toContain(older.imageId);
    expect(replay.systemPrompt).toContain(IMAGE_CONTEXT_FRAMING.findingSectionHeader);
    expect(replay.systemPrompt).toContain(answer.answer);
  });

  it('keeps an uninspected Image discoverable through rotation', async () => {
    world = await makeWorld();
    const uninspected = await uploadImage(world, 'chat-rotate', 'ext-uninspected');
    const inspected = await uploadImage(world, 'chat-rotate', 'ext-inspected');

    const answer = { answer: 'A blue square, already described.' };
    const vision = await makeVisionHarness(world, answer);
    const runId = seedRun(world, inspected.threadId, world.analystId);
    expect(
      (
        await inspect(world, vision, inspected.threadId, world.analystId, runId, [
          inspected.imageId,
        ])
      ).status,
    ).toBe('success');

    let summarizerInput = '';
    const summarizerRun: SummarizerRunFn = async (_threadId, _personaId, input) => {
      summarizerInput = JSON.stringify(input);
      return ok({ summary: 'rotated summary', data: { summary: 'rotated summary' } });
    };
    const roller = new ContextRoller({
      messageRepo: world.messageRepo,
      memoryRepo: new MemoryRepository(world.db),
      sessionTracker: new SessionTracker(),
      summarizerRun,
      logger: world.logger,
    });

    const rotated = await roller.checkAndRotate(
      uninspected.threadId,
      world.analystId,
      { ratio: 0.9, inputTokens: 90_000, rawMetric: 90_000, rawMetricName: 'context_tokens' },
      0.5,
      'session-summarizer',
      { source: world.contextSource, imageLookupExposed: true },
    );

    expect(rotated.rotated).toBe(true);
    expect(summarizerInput).toContain(IMAGE_CONTEXT_FRAMING.inventorySectionHeader);
    expect(summarizerInput).toContain(uninspected.imageId);
    expect(summarizerInput).toContain(inspected.imageId);
    expect(summarizerInput).toContain(answer.answer);
    expect(summarizerInput).not.toContain(world.dataDir);
  });

  it('pages the inventory and returns exact Findings through image_lookup', async () => {
    world = await makeWorld();
    const first = await uploadImage(world, 'chat-lookup', 'ext-a');
    // Distinct receipt times make the newest-first page order deterministic.
    world.clock.now += 1_000;
    const second = await uploadImage(world, 'chat-lookup', 'ext-b');
    const runId = seedRun(world, first.threadId, world.analystId);
    const answer = { answer: 'Answer preserved byte for byte.', extractedText: 'abc' };
    const vision = await makeVisionHarness(world, answer);
    const inspected = await inspect(world, vision, first.threadId, world.analystId, runId, [
      first.imageId,
    ]);
    const findingId = (inspected.result as { data: { findingId: string } }).data.findingId;

    // Page 1: one Image, newest receipt first, with a continuation cursor.
    const page1 = await world.lookup.execute(
      { operation: 'list_images', limit: 1 },
      toolContext(first.threadId, world.analystId, runId),
    );
    expect(page1.status).toBe('success');
    const page1Result = page1.result as {
      images: Array<{ imageId: string; state: string }>;
      nextCursor: string | null;
    };
    expect(page1Result.images.map((image) => image.imageId)).toEqual([second.imageId]);
    expect(page1Result.nextCursor).toBeTypeOf('string');

    // Page 2: the continuation, then exhaustion.
    const page2 = await world.lookup.execute(
      { operation: 'list_images', limit: 1, cursor: page1Result.nextCursor },
      toolContext(first.threadId, world.analystId, runId),
    );
    const page2Result = page2.result as {
      images: Array<{ imageId: string }>;
      nextCursor: string | null;
    };
    expect(page2Result.images.map((image) => image.imageId)).toEqual([first.imageId]);
    expect(page2Result.nextCursor).toBeNull();

    // get_image returns the current descriptor.
    const got = await world.lookup.execute(
      { operation: 'get_image', imageId: first.imageId },
      toolContext(first.threadId, world.analystId, runId),
    );
    expect(got.status).toBe('success');
    expect(got.result).toMatchObject({ image: { imageId: first.imageId, state: 'available' } });

    // get_finding returns the canonical Finding verbatim.
    const gotFinding = await world.lookup.execute(
      { operation: 'get_finding', findingId },
      toolContext(first.threadId, world.analystId, runId),
    );
    expect(gotFinding.status).toBe('success');
    expect(gotFinding.result).toMatchObject({
      finding: {
        findingId,
        answer: answer.answer,
        extractedText: answer.extractedText,
        imageIds: [first.imageId],
        runId,
      },
    });
    expect(JSON.stringify(gotFinding)).not.toContain(world.dataDir);
  });

  it('scopes image_lookup to the calling thread and requires image.read', async () => {
    world = await makeWorld();
    const owned = await uploadImage(world, 'chat-owned', 'ext-owned');
    const other = await uploadImage(world, 'chat-other', 'ext-other');
    const deskThread = await uploadImage(
      world,
      'chat-desk',
      'ext-desk',
      'what is this?',
      'desk-bot',
    );

    const runId = seedRun(world, owned.threadId, world.analystId);
    const answer = { answer: 'Only the owning thread may read this.' };
    const vision = await makeVisionHarness(world, answer);
    const inspected = await inspect(world, vision, owned.threadId, world.analystId, runId, [
      owned.imageId,
    ]);
    const findingId = (inspected.result as { data: { findingId: string } }).data.findingId;

    // The other thread's own inventory contains only its own Image.
    const ownList = await world.lookup.execute(
      { operation: 'list_images' },
      toolContext(other.threadId, world.analystId, runId),
    );
    const ownImages = (ownList.result as { images: Array<{ imageId: string }> }).images;
    expect(ownImages.map((image) => image.imageId)).toEqual([other.imageId]);

    // Cross-thread reads by ID are indistinguishable from unknown IDs.
    const crossImage = await world.lookup.execute(
      { operation: 'get_image', imageId: owned.imageId },
      toolContext(other.threadId, world.analystId, runId),
    );
    const unknownImage = await world.lookup.execute(
      { operation: 'get_image', imageId: 'img-does-not-exist' },
      toolContext(other.threadId, world.analystId, runId),
    );
    expect(crossImage.status).toBe('error');
    expect(unknownImage.status).toBe('error');
    expect(JSON.stringify(crossImage)).not.toContain(owned.messageId);
    // Same answer shape and text: ownership cannot be probed.
    expect({ status: crossImage.status, error: crossImage.error }).toEqual({
      status: unknownImage.status,
      error: unknownImage.error,
    });

    const crossFinding = await world.lookup.execute(
      { operation: 'get_finding', findingId },
      toolContext(other.threadId, world.analystId, runId),
    );
    expect(crossFinding.status).toBe('error');
    expect(JSON.stringify(crossFinding)).not.toContain(answer.answer);

    // A persona without `image.read` is denied before any read happens.
    const denied = await world.lookup.execute(
      { operation: 'list_images' },
      toolContext(deskThread.threadId, world.deskId, runId),
    );
    expect(denied.status).toBe('error');
    expect(JSON.stringify(denied)).toContain(IMAGE_LOOKUP_CAPABILITY);
    expect(JSON.stringify(denied)).not.toContain(owned.imageId);
  });

  it('expires an Image: file deleted, Finding kept, Inspection denied, re-upload admitted', async () => {
    world = await makeWorld();
    const { threadId, imageId } = await uploadImage(world, 'chat-expiry', 'ext-1');
    const runId = seedRun(world, threadId, world.analystId);
    const answer = { answer: 'Recorded before the pixels were deleted.' };
    const vision = await makeVisionHarness(world, answer);
    const inspected = await inspect(world, vision, threadId, world.analystId, runId, [imageId]);
    expect(inspected.status).toBe('success');
    const findingId = (inspected.result as { data: { findingId: string } }).data.findingId;
    expect(world.store.normalizedExists(threadId, imageId)).toBe(true);

    // Advance past retention. The next read applies the expiry transition.
    world.clock.now += IMAGES_CONFIG.retentionHours * HOUR + 1;

    const expired = await world.contextSource.listThreadDescriptors(threadId);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      imageId,
      state: 'unavailable',
      unavailabilityReason: 'expired',
    });

    const row = world.imageRepo.findById(imageId)._unsafeUnwrap()!;
    expect(row.state).toBe('unavailable');
    expect(row.unavailability_reason).toBe('expired');
    // The Normalized file is gone.
    expect(world.store.normalizedExists(threadId, imageId)).toBe(false);

    // The transition is durable and the Image stays discoverable as
    // Unavailable on every LATER read instead of vanishing from inventory.
    const listedAfter = await world.contextSource.listThreadDescriptors(threadId);
    expect(listedAfter.map((descriptor) => descriptor.state)).toEqual(['unavailable']);
    const lookupList = await world.lookup.execute(
      { operation: 'list_images' },
      toolContext(threadId, world.analystId, runId),
    );
    expect(
      (lookupList.result as { images: Array<{ imageId: string; state: string }> }).images,
    ).toEqual([expect.objectContaining({ imageId, state: 'unavailable' })]);

    // The Finding survives, verbatim, in both projection and lookup.
    const findings = await world.contextSource.listThreadFindings(threadId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.answer).toBe(answer.answer);
    const kept = await world.lookup.execute(
      { operation: 'get_finding', findingId },
      toolContext(threadId, world.analystId, runId),
    );
    expect(kept.status).toBe('success');
    expect(kept.result).toMatchObject({ finding: { findingId, answer: answer.answer } });

    // A new Inspection of the dead Image is denied and records nothing.
    const deniedInspection = await inspect(world, vision, threadId, world.analystId, runId, [
      imageId,
    ]);
    expect(deniedInspection.status).toBe('error');
    expect(vision.calls).toHaveLength(1);
    expect(await world.contextSource.listThreadFindings(threadId)).toHaveLength(1);

    // Re-uploading the same bytes admits a NEW Image with its own lifecycle.
    const again = await uploadImage(world, 'chat-expiry', 'ext-2');
    expect(again.imageId).not.toBe(imageId);
    expect(again.threadId).toBe(threadId);
    expect(world.imageRepo.findById(again.imageId)._unsafeUnwrap()!.state).toBe('available');
    expect(world.store.normalizedExists(threadId, again.imageId)).toBe(true);

    const recovered = await inspect(world, vision, threadId, world.analystId, runId, [
      again.imageId,
    ]);
    expect(recovered.status).toBe('success');
    const recoveredData = recovered.result as { data: { imageIds: string[] } };
    expect(recoveredData.data.imageIds).toEqual([again.imageId]);
    expect(await world.contextSource.listThreadFindings(threadId)).toHaveLength(2);
  });

  it('reports an Image that expires in the queue backlog as unavailable, never available', async () => {
    world = await makeWorld();
    const { threadId, messageId, imageId } = await uploadImage(world, 'chat-backlog', 'ext-1');
    // The item waits in the queue; retention lapses before its turn.
    world.clock.now += IMAGES_CONFIG.retentionHours * HOUR + 1;

    const harness = makeAgentHarness(world);
    const ran = await harness.runner.run(claimNextItem(world, threadId));
    expect(ran.isOk(), ran.isErr() ? ran.error.message : '').toBe(true);

    const prompt = harness.turns[0]!.prompt;
    expect(prompt).toContain(LIVE_IMAGE_SECTION_HEADER);
    expect(prompt).toContain(`img ${imageId} state=unavailable`);
    expect(prompt).toContain('expired');
    expect(prompt).not.toContain(`img ${imageId} state=available`);
    expect(prompt).not.toContain(world.dataDir);
  });

  it('keeps a Finding recorded under a run that later failed projected and retrievable', async () => {
    world = await makeWorld();
    const { threadId, imageId } = await uploadImage(world, 'chat-failed', 'ext-1');
    const runId = seedRun(world, threadId, world.analystId);
    const answer = { answer: 'This Finding outlives the run that made it.' };
    const vision = await makeVisionHarness(world, answer);
    const inspected = await inspect(world, vision, threadId, world.analystId, runId, [imageId]);
    expect(inspected.status).toBe('success');
    const findingId = (inspected.result as { data: { findingId: string } }).data.findingId;

    // The provider stream aborts after the tool call: the run is transitioned
    // to `failed` through the same repository call AgentRunner uses.
    world.runRepo
      .updateStatus(runId, 'failed', { error: 'provider stream aborted after tool call' })
      ._unsafeUnwrap();
    expect(world.runRepo.findById(runId)._unsafeUnwrap()!.status).toBe('failed');

    // The Finding is still in the ledger, the projection, and the lookup.
    const findings = await world.contextSource.listThreadFindings(threadId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ findingId, runId, answer: answer.answer });

    const assembled = world.assembler.assemble(threadId, 10, {
      images: {
        live: EMPTY_LIVE_BLOCK,
        inventoryDescriptors: await world.contextSource.listThreadDescriptors(threadId),
        findings,
        imageLookupExposed: false,
      },
    });
    expect(assembled.text).toContain(answer.answer);
    expect(assembled.text).toContain(imageId);

    const looked = await world.lookup.execute(
      { operation: 'get_finding', findingId },
      toolContext(threadId, world.analystId, 'req-unrelated'),
    );
    expect(looked.status).toBe('success');
    expect(looked.result).toMatchObject({ finding: { findingId, answer: answer.answer } });
  });

  it('does not leak pixel bytes or storage paths into daemon logs during the workflow', async () => {
    world = await makeWorld();
    const { threadId, messageId, imageId } = await uploadImage(world, 'chat-logs', 'ext-1');
    const runId = seedRun(world, threadId, world.analystId);
    const vision = await makeVisionHarness(world, { answer: 'A blue square.' });
    await inspect(world, vision, threadId, world.analystId, runId, [imageId]);
    const pixels = normalizedBase64(world, threadId, imageId);

    const harness = makeAgentHarness(world);
    expect((await harness.runner.run(pendingItemForMessage(world, messageId))).isOk()).toBe(true);
    world.clock.now += IMAGES_CONFIG.retentionHours * HOUR + 1;
    await world.contextSource.listThreadDescriptors(threadId);

    const joined = world.logLines.join('\n');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toContain(world.dataDir);
    expect(joined).not.toContain(pixels);
    expect(joined).not.toContain(SOURCE_PNG.toString('base64'));
  });
});

// ---------------------------------------------------------------------------
// Bootstrapped-daemon world (TASK-019 P1-2)
// ---------------------------------------------------------------------------

/**
 * Everything below runs the SHIPPED `bootstrap()` from
 * `src/daemon/daemon-bootstrap.ts` against a temp dataDir, and proves that the
 * image subsystem is reachable through the objects bootstrap actually hands
 * the daemon — not through a hand-assembled approximation of them.
 *
 * Only two seams exist, both deterministic and both model-side:
 *
 * - the foreground provider strategy (a `ProviderRegistry` entry whose
 *   `run()` behaves like a real provider shim: it reads the
 *   `__talond_host_tools` env AgentRunner exported and speaks the real NDJSON
 *   protocol over the real Unix socket);
 * - `@ai-sdk/anthropic`, the factory `ModelResolver` uses for the shipped
 *   `vision` manifest (mocked at module scope above).
 *
 * `bootstrap()` constructs and wires but never starts services, and the
 * config declares NO channels, so no connector and no TCP listener of any
 * kind exists. The only socket in play is the Unix socket under the temp
 * dataDir that `HostToolsBridge` owns.
 */
interface BootWorld {
  root: string;
  ctx: DaemonContext;
  analystId: string;
  turns: CapturedTurn[];
  toolCalls: Array<{ tool: string; response: BridgeResponseShape }>;
  close(): void;
}

/** The subset of the bridge response this suite asserts on. */
interface BridgeResponseShape {
  id: string;
  result?: { status: string; error?: string; result?: unknown };
  error?: string;
}

/** One line of the bridge's NDJSON protocol, asked and answered over a socket. */
function bridgeRequest(socketPath: string, payload: unknown): Promise<BridgeResponseShape> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as BridgeResponseShape);
    });
    socket.once('error', reject);
  });
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`host-tools bridge socket never appeared at ${socketPath}`);
}

/** Fails if anything is accepting TCP on a smoke port. */
async function expectNoTcpListener(port: number): Promise<void> {
  const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.end();
      resolve(
        Object.assign(new Error(`something is listening on TCP ${port}`), {
          code: 'LISTENING',
        }),
      );
    });
    socket.once('error', (err) => {
      socket.destroy();
      resolve(err);
    });
  });
  expect(error.code, `TCP port ${port} must stay closed during image e2e`).not.toBe('LISTENING');
}

/**
 * The smallest config that boots: no channels (so no connector, no port), one
 * vision-capable persona, and an Anthropic credential whose value is inert
 * because the SDK factory is the mocked seam.
 */
function writeBootConfig(root: string): string {
  const configPath = path.join(root, 'talond.yaml');
  fs.writeFileSync(
    configPath,
    [
      `dataDir: ${path.join(root, 'data')}`,
      `logLevel: error`,
      `storage:`,
      `  path: ${path.join(root, 'data', 'talond.sqlite')}`,
      `channels: []`,
      `auth:`,
      `  providers:`,
      `    anthropic:`,
      `      apiKey: test-anthropic-key-never-used`,
      `agentRunner:`,
      `  defaultProvider: fake-codex`,
      `  providers:`,
      `    fake-codex:`,
      `      enabled: true`,
      `      command: fake-codex`,
      `backgroundAgent:`,
      `  enabled: false`,
      `personas:`,
      `  - name: analyst`,
      `    model: fake-foreground-model`,
      `    provider: fake-codex`,
      `    subagents:`,
      `      - vision`,
      `    capabilities:`,
      `      allow:`,
      `        - image.read:thread`,
      `        - subagent.invoke`,
      `  - name: desk`,
      `    model: fake-foreground-model`,
      `    provider: fake-codex`,
      `    capabilities:`,
      `      allow: []`,
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

/**
 * A provider strategy that does what a real provider's MCP shim does: read the
 * exported bridge env, open the Unix socket, and issue the tool calls the live
 * prompt advertises. The Inspection is therefore issued BY the foreground run
 * through the real bridge, not called directly by the test.
 */
function makeBridgeSpeakingRegistry(
  world: Pick<BootWorld, 'turns' | 'toolCalls'>,
): ProviderRegistry {
  const provider = {
    name: 'fake-codex',
    skillLoaderTransport: 'stdio',
    createExecutionStrategy: () => ({
      type: 'cli' as const,
      supportsSessionResumption: false,
      run: async (input: AgentRunInput) => {
        world.turns.push({
          prompt: input.prompt,
          systemPrompt: input.systemPrompt,
        });

        const env = input.mcpServers.__talond_host_tools?.env ?? {};
        const socketPath = env.TALOND_SOCKET as string;
        const bridgeSecret = env[TALOND_BRIDGE_SECRET_ENV] as string;
        const context = {
          runId: env.TALOND_RUN_ID as string,
          threadId: env.TALOND_THREAD_ID as string,
          personaId: env.TALOND_PERSONA_ID as string,
          requestId: 'req-boot-1',
        };

        // The images the live descriptor advertised are the images the shim
        // inspects; a descriptor that omitted them could not be recovered here.
        const advertised = [...input.prompt.matchAll(/img ([0-9a-f-]{36}) state=available/g)].map(
          (match) => match[1]!,
        );

        for (const [index, tool] of [
          {
            tool: 'subagent_invoke',
            args: {
              name: 'vision',
              input: { question: 'What is in this image?', imageIds: advertised },
            },
          },
          { tool: 'image_lookup', args: { operation: 'list_images', limit: 5 } },
        ].entries()) {
          const response = await bridgeRequest(socketPath, {
            id: `call-boot-${index}`,
            ...tool,
            bridgeSecret,
            context,
          });
          world.toolCalls.push({ tool: tool.tool, response });
        }

        return {
          output: 'ACK',
          sessionId: 'sess-boot-1',
          usage: { inputTokens: 1_000, outputTokens: 20 },
          isError: false,
        };
      },
    }),
    estimateContextUsage: (usage: { inputTokens?: number }) => ({
      inputTokens: usage.inputTokens ?? 0,
      metrics: { input_tokens: usage.inputTokens ?? 0 },
    }),
  } as unknown as AgentProvider;

  return new ProviderRegistry(
    {
      'fake-codex': {
        enabled: true,
        command: 'fake-codex',
        contextWindowTokens: 200_000,
      },
    } as never,
    { 'fake-codex': () => provider } as never,
  );
}

async function makeBootWorld(): Promise<BootWorld> {
  BaseRepository.__resetMonotonicClockForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-image-boot-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  visionSeam.calls.length = 0;

  const logger = pino({ level: 'silent' });
  const booted = await bootstrap(writeBootConfig(root), logger);
  if (booted.isErr()) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`bootstrap failed: ${booted.error.message}`);
  }
  const ctx = booted.value;

  // The registry bootstrap built has no factory for the config's provider
  // name, so the deterministic strategy is installed on the bootstrapped
  // context. Every other field — including the bridge, the pipeline and the
  // image context source — is the object bootstrap returned.
  const world: Pick<BootWorld, 'turns' | 'toolCalls'> = { turns: [], toolCalls: [] };
  (ctx as { providerRegistry: ProviderRegistry }).providerRegistry =
    makeBridgeSpeakingRegistry(world);

  // Channel + binding rows only (no connector object, hence no transport).
  const channelId = uuidv4();
  ctx.repos.channel
    .insert({
      id: channelId,
      type: 'telegram',
      name: 'boot-bot',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    })
    ._unsafeUnwrap();
  const analystId = ctx.repos.persona.findByName('analyst')._unsafeUnwrap()!.id;
  ctx.repos.binding
    .insert({
      id: uuidv4(),
      channel_id: channelId,
      thread_id: null,
      persona_id: analystId,
      is_default: 1,
    })
    ._unsafeUnwrap();

  return {
    root,
    ctx,
    analystId,
    turns: world.turns,
    toolCalls: world.toolCalls,
    close(): void {
      ctx.hostToolsBridge.stop?.();
      ctx.db.close();
    },
  };
}

/** Admits an image-bearing message through the bootstrapped pipeline. */
async function bootUpload(
  world: BootWorld,
  externalChatId: string,
  externalMessageId: string,
): Promise<{ threadId: string; messageId: string; imageId: string }> {
  const admitted = await world.ctx.messagePipeline.handleInboundEvent({
    channelType: 'telegram',
    channelName: 'boot-bot',
    externalThreadId: externalChatId,
    senderId: 'user-1',
    content: 'what is in this image?',
    idempotencyKey: externalMessageId,
    timestamp: START,
    attachments: [
      {
        filename: 'photo.png',
        mimeType: 'image/png',
        data: Buffer.from(SOURCE_PNG),
        size: SOURCE_PNG.byteLength,
      },
    ],
  });
  expect(admitted.isOk(), admitted.isErr() ? admitted.error.message : '').toBe(true);

  const channelId = world.ctx.repos.channel.findByName('boot-bot')._unsafeUnwrap()!.id;
  const thread = world.ctx.repos.thread.findByExternalId(channelId, externalChatId)._unsafeUnwrap();
  expect(thread).not.toBeNull();

  const row = world.ctx.db
    .prepare<[string], { id: string }>('SELECT id FROM messages WHERE idempotency_key = ?')
    .get(`${channelId}:${externalMessageId}`);
  expect(row, 'no stored message for the upload').not.toBeUndefined();

  const images = world.ctx.repos.image.findByMessage(row!.id)._unsafeUnwrap();
  expect(images).toHaveLength(1);
  return { threadId: thread!.id, messageId: row!.id, imageId: images[0]!.id };
}

/** The pending queue item for a message, as the dequeue loop would hand it over. */
function bootPendingItem(world: BootWorld, messageId: string): QueueItem {
  const rows = world.ctx.repos.queue.findPending()._unsafeUnwrap();
  const row = rows.find((candidate) => candidate.message_id === messageId);
  expect(row, `no pending queue item for message ${messageId}`).toBeDefined();
  return toQueueItem(row!);
}

// ---------------------------------------------------------------------------
// Bootstrap wiring tests
// ---------------------------------------------------------------------------

describe('bootstrapped daemon image wiring (TASK-019 P1-2)', () => {
  let world: BootWorld;

  afterEach(() => {
    if (world) {
      world.close();
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });

  it('wires the real ImageContextSource and gives the bridge its lookup authorities', async () => {
    world = await makeBootWorld();

    expect(world.ctx).toBeDefined();
    expect(world.ctx.imageContextSource).toBeInstanceOf(DaemonImageContextSource);
    expect(world.ctx.hostToolsBridge).toBeInstanceOf(HostToolsBridge);
    expect(world.ctx.messagePipeline).toBeDefined();
    expect(world.ctx.hostToolsBridge.path.startsWith(path.join(world.root, 'data'))).toBe(true);

    // No connector, therefore no transport: the bootstrapped registry is empty
    // and both smoke ports stay closed.
    expect(world.ctx.channelRegistry.listAll()).toHaveLength(0);
    await expectNoTcpListener(17700);
    await expectNoTcpListener(17701);
  });

  it('admits an upload through the bootstrapped pipeline into an Available Image', async () => {
    world = await makeBootWorld();
    const { threadId, messageId, imageId } = await bootUpload(world, 'chat-boot-admit', 'ext-1');

    const row = world.ctx.repos.image.findById(imageId)._unsafeUnwrap()!;
    expect(row.state).toBe('available');
    expect(row.message_id).toBe(messageId);
    expect(row.mime_type).toBe('image/jpeg');

    const normalized = fs.readFileSync(
      world.ctx.imageStore.normalizedPath(threadId, imageId)._unsafeUnwrap(),
    );
    expect([...normalized.subarray(0, 3)]).toEqual(JPEG_MAGIC);

    const payload = JSON.stringify(bootPendingItem(world, messageId).payload);
    expect(payload).not.toContain(normalized.toString('base64'));
    expect(payload).not.toContain(world.root);

    // The context source bootstrap wired sees the live Image.
    const live = await world.ctx.imageContextSource.resolveMessageDescriptors({
      threadId,
      messageId,
    });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ imageId, state: 'available' });

    await expectNoTcpListener(17700);
    await expectNoTcpListener(17701);
  });

  it('runs a foreground turn that Inspects over the real bridge and persists a Finding', async () => {
    world = await makeBootWorld();
    const { threadId, messageId, imageId } = await bootUpload(world, 'chat-boot-run', 'ext-1');

    world.ctx.hostToolsBridge.start();
    await waitForSocket(world.ctx.hostToolsBridge.path);

    const ran = await new AgentRunner(world.ctx, {
      imageContextSource: world.ctx.imageContextSource,
    }).run(bootPendingItem(world, messageId));
    expect(ran.isOk(), ran.isErr() ? ran.error.message : '').toBe(true);

    // The foreground turn carried the live descriptor and no pixels.
    expect(world.turns).toHaveLength(1);
    const turn = world.turns[0]!;
    expect(turn.prompt).toContain(LIVE_IMAGE_SECTION_HEADER);
    expect(turn.prompt).toContain(`img ${imageId} state=available`);
    const pixels = fs
      .readFileSync(world.ctx.imageStore.normalizedPath(threadId, imageId)._unsafeUnwrap())
      .toString('base64');
    expect(turn.prompt).not.toContain(pixels);
    expect(turn.prompt).not.toContain(world.root);

    // Both tool legs were served by the bridge bootstrap built.
    expect(world.toolCalls.map((call) => call.tool)).toEqual(['subagent_invoke', 'image_lookup']);
    const inspection = world.toolCalls[0]!.response;
    expect(inspection.error).toBeUndefined();
    expect(inspection.result?.status).toBe('success');
    expect(JSON.stringify(inspection.result?.result)).toContain(visionSeam.answer.answer);
    expect(JSON.stringify(inspection.result)).not.toContain(pixels);

    // The Inspection really went through the shipped vision manifest: the
    // mocked Anthropic factory saw one request carrying the Normalized JPEG.
    expect(visionSeam.calls).toHaveLength(1);
    const carried = collectPromptJpeg(visionSeam.calls[0]!);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.equals(Buffer.from(pixels, 'base64'))).toBe(true);

    // A canonical Finding was persisted for the foreground run and is readable
    // through the context source the daemon actually holds.
    const findings = await world.ctx.imageContextSource.listThreadFindings(threadId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      answer: visionSeam.answer.answer,
      question: 'What is in this image?',
      threadId,
      imageIds: [imageId],
    });
    const runId = findings[0]!.runId;
    expect(world.ctx.repos.run.findById(runId)._unsafeUnwrap()).not.toBeNull();

    // The `image_lookup` leg answered from the same wiring, text-only and
    // scoped to the calling thread.
    const lookup = world.toolCalls[1]!.response;
    expect(lookup.error).toBeUndefined();
    expect(lookup.result?.status).toBe('success');
    const listed = lookup.result?.result as { images?: Array<{ imageId: string }> };
    expect(listed.images?.map((image) => image.imageId)).toEqual([imageId]);
    expect(JSON.stringify(lookup.result)).not.toContain(pixels);

    await expectNoTcpListener(17700);
    await expectNoTcpListener(17701);
  });

  it('refuses a persona without image.read through the real bridge', async () => {
    world = await makeBootWorld();

    // Rebind the channel onto the persona that has no capabilities BEFORE the
    // message is admitted, so the routed run really belongs to `desk`.
    const deskId = world.ctx.repos.persona.findByName('desk')._unsafeUnwrap()!.id;
    const channelId = world.ctx.repos.channel.findByName('boot-bot')._unsafeUnwrap()!.id;
    world.ctx.db
      .prepare('UPDATE bindings SET persona_id = ? WHERE channel_id = ?')
      .run(deskId, channelId);

    const { threadId, messageId } = await bootUpload(world, 'chat-boot-deny', 'ext-1');

    world.ctx.hostToolsBridge.start();
    await waitForSocket(world.ctx.hostToolsBridge.path);

    expect(
      (
        await new AgentRunner(world.ctx, {
          imageContextSource: world.ctx.imageContextSource,
        }).run(bootPendingItem(world, messageId))
      ).isOk(),
    ).toBe(true);

    // The shim was never given the image tools, and a forged call over the
    // real socket is refused by the bridge's own capability gate.
    const turn = world.turns[0]!;
    expect(turn.prompt).not.toContain('image_lookup');

    // No Inspection was recorded: the persona could not reach either leg.
    expect(await world.ctx.imageContextSource.listThreadFindings(threadId)).toHaveLength(0);

    const forged = await bridgeRequest(world.ctx.hostToolsBridge.path, {
      id: 'call-forged',
      tool: 'image_lookup',
      args: { operation: 'list_images', limit: 5 },
      bridgeSecret: 'not-the-real-secret',
      context: { runId: 'no-such-run', threadId, personaId: deskId, requestId: 'req-forged' },
    });
    expect(forged.result).toBeUndefined();
    expect(forged.error).toContain('Invalid bridge secret');

    await expectNoTcpListener(17700);
    await expectNoTcpListener(17701);
  });
});
