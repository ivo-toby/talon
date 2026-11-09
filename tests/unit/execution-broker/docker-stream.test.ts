import { describe, expect, it } from 'vitest';
import { demuxDockerStream } from '../../../src/execution-broker/docker-stream.js';

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('demuxDockerStream', () => {
  it('returns empty output for an empty buffer', () => {
    expect(demuxDockerStream(Buffer.alloc(0))._unsafeUnwrap()).toEqual({ stdout: '', stderr: '' });
  });

  it('splits interleaved stdout and stderr frames in order', () => {
    const buffer = Buffer.concat([frame(1, 'a'), frame(2, 'E1'), frame(1, 'b'), frame(2, 'E2')]);
    expect(demuxDockerStream(buffer)._unsafeUnwrap()).toEqual({ stdout: 'ab', stderr: 'E1E2' });
  });

  it('decodes a multi-byte character split across two frames of the same stream', () => {
    const euro = Buffer.from('€', 'utf8');
    const header = (size: number): Buffer => {
      const h = Buffer.alloc(8);
      h[0] = 1;
      h.writeUInt32BE(size, 4);
      return h;
    };
    const buffer = Buffer.concat([
      header(1),
      euro.subarray(0, 1),
      header(2),
      euro.subarray(1),
    ]);
    expect(demuxDockerStream(buffer)._unsafeUnwrap().stdout).toBe('€');
  });

  it('ignores stdin frames (stream type 0)', () => {
    const stdin = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]), Buffer.from('xx')]);
    const buffer = Buffer.concat([stdin, frame(1, 'ok')]);
    expect(demuxDockerStream(buffer)._unsafeUnwrap()).toEqual({ stdout: 'ok', stderr: '' });
  });

  it('rejects a truncated header', () => {
    const error = demuxDockerStream(Buffer.from([1, 0, 0]))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
  });

  it('rejects a frame whose declared size exceeds the remaining bytes, without echoing output', () => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(100, 4);
    const error = demuxDockerStream(Buffer.concat([header, Buffer.from('secret-output')]))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(error.message).not.toContain('secret-output');
  });

  it('rejects an unknown stream type', () => {
    const header = Buffer.alloc(8);
    header[0] = 9;
    expect(demuxDockerStream(header)._unsafeUnwrapErr().brokerCode).toBe('BACKEND_FAILURE');
  });
});
