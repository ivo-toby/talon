import { describe, it, expect } from 'vitest';
import { encodeStreamPart, buildTextChunks, buildFinishChunks, buildKeepAlive } from '../../../../src/channels/connectors/aisdk-http/stream-adapter.js';

describe('encodeStreamPart', () => {
  it('encodes a text-delta chunk', () => {
    const line = encodeStreamPart('0', 'Hello world');
    expect(line).toBe('0:"Hello world"\n');
  });

  it('encodes a data chunk (array)', () => {
    const line = encodeStreamPart('2', [{ type: 'test' }]);
    expect(line).toBe('2:[{"type":"test"}]\n');
  });

  it('encodes a finish-message chunk', () => {
    const line = encodeStreamPart('d', { finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } });
    expect(line).toBe('d:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":5}}\n');
  });
});

describe('buildTextChunks', () => {
  it('returns array of encoded text-delta lines for word tokens', () => {
    const chunks = buildTextChunks('Hello world', null);
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach(c => expect(c).toMatch(/^0:".+"\n$/));
  });

  it('uses custom chunk type when textChunkType is set', () => {
    const chunks = buildTextChunks('Hi', 'data-human-readable');
    expect(chunks[0]).toMatch(/^data-human-readable:/);
  });
});

describe('buildFinishChunks', () => {
  it('returns finish-step and finish-message lines', () => {
    const chunks = buildFinishChunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('"finishReason":"stop"');
    expect(chunks[0]).toContain('"isContinued":false');
    expect(chunks[1]).toContain('"finishReason":"stop"');
  });
});

describe('buildKeepAlive', () => {
  it('returns a comment line (SSE keep-alive)', () => {
    const line = buildKeepAlive();
    expect(line).toBe(': keep-alive\n\n');
  });
});
