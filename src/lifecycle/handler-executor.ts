/** Executes the immutable implementation identity captured on a durable lifecycle delivery. */

import { err, ok, type Result } from 'neverthrow';
import { types } from 'node:util';
import { createHash } from 'node:crypto';
import {
  LifecycleEventEnvelopeSchema,
  LifecycleHandlerIdentityContractSchema,
  parseLifecycleHandlerResult,
  type LifecycleEventEnvelope,
  type LifecycleHandlerIdentityContract,
  type LifecycleHandlerResult,
} from './contracts/index.js';
import { LifecycleError } from '../core/errors/index.js';
import type { ClaimedLifecycleDelivery } from '../core/database/repositories/lifecycle-delivery-repository.js';

export interface LifecycleSubagentCapabilityScope {
  readonly persona: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/** This is intentionally token-free: only the dispatcher owns a lease. */
export interface LifecycleHandlerExecution {
  readonly event: LifecycleEventEnvelope;
  readonly identity: LifecycleHandlerIdentityContract;
  /** Persisted delivery persona, detached from the claim row. */
  readonly persona: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  /** Loader-owned scope is available only to a matching sub-agent capability. */
  readonly subagentScope?: LifecycleSubagentCapabilityScope;
}

export type LifecycleRuntimeHandler = (
  execution: LifecycleHandlerExecution,
) => Promise<Result<LifecycleHandlerResult, LifecycleError>>;

export interface LifecycleHandlerExecutor {
  execute(
    execution: LifecycleHandlerExecution,
  ): Promise<Result<LifecycleHandlerResult, LifecycleError>>;
}

/**
 * Stable, bounded idempotency key for one signal handoff. The length-delimited
 * encoding prevents tuple ambiguity before hashing and keeps valid maximum
 * event/handler identities inside LifecycleRuntimeId's persistence bound.
 */
export function lifecycleSignalHandoffKey(eventId: string, handlerId: string): string {
  const encode = (value: string): string => `${Buffer.byteLength(value, 'utf8')}:${value}`;
  return `lsh.v1.${createHash('sha256')
    .update('talon.lifecycle.signal-handoff.v1\0', 'utf8')
    .update(encode(eventId), 'utf8')
    .update('\0', 'utf8')
    .update(encode(handlerId), 'utf8')
    .digest('base64url')}`;
}

export interface LifecycleRuntimeCapability {
  readonly identity: LifecycleHandlerIdentityContract;
  readonly handler: LifecycleRuntimeHandler;
  readonly subagentScope?: LifecycleSubagentCapabilityScope;
}

export interface CapturedLifecycleHandlerExecutorOptions {
  /** Bootstrap-owned native capabilities, never configuration-derived refs. */
  readonly nativeCatalog?: readonly LifecycleRuntimeCapability[];
  /** Loader-owned sub-agent capabilities with their exact persona scope. */
  readonly subagentCatalog?: readonly LifecycleRuntimeCapability[];
}

const MAX_CATALOG_ENTRIES = 256;
const MAX_SCOPE_NODES = 256;
const MAX_SCOPE_DEPTH = 12;

interface PlainDataRecord {
  readonly [key: string]: PlainData;
}

interface PlainDataArray extends ReadonlyArray<PlainData> {
  readonly __plainDataArrayBrand?: never;
}

type PlainData = string | number | boolean | null | PlainDataArray | PlainDataRecord;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value instanceof AbortSignal) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function snapshotPlainData(
  value: unknown,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): PlainData | undefined {
  try {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (
      typeof value !== 'object' ||
      types.isProxy(value) ||
      depth > MAX_SCOPE_DEPTH ||
      ++budget.nodes > MAX_SCOPE_NODES
    ) {
      return undefined;
    }
    if (Array.isArray(value)) {
      if (Reflect.getPrototypeOf(value) !== Array.prototype || value.length > 128) return undefined;
      const result: PlainData[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
        const item = snapshotPlainData(descriptor.value, depth + 1, budget);
        if (item === undefined) return undefined;
        result.push(item);
      }
      return deepFreeze(result);
    }
    if (Reflect.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64 || keys.some((key) => typeof key !== 'string')) return undefined;
    const result: Record<string, PlainData> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
      const item = snapshotPlainData(descriptor.value, depth + 1, budget);
      if (item === undefined) return undefined;
      result[key as string] = item;
    }
    return deepFreeze(result);
  } catch {
    return undefined;
  }
}

function sameIdentity(
  left: LifecycleHandlerIdentityContract,
  right: LifecycleHandlerIdentityContract,
): boolean {
  return (
    left.version === right.version &&
    left.handlerId === right.handlerId &&
    left.runtimeKind === right.runtimeKind &&
    left.implementationRef === right.implementationRef &&
    left.implementationVersion === right.implementationVersion &&
    left.mode === right.mode &&
    left.inputContract === right.inputContract &&
    left.outputContract === right.outputContract &&
    left.interceptorSafety === right.interceptorSafety
  );
}

function materializeCatalog(
  input: unknown,
  kind: 'native' | 'subagent',
): readonly LifecycleRuntimeCapability[] | undefined {
  try {
    if (input === undefined) return Object.freeze([]);
    if (
      !Array.isArray(input) ||
      types.isProxy(input) ||
      Reflect.getPrototypeOf(input) !== Array.prototype ||
      input.length > MAX_CATALOG_ENTRIES
    ) {
      return undefined;
    }
    const result: LifecycleRuntimeCapability[] = [];
    const tuples = new Set<string>();
    for (let index = 0; index < input.length; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(input, String(index));
      if (!entry || !('value' in entry) || !entry.enumerable) return undefined;
      const candidate: unknown = entry.value;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        types.isProxy(candidate) ||
        Reflect.getPrototypeOf(candidate) !== Object.prototype
      ) {
        return undefined;
      }
      const allowed = new Set(['identity', 'handler', 'subagentScope']);
      const keys = Reflect.ownKeys(candidate);
      if (
        keys.length > allowed.size ||
        keys.some((key) => typeof key !== 'string' || !allowed.has(key))
      ) {
        return undefined;
      }
      const identityDescriptor = Object.getOwnPropertyDescriptor(candidate, 'identity');
      const handlerDescriptor = Object.getOwnPropertyDescriptor(candidate, 'handler');
      const scopeDescriptor = Object.getOwnPropertyDescriptor(candidate, 'subagentScope');
      if (
        !identityDescriptor ||
        !('value' in identityDescriptor) ||
        !identityDescriptor.enumerable ||
        !handlerDescriptor ||
        !('value' in handlerDescriptor) ||
        !handlerDescriptor.enumerable ||
        typeof handlerDescriptor.value !== 'function' ||
        types.isProxy(handlerDescriptor.value) ||
        (scopeDescriptor && (!('value' in scopeDescriptor) || !scopeDescriptor.enumerable))
      ) {
        return undefined;
      }
      const identitySnapshot = snapshotPlainData(identityDescriptor.value);
      const parsedIdentity = LifecycleHandlerIdentityContractSchema.safeParse(identitySnapshot);
      if (!parsedIdentity.success || parsedIdentity.data.runtimeKind !== kind) return undefined;
      const scopeSnapshot = scopeDescriptor ? snapshotPlainData(scopeDescriptor.value) : undefined;
      let scopePersona = '';
      if (kind === 'subagent') {
        if (!scopeSnapshot || typeof scopeSnapshot !== 'object' || Array.isArray(scopeSnapshot))
          return undefined;
        const scope = scopeSnapshot as Record<string, unknown>;
        if (
          typeof scope.persona !== 'string' ||
          !scope.capabilities ||
          typeof scope.capabilities !== 'object'
        ) {
          return undefined;
        }
        scopePersona = scope.persona;
      } else if (scopeDescriptor) {
        return undefined;
      }
      // Sub-agent authority is attached per persona. The same immutable
      // implementation identity may safely serve distinct explicit personas,
      // but may only be registered once for each persona attachment.
      const tuple =
        kind === 'subagent'
          ? `${JSON.stringify(parsedIdentity.data)}\u0000${scopePersona}`
          : JSON.stringify(parsedIdentity.data);
      if (tuples.has(tuple)) return undefined;
      tuples.add(tuple);
      result.push(
        deepFreeze({
          identity: deepFreeze(parsedIdentity.data),
          handler: handlerDescriptor.value as LifecycleRuntimeHandler,
          ...(scopeSnapshot
            ? { subagentScope: scopeSnapshot as unknown as LifecycleSubagentCapabilityScope }
            : {}),
        }),
      );
    }
    return deepFreeze(result);
  } catch {
    return undefined;
  }
}

function materializeCatalogOptions(
  options: unknown,
): Readonly<{ nativeCatalog: unknown; subagentCatalog: unknown }> | undefined {
  try {
    if (
      options === undefined ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      types.isProxy(options) ||
      Reflect.getPrototypeOf(options) !== Object.prototype
    ) {
      return options === undefined
        ? Object.freeze({ nativeCatalog: undefined, subagentCatalog: undefined })
        : undefined;
    }
    const keys = Reflect.ownKeys(options);
    if (
      keys.length > 2 ||
      keys.some((key) => key !== 'nativeCatalog' && key !== 'subagentCatalog')
    ) {
      return undefined;
    }
    const nativeCatalog = Object.getOwnPropertyDescriptor(options, 'nativeCatalog');
    const subagentCatalog = Object.getOwnPropertyDescriptor(options, 'subagentCatalog');
    if (
      (nativeCatalog && !('value' in nativeCatalog)) ||
      (nativeCatalog && !nativeCatalog.enumerable) ||
      (subagentCatalog && (!('value' in subagentCatalog) || !subagentCatalog.enumerable))
    ) {
      return undefined;
    }
    return Object.freeze({
      nativeCatalog:
        nativeCatalog && 'value' in nativeCatalog ? (nativeCatalog.value as unknown) : undefined,
      subagentCatalog:
        subagentCatalog && 'value' in subagentCatalog
          ? (subagentCatalog.value as unknown)
          : undefined,
    });
  } catch {
    return undefined;
  }
}

/**
 * Native and sub-agent implementations are selected from a one-time immutable
 * authority catalog. A persisted ref alone can never select a mutable handler.
 */
export class CapturedLifecycleHandlerExecutor implements LifecycleHandlerExecutor {
  private constructor(
    private readonly nativeCatalog: readonly LifecycleRuntimeCapability[],
    private readonly subagentCatalog: readonly LifecycleRuntimeCapability[],
  ) {}

  static create(
    options: CapturedLifecycleHandlerExecutorOptions = {},
  ): Result<CapturedLifecycleHandlerExecutor, LifecycleError> {
    const catalogOptions = materializeCatalogOptions(options);
    if (!catalogOptions)
      return err(new LifecycleError('invalid lifecycle runtime capability catalog'));
    const nativeCatalog = materializeCatalog(catalogOptions.nativeCatalog, 'native');
    const subagentCatalog = materializeCatalog(catalogOptions.subagentCatalog, 'subagent');
    if (!nativeCatalog || !subagentCatalog) {
      return err(new LifecycleError('invalid lifecycle runtime capability catalog'));
    }
    return ok(new CapturedLifecycleHandlerExecutor(nativeCatalog, subagentCatalog));
  }

  async execute(
    execution: LifecycleHandlerExecution,
  ): Promise<Result<LifecycleHandlerResult, LifecycleError>> {
    try {
      const catalog =
        execution.identity.runtimeKind === 'native' ? this.nativeCatalog : this.subagentCatalog;
      const capability = catalog.find(
        (candidate) =>
          sameIdentity(candidate.identity, execution.identity) &&
          (execution.identity.runtimeKind === 'native' ||
            candidate.subagentScope?.persona === execution.persona),
      );
      if (
        !capability ||
        (execution.identity.runtimeKind === 'subagent' &&
          capability.subagentScope?.persona !== execution.persona)
      ) {
        return err(new LifecycleError('captured lifecycle handler implementation is unavailable'));
      }
      const result = await capability.handler(
        deepFreeze({
          ...execution,
          ...(capability.subagentScope ? { subagentScope: capability.subagentScope } : {}),
        }),
      );
      if (result.isErr()) return result;
      const parsed = parseLifecycleHandlerResult(
        {
          version: execution.identity.version,
          id: execution.identity.handlerId,
          mode: execution.identity.mode,
          inputContract: execution.identity.inputContract,
          outputContract: execution.identity.outputContract,
          runtime: {
            kind: execution.identity.runtimeKind,
            ref: execution.identity.implementationRef,
            implementationVersion: execution.identity.implementationVersion,
          },
          ...(execution.identity.interceptorSafety
            ? { interceptorSafety: execution.identity.interceptorSafety }
            : {}),
        },
        execution.event,
        result.value,
      );
      return parsed.success
        ? ok(parsed.data)
        : err(new LifecycleError('captured lifecycle handler returned invalid output'));
    } catch {
      return err(new LifecycleError('captured lifecycle handler execution failed'));
    }
  }
}

/** Rehydrates and validates detached persisted records before crossing an executor boundary. */
export function materializeLifecycleHandlerExecution(
  claim: ClaimedLifecycleDelivery,
  signal: AbortSignal,
): Result<LifecycleHandlerExecution, LifecycleError> {
  try {
    const identity = LifecycleHandlerIdentityContractSchema.safeParse(
      JSON.parse(claim.delivery.handler_identity) as unknown,
    );
    const provenance = JSON.parse(claim.event.provenance) as unknown;
    const payload = JSON.parse(claim.event.payload) as unknown;
    const event = LifecycleEventEnvelopeSchema.safeParse({
      version: claim.event.version,
      eventId: claim.event.event_id,
      type: claim.event.type,
      occurredAt: claim.event.occurred_at,
      context: {
        aggregate: { type: claim.event.aggregate_type, id: claim.event.aggregate_id },
        correlationId: claim.event.correlation_id,
        ...(claim.event.causation_id ? { causationId: claim.event.causation_id } : {}),
        recursion: {
          depth: claim.event.recursion_depth,
          maxDepth: claim.event.recursion_max_depth,
        },
        provenance,
      },
      payload,
    });
    if (
      !identity.success ||
      !event.success ||
      identity.data.handlerId !== claim.delivery.handler_id
    ) {
      return err(new LifecycleError('persisted lifecycle execution is invalid'));
    }
    return ok(
      deepFreeze({
        event: deepFreeze(structuredClone(event.data)),
        identity: deepFreeze(structuredClone(identity.data)),
        persona: claim.delivery.persona,
        idempotencyKey: lifecycleSignalHandoffKey(
          claim.delivery.event_id,
          claim.delivery.handler_id,
        ),
        signal,
      }),
    );
  } catch {
    return err(new LifecycleError('persisted lifecycle execution is invalid'));
  }
}
