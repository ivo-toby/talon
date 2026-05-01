/**
 * Host-side tool: web.search
 *
 * Performs web search via the Exa API and returns results with optional
 * content (text, highlights, summary). Useful for personas that need to
 * answer questions about the live web — research assistants, news
 * summarizers, fact-checkers, etc.
 *
 * The handler talks directly to https://api.exa.ai/search using the host's
 * built-in fetch — the same pattern as net.http — so it does not add a new
 * SDK dependency and keeps egress observable through host logs.
 *
 * Authentication: reads the Exa API key from the EXA_API_KEY environment
 * variable. The tool registers its manifest unconditionally; if the key is
 * absent at call time the handler returns a clear error.
 *
 * Gated by `web.search:exa`.
 */

import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolExecutionContext } from './channel-send.js';

/** Manifest for the web.search host tool. */
export interface ExaSearchTool {
  readonly manifest: ToolManifest;
}

/** Search type accepted by the Exa API. `auto` is the default. */
export type ExaSearchType = 'neural' | 'fast' | 'auto' | 'instant';

/** Category filter accepted by the Exa API. */
export type ExaCategory =
  | 'company'
  | 'research paper'
  | 'news'
  | 'pdf'
  | 'github'
  | 'tweet'
  | 'personal site'
  | 'linkedin profile'
  | 'financial report';

/** Arguments accepted by the web.search tool. */
export interface ExaSearchArgs {
  /** Search query string. */
  query: string;
  /** Search method (default: `auto`). */
  type?: ExaSearchType;
  /** Optional category filter — narrows results to a known content type. */
  category?: ExaCategory;
  /** Number of results to return (1–25, default: 5). */
  numResults?: number;
  /** Include only results from these domains (max 1200). */
  includeDomains?: string[];
  /** Exclude results from these domains (max 1200). */
  excludeDomains?: string[];
  /** Require results to contain this phrase (max 5 words). */
  includeText?: string[];
  /** Exclude results that contain this phrase (max 5 words). */
  excludeText?: string[];
  /** Minimum publication date (ISO 8601). */
  startPublishedDate?: string;
  /** Maximum publication date (ISO 8601). */
  endPublishedDate?: string;
  /** Two-letter ISO country code (e.g. `US`, `GB`) for geographic relevance. */
  userLocation?: string;
  /** When true, return short text excerpts (default). */
  text?: boolean;
  /** When true, return relevance-scored highlight snippets. */
  highlights?: boolean;
  /**
   * When provided, generate an LLM summary of each result. Pass `true` for a
   * default summary or an object with `query` to guide it.
   */
  summary?: boolean | { query: string };
  /** Maximum characters of text to return per result (default: 1000). */
  maxCharacters?: number;
}

/** Single search result returned by the tool. */
export interface ExaSearchResultEntry {
  title: string | null;
  url: string;
  id: string;
  publishedDate: string | null;
  author: string | null;
  score: number | null;
  /** Best-effort snippet — falls back through highlights → text → summary. */
  snippet: string | null;
  text: string | null;
  highlights: string[] | null;
  summary: string | null;
}

/** Tool response payload. */
export interface ExaSearchResultPayload {
  query: string;
  searchType: string | null;
  results: ExaSearchResultEntry[];
  costDollars: number | null;
}

/** Wire-shape of the Exa /search response we consume. */
interface ExaApiResult {
  title?: string | null;
  url: string;
  id: string;
  publishedDate?: string | null;
  author?: string | null;
  score?: number | null;
  text?: string | null;
  highlights?: string[] | null;
  summary?: string | null;
}

interface ExaApiResponse {
  results: ExaApiResult[];
  searchType?: string;
  costDollars?: { total?: number };
}

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 25;
const DEFAULT_MAX_CHARACTERS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const EXA_API_URL = 'https://api.exa.ai/search';
const INTEGRATION_HEADER = 'talon';

/**
 * Handler class for the web.search host tool.
 *
 * Validates inputs, calls the Exa /search endpoint with content options the
 * persona requested, and returns a normalized result list with a snippet
 * field that cascades through the available content modes.
 */
export class ExaSearchHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'web.search',
    description:
      'Performs AI-powered web search via Exa and returns results with text, highlights, or summaries.',
    capabilities: ['web.search:exa'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      logger: pino.Logger;
      /** Optional API key. Falls back to `process.env.EXA_API_KEY` at call time. */
      apiKey?: string;
    },
  ) {}

  /**
   * Execute the web.search tool.
   *
   * @param args    - Validated tool arguments.
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success', 'error', or 'timeout'.
   */
  async execute(args: ExaSearchArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    const apiKey = this.deps.apiKey ?? process.env.EXA_API_KEY;
    if (!apiKey || apiKey.trim() === '') {
      const error = new ToolError(
        'web.search: EXA_API_KEY environment variable is not set',
      );
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'web.search', status: 'error', error: error.message };
    }

    const validation = validateArgs(args);
    if (!validation.ok) {
      this.deps.logger.warn({ requestId }, validation.error);
      return { requestId, tool: 'web.search', status: 'error', error: validation.error };
    }

    const body = buildRequestBody(validation.value);

    this.deps.logger.info(
      {
        requestId,
        runId: context.runId,
        personaId: context.personaId,
        query: validation.value.query,
        numResults: body.numResults,
      },
      'web.search: executing',
    );

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(EXA_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-exa-integration': INTEGRATION_HEADER,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);

      if (!response.ok) {
        const detail = await safeReadText(response);
        const msg = `web.search: Exa API returned ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`;
        this.deps.logger.warn({ requestId, status: response.status }, msg);
        return { requestId, tool: 'web.search', status: 'error', error: msg };
      }

      const data = (await response.json()) as ExaApiResponse;
      const payload = formatPayload(validation.value.query, data);

      this.deps.logger.info(
        { requestId, resultCount: payload.results.length },
        'web.search: completed',
      );

      return {
        requestId,
        tool: 'web.search',
        status: 'success',
        result: payload,
      };
    } catch (cause) {
      clearTimeout(timeoutHandle);

      if (cause instanceof Error && cause.name === 'AbortError') {
        this.deps.logger.warn({ requestId }, 'web.search: request timed out');
        return { requestId, tool: 'web.search', status: 'timeout' };
      }

      const msg = `web.search: request failed — ${cause instanceof Error ? cause.message : String(cause)}`;
      this.deps.logger.error({ requestId, err: cause }, msg);
      return { requestId, tool: 'web.search', status: 'error', error: msg };
    }
  }
}

interface ValidationOk {
  ok: true;
  value: ExaSearchArgs;
}

interface ValidationErr {
  ok: false;
  error: string;
}

function validateArgs(args: ExaSearchArgs): ValidationOk | ValidationErr {
  if (!args.query || typeof args.query !== 'string' || args.query.trim() === '') {
    return { ok: false, error: 'web.search: query is required and must be a non-empty string' };
  }

  if (args.numResults !== undefined) {
    if (typeof args.numResults !== 'number' || args.numResults < 1) {
      return { ok: false, error: 'web.search: numResults must be a positive number' };
    }
  }

  if (args.maxCharacters !== undefined) {
    if (typeof args.maxCharacters !== 'number' || args.maxCharacters < 1) {
      return { ok: false, error: 'web.search: maxCharacters must be a positive number' };
    }
  }

  if (args.includeDomains && !Array.isArray(args.includeDomains)) {
    return { ok: false, error: 'web.search: includeDomains must be an array of strings' };
  }
  if (args.excludeDomains && !Array.isArray(args.excludeDomains)) {
    return { ok: false, error: 'web.search: excludeDomains must be an array of strings' };
  }
  if (args.includeText && !Array.isArray(args.includeText)) {
    return { ok: false, error: 'web.search: includeText must be an array of strings' };
  }
  if (args.excludeText && !Array.isArray(args.excludeText)) {
    return { ok: false, error: 'web.search: excludeText must be an array of strings' };
  }

  return { ok: true, value: args };
}

interface ExaContentsRequest {
  text?: { maxCharacters: number } | true;
  highlights?: true;
  summary?: true | { query: string };
}

interface ExaSearchRequestBody {
  query: string;
  type?: ExaSearchType;
  category?: ExaCategory;
  numResults: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeText?: string[];
  excludeText?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  userLocation?: string;
  contents: ExaContentsRequest;
}

function buildRequestBody(args: ExaSearchArgs): ExaSearchRequestBody {
  const numResults = Math.min(
    Math.max(1, Math.floor(args.numResults ?? DEFAULT_NUM_RESULTS)),
    MAX_NUM_RESULTS,
  );

  const contents: ExaContentsRequest = {};

  // Default to text content if the caller did not explicitly pick a content mode.
  const askedAnyContent =
    args.text !== undefined || args.highlights !== undefined || args.summary !== undefined;
  const wantText = args.text === true || (!askedAnyContent && args.text !== false);

  if (wantText) {
    const maxCharacters = Math.max(1, Math.floor(args.maxCharacters ?? DEFAULT_MAX_CHARACTERS));
    contents.text = { maxCharacters };
  }
  if (args.highlights === true) {
    contents.highlights = true;
  }
  if (args.summary !== undefined && args.summary !== false) {
    contents.summary = args.summary === true ? true : { query: args.summary.query };
  }

  const body: ExaSearchRequestBody = {
    query: args.query,
    numResults,
    contents,
  };

  if (args.type) body.type = args.type;
  if (args.category) body.category = args.category;
  if (args.includeDomains?.length) body.includeDomains = args.includeDomains;
  if (args.excludeDomains?.length) body.excludeDomains = args.excludeDomains;
  if (args.includeText?.length) body.includeText = args.includeText;
  if (args.excludeText?.length) body.excludeText = args.excludeText;
  if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate;
  if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate;
  if (args.userLocation) body.userLocation = args.userLocation;

  return body;
}

function formatPayload(query: string, data: ExaApiResponse): ExaSearchResultPayload {
  const results: ExaSearchResultEntry[] = (data.results ?? []).map((r) => {
    const highlights = r.highlights ?? null;
    const text = r.text ?? null;
    const summary = r.summary ?? null;

    // Snippet cascade: highlights → text → summary. Any can be missing.
    let snippet: string | null = null;
    if (highlights && highlights.length > 0) {
      snippet = highlights.join(' … ');
    } else if (text && text.trim() !== '') {
      snippet = text;
    } else if (summary && summary.trim() !== '') {
      snippet = summary;
    }

    return {
      title: r.title ?? null,
      url: r.url,
      id: r.id,
      publishedDate: r.publishedDate ?? null,
      author: r.author ?? null,
      score: r.score ?? null,
      snippet,
      text,
      highlights,
      summary,
    };
  });

  return {
    query,
    searchType: data.searchType ?? null,
    results,
    costDollars: data.costDollars?.total ?? null,
  };
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.trim() === '' ? null : text;
  } catch {
    return null;
  }
}
