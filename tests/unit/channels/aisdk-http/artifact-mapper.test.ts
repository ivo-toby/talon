import { describe, it, expect } from 'vitest';
import { buildArtifactChunks } from '../../../../src/channels/connectors/aisdk-http/artifact-mapper.js';
import type { ArtifactMapping } from '../../../../src/channels/connectors/aisdk-http/aisdk-http-types.js';

const mapping: ArtifactMapping[] = [
  { toolName: 'assemble_experience_tree', chunkType: 'data-exo-output-artifact', wrapAs: 'jsonContent' },
  { toolName: 'search_results', chunkType: 'data-search-results' },
];

describe('buildArtifactChunks', () => {
  it('returns empty array when tool name is not in mapping', () => {
    const chunks = buildArtifactChunks('unknown_tool', { foo: 'bar' }, mapping);
    expect(chunks).toHaveLength(0);
  });

  it('wraps result when wrapAs is set', () => {
    const chunks = buildArtifactChunks('assemble_experience_tree', { tree: [] }, mapping);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('"data-exo-output-artifact"');
    expect(chunks[0]).toContain('"jsonContent"');
    expect(chunks[0]).toContain('"tree"');
  });

  it('emits result as-is when wrapAs is absent', () => {
    const chunks = buildArtifactChunks('search_results', [{ id: '1' }], mapping);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('"data-search-results"');
    expect(chunks[0]).toContain('"id"');
  });
});
