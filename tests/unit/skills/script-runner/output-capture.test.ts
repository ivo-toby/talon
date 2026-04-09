import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutputCapture } from '@talon/skills/script-runner/output-capture.js';

// Mock fs to avoid real file I/O
vi.mock('node:fs', () => {
  const chunks: Buffer[] = [];
  const mockStream = {
    write: vi.fn((chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }),
    end: vi.fn((cb: (err: Error | null) => void) => cb(null)),
    on: vi.fn(),
  };
  return {
    createWriteStream: vi.fn(() => mockStream),
    __mockStream: mockStream,
    __chunks: chunks,
  };
});

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe('OutputCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures output under the limit', async () => {
    const capture = new OutputCapture(1024, '/tmp/artifacts', 'test.log');

    capture.onData(Buffer.from('hello '));
    capture.onData(Buffer.from('world'));

    const result = await capture.finalize();

    expect(result.content).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.artifactPath).toBeNull();
  });

  it('truncates output over the limit and creates artifact', async () => {
    const capture = new OutputCapture(10, '/tmp/artifacts', 'test.log');

    capture.onData(Buffer.from('12345'));
    capture.onData(Buffer.from('67890')); // fills to exactly 10
    capture.onData(Buffer.from('overflow')); // exceeds limit

    const result = await capture.finalize();

    expect(result.content).toBe('1234567890');
    expect(result.truncated).toBe(true);
    expect(result.artifactPath).toBe('/tmp/artifacts/test.log');
  });

  it('handles a single chunk that exceeds the limit', async () => {
    const capture = new OutputCapture(5, '/tmp/artifacts', 'test.log');

    capture.onData(Buffer.from('abcdefghij'));

    const result = await capture.finalize();

    expect(result.content).toBe('abcde');
    expect(result.truncated).toBe(true);
    expect(result.artifactPath).toBe('/tmp/artifacts/test.log');
  });

  it('finalize is idempotent', async () => {
    const capture = new OutputCapture(1024, '/tmp/artifacts', 'test.log');

    capture.onData(Buffer.from('data'));

    const result1 = await capture.finalize();
    const result2 = await capture.finalize();

    expect(result1).toBe(result2);
    expect(result1.content).toBe('data');
  });

  it('handles empty output', async () => {
    const capture = new OutputCapture(1024, '/tmp/artifacts', 'test.log');

    const result = await capture.finalize();

    expect(result.content).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.artifactPath).toBeNull();
  });

  it('ignores data after finalize', async () => {
    const capture = new OutputCapture(1024, '/tmp/artifacts', 'test.log');

    capture.onData(Buffer.from('before'));
    await capture.finalize();
    capture.onData(Buffer.from('after'));

    const result = await capture.finalize();

    expect(result.content).toBe('before');
  });
});
