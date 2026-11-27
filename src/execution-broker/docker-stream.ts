import { StringDecoder } from 'node:string_decoder';
import { err, ok, type Result } from 'neverthrow';

import { ExecutionBrokerError } from './errors.js';
import type { DemuxedOutput } from './docker-types.js';

/** Docker stream frame header: 1 stream-type byte, 3 zero bytes, uint32BE payload size. */
const HEADER_BYTES = 8;

const STREAM_STDIN = 0;
const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;

function backendFailure(detail: string): Result<DemuxedOutput, ExecutionBrokerError> {
  return err(new ExecutionBrokerError('BACKEND_FAILURE', detail));
}

/**
 * Demux Docker's multiplexed exec stream (the non-TTY encoding).
 *
 * One `StringDecoder` per stream is retained across the whole buffer so a
 * multi-byte character split across frame boundaries is not mangled. Stdin
 * frames are ignored: this stream is read-only output.
 */
export function demuxDockerStream(buffer: Buffer): Result<DemuxedOutput, ExecutionBrokerError> {
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];

  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    if (remaining < HEADER_BYTES) {
      return backendFailure('docker stream ended with a truncated frame header');
    }

    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);

    if (
      streamType !== STREAM_STDIN &&
      streamType !== STREAM_STDOUT &&
      streamType !== STREAM_STDERR
    ) {
      return backendFailure('docker stream contained an unknown stream type');
    }
    if (size > remaining - HEADER_BYTES) {
      return backendFailure('docker stream frame is longer than the remaining bytes');
    }

    const payload = buffer.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + size);
    if (streamType === STREAM_STDOUT) {
      stdoutParts.push(stdoutDecoder.write(payload));
    } else if (streamType === STREAM_STDERR) {
      stderrParts.push(stderrDecoder.write(payload));
    }

    offset += HEADER_BYTES + size;
  }

  stdoutParts.push(stdoutDecoder.end());
  stderrParts.push(stderrDecoder.end());

  return ok({ stdout: stdoutParts.join(''), stderr: stderrParts.join('') });
}

export interface DemuxFrame {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface DockerDemuxer {
  /** Feed the next chunk; returns the frames completed by it, in order. */
  push(chunk: Buffer): Result<DemuxFrame[], ExecutionBrokerError>;
  /** Signal end of stream; fails if a frame is incomplete, else flushes decoders. */
  end(): Result<DemuxFrame[], ExecutionBrokerError>;
}

function demuxFailure(detail: string): Result<DemuxFrame[], ExecutionBrokerError> {
  return err(new ExecutionBrokerError('BACKEND_FAILURE', detail));
}

/**
 * Incremental variant of `demuxDockerStream`: accepts chunks as they arrive.
 *
 * A frame is emitted once its whole payload has arrived. One `StringDecoder`
 * per stream spans frames so a multi-byte character split across frames is
 * not mangled; frames whose decoded text is empty (stdin, zero-size, or a
 * lone partial character) are not emitted. Once a push has failed the demuxer
 * stays failed.
 */
export function createDockerDemuxer(): DockerDemuxer {
  const decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  let carry: Buffer = Buffer.alloc(0);
  let failed = false;

  return {
    push(chunk: Buffer): Result<DemuxFrame[], ExecutionBrokerError> {
      if (failed) {
        return demuxFailure('docker stream demuxer is in a failed state');
      }
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const frames: DemuxFrame[] = [];
      let offset = 0;

      while (carry.length - offset >= HEADER_BYTES) {
        const streamType = carry[offset];
        if (
          streamType !== STREAM_STDIN &&
          streamType !== STREAM_STDOUT &&
          streamType !== STREAM_STDERR
        ) {
          failed = true;
          return demuxFailure('docker stream contained an unknown stream type');
        }
        const size = carry.readUInt32BE(offset + 4);
        if (carry.length - offset - HEADER_BYTES < size) {
          break;
        }
        const start = offset + HEADER_BYTES;
        const payload = carry.subarray(start, start + size);
        offset = start + size;

        if (streamType === STREAM_STDIN) {
          continue;
        }
        const stream = streamType === STREAM_STDOUT ? 'stdout' : 'stderr';
        const text = decoders[stream].write(payload);
        if (text.length > 0) {
          frames.push({ stream, text });
        }
      }

      carry = Buffer.from(carry.subarray(offset));
      return ok(frames);
    },

    end(): Result<DemuxFrame[], ExecutionBrokerError> {
      if (failed) {
        return demuxFailure('docker stream demuxer is in a failed state');
      }
      if (carry.length > 0) {
        failed = true;
        return demuxFailure(
          carry.length < HEADER_BYTES
            ? 'docker stream ended with a truncated frame header'
            : 'docker stream ended with a truncated frame payload',
        );
      }
      const frames: DemuxFrame[] = [];
      for (const stream of ['stdout', 'stderr'] as const) {
        const text = decoders[stream].end();
        if (text.length > 0) {
          frames.push({ stream, text });
        }
      }
      return ok(frames);
    },
  };
}
