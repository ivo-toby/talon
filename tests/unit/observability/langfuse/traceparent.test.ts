import { describe, it, expect } from 'vitest';

import {
  parseTraceparent,
  serializeTraceparent,
} from '../../../../src/observability/langfuse/traceparent.js';

describe('traceparent helpers', () => {
  it('serializes and parses a span context round-trip', () => {
    const serialized = serializeTraceparent({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 0x01,
      isRemote: false,
    });

    expect(serialized).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(parseTraceparent(serialized)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 0x01,
      isRemote: true,
    });
  });

  it('returns null for malformed traceparents', () => {
    expect(parseTraceparent('not-a-traceparent')).toBeNull();
    expect(parseTraceparent('00-short-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-short-01')).toBeNull();
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    expect(serializeTraceparent(undefined)).toBeNull();
  });

  it('accepts non-00 traceparent versions', () => {
    expect(parseTraceparent('7f-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 0x01,
      isRemote: true,
    });
  });
});
