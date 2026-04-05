/**
 * Stream-chunk usage extraction helpers for the openai-compatible wrapper
 * CLI. Kept in their own module so they can be unit-tested without having
 * to spawn Mastra or connect to a real LLM endpoint.
 *
 * Mastra and the AI SDK place the authoritative token counts on the
 * `finish` / `step-finish` chunks that flow through `fullStream`. The
 * exact location varies by provider and version — sometimes
 * `payload.output.usage`, sometimes `payload.totalUsage`, sometimes
 * `payload.usage`. We scan every known location and prefer chunk-derived
 * counts over the `stream.usage` promise, because some providers resolve
 * that promise with zeros once `fullStream` has been externally drained.
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
 * Scan a stream-chunk payload for a usage record in any of the known
 * shapes. Returns `undefined` if the payload carries no token counts.
 */
export function extractUsage(payload: Record<string, unknown>): UsageSnapshot | undefined {
  const stepResult = isRecord(payload.stepResult) ? payload.stepResult : undefined;
  const output = isRecord(payload.output) ? payload.output : undefined;

  const candidates: unknown[] = [
    // Top-level locations Mastra uses on finish/step-finish chunks.
    payload.totalUsage,
    payload.usage,
    // FinishPayload.output.usage.
    output?.usage,
    // StepFinishPayload.stepResult.{usage,totalUsage}. Some Mastra versions
    // and providers prefer one over the other, so scan both.
    stepResult?.usage,
    stepResult?.totalUsage,
  ];

  for (const candidate of candidates) {
    const snapshot = toUsageSnapshot(candidate);
    if (snapshot) {
      return snapshot;
    }
  }

  return undefined;
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
 * win: OpenAI-compatible servers emit the final, authoritative counts on
 * the last stream event, so we let them overwrite any partial numbers
 * seen earlier in the stream.
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
