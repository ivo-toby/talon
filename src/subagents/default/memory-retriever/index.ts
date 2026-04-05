import { generateText } from 'ai';
import { ok, err } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { MemoryItemRow } from '../../../core/database/repositories/memory-repository.js';

/** Shape of a single ranked result from the model. */
interface RankedItem {
  id: string;
  relevance: number;
  reason: string;
}

/** Top-level response shape from the model. */
interface RankResponse {
  ranked: RankedItem[];
}

/** Default number of memories below which we skip LLM ranking and do keyword-only. */
const DEFAULT_LLM_THRESHOLD = 10;

/** Default max results to return. */
const DEFAULT_TOP_K = 10;

/** Format memory items into a numbered list for the model prompt. */
function formatMemories(items: MemoryItemRow[]): string {
  return items
    .map(
      (item, idx) =>
        `${idx + 1}. [id=${item.id}] type=${item.type} created=${new Date(item.created_at).toISOString()}\n   ${item.content}`,
    )
    .join('\n\n');
}

/** Simple keyword pre-filter: returns items whose content contains any query word. */
function keywordFilter(items: MemoryItemRow[], query: string): MemoryItemRow[] {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (words.length === 0) return items;

  return items.filter((item) => {
    const lower = item.content.toLowerCase();
    return words.some((word) => lower.includes(word));
  });
}

/** Parse the model's JSON response into ranked items. */
function parseResponse(text: string): RankedItem[] {
  try {
    const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed: unknown = JSON.parse(cleaned);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    const response = parsed as RankResponse;
    if (!Array.isArray(response.ranked)) return [];

    return response.ranked
      .filter(
        (item): item is RankedItem =>
          typeof item === 'object' &&
          item !== null &&
          typeof item.id === 'string' &&
          typeof item.relevance === 'number' &&
          typeof item.reason === 'string' &&
          item.relevance >= 0.3 &&
          item.relevance <= 1,
      )
      .sort((a, b) => b.relevance - a.relevance);
  } catch {
    return [];
  }
}

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';

  if (!query) {
    return err(new SubAgentError('Cannot retrieve memories with empty query'));
  }

  const topK = typeof input.topK === 'number' && input.topK > 0
    ? Math.min(input.topK, 50)
    : DEFAULT_TOP_K;

  const llmThreshold = typeof input.threshold === 'number' && input.threshold > 0
    ? input.threshold
    : DEFAULT_LLM_THRESHOLD;

  const { memory, logger } = ctx.services;

  // 1. Read all memory items for this thread.
  const findResult = memory.findByThread(ctx.threadId);
  if (findResult.isErr()) {
    return err(new SubAgentError(`Failed to read memory items: ${findResult.error.message}`));
  }

  const allItems = findResult.value;
  if (allItems.length === 0) {
    return ok({
      summary: 'No memories found for this thread.',
      data: { results: [], query },
    });
  }

  // 2. Keyword pre-filter to narrow candidates.
  const candidates = keywordFilter(allItems, query);

  if (candidates.length === 0) {
    return ok({
      summary: `No memories matched query "${query}"`,
      data: { results: [], query },
    });
  }

  // 3. If few enough candidates, return directly without LLM.
  if (candidates.length <= llmThreshold) {
    const results = candidates.slice(0, topK).map((item) => ({
      id: item.id,
      type: item.type,
      content: item.content,
      relevance: 1.0,
      reason: 'Keyword match',
    }));

    return ok({
      summary: `Found ${results.length} memor${results.length === 1 ? 'y' : 'ies'} matching "${query}"`,
      data: { results, query },
    });
  }

  // 4. Too many candidates — use LLM to rank by relevance.
  try {
    const prompt = `Query: "${query}"\n\nMemory entries:\n\n${formatMemories(candidates)}`;

    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });

    const ranked = parseResponse(text);

    if (ranked.length === 0) {
      logger.warn('LLM returned no valid ranked items, falling back to keyword results');
      const fallback = candidates.slice(0, topK).map((item) => ({
        id: item.id,
        type: item.type,
        content: item.content,
        relevance: 1.0,
        reason: 'Keyword match (LLM fallback)',
      }));

      return ok({
        summary: `Found ${fallback.length} memor${fallback.length === 1 ? 'y' : 'ies'} for "${query}" (keyword only)`,
        data: { results: fallback, query },
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costUsd: 0,
        },
      });
    }

    // Enrich ranked items with full content from the source data.
    const itemMap = new Map(candidates.map((i) => [i.id, i]));
    const enriched = ranked
      .filter((r) => itemMap.has(r.id))
      .slice(0, topK)
      .map((r) => {
        const item = itemMap.get(r.id)!;
        return {
          id: r.id,
          type: item.type,
          content: item.content,
          relevance: r.relevance,
          reason: r.reason,
        };
      });

    // Fallback if all ranked IDs were hallucinated / filtered out.
    if (enriched.length === 0) {
      logger.warn('All LLM-ranked IDs were unknown, falling back to keyword results');
      const fallbackResults = candidates.slice(0, topK).map((item) => ({
        id: item.id,
        type: item.type,
        content: item.content,
        relevance: 1.0,
        reason: 'Keyword match (LLM fallback)',
      }));

      return ok({
        summary: `Found ${fallbackResults.length} memor${fallbackResults.length === 1 ? 'y' : 'ies'} for "${query}" (keyword only)`,
        data: { results: fallbackResults, query },
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costUsd: 0,
        },
      });
    }

    return ok({
      summary: `Found ${enriched.length} relevant memor${enriched.length === 1 ? 'y' : 'ies'} for "${query}", ranked by relevance`,
      data: { results: enriched, query },
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(
      new SubAgentError(
        `Memory retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}
