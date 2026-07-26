import { err, ok, type Result } from 'neverthrow';

import { parseTraceparent } from '../observability/langfuse/traceparent.js';
import { LifecycleError } from '../core/errors/index.js';

export interface TraceEvidenceQuery {
  readonly correlationId: string;
  readonly eventId?: string;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
}

export interface TraceEvidenceReference {
  readonly type: string;
  readonly id: string;
}

export interface TraceEvidence {
  readonly traceparent?: string;
  readonly source: string;
  readonly references?: readonly TraceEvidenceReference[];
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TraceEvidenceProvider {
  findEvidence(query: TraceEvidenceQuery): Result<TraceEvidence | null, LifecycleError>;
}

const MAX_TRACE_EVIDENCE_STRING = 256;
const MAX_TRACE_EVIDENCE_REFERENCES = 8;
const MAX_TRACE_EVIDENCE_METADATA_KEYS = 16;

function boundedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TRACE_EVIDENCE_STRING
    ? value
    : undefined;
}

function boundedMetadata(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_TRACE_EVIDENCE_METADATA_KEYS || keys.some((key) => typeof key !== 'string')) {
    return undefined;
  }
  const stringKeys = keys as string[];
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
    const item: unknown = descriptor.value;
    if (
      item !== null &&
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean'
    ) {
      return undefined;
    }
    if (typeof item === 'string' && item.length > MAX_TRACE_EVIDENCE_STRING) return undefined;
    result[key] = item;
  }
  return Object.freeze(result);
}

function boundedReferences(value: unknown): readonly TraceEvidenceReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TRACE_EVIDENCE_REFERENCES) return undefined;
  const references: TraceEvidenceReference[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const type = boundedString(Object.getOwnPropertyDescriptor(item, 'type')?.value);
    const id = boundedString(Object.getOwnPropertyDescriptor(item, 'id')?.value);
    if (!type || !id) return undefined;
    references.push(Object.freeze({ type, id }));
  }
  return Object.freeze(references);
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
}

export function normalizeTraceEvidence(value: unknown): TraceEvidence | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const traceparentValue = ownValue(value, 'traceparent');
  const source = boundedString(ownValue(value, 'source'));
  if (!source) return null;
  const traceparent =
    typeof traceparentValue === 'string' && parseTraceparent(traceparentValue)
      ? traceparentValue.trim().toLowerCase()
      : undefined;
  const references = boundedReferences(ownValue(value, 'references'));
  const metadataValue = ownValue(value, 'metadata');
  const metadata = metadataValue === undefined ? undefined : boundedMetadata(metadataValue);
  if (references === undefined && Object.hasOwn(value, 'references')) return null;
  if (metadata === undefined && metadataValue !== undefined) return null;

  return Object.freeze({
    ...(traceparent ? { traceparent } : {}),
    source,
    ...(references ? { references } : {}),
    ...(metadata ? { metadata } : {}),
  });
}

export class NoopTraceEvidenceProvider implements TraceEvidenceProvider {
  findEvidence(_query: TraceEvidenceQuery): Result<TraceEvidence | null, LifecycleError> {
    return ok(null);
  }
}

export function safeFindTraceEvidence(
  provider: TraceEvidenceProvider,
  query: TraceEvidenceQuery,
): Result<TraceEvidence | null, LifecycleError> {
  try {
    const evidence = provider.findEvidence(query);
    if (evidence.isErr()) return err(evidence.error);
    return ok(normalizeTraceEvidence(evidence.value));
  } catch {
    return err(new LifecycleError('failed to resolve lifecycle trace evidence'));
  }
}
