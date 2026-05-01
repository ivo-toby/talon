## Web Search

Use `web_search` to search the live web via the Exa API. Best for answering
questions about current events, recent research, specific URLs, or information
that is not in the persona's memory.

The tool returns ranked results with title, url, publishedDate, and a snippet
that cascades through highlights → text → summary depending on which content
modes were requested. Results include a `costDollars` field so callers can
track usage.

Tips:

- Pass `category` (e.g. `news`, `research paper`, `github`) to focus results.
- Use `includeDomains` / `excludeDomains` to scope to known sources.
- Use `startPublishedDate` / `endPublishedDate` for time-bounded queries.
- Set `highlights: true` for short relevance-scored snippets, or `summary: true`
  for an LLM-generated summary; `text` is on by default.
