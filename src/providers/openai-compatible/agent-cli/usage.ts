/**
 * Stream-chunk usage extraction helpers for the openai-compatible wrapper
 * CLI. Kept in their own module so they can be unit-tested without having
 * to spawn Mastra or connect to a real LLM endpoint.
 *
 * Mastra and the AI SDK place token counts on `step-finish` and `finish`
 * chunks in fullStream. The exact location varies by provider and version
 * — sometimes `payload.usage`, sometimes `payload.totalUsage`, sometimes
 * `payload.output.usage`, sometimes `payload.stepResult.{usage,totalUsage}`.
 * We scan every known location and prefer chunk-derived counts over the
 * `stream.usage` promise, because some providers resolve that promise with
 * zeros once `fullStream` has been externally drained.
 *
 * Per-step vs cumulative
 * ----------------------
 * `usage` on a step-finish chunk reports tokens for THAT step (the last
 * model call). `totalUsage` (and the cumulative-shaped `output.usage` on a
 * finish chunk) reports the running total across all steps in the current
 * agent loop. Downstream consumers care about each separately:
 *
 * - Telemetry / accounting (Langfuse, `runs.input_tokens`) wants
 *   CUMULATIVE — that is what the user was actually billed for.
 * - Context-rotation gating wants PER-STEP — it asks "is the NEXT prompt
 *   going to exceed the model's context window?". Cumulative across a
 *   multi-tool loop can easily exceed the per-call window and would
 *   trigger spurious session rotations.
 *
 * These are exposed as two distinct extractors so the caller can maintain
 * separate accumulators and surface both upstream. Mixing the two within a
 * single snapshot is never correct.
 */

export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract PER-STEP usage from a stream chunk payload.
 *
 * Scans only the locations that carry per-step (single-turn) token counts:
 * `payload.usage` and `payload.stepResult.usage`. Returns `undefined` if
 * neither is present, so callers never mistake cumulative shapes for
 * per-step data.
 */
export function extractPerStepUsage(payload: Record<string, unknown>): UsageSnapshot | undefined {
  const stepResult = isRecord(payload.stepResult) ? payload.stepResult : undefined;
  const candidates: unknown[] = [payload.usage, stepResult?.usage];
  for (const candidate of candidates) {
    const snapshot = toUsageSnapshot(candidate);
    if (snapshot) {
      return snapshot;
    }
  }
  return undefined;
}

/**
 * Extract CUMULATIVE usage from a stream chunk payload.
 *
 * Scans only the locations that carry running totals across the agent
 * loop: `payload.output.usage` (final cumulative on finish chunks),
 * `payload.totalUsage`, and `payload.stepResult.totalUsage`. Returns
 * `undefined` if none is present.
 */
export function extractCumulativeUsage(
  payload: Record<string, unknown>,
): UsageSnapshot | undefined {
  const stepResult = isRecord(payload.stepResult) ? payload.stepResult : undefined;
  const output = isRecord(payload.output) ? payload.output : undefined;
  const candidates: unknown[] = [output?.usage, payload.totalUsage, stepResult?.totalUsage];
  for (const candidate of candidates) {
    const snapshot = toUsageSnapshot(candidate);
    if (snapshot) {
      return snapshot;
    }
  }
  return undefined;
}

/**
 * Legacy combined extractor — preferred order is per-step first, then
 * cumulative. Retained for callers that want a single "best available"
 * usage signal without caring about provenance. Avoid in code paths that
 * need to distinguish the two (use the specialized extractors instead).
 */
export function extractUsage(payload: Record<string, unknown>): UsageSnapshot | undefined {
  return extractPerStepUsage(payload) ?? extractCumulativeUsage(payload);
}

export function toUsageSnapshot(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = typeof value.inputTokens === 'number' ? value.inputTokens : undefined;
  const outputTokens = typeof value.outputTokens === 'number' ? value.outputTokens : undefined;
  const cachedInputTokens =
    typeof value.cachedInputTokens === 'number' ? value.cachedInputTokens : undefined;

  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

/**
 * Merge a newer usage snapshot into an accumulator. Later chunks always
 * win: openai-compatible servers emit the final, authoritative counts on
 * the last stream event, so newer values overwrite earlier ones.
 *
 * IMPORTANT: callers must keep per-step and cumulative accumulators in
 * SEPARATE variables and only merge values of the same kind into each.
 * This function does not enforce that — it cannot know what kind a
 * snapshot is — so cross-kind merges are the caller's responsibility to
 * avoid (e.g. by extracting via `extractPerStepUsage` vs
 * `extractCumulativeUsage` and routing into the matching accumulator).
 */
export function mergeUsage(
  current: UsageSnapshot | undefined,
  next: UsageSnapshot,
): UsageSnapshot {
  return {
    inputTokens: next.inputTokens ?? current?.inputTokens,
    outputTokens: next.outputTokens ?? current?.outputTokens,
    cachedInputTokens: next.cachedInputTokens ?? current?.cachedInputTokens,
  };
}

/**
 * Pick the most reliable usage source. Chunk-derived usage wins when it
 * contains a non-zero input or output count, otherwise fall back to
 * whatever the Mastra `stream.usage` promise resolved to.
 */
export function chooseUsage(
  chunkDerived: UsageSnapshot | undefined,
  fromPromise: UsageSnapshot | undefined,
): UsageSnapshot | undefined {
  // A chunk-derived snapshot is authoritative as soon as it carries any
  // non-zero signal — input, output, OR cache tokens. Otherwise fall back
  // to the promise (which may still carry zeros, but that's informative).
  if (chunkDerived && hasNonZeroSignal(chunkDerived)) {
    return chunkDerived;
  }
  return fromPromise ?? chunkDerived;
}

function hasNonZeroSignal(usage: UsageSnapshot): boolean {
  return (
    (usage.inputTokens ?? 0) > 0
    || (usage.outputTokens ?? 0) > 0
    || (usage.cachedInputTokens ?? 0) > 0
  );
}

export function normalizeUsage(
  usage: UsageSnapshot | undefined,
): { inputTokens: number; outputTokens: number; cacheReadTokens?: number } {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    ...(typeof usage?.cachedInputTokens === 'number'
      ? { cacheReadTokens: usage.cachedInputTokens }
      : {}),
  };
}
