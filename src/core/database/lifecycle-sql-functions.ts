/** Exact, fail-closed lifecycle JSON validators registered on every SQLite connection. */

import type Database from 'better-sqlite3';
import {
  hasCompatibleLifecycleFailurePolicy,
  isBoundedUnicodeScalarsUtf8,
  isBoundedWellFormedUtf8,
} from './repositories/lifecycle-persistence-validation.js';

const identifier = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const retentionMutationAuthorizationDepth = new WeakMap<Database.Database, number>();

function text(value: unknown, units: number, bytes: number): value is string {
  return (
    typeof value === 'string' &&
    isBoundedWellFormedUtf8(value, units, bytes) &&
    value.indexOf('\0') === -1
  );
}

function runtimeId(value: unknown): value is string {
  return text(value, 256, 1024) && value.length > 0 && value.trim() === value;
}

function lifecycleIdentifier(value: unknown): value is string {
  return text(value, 128, 512) && identifier.test(value);
}

function runtimeName(value: unknown): value is string {
  if (!text(value, 128, 512) || value.length === 0 || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const point = value.codePointAt(index)!;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) return false;
    if (point > 0xffff) index += 1;
  }
  return true;
}

function displayName(value: unknown): value is string {
  return text(value, 256, 1024) && value.length > 0 && value.trim() === value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Walks raw JSON before JSON.parse can collapse duplicate object member names. */
function hasDuplicateJsonKeys(raw: string): boolean {
  let cursor = 0;
  const whitespace = (): void => {
    while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
  };
  const string = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < raw.length) {
      const char = raw[cursor] ?? '';
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      cursor += 1;
      if (char === '"') return JSON.parse(raw.slice(start, cursor)) as string;
    }
    throw new Error('unterminated JSON string');
  };
  const primitive = (): void => {
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      raw.slice(cursor),
    );
    if (!match) throw new Error('invalid JSON primitive');
    cursor += match[0].length;
  };
  const value = (): void => {
    whitespace();
    const token = raw[cursor];
    if (token === '"') {
      string();
      return;
    }
    if (token === '[') {
      cursor += 1;
      whitespace();
      if (raw[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (true) {
        value();
        whitespace();
        if (raw[cursor] === ']') {
          cursor += 1;
          return;
        }
        if (raw[cursor++] !== ',') throw new Error('invalid array');
      }
    }
    if (token === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (raw[cursor] === '}') {
        cursor += 1;
        return;
      }
      while (true) {
        whitespace();
        if (raw[cursor] !== '"') throw new Error('invalid object key');
        const key = string();
        if (keys.has(key)) throw new Error('duplicate JSON key');
        keys.add(key);
        whitespace();
        if (raw[cursor++] !== ':') throw new Error('invalid object');
        value();
        whitespace();
        if (raw[cursor] === '}') {
          cursor += 1;
          return;
        }
        if (raw[cursor++] !== ',') throw new Error('invalid object');
      }
    }
    primitive();
  };
  try {
    value();
    whitespace();
    return cursor !== raw.length;
  } catch {
    return true;
  }
}

function parseJson(raw: unknown, maxBytes: number): unknown {
  if (typeof raw !== 'string' || raw.length > maxBytes || Buffer.byteLength(raw, 'utf8') > maxBytes)
    return null;
  try {
    if (hasDuplicateJsonKeys(raw)) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function reference(value: unknown): boolean {
  return exactKeys(value, ['type', 'id']) && lifecycleIdentifier(value.type) && runtimeId(value.id);
}

function references(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 32 && value.every(reference);
}

function metadata(value: unknown): boolean {
  if (!plainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 32) return false;
  const normalized = new Set<string>();
  for (const [key, item] of entries) {
    if (!text(key, 128, 512) || key.length === 0 || key.trim() !== key) return false;
    const normalizedKey = key.normalize('NFKC');
    if (normalized.has(normalizedKey)) return false;
    normalized.add(normalizedKey);
    if (typeof item === 'string') {
      if (!text(item, 1024, 4096)) return false;
    } else if (
      item !== null &&
      typeof item !== 'boolean' &&
      (typeof item !== 'number' || !Number.isFinite(item))
    )
      return false;
  }
  return true;
}

export function validPayload(raw: unknown): boolean {
  const value = parseJson(raw, 262_144);
  return (
    exactKeys(value, ['references', 'metadata']) &&
    references(value.references) &&
    metadata(value.metadata)
  );
}

export function validProvenance(raw: unknown): boolean {
  const value = parseJson(raw, 131_072);
  return (
    exactKeys(value, ['source', 'sourceEventIds', 'sourceReferences']) &&
    lifecycleIdentifier(value.source) &&
    Array.isArray(value.sourceEventIds) &&
    value.sourceEventIds.length <= 32 &&
    value.sourceEventIds.every(runtimeId) &&
    references(value.sourceReferences)
  );
}

export function validIdentity(raw: unknown, handlerId: unknown): boolean {
  const value = parseJson(raw, 8192);
  if (!plainObject(value)) return false;
  const allowed = [
    'version',
    'handlerId',
    'runtimeKind',
    'implementationRef',
    'implementationVersion',
    'mode',
    'inputContract',
    'outputContract',
    'interceptorSafety',
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    (!Object.hasOwn(value, 'interceptorSafety') && Object.keys(value).length !== 8) ||
    (Object.hasOwn(value, 'interceptorSafety') && Object.keys(value).length !== 9)
  )
    return false;
  if (
    value.version !== 'v1' ||
    value.handlerId !== handlerId ||
    !lifecycleIdentifier(value.handlerId) ||
    (value.runtimeKind !== 'native' && value.runtimeKind !== 'subagent') ||
    !runtimeName(value.implementationRef) ||
    !displayName(value.implementationVersion) ||
    !text(value.mode, 16, 64) ||
    !text(value.inputContract, 128, 512) ||
    !text(value.outputContract, 128, 512)
  )
    return false;
  if (value.mode === 'event')
    return (
      value.inputContract === 'talon.lifecycle.event.envelope.v1' &&
      value.outputContract === 'talon.lifecycle.signal.envelopes.v1' &&
      !Object.hasOwn(value, 'interceptorSafety')
    );
  if (value.mode === 'signal')
    return (
      value.inputContract === 'talon.lifecycle.signal.envelope.v1' &&
      value.outputContract === 'talon.lifecycle.signal.envelopes.v1' &&
      !Object.hasOwn(value, 'interceptorSafety')
    );
  if (
    value.mode !== 'interceptor' ||
    value.inputContract !== 'talon.lifecycle.interceptor.input.v1'
  )
    return false;
  if (value.interceptorSafety === 'enforcing')
    return (
      value.runtimeKind === 'native' &&
      value.outputContract === 'talon.lifecycle.enforcing.interceptor.output.v1'
    );
  return (
    (value.interceptorSafety === undefined || value.interceptorSafety === 'advisory') &&
    value.outputContract === 'talon.lifecycle.advisory.interceptor.output.v1'
  );
}

export function validFailurePolicy(raw: unknown): boolean {
  const value = parseJson(raw, 1024);
  return (
    exactKeys(value, ['version', 'mode']) &&
    value.version === 'v1' &&
    (value.mode === 'fail_closed' ||
      value.mode === 'fail_open' ||
      value.mode === 'dead_letter' ||
      value.mode === 'preserve_session')
  );
}

/** Validates the identity/policy pair as one durable authority boundary. */
export function validDeliveryContract(
  identityRaw: unknown,
  failurePolicyRaw: unknown,
  handlerId: unknown,
): boolean {
  if (!validIdentity(identityRaw, handlerId) || !validFailurePolicy(failurePolicyRaw)) return false;
  const identity = parseJson(identityRaw, 8192);
  const failurePolicy = parseJson(failurePolicyRaw, 1024);
  if (!plainObject(identity) || !plainObject(failurePolicy)) return false;
  return hasCompatibleLifecycleFailurePolicy(
    identity as {
      mode: string;
      runtimeKind: string;
      inputContract: string;
      outputContract: string;
      interceptorSafety?: string;
    },
    failurePolicy as { mode: string },
  );
}

export function validDiagnostic(raw: unknown): boolean {
  const value = parseJson(raw, 1024);
  return exactKeys(value, ['code']) && lifecycleIdentifier(value.code);
}

function validPersona(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.indexOf('\0') === -1 &&
    value.length > 0 &&
    isBoundedUnicodeScalarsUtf8(value, 256, 1024)
  );
}

export function withLifecycleRetentionMutationAuthorization<T>(
  db: Database.Database,
  operation: () => T,
): T {
  const previous = retentionMutationAuthorizationDepth.get(db) ?? 0;
  retentionMutationAuthorizationDepth.set(db, previous + 1);
  try {
    return operation();
  } finally {
    if (previous === 0) {
      retentionMutationAuthorizationDepth.delete(db);
    } else {
      retentionMutationAuthorizationDepth.set(db, previous);
    }
  }
}

/** Registers validators before migrations and on normal application connections. */
export function registerLifecycleSqlFunctions(db: Database.Database): void {
  db.function(
    'lifecycle_json_valid_provenance',
    { deterministic: true },
    (value: unknown): number => (validProvenance(value) ? 1 : 0),
  );
  db.function('lifecycle_json_valid_payload', { deterministic: true }, (value: unknown): number =>
    validPayload(value) ? 1 : 0,
  );
  db.function(
    'lifecycle_json_valid_handler_identity',
    { deterministic: true },
    (value: unknown, handlerId: unknown): number => (validIdentity(value, handlerId) ? 1 : 0),
  );
  db.function(
    'lifecycle_json_valid_failure_policy',
    { deterministic: true },
    (value: unknown): number => (validFailurePolicy(value) ? 1 : 0),
  );
  db.function(
    'lifecycle_json_valid_delivery_contract',
    { deterministic: true },
    (identity: unknown, failurePolicy: unknown, handlerId: unknown): number =>
      validDeliveryContract(identity, failurePolicy, handlerId) ? 1 : 0,
  );
  db.function(
    'lifecycle_json_valid_diagnostic',
    { deterministic: true },
    (value: unknown): number => (validDiagnostic(value) ? 1 : 0),
  );
  db.function('lifecycle_runtime_id_valid', { deterministic: true }, (value: unknown): number =>
    runtimeId(value) ? 1 : 0,
  );
  db.function('lifecycle_identifier_valid', { deterministic: true }, (value: unknown): number =>
    lifecycleIdentifier(value) ? 1 : 0,
  );
  db.function('lifecycle_persona_valid', { deterministic: true }, (value: unknown): number =>
    validPersona(value) ? 1 : 0,
  );
  db.function('lifecycle_retention_mutation_authorized', (): number =>
    (retentionMutationAuthorizationDepth.get(db) ?? 0) > 0 ? 1 : 0,
  );
}
