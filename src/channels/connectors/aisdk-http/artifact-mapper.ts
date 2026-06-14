/**
 * Artifact mapper for the aisdk-http channel.
 *
 * Maps tool results to custom AI SDK v5 data chunks based on
 * the configured artifact mapping. In v5, custom data is emitted
 * as SSE frames with a custom `type` field.
 */

import { encodeSSE } from './stream-adapter.js';
import type { ArtifactMapping } from './aisdk-http-types.js';

/**
 * Given a tool name and its result, emit zero or more custom SSE data frames
 * based on the configured artifact mapping.
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

  return [encodeSSE(payload)];
}
