/** Bounded, descriptor-only lifecycle transport guards before SQLite sees caller data. */

import { types } from 'node:util';
import {
  isBoundedUnicodeScalarsUtf8,
  isBoundedWellFormedUtf8,
} from '../../../lifecycle/contracts/common.js';

export { isBoundedUnicodeScalarsUtf8, isBoundedWellFormedUtf8 };

const MAX_REFERENCES = 32;
const MAX_METADATA_ENTRIES = 32;
const MAX_DELIVERIES = 32;

type DataRecord = Record<string, unknown>;

/** Rejects lone UTF-16 surrogate code units without normalizing a string. */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedString(value: unknown, maxCodeUnits: number, maxBytes: number): string | null {
  if (typeof value !== 'string' || value.length > maxCodeUnits) return null;
  if (!isBoundedWellFormedUtf8(value, maxCodeUnits, maxBytes)) return null;
  // This scan intentionally happens only after the bounded UTF-16/UTF-8 pass.
  return value.indexOf('\0') === -1 ? value : null;
}

/**
 * Materializes at most maxKeys descriptors after a single own-key boundary.
 * In particular, never use Object.getOwnPropertyDescriptors here: that builds
 * one descriptor object for every hostile property before a size check can run.
 */
export function snapshotBoundedPlainDataRecord(value: unknown, maxKeys: number): DataRecord | null {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return null;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maxKeys || keys.some((key) => typeof key !== 'string')) return null;
    const snapshot: DataRecord = Object.create(null) as DataRecord;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      // defineProperty preserves a legitimate "__proto__" data key without
      // invoking Object.prototype's legacy setter.
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** Reads a bounded plain object without executing accessors, iteration, or proxy traps. */
function readRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): DataRecord | null {
  const allowed = new Set([...required, ...optional]);
  const record = snapshotBoundedPlainDataRecord(value, allowed.size);
  if (!record) return null;
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key))) return null;
  const snapshot: DataRecord = Object.create(null) as DataRecord;
  for (const key of required) {
    if (!Object.hasOwn(record, key)) return null;
    Object.defineProperty(snapshot, key, {
      value: record[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const key of optional) {
    if (Object.hasOwn(record, key)) {
      Object.defineProperty(snapshot, key, {
        value: record[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return snapshot;
}

/** Reads a bounded dense native array without consulting iterators or prototypes. */
function readArray(value: unknown, maxLength: number): unknown[] | null {
  if (!Array.isArray(value) || types.isProxy(value)) return null;
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) return null;
    if (length.value > maxLength) return null;
    const keys = Reflect.ownKeys(value);
    // A dense array has exactly its bounded indices plus the non-enumerable
    // length descriptor. Check this before looking up any element descriptor.
    if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== 'string'))
      return null;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      snapshot.push(descriptor.value);
    }
    // Dense arrays have exactly one enumerable own data descriptor per index.
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotReference(value: unknown): DataRecord | null {
  const record = readRecord(value, ['type', 'id']);
  if (!record) return null;
  const type = boundedString(record.type, 128, 512);
  const id = boundedString(record.id, 256, 1024);
  return type === null || id === null ? null : { type, id };
}

function snapshotReferences(value: unknown): DataRecord[] | null {
  const items = readArray(value, MAX_REFERENCES);
  if (!items) return null;
  const snapshots: DataRecord[] = [];
  for (const item of items) {
    const snapshot = snapshotReference(item);
    if (!snapshot) return null;
    snapshots.push(snapshot);
  }
  return snapshots;
}

function snapshotMetadata(value: unknown): DataRecord | null {
  const record = snapshotBoundedPlainDataRecord(value, MAX_METADATA_ENTRIES);
  if (!record) return null;
  const snapshot: DataRecord = Object.create(null) as DataRecord;
  const normalizedKeys = new Set<string>();
  for (const key of Object.keys(record)) {
    // Never normalize or trim an unbounded key.
    if (boundedString(key, 128, 512) === null || key.trim() !== key) return null;
    const normalized = key.normalize('NFKC');
    if (normalizedKeys.has(normalized)) return null;
    normalizedKeys.add(normalized);
    const item: unknown = record[key];
    if (typeof item === 'string') {
      if (boundedString(item, 1024, 4096) === null) return null;
    } else if (
      item !== null &&
      (typeof item !== 'number' || !Number.isFinite(item)) &&
      typeof item !== 'boolean'
    ) {
      return null;
    }
    Object.defineProperty(snapshot, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function snapshotProvenance(value: unknown): DataRecord | null {
  const record = readRecord(value, ['source'], ['sourceEventIds', 'sourceReferences']);
  if (!record) return null;
  const source = boundedString(record.source, 128, 512);
  const sourceEventIds =
    record.sourceEventIds === undefined ? [] : readArray(record.sourceEventIds, MAX_REFERENCES);
  const sourceReferences =
    record.sourceReferences === undefined ? [] : snapshotReferences(record.sourceReferences);
  if (source === null || !sourceEventIds || !sourceReferences) return null;
  const ids: string[] = [];
  for (const id of sourceEventIds) {
    const snapshot = boundedString(id, 256, 1024);
    if (snapshot === null) return null;
    ids.push(snapshot);
  }
  return { source, sourceEventIds: ids, sourceReferences };
}

/** Returns a contract-owned, finite plain-data event snapshot or null. */
export function snapshotLifecycleEvent(value: unknown): DataRecord | null {
  const event = readRecord(value, [
    'version',
    'eventId',
    'type',
    'occurredAt',
    'context',
    'payload',
  ]);
  if (!event) return null;
  const context = readRecord(
    event.context,
    ['aggregate', 'correlationId', 'recursion', 'provenance'],
    ['causationId'],
  );
  const aggregate = context && readRecord(context.aggregate, ['type', 'id']);
  const recursion = context && readRecord(context.recursion, ['depth', 'maxDepth']);
  const provenance = context && snapshotProvenance(context.provenance);
  const payload = readRecord(event.payload, [], ['references', 'metadata']);
  const references =
    payload && (payload.references === undefined ? [] : snapshotReferences(payload.references));
  const metadata =
    payload && (payload.metadata === undefined ? {} : snapshotMetadata(payload.metadata));
  const eventId = boundedString(event.eventId, 256, 1024);
  const type = boundedString(event.type, 128, 512);
  const occurredAt = boundedString(event.occurredAt, 64, 256);
  const correlationId = context && boundedString(context.correlationId, 256, 1024);
  const causationId =
    context?.causationId === undefined ? undefined : boundedString(context.causationId, 256, 1024);
  const aggregateType = aggregate && boundedString(aggregate.type, 128, 512);
  const aggregateId = aggregate && boundedString(aggregate.id, 256, 1024);
  if (
    event.version !== 'v1' ||
    eventId === null ||
    type === null ||
    occurredAt === null ||
    !context ||
    !aggregate ||
    !recursion ||
    !provenance ||
    !payload ||
    !references ||
    !metadata ||
    correlationId === null ||
    (context.causationId !== undefined && causationId === null) ||
    aggregateType === null ||
    aggregateId === null ||
    typeof recursion.depth !== 'number' ||
    typeof recursion.maxDepth !== 'number'
  )
    return null;
  return {
    version: 'v1',
    eventId,
    type,
    occurredAt,
    context: {
      aggregate: { type: aggregateType, id: aggregateId },
      correlationId,
      ...(causationId === undefined ? {} : { causationId }),
      recursion: { depth: recursion.depth, maxDepth: recursion.maxDepth },
      provenance,
    },
    payload: { references, metadata },
  };
}

function snapshotIdentity(value: unknown): DataRecord | null {
  const record = readRecord(
    value,
    [
      'version',
      'handlerId',
      'runtimeKind',
      'implementationRef',
      'implementationVersion',
      'mode',
      'inputContract',
      'outputContract',
    ],
    ['interceptorSafety'],
  );
  if (!record) return null;
  for (const [key, units, bytes] of [
    ['handlerId', 128, 512],
    ['runtimeKind', 16, 64],
    ['implementationRef', 128, 512],
    ['implementationVersion', 256, 1024],
    ['mode', 16, 64],
    ['inputContract', 128, 512],
    ['outputContract', 128, 512],
  ] as const)
    if (boundedString(record[key], units, bytes) === null) return null;
  if (
    record.version !== 'v1' ||
    (record.interceptorSafety !== undefined &&
      boundedString(record.interceptorSafety, 16, 64) === null)
  )
    return null;
  return { ...record };
}

function snapshotFailurePolicy(value: unknown): DataRecord | null {
  const record = readRecord(value, ['version', 'mode']);
  return record && record.version === 'v1' && boundedString(record.mode, 32, 128) !== null
    ? { ...record }
    : null;
}

/** Snapshots a public failure diagnostic without allowing Zod to touch accessors. */
export function snapshotLifecycleFailureDiagnostic(value: unknown): DataRecord | null {
  const record = readRecord(value, ['code']);
  const code = record && boundedString(record.code, 128, 512);
  return code === null ? null : { code };
}

/** Security authority matrix for persisted handler identities. */
export function hasDurableHandlerIdentityAuthority(value: {
  mode: string;
  runtimeKind: string;
  inputContract: string;
  outputContract: string;
  interceptorSafety?: string;
}): boolean {
  if (value.mode === 'event') {
    return (
      value.inputContract === 'talon.lifecycle.event.envelope.v1' &&
      value.outputContract === 'talon.lifecycle.signal.envelopes.v1' &&
      value.interceptorSafety === undefined
    );
  }
  if (value.mode === 'signal') {
    return (
      value.inputContract === 'talon.lifecycle.signal.envelope.v1' &&
      value.outputContract === 'talon.lifecycle.signal.envelopes.v1' &&
      value.interceptorSafety === undefined
    );
  }
  if (
    value.mode !== 'interceptor' ||
    value.inputContract !== 'talon.lifecycle.interceptor.input.v1'
  ) {
    return false;
  }
  if (value.interceptorSafety === 'enforcing') {
    return (
      value.runtimeKind === 'native' &&
      value.outputContract === 'talon.lifecycle.enforcing.interceptor.output.v1'
    );
  }
  return (
    (value.interceptorSafety === undefined || value.interceptorSafety === 'advisory') &&
    value.outputContract === 'talon.lifecycle.advisory.interceptor.output.v1'
  );
}

/** Frozen TASK-001 matrix binding a durable handler identity to its failure policy. */
export function hasCompatibleLifecycleFailurePolicy(
  identity: {
    mode: string;
    runtimeKind: string;
    inputContract: string;
    outputContract: string;
    interceptorSafety?: string;
  },
  failurePolicy: { mode: string },
): boolean {
  if (!hasDurableHandlerIdentityAuthority(identity)) return false;
  if (identity.mode === 'event' || identity.mode === 'signal') {
    return failurePolicy.mode === 'dead_letter' || failurePolicy.mode === 'preserve_session';
  }
  return identity.interceptorSafety === 'enforcing'
    ? failurePolicy.mode === 'fail_closed'
    : failurePolicy.mode === 'fail_open';
}

/** Returns bounded plain-data fan-out snapshots or null without iterating caller data. */
export function snapshotLifecycleDeliveries(value: unknown): DataRecord[] | null {
  const deliveries = readArray(value, MAX_DELIVERIES);
  if (!deliveries) return null;
  const snapshots: DataRecord[] = [];
  for (const candidate of deliveries) {
    const delivery = readRecord(
      candidate,
      ['handlerId', 'persona', 'priority', 'identity', 'failurePolicy'],
      ['maxAttempts'],
    );
    if (!delivery) return null;
    const handlerId = boundedString(delivery.handlerId, 128, 512);
    // Persona persistence intentionally permits 256 Unicode scalar values;
    // the UTF-16 bound is therefore twice that count while UTF-8 remains 1KiB.
    const persona =
      typeof delivery.persona === 'string' &&
      delivery.persona.indexOf('\0') === -1 &&
      isBoundedUnicodeScalarsUtf8(delivery.persona, 256, 1024)
        ? delivery.persona
        : null;
    const identity = snapshotIdentity(delivery.identity);
    const failurePolicy = snapshotFailurePolicy(delivery.failurePolicy);
    if (
      handlerId === null ||
      persona === null ||
      !identity ||
      !failurePolicy ||
      typeof delivery.priority !== 'number' ||
      (delivery.maxAttempts !== undefined && typeof delivery.maxAttempts !== 'number')
    )
      return null;
    snapshots.push({
      handlerId,
      persona,
      priority: delivery.priority,
      identity,
      failurePolicy,
      ...(delivery.maxAttempts === undefined ? {} : { maxAttempts: delivery.maxAttempts }),
    });
  }
  return snapshots;
}
