/**
 * Browser adapter for the small subset of GPT-Live data-channel events that
 * controls connection readiness. Raw provider payloads stay in this module;
 * the generic browser client consumes only the normalized readiness event.
 */

export type OpenAiLiveBrowserEvent =
  | { readonly kind: 'engine_ready' }
  | { readonly kind: 'ignored' };

const MAX_EVENT_BYTES = 256 * 1024;

/** Parse one untrusted data-channel payload without exposing its raw fields. */
export function parseOpenAiLiveEvent(data: unknown): OpenAiLiveBrowserEvent | null {
  if (typeof data !== 'string' || utf8ByteLength(data) > MAX_EVENT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
  return parsed.type === 'session.started' ? { kind: 'engine_ready' } : { kind: 'ignored' };
}

/** Stable predicate used by the browser readiness state machine. */
export function isOpenAiLiveReadyEvent(data: unknown): boolean {
  return parseOpenAiLiveEvent(data)?.kind === 'engine_ready';
}

export const parseOpenAILiveEvent = parseOpenAiLiveEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  // A browser without TextEncoder is unusual; keep the fallback conservative.
  return value.length * 4;
}
