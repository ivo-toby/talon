/**
 * Tool-output excerpting for the openai-compatible agent-cli wrapper.
 *
 * Ollama and other small-window openai-compatible endpoints are overwhelmed
 * by a single large tool result — a 50K-char `read_file` dump will bust an
 * 8K window in one step. This module caps what enters the message history
 * while retaining the full payload in-memory for the current agent run, so
 * the model can explicitly re-fetch ranges via the `fetch_tool_output` tool.
 *
 * Spec: specs/2026-04-20-tool-output-excerpting-stage1.md
 *
 * Design invariants:
 *   - Errors are NEVER truncated (they're short and critical).
 *   - Shape-aware: MCP `{ content: [{ type: 'text', text }] }` is preserved,
 *     plain strings are head/tail trimmed, objects are JSON-stringified.
 *   - Truncation markers are explicit so the model knows the excerpt is a
 *     Talon artefact and how to retrieve the rest.
 *   - `fetch_tool_output` slices are themselves bounded to prevent
 *     reintroducing the whole payload by asking for a huge range.
 */

/** Default cap for a single tool result entering message history. */
export const DEFAULT_TOOL_OUTPUT_CAP = 4000;
/** Upper bound on a single `fetch_tool_output` slice. */
export const DEFAULT_FETCH_SLICE_CAP = 8000;
/** Fraction of the cap taken from the head of the output. Remainder is tail. */
const HEAD_RATIO = 0.7;

/**
 * Stable record kept in the in-memory store for the duration of one agent run.
 * `fullOutput` is the raw stringified content (JSON-stringified for objects).
 */
export interface StoredToolOutput {
  toolName: string;
  fullOutput: string;
  originalChars: number;
  truncated: boolean;
  excerptChars: number;
}

/**
 * In-memory store of full tool outputs, keyed by toolCallId. Lifetime is a
 * single agent run (the agent-cli child process). No DB or disk writes.
 */
export class ToolOutputStore {
  private readonly entries = new Map<string, StoredToolOutput>();

  record(toolCallId: string, record: StoredToolOutput): void {
    this.entries.set(toolCallId, record);
  }

  get(toolCallId: string): StoredToolOutput | undefined {
    return this.entries.get(toolCallId);
  }

  size(): number {
    return this.entries.size;
  }

  /** Clears the entire store. Exposed primarily for tests. */
  clear(): void {
    this.entries.clear();
  }
}

/** Result of excerpting a tool output for history injection. */
export interface ExcerptResult {
  /** Content to place in message history. Shape mirrors the input where possible. */
  excerpt: unknown;
  /** The stringified full output (used for the store). */
  fullOutputString: string;
  /** True when truncation actually occurred. */
  truncated: boolean;
  originalChars: number;
  excerptChars: number;
}

/**
 * Produce a bounded excerpt for a tool result.
 *
 * - When `cap <= 0`, excerpting is disabled: the input passes through unchanged.
 * - Errors (either `isError: true` on an MCP-shaped result, or a short
 *   stderr-like payload) are never truncated.
 * - MCP shape is preserved so downstream Mastra/Agent code keeps working.
 */
export function excerptToolOutput(
  toolCallId: string,
  toolName: string,
  rawResult: unknown,
  cap: number,
): ExcerptResult {
  const fullOutputString = stringifyForStorage(rawResult);
  const originalChars = fullOutputString.length;

  // Disabled — pass through untouched.
  if (cap <= 0) {
    return {
      excerpt: rawResult,
      fullOutputString,
      truncated: false,
      originalChars,
      excerptChars: originalChars,
    };
  }

  // Skip truncation for error-flagged or obviously short payloads. Error
  // messages and short strings aren't worth the overhead.
  if (isLikelyError(rawResult) || originalChars <= cap) {
    return {
      excerpt: rawResult,
      fullOutputString,
      truncated: false,
      originalChars,
      excerptChars: originalChars,
    };
  }

  // MCP shape: preserve envelope when bulk is in text parts. When the text
  // parts are small (bulk is in images / binary / non-text parts), skip the
  // envelope-preserving path and fall through to the generic stringify-and-
  // truncate branch below — otherwise oversized non-text content would pass
  // through untouched and violate the "never enters history unbounded"
  // invariant.
  if (isMcpShape(rawResult)) {
    const { combinedOriginal } = concatMcpText(rawResult);
    if (combinedOriginal.length > cap) {
      const truncatedText = buildTruncatedText(combinedOriginal, cap, toolName, toolCallId);
      const excerpt = {
        ...(rawResult as Record<string, unknown>),
        content: [{ type: 'text' as const, text: truncatedText }],
      };
      return {
        excerpt,
        fullOutputString,
        truncated: true,
        originalChars,
        excerptChars: truncatedText.length,
      };
    }
    // Text parts fit but overall stringified size is still too big → bulk
    // is non-text. Fall through to generic truncation (covers images,
    // resource blobs, custom MCP part types, etc.).
  }

  // String result.
  if (typeof rawResult === 'string') {
    const truncatedText = buildTruncatedText(rawResult, cap, toolName, toolCallId);
    return {
      excerpt: truncatedText,
      fullOutputString,
      truncated: true,
      originalChars,
      excerptChars: truncatedText.length,
    };
  }

  // Everything else — stringify and head/tail. Structure is lost; JSON-aware
  // trimming is a V2 concern.
  const truncatedText = buildTruncatedText(fullOutputString, cap, toolName, toolCallId);
  return {
    excerpt: truncatedText,
    fullOutputString,
    truncated: true,
    originalChars,
    excerptChars: truncatedText.length,
  };
}

/**
 * Fetch a ranged slice of a previously-stored tool output. Each slice is
 * itself capped at `sliceCap` chars so the model can't reintroduce the full
 * payload by asking for `[0, Infinity]`.
 *
 * On any validation failure (missing id, invalid range) returns a string
 * explaining the problem rather than throwing, so the model can self-correct.
 */
export function fetchToolOutputSlice(
  store: ToolOutputStore,
  toolCallId: string,
  startChar: number | undefined,
  endChar: number | undefined,
  sliceCap: number = DEFAULT_FETCH_SLICE_CAP,
): string {
  const entry = store.get(toolCallId);
  if (!entry) {
    return `Error: no stored tool output found for toolCallId="${toolCallId}". `
      + `Outputs are retained only for the current agent run; if this id is `
      + `from a prior turn it is no longer available.`;
  }

  const total = entry.fullOutput.length;
  const start = normalizeIndex(startChar, 0, total);
  const tentativeEnd = endChar === undefined ? start + sliceCap : normalizeIndex(endChar, start, total);
  if (tentativeEnd <= start) {
    return `Error: endChar (${endChar}) must be greater than startChar (${startChar}). `
      + `The output has ${total} total chars; call with a non-empty range.`;
  }
  const end = Math.min(tentativeEnd, start + sliceCap, total);
  const slice = entry.fullOutput.slice(start, end);

  const prefixRange = `[range ${start}-${end} of ${total} from '${entry.toolName}', toolCallId="${toolCallId}"]\n`;
  if (end - start >= sliceCap && end < total) {
    const hint = `\n[slice capped at ${sliceCap} chars. call fetch_tool_output with `
      + `startChar=${end} to continue, or narrow the range.]`;
    return prefixRange + slice + hint;
  }
  return prefixRange + slice;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface McpTextPart {
  type: 'text';
  text: string;
}
interface McpShape {
  content: Array<McpTextPart | { type: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

function isMcpShape(value: unknown): value is McpShape {
  if (typeof value !== 'object' || value === null) return false;
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content);
}

function concatMcpText(mcp: McpShape): { headText: string; combinedOriginal: string } {
  const textParts = mcp.content
    .filter((part): part is McpTextPart => part?.type === 'text' && typeof (part as McpTextPart).text === 'string')
    .map((part) => part.text);
  const combined = textParts.join('\n');
  return { headText: textParts[0] ?? '', combinedOriginal: combined };
}

/**
 * Head/tail truncation with an explicit marker. The marker tells the model
 * this is a Talon artefact (not the tool's own output) and how to recover.
 */
function buildTruncatedText(
  fullText: string,
  cap: number,
  toolName: string,
  toolCallId: string,
): string {
  const total = fullText.length;
  // Budget for the actual content is cap minus the marker overhead — estimate
  // marker as ~300 chars and clamp so pathologically small caps still work.
  const markerBudget = 300;
  const contentBudget = Math.max(cap - markerBudget, Math.floor(cap * 0.5));
  const headChars = Math.floor(contentBudget * HEAD_RATIO);
  const tailChars = contentBudget - headChars;
  const head = fullText.slice(0, headChars);
  const tail = tailChars > 0 ? fullText.slice(-tailChars) : '';
  const omitted = total - head.length - tail.length;
  const marker = [
    '',
    `[... TRUNCATED BY TALON: ${omitted} chars omitted, ${total} total from tool '${toolName}'.`,
    `    Full output retained this run as toolCallId="${toolCallId}".`,
    `    Call fetch_tool_output(toolCallId="${toolCallId}", startChar=..., endChar=...) to read a specific range. ...]`,
    '',
  ].join('\n');
  return tail.length > 0 ? `${head}${marker}${tail}` : `${head}${marker}`;
}

/**
 * Heuristic: does this look like a tool error we should leave alone?
 *  - MCP `isError: true` is definitive.
 *  - Short strings/objects that mention "error"/"exception" are almost always
 *    error messages, and truncating them is more harmful than the tokens they
 *    cost.
 */
export function isLikelyError(value: unknown): boolean {
  if (isMcpShape(value) && value.isError === true) return true;
  const text = typeof value === 'string' ? value : stringifyForStorage(value);
  if (text.length > 2000) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('error:')
    || lower.includes('exception:')
    || lower.includes('traceback')
    || lower.startsWith('error ')
    || lower.startsWith('fatal:')
  );
}

function stringifyForStorage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeIndex(value: number | undefined, fallback: number, total: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > total) return total;
  return Math.floor(value);
}
