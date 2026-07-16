import { err, ok, type Result } from 'neverthrow';
import { types } from 'node:util';
import { z } from 'zod';
import {
  getEffectiveInterceptorSafety,
  LifecycleEventTypeSchema,
  LifecycleConfigSchema,
  LifecycleDurablePersonaOwnerNameSchema,
  LifecycleFilterOwnerNameSchema,
  LifecycleHandlerModeSchema,
  PersonaLifecycleConfigSchema,
  LifecycleRuntimeNameSchema,
  LifecycleSignalTypeSchema,
  LifecycleDisplayNameSchema,
  resolveLifecycleHandlerContract,
} from './contracts/index.js';

import { LifecycleError } from '../core/errors/error-types.js';
import type {
  LifecycleBudgetContract,
  LifecycleConfig,
  LifecycleFailurePolicyContract,
  LifecycleFilterContract,
  LifecycleHandlerContract,
  LifecycleHandlerIdentityContract,
  LifecycleInterceptorContract,
  LifecycleItemOrigin,
  LifecycleItemType,
  LifecycleMessageSource,
  LifecycleScheduleSource,
  LifecycleSignalContract,
  LifecycleEventContract,
  LifecycleEventType,
  PersonaLifecycleConfig,
  PersonaLifecycleSubscription,
  LifecycleSignalType,
} from './contracts/index.js';

export interface LifecycleRegistryPersonaInput {
  name: string;
  lifecycle?: PersonaLifecycleConfig;
}

export interface LifecycleRegistryChannelInput {
  name: string;
}

/**
 * Bootstrap-owned native authority. Configuration may select a registration,
 * but every executable property is confirmed here before the registry exists.
 */
export interface LifecycleNativeImplementationRegistration {
  ref: string;
  implementationVersion: string;
  mode: LifecycleHandlerContract['mode'];
  inputContract: string;
  outputContract: string;
  interceptorSafety?: 'advisory' | 'enforcing';
}

/**
 * Loader-owned subagent authority. The loader derives this from the loaded
 * manifest and supported runtime capabilities; lifecycle YAML can select a
 * capability, but cannot assert its version or contract.
 */
export interface LifecycleLoadedSubagentRegistration {
  ref: string;
  implementationVersion: string;
  mode: LifecycleHandlerContract['mode'];
  inputContract: string;
  outputContract: string;
  interceptorSafety?: 'advisory' | 'enforcing';
}

export interface LifecycleRegistryInput {
  lifecycle?: LifecycleConfig;
  channels?: LifecycleRegistryChannelInput[];
  personas: LifecycleRegistryPersonaInput[];
  /**
   * Bootstrap's trusted native factory catalog.  Do not infer this from a
   * handler reference: config can select a factory, but cannot create trust.
   */
  nativeImplementationCatalog?: Iterable<LifecycleNativeImplementationRegistration>;
  /** Loader-owned catalog of manifest-backed subagent capabilities. */
  loadedSubagentCatalog?: Iterable<LifecycleLoadedSubagentRegistration>;
}

/**
 * The registry is also called directly during bootstrap, so validate and
 * normalize the configuration-owned subset before trusting its typed shape.
 * Catalog iterables remain outside this schema because they are bootstrap and
 * loader authority, not YAML configuration.
 */
const LifecycleRegistryOwnedConfigSchema = z.object({
  lifecycle: LifecycleConfigSchema.optional(),
  channels: z
    .array(
      z.object({
        name: LifecycleFilterOwnerNameSchema,
      }),
    )
    .optional(),
  personas: z.array(
    z.object({
      name: LifecycleFilterOwnerNameSchema,
      lifecycle: PersonaLifecycleConfigSchema.optional(),
    }),
  ),
});

function formatStructuralConfigError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ');
}

export interface LifecycleValidationIssue {
  path: PropertyKey[];
  message: string;
}

export interface ResolvedLifecycleHandler {
  persona: string;
  priority: number;
  handler: LifecycleHandlerContract;
  identity: LifecycleHandlerIdentityContract;
  subscription: PersonaLifecycleSubscription['subscription'];
  budget?: LifecycleBudgetContract;
  failurePolicy: LifecycleFailurePolicyContract;
}

export interface LifecycleEventResolutionQuery {
  persona: string;
  eventType: LifecycleEventType;
  itemOrigin?: LifecycleItemOrigin;
  itemType?: LifecycleItemType;
  channel?: string;
  messageSource?: LifecycleMessageSource;
  scheduleSource?: LifecycleScheduleSource;
}

export interface LifecycleSignalResolutionQuery {
  persona: string;
  signalType: LifecycleSignalType;
  itemOrigin?: LifecycleEventResolutionQuery['itemOrigin'];
  itemType?: LifecycleEventResolutionQuery['itemType'];
  channel?: string;
  messageSource?: LifecycleMessageSource;
  scheduleSource?: LifecycleEventResolutionQuery['scheduleSource'];
}

export interface LifecycleInterceptorResolutionQuery {
  persona: string;
  hook: LifecycleInterceptorContract['hook'];
  itemOrigin?: LifecycleEventResolutionQuery['itemOrigin'];
  itemType?: LifecycleEventResolutionQuery['itemType'];
  channel?: string;
  messageSource?: LifecycleMessageSource;
  scheduleSource?: LifecycleEventResolutionQuery['scheduleSource'];
}

function compareResolvedHandlers(
  left: ResolvedLifecycleHandler,
  right: ResolvedLifecycleHandler,
): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  // Locale collation varies by host configuration; registry order is part of
  // the delivery contract, so compare normalized ASCII identifiers directly.
  if (left.handler.id < right.handler.id) {
    return -1;
  }
  if (left.handler.id > right.handler.id) {
    return 1;
  }
  return 0;
}

function defaultFailurePolicyForMode(
  mode: LifecycleHandlerContract['mode'],
): LifecycleFailurePolicyContract {
  return {
    version: 'v1',
    mode: mode === 'interceptor' ? 'fail_closed' : 'dead_letter',
  };
}

function effectiveFailurePolicy(
  handler: LifecycleHandlerContract,
  attachment?: PersonaLifecycleSubscription,
): LifecycleFailurePolicyContract {
  if (handler.mode === 'interceptor' && getEffectiveInterceptorSafety(handler) === 'advisory') {
    return { version: 'v1', mode: 'fail_open' };
  }

  return (
    attachment?.failurePolicy ?? handler.failurePolicy ?? defaultFailurePolicyForMode(handler.mode)
  );
}

function toHandlerIdentity(handler: LifecycleHandlerContract): LifecycleHandlerIdentityContract {
  return {
    version: 'v1',
    handlerId: handler.id,
    runtimeKind: handler.runtime.kind,
    implementationRef: handler.runtime.ref,
    implementationVersion: handler.runtime.implementationVersion,
    mode: handler.mode,
    inputContract: handler.inputContract,
    outputContract: handler.outputContract,
    ...(handler.mode === 'interceptor'
      ? { interceptorSafety: getEffectiveInterceptorSafety(handler) }
      : {}),
  };
}

type LifecycleRuntimeCapabilityRegistration =
  | LifecycleNativeImplementationRegistration
  | LifecycleLoadedSubagentRegistration;

type CanonicalLifecycleRuntimeCapabilityRegistration =
  Readonly<LifecycleRuntimeCapabilityRegistration>;

type LifecycleCapabilityCatalogName = 'nativeImplementationCatalog' | 'loadedSubagentCatalog';

const MAX_LIFECYCLE_RUNTIME_CAPABILITIES = 256;
const MAX_LIFECYCLE_AUTHORITY_PROTOTYPE_DEPTH = 16;

type LifecycleSafePropertyLookup =
  | Readonly<{ kind: 'found'; value: unknown }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>;

function findSafeDataProperty(source: object, key: PropertyKey): LifecycleSafePropertyLookup {
  try {
    let candidate: object | null = source;
    for (let depth = 0; candidate && depth <= MAX_LIFECYCLE_AUTHORITY_PROTOTYPE_DEPTH; depth += 1) {
      if (types.isProxy(candidate)) {
        return { kind: 'invalid' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor) {
        if (!('value' in descriptor)) {
          return { kind: 'invalid' };
        }
        const value: unknown = descriptor.value;
        return { kind: 'found', value };
      }
      const prototype: unknown = Object.getPrototypeOf(candidate);
      if (prototype !== null && typeof prototype !== 'object') {
        return { kind: 'invalid' };
      }
      candidate = prototype;
    }
    return candidate ? { kind: 'invalid' } : { kind: 'missing' };
  } catch {
    return { kind: 'invalid' };
  }
}

function materializeRegistryFactoryInput(input: unknown):
  | Readonly<{
      ownedConfig: { lifecycle?: unknown; channels?: unknown; personas?: unknown };
      nativeImplementationCatalog: unknown;
      loadedSubagentCatalog: unknown;
    }>
  | undefined {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      types.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      return undefined;
    }

    const lifecycle = findSafeDataProperty(input, 'lifecycle');
    const channels = findSafeDataProperty(input, 'channels');
    const personas = findSafeDataProperty(input, 'personas');
    const nativeImplementationCatalog = findSafeDataProperty(input, 'nativeImplementationCatalog');
    const loadedSubagentCatalog = findSafeDataProperty(input, 'loadedSubagentCatalog');
    if (
      lifecycle.kind === 'invalid' ||
      channels.kind === 'invalid' ||
      personas.kind === 'invalid' ||
      nativeImplementationCatalog.kind === 'invalid' ||
      loadedSubagentCatalog.kind === 'invalid'
    ) {
      return undefined;
    }

    return Object.freeze({
      ownedConfig: {
        ...(lifecycle.kind === 'found' ? { lifecycle: lifecycle.value } : {}),
        ...(channels.kind === 'found' ? { channels: channels.value } : {}),
        ...(personas.kind === 'found' ? { personas: personas.value } : {}),
      },
      nativeImplementationCatalog:
        nativeImplementationCatalog.kind === 'found'
          ? nativeImplementationCatalog.value
          : undefined,
      loadedSubagentCatalog:
        loadedSubagentCatalog.kind === 'found' ? loadedSubagentCatalog.value : undefined,
    });
  } catch {
    return undefined;
  }
}

function materializeIteratorStep(
  step: unknown,
): Readonly<{ done: boolean; value: unknown }> | undefined {
  if (!step || typeof step !== 'object' || types.isProxy(step)) {
    return undefined;
  }

  const done = findSafeDataProperty(step, 'done');
  if (done.kind === 'invalid' || (done.kind === 'found' && typeof done.value !== 'boolean')) {
    return undefined;
  }

  // Completion is authoritative. Do not inspect a terminal value: it could
  // otherwise be mistaken for a capability registration.
  if (done.kind === 'found' && done.value === true) {
    return Object.freeze({ done: true, value: undefined });
  }

  const value = findSafeDataProperty(step, 'value');
  if (value.kind !== 'found') {
    return undefined;
  }

  return Object.freeze({ done: false, value: value.value });
}

function materializeRuntimeCapabilityRegistration(
  registration: unknown,
): CanonicalLifecycleRuntimeCapabilityRegistration | undefined {
  try {
    if (
      !registration ||
      typeof registration !== 'object' ||
      Array.isArray(registration) ||
      types.isProxy(registration) ||
      Object.getPrototypeOf(registration) !== Object.prototype
    ) {
      return undefined;
    }

    const descriptors = Object.getOwnPropertyDescriptors(registration);
    const requiredKeys = [
      'ref',
      'implementationVersion',
      'mode',
      'inputContract',
      'outputContract',
    ] as const;
    const allowedKeys = [...requiredKeys, 'interceptorSafety'] as const;
    const allowedKeySet = new Set<string>(allowedKeys);
    const keys = Reflect.ownKeys(registration);
    if (
      keys.some((key) => typeof key !== 'string' || !allowedKeySet.has(key)) ||
      requiredKeys.some((key) => descriptors[key] === undefined)
    ) {
      return undefined;
    }

    for (const key of allowedKeys) {
      const descriptor = descriptors[key];
      if (descriptor && (!('value' in descriptor) || !descriptor.enumerable)) {
        return undefined;
      }
    }

    const refValue: unknown = descriptors.ref.value;
    const implementationVersionValue: unknown = descriptors.implementationVersion.value;
    const modeValue: unknown = descriptors.mode.value;
    const inputContract: unknown = descriptors.inputContract.value;
    const outputContract: unknown = descriptors.outputContract.value;
    const interceptorSafety: unknown = descriptors.interceptorSafety?.value;
    const ref = LifecycleRuntimeNameSchema.safeParse(refValue);
    const implementationVersion = LifecycleDisplayNameSchema.safeParse(implementationVersionValue);
    const mode = LifecycleHandlerModeSchema.safeParse(modeValue);
    if (
      !ref.success ||
      !implementationVersion.success ||
      !mode.success ||
      typeof inputContract !== 'string' ||
      typeof outputContract !== 'string' ||
      (interceptorSafety !== undefined &&
        interceptorSafety !== 'advisory' &&
        interceptorSafety !== 'enforcing')
    ) {
      return undefined;
    }

    const contract = resolveLifecycleHandlerContract(inputContract, outputContract);
    if (!contract || contract.mode !== mode.data || contract.requiredSafety !== interceptorSafety) {
      return undefined;
    }

    return Object.freeze({
      ref: ref.data,
      implementationVersion: implementationVersion.data,
      mode: mode.data,
      inputContract,
      outputContract,
      ...(interceptorSafety ? { interceptorSafety } : {}),
    });
  } catch {
    return undefined;
  }
}

function materializeRuntimeCatalog(
  catalog: unknown,
  catalogName: LifecycleCapabilityCatalogName,
  issues: LifecycleValidationIssue[],
): readonly CanonicalLifecycleRuntimeCapabilityRegistration[] {
  if (catalog === undefined) {
    return [];
  }

  let iterator: object | undefined;
  let completed = false;
  const registrations: CanonicalLifecycleRuntimeCapabilityRegistration[] = [];
  try {
    if (!catalog || (typeof catalog !== 'object' && typeof catalog !== 'function')) {
      issues.push({ path: [catalogName], message: 'lifecycle runtime catalog must be iterable' });
      return registrations;
    }

    if (types.isProxy(catalog)) {
      issues.push({ path: [catalogName], message: 'lifecycle runtime catalog must be plain data' });
      return registrations;
    }
    const iteratorFactory = findSafeDataProperty(catalog, Symbol.iterator);
    if (iteratorFactory.kind !== 'found' || typeof iteratorFactory.value !== 'function') {
      issues.push({ path: [catalogName], message: 'lifecycle runtime catalog must be iterable' });
      return registrations;
    }
    if (types.isProxy(iteratorFactory.value)) {
      issues.push({
        path: [catalogName],
        message: 'lifecycle runtime iterator factory must be plain data',
      });
      return registrations;
    }
    const iteratorCandidate: unknown = Reflect.apply(iteratorFactory.value, catalog, []);
    if (!iteratorCandidate || typeof iteratorCandidate !== 'object') {
      issues.push({ path: [catalogName], message: 'lifecycle runtime iterator must be an object' });
      return registrations;
    }
    if (types.isProxy(iteratorCandidate)) {
      issues.push({
        path: [catalogName],
        message: 'lifecycle runtime iterator must be plain data',
      });
      return registrations;
    }
    iterator = iteratorCandidate;
    const next = findSafeDataProperty(iterator, 'next');
    if (next.kind !== 'found' || typeof next.value !== 'function') {
      issues.push({ path: [catalogName], message: 'lifecycle runtime iterator must provide next' });
      return registrations;
    }
    if (types.isProxy(next.value)) {
      issues.push({
        path: [catalogName],
        message: 'lifecycle runtime iterator next must be plain data',
      });
      return registrations;
    }

    for (let index = 0; ; index += 1) {
      const step = materializeIteratorStep(Reflect.apply(next.value, iterator, []));
      if (!step) {
        issues.push({
          path: [catalogName],
          message: 'lifecycle runtime iterator returned an invalid step',
        });
        return registrations;
      }
      if (step.done) {
        completed = true;
        return registrations;
      }
      if (index >= MAX_LIFECYCLE_RUNTIME_CAPABILITIES) {
        issues.push({
          path: [catalogName],
          message: `lifecycle runtime catalog may contain at most ${MAX_LIFECYCLE_RUNTIME_CAPABILITIES} registrations`,
        });
        return registrations;
      }

      const registration = materializeRuntimeCapabilityRegistration(step.value);
      if (!registration) {
        issues.push({
          path: [catalogName, index],
          message:
            'lifecycle runtime registration must be a strict data record with a supported contract pair',
        });
        return registrations;
      }
      registrations.push(registration);
    }
  } catch {
    issues.push({
      path: [catalogName],
      message: 'failed to materialize lifecycle runtime catalog',
    });
    return registrations;
  } finally {
    if (!completed && iterator) {
      try {
        const close = findSafeDataProperty(iterator, 'return');
        if (
          close.kind === 'found' &&
          typeof close.value === 'function' &&
          !types.isProxy(close.value)
        ) {
          Reflect.apply(close.value, iterator, []);
        }
      } catch {
        // The catalog has already been rejected. Cleanup must not escape the
        // Result boundary or cause a second traversal.
      }
    }
  }
}

function runtimeCatalogMap(
  catalog: readonly CanonicalLifecycleRuntimeCapabilityRegistration[],
  catalogName: LifecycleCapabilityCatalogName,
  issues: LifecycleValidationIssue[],
): Map<string, CanonicalLifecycleRuntimeCapabilityRegistration[]> {
  const registrations = new Map<string, CanonicalLifecycleRuntimeCapabilityRegistration[]>();
  for (const [catalogIndex, registration] of catalog.entries()) {
    const existing = registrations.get(registration.ref) ?? [];
    if (
      existing.some(
        (candidate) => candidate.implementationVersion !== registration.implementationVersion,
      )
    ) {
      issues.push({
        path: [catalogName, catalogIndex, 'implementationVersion'],
        message: `lifecycle runtime registration "${registration.ref}" conflicts with an authoritative implementation version`,
      });
      continue;
    }
    if (
      existing.some(
        (candidate) =>
          candidate.mode === registration.mode &&
          candidate.inputContract === registration.inputContract &&
          candidate.outputContract === registration.outputContract &&
          candidate.interceptorSafety === registration.interceptorSafety,
      )
    ) {
      issues.push({
        path: [catalogName, catalogIndex],
        message: `duplicate lifecycle runtime capability for "${registration.ref}"`,
      });
      continue;
    }
    registrations.set(registration.ref, [...existing, registration]);
  }
  return registrations;
}

function findRuntimeCapability(
  catalog: ReadonlyMap<string, readonly CanonicalLifecycleRuntimeCapabilityRegistration[]>,
  handler: LifecycleHandlerContract,
): CanonicalLifecycleRuntimeCapabilityRegistration | undefined {
  return catalog
    .get(handler.runtime.ref)
    ?.find(
      (registration) =>
        registration.implementationVersion === handler.runtime.implementationVersion &&
        registration.mode === handler.mode &&
        registration.inputContract === handler.inputContract &&
        registration.outputContract === handler.outputContract &&
        registration.interceptorSafety === getEffectiveInterceptorSafety(handler),
    );
}

function matchesFilter(
  filter: LifecycleFilterContract | undefined,
  query: {
    persona: string;
    itemOrigin?: LifecycleEventResolutionQuery['itemOrigin'];
    itemType?: LifecycleEventResolutionQuery['itemType'];
    channel?: string;
    messageSource?: LifecycleMessageSource;
    scheduleSource?: LifecycleEventResolutionQuery['scheduleSource'];
  },
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.personas && !filter.personas.includes(query.persona)) {
    return false;
  }
  if (filter.itemOrigins && (!query.itemOrigin || !filter.itemOrigins.includes(query.itemOrigin))) {
    return false;
  }
  if (filter.itemTypes && (!query.itemType || !filter.itemTypes.includes(query.itemType))) {
    return false;
  }
  if (filter.channels && (!query.channel || !filter.channels.includes(query.channel))) {
    return false;
  }
  if (
    filter.messageSources &&
    (!query.messageSource || !filter.messageSources.includes(query.messageSource))
  ) {
    return false;
  }
  if (
    filter.scheduleSources &&
    (!query.scheduleSource || !filter.scheduleSources.includes(query.scheduleSource))
  ) {
    return false;
  }

  return true;
}

function isFailurePolicyCompatible(
  handler: LifecycleHandlerContract,
  failurePolicy: LifecycleFailurePolicyContract,
): boolean {
  if (handler.mode === 'interceptor') {
    if (getEffectiveInterceptorSafety(handler) === 'enforcing') {
      return failurePolicy.mode === 'fail_closed';
    }

    return failurePolicy.mode === 'fail_open';
  }

  return failurePolicy.mode === 'dead_letter' || failurePolicy.mode === 'preserve_session';
}

function appendFailurePolicyIssues(
  handler: LifecycleHandlerContract,
  failurePolicy: LifecycleFailurePolicyContract | undefined,
  path: PropertyKey[],
  issues: LifecycleValidationIssue[],
): void {
  if (!failurePolicy) {
    return;
  }

  if (!isFailurePolicyCompatible(handler, failurePolicy)) {
    issues.push({
      path,
      message:
        handler.mode === 'interceptor'
          ? getEffectiveInterceptorSafety(handler) === 'enforcing'
            ? 'enforcing native interceptors must use fail_closed failure policies'
            : 'advisory interceptors must use fail_open failure policies'
          : `${handler.mode} handlers must use dead_letter or preserve_session failure policies`,
    });
  }
}

export function collectLifecycleValidationIssues(
  input: LifecycleRegistryInput,
  options: {
    verifyRuntimeAvailability?: boolean;
    nativeImplementationCatalog?: readonly CanonicalLifecycleRuntimeCapabilityRegistration[];
    loadedSubagentCatalog?: readonly CanonicalLifecycleRuntimeCapabilityRegistration[];
  } = {},
): LifecycleValidationIssue[] {
  const issues: LifecycleValidationIssue[] = [];
  const handlerIndexes = new Map<string, number>();
  const handlers = input.lifecycle?.handlers ?? [];
  const personaNames = new Map<string, number>();
  const channelNames = new Map<string, number>();
  const lifecycleEnabled = input.lifecycle?.enabled === true;

  // Names are only registry keys while lifecycle resolution is active. Keeping
  // this check behind the feature flag preserves legacy and disabled configs.
  if (lifecycleEnabled) {
    for (const [index, persona] of input.personas.entries()) {
      if (!LifecycleDurablePersonaOwnerNameSchema.safeParse(persona.name).success) {
        issues.push({
          path: ['personas', index, 'name'],
          message:
            'lifecycle-enabled persona names must be at most 256 Unicode scalars and 1024 UTF-8 bytes without NUL characters',
        });
      }
      const firstIndex = personaNames.get(persona.name);
      if (firstIndex !== undefined) {
        issues.push({
          path: ['personas', index, 'name'],
          message: `duplicate persona name "${persona.name}" (first declared at personas.${firstIndex}.name)`,
        });
        continue;
      }
      personaNames.set(persona.name, index);
    }

    for (const [index, channel] of (input.channels ?? []).entries()) {
      const firstIndex = channelNames.get(channel.name);
      if (firstIndex !== undefined) {
        issues.push({
          path: ['channels', index, 'name'],
          message: `duplicate channel name "${channel.name}" (first declared at channels.${firstIndex}.name)`,
        });
        continue;
      }
      channelNames.set(channel.name, index);
    }
  }

  const knownPersonas = new Set(input.personas.map((persona) => persona.name));
  const knownChannels = input.channels
    ? new Set(input.channels.map((channel) => channel.name))
    : null;
  const nativeImplementationCatalog = runtimeCatalogMap(
    options.nativeImplementationCatalog ??
      materializeRuntimeCatalog(
        input.nativeImplementationCatalog,
        'nativeImplementationCatalog',
        issues,
      ),
    'nativeImplementationCatalog',
    issues,
  );
  const loadedSubagentCatalog = runtimeCatalogMap(
    options.loadedSubagentCatalog ??
      materializeRuntimeCatalog(input.loadedSubagentCatalog, 'loadedSubagentCatalog', issues),
    'loadedSubagentCatalog',
    issues,
  );

  for (const [index, handler] of handlers.entries()) {
    const duplicateIndex = handlerIndexes.get(handler.id);
    if (duplicateIndex !== undefined) {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'id'],
        message: `duplicate lifecycle handler id "${handler.id}"`,
      });
      continue;
    }

    handlerIndexes.set(handler.id, index);

    if (handler.mode !== 'interceptor' && handler.interceptorSafety !== undefined) {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'interceptorSafety'],
        message: 'interceptorSafety is only valid for interceptor handlers',
      });
    }

    if (
      options.verifyRuntimeAvailability &&
      handler.runtime.kind === 'native' &&
      !nativeImplementationCatalog.has(handler.runtime.ref)
    ) {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'runtime', 'ref'],
        message: `lifecycle native implementation "${handler.runtime.ref}" is not in the bootstrap catalog`,
      });
    }

    if (options.verifyRuntimeAvailability && handler.runtime.kind === 'native') {
      if (
        nativeImplementationCatalog.has(handler.runtime.ref) &&
        !findRuntimeCapability(nativeImplementationCatalog, handler)
      ) {
        issues.push({
          path: ['lifecycle', 'handlers', index],
          message:
            `lifecycle native implementation "${handler.runtime.ref}" must exactly match an ` +
            'authoritative bootstrap capability mode, version, contracts, and interceptor safety',
        });
      }
    }

    if (
      options.verifyRuntimeAvailability &&
      handler.runtime.kind === 'subagent' &&
      !loadedSubagentCatalog.has(handler.runtime.ref)
    ) {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'runtime', 'ref'],
        message: `lifecycle subagent implementation "${handler.runtime.ref}" is not in the loaded subagent catalog`,
      });
    }

    if (
      options.verifyRuntimeAvailability &&
      handler.runtime.kind === 'subagent' &&
      loadedSubagentCatalog.has(handler.runtime.ref) &&
      !findRuntimeCapability(loadedSubagentCatalog, handler)
    ) {
      issues.push({
        path: ['lifecycle', 'handlers', index],
        message:
          `lifecycle subagent implementation "${handler.runtime.ref}" must exactly match an ` +
          'authoritative loaded capability mode, manifest version, contracts, and interceptor safety',
      });
    }

    const contract = resolveLifecycleHandlerContract(handler.inputContract, handler.outputContract);
    if (!contract || contract.mode !== handler.mode) {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'inputContract'],
        message:
          `lifecycle handler contracts "${handler.inputContract}" and "${handler.outputContract}" ` +
          `are not a supported ${handler.mode} contract pair`,
      });
    } else if (
      contract.requiredSafety !== getEffectiveInterceptorSafety(handler) &&
      !(
        handler.mode === 'interceptor' &&
        handler.runtime.kind !== 'native' &&
        handler.interceptorSafety === 'enforcing'
      )
    ) {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'outputContract'],
        message:
          `lifecycle handler output contract "${handler.outputContract}" is incompatible with ` +
          `${getEffectiveInterceptorSafety(handler)} interceptor safety`,
      });
    }

    if (
      handler.mode === 'interceptor' &&
      handler.runtime.kind !== 'native' &&
      handler.interceptorSafety === 'enforcing'
    ) {
      issues.push({
        path: ['lifecycle', 'handlers', index, 'interceptorSafety'],
        message: 'enforcing interceptors must use a native implementation',
      });
    }

    if (handler.failurePolicy) {
      appendFailurePolicyIssues(
        handler,
        handler.failurePolicy,
        ['lifecycle', 'handlers', index, 'failurePolicy'],
        issues,
      );
    }
  }

  for (const [personaIndex, persona] of input.personas.entries()) {
    const seenHandlers = new Set<string>();
    const subscriptions = persona.lifecycle?.subscriptions ?? [];

    for (const [subscriptionIndex, attachment] of subscriptions.entries()) {
      if (seenHandlers.has(attachment.handler)) {
        issues.push({
          path: [
            'personas',
            personaIndex,
            'lifecycle',
            'subscriptions',
            subscriptionIndex,
            'handler',
          ],
          message: `persona "${persona.name}" attaches lifecycle handler "${attachment.handler}" more than once`,
        });
      } else {
        seenHandlers.add(attachment.handler);
      }

      const handlerIndex = handlerIndexes.get(attachment.handler);
      if (handlerIndex === undefined) {
        issues.push({
          path: [
            'personas',
            personaIndex,
            'lifecycle',
            'subscriptions',
            subscriptionIndex,
            'handler',
          ],
          message:
            `persona "${persona.name}" references unknown lifecycle handler ` +
            `"${attachment.handler}"`,
        });
        continue;
      }

      const handler = handlers[handlerIndex];
      if (handler.mode !== attachment.subscription.kind) {
        issues.push({
          path: [
            'personas',
            personaIndex,
            'lifecycle',
            'subscriptions',
            subscriptionIndex,
            'subscription',
            'kind',
          ],
          message:
            `handler "${handler.id}" has mode "${handler.mode}" but subscription kind is ` +
            `"${attachment.subscription.kind}"`,
        });
      }

      if (attachment.subscription.filter?.personas) {
        for (const [
          filterIndex,
          personaName,
        ] of attachment.subscription.filter.personas.entries()) {
          if (!knownPersonas.has(personaName)) {
            issues.push({
              path: [
                'personas',
                personaIndex,
                'lifecycle',
                'subscriptions',
                subscriptionIndex,
                'subscription',
                'filter',
                'personas',
                filterIndex,
              ],
              message: `lifecycle filter references unknown persona "${personaName}"`,
            });
          } else if (personaName !== persona.name) {
            issues.push({
              path: [
                'personas',
                personaIndex,
                'lifecycle',
                'subscriptions',
                subscriptionIndex,
                'subscription',
                'filter',
                'personas',
                filterIndex,
              ],
              message:
                `lifecycle filter persona "${personaName}" does not match the attached ` +
                `persona "${persona.name}"`,
            });
          }
        }
      }

      if (knownChannels && attachment.subscription.filter?.channels) {
        for (const [
          filterIndex,
          channelName,
        ] of attachment.subscription.filter.channels.entries()) {
          if (!knownChannels.has(channelName)) {
            issues.push({
              path: [
                'personas',
                personaIndex,
                'lifecycle',
                'subscriptions',
                subscriptionIndex,
                'subscription',
                'filter',
                'channels',
                filterIndex,
              ],
              message: `lifecycle filter references unknown channel "${channelName}"`,
            });
          }
        }
      }

      const effectivePolicy = effectiveFailurePolicy(handler, attachment);

      appendFailurePolicyIssues(
        handler,
        attachment.failurePolicy ?? effectivePolicy,
        [
          'personas',
          personaIndex,
          'lifecycle',
          'subscriptions',
          subscriptionIndex,
          attachment.failurePolicy ? 'failurePolicy' : 'subscription',
        ],
        issues,
      );
    }
  }

  return issues;
}

function formatValidationIssues(issues: LifecycleValidationIssue[]): string {
  return issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) {
      return;
    }

    Object.freeze(candidate);
    for (const nested of Object.values(candidate)) {
      freeze(nested);
    }
  };

  freeze(copy);
  return copy;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class LifecycleHandlerRegistry {
  private readonly handlersById = new Map<string, LifecycleHandlerContract>();
  private readonly personaHandlers = new Map<string, ResolvedLifecycleHandler[]>();
  private readonly enabled: boolean;

  private constructor(
    input: LifecycleRegistryInput & {
      nativeImplementationCatalog?: readonly CanonicalLifecycleRuntimeCapabilityRegistration[];
      loadedSubagentCatalog?: readonly CanonicalLifecycleRuntimeCapabilityRegistration[];
    },
    capabilityCatalogs: {
      native: ReadonlyMap<string, readonly CanonicalLifecycleRuntimeCapabilityRegistration[]>;
      loadedSubagent: ReadonlyMap<
        string,
        readonly CanonicalLifecycleRuntimeCapabilityRegistration[]
      >;
    },
  ) {
    const inputSnapshot = snapshot(input);
    this.enabled = inputSnapshot.lifecycle?.enabled ?? false;
    const sortedHandlers = [...(inputSnapshot.lifecycle?.handlers ?? [])].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );

    for (const handler of sortedHandlers) {
      const authoritativeCapability =
        handler.runtime.kind === 'native'
          ? findRuntimeCapability(capabilityCatalogs.native, handler)
          : findRuntimeCapability(capabilityCatalogs.loadedSubagent, handler);
      if (this.enabled && !authoritativeCapability) {
        throw new Error(
          `enabled lifecycle handler "${handler.id}" lacks an exact authoritative runtime capability`,
        );
      }
      const canonicalHandler = authoritativeCapability
        ? snapshot({
            ...handler,
            mode: authoritativeCapability.mode,
            inputContract: authoritativeCapability.inputContract,
            outputContract: authoritativeCapability.outputContract,
            runtime: {
              ...handler.runtime,
              ref: authoritativeCapability.ref,
              implementationVersion: authoritativeCapability.implementationVersion,
            },
            ...(authoritativeCapability.mode === 'interceptor'
              ? { interceptorSafety: authoritativeCapability.interceptorSafety }
              : {}),
          })
        : handler.mode === 'interceptor'
          ? snapshot({ ...handler, interceptorSafety: getEffectiveInterceptorSafety(handler) })
          : handler;
      this.handlersById.set(canonicalHandler.id, canonicalHandler);
    }

    for (const persona of inputSnapshot.personas) {
      const resolvedHandlers: ResolvedLifecycleHandler[] = [];
      for (const attachment of persona.lifecycle?.subscriptions ?? []) {
        const handler = this.handlersById.get(attachment.handler);
        // The factory validates all references before construction. The
        // fallback keeps construction total if a caller has bypassed parsing.
        if (!handler) {
          continue;
        }

        const resolved: ResolvedLifecycleHandler = {
          persona: persona.name,
          priority: attachment.priority,
          handler,
          identity: toHandlerIdentity(handler),
          subscription: attachment.subscription,
          failurePolicy: effectiveFailurePolicy(handler, attachment),
        };
        const budget = attachment.budget ?? handler.budget;
        if (budget) {
          resolved.budget = budget;
        }
        resolvedHandlers.push(resolved);
      }
      resolvedHandlers.sort(compareResolvedHandlers);

      this.personaHandlers.set(persona.name, resolvedHandlers);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  listHandlers(): LifecycleHandlerContract[] {
    return [...this.handlersById.values()].map(clone);
  }

  getHandler(handlerId: string): LifecycleHandlerContract | undefined {
    const handler = this.handlersById.get(handlerId);
    return handler ? clone(handler) : undefined;
  }

  listPersonaHandlers(persona: string): ResolvedLifecycleHandler[] {
    return clone(this.personaHandlers.get(persona) ?? []);
  }

  resolveEventHandlers(query: LifecycleEventResolutionQuery): ResolvedLifecycleHandler[] {
    if (!this.enabled || !LifecycleEventTypeSchema.safeParse(query.eventType).success) {
      return [];
    }

    const resolvedHandlers = this.personaHandlers.get(query.persona) ?? [];

    return clone(
      resolvedHandlers.filter((handler) => {
        if (handler.subscription.kind !== 'event') {
          return false;
        }

        const matchesEvent = handler.subscription.events.some(
          (event: LifecycleEventContract) => event.type === query.eventType,
        );

        return (
          matchesEvent &&
          matchesFilter(handler.subscription.filter, {
            persona: query.persona,
            itemOrigin: query.itemOrigin,
            itemType: query.itemType,
            channel: query.channel,
            messageSource: query.messageSource,
            scheduleSource: query.scheduleSource,
          })
        );
      }),
    );
  }

  resolveSignalHandlers(query: LifecycleSignalResolutionQuery): ResolvedLifecycleHandler[] {
    if (!this.enabled || !LifecycleSignalTypeSchema.safeParse(query.signalType).success) {
      return [];
    }

    const resolvedHandlers = this.personaHandlers.get(query.persona) ?? [];

    return clone(
      resolvedHandlers.filter((handler) => {
        if (handler.subscription.kind !== 'signal') {
          return false;
        }

        const matchesSignal = handler.subscription.signals.some(
          (signal: LifecycleSignalContract) => signal.type === query.signalType,
        );

        return (
          matchesSignal &&
          matchesFilter(handler.subscription.filter, {
            persona: query.persona,
            itemOrigin: query.itemOrigin,
            itemType: query.itemType,
            channel: query.channel,
            messageSource: query.messageSource,
            scheduleSource: query.scheduleSource,
          })
        );
      }),
    );
  }

  resolveInterceptorHandlers(
    query: LifecycleInterceptorResolutionQuery,
  ): ResolvedLifecycleHandler[] {
    if (!this.enabled) {
      return [];
    }

    const resolvedHandlers = this.personaHandlers.get(query.persona) ?? [];

    return clone(
      resolvedHandlers.filter((handler) => {
        if (handler.subscription.kind !== 'interceptor') {
          return false;
        }

        const matchesHook = handler.subscription.interceptors.some(
          (interceptor: LifecycleInterceptorContract) => interceptor.hook === query.hook,
        );

        return (
          matchesHook &&
          matchesFilter(handler.subscription.filter, {
            persona: query.persona,
            itemOrigin: query.itemOrigin,
            itemType: query.itemType,
            channel: query.channel,
            messageSource: query.messageSource,
            scheduleSource: query.scheduleSource,
          })
        );
      }),
    );
  }

  static create(input: LifecycleRegistryInput): Result<LifecycleHandlerRegistry, LifecycleError> {
    try {
      const factoryInput = materializeRegistryFactoryInput(input);
      if (!factoryInput) {
        return err(
          new LifecycleError('invalid lifecycle registry input: expected a plain data record'),
        );
      }

      const parsedOwnedConfig = LifecycleRegistryOwnedConfigSchema.safeParse(
        factoryInput.ownedConfig,
      );
      if (!parsedOwnedConfig.success) {
        return err(
          new LifecycleError(
            `invalid lifecycle registry configuration: ${formatStructuralConfigError(
              parsedOwnedConfig.error,
            )}`,
          ),
        );
      }

      const catalogIssues: LifecycleValidationIssue[] = [];
      const nativeImplementationCatalog = materializeRuntimeCatalog(
        factoryInput.nativeImplementationCatalog,
        'nativeImplementationCatalog',
        catalogIssues,
      );
      const loadedSubagentCatalogSnapshot = materializeRuntimeCatalog(
        factoryInput.loadedSubagentCatalog,
        'loadedSubagentCatalog',
        catalogIssues,
      );
      if (catalogIssues.length > 0) {
        return err(new LifecycleError(formatValidationIssues(catalogIssues)));
      }

      const nativeCapabilityMap = runtimeCatalogMap(
        nativeImplementationCatalog,
        'nativeImplementationCatalog',
        catalogIssues,
      );
      const loadedSubagentCapabilityMap = runtimeCatalogMap(
        loadedSubagentCatalogSnapshot,
        'loadedSubagentCatalog',
        catalogIssues,
      );
      if (catalogIssues.length > 0) {
        return err(new LifecycleError(formatValidationIssues(catalogIssues)));
      }

      const normalizedInput = {
        lifecycle: parsedOwnedConfig.data.lifecycle,
        channels: parsedOwnedConfig.data.channels?.map(({ name }) => ({ name })),
        personas: parsedOwnedConfig.data.personas.map(({ name, lifecycle }) => ({
          name,
          ...(lifecycle ? { lifecycle } : {}),
        })),
        nativeImplementationCatalog,
        loadedSubagentCatalog: loadedSubagentCatalogSnapshot,
      };
      const issues = collectLifecycleValidationIssues(normalizedInput, {
        verifyRuntimeAvailability: normalizedInput.lifecycle?.enabled === true,
        nativeImplementationCatalog,
        loadedSubagentCatalog: loadedSubagentCatalogSnapshot,
      });
      if (issues.length > 0) {
        return err(new LifecycleError(formatValidationIssues(issues)));
      }

      return ok(
        new LifecycleHandlerRegistry(normalizedInput, {
          native: nativeCapabilityMap,
          loadedSubagent: loadedSubagentCapabilityMap,
        }),
      );
    } catch (error) {
      return err(
        new LifecycleError(
          `failed to create lifecycle handler registry: ${
            error instanceof Error ? error.message : 'invalid registry input'
          }`,
        ),
      );
    }
  }
}

export function createLifecycleHandlerRegistry(
  input: LifecycleRegistryInput,
): Result<LifecycleHandlerRegistry, LifecycleError> {
  return LifecycleHandlerRegistry.create(input);
}
