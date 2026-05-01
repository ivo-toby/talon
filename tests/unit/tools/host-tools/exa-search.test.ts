/**
 * Unit tests for ExaSearchHandler.
 *
 * Tests cover:
 *   - Manifest shape and capability declaration
 *   - Successful search with all content modes (text, highlights, summary)
 *   - Snippet cascade (highlights → text → summary → null)
 *   - Default content mode when none specified
 *   - x-exa-integration header is sent on every request
 *   - Argument validation (missing query, bad numbers, bad arrays)
 *   - EXA_API_KEY missing → error
 *   - HTTP error responses surfaced
 *   - Network errors surfaced
 *   - AbortError → timeout status
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExaSearchHandler } from '../../../../src/tools/host-tools/exa-search.js';
import type { ExaSearchArgs } from '../../../../src/tools/host-tools/exa-search.js';

type Context = { runId: string; threadId: string; personaId: string; requestId?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeArgs(overrides: Partial<ExaSearchArgs> = {}): ExaSearchArgs {
  return {
    query: 'latest LLM research',
    ...overrides,
  };
}

function makeHandler(apiKey: string | undefined = 'test-key') {
  return new ExaSearchHandler({ logger: makeLogger(), apiKey });
}

interface FetchResponseInit {
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
  ok?: boolean;
}

function mockFetchResponse({
  status = 200,
  statusText = 'OK',
  json,
  text,
  ok,
}: FetchResponseInit) {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    statusText,
    json: vi.fn().mockResolvedValue(json ?? {}),
    text: vi.fn().mockResolvedValue(text ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Setup: mock global fetch
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('ExaSearchHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(ExaSearchHandler.manifest.name).toBe('web.search');
  });

  it('has executionLocation set to host', () => {
    expect(ExaSearchHandler.manifest.executionLocation).toBe('host');
  });

  it('declares web.search:exa capability', () => {
    expect(ExaSearchHandler.manifest.capabilities).toContain('web.search:exa');
  });
});

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

describe('ExaSearchHandler — API key resolution', () => {
  it('returns error when no API key is set', async () => {
    const original = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;

    const handler = new ExaSearchHandler({ logger: makeLogger() });
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/EXA_API_KEY/);

    if (original !== undefined) {
      process.env.EXA_API_KEY = original;
    }
  });

  it('falls back to process.env.EXA_API_KEY when constructor key is omitted', async () => {
    process.env.EXA_API_KEY = 'env-key';
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ json: { results: [], searchType: 'auto' } }) as never,
    );

    const handler = new ExaSearchHandler({ logger: makeLogger() });
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    const headers = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('env-key');

    delete process.env.EXA_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// Successful searches
// ---------------------------------------------------------------------------

describe('ExaSearchHandler — success', () => {
  it('returns normalized results from the Exa API', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({
        json: {
          results: [
            {
              title: 'Paper One',
              url: 'https://arxiv.org/abs/1',
              id: 'https://arxiv.org/abs/1',
              publishedDate: '2025-01-01T00:00:00Z',
              author: 'Alice',
              score: 0.91,
              text: 'Body of paper one.',
              highlights: ['key insight'],
              summary: null,
            },
          ],
          searchType: 'neural',
          costDollars: { total: 0.005 },
        },
      }) as never,
    );

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.tool).toBe('web.search');
    const payload = result.result as {
      query: string;
      searchType: string | null;
      costDollars: number | null;
      results: Array<{ title: string; snippet: string }>;
    };
    expect(payload.query).toBe('latest LLM research');
    expect(payload.searchType).toBe('neural');
    expect(payload.costDollars).toBe(0.005);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].title).toBe('Paper One');
  });

  it('always sends the x-exa-integration header', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ json: { results: [] } }) as never,
    );

    const handler = makeHandler();
    await handler.execute(makeArgs(), makeContext());

    const headers = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['x-exa-integration']).toBe('talon');
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('targets the Exa /search endpoint', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ json: { results: [] } }) as never,
    );

    const handler = makeHandler();
    await handler.execute(makeArgs(), makeContext());

    expect(fetchSpy).toHaveBeenCalledWith('https://api.exa.ai/search', expect.any(Object));
  });

  it('forwards filtering and content options to the API', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ json: { results: [] } }) as never,
    );

    const handler = makeHandler();
    await handler.execute(
      makeArgs({
        type: 'neural',
        category: 'research paper',
        numResults: 8,
        includeDomains: ['arxiv.org'],
        excludeDomains: ['example.com'],
        includeText: ['llm'],
        startPublishedDate: '2024-01-01',
        userLocation: 'US',
        highlights: true,
        summary: { query: 'main developments' },
      }),
      makeContext(),
    );

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;

    expect(body.query).toBe('latest LLM research');
    expect(body.type).toBe('neural');
    expect(body.category).toBe('research paper');
    expect(body.numResults).toBe(8);
    expect(body.includeDomains).toEqual(['arxiv.org']);
    expect(body.excludeDomains).toEqual(['example.com']);
    expect(body.includeText).toEqual(['llm']);
    expect(body.startPublishedDate).toBe('2024-01-01');
    expect(body.userLocation).toBe('US');

    const contents = body.contents as Record<string, unknown>;
    expect(contents.highlights).toBe(true);
    expect(contents.summary).toEqual({ query: 'main developments' });
    // text is omitted when caller picks other content modes — matches Exa SDK semantics
    expect(contents.text).toBeUndefined();
  });

  it('defaults to text content when no content mode is specified', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ json: { results: [] } }) as never,
    );

    const handler = makeHandler();
    await handler.execute(makeArgs(), makeContext());

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>;
    expect(contents.text).toEqual({ maxCharacters: 1000 });
  });

  it('clamps numResults to the valid range', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ json: { results: [] } }) as never,
    );

    const handler = makeHandler();
    await handler.execute(makeArgs({ numResults: 999 }), makeContext());

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body.numResults).toBe(25);
  });

  it('omits text when caller explicitly disables it', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ json: { results: [] } }) as never,
    );

    const handler = makeHandler();
    await handler.execute(
      makeArgs({ text: false, highlights: true }),
      makeContext(),
    );

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>;
    expect(contents.text).toBeUndefined();
    expect(contents.highlights).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snippet cascade
// ---------------------------------------------------------------------------

describe('ExaSearchHandler — snippet cascade', () => {
  function singleResultPayload(overrides: Record<string, unknown>) {
    return {
      results: [
        {
          title: 'r',
          url: 'https://r/1',
          id: 'r-1',
          ...overrides,
        },
      ],
    };
  }

  it('uses highlights when present', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({
        json: singleResultPayload({
          highlights: ['snippet a', 'snippet b'],
          text: 'fallback text',
          summary: 'fallback summary',
        }),
      }) as never,
    );

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());
    const payload = result.result as { results: Array<{ snippet: string }> };
    expect(payload.results[0].snippet).toBe('snippet a … snippet b');
  });

  it('falls back to text when no highlights', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({
        json: singleResultPayload({
          text: 'body text only',
          summary: 'fallback summary',
        }),
      }) as never,
    );

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());
    const payload = result.result as { results: Array<{ snippet: string }> };
    expect(payload.results[0].snippet).toBe('body text only');
  });

  it('falls back to summary when no highlights or text', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({
        json: singleResultPayload({ summary: 'just the summary' }),
      }) as never,
    );

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());
    const payload = result.result as { results: Array<{ snippet: string | null }> };
    expect(payload.results[0].snippet).toBe('just the summary');
  });

  it('returns null snippet when no content fields are present', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ json: singleResultPayload({}) }) as never,
    );

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());
    const payload = result.result as { results: Array<{ snippet: string | null }> };
    expect(payload.results[0].snippet).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('ExaSearchHandler — arg validation', () => {
  it('rejects missing query', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      { query: '' } as ExaSearchArgs,
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/query is required/);
  });

  it('rejects non-positive numResults', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      makeArgs({ numResults: 0 }),
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/numResults/);
  });

  it('rejects non-array includeDomains', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      makeArgs({ includeDomains: 'arxiv.org' as unknown as string[] }),
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/includeDomains/);
  });
});

// ---------------------------------------------------------------------------
// HTTP / network errors
// ---------------------------------------------------------------------------

describe('ExaSearchHandler — error responses', () => {
  it('surfaces non-2xx HTTP responses with detail', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({
        status: 401,
        statusText: 'Unauthorized',
        ok: false,
        text: 'invalid api key',
      }) as never,
    );

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/401/);
    expect(result.error).toMatch(/invalid api key/);
  });

  it('returns timeout status when request is aborted', async () => {
    fetchSpy.mockImplementation(() => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      return Promise.reject(abortError);
    });

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('timeout');
  });

  it('returns error on network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
