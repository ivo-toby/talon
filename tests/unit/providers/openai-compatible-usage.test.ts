import { describe, expect, it } from 'vitest';
import {
  chooseUsage,
  extractCumulativeUsage,
  extractPerStepUsage,
  extractUsage,
  mergeUsage,
  normalizeUsage,
} from '../../../src/providers/openai-compatible/agent-cli/usage.js';

describe('openai-compatible wrapper usage extraction', () => {
  describe('extractPerStepUsage', () => {
    it('reads the top-level payload.usage shape (step-finish per-step)', () => {
      const usage = extractPerStepUsage({
        usage: { inputTokens: 30, outputTokens: 10 },
      });
      expect(usage).toEqual({ inputTokens: 30, outputTokens: 10 });
    });

    it('reads stepResult.usage (Mastra step-finish per-step)', () => {
      const usage = extractPerStepUsage({
        stepResult: { usage: { inputTokens: 50, outputTokens: 20 } },
      });
      expect(usage).toEqual({ inputTokens: 50, outputTokens: 20 });
    });

    it('prefers payload.usage over stepResult.usage when both exist', () => {
      // Both are per-step but we still need a deterministic order. Top-level
      // wins because Mastra's outer chunk typically carries the freshest data.
      const usage = extractPerStepUsage({
        usage: { inputTokens: 30, outputTokens: 10 },
        stepResult: { usage: { inputTokens: 999, outputTokens: 999 } },
      });
      expect(usage).toEqual({ inputTokens: 30, outputTokens: 10 });
    });

    it('returns undefined when only cumulative shapes are present', () => {
      // Cumulative `totalUsage` / `output.usage` must NOT leak into per-step.
      // This is the core invariant that prevents the inflated-ratio bug.
      expect(
        extractPerStepUsage({ totalUsage: { inputTokens: 540, outputTokens: 90 } }),
      ).toBeUndefined();
      expect(
        extractPerStepUsage({ output: { usage: { inputTokens: 540, outputTokens: 90 } } }),
      ).toBeUndefined();
      expect(
        extractPerStepUsage({
          stepResult: { totalUsage: { inputTokens: 540, outputTokens: 90 } },
        }),
      ).toBeUndefined();
    });
  });

  describe('extractCumulativeUsage', () => {
    it('reads the top-level payload.totalUsage shape (step-finish cumulative)', () => {
      const usage = extractCumulativeUsage({
        totalUsage: { inputTokens: 540, outputTokens: 90, cachedInputTokens: 48 },
      });
      expect(usage).toEqual({ inputTokens: 540, outputTokens: 90, cachedInputTokens: 48 });
    });

    it('reads output.usage (Mastra finish-chunk cumulative)', () => {
      const usage = extractCumulativeUsage({
        output: { usage: { inputTokens: 540, outputTokens: 90 } },
      });
      expect(usage).toEqual({ inputTokens: 540, outputTokens: 90 });
    });

    it('reads stepResult.totalUsage when nothing else is present', () => {
      const usage = extractCumulativeUsage({
        stepResult: { totalUsage: { inputTokens: 540, outputTokens: 90 } },
      });
      expect(usage).toEqual({ inputTokens: 540, outputTokens: 90 });
    });

    it('returns undefined when only per-step shapes are present', () => {
      // Symmetric guarantee: per-step values must NOT leak into cumulative.
      expect(
        extractCumulativeUsage({ usage: { inputTokens: 30, outputTokens: 10 } }),
      ).toBeUndefined();
      expect(
        extractCumulativeUsage({ stepResult: { usage: { inputTokens: 30, outputTokens: 10 } } }),
      ).toBeUndefined();
    });
  });

  describe('extractUsage (legacy combined)', () => {
    it('prefers per-step over cumulative when both are present', () => {
      const usage = extractUsage({
        usage: { inputTokens: 30, outputTokens: 10 },
        totalUsage: { inputTokens: 540, outputTokens: 90 },
      });
      expect(usage).toEqual({ inputTokens: 30, outputTokens: 10 });
    });

    it('falls back to cumulative when only cumulative is present', () => {
      const usage = extractUsage({
        totalUsage: { inputTokens: 540, outputTokens: 90 },
      });
      expect(usage).toEqual({ inputTokens: 540, outputTokens: 90 });
    });

    it('returns undefined for chunks without any recognised usage shape', () => {
      expect(extractUsage({ text: 'hello' })).toBeUndefined();
      expect(extractUsage({ output: { text: 'hello' } })).toBeUndefined();
      expect(extractUsage({ usage: null })).toBeUndefined();
      expect(extractUsage({ usage: {} })).toBeUndefined();
    });

    it('ignores non-numeric token fields', () => {
      const usage = extractUsage({
        usage: { inputTokens: '42' as unknown as number, outputTokens: 7 },
      });
      expect(usage).toEqual({ outputTokens: 7 });
    });
  });

  describe('two-accumulator streaming semantics', () => {
    // These guard the wrapper-CLI streaming loop's invariant: per-step and
    // cumulative are accumulated in SEPARATE variables so a later cumulative
    // chunk can never clobber the freshest per-step value (and vice versa).
    // We simulate the streaming loop here to lock in behavior.

    function simulate(chunks: Array<Record<string, unknown>>): {
      perStep: ReturnType<typeof mergeUsage> | undefined;
      cumulative: ReturnType<typeof mergeUsage> | undefined;
    } {
      let perStep: ReturnType<typeof mergeUsage> | undefined;
      let cumulative: ReturnType<typeof mergeUsage> | undefined;
      for (const chunk of chunks) {
        const ps = extractPerStepUsage(chunk);
        if (ps) perStep = mergeUsage(perStep, ps);
        const cu = extractCumulativeUsage(chunk);
        if (cu) cumulative = mergeUsage(cumulative, cu);
      }
      return { perStep, cumulative };
    }

    it('per-step value survives a trailing cumulative finish chunk', () => {
      // Mastra emits per-step on step-finish, then a finish chunk with the
      // cumulative total in output.usage. The per-step value must NOT be
      // overwritten — this is the inflated-ratio regression guard.
      const { perStep, cumulative } = simulate([
        // First step-finish: per-step 20K, cumulative 20K.
        { usage: { inputTokens: 20_000, outputTokens: 500 }, totalUsage: { inputTokens: 20_000, outputTokens: 500 } },
        // Second step-finish: per-step 30K, cumulative 50K.
        { usage: { inputTokens: 30_000, outputTokens: 800 }, totalUsage: { inputTokens: 50_000, outputTokens: 1_300 } },
        // Trailing finish chunk: only cumulative (546K) present, no per-step.
        { output: { usage: { inputTokens: 546_000, outputTokens: 1_500 } } },
      ]);
      expect(perStep?.inputTokens).toBe(30_000);
      expect(cumulative?.inputTokens).toBe(546_000);
    });

    it('cumulative value survives partial per-step-only chunks', () => {
      // Symmetric guarantee: a chunk with only per-step data does not
      // overwrite the running cumulative total.
      const { perStep, cumulative } = simulate([
        { totalUsage: { inputTokens: 100_000, outputTokens: 2_000 } },
        // Partial per-step chunk (no totalUsage) — must not clobber cumulative.
        { usage: { inputTokens: 15_000, outputTokens: 400 } },
      ]);
      expect(perStep?.inputTokens).toBe(15_000);
      expect(cumulative?.inputTokens).toBe(100_000);
    });

    it('cachedInputTokens stays within its own accumulator', () => {
      // Field-level provenance check: cumulative cache tokens never leak
      // into the per-step accumulator and vice versa.
      const { perStep, cumulative } = simulate([
        { totalUsage: { inputTokens: 200_000, cachedInputTokens: 80_000 } },
        { usage: { inputTokens: 25_000, cachedInputTokens: 1_000 } },
      ]);
      expect(perStep?.cachedInputTokens).toBe(1_000);
      expect(cumulative?.cachedInputTokens).toBe(80_000);
    });

    it('summed per-step is a faithful cumulative fallback', () => {
      // For providers that only emit per-step shapes (no native cumulative
      // chunk), summing per-step inputs across the loop equals what
      // `totalUsage` would have reported. The wrapper uses this as a
      // billing-accurate fallback so Langfuse / `runs.input_tokens` do not
      // silently under-report. Simulate the loop's third accumulator here.
      let summedInput = 0;
      let summedOutput = 0;
      const chunks = [
        { usage: { inputTokens: 20_000, outputTokens: 500 } },
        { usage: { inputTokens: 30_000, outputTokens: 800 } },
        { usage: { inputTokens: 25_000, outputTokens: 600 } },
      ];
      for (const c of chunks) {
        const ps = extractPerStepUsage(c);
        if (ps) {
          summedInput += ps.inputTokens ?? 0;
          summedOutput += ps.outputTokens ?? 0;
        }
      }
      expect(summedInput).toBe(75_000);
      expect(summedOutput).toBe(1_900);
    });
  });

  describe('mergeUsage', () => {
    it('lets later snapshots overwrite earlier ones', () => {
      const merged = mergeUsage(
        { inputTokens: 10, outputTokens: 5 },
        { inputTokens: 120, outputTokens: 24 },
      );
      expect(merged).toEqual({
        inputTokens: 120,
        outputTokens: 24,
        cachedInputTokens: undefined,
      });
    });

    it('preserves earlier fields when the newer chunk omits them', () => {
      const merged = mergeUsage(
        { inputTokens: 50, cachedInputTokens: 12 },
        { outputTokens: 8 },
      );
      expect(merged).toEqual({
        inputTokens: 50,
        outputTokens: 8,
        cachedInputTokens: 12,
      });
    });

    it('works without a previous accumulator', () => {
      const merged = mergeUsage(undefined, { inputTokens: 3, outputTokens: 4 });
      expect(merged).toEqual({
        inputTokens: 3,
        outputTokens: 4,
        cachedInputTokens: undefined,
      });
    });
  });

  describe('chooseUsage', () => {
    it('prefers chunk-derived usage when it has non-zero counts', () => {
      const chunk = { inputTokens: 120, outputTokens: 24 };
      const fromPromise = { inputTokens: 0, outputTokens: 0 };
      expect(chooseUsage(chunk, fromPromise)).toEqual(chunk);
    });

    it('falls back to the promise when chunk usage is all zero', () => {
      const chunk = { inputTokens: 0, outputTokens: 0 };
      const fromPromise = { inputTokens: 99, outputTokens: 11 };
      expect(chooseUsage(chunk, fromPromise)).toEqual(fromPromise);
    });

    it('returns undefined when neither source has usage', () => {
      expect(chooseUsage(undefined, undefined)).toBeUndefined();
    });

    it('returns the chunk snapshot when only the chunk source is defined', () => {
      const chunk = { inputTokens: 5, outputTokens: 3 };
      expect(chooseUsage(chunk, undefined)).toEqual(chunk);
    });

    it('treats a chunk with only cache tokens as authoritative', () => {
      const chunk = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 42 };
      const fromPromise = { inputTokens: 0, outputTokens: 0 };
      expect(chooseUsage(chunk, fromPromise)).toEqual(chunk);
    });
  });

  describe('normalizeUsage', () => {
    it('defaults missing counts to zero and omits cacheReadTokens when absent', () => {
      expect(normalizeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(normalizeUsage({ inputTokens: 7 })).toEqual({ inputTokens: 7, outputTokens: 0 });
    });

    it('maps cachedInputTokens onto cacheReadTokens for AgentUsage compatibility', () => {
      expect(normalizeUsage({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 })).toEqual({
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 4,
      });
    });
  });
});
