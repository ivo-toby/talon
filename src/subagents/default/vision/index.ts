/**
 * Built-in vision sub-agent: one-shot multimodal Inspection (ADR-0001).
 *
 * One invocation answers exactly one question about the current thread's
 * Images with a single SDK request that carries every referenced Normalized
 * JPEG as an in-memory `ImagePart` (`{ type: 'image', image: Buffer,
 * mediaType: 'image/jpeg' }` — AI SDK 6 contract, inventory row E12). URLs
 * are never sent: bytes come from the injected `ImageAccess` port (TASK-001)
 * and neither a path nor a URL ever enters the request. On success exactly
 * one textual Finding is persisted through the injected Finding ledger port
 * (TASK-011) before the result is returned; every failure path — input
 * validation, request failure, output validation, abort, or a failed write —
 * creates no Finding and returns an explicit `SubAgentError`.
 *
 * Failover (inventory I7): the shared model chain calls this run function
 * once per chain entry. Each attempt first preflights the WHOLE ID list with
 * metadata-only `getAvailability` (no pixel load), then re-resolves every
 * Image through a fresh `fetchInspectionBytes` and builds a fully independent
 * request with the question and ALL image parts. Pixels are never dropped to
 * obtain a successful answer, and no new attempt can start after an Image
 * expires because its fresh availability check fails before any pixel load.
 *
 * Error payloads stay payload-free (review P1-2): Image IDs must be PLAIN
 * ID-shaped tokens (alphanumerics, dash, dot, underscore, ≤128 chars) and
 * are rejected at the validation boundary — so no nonplain token (path,
 * URL, `data:` URI, base64 payload, angle brackets, padding) can ever reach
 * a port, a request, an error renderer, or the model-chain warning log.
 * Validation errors additionally redact anything nonplain to a generic
 * message, and model request errors forward only an allowlisted detail (a
 * leading numeric HTTP status code) — never raw provider-authored error
 * text. Every error path (including port `not_found` echoes) therefore
 * carries only plain opaque tokens and is log-safe.
 * An attempt that loaded its bytes before expiry may finish within the
 * entry timeout; SDK input recording stays disabled (inventory row E13) so
 * image bytes never enter telemetry, and the abort signal is rechecked
 * after generation so a timed-out or late attempt can never save a Finding
 * or return an unrecorded success.
 *
 * Provenance (inventory I8): `runId` comes only from the trusted host-tool
 * context forwarded by the runner, and the recorded model is the winning
 * SDK model instance resolved by Talon — never model-authored output.
 * Logs and observations carry text-only IDs/question/Finding text; pixel
 * bytes, base64 payloads, and credentials never leave this function's
 * request material.
 */

import { generateText } from 'ai';
import { randomUUID } from 'node:crypto';
import { ok, err, type Result } from 'neverthrow';
import type { ImagePart, LanguageModel, TextPart } from 'ai';
import type {
  SubAgentContext,
  SubAgentInput,
  SubAgentResult,
  SubAgentServices,
} from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { ImageAccess, ImageInspectionBytes } from '../../../images/image-types.js';
import type { FindingTokenUsage } from '../../../images/finding-types.js';
import type { FindingRecord } from '../../../core/database/repositories/finding-repository.js';
import type { DbError } from '../../../core/errors/index.js';

/**
 * Fallback ceiling on distinct Image IDs per Inspection. Mirrors the
 * `images.maxPerInspection` schema default; the validated configured value
 * arrives through `SubAgentServices.imageInspectionLimits` once runtime
 * wiring (TASK-014) supplies it.
 */
export const DEFAULT_MAX_PER_INSPECTION = 5;

/** The validated Inspection request shared by every attempt of one call. */
interface ValidatedInspection {
  question: string;
  imageIds: string[];
}

/** Validated textual answer DTO; absent optional fields mean the model reported nothing. */
interface InspectionAnswer {
  answer: string;
  extractedText?: string;
  uncertainty?: string;
}

// ---------------------------------------------------------------------------
// Services / provenance guards
// ---------------------------------------------------------------------------

interface VisionServices {
  images: ImageAccess;
  findings: NonNullable<SubAgentServices['findings']>;
  runId: string;
}

/**
 * Vision refuses to run without the Image access port, the Finding ledger
 * port, or the trusted run identity: an Inspection that cannot record its
 * Finding, or cannot verify where its bytes came from, is an explicit
 * invocation error — never a silent success and never a foreground fallback.
 */
function requireVisionServices(
  ctx: SubAgentContext,
): Result<VisionServices, SubAgentError> {
  if (!ctx.services.images) {
    return err(
      new SubAgentError(
        'Vision requires the Image access service (SubAgentServices.images); ' +
          'Inspection cannot resolve current-thread Images without it.',
      ),
    );
  }
  if (!ctx.services.findings) {
    return err(
      new SubAgentError(
        'Vision requires the Finding persistence service (SubAgentServices.findings); ' +
          'a successful Inspection must be able to record its Finding.',
      ),
    );
  }
  if (!ctx.runId) {
    return err(
      new SubAgentError(
        'Vision requires the trusted runId from the invoking run tool context; ' +
          'refusing to record a Finding with untrusted provenance.',
      ),
    );
  }
  return ok({
    images: ctx.services.images,
    findings: ctx.services.findings,
    runId: ctx.runId,
  });
}

// ---------------------------------------------------------------------------
// Input validation (runs before any Image load or model request)
// ---------------------------------------------------------------------------

/**
 * Plain opaque-ID tokens — the ONLY shape Talon generates for Image IDs
 * (alphanumerics, dash, dot, underscore, ≤128 chars).
 *
 * This is a POSITIVE shape check at the validation boundary (review P1):
 * paths, scheme URLs, `data:` URIs, base64 payloads (padding, angle
 * brackets, oversize), and any other nonplain token are rejected HERE so
 * no nonplain token can ever reach a port, a request, a downstream error
 * renderer (including port `not_found` echoes), or the model-chain warning
 * log. Every ID that survives validation is safe to echo verbatim.
 */
function isPlainIdToken(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,128}$/.test(value);
}

function isOpaqueImageId(value: unknown): value is string {
  return typeof value === 'string' && isPlainIdToken(value);
}

/**
 * Allowlisted detail for model request errors (review P1-2): at most the
 * leading numeric HTTP status code (e.g. `400` from `400: not supported`).
 * Raw provider-authored error text is never forwarded — it reaches app
 * warning logs and could echo request material.
 */
function extractStatusDetail(message: string): string | undefined {
  const match = /^([1-5]\d{2})\b/.exec(message);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) ? String(status) : undefined;
}

function validateInspectionInput(
  input: SubAgentInput,
  maxPerInspection: number,
): Result<ValidatedInspection, SubAgentError> {
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (question === '') {
    return err(new SubAgentError('Inspection requires a nonempty question.'));
  }

  if (!Array.isArray(input.imageIds)) {
    return err(
      new SubAgentError(
        'Inspection requires imageIds: an array of current-thread Image IDs (not paths or URLs).',
      ),
    );
  }
  const rawIds: readonly unknown[] = input.imageIds;
  if (rawIds.length === 0) {
    return err(new SubAgentError('Inspection requires at least one Image ID.'));
  }
  if (rawIds.length > maxPerInspection) {
    return err(
      new SubAgentError(
        `Inspection accepts at most ${maxPerInspection} Image IDs but received ` +
          `${rawIds.length}; the whole Inspection was rejected without truncation. ` +
          'Split it into separate Inspections.',
      ),
    );
  }

  for (const id of rawIds) {
    if (!isOpaqueImageId(id)) {
      // Payload-free error: echo the token only when it is a plain opaque-ID
      // shape (e.g. a numeric id); anything else (path, URL, data: URI,
      // base64) stays unnamed.
      const candidate = String(id);
      const badId = isPlainIdToken(candidate) ? candidate : undefined;
      return err(
        new SubAgentError(
          (badId !== undefined
            ? `Inspection received an invalid image id (${badId}); `
            : 'Inspection received an invalid image id; ') +
            'Image IDs are opaque identifiers — paths and URLs are never accepted.',
        ),
      );
    }
  }

  // Note: every id above is plain-shaped, so downstream renderers (port
  // not_found echoes, chain warnings) can safely quote them verbatim.

  // Every entry passed the opaque-string guard above.
  const imageIds = rawIds.filter(isOpaqueImageId);
  if (new Set(imageIds).size !== imageIds.length) {
    return err(
      new SubAgentError(
        'Inspection Image IDs must be distinct; duplicate IDs were rejected instead of deduplicated.',
      ),
    );
  }

  return ok({ question: input.question as string, imageIds: [...imageIds] });
}

// ---------------------------------------------------------------------------
// Per-attempt Image loading
// ---------------------------------------------------------------------------

/** Maps an `ImageAccessError` to an explicit, text-only Inspection error. */
function availabilityError(imageId: string, error: {
  code: string;
  message?: string;
  rejectionReason?: string;
  unavailabilityReason?: string;
}): SubAgentError {
  switch (error.code) {
    case 'not_found':
      return new SubAgentError(
        `Image ${imageId} was not found in the current thread; the whole Inspection was rejected.`,
      );
    case 'processing':
      return new SubAgentError(
        `Image ${imageId} is still Processing and cannot be inspected yet; ` +
          'the whole Inspection was rejected.',
      );
    case 'rejected':
      return new SubAgentError(
        `Image ${imageId} was Rejected (${error.rejectionReason ?? 'unknown reason'}) ` +
          'and cannot be inspected; the whole Inspection was rejected.',
      );
    case 'unavailable':
      return new SubAgentError(
        `Image ${imageId} is Unavailable (${error.unavailabilityReason ?? 'unknown reason'}); ` +
          'ask the user to re-upload. The whole Inspection was rejected.',
      );
    default:
      return new SubAgentError(
        `Failed to load Image ${imageId}: ${error.message ?? error.code}`,
      );
  }
}

/**
 * Loads every Image for one attempt in two passes (review P2-5):
 *
 * 1. Whole-list preflight — metadata-only `getAvailability` for EVERY id,
 *    in order, before ANY pixel load. A mixed list like
 *    `[available, unknown]` is rejected on the unknown id with zero pixels
 *    leaving the file layer. `getAvailability` refreshes state and expiry,
 *    so an Image that expired or turned terminal since the previous attempt
 *    fails here — before any pixel load and before any SDK request.
 * 2. Pixel load — fresh `fetchInspectionBytes` per Image, which re-resolves
 *    the file and carries the current byte set into the independent request.
 *
 * This is what keeps failover honest: no new attempt starts against stale or
 * unreadable Images, and every request carries the full current byte set.
 */
async function loadAllImageBytes(
  images: ImageAccess,
  threadId: string,
  imageIds: readonly string[],
): Promise<Result<ImageInspectionBytes[], SubAgentError>> {
  // Pass 1: whole-list availability preflight (no pixel load).
  for (const imageId of imageIds) {
    const availability = await images.getAvailability({ threadId, imageId });
    if (availability.isErr()) {
      return err(availabilityError(imageId, availability.error));
    }
    const state = availability.value;
    if (!state.available) {
      if (state.state === 'processing') {
        return err(availabilityError(imageId, { code: 'processing' }));
      }
      if (state.state === 'rejected') {
        return err(
          availabilityError(imageId, { code: 'rejected', rejectionReason: state.rejectionReason }),
        );
      }
      return err(
        availabilityError(imageId, {
          code: 'unavailable',
          unavailabilityReason: state.unavailabilityReason,
        }),
      );
    }
  }

  // Pass 2: pixel load, after the whole list passed preflight.
  const loaded: ImageInspectionBytes[] = [];
  for (const imageId of imageIds) {
    const result = await images.fetchInspectionBytes({ threadId, imageId });
    if (result.isErr()) {
      return err(availabilityError(imageId, result.error));
    }
    loaded.push(result.value);
  }
  return ok(loaded);
}

// ---------------------------------------------------------------------------
// Model output validation
// ---------------------------------------------------------------------------

/**
 * Validates the model reply into the textual Finding DTO. `extractedText`
 * and `uncertainty` are kept verbatim when the model reported real text;
 * blank values mean "reported nothing" and are stored absent, never as empty
 * strings (the Finding ledger requires verbatim text or absence).
 */
function parseInspectionAnswer(text: string): Result<InspectionAnswer, string> {
  // Parse the response UNCHANGED first. A fenced response is accepted only
  // when a single fence pair ENCLOSES the whole reply, and only then is the
  // enclosing fence removed (review P1-1): fences inside JSON string values
  // — e.g. OCR text containing triple backticks — must survive
  // byte-identically into the persisted Finding, so no global stripping is
  // ever applied.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const fenced = /^\s*```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
    if (!fenced) {
      return err('the vision model did not return a JSON object');
    }
    try {
      parsed = JSON.parse(fenced[1]);
    } catch {
      return err('the vision model did not return a JSON object');
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err('the vision model response was not a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  const answer = record.answer;
  if (typeof answer !== 'string' || answer.trim() === '') {
    return err('the vision model response is missing a nonempty answer');
  }

  const result: InspectionAnswer = { answer };
  for (const field of ['extractedText', 'uncertainty'] as const) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return err(`the vision model response field ${field} was not a string`);
    }
    if (value.trim() === '') continue; // reported nothing
    result[field] = value;
  }
  return ok(result);
}

// ---------------------------------------------------------------------------
// Trusted provenance helpers
// ---------------------------------------------------------------------------

/**
 * The winning model label, taken from the SDK model instance Talon resolved
 * for this attempt — never from anything the model wrote.
 */
function trustedModelName(model: LanguageModel): string {
  if (typeof model === 'string') return model;
  return `${model.provider}/${model.modelId}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Maps the SDK usage of the winning attempt to reported Finding usage.
 * Absent or non-integer counters stay absent: usage is never estimated or
 * zero-filled.
 */
function toFindingUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?:
    | { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }
    | undefined;
}): FindingTokenUsage {
  const mapped: FindingTokenUsage = {};
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  if (isNonNegativeInteger(usage.inputTokens)) mapped.inputTokens = usage.inputTokens;
  if (isNonNegativeInteger(usage.outputTokens)) mapped.outputTokens = usage.outputTokens;
  if (isNonNegativeInteger(cacheRead)) mapped.cacheReadTokens = cacheRead;
  if (isNonNegativeInteger(cacheWrite)) mapped.cacheWriteTokens = cacheWrite;
  return mapped;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  // 1. Services and trusted provenance gate (no Image load, no request).
  const services = requireVisionServices(ctx);
  if (services.isErr()) return err(services.error);
  const { images, findings, runId } = services.value;

  // 2. Input validation: whole call fails before any Image load or request.
  const maxPerInspection =
    ctx.services.imageInspectionLimits?.maxPerInspection ?? DEFAULT_MAX_PER_INSPECTION;
  const validated = validateInspectionInput(input, maxPerInspection);
  if (validated.isErr()) return err(validated.error);
  const { question, imageIds } = validated.value;

  // 3. Re-resolve every Image and refresh availability for THIS attempt.
  const loaded = await loadAllImageBytes(images, ctx.threadId, imageIds);
  if (loaded.isErr()) return err(loaded.error);

  // 4. One independent one-shot request: the question plus every Image as a
  //    Buffer JPEG ImagePart (E12). No URLs, no paths, no partial pixel sets.
  const content: Array<TextPart | ImagePart> = [
    { type: 'text', text: question },
    ...loaded.value.map((image) => ({
      type: 'image' as const,
      image: image.bytes,
      mediaType: image.mimeType,
    })),
  ];

  let text: string;
  let findingUsage: FindingTokenUsage;
  try {
    const generation = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      messages: [{ role: 'user', content }],
      maxOutputTokens: ctx.maxOutputTokens,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
      // E13: image inputs must never be recorded by SDK telemetry.
      experimental_telemetry: { ...ctx.telemetry, recordInputs: false },
    });
    text = generation.text;
    findingUsage = toFindingUsage(generation.usage ?? {});
  } catch (error) {
    // Includes aborts, timeouts, and a model rejecting image parts — an
    // ordinary request failure that fails over without dropping pixels.
    // Allowlisted detail only (review P1-2): at most a leading numeric HTTP
    // status code; the raw provider-authored error text is never forwarded
    // because it reaches application warning logs via the model chain.
    const detail =
      error instanceof Error ? extractStatusDetail(error.message) : undefined;
    return err(
      new SubAgentError(
        `Vision request failed${detail !== undefined ? ` (status ${detail})` : ''}; ` +
          'no Finding was recorded.',
      ),
    );
  }

  // 5. Validate the textual DTO. An unrecordable answer is an attempt
  //    failure, never a partial or unrecorded success.
  const parsed = parseInspectionAnswer(text);
  if (parsed.isErr()) {
    return err(new SubAgentError(`Vision response invalid: ${parsed.error}`));
  }

  // 6. Recheck abort after generation and before saving: a timed-out or
  //    late attempt must not persist a Finding.
  if (ctx.abortSignal?.aborted) {
    return err(
      new SubAgentError(
        'Inspection was aborted before the Finding could be saved; nothing was recorded.',
      ),
    );
  }

  // 7. Persist exactly one canonical Finding before returning it. A write
  //    failure fails the whole Inspection — no unrecorded success.
  const findingId = randomUUID();
  const model = trustedModelName(ctx.model);
  let created: Result<FindingRecord, DbError>;
  try {
    created = findings.create({
      id: findingId,
      runId,
      threadId: ctx.threadId,
      imageIds,
      question,
      answer: parsed.value.answer,
      extractedText: parsed.value.extractedText ?? null,
      uncertainty: parsed.value.uncertainty ?? null,
      modelName: model,
      usage: findingUsage,
    });
  } catch (error) {
    // A port crash that escapes as a raw throw (not a typed Result failure)
    // must fail the Inspection exactly like a typed write failure.
    return err(
      new SubAgentError(
        `Vision Inspection succeeded but its Finding could not be saved: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (created.isErr()) {
    return err(
      new SubAgentError(
        `Vision Inspection succeeded but its Finding could not be saved: ${created.error.message}`,
      ),
    );
  }

  // 8. Text-only result and log: IDs, question, Finding text, reported usage.
  ctx.services.logger.info(
    {
      threadId: ctx.threadId,
      runId: ctx.runId,
      findingId,
      imageIds,
      model,
    },
    'vision: Inspection recorded one Finding',
  );

  // Outer usage is reported only for counters the model actually reported
  // (review P2-4): unreported counters are omitted, never zero-filled.
  let outerUsage: { inputTokens: number; outputTokens: number } | undefined;
  if (findingUsage.inputTokens !== undefined && findingUsage.outputTokens !== undefined) {
    outerUsage = {
      inputTokens: findingUsage.inputTokens,
      outputTokens: findingUsage.outputTokens,
    };
  }
  return ok({
    summary:
      `Inspection of ${imageIds.length} image(s) completed. Finding ${findingId} ` +
      'records the answer to the submitted question.',
    data: {
      findingId,
      imageIds,
      answer: parsed.value.answer,
      ...(parsed.value.extractedText !== undefined
        ? { extractedText: parsed.value.extractedText }
        : {}),
      ...(parsed.value.uncertainty !== undefined
        ? { uncertainty: parsed.value.uncertainty }
        : {}),
      model,
      ...(Object.keys(findingUsage).length > 0 ? { usage: findingUsage } : {}),
    },
    ...(outerUsage !== undefined ? { usage: outerUsage } : {}),
  });
}
