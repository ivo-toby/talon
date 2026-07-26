import type { SpanContext } from '@opentelemetry/api';
import { TraceFlags } from '@opentelemetry/api';

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function isAllZero(value: string): boolean {
  return /^0+$/.test(value);
}

export function parseTraceparent(value: string | null | undefined): SpanContext | null {
  if (!value) {
    return null;
  }

  const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase());
  if (!match) {
    return null;
  }

  const [, version, traceId, spanId, flags] = match;
  if (version === 'ff') {
    return null;
  }
  if (isAllZero(traceId) || isAllZero(spanId)) {
    return null;
  }

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  };
}

export function serializeTraceparent(spanContext: SpanContext | null | undefined): string | null {
  if (!spanContext) {
    return null;
  }

  const traceId = spanContext.traceId.toLowerCase();
  const spanId = spanContext.spanId.toLowerCase();
  if (
    !/^[0-9a-f]{32}$/.test(traceId) ||
    !/^[0-9a-f]{16}$/.test(spanId) ||
    isAllZero(traceId) ||
    isAllZero(spanId)
  ) {
    return null;
  }

  const traceFlags = (spanContext.traceFlags ?? TraceFlags.NONE)
    .toString(16)
    .padStart(2, '0')
    .slice(-2);

  return `00-${traceId}-${spanId}-${traceFlags}`;
}
