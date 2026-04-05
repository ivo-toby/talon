import { describe, expect, it } from 'vitest';
import {
  chooseUsage,
  extractUsage,
  mergeUsage,
  normalizeUsage,
} from '../../../src/providers/openai-compatible/agent-cli/usage.js';

describe('openai-compatible wrapper usage extraction', () => {
  describe('extractUsage', () => {
    it('reads usage from a step-finish-style totalUsage payload', () => {
      // Shape emitted by Mastra on step-finish chunks.
      const usage = extractUsage({
        totalUsage: { inputTokens: 120, outputTokens: 24, cachedInputTokens: 48 },
      });
      expect(usage).toEqual({ inputTokens: 120, outputTokens: 24, cachedInputTokens: 48 });
    });

    it('reads usage from a finish-style output.usage payload', () => {
      // Shape emitted by Mastra on finish chunks (FinishPayload.output.usage).
      const usage = extractUsage({
        output: { usage: { inputTokens: 42, outputTokens: 7 } },
      });
      expect(usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    });

    it('reads usage from a flat payload.usage shape', () => {
      // Some providers / older Mastra versions place it at the top level.
      const usage = extractUsage({
        usage: { inputTokens: 10, outputTokens: 3 },
      });
      expect(usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    });

    it('reads usage from stepResult.totalUsage when that is the only location', () => {
      // Mastra's own step-result schema includes stepResult.totalUsage;
      // some provider pipelines surface usage only there.
      const usage = extractUsage({
        stepResult: {
          totalUsage: { inputTokens: 200, outputTokens: 80 },
        },
      });
      expect(usage).toEqual({ inputTokens: 200, outputTokens: 80 });
    });

    it('prefers stepResult.usage over stepResult.totalUsage when both exist', () => {
      // The per-step usage (stepResult.usage) is scanned first because it
      // is the more specific, per-chunk value; totalUsage is the accumulator.
      const usage = extractUsage({
        stepResult: {
          usage: { inputTokens: 50, outputTokens: 20 },
          totalUsage: { inputTokens: 200, outputTokens: 80 },
        },
      });
      expect(usage).toEqual({ inputTokens: 50, outputTokens: 20 });
    });

    it('returns undefined for chunks without any recognised usage shape', () => {
      expect(extractUsage({ text: 'hello' })).toBeUndefined();
      expect(extractUsage({ output: { text: 'hello' } })).toBeUndefined();
      expect(extractUsage({ usage: null })).toBeUndefined();
      expect(extractUsage({ usage: {} })).toBeUndefined();
    });

    it('ignores non-numeric token fields', () => {
      // Defensive: some providers send string counts.
      const usage = extractUsage({
        usage: { inputTokens: '42' as unknown as number, outputTokens: 7 },
      });
      expect(usage).toEqual({ outputTokens: 7 });
    });
  });

  describe('mergeUsage', () => {
    it('lets later chunks overwrite earlier ones', () => {
      // OpenAI-compatible servers emit the final counts on the last stream
      // event, so newer values must win.
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
      // This is the regression guard for the bug where `stream.usage` settles
      // with zeros after fullStream is externally drained — the chunk-derived
      // counts must win.
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
      // Regression guard: if a provider emits a chunk that carries only
      // cachedInputTokens (and the promise resolves with zeros), the chunk
      // must still win so we do not drop the cache signal.
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
