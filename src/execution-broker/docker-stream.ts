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

    if (streamType !== STREAM_STDIN && streamType !== STREAM_STDOUT && streamType !== STREAM_STDERR) {
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
