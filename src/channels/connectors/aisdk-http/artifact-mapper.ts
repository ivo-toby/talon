/**
 * Artifact mapper for the aisdk-http channel.
 *
 * Maps tool results to custom AI SDK data-stream chunks based on
 * the configured artifact mapping. Frontends can listen for these
 * via `useChat`'s `onData` callback.
 */

import { encodeStreamPart } from './stream-adapter.js';
import type { ArtifactMapping } from './aisdk-http-types.js';

/**
 * Given a tool name and its result, emit zero or more custom SSE data chunks
 * based on the configured artifact mapping.
 *
 * Custom chunks are emitted as `2:[{type, ...data}]` lines — the AI SDK
 * data-stream "data" part type.
 */
export function buildArtifactChunks(
  toolName: string,
  result: unknown,
  mapping: ArtifactMapping[],
): string[] {
  const entry = mapping.find((m) => m.toolName === toolName);
  if (!entry) return [];

  const payload = entry.wrapAs
    ? { type: entry.chunkType, [entry.wrapAs]: result }
    : { type: entry.chunkType, ...(typeof result === 'object' && result !== null ? result : { result }) };

  return [encodeStreamPart('2', [payload])];
}
