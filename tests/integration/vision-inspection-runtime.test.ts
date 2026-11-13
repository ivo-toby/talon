/**
 * TASK-014 integration: a text-only foreground persona reaches the built-in
 * vision sub-agent and the canonical Finding ledger through the real daemon
 * wiring shape.
 *
 * Everything is real except the model adapter:
 *
 * - file-backed SQLite (WAL) with the real repositories (channel, thread,
 *   message, run, persona, image, ingestion, queue, finding, memory,
 *   schedule, audit);
 * - the real durable Image ingestion pipeline (ImageIngestionCoordinator +
 *   real QueueManager) producing the Available Image the Inspection reads,
 *   with the native Sharp normalizer as the only injected seam;
 * - the real ImageService (the `ImageAccess` port bootstrap supplies) and
 *   the real FindingRepository (the `findings` service bootstrap supplies);
 * - the real SubAgentLoader loading the SHIPPED built-in `vision` sub-agent
 *   from `src/subagents/default` (no manifest or entry mocks) and the real
 *   SubAgentRunner + SubAgentInvokeHandler (persona assignment + capability
 *   checks intact);
 * - the AI SDK `generateText` path is deterministic via a `MockLanguageModelV3`
 *   that captures every model request and returns a scripted JSON answer.
 *
 * Guarantees pinned:
 *
 * - the foreground result is TEXT ONLY: the Finding's answer/extractedText/
 *   uncertainty verbatim, no image bytes or base64 in the tool result;
 * - the model request carried the real Normalized JPEG bytes (the pixel
 *   path is real, the foreground stays text-only);
 * - exactly one canonical Finding is persisted with trusted run/thread/image
 *   provenance and the reported usage, and a Finding creates no synthetic
 *   message;
 * - the saved Finding survives a subsequent FAILED foreground run;
 * - explicit errors, never silent degradation: an unassigned persona is
 *   denied, a runner missing the Finding service rejects, and the configured
 *   Inspection ceiling is enforced before any model request;
 * - wiring is not authorization: `subagent.invoke` and `image.read` stay
 *   capability-gated by the real policy function.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ok, type Result } from 'neverthrow';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';

import { runMigrations } from '../../src/core/database/migrations/runner.js';
import {
  ChannelRepository,
  ThreadRepository,
  MessageRepository,
  RunRepository,
  PersonaRepository,
  MemoryRepository,
  ScheduleRepository,
  QueueRepository,
  ImageRepository,
  ImageIngestionRepository,
  FindingRepository,
} from '../../src/core/database/repositories/index.js';
import { QueueManager } from '../../src/queue/queue-manager.js';
import type { AuditStore } from '../../src/core/logging/audit-logger.js';
import { ImageStore } from '../../src/images/image-store.js';
import {
  ImageIngestionCoordinator,
  type ImageIngestionRequest,
} from '../../src/images/image-ingestion.js';
import { ImageService } from '../../src/images/image-service.js';
import type { ImagesConfig } from '../../src/core/config/config-types.js';
import type {
  ImageNormalizationOptions,
  ImageNormalizationResult,
  ImageNormalizationError,
} from '../../src/images/image-normalizer.js';
import { PersonaLoader } from '../../src/personas/persona-loader.js';
import { PersonaConfigSchema } from '../../src/core/config/config-schema.js';
import { SubAgentLoader } from '../../src/subagents/subagent-loader.js';
import { SubAgentRunner } from '../../src/subagents/subagent-runner.js';
import type { ModelResolver } from '../../src/subagents/model-resolver.js';
import type { SubAgentServices } from '../../src/subagents/subagent-types.js';
import { SubAgentInvokeHandler } from '../../src/tools/host-tools/subagent-invoke.js';
import { isToolAllowed } from '../../src/tools/tool-filter.js';
import type { ResolvedCapabilities } from '../../src/personas/persona-types.js';

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

const NOW = Date.now();

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

/** A small real JPEG used as the normalized output of the ingest pipeline. */
const NORMALIZED_JPEG: Buffer = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 128, b: 220 } },
})
  .jpeg({ quality: 90 })
  .toBuffer();

function migrationsDir(): string {
  return path.join(import.meta.dirname, '../../src/core/database/migrations');
}

const builtinSubAgentsDir = path.join(import.meta.dirname, '../../src/subagents/default');

interface World {
  dataDir: string;
  db: Database.Database;
  channelId: string;
  threadId: string;
  personaId: string;
  personaLoader: PersonaLoader;
  personaRepo: PersonaRepository;
  imageRepo: ImageRepository;
  messageRepo: MessageRepository;
  runRepo: RunRepository;
  findings: FindingRepository;
  coordinator: ImageIngestionCoordinator;
  imageAccess: ImageService;
  auditEntries: unknown[];
  close(): void;
}

async function makeWorld(): Promise<World> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-vision-runtime-'));
  const db = new Database(path.join(dataDir, 'talon.sqlite'));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  const migrated = runMigrations(db, migrationsDir());
  if (migrated.isErr()) {
    db.close();
    throw new Error(`migration failed: ${migrated.error.message}`);
  }

  const logger = pino({ level: 'silent' });
  const channelId = uuidv4();
  const threadId = uuidv4();

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
  const store = new ImageStore(dataDir);

  const auditEntries: unknown[] = [];
  const auditStore: AuditStore = {
    append: (entry) => {
      auditEntries.push(entry);
    },
  };

  // Seed channel + thread.
  channelRepo
    .insert({
      id: channelId,
      type: 'telegram',
      name: 'vision-bot',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    })
    ._unsafeUnwrap();
  threadRepo
    .insert({
      id: threadId,
      channel_id: channelId,
      external_id: 'ext-chat-vision',
      metadata: '{}',
    })
    ._unsafeUnwrap();

  // Text-only foreground persona: no image capability of its own, but
  // explicitly assigned the vision sub-agent and holding `subagent.invoke`.
  const personaConfig = PersonaConfigSchema.parse({
    name: 'textdesk',
    model: 'claude-sonnet-4-6',
    subagents: ['vision'],
    capabilities: { allow: ['subagent.invoke'] },
  });
  const personaLoader = new PersonaLoader(personaRepo, logger);
  const loaded = (await personaLoader.loadFromConfig([personaConfig]))._unsafeUnwrap();
  expect(loaded).toHaveLength(1);
  const personaId = personaRepo.findByName('textdesk')._unsafeUnwrap()!.id;

  const queueManager = new QueueManager(queueRepo, threadRepo, QUEUE_CONFIG, logger);

  // Real durable ingestion pipeline; the native Sharp normalizer is the only
  // injected seam and writes a real JPEG.
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
    now: () => NOW,
    normalize: async (
      _source: Buffer,
      options: ImageNormalizationOptions,
    ): Promise<Result<ImageNormalizationResult, ImageNormalizationError>> => {
      fs.writeFileSync(options.tempFilePath, NORMALIZED_JPEG);
      return ok({
        filePath: options.tempFilePath,
        dimensions: { width: 8, height: 8 },
        sourceDimensions: { width: 8, height: 8 },
      });
    },
  });

  // The same ImageAccess port bootstrap supplies to SubAgentServices.
  const imageAccess = new ImageService({
    imageRepo,
    store,
    logger,
    auditStore,
  });

  return {
    dataDir,
    db,
    channelId,
    threadId,
    personaId,
    personaLoader,
    personaRepo,
    imageRepo,
    messageRepo,
    runRepo,
    findings,
    coordinator,
    imageAccess,
    auditEntries,
    close(): void {
      db.close();
    },
  };
}

/** Admits one image-bearing message through the real pipeline and returns the Available Image id. */
async function admitImage(world: World, externalId: string): Promise<string> {
  const request: ImageIngestionRequest = {
    channelId: world.channelId,
    channelName: 'vision-bot',
    externalMessageId: externalId,
    externalChatId: 'ext-chat-vision',
    threadId: world.threadId,
    message: {
      id: uuidv4(),
      content: 'look at this',
      senderId: 'user-1',
      idempotencyKey: externalId,
    },
    attachments: [
      {
        filename: 'photo.png',
        mimeType: 'image/png',
        data: Buffer.from('SOURCE-BYTES'),
        size: 12,
      },
    ],
    personaId: world.personaId,
  };
  const outcome = await world.coordinator.ingestMessage(request);
  expect(outcome.isOk()).toBe(true);
  expect(outcome._unsafeUnwrap()).toBe('enqueued');

  const images = world.imageRepo.findByThread(world.threadId)._unsafeUnwrap();
  expect(images).toHaveLength(1);
  expect(images[0]!.state).toBe('available');
  return images[0]!.id;
}

function seedRun(world: World, status: 'running' | 'failed' = 'running'): string {
  const runId = uuidv4();
  world.runRepo
    .insert({
      id: runId,
      thread_id: world.threadId,
      persona_id: world.personaId,
      provider_name: 'claude-code',
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
      error: status === 'failed' ? 'foreground provider stream aborted' : null,
      started_at: NOW,
      ended_at: status === 'failed' ? NOW + 1 : null,
    })
    ._unsafeUnwrap();
  return runId;
}

// ---------------------------------------------------------------------------
// Deterministic vision adapter (the only seam over the real runner)
// ---------------------------------------------------------------------------

interface VisionAnswer {
  answer: string;
  extractedText?: string;
  uncertainty?: string;
}

function makeDeterministicModel(answer: VisionAnswer): {
  model: LanguageModelV3;
  calls: LanguageModelV3CallOptions[];
} {
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
  return { model, calls };
}

interface RunnerStack {
  runner: SubAgentRunner;
  handler: SubAgentInvokeHandler;
  calls: LanguageModelV3CallOptions[];
}

/**
 * Builds the same sub-agent stack bootstrap wires: real loader over the
 * shipped built-ins, real runner with the real services bundle, real
 * subagent.invoke handler. The deterministic model adapter is the only seam.
 */
async function makeRunnerStack(
  world: World,
  options: { maxPerInspection?: number; withFindings?: boolean; answer?: VisionAnswer } = {
    maxPerInspection: IMAGES_CONFIG.maxPerInspection,
  },
): Promise<RunnerStack> {
  const logger = pino({ level: 'silent' });
  const loader = new SubAgentLoader(logger);
  const agents = (await loader.loadAll(builtinSubAgentsDir))._unsafeUnwrap();
  const agentMap = new Map(agents.map((agent) => [agent.manifest.name, agent]));
  expect(agentMap.has('vision')).toBe(true);

  const { model, calls } = makeDeterministicModel(
    options.answer ?? {
      answer: 'A blue square fills the image.',
      extractedText: 'no visible text',
      uncertainty: 'None.',
    },
  );

  const services: SubAgentServices = {
    memory: new MemoryRepository(world.db),
    schedules: new ScheduleRepository(world.db),
    personas: new PersonaRepository(world.db),
    channels: new ChannelRepository(world.db),
    threads: new ThreadRepository(world.db),
    messages: world.messageRepo,
    runs: world.runRepo,
    queue: new QueueRepository(world.db),
    images: world.imageAccess,
    findings: options.withFindings === false ? undefined : world.findings,
    imageInspectionLimits: {
      maxPerInspection: options.maxPerInspection ?? IMAGES_CONFIG.maxPerInspection,
    },
    logger,
  };

  const runner = new SubAgentRunner(
    agentMap,
    // The deterministic adapter stands in for provider credential resolution;
    // everything above it (loader, chain runner, services, gates) is real.
    { resolve: async () => ok(model as unknown as LanguageModel) } as unknown as ModelResolver,
    services,
    logger,
  );

  const handler = new SubAgentInvokeHandler({
    runner,
    personaLoader: world.personaLoader,
    personaRepository: world.personaRepo,
    logger,
  });

  return { runner, handler, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects every image byte set carried in one model prompt (any part shape). */
function collectPromptImages(
  call: LanguageModelV3CallOptions,
): Array<{ bytes: Buffer; mediaType: string }> {
  const found: Array<{ bytes: Buffer; mediaType: string }> = [];
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
          found.push({ bytes: Buffer.from(data), mediaType: 'image/jpeg' });
        }
      }
      for (const key of Object.keys(record)) {
        if (key === 'image' || key === 'data') continue; // byte payloads are never walked
        walk(record[key]);
      }
      return;
    }
  };
  walk(call.prompt);
  return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vision Inspection runtime — real daemon wiring (TASK-014)', () => {
  let world: World;

  afterEach(() => {
    if (!world) return;
    world.close();
    fs.rmSync(world.dataDir, { recursive: true, force: true });
  });

  it('records one Finding for a text-only foreground persona and returns only text', async () => {
    world = await makeWorld();
    const imageId = await admitImage(world, 'ext-img-1');
    const runId = seedRun(world);

    const stack = await makeRunnerStack(world, {});
    const toolResult = await stack.handler.execute(
      { name: 'vision', input: { question: 'What color is the square?', imageIds: [imageId] } },
      { runId, threadId: world.threadId, personaId: world.personaId, requestId: 'req-1' },
    );

    // 1. The tool succeeds with a textual Finding.
    expect(toolResult.status).toBe('success');
    const subAgentResult = toolResult.result as {
      summary: string;
      data: Record<string, unknown>;
      usage?: Record<string, unknown>;
    };
    expect(subAgentResult.data.findingId).toBeTypeOf('string');
    expect(subAgentResult.data.answer).toBe('A blue square fills the image.');
    expect(subAgentResult.data.extractedText).toBe('no visible text');
    expect(subAgentResult.data.uncertainty).toBe('None.');
    expect(subAgentResult.data.imageIds).toEqual([imageId]);
    expect(subAgentResult.data.model).toBe('mock.vision/deterministic-vision-1');
    // Reported usage is mapped, never zero-filled.
    expect(subAgentResult.data.usage).toEqual({
      inputTokens: 120,
      outputTokens: 42,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
    expect(subAgentResult.usage).toEqual({ inputTokens: 120, outputTokens: 42 });

    // 2. The foreground result is text only: no image bytes, no base64.
    const serialized = JSON.stringify(toolResult);
    expect(serialized).not.toContain(NORMALIZED_JPEG.toString('base64'));
    expect(serialized).not.toContain('data:image');
    expect(serialized.length).toBeLessThan(4000);

    // 3. The real pixel path reached the model exactly once, with the real
    //    Normalized JPEG bytes and the question.
    expect(stack.calls).toHaveLength(1);
    const call = stack.calls[0]!;
    const promptText = JSON.stringify(call.prompt);
    expect(promptText).toContain('What color is the square?');
    const promptImages = collectPromptImages(call);
    expect(promptImages).toHaveLength(1);
    expect(promptImages[0]!.bytes.equals(NORMALIZED_JPEG)).toBe(true);
    // The real system prompt from the shipped built-in was forwarded (the AI
    // SDK delivers `system:` as a leading system message in the model prompt).
    const systemText = call.prompt
      .filter((message) => message.role === 'system')
      .map((message) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      )
      .join('\n');
    expect(systemText.length).toBeGreaterThan(0);

    // 4. Exactly one canonical Finding, with trusted provenance.
    const findingId = subAgentResult.data.findingId as string;
    const record = world.findings.findByIdInThread(findingId, world.threadId)._unsafeUnwrap();
    expect(record).not.toBeNull();
    expect(record!.finding.run_id).toBe(runId);
    expect(record!.finding.thread_id).toBe(world.threadId);
    expect(record!.finding.question).toBe('What color is the square?');
    expect(record!.finding.answer).toBe('A blue square fills the image.');
    expect(record!.finding.model_name).toBe('mock.vision/deterministic-vision-1');
    expect(record!.finding.usage_input_tokens).toBe(120);
    expect(record!.finding.usage_output_tokens).toBe(42);
    expect(record!.finding.usage_cache_read_tokens).toBe(30);
    expect(record!.finding.usage_cache_write_tokens).toBe(0);
    expect(record!.imageIds).toEqual([imageId]);
    expect(
      world.findings.findPage({ threadId: world.threadId })._unsafeUnwrap().findings,
    ).toHaveLength(1);

    // 5. A Finding creates no synthetic message.
    const messageCount = (
      world.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
    ).c;
    expect(messageCount).toBe(1); // only the ingested inbound message
  });

  it('keeps the saved Finding after a subsequent FAILED foreground run', async () => {
    world = await makeWorld();
    const imageId = await admitImage(world, 'ext-img-2');
    const runId = seedRun(world);

    const stack = await makeRunnerStack(world, {});
    const toolResult = await stack.handler.execute(
      { name: 'vision', input: { question: 'Describe the image.', imageIds: [imageId] } },
      { runId, threadId: world.threadId, personaId: world.personaId, requestId: 'req-2' },
    );
    expect(toolResult.status).toBe('success');
    const findingId = (toolResult.result as { data: Record<string, unknown> }).data
      .findingId as string;

    // The foreground run that invoked the Inspection later FAILS, and a later
    // foreground attempt fails too. Findings are a canonical ledger: run
    // outcomes never erase them.
    world.runRepo
      .updateStatus(runId, 'failed', { error: 'foreground provider stream aborted' })
      ._unsafeUnwrap();
    const laterRunId = seedRun(world, 'failed');

    const page = world.findings.findPage({ threadId: world.threadId })._unsafeUnwrap();
    expect(page.findings).toHaveLength(1);
    expect(page.findings[0]!.finding.id).toBe(findingId);
    expect(page.findings[0]!.imageIds).toEqual([imageId]);

    const record = world.findings.findByIdInThread(findingId, world.threadId)._unsafeUnwrap();
    expect(record).not.toBeNull();
    expect(record!.finding.answer).toBe('A blue square fills the image.');

    // The Inspection's source Image is still Available for the thread.
    const images = world.imageRepo.findByThread(world.threadId)._unsafeUnwrap();
    expect(images[0]!.state).toBe('available');

    // Both runs are durable failures; the ledger is untouched by them.
    expect(world.runRepo.findById(runId)._unsafeUnwrap()!.status).toBe('failed');
    expect(world.runRepo.findById(laterRunId)._unsafeUnwrap()!.status).toBe('failed');
  });

  it('denies a persona without the vision assignment, with no model call and no Finding', async () => {
    world = await makeWorld();
    const imageId = await admitImage(world, 'ext-img-3');
    const runId = seedRun(world);

    // A second, unassigned persona.
    const strangerConfig = PersonaConfigSchema.parse({
      name: 'stranger',
      model: 'claude-sonnet-4-6',
      subagents: [],
      capabilities: { allow: ['subagent.invoke'] },
    });
    await world.personaLoader.loadFromConfig([strangerConfig]);
    const strangerId = world.personaRepo.findByName('stranger')._unsafeUnwrap()!.id;

    const stack = await makeRunnerStack(world, {});
    const toolResult = await stack.handler.execute(
      { name: 'vision', input: { question: 'Describe the image.', imageIds: [imageId] } },
      { runId, threadId: world.threadId, personaId: strangerId, requestId: 'req-3' },
    );

    expect(toolResult.status).toBe('error');
    expect(toolResult.error).toContain('is not assigned to persona');
    expect(stack.calls).toHaveLength(0);
    expect(
      world.findings.findPage({ threadId: world.threadId })._unsafeUnwrap().findings,
    ).toHaveLength(0);
  });

  it('fails explicitly when the Finding ledger is not wired (missing setup)', async () => {
    world = await makeWorld();
    const imageId = await admitImage(world, 'ext-img-4');
    const runId = seedRun(world);

    const stack = await makeRunnerStack(world, { withFindings: false });
    const toolResult = await stack.handler.execute(
      { name: 'vision', input: { question: 'Describe the image.', imageIds: [imageId] } },
      { runId, threadId: world.threadId, personaId: world.personaId, requestId: 'req-4' },
    );

    expect(toolResult.status).toBe('error');
    expect(toolResult.error).toContain('Finding persistence service');
    expect(stack.calls).toHaveLength(0);
    expect(
      world.findings.findPage({ threadId: world.threadId })._unsafeUnwrap().findings,
    ).toHaveLength(0);
  });

  it('enforces the configured Inspection ceiling before touching the model', async () => {
    world = await makeWorld();
    const imageId = await admitImage(world, 'ext-img-5');
    const runId = seedRun(world);

    // maxPerInspection is 2 (from the world's images config); 3 IDs must be
    // rejected before any Image load or model request.
    const stack = await makeRunnerStack(world, { maxPerInspection: 2 });
    const toolResult = await stack.handler.execute(
      {
        name: 'vision',
        input: {
          question: 'Describe these.',
          imageIds: [imageId, uuidv4(), uuidv4()],
        },
      },
      { runId, threadId: world.threadId, personaId: world.personaId, requestId: 'req-5' },
    );

    expect(toolResult.status).toBe('error');
    expect(toolResult.error).toContain('at most 2');
    expect(stack.calls).toHaveLength(0);
  });

  it('keeps tool capabilities capability-gated: wiring is not authorization', async () => {
    // The real policy function, unchanged: `subagent.invoke` is exposed only
    // to personas that allow it, and no `image.read` capability is implied by
    // the new service wiring.
    const granted: ResolvedCapabilities = { allow: ['subagent.invoke'], requireApproval: [] };
    const ungranted: ResolvedCapabilities = { allow: [], requireApproval: [] };

    expect(isToolAllowed('subagent.invoke', granted)).toBe(true);
    expect(isToolAllowed('subagent.invoke', ungranted)).toBe(false);
    expect(isToolAllowed('image.read', granted)).toBe(false);
    expect(isToolAllowed('image.read', ungranted)).toBe(false);
  });
});
