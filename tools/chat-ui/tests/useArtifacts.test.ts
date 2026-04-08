import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArtifacts } from '../src/hooks/useArtifacts';

describe('useArtifacts', () => {
  it('returns empty array when data is empty', () => {
    const { result } = renderHook(() => useArtifacts([]));
    expect(result.current).toEqual([]);
  });

  it('filters data items by known artifact type prefixes', () => {
    const data = [
      { type: 'data-exo-output-artifact', jsonContent: { tree: [] } },
      { type: 'data-search-results', items: [{ id: '1' }] },
      { type: 'other-data' },
    ];
    const { result } = renderHook(() => useArtifacts(data as object[]));
    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toMatchObject({ type: 'data-exo-output-artifact' });
  });
});
