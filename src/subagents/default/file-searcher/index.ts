import { resolve } from 'node:path';
import { generateText } from 'ai';
import { ok, err } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { Result } from 'neverthrow';
import { searchFiles } from './lib/search.js';

const DEFAULT_MAX_RESULTS_WITHOUT_LLM = 20;
const MAX_RAW_RESULTS = 50;

/**
 * Validate that all caller-supplied rootPaths are sub-paths of at least one
 * allowed root from the manifest. This prevents callers from reading arbitrary
 * filesystem locations via input overrides.
 */
function validateRootPaths(requested: string[], allowed: string[]): boolean {
  return requested.every((req) => {
    const resolved = resolve(req);
    return allowed.some((allow) => {
      const resolvedAllow = resolve(allow);
      return resolved === resolvedAllow || resolved.startsWith(resolvedAllow + '/');
    });
  });
}

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';

  if (!query) {
    return err(new SubAgentError('Cannot search with empty query'));
  }

  // Allowed roots come from the manifest (ctx.rootPaths), not hardcoded defaults.
  const allowedRoots = ctx.rootPaths;
  if (allowedRoots.length === 0) {
    return err(new SubAgentError('No rootPaths configured in sub-agent manifest'));
  }

  const maxResultsWithoutLlm = typeof input.maxResultsWithoutLlm === 'number' && input.maxResultsWithoutLlm > 0
    ? input.maxResultsWithoutLlm
    : DEFAULT_MAX_RESULTS_WITHOUT_LLM;

  let rootPaths = allowedRoots;

  if (Array.isArray(input.rootPaths) && input.rootPaths.length > 0) {
    const candidates = input.rootPaths.filter((p): p is string => typeof p === 'string');
    if (candidates.length === 0 || !validateRootPaths(candidates, allowedRoots)) {
      return err(new SubAgentError(
        'Requested rootPaths are outside the allowed search scope',
      ));
    }
    rootPaths = candidates;
  }

  try {
    const MAX_FILE_SIZE_LIMIT = 8 * 1024 * 1024; // 8 MB hard cap
    const maxFileSize = typeof input.maxFileSize === 'number' && input.maxFileSize > 0
      ? Math.min(input.maxFileSize, MAX_FILE_SIZE_LIMIT)
      : undefined;

    const matches = await searchFiles(rootPaths, query, {
      maxResults: MAX_RAW_RESULTS,
      extensions: Array.isArray(input.extensions) ? (input.extensions as string[]) : undefined,
      maxFileSize,
    });

    if (matches.length === 0) {
      return ok({
        summary: `No files matched query "${query}"`,
        data: { results: [], query },
      });
    }

    // If few enough matches, return directly without LLM ranking
    if (matches.length <= maxResultsWithoutLlm) {
      const results = matches.map((m) => ({
        path: m.path,
        snippet: m.context,
        relevance: 1.0,
      }));

      return ok({
        summary: `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}"`,
        data: { results, query },
      });
    }

    // Too many matches — use LLM to rank by relevance
    const matchSummary = matches
      .map((m, i) => `[${i + 1}] ${m.path}:${m.line}\n${m.context}`)
      .join('\n\n---\n\n');

    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Query: "${query}"\n\nMatches:\n\n${matchSummary}`,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
    });

    let ranked: Array<{ path: string; snippet: string; relevance: number }> = [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        ranked = parsed.filter(
          (item): item is { path: string; snippet: string; relevance: number } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).path === 'string' &&
            typeof (item as Record<string, unknown>).snippet === 'string' &&
            typeof (item as Record<string, unknown>).relevance === 'number',
        );
      }
    } catch {
      // If LLM response isn't valid JSON, fall back to raw matches
      ranked = matches.slice(0, 10).map((m) => ({
        path: m.path,
        snippet: m.context,
        relevance: 1.0,
      }));
    }

    return ok({
      summary: `Found ${matches.length} matches for "${query}", ranked ${ranked.length} by relevance`,
      data: { results: ranked, query },
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(new SubAgentError(
      `File search failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}
