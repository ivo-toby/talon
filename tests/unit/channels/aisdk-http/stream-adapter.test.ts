import { describe, it, expect } from 'vitest';
import { encodeSSE, buildStart, buildStartStep, buildTextChunks, buildFinishChunks, buildDone, buildKeepAlive } from '../../../../src/channels/connectors/aisdk-http/stream-adapter.js';

describe('encodeSSE', () => {
  it('encodes a JSON object as an SSE data frame', () => {
    const line = encodeSSE({ type: 'text-delta', id: 'msg1', delta: 'Hello' });
    expect(line).toBe('data: {"type":"text-delta","id":"msg1","delta":"Hello"}\n\n');
  });

  it('encodes nested objects', () => {
    const line = encodeSSE({ type: 'finish', usage: { promptTokens: 10 } });
    expect(line).toBe('data: {"type":"finish","usage":{"promptTokens":10}}\n\n');
  });
});

describe('buildStart', () => {
  it('emits a start chunk with messageId', () => {
    const chunk = buildStart('msg-123');
    expect(chunk).toContain('"type":"start"');
    expect(chunk).toContain('"messageId":"msg-123"');
    expect(chunk).toMatch(/^data: .+\n\n$/);
  });
});

describe('buildStartStep', () => {
  it('emits a start-step chunk', () => {
    const chunk = buildStartStep();
    expect(chunk).toBe('data: {"type":"start-step"}\n\n');
  });
});

describe('buildTextChunks', () => {
  it('returns text-start, text-delta(s), and text-end for standard mode', () => {
    const chunks = buildTextChunks('Hello world', null, 'msg-1');
    expect(chunks.length).toBeGreaterThanOrEqual(3); // start + at least 1 delta + end
    expect(chunks[0]).toContain('"type":"text-start"');
    expect(chunks[0]).toContain('"id":"msg-1"');
    expect(chunks[chunks.length - 1]).toContain('"type":"text-end"');

    // Middle chunks are text-delta
    for (let i = 1; i < chunks.length - 1; i++) {
      expect(chunks[i]).toContain('"type":"text-delta"');
      expect(chunks[i]).toContain('"delta":');
    }
  });

  it('uses custom chunk type when textChunkType is set', () => {
    const chunks = buildTextChunks('Hi there', 'data-human-readable', 'msg-2');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('"type":"data-human-readable"');
    expect(chunks[0]).toContain('"data":"Hi there"');
  });
});

describe('buildFinishChunks', () => {
  it('returns finish-step and finish chunks', () => {
    const chunks = buildFinishChunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('"type":"finish-step"');
    expect(chunks[1]).toContain('"type":"finish"');
  });
});

describe('buildDone', () => {
  it('returns the v5 stream terminator', () => {
    expect(buildDone()).toBe('data: [DONE]\n\n');
  });
});

describe('buildKeepAlive', () => {
  it('returns a comment line (SSE keep-alive)', () => {
    const line = buildKeepAlive();
    expect(line).toBe(': keep-alive\n\n');
  });
});
