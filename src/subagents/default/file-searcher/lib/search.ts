import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';

export interface SearchMatch {
  path: string;
  line: number;
  content: string;
  context: string;
}

const DEFAULT_EXTENSIONS = ['.md', '.txt', '.ts', '.js'];
const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB
const NULL_BYTE_CHECK_SIZE = 512;

interface SearchOptions {
  extensions?: string[];
  maxResults?: number;
  contextLines?: number;
  maxFileSize?: number;
}

// ---------------------------------------------------------------------------
// Search backend detection (lazy singleton)
// ---------------------------------------------------------------------------

type SearchBackend = 'rg' | 'grep' | 'node';

let detectedBackend: SearchBackend | null = null;

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function detectBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [name], (error) => {
      resolve(!error);
    });
  });
}

/** Detect the fastest available search backend. Cached after first call. */
export async function detectBackend(): Promise<SearchBackend> {
  if (detectedBackend !== null) return detectedBackend;

  if (await detectBinary('rg')) {
    detectedBackend = 'rg';
  } else if (await detectBinary('grep')) {
    detectedBackend = 'grep';
  } else {
    detectedBackend = 'node';
  }

  return detectedBackend;
}

/** Reset cached backend (for testing). */
export function resetBackendCache(): void {
  detectedBackend = null;
}

/** Force a specific backend (for testing). */
export function setBackendForTest(backend: SearchBackend): void {
  detectedBackend = backend;
}

// ---------------------------------------------------------------------------
// Resolved options (shared across backends)
// ---------------------------------------------------------------------------

interface ResolvedOptions {
  extensions: string[];
  maxResults: number;
  contextLines: number;
  maxFileSize?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search files within the given root paths for lines matching the query.
 * Uses rg → grep → Node.js fallback cascade. If the selected backend fails
 * at runtime, falls through to the next one.
 */
export async function searchFiles(
  rootPaths: string[],
  query: string,
  options?: SearchOptions,
): Promise<SearchMatch[]> {
  const backend = await detectBackend();
  const opts: ResolvedOptions = {
    maxResults: options?.maxResults ?? 50,
    contextLines: options?.contextLines ?? 2,
    extensions: options?.extensions ?? DEFAULT_EXTENSIONS,
    maxFileSize: options?.maxFileSize,
  };

  const cascade: SearchBackend[] =
    backend === 'rg' ? ['rg', 'grep', 'node'] :
    backend === 'grep' ? ['grep', 'node'] :
    ['node'];

  for (const be of cascade) {
    try {
      switch (be) {
        case 'rg': {
          const results = await searchWithRg(rootPaths, query, opts);
          if (shouldTryNextBackendAfterEmptyResult(results, rootPaths)) continue;
          return results;
        }
        case 'grep': {
          const results = await searchWithGrep(rootPaths, query, opts);
          if (shouldTryNextBackendAfterEmptyResult(results, rootPaths)) continue;
          return results;
        }
        case 'node':
          return await searchWithNode(rootPaths, query, opts);
      }
    } catch {
      // Backend failed at runtime — try next in cascade
      continue;
    }
  }

  return [];
}

function shouldTryNextBackendAfterEmptyResult(results: SearchMatch[], rootPaths: string[]): boolean {
  return results.length === 0 && rootPaths.some((rootPath) => !existsSync(rootPath));
}

// ---------------------------------------------------------------------------
// ripgrep backend (uses --json for unambiguous parsing)
// ---------------------------------------------------------------------------

function searchWithRg(
  rootPaths: string[],
  query: string,
  opts: ResolvedOptions,
): Promise<SearchMatch[]> {
  const args = [
    '--json',
    '--ignore-case',
    '--fixed-strings',
    `--max-filesize=${opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE}`,
    `--context=${opts.contextLines}`,
  ];

  for (const ext of opts.extensions) {
    args.push('--glob', `*${ext}`);
  }

  args.push('--', query, ...rootPaths);

  return new Promise((resolve, reject) => {
    execFile('rg', args, { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }, (error, stdout) => {
      if (error) {
        // Exit code 1 = no matches (normal for rg/grep)
        if (error.code === 1) {
          resolve([]);
          return;
        }
        reject(asError(error));
        return;
      }

      const matches = parseRgJson(stdout ?? '', opts.contextLines, opts.maxResults);
      resolve(matches);
    });
  });
}

/** Parse rg --json output into SearchMatch[]. */
function parseRgJson(stdout: string, contextLines: number, maxResults: number): SearchMatch[] {
  if (!stdout.trim()) return [];

  // Collect all match and context data, grouped by file
  interface RgMatch { path: string; line: number; content: string }

  const allMatches: RgMatch[] = [];
  const contextMap = new Map<string, Map<number, string>>(); // path -> lineNum -> content

  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    try {
      const obj = JSON.parse(rawLine) as Record<string, unknown>;
      if (obj.type === 'match') {
        const data = obj.data as { path: { text: string }; line_number: number; lines: { text: string } };
        const content = data.lines.text.replace(/\n$/, '');
        allMatches.push({
          path: data.path.text,
          line: data.line_number,
          content,
        });
        // Also store in contextMap so adjacent matches appear in context windows
        const filePath = data.path.text;
        if (!contextMap.has(filePath)) contextMap.set(filePath, new Map());
        contextMap.get(filePath)!.set(data.line_number, content);
      } else if (obj.type === 'context') {
        const data = obj.data as { path: { text: string }; line_number: number; lines: { text: string } };
        const filePath = data.path.text;
        if (!contextMap.has(filePath)) contextMap.set(filePath, new Map());
        contextMap.get(filePath)!.set(data.line_number, data.lines.text.replace(/\n$/, ''));
      }
    } catch {
      continue;
    }
  }

  // Build SearchMatch with context windows
  const results: SearchMatch[] = [];
  for (const m of allMatches) {
    if (results.length >= maxResults) break;

    const fileCtx = contextMap.get(m.path);
    const contextParts: string[] = [];

    for (let ln = m.line - contextLines; ln <= m.line + contextLines; ln++) {
      if (ln === m.line) {
        contextParts.push(m.content);
      } else if (fileCtx?.has(ln)) {
        contextParts.push(fileCtx.get(ln)!);
      }
    }

    results.push({
      path: m.path,
      line: m.line,
      content: m.content,
      context: contextParts.join('\n'),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// grep backend
// ---------------------------------------------------------------------------

function searchWithGrep(
  rootPaths: string[],
  query: string,
  opts: ResolvedOptions,
): Promise<SearchMatch[]> {
  // grep cannot enforce maxFileSize — cascade to node
  if (opts.maxFileSize !== undefined) {
    return Promise.reject(new Error('grep does not support maxFileSize'));
  }

  const args = [
    '--recursive',
    '--line-number',
    '--with-filename',
    '--ignore-case',
    '--fixed-strings',
    `--max-count=${opts.maxResults}`,
    `--after-context=${opts.contextLines}`,
    `--before-context=${opts.contextLines}`,
    '--binary-files=without-match',
  ];

  for (const ext of opts.extensions) {
    args.push(`--include=*${ext}`);
  }

  args.push('--', query, ...rootPaths);

  return new Promise((resolve, reject) => {
    execFile('grep', args, { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }, (error, stdout) => {
      if (error) {
        if (error.code === 1) {
          resolve([]);
          return;
        }
        reject(asError(error));
        return;
      }

      const matches = parseGrepOutput(stdout ?? '', opts.maxResults);
      resolve(matches);
    });
  });
}

/**
 * Parse grep output with context lines.
 * Match lines: "path:linenum:content", context lines: "path-linenum-content", groups separated by "--".
 *
 * To handle paths containing "-digits-", we match from the known path prefix
 * extracted from the match line (which uses ":" separators and is unambiguous).
 */
function parseGrepOutput(stdout: string, maxResults: number): SearchMatch[] {
  if (!stdout.trim()) return [];

  const matches: SearchMatch[] = [];
  const groups = stdout.split(/^--$/m);

  for (const group of groups) {
    if (matches.length >= maxResults) break;

    const lines = group.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    // Build context string from the whole group
    const contextParts: string[] = [];
    let knownPath = '';

    // First pass: determine the file path from a match line
    for (const line of lines) {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (m) { knownPath = m[1]; break; }
    }

    // Second pass: extract content from all lines
    for (const line of lines) {
      const matchLine = line.match(/^(.+?):(\d+):(.*)$/);
      if (matchLine) {
        contextParts.push(matchLine[3]);
      } else if (knownPath) {
        const prefix = knownPath + '-';
        if (line.startsWith(prefix)) {
          const rest = line.slice(prefix.length);
          const ctxMatch = rest.match(/^(\d+)-(.*)$/);
          if (ctxMatch) { contextParts.push(ctxMatch[2]); continue; }
        }
        contextParts.push(line);
      } else {
        contextParts.push(line);
      }
    }

    const context = contextParts.join('\n');

    // Third pass: emit a SearchMatch for every match line in the group
    for (const line of lines) {
      if (matches.length >= maxResults) break;

      const matchResult = line.match(/^(.+?):(\d+):(.*)$/);
      if (matchResult) {
        matches.push({
          path: matchResult[1],
          line: parseInt(matchResult[2], 10),
          content: matchResult[3],
          context,
        });
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Node.js fallback (original implementation)
// ---------------------------------------------------------------------------

async function searchWithNode(
  rootPaths: string[],
  query: string,
  opts: ResolvedOptions,
): Promise<SearchMatch[]> {
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const matches: SearchMatch[] = [];
  const pattern = new RegExp(escapeRegExp(query), 'i');

  for (const rootPath of rootPaths) {
    if (matches.length >= opts.maxResults) break;

    let entries: string[];
    try {
      entries = await listFiles(rootPath, opts.extensions);
    } catch {
      continue;
    }

    for (const filePath of entries) {
      if (matches.length >= opts.maxResults) break;

      try {
        const content = await readFileSafe(filePath, maxFileSize);
        if (content === null) continue;

        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= opts.maxResults) break;

          if (pattern.test(lines[i])) {
            const start = Math.max(0, i - opts.contextLines);
            const end = Math.min(lines.length - 1, i + opts.contextLines);
            const contextSlice = lines.slice(start, end + 1).join('\n');

            matches.push({
              path: filePath,
              line: i + 1,
              content: lines[i],
              context: contextSlice,
            });
          }
        }
      } catch {
        continue;
      }
    }
  }

  return matches;
}

async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!extensions.includes(ext)) continue;
    const parentEntry = entry as typeof entry & { parentPath?: string; path?: string };
    const parent = parentEntry.parentPath ?? parentEntry.path;
    if (parent === undefined) continue;
    const fullPath = join(parent, entry.name);
    results.push(fullPath);
  }

  return results;
}

async function readFileSafe(filePath: string, maxFileSize: number = DEFAULT_MAX_FILE_SIZE): Promise<string | null> {
  try {
    const st = await stat(filePath);
    if (st.size > maxFileSize) return null;

    const buf = await readFile(filePath);

    const checkLen = Math.min(buf.length, NULL_BYTE_CHECK_SIZE);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0) return null;
    }

    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
