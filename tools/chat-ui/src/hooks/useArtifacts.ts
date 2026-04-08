import { useMemo } from 'react';

export interface ArtifactChunk {
  type: string;
  [key: string]: unknown;
}

/**
 * Extract custom artifact chunks from the useChat `data` array.
 * Artifact chunks are identified by their `type` field starting with "data-".
 */
export function useArtifacts(data: object[]): ArtifactChunk[] {
  return useMemo(
    () =>
      data.filter(
        (item): item is ArtifactChunk =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          typeof (item as { type: unknown }).type === 'string' &&
          (item as { type: string }).type.startsWith('data-'),
      ),
    [data],
  );
}
