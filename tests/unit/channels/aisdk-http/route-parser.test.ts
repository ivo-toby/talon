import { describe, it, expect } from 'vitest';
import { parseRoute, matchRoute } from '../../../../src/channels/connectors/aisdk-http/route-parser.js';

describe('parseRoute', () => {
  it('converts pattern to regex and extracts param names', () => {
    const result = parseRoute('/agents/:agentId/stream');
    expect(result.paramNames).toEqual(['agentId']);
    expect(result.regex.test('/agents/exo-agent/stream')).toBe(true);
    expect(result.regex.test('/agents/exo-agent/other')).toBe(false);
  });

  it('handles multi-segment patterns with multiple params', () => {
    const result = parseRoute('/spaces/:spaceId/environments/:envId/ai/agents/:agentId/stream');
    expect(result.paramNames).toEqual(['spaceId', 'envId', 'agentId']);
    expect(result.regex.test('/spaces/abc123/environments/master/ai/agents/exo-agent/stream')).toBe(true);
  });

  it('handles patterns with no params', () => {
    const result = parseRoute('/chat/stream');
    expect(result.paramNames).toEqual([]);
    expect(result.regex.test('/chat/stream')).toBe(true);
    expect(result.regex.test('/chat/stream/extra')).toBe(false);
  });
});

describe('matchRoute', () => {
  it('returns null when URL does not match pattern', () => {
    const result = matchRoute('/agents/:agentId/stream', '/other/path');
    expect(result).toBeNull();
  });

  it('extracts named params from matching URL', () => {
    const result = matchRoute('/agents/:agentId/stream', '/agents/my-persona/stream');
    expect(result).toEqual({ agentId: 'my-persona' });
  });

  it('extracts multiple named params', () => {
    const result = matchRoute(
      '/spaces/:spaceId/environments/:envId/ai/agents/:agentId/stream',
      '/spaces/abc/environments/master/ai/agents/exo-agent/stream',
    );
    expect(result).toEqual({ spaceId: 'abc', envId: 'master', agentId: 'exo-agent' });
  });

  it('ignores query string when matching', () => {
    const result = matchRoute('/agents/:agentId/stream', '/agents/foo/stream?bar=baz');
    expect(result).toEqual({ agentId: 'foo' });
  });
});
