import { describe, it, expect } from 'vitest';
import {
  MCP_CHILD_MARKER_ENV,
  stampMcpChildMarker,
} from '../../../src/providers/mcp-child-marker.js';

describe('stampMcpChildMarker', () => {
  it('exposes the canonical env var name', () => {
    expect(MCP_CHILD_MARKER_ENV).toBe('TALON_MCP_CHILD');
  });

  it('adds the marker to an undefined env', () => {
    expect(stampMcpChildMarker(undefined)).toEqual({ TALON_MCP_CHILD: '1' });
  });

  it('adds the marker to an empty env', () => {
    expect(stampMcpChildMarker({})).toEqual({ TALON_MCP_CHILD: '1' });
  });

  it('preserves existing env entries', () => {
    expect(stampMcpChildMarker({ FOO: 'bar', BAZ: 'qux' })).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
      TALON_MCP_CHILD: '1',
    });
  });

  it('overrides any pre-existing marker value', () => {
    expect(stampMcpChildMarker({ TALON_MCP_CHILD: '0' })).toEqual({
      TALON_MCP_CHILD: '1',
    });
  });

  it('returns a new object — does not mutate the input', () => {
    const input = { FOO: 'bar' };
    const result = stampMcpChildMarker(input);
    expect(input).toEqual({ FOO: 'bar' });
    expect(result).not.toBe(input);
  });
});
