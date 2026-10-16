/**
 * Vision sub-agent (TASK-013): one-shot multimodal Inspection.
 *
 * Deterministic adapter: the AI SDK `generateText` is mocked, so every model
 * request is captured whole and its outcome scripted. The tests pin:
 *
 * - the exact request content: the question plus EVERY Image as a Buffer JPEG
 *   ImagePart (`{ type: 'image', image: Buffer, mediaType: 'image/jpeg' }`),
 *   with no URL, path, or base64 string anywhere in the request material;
 * - the telemetry contract: `experimental_telemetry.recordInputs: false`
 *   regardless of the ambient `telemetry.isEnabled`;
 * - whole-call rejection BEFORE any pixel load or model request for empty
 *   questions, empty/excess/duplicate IDs, nonplain ID-shaped tokens (paths,
 *   scheme URLs, base64-ish strings), unknown/cross-thread IDs, and
 *   Processing/Rejected/Unavailable Images — and no nonplain token ever
 *   appears in any error or chain-warning surface;
 * - no Finding on ANY failure path (request, response, abort, persistence);
 * - the abort recheck between generation and save;
 * - trusted provenance: runId from context only, model label from the winning
 *   SDK model instance, reported usage mapped without zero-filling;
 * - failover through the real shared model chain: every attempt re-resolves
 *   all Images and every request carries all pixels, and no new attempt
 *   starts after an Image turns Unavailable.
 *
 * The concrete TASK-010 adapter is intentionally NOT imported: all Image
 * access goes through the `ImageAccess` port with a deterministic fake.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { ok, err, type Result } from 'neverthrow';
import type { LanguageModel } from 'ai';

// Deterministic AI SDK adapter (contract rows E12/E13): capture the full
// generateText options of every attempt; outcomes are scripted per test.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from 'ai';
import { run as visionRun, DEFAULT_MAX_PER_INSPECTION } from '../../../src/subagents/default/vision/index.js';
import { runSubAgentModelChain } from '../../../src/subagents/subagent-model-chain.js';
import type {
  LoadedSubAgent,
  SubAgentContext,
  SubAgentInput,
  SubAgentServices,
} from '../../../src/subagents/subagent-types.js';
import type { ModelResolver } from '../../../src/subagents/model-resolver.js';
import type {
  ImageAccess,
  ImageAccessError,
  ImageAvailability,
  ImageDescriptor,
  ImageInspectionBytes,
} from '../../../src/images/image-types.js';
import type { FindingRecord } from '../../../src/core/database/repositories/finding-repository.js';
import { DbError, SubAgentError } from '../../../src/core/errors/index.js';
import type pino from 'pino';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A deterministic Normalized JPEG: SOI marker, payload seeded per image, EOI. */
function jpegBytes(seed: string): Buffer {
  const payload = Buffer.from(seed, 'utf8');
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    payload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

const THREAD_ID = 'thread-1';
const OTHER_THREAD_ID = 'thread-2';
const RUN_ID = 'run-1';

type FakeFile =
  | { kind: 'file'; bytes: Buffer; expiresAt: number }
  | { kind: 'error'; error: ImageAccessError };

interface FakeEntry {
  threadId: string;
  file: FakeFile;
}

/**
 * Deterministic `ImageAccess` fake. `fetchInspectionBytes` re-reads the stored
 * bytes on every call (fresh Buffer instance), so tests can mutate the stored
 * bytes between attempts and observe the next attempt loading the new content.
 * Cross-thread requests resolve as `not_found`, per the port contract.
 */
class FakeImageAccess implements ImageAccess {
  readonly fetchCalls: Array<{ threadId: string; imageId: string }> = [];
  /** Metadata-only availability checks — tracked separately from pixel loads. */
  readonly availabilityCalls: Array<{ threadId: string; imageId: string }> = [];
  private readonly entries = new Map<string, FakeEntry>();

  addAvailable(imageId: string, bytes: Buffer, threadId: string = THREAD_ID): void {
    this.entries.set(imageId, { threadId, file: { kind: 'file', bytes, expiresAt: Date.now() + 60_000 } });
  }

  setBytes(imageId: string, bytes: Buffer): void {
    const entry = this.entries.get(imageId);
    if (entry && entry.file.kind === 'file') entry.file.bytes = bytes;
  }

  setFault(imageId: string, error: ImageAccessError): void {
    const entry = this.entries.get(imageId);
    if (entry) entry.file = { kind: 'error', error };
  }

  private find(request: { threadId: string; imageId: string }): FakeEntry | undefined {
    const entry = this.entries.get(request.imageId);
    if (!entry || entry.threadId !== request.threadId) return undefined;
    return entry;
  }

  async resolveImage(request: { threadId: string; imageId: string }): Promise<
    Result<ImageDescriptor, ImageAccessError>
  > {
    const entry = this.find(request);
    if (!entry || entry.file.kind !== 'file') {
      return err({ code: 'not_found' } satisfies ImageAccessError);
    }
    return ok({
      imageId: request.imageId,
      threadId: request.threadId,
      messageId: 'msg-1',
      ordinal: 0,
      receivedAt: Date.now(),
      expiresAt: entry.file.expiresAt,
      state: 'available',
    } satisfies ImageDescriptor);
  }

  async getAvailability(request: { threadId: string; imageId: string }): Promise<
    Result<ImageAvailability, ImageAccessError>
  > {
    this.availabilityCalls.push({ ...request });
    const entry = this.find(request);
    if (!entry) {
      return err({ code: 'not_found' } satisfies ImageAccessError);
    }
    if (entry.file.kind === 'error') {
      const code = entry.file.error.code;
      if (code === 'processing') {
        return ok({ state: 'processing', available: false } satisfies ImageAvailability);
      }
      if (code === 'rejected') {
        return ok({
          state: 'rejected',
          available: false,
          rejectionReason: entry.file.error.rejectionReason,
        } satisfies ImageAvailability);
      }
      if (code === 'unavailable') {
        return ok({
          state: 'unavailable',
          available: false,
          unavailabilityReason: entry.file.error.unavailabilityReason,
        } satisfies ImageAvailability);
      }
      return err(entry.file.error);
    }
    return ok({
      state: 'available',
      available: true,
      expiresAt: entry.file.expiresAt,
    } satisfies ImageAvailability);
  }

  async fetchInspectionBytes(request: {
    threadId: string;
    imageId: string;
  }): Promise<Result<ImageInspectionBytes, ImageAccessError>> {
    this.fetchCalls.push({ ...request });
    const entry = this.find(request);
    if (!entry) return err({ code: 'not_found' } satisfies ImageAccessError);
    if (entry.file.kind === 'error') return err(entry.file.error);
    return ok({
      imageId: request.imageId,
      bytes: Buffer.from(entry.file.bytes),
      mimeType: 'image/jpeg',
      expiresAt: entry.file.expiresAt,
    } satisfies ImageInspectionBytes);
  }
}

/**
 * Stateful Finding ledger fake: it actually records every successful create
 * (review P1-3), so failure paths can assert ledger EMPTINESS against real
 * recorded state rather than call counts.
 */
interface FindingLedger {
  create: Mock;
  entries: Array<Record<string, unknown>>;
}

function makeFindingLedger(failWith?: DbError): FindingLedger {
  const ledger: FindingLedger = { create: vi.fn(), entries: [] };
  ledger.create = vi.fn((input: Record<string, unknown>) => {
    if (failWith) return err(failWith);
    ledger.entries.push({ ...input });
    return ok({ finding: input, imageIds: input.imageIds } as unknown as FindingRecord);
  });
  return ledger;
}

function makeModel(provider: string, modelId: string): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider,
    modelId,
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  } as unknown as LanguageModel;
}

const mockLogger = {
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as unknown as pino.Logger;

const generateTextMock = generateText as unknown as Mock;

type ScriptedGeneration = { text: string; usage?: Record<string, unknown> };

function scriptSuccess(payload: Record<string, unknown>, usage?: Record<string, unknown>): void {
  const generation: ScriptedGeneration = { text: JSON.stringify(payload) };
  if (usage !== undefined) generation.usage = usage;
  generateTextMock.mockResolvedValueOnce(generation);
}

function scriptFailure(message: string): void {
  generateTextMock.mockRejectedValueOnce(new Error(message));
}

interface CapturedCall {
  [key: string]: unknown;
}

/** The options object of every captured generateText call. */
function capturedCalls(): CapturedCall[] {
  return (generateTextMock.mock.calls as unknown as Array<[CapturedCall]>).map(
    (args) => args[0],
  );
}

function makeServices(overrides: {
  images?: ImageAccess;
  findings?: FindingLedger;
  maxPerInspection?: number;
}): SubAgentServices {
  return {
    memory: {},
    schedules: {},
    personas: {},
    channels: {},
    threads: {},
    messages: {},
    runs: {},
    queue: {},
    logger: mockLogger,
    ...(overrides.images !== undefined ? { images: overrides.images } : {}),
    ...(overrides.findings !== undefined ? { findings: overrides.findings } : {}),
    ...(overrides.maxPerInspection !== undefined
      ? { imageInspectionLimits: { maxPerInspection: overrides.maxPerInspection } }
      : {}),
  } as unknown as SubAgentServices;
}

function makeContext(overrides: {
  services?: SubAgentServices;
  runId?: string;
  model?: LanguageModel;
  abortController?: AbortController;
  telemetry?: { isEnabled: boolean };
  providerOptions?: SubAgentContext['providerOptions'];
} = {}): SubAgentContext {
  const abortController = overrides.abortController ?? new AbortController();
  return {
    threadId: THREAD_ID,
    personaId: 'assistant',
    runId: 'runId' in overrides ? overrides.runId : RUN_ID,
    systemPrompt: 'VISION-SYSTEM-PROMPT',
    model: overrides.model ?? makeModel('anthropic', 'claude-haiku-4-5-20251001'),
    maxOutputTokens: 4096,
    rootPaths: [],
    services: overrides.services ?? makeServices({ images: new FakeImageAccess() }),
    telemetry: overrides.telemetry ?? { isEnabled: true },
    abortSignal: abortController.signal,
    providerOptions: overrides.providerOptions ?? { anthropic: { temperature: 0 } },
  };
}

/** The canonical happy-path input: one question, two distinct thread images. */
function makeHappyFixture() {
  const images = new FakeImageAccess();
  const imageA = jpegBytes('PIXELS-A');
  const imageB = jpegBytes('PIXELS-B');
  images.addAvailable('img-a', imageA);
  images.addAvailable('img-b', imageB);
  const findings = makeFindingLedger();
  const context = makeContext({ services: makeServices({ images, findings }) });
  const input: SubAgentInput = {
    question: 'What is parked on the street?',
    imageIds: ['img-a', 'img-b'],
  };
  return { images, findings, context, input, imageA, imageB };
}

/** Serializes request material without dumping pixel bytes into test output. */
function redactBuffers(value: unknown): string {
  return JSON.stringify(value, (key, v) =>
    Buffer.isBuffer(v) ? `<jpeg-bytes length=${v.length}>` : v,
  );
}

function lastFindingsCall(findings: FindingLedger): Record<string, unknown> {
  const calls = findings.create.mock.calls as unknown as Array<[Record<string, unknown>]>;
  return calls[calls.length - 1][0];
}

/** Stringified arguments of every captured call to a logger method. */
function loggerCalls(method: 'warn' | 'info' | 'error'): string[] {
  const fn = mockLogger[method] as unknown as Mock;
  return fn.mock.calls.flat().map(String);
}

/**
 * Minimal real-chain invocation over the actual `runSubAgentModelChain`
 * with a fresh single-entry override (plus the implicit manifest fallback,
 * so failing runs produce per-attempt warnings AND a final error).
 */
function makeChainInvocation(options: {
  images: FakeImageAccess;
  findings: FindingLedger;
  input: SubAgentInput;
  override?: { model: Array<{ provider: 'anthropic'; name: string; maxTokens: number; timeoutMs: number }> };
}) {
  const model = makeModel('anthropic', 'claude-haiku-4-5-20251001');
  const resolver = {
    resolve: vi.fn(async () => ok(model)),
  } as unknown as ModelResolver;
  const createContext = ({
    model: resolvedModel,
    abortSignal,
    providerOptions,
  }: {
    model: LanguageModel;
    abortSignal: AbortSignal;
    providerOptions?: SubAgentContext['providerOptions'];
  }): SubAgentContext => ({
    threadId: THREAD_ID,
    personaId: 'assistant',
    runId: RUN_ID,
    systemPrompt: 'VISION-SYSTEM-PROMPT',
    model: resolvedModel,
    maxOutputTokens: 8192,
    rootPaths: [],
    services: makeServices({ images: options.images, findings: options.findings }),
    telemetry: { isEnabled: true },
    abortSignal,
    providerOptions,
  });
  const runChain = async () =>
    runSubAgentModelChain({
      name: 'vision',
      agent: makeVisionAgent(),
      input: options.input,
      override: options.override,
      modelResolver: resolver,
      logger: mockLogger,
      createContext,
    });
  return { runChain };
}

beforeEach(() => {
  generateTextMock.mockReset();
  // Clear accumulated log captures per test (mockClear keeps implementations,
  // including child() → this), so logger-surface assertions are per-test.
  for (const method of ['info', 'warn', 'error', 'debug', 'trace', 'fatal'] as const) {
    (mockLogger[method] as unknown as Mock).mockClear();
  }
});

// ---------------------------------------------------------------------------
// Happy path: one request, exactly one Finding, text-only result
// ---------------------------------------------------------------------------

describe('vision happy path', () => {
  it('sends the question plus every Image as a Buffer JPEG ImagePart and records one Finding', async () => {
    const { images, findings, context, input, imageA, imageB } = makeHappyFixture();
    scriptSuccess(
      {
        answer: 'A red car.',
        extractedText: 'PARKING 2H',
        uncertainty: 'The make is not legible.',
        // Model-authored provenance must never reach the Finding.
        runId: 'model-authored-run',
        modelName: 'gpt-9-pretend',
      },
      {
        inputTokens: 1234,
        outputTokens: 56,
        inputTokenDetails: { cacheReadTokens: 7 },
      },
    );

    const result = await visionRun(context, input);

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();

    // Exactly one model request.
    expect(generateTextMock).toHaveBeenCalledOnce();
    const call = capturedCalls()[0];
    expect(call.model).toBe(context.model);
    expect(call.system).toBe('VISION-SYSTEM-PROMPT');
    expect(call.maxOutputTokens).toBe(4096);
    expect(call.abortSignal).toBe(context.abortSignal);
    expect(call.providerOptions).toEqual({ anthropic: { temperature: 0 } });

    // E12: content is the question plus ALL images as Buffer JPEG parts.
    const messages = call.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    const content = messages[0].content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: 'text', text: input.question });
    for (const [index, expectedBytes] of [
      [1, imageA],
      [2, imageB],
    ] as Array<[number, Buffer]>) {
      const part = content[index];
      expect(part.type).toBe('image');
      expect(part.mediaType).toBe('image/jpeg');
      expect(Buffer.isBuffer(part.image)).toBe(true);
      expect((part.image as Buffer).equals(expectedBytes)).toBe(true);
    }

    // E13: image inputs are never recorded by SDK telemetry.
    expect(call.experimental_telemetry).toEqual({ isEnabled: true, recordInputs: false });

    // No URL, path, or raw base64 anywhere in the request material.
    const serialized = redactBuffers(messages);
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('file:');
    expect(serialized).not.toContain('data:');
    expect(serialized).not.toContain('PIXELS');

    // Every image was loaded for this attempt (fresh re-resolution).
    expect(images.fetchCalls).toEqual([
      { threadId: THREAD_ID, imageId: 'img-a' },
      { threadId: THREAD_ID, imageId: 'img-b' },
    ]);

    // Exactly one canonical Finding, with trusted provenance — and the
    // stateful ledger actually records it (review P1-3).
    expect(findings.create).toHaveBeenCalledOnce();
    expect(findings.entries).toHaveLength(1);
    const saved = lastFindingsCall(findings);
    expect(findings.entries[0]).toMatchObject(saved);
    expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(saved.runId).toBe(RUN_ID);
    expect(saved.threadId).toBe(THREAD_ID);
    expect(saved.imageIds).toEqual(['img-a', 'img-b']);
    expect(saved.question).toBe(input.question);
    expect(saved.answer).toBe('A red car.');
    expect(saved.extractedText).toBe('PARKING 2H');
    expect(saved.uncertainty).toBe('The make is not legible.');
    // Trusted model label from the winning SDK instance, not model output.
    expect(saved.modelName).toBe('anthropic/claude-haiku-4-5-20251001');
    // Reported usage, mapped without zero-filling absent counters.
    expect(saved.usage).toEqual({ inputTokens: 1234, outputTokens: 56, cacheReadTokens: 7 });
    expect('cacheWriteTokens' in (saved.usage as object)).toBe(false);

    // Text-only result: Finding ID, IDs, answer, DTO fields, model, usage.
    const data = value.data as Record<string, unknown>;
    expect(data.findingId).toBe(saved.id);
    expect(data.imageIds).toEqual(['img-a', 'img-b']);
    expect(data.answer).toBe('A red car.');
    expect(data.extractedText).toBe('PARKING 2H');
    expect(data.uncertainty).toBe('The make is not legible.');
    expect(data.model).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(data.usage).toEqual({ inputTokens: 1234, outputTokens: 56, cacheReadTokens: 7 });
    expect(value.summary).toContain(String(saved.id));
    expect(value.usage).toEqual({ inputTokens: 1234, outputTokens: 56 });
    // No pixels leak into the observable result or the log line.
    expect(redactBuffers(value)).not.toContain('PIXELS');
    const infoCalls = (mockLogger.info as unknown as Mock).mock.calls;
    expect(redactBuffers(infoCalls)).not.toContain('PIXELS');
  });

  it('stores extractedText/uncertainty absent when the model reported nothing', async () => {
    const { findings, context, input } = makeHappyFixture();
    scriptSuccess({ answer: 'A red car.' }, { inputTokens: 10, outputTokens: 2 });

    const result = await visionRun(context, input);

    expect(result.isOk()).toBe(true);
    expect(findings.entries).toHaveLength(1);
    const saved = lastFindingsCall(findings);
    expect(saved.extractedText).toBeNull();
    expect(saved.uncertainty).toBeNull();
    const data = result._unsafeUnwrap().data as Record<string, unknown>;
    expect('extractedText' in data).toBe(false);
    expect('uncertainty' in data).toBe(false);
  });

  it('treats blank extractedText/uncertainty as reported nothing', async () => {
    const { findings, context, input } = makeHappyFixture();
    scriptSuccess({ answer: 'A red car.', extractedText: '   ', uncertainty: null });

    const result = await visionRun(context, input);

    expect(result.isOk()).toBe(true);
    expect(findings.entries).toHaveLength(1);
    const saved = lastFindingsCall(findings);
    expect(saved.extractedText).toBeNull();
    expect(saved.uncertainty).toBeNull();
  });

  it('keeps usage fields absent when the model reported none (never zero-filled)', async () => {
    const { findings, context, input } = makeHappyFixture();
    scriptSuccess({ answer: 'A red car.' });

    const result = await visionRun(context, input);

    expect(result.isOk()).toBe(true);
    expect(findings.entries).toHaveLength(1);
    const saved = lastFindingsCall(findings);
    expect(saved.usage).toEqual({});
    const data = result._unsafeUnwrap().data as Record<string, unknown>;
    expect('usage' in data).toBe(false);
    // Unreported counters are OMITTED on the outer result, never zero-filled
    // (review P2-4).
    expect(result._unsafeUnwrap().usage).toBeUndefined();
  });

  it('reports complete outer usage when the model reported both counters', async () => {
    const { findings, context, input } = makeHappyFixture();
    scriptSuccess({ answer: 'A red car.' }, { inputTokens: 10, outputTokens: 2 });

    const result = await visionRun(context, input);

    expect(result.isOk()).toBe(true);
    expect(findings.entries).toHaveLength(1);
    expect(result._unsafeUnwrap().usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it('keeps fenced code blocks INSIDE the DTO byte-identically (no global fence stripping)', async () => {
    const { findings, context, input } = makeHappyFixture();
    const answerWithFence = 'The sign reads: ```text\nNO PARKING 2H\n``` end.';
    const ocrWithFence = '```\nNO PARKING\n2H MAX\n```';
    scriptSuccess({ answer: answerWithFence, extractedText: ocrWithFence });

    const result = await visionRun(context, input);

    expect(result.isOk()).toBe(true);
    expect(findings.entries).toHaveLength(1);
    // The exact-text contract (review P1-1): triple-backtick OCR survives
    // byte-identically into the persisted Finding.
    const saved = lastFindingsCall(findings);
    expect(saved.answer).toBe(answerWithFence);
    expect(saved.extractedText).toBe(ocrWithFence);
    const data = result._unsafeUnwrap().data as Record<string, unknown>;
    expect(data.answer).toBe(answerWithFence);
    expect(data.extractedText).toBe(ocrWithFence);
  });

  it('accepts a single enclosing fence around the whole reply, not inner fences', async () => {
    const { findings, context, input } = makeHappyFixture();
    const inner = 'The plate says ```X-99``` clearly.';
    const payload = JSON.stringify({ answer: inner });
    // The model may wrap the WHOLE reply in one fence pair; fences inside
    // JSON string values must survive unchanged.
    generateTextMock.mockResolvedValueOnce({
      text: `\`\`\`json\n${payload}\n\`\`\``,
      usage: { inputTokens: 5, outputTokens: 6 },
    });

    const result = await visionRun(context, input);

    expect(result.isOk()).toBe(true);
    expect(findings.entries).toHaveLength(1);
    expect(lastFindingsCall(findings).answer).toBe(inner);
  });

  it('keeps telemetry recordInputs off when ambient telemetry is disabled', async () => {
    const { context, input } = makeHappyFixture();
    const ctx = makeContext({
      services: context.services,
      telemetry: { isEnabled: false },
    });
    scriptSuccess({ answer: 'A red car.' });

    await visionRun(ctx, input);

    expect(capturedCalls()[0].experimental_telemetry).toEqual({
      isEnabled: false,
      recordInputs: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Whole-call rejection BEFORE any pixel load, availability probe, or model request
// ---------------------------------------------------------------------------

describe('vision input validation', () => {
  const invalidInputs: Array<{ name: string; input: SubAgentInput; expectInError: string }> = [
    {
      name: 'empty question',
      input: { question: '', imageIds: ['img-1'] },
      expectInError: 'nonempty question',
    },
    {
      name: 'blank question',
      input: { question: '   ', imageIds: ['img-1'] },
      expectInError: 'nonempty question',
    },
    {
      name: 'missing imageIds',
      input: { question: 'What is here?' },
      expectInError: 'array of current-thread Image IDs',
    },
    {
      name: 'non-array imageIds',
      input: { question: 'What is here?', imageIds: 'img-1' },
      expectInError: 'array of current-thread Image IDs',
    },
    {
      name: 'empty imageIds',
      input: { question: 'What is here?', imageIds: [] },
      expectInError: 'at least one Image ID',
    },
    {
      name: 'duplicate IDs are rejected, not deduplicated',
      input: { question: 'What is here?', imageIds: ['img-1', 'img-1'] },
      expectInError: 'distinct',
    },
    {
      name: `excess beyond the default of ${DEFAULT_MAX_PER_INSPECTION}`,
      input: { question: 'What is here?', imageIds: ['a', 'b', 'c', 'd', 'e', 'f'] },
      expectInError: 'at most 5',
    },
    {
      name: 'filesystem path ID',
      input: { question: 'What is here?', imageIds: ['/tmp/evil.jpg'] },
      expectInError: 'opaque identifiers',
    },
    {
      name: 'windows path ID',
      input: { question: 'What is here?', imageIds: ['C:\\photos\\a.jpg'] },
      expectInError: 'opaque identifiers',
    },
    {
      name: 'URL ID',
      input: { question: 'What is here?', imageIds: ['https://example.com/a.jpg'] },
      expectInError: 'opaque identifiers',
    },
    {
      name: 'data URI with base64 payload',
      input: { question: 'What is here?', imageIds: ['data:image/png;base64,AAAA'] },
      expectInError: 'opaque identifiers',
    },
    {
      name: 'whitespace-padded ID',
      input: { question: 'What is here?', imageIds: [' img-1'] },
      expectInError: 'opaque identifiers',
    },
    {
      // Review P1: these shapes once reached the port and were echoed
      // verbatim by the not_found renderer. The positive plain-shape
      // boundary rejects them before ANY load.
      name: 'nonplain short token with angle brackets',
      input: { question: 'What is here?', imageIds: ['AAAA<PAYLOAD>AAAA'] },
      expectInError: 'invalid image id',
    },
    {
      name: 'base64-padded token',
      input: { question: 'What is here?', imageIds: ['YW55IGNhcm5hbCB3b3JrPT0='] },
      expectInError: 'invalid image id',
    },
  ];

  it.each(invalidInputs)('$name', async ({ input, expectInError }) => {
    const images = new FakeImageAccess();
    images.addAvailable('img-1', jpegBytes('X'));
    const findings = makeFindingLedger();
    const context = makeContext({ services: makeServices({ images, findings }) });

    const result = await visionRun(context, input);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain(expectInError);
    // Rejected before ANY pixel load, availability probe, or model request;
    // the stateful ledger stays empty.
    expect(images.fetchCalls).toHaveLength(0);
    expect(images.availabilityCalls).toHaveLength(0);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  it('enforces the wired maxPerInspection from the validated images config', async () => {
    const images = new FakeImageAccess();
    for (const id of ['img-1', 'img-2', 'img-3']) images.addAvailable(id, jpegBytes(id));
    const findings = makeFindingLedger();
    const context = makeContext({
      services: makeServices({ images, findings, maxPerInspection: 2 }),
    });

    const rejected = await visionRun(context, {
      question: 'What is here?',
      imageIds: ['img-1', 'img-2', 'img-3'],
    });
    expect(rejected.isErr()).toBe(true);
    expect(rejected._unsafeUnwrapErr().message).toContain('at most 2');
    expect(images.fetchCalls).toHaveLength(0);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);

    // Exactly the configured maximum is accepted.
    scriptSuccess({ answer: 'ok' });
    const accepted = await visionRun(context, {
      question: 'What is here?',
      imageIds: ['img-1', 'img-2'],
    });
    expect(accepted.isOk()).toBe(true);
    expect(findings.entries).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // Payload-free validation errors (review P1-2): rejected IDs that are
  // not plain opaque-ID tokens (paths, URLs, data: URIs with base64)
  // must NEVER be echoed into the error text — the error message reaches
  // application warning logs through the model chain. Plain opaque-ID
  // shaped tokens (and harmless numeric ids) may be echoed. The real-chain
  // regression below proves the same through the chain's warning log and
  // final error, not just the direct error surface.
  // ---------------------------------------------------------------------
  it('never echoes a data-URI/base64 payload through the real chain (warnings + final error)', async () => {
    const payload = 'AAAA<PAYLOAD>AAAA';
    const images = new FakeImageAccess();
    images.addAvailable('img-1', jpegBytes('X'));
    const findings = makeFindingLedger();
    const input: SubAgentInput = {
      question: 'What is here?',
      imageIds: [`data:image/jpeg;base64,${payload}`],
    };
    const override = {
      model: [
        { provider: 'anthropic' as const, name: 'claude-haiku-4-5-20251001', maxTokens: 8192, timeoutMs: 10_000 },
      ],
    };

    const { runChain } = makeChainInvocation({ images, findings, input, override });
    const chained = await runChain();

    expect(chained.isErr()).toBe(true);
    const finalMessage = (chained._unsafeUnwrapErr() as Error).message;
    expect(finalMessage).toContain('invalid image id');
    expect(finalMessage).not.toContain('<PAYLOAD>');
    expect(finalMessage).not.toContain('AAAA');
    expect(finalMessage).not.toContain('data:image');
    // The chain's per-attempt warnings are the app warning surface (review P2a):
    // payload material is absent there too.
    const warnings = loggerCalls('warn').join('\n');
    expect(warnings).toContain('trying next');
    expect(warnings).not.toContain('<PAYLOAD>');
    expect(warnings).not.toContain('AAAA');
    expect(warnings).not.toContain('data:image');
    expect(images.fetchCalls).toHaveLength(0);
    expect(findings.entries).toHaveLength(0);
  });

  it('never echoes oversized/base64-like IDs; only plain opaque-ID tokens are echoed', async () => {
    const images = new FakeImageAccess();
    images.addAvailable('img-1', jpegBytes('X'));
    const findings = makeFindingLedger();
    const context = makeContext({ services: makeServices({ images, findings }) });

    // Oversized token (base64-like, 300 chars): generic message, no echo.
    const oversized = 'B'.repeat(300);
    const oversizedResult = await visionRun(context, {
      question: 'What is here?',
      imageIds: [oversized],
    });
    expect(oversizedResult.isErr()).toBe(true);
    const oversizedMessage = (oversizedResult._unsafeUnwrapErr() as Error).message;
    expect(oversizedMessage).toContain('invalid image id');
    expect(oversizedMessage).not.toContain('B'.repeat(20));

    // Harmless numeric id: plain-shaped, safe to echo.
    const numericResult = await visionRun(context, {
      question: 'What is here?',
      imageIds: [42 as unknown as string],
    });
    expect(numericResult.isErr()).toBe(true);
    const numericMessage = (numericResult._unsafeUnwrapErr() as Error).message;
    expect(numericMessage).toContain('(42)');
    expect(findings.entries).toHaveLength(0);
    expect(images.fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Nonplain-token boundary (review P1): short nonplain tokens (angle
// brackets, base64 padding) are rejected AT THE BOUNDARY — they never reach
// the port, so a not_found echo can never carry them into errors or chain
// warnings. Regression runs through the real chain via the available-list
// path (one available Image + one forged token).
// ---------------------------------------------------------------------------

describe('vision nonplain token boundary (real chain)', () => {
  const forgedTokens = [
    'AAAA<PAYLOAD>AAAA',
    'YW55IGNhcm5hbCBwYXlsb2FkIDxQQVlMT0FEPg==',
    'a/based64+ish<token>',
  ];

  it.each(forgedTokens)(
    'rejects %s before any load; the token is absent from chain warnings and the final error',
    async (token) => {
      const images = new FakeImageAccess();
      images.addAvailable('img-a', jpegBytes('PIXELS-A'));
      const findings = makeFindingLedger();
      const input: SubAgentInput = { question: 'What is here?', imageIds: ['img-a', token] };
      const override = {
        model: [
          { provider: 'anthropic' as const, name: 'claude-haiku-4-5-20251001', maxTokens: 8192, timeoutMs: 10_000 },
        ],
      };

      const { runChain } = makeChainInvocation({ images, findings, input, override });
      const chained = await runChain();

      expect(chained.isErr()).toBe(true);
      const finalMessage = (chained._unsafeUnwrapErr() as Error).message;
      expect(finalMessage).toContain('invalid image id');
      expect(finalMessage).not.toContain(token);
      expect(finalMessage).not.toContain('<PAYLOAD>');
      // The forged token is absent from every warning the chain logged.
      const warnings = loggerCalls('warn').join('\n');
      expect(warnings).toContain('trying next');
      expect(warnings).not.toContain(token);
      expect(warnings).not.toContain('<PAYLOAD>');
      // The boundary rejected before ANY load — not even the available
      // half of the mixed list.
      expect(images.fetchCalls).toHaveLength(0);
      expect(images.availabilityCalls).toHaveLength(0);
      expect(findings.entries).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Port-level rejections (unknown/cross-thread/Processing/Rejected/Unavailable)
// ---------------------------------------------------------------------------

describe('vision Image port rejections', () => {
  async function expectRejectedImage(
    setup: (images: FakeImageAccess) => void,
    imageIds: string[],
    expectInError: string[],
  ): Promise<void> {
    const images = new FakeImageAccess();
    setup(images);
    const findings = makeFindingLedger();
    const context = makeContext({ services: makeServices({ images, findings }) });

    const result = await visionRun(context, {
      question: 'What is here?',
      imageIds,
    });

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    for (const fragment of expectInError) {
      expect(message).toContain(fragment);
    }
    // No model request, no Finding, and NO pixel load for any
    // terminal/unreadable Image state — the whole-list preflight rejects
    // before the pixel pass; the ledger stays empty.
    expect(images.fetchCalls).toHaveLength(0);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  }

  it('rejects an unknown Image ID without a model request', () =>
    expectRejectedImage((images) => images.addAvailable('other', jpegBytes('X')), ['img-missing'], [
      'not found',
      'img-missing',
    ]));

  it('rejects a cross-thread Image ID as not found', () =>
    expectRejectedImage((images) => images.addAvailable('img-1', jpegBytes('X'), OTHER_THREAD_ID), [
      'img-1',
    ], ['not found', 'img-1']));

  it('rejects a Processing Image', () =>
    expectRejectedImage((images) => {
      images.addAvailable('img-1', jpegBytes('X'));
      images.setFault('img-1', { code: 'processing' });
    }, ['img-1'], ['Processing', 'img-1']));

  it('rejects a Rejected Image with its rejection reason', () =>
    expectRejectedImage((images) => {
      images.addAvailable('img-1', jpegBytes('X'));
      images.setFault('img-1', { code: 'rejected', rejectionReason: 'animated' });
    }, ['img-1'], ['Rejected', 'animated', 'img-1']));

  it('rejects an Unavailable Image with its unavailability reason and recovery hint', () =>
    expectRejectedImage((images) => {
      images.addAvailable('img-1', jpegBytes('X'));
      images.setFault('img-1', { code: 'unavailable', unavailabilityReason: 'expired' });
    }, ['img-1'], ['Unavailable', 'expired', 're-upload', 'img-1']));

  it('fails the Inspection on an operational storage failure', () =>
    expectRejectedImage((images) => {
      images.addAvailable('img-1', jpegBytes('X'));
      images.setFault('img-1', { code: 'storage_failed', message: 'disk full' });
    }, ['img-1'], ['Failed to load Image img-1', 'disk full']));
});

// ---------------------------------------------------------------------------
// Whole-list preflight (review P2-5): the ENTIRE ID list is checked via
// metadata-only getAvailability before ANY pixel load, so a mixed
// valid/invalid list never loads pixels for the valid half.
// ---------------------------------------------------------------------------

describe('vision whole-list preflight', () => {
  it('rejects a mixed [available, unknown] list before ANY pixel load', async () => {
    const { images, findings, context } = makeHappyFixture();

    const result = await visionRun(context, {
      question: 'What is here?',
      imageIds: ['img-a', 'ghost-img'],
    });

    expect(result.isErr()).toBe(true);
    const message = (result._unsafeUnwrapErr() as Error).message;
    expect(message).toContain('ghost-img');
    expect(message).toContain('not found');
    // Neither image's pixels were loaded — the unknown id failed the
    // whole-list preflight first.
    expect(images.fetchCalls).toHaveLength(0);
    expect(images.availabilityCalls).toEqual([
      { threadId: THREAD_ID, imageId: 'img-a' },
      { threadId: THREAD_ID, imageId: 'ghost-img' },
    ]);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  it('rejects a mixed [available, rejected] list with the reason, before ANY pixel load', async () => {
    const { images, findings, context } = makeHappyFixture();
    images.setFault('img-b', { code: 'rejected', rejectionReason: 'animated' });

    const result = await visionRun(context, {
      question: 'What is here?',
      imageIds: ['img-a', 'img-b'],
    });

    expect(result.isErr()).toBe(true);
    const message = (result._unsafeUnwrapErr() as Error).message;
    expect(message).toContain('Rejected');
    expect(message).toContain('animated');
    expect(images.fetchCalls).toHaveLength(0);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  it('rejects an [available, processing] list before ANY pixel load', async () => {
    const { images, findings, context } = makeHappyFixture();
    images.setFault('img-b', { code: 'processing' });

    const result = await visionRun(context, {
      question: 'What is here?',
      imageIds: ['img-a', 'img-b'],
    });

    expect(result.isErr()).toBe(true);
    expect((result._unsafeUnwrapErr() as Error).message).toContain('Processing');
    expect(images.fetchCalls).toHaveLength(0);
    expect(findings.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Service and provenance gates
// ---------------------------------------------------------------------------

describe('vision service and provenance gates', () => {
  it('refuses invocation without the Image access service', async () => {
    const findings = makeFindingLedger();
    // makeServices without images leaves services.images absent.
    const context = makeContext({ services: makeServices({ findings }) });
    const result = await visionRun(context, { question: 'q', imageIds: ['img-1'] });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Image access service');
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  it('refuses invocation without the Finding persistence service', async () => {
    const images = new FakeImageAccess();
    images.addAvailable('img-1', jpegBytes('X'));
    const context = makeContext({ services: makeServices({ images }) });

    const result = await visionRun(context, { question: 'q', imageIds: ['img-1'] });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Finding persistence service');
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('refuses invocation without the trusted runId, even if the input authors one', async () => {
    const images = new FakeImageAccess();
    images.addAvailable('img-1', jpegBytes('X'));
    const findings = makeFindingLedger();
    const context = makeContext({
      services: makeServices({ images, findings }),
      runId: undefined,
    });

    const result = await visionRun(context, {
      question: 'q',
      imageIds: ['img-1'],
      // Model-authored provenance must never be trusted.
      runId: 'model-authored-run',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('trusted runId');
    expect(images.fetchCalls).toHaveLength(0);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure paths: no Finding, no unrecorded success
// ---------------------------------------------------------------------------

describe('vision failure paths', () => {
  it('fails the attempt when the model request rejects, forwarding only an allowlisted detail', async () => {
    const { context, input, findings } = makeHappyFixture();
    scriptFailure('400: image parts are not supported by this model <raw-provider-detail>');

    const result = await visionRun(context, input);

    expect(result.isErr()).toBe(true);
    const message = (result._unsafeUnwrapErr() as Error).message;
    expect(message).toContain('Vision request failed');
    expect(message).toContain('(status 400)');
    // Raw provider-authored error text is never forwarded — these messages
    // reach application warning logs through the model chain (review P1-2).
    expect(message).not.toContain('image parts are not supported');
    expect(message).not.toContain('<raw-provider-detail>');
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  const invalidResponses: Array<{ name: string; text: string; expectInError: string }> = [
    { name: 'non-JSON prose', text: 'Sure, the car is red.', expectInError: 'did not return a JSON object' },
    { name: 'JSON array', text: '["a red car"]', expectInError: 'was not a JSON object' },
    { name: 'missing answer', text: '{"extractedText": "x"}', expectInError: 'nonempty answer' },
    { name: 'blank answer', text: '{"answer": "  "}', expectInError: 'nonempty answer' },
    { name: 'non-string extractedText', text: '{"answer": "x", "extractedText": 42}', expectInError: 'extractedText' },
    { name: 'non-string uncertainty', text: '{"answer": "x", "uncertainty": [1]}', expectInError: 'uncertainty' },
  ];

  it.each(invalidResponses)('$name', async ({ text, expectInError }) => {
    const { context, input, findings } = makeHappyFixture();
    generateTextMock.mockResolvedValueOnce({ text, usage: {} });

    const result = await visionRun(context, input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(expectInError);
    // An unrecordable answer creates no Finding.
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  it('rechecks abort after generation and before saving (late attempt saves nothing)', async () => {
    const { context, input, findings } = makeHappyFixture();
    const abortController = new AbortController();
    const ctx = makeContext({
      services: context.services,
      abortController,
    });
    // The SDK call completes, but the attempt is aborted before it returns.
    generateTextMock.mockImplementationOnce(async () => {
      abortController.abort();
      return { text: JSON.stringify({ answer: 'A red car.' }), usage: {} };
    });

    const result = await visionRun(ctx, input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'aborted before the Finding could be saved',
    );
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  it('does not save a Finding when the signal is already aborted', async () => {
    const { context, input, findings } = makeHappyFixture();
    const abortController = new AbortController();
    abortController.abort();
    const ctx = makeContext({ services: context.services, abortController });
    scriptSuccess({ answer: 'A red car.' });

    const result = await visionRun(ctx, input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'aborted before the Finding could be saved',
    );
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  it('fails the Inspection when the Finding write fails (no unrecorded success)', async () => {
    const images = new FakeImageAccess();
    images.addAvailable('img-a', jpegBytes('A'));
    const findings = makeFindingLedger(new DbError('disk full'));
    const context = makeContext({ services: makeServices({ images, findings }) });
    scriptSuccess({ answer: 'A red car.' });

    const result = await visionRun(context, { question: 'q', imageIds: ['img-a'] });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Finding could not be saved');
    expect(result._unsafeUnwrapErr().message).toContain('disk full');
    expect(findings.create).toHaveBeenCalledOnce();
    // The write failed: the stateful ledger holds nothing (review P1-3).
    expect(findings.entries).toHaveLength(0);
  });

  it('fails the Inspection when the Finding write THROWS (no Finding, propagated failure)', async () => {
    const images = new FakeImageAccess();
    images.addAvailable('img-a', jpegBytes('A'));
    // A genuine throw — not a typed Result failure — from the persistence port.
    const findings: FindingLedger = {
      create: vi.fn(() => {
        throw new Error('sqlite crash <detail-W>');
      }),
      entries: [],
    };
    const context = makeContext({ services: makeServices({ images, findings }) });
    scriptSuccess({ answer: 'A red car.' });

    const result = await visionRun(context, { question: 'q', imageIds: ['img-a'] });

    // Propagated failure shape: an explicit SubAgentError (not an escaped
    // throw, not a success), and no Finding in the ledger (review P2c).
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(SubAgentError);
    expect((error as SubAgentError).message).toContain('Finding could not be saved');
    expect((error as SubAgentError).message).toContain('sqlite crash');
    expect(findings.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failover through the real shared model chain
// ---------------------------------------------------------------------------

function makeVisionAgent(run = visionRun): LoadedSubAgent {
  return {
    manifest: {
      name: 'vision',
      version: '0.1.0',
      description: 'one-shot vision Inspection',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001', maxTokens: 8192 },
      requiredCapabilities: [],
      rootPaths: [],
      timeoutMs: 60_000,
      requiresEnv: [],
    },
    promptContents: ['VISION-SYSTEM-PROMPT'],
    run,
    rootDir: '/tmp/subagents/vision',
  };
}

function makeChainHarness() {
  const images = new FakeImageAccess();
  const imageA = jpegBytes('ATTEMPT-A-1');
  const imageB = jpegBytes('ATTEMPT-A-2');
  images.addAvailable('img-a', imageA);
  images.addAvailable('img-b', imageB);
  const findings = makeFindingLedger();

  const modelA = makeModel('ollama', 'llava-fake');
  const modelB = makeModel('anthropic', 'claude-haiku-4-5-20251001');
  const resolver = {
    resolve: vi.fn(async (entry: { provider: string; name: string }) =>
      entry.provider === 'ollama' ? ok(modelA) : ok(modelB),
    ),
  } as unknown as ModelResolver;

  const override = {
    model: [
      { provider: 'ollama' as const, name: 'llava-fake', maxTokens: 8192, timeoutMs: 10_000 },
      {
        provider: 'anthropic' as const,
        name: 'claude-haiku-4-5-20251001',
        maxTokens: 8192,
        timeoutMs: 10_000,
      },
    ],
  };

  const createContext = ({
    model,
    abortSignal,
    providerOptions,
  }: {
    model: LanguageModel;
    abortSignal: AbortSignal;
    providerOptions?: SubAgentContext['providerOptions'];
  }): SubAgentContext => ({
    threadId: THREAD_ID,
    personaId: 'assistant',
    runId: RUN_ID,
    systemPrompt: 'VISION-SYSTEM-PROMPT',
    model,
    maxOutputTokens: 8192,
    rootPaths: [],
    services: makeServices({ images, findings }),
    telemetry: { isEnabled: true },
    abortSignal,
    providerOptions,
  });

  const input: SubAgentInput = { question: 'What is parked on the street?', imageIds: ['img-a', 'img-b'] };

  const invokeChain = async () =>
    runSubAgentModelChain({
      name: 'vision',
      agent: makeVisionAgent(),
      input,
      override,
      modelResolver: resolver,
      logger: mockLogger,
      createContext,
    });

  return { images, findings, modelA, modelB, imageA, imageB, invokeChain };
}

describe('vision failover (real model chain)', () => {
  it('re-resolves every Image and sends ALL pixels again on the next attempt', async () => {
    const { images, findings, modelA, modelB, imageA, imageB, invokeChain } = makeChainHarness();

    // Attempt 1 (ollama): the model rejects the request. Before failing over,
    // the stored bytes change, simulating a fresh re-resolution of the same
    // Images for attempt 2.
    generateTextMock.mockImplementationOnce(async (options: Record<string, unknown>) => {
      expect(options.model).toBe(modelA);
      images.setBytes('img-a', jpegBytes('ATTEMPT-B-1'));
      images.setBytes('img-b', jpegBytes('ATTEMPT-B-2'));
      throw new Error('500 internal error');
    });
    scriptSuccess(
      { answer: 'A red car.', extractedText: 'PARKING 2H' },
      { inputTokens: 200, outputTokens: 30 },
    );

    const result = await invokeChain();

    expect(result.isOk()).toBe(true);
    const success = result._unsafeUnwrap();
    expect(success.model).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(success.failedAttempts).toBe(1);

    // Two independent requests, one per chain entry.
    const calls = capturedCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe(modelA);
    expect(calls[1].model).toBe(modelB);
    expect(calls[0].messages).not.toBe(calls[1].messages);

    // Attempt 1 carried both images with the bytes it loaded.
    const content0 = (calls[0].messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    expect(content0).toHaveLength(3);
    expect(content0[0]).toEqual({ type: 'text', text: 'What is parked on the street?' });
    expect(Buffer.isBuffer(content0[1].image)).toBe(true);
    expect((content0[1].image as Buffer).equals(imageA)).toBe(true);
    expect((content0[2].image as Buffer).equals(imageB)).toBe(true);

    // Attempt 2 re-resolved all Images and carried ALL pixels again — nothing
    // was dropped or truncated to obtain a successful answer.
    const content1 = (calls[1].messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    expect(content1).toHaveLength(3);
    expect(content1[0]).toEqual({ type: 'text', text: 'What is parked on the street?' });
    expect((content1[1].image as Buffer).equals(jpegBytes('ATTEMPT-B-1'))).toBe(true);
    expect((content1[2].image as Buffer).equals(jpegBytes('ATTEMPT-B-2'))).toBe(true);
    expect(content1[1].mediaType).toBe('image/jpeg');
    expect(content1[2].mediaType).toBe('image/jpeg');

    // Fresh load per attempt: 2 Images x 2 attempts.
    expect(images.fetchCalls).toHaveLength(4);

    // One Finding, attributed to the WINNING model with trusted provenance.
    expect(findings.create).toHaveBeenCalledOnce();
    expect(findings.entries).toHaveLength(1);
    const saved = lastFindingsCall(findings);
    expect(saved.runId).toBe(RUN_ID);
    expect(saved.modelName).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(saved.imageIds).toEqual(['img-a', 'img-b']);
    expect(saved.answer).toBe('A red car.');
    expect(saved.extractedText).toBe('PARKING 2H');
    expect(success.result.data).not.toHaveProperty('runId');
  });

  it('discards a late completion that lands after the chain resolved (no Finding from it)', async () => {
    // Entry 1's model request never settles within its 30ms entry timeout;
    // the chain aborts entry 1 and entry 2 succeeds. The late entry-1
    // completion must then hit the abort recheck and record nothing.
    let releaseLate!: (value: { text: string; usage?: Record<string, unknown> }) => void;
    const lateSettlement = new Promise<{ text: string; usage?: Record<string, unknown> }>(
      (resolve) => {
        releaseLate = resolve;
      },
    );
    const images = new FakeImageAccess();
    images.addAvailable('img-a', jpegBytes('PIXELS-A'));
    const findings = makeFindingLedger();
    const winnerModel = makeModel('anthropic', 'claude-haiku-4-5-20251001');
    const resolver = {
      resolve: vi.fn(async () => ok(winnerModel)),
    } as unknown as ModelResolver;
    const override = {
      model: [
        { provider: 'anthropic' as const, name: 'slow-model', maxTokens: 8192, timeoutMs: 30 },
        { provider: 'anthropic' as const, name: 'winner-model', maxTokens: 8192, timeoutMs: 10_000 },
      ],
    };
    const createContext = ({
      model,
      abortSignal,
      providerOptions,
    }: {
      model: LanguageModel;
      abortSignal: AbortSignal;
      providerOptions?: SubAgentContext['providerOptions'];
    }): SubAgentContext => ({
      threadId: THREAD_ID,
      personaId: 'assistant',
      runId: RUN_ID,
      systemPrompt: 'VISION-SYSTEM-PROMPT',
      model,
      maxOutputTokens: 8192,
      rootPaths: [],
      services: makeServices({ images, findings }),
      telemetry: { isEnabled: true },
      abortSignal,
      providerOptions,
    });

    // Entry 1 consumes the never-settling request; entry 2 the success.
    generateTextMock.mockReturnValueOnce(lateSettlement as never);
    scriptSuccess({ answer: 'A red car.' });

    const chained = await runSubAgentModelChain({
      name: 'vision',
      agent: makeVisionAgent(),
      input: { question: 'What is here?', imageIds: ['img-a'] },
      override,
      modelResolver: resolver,
      logger: mockLogger,
      createContext,
    });

    expect(chained.isOk()).toBe(true);
    expect((chained._unsafeUnwrap().result.data as Record<string, unknown>).answer).toBe(
      'A red car.',
    );
    expect(findings.entries).toHaveLength(1);
    expect(findings.entries[0].answer).toBe('A red car.');

    // Now let the late completion land and run its full tail (parse, abort
    // recheck, save attempt).
    releaseLate({
      text: JSON.stringify({ answer: 'LATE ANSWER' }),
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    await new Promise((r) => setTimeout(r, 20));

    // The late attempt recorded nothing: the ledger still holds exactly one
    // Finding — the winner's.
    expect(findings.entries).toHaveLength(1);
    expect(findings.entries[0].answer).toBe('A red car.');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('surfaces the final failure when every attempt fails the request (no Finding, no success)', async () => {
    const images = new FakeImageAccess();
    images.addAvailable('img-a', jpegBytes('PIXELS-A'));
    const findings = makeFindingLedger();
    const model = makeModel('openai', 'gpt-x');
    const resolver = {
      resolve: vi.fn(async () => ok(model)),
    } as unknown as ModelResolver;
    const override = {
      model: [
        // Plus the implicit manifest fallback entry (anthropic/claude-haiku).
        { provider: 'openai' as const, name: 'provider-a', maxTokens: 8192, timeoutMs: 30_000 },
      ],
    };
    const createContext = ({
      model,
      abortSignal,
      providerOptions,
    }: {
      model: LanguageModel;
      abortSignal: AbortSignal;
      providerOptions?: SubAgentContext['providerOptions'];
    }): SubAgentContext => ({
      threadId: THREAD_ID,
      personaId: 'assistant',
      runId: RUN_ID,
      systemPrompt: 'VISION-SYSTEM-PROMPT',
      model,
      maxOutputTokens: 8192,
      rootPaths: [],
      services: makeServices({ images, findings }),
      telemetry: { isEnabled: true },
      abortSignal,
      providerOptions,
    });

    scriptFailure('400: bad image part from provider A <detail-A>');
    scriptFailure('500: provider B exploded <detail-B>');

    const chained = await runSubAgentModelChain({
      name: 'vision',
      agent: makeVisionAgent(),
      input: { question: 'What is here?', imageIds: ['img-a'] },
      override,
      modelResolver: resolver,
      logger: mockLogger,
      createContext,
    });

    expect(chained.isErr()).toBe(true);
    const message = (chained._unsafeUnwrapErr() as Error).message;
    expect(message).toContain('vision');
    // Allowlisted status details are present; raw provider text is not
    // (review P1-2).
    expect(message).toContain('status 400');
    expect(message).toContain('status 500');
    expect(message).not.toContain('bad image part');
    expect(message).not.toContain('provider B exploded');
    // The chain's per-attempt warnings are the app warning surface (review
    // P2b): allowlisted detail present, raw provider text absent.
    const warnings = loggerCalls('warn').join('\n');
    expect(warnings).toContain('status 400');
    expect(warnings).toContain('status 500');
    expect(warnings).not.toContain('bad image part');
    expect(warnings).not.toContain('provider B exploded');
    expect(warnings).not.toContain('<detail-A>');
    expect(warnings).not.toContain('<detail-B>');
    expect(findings.entries).toHaveLength(0);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('starts no new attempt after an Image turns Unavailable', async () => {
    const { images, findings, invokeChain } = makeChainHarness();

    // Attempt 1 loads its Images, then fails at the model. Only AFTER that,
    // before attempt 2 may start, both Images expire: the fresh re-resolution
    // must refuse to load them, so attempt 2 never reaches the SDK.
    generateTextMock.mockImplementationOnce(async () => {
      images.setFault('img-a', { code: 'unavailable', unavailabilityReason: 'expired' });
      images.setFault('img-b', { code: 'unavailable', unavailabilityReason: 'expired' });
      throw new Error('500 internal error');
    });

    const result = await invokeChain();

    expect(result.isErr()).toBe(true);
    // Exactly one model request: the second attempt never reached the SDK
    // because its Image load failed first.
    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(result._unsafeUnwrapErr().message).toContain('Unavailable (expired)');
    expect(findings.create).not.toHaveBeenCalled();
    expect(findings.entries).toHaveLength(0);
  });

  it('keeps telemetry recordInputs off on every failover attempt', async () => {
    const { invokeChain } = makeChainHarness();
    generateTextMock.mockImplementationOnce(async () => {
      throw new Error('down');
    });
    scriptSuccess({ answer: 'A red car.' });

    await invokeChain();

    for (const call of capturedCalls()) {
      expect(call.experimental_telemetry).toEqual({ isEnabled: true, recordInputs: false });
    }
  });
});
