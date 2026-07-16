import { err, ok, type Result } from 'neverthrow';
import { types } from 'node:util';

import { LifecycleError } from '../../core/errors/index.js';
import type { ResolvedCapabilities } from '../../personas/persona-types.js';
import {
  DEFAULT_LIFECYCLE_SUBAGENT_TIMEOUT_MS,
  type SubAgentRunner,
} from '../../subagents/subagent-runner.js';
import type { LifecycleHandlerResult } from '../contracts/index.js';
import {
  LifecycleAggregateIdentitySchema,
  LifecycleBudgetContractSchema,
  LifecycleFailurePolicyContractSchema,
  LifecycleFilterOwnerNameSchema,
  LifecycleHandlerContractSchema,
  LifecycleHandlerIdentityContractSchema,
  LifecyclePrioritySchema,
  type LifecycleSubscriptionContract,
  LifecycleSubscriptionContractSchema,
  parseLifecycleHandlerResult,
  resolveLifecycleHandlerContract,
} from '../contracts/index.js';
import type { ResolvedLifecycleHandler } from '../handler-registry.js';
import { fenceLifecycleUntrustedInput } from './prompt-fencing.js';

export { fenceLifecycleUntrustedInput } from './prompt-fencing.js';

/** The required data key prevents accidental interpretation of arbitrary agent output. */
export const LIFECYCLE_SUBAGENT_RESULT_KEY = 'lifecycleResult';

export interface LifecycleSubagentPersonaScope {
  readonly id: string;
  /** Configured lifecycle owner name; distinct from durable persona id. */
  readonly name?: string;
  readonly subagents: readonly string[];
  readonly capabilities: ResolvedCapabilities;
}

/** Trusted dispatch ownership. This is supplied by the native lifecycle dispatcher. */
export interface LifecycleDispatchScope {
  readonly threadId: string;
  readonly persona: LifecycleSubagentPersonaScope;
  /** Approval facts from the dispatcher, not persona policy configuration. */
  readonly approvedCapabilities?: readonly string[];
  /** Required for non-thread aggregates; thread remains the compatibility default. */
  readonly aggregate?: Readonly<{ type: string; id: string }>;
}

export interface SubAgentLifecycleInvocation {
  readonly handler: ResolvedLifecycleHandler;
  readonly scope: LifecycleDispatchScope;
  readonly input: unknown;
  /** Optional dispatcher-captured ceiling; the runner can only reduce it further. */
  readonly maxOutputTokens?: number;
  readonly traceparent?: string;
}

type LifecycleSubagentRunner = Pick<SubAgentRunner, 'execute'>;

const MAX_LIFECYCLE_BOUNDARY_NODES = 512;
const MAX_LIFECYCLE_BOUNDARY_DEPTH = 16;
const MAX_LIFECYCLE_BOUNDARY_ARRAY_LENGTH = 128;
const MAX_LIFECYCLE_BOUNDARY_OBJECT_KEYS = 128;
const MAX_LIFECYCLE_BOUNDARY_STRING_LENGTH = 16_384;

const INVOCATION_KEYS = new Set(['handler', 'scope', 'input', 'maxOutputTokens', 'traceparent']);
const RESOLVED_HANDLER_KEYS = new Set([
  'persona',
  'priority',
  'handler',
  'identity',
  'subscription',
  'budget',
  'failurePolicy',
]);
const SCOPE_KEYS = new Set(['threadId', 'persona', 'approvedCapabilities', 'aggregate']);
const PERSONA_KEYS = new Set(['id', 'name', 'subagents', 'capabilities']);
const CAPABILITIES_KEYS = new Set(['allow', 'requireApproval']);

/**
 * Trusted adapter between registry-resolved lifecycle authority and an
 * untrusted model-backed sub-agent. It never grants a sub-agent repository
 * access and only returns contract-validated proposals for native consumers.
 */
export class SubAgentLifecycleAdapter {
  constructor(private readonly runner: LifecycleSubagentRunner) {}

  async invoke(
    invocation: SubAgentLifecycleInvocation,
  ): Promise<Result<LifecycleHandlerResult, LifecycleError>> {
    try {
      const snapshot = this.materializeInvocation(invocation);
      if (!snapshot) {
        return err(new LifecycleError('lifecycle subagent invocation is malformed'));
      }
      const authorizationError = this.validateInvocation(snapshot);
      if (authorizationError) {
        return err(authorizationError);
      }

      const contract = resolveLifecycleHandlerContract(
        snapshot.handler.handler.inputContract,
        snapshot.handler.handler.outputContract,
      );
      const parsedInput = contract?.parseInput(snapshot.input);
      if (!contract || !parsedInput?.success) {
        return err(new LifecycleError('lifecycle subagent received invalid lifecycle input'));
      }
      if (!this.hasMatchingSubscription(parsedInput.data, snapshot.handler.subscription)) {
        return err(
          new LifecycleError('lifecycle subagent input is not configured for this handler'),
        );
      }
      if (this.hasMismatchedAggregate(parsedInput.data, snapshot.scope)) {
        return err(
          new LifecycleError('lifecycle subagent aggregate is not owned by the dispatch thread'),
        );
      }
      if (
        this.hasMismatchedPayloadPersona(
          parsedInput.data,
          snapshot.scope.persona.name ?? snapshot.scope.persona.id,
        )
      ) {
        return err(
          new LifecycleError('lifecycle subagent payload persona does not match dispatch scope'),
        );
      }

      const { handler, scope } = snapshot;
      const persona = scope.persona;
      // Copy the registry/loader snapshot before crossing into asynchronous
      // model resolution. The runner verifies this exact tuple against its
      // current loaded implementation before resolving a model.
      const expectedIdentity = Object.freeze({ ...handler.identity });
      const capturedHandler = Object.freeze({
        ...handler.handler,
        runtime: Object.freeze({ ...handler.handler.runtime }),
      });
      const result = await this.runner.execute(
        expectedIdentity.implementationRef,
        {
          lifecycle: {
            version: 'v1',
            handlerId: expectedIdentity.handlerId,
            inputContract: expectedIdentity.inputContract,
            outputContract: expectedIdentity.outputContract,
            untrustedInput: fenceLifecycleUntrustedInput(parsedInput.data),
          },
        },
        {
          threadId: scope.threadId,
          personaId: persona.id,
          personaSubagents: [...persona.subagents],
          personaCapabilities: {
            allow: [...persona.capabilities.allow],
            requireApproval: [...persona.capabilities.requireApproval],
          },
          ...(snapshot.traceparent ? { traceparent: snapshot.traceparent } : {}),
          serviceScope: 'none',
          executionLimits: {
            timeoutMs: handler.budget?.timeoutMs ?? DEFAULT_LIFECYCLE_SUBAGENT_TIMEOUT_MS,
            ...(snapshot.maxOutputTokens ? { maxOutputTokens: snapshot.maxOutputTokens } : {}),
          },
          lifecycle: {
            expectedIdentity,
            ...(scope.approvedCapabilities
              ? { approvedCapabilities: Object.freeze([...scope.approvedCapabilities]) }
              : {}),
          },
        },
      );

      const output = this.materializeLifecycleOutput(result);
      if (output === undefined) {
        return err(new LifecycleError('lifecycle subagent execution failed'));
      }

      const parsedOutput = parseLifecycleHandlerResult(capturedHandler, parsedInput.data, output);
      if (!parsedOutput.success) {
        return err(new LifecycleError('lifecycle subagent returned invalid lifecycle output'));
      }

      return ok(parsedOutput.data);
    } catch {
      // This is a public trust boundary. Never surface hostile traps, runner
      // failures, parser errors, or caller-controlled details to dispatchers.
      return err(new LifecycleError('lifecycle subagent execution failed'));
    }
  }

  private validateInvocation(invocation: SubAgentLifecycleInvocation): LifecycleError | undefined {
    const { handler, scope } = invocation;
    const persona = scope.persona;
    const definition = handler.handler;
    const identity = handler.identity;

    if (definition.runtime.kind !== 'subagent' || identity.runtimeKind !== 'subagent') {
      return new LifecycleError('lifecycle handler is not a subagent implementation');
    }
    if (handler.persona !== (persona.name ?? persona.id)) {
      return new LifecycleError('lifecycle handler may only run for its attached persona');
    }
    if (!persona.subagents.includes(identity.implementationRef)) {
      return new LifecycleError(
        'lifecycle subagent is not explicitly assigned to dispatch persona',
      );
    }
    if (
      invocation.maxOutputTokens !== undefined &&
      (!Number.isInteger(invocation.maxOutputTokens) || invocation.maxOutputTokens < 1)
    ) {
      return new LifecycleError('lifecycle subagent maxOutputTokens must be a positive integer');
    }
    if (
      definition.runtime.ref !== identity.implementationRef ||
      definition.id !== identity.handlerId ||
      definition.runtime.implementationVersion !== identity.implementationVersion ||
      definition.mode !== identity.mode ||
      definition.inputContract !== identity.inputContract ||
      definition.outputContract !== identity.outputContract ||
      definition.interceptorSafety !== identity.interceptorSafety ||
      handler.subscription.kind !== definition.mode
    ) {
      return new LifecycleError(
        'lifecycle handler identity does not match its resolved attachment',
      );
    }
    return undefined;
  }

  private hasMismatchedAggregate(input: unknown, scope: LifecycleDispatchScope): boolean {
    if (!input || typeof input !== 'object') {
      return true;
    }
    const context = (input as { context?: { aggregate?: { type?: unknown; id?: unknown } } })
      .context;
    const aggregate = context?.aggregate;
    if (!aggregate || typeof aggregate.type !== 'string' || typeof aggregate.id !== 'string') {
      return true;
    }
    if (aggregate.type === 'thread') {
      return aggregate.id !== scope.threadId;
    }
    return (
      !scope.aggregate ||
      aggregate.type !== scope.aggregate.type ||
      aggregate.id !== scope.aggregate.id
    );
  }

  private hasMismatchedPayloadPersona(input: unknown, personaId: string): boolean {
    if (!input || typeof input !== 'object') {
      return true;
    }
    const candidate = input as { input?: { persona?: unknown } };
    const payloadPersona = candidate.input?.persona;
    return payloadPersona !== undefined && payloadPersona !== personaId;
  }

  /** The adapter must not turn a resolved handler into a wildcard subscription. */
  private hasMatchingSubscription(
    input: unknown,
    subscription: LifecycleSubscriptionContract,
  ): boolean {
    if (!input || typeof input !== 'object') {
      return false;
    }
    const candidate = input as { type?: unknown; hook?: unknown };
    switch (subscription.kind) {
      case 'event':
        return (
          typeof candidate.type === 'string' &&
          subscription.events.some((event) => event.type === candidate.type)
        );
      case 'signal':
        return (
          typeof candidate.type === 'string' &&
          subscription.signals.some((signal) => signal.type === candidate.type)
        );
      case 'interceptor':
        return (
          typeof candidate.hook === 'string' &&
          subscription.interceptors.some((interceptor) => interceptor.hook === candidate.hook)
        );
    }
  }

  private materializeInvocation(
    invocation: SubAgentLifecycleInvocation,
  ): SubAgentLifecycleInvocation | undefined {
    const snapshot = this.cloneData(invocation);
    if (!this.hasExactKeys(snapshot, INVOCATION_KEYS)) return undefined;
    const candidate = snapshot as Record<string, unknown>;
    const handler = this.materializeResolvedHandler(this.ownDataProperty(candidate, 'handler'));
    const scope = this.materializeScope(this.ownDataProperty(candidate, 'scope'));
    const input = this.ownDataProperty(candidate, 'input');
    const maxOutputTokens = this.ownDataProperty(candidate, 'maxOutputTokens');
    const traceparent = this.ownDataProperty(candidate, 'traceparent');
    if (
      !handler ||
      !scope ||
      input === undefined ||
      (maxOutputTokens !== undefined &&
        (typeof maxOutputTokens !== 'number' ||
          !Number.isInteger(maxOutputTokens) ||
          maxOutputTokens < 1)) ||
      (traceparent !== undefined && typeof traceparent !== 'string')
    ) {
      return undefined;
    }
    return Object.freeze({
      handler,
      scope,
      input,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(traceparent === undefined ? {} : { traceparent }),
    });
  }

  private materializeResolvedHandler(value: unknown): ResolvedLifecycleHandler | undefined {
    if (!this.hasExactKeys(value, RESOLVED_HANDLER_KEYS)) return undefined;
    const source = value as Record<string, unknown>;
    const persona = LifecycleFilterOwnerNameSchema.safeParse(
      this.ownDataProperty(source, 'persona'),
    );
    const priority = LifecyclePrioritySchema.safeParse(this.ownDataProperty(source, 'priority'));
    const definition = LifecycleHandlerContractSchema.safeParse(
      this.ownDataProperty(source, 'handler'),
    );
    const identity = LifecycleHandlerIdentityContractSchema.safeParse(
      this.ownDataProperty(source, 'identity'),
    );
    const subscription = LifecycleSubscriptionContractSchema.safeParse(
      this.ownDataProperty(source, 'subscription'),
    );
    const budgetValue = this.ownDataProperty(source, 'budget');
    const budget =
      budgetValue === undefined ? undefined : LifecycleBudgetContractSchema.safeParse(budgetValue);
    const failurePolicy = LifecycleFailurePolicyContractSchema.safeParse(
      this.ownDataProperty(source, 'failurePolicy'),
    );
    if (
      !persona.success ||
      !priority.success ||
      !definition.success ||
      !identity.success ||
      !subscription.success ||
      (budget !== undefined && !budget.success) ||
      !failurePolicy.success
    ) {
      return undefined;
    }
    return Object.freeze({
      persona: persona.data,
      priority: priority.data,
      handler: Object.freeze({
        ...definition.data,
        runtime: Object.freeze({ ...definition.data.runtime }),
      }),
      identity: Object.freeze({ ...identity.data }),
      subscription: Object.freeze(subscription.data),
      ...(budget === undefined ? {} : { budget: Object.freeze({ ...budget.data }) }),
      failurePolicy: Object.freeze({ ...failurePolicy.data }),
    });
  }

  private materializeScope(value: unknown): LifecycleDispatchScope | undefined {
    if (!this.hasExactKeys(value, SCOPE_KEYS)) return undefined;
    const source = value as Record<string, unknown>;
    const threadId = LifecycleFilterOwnerNameSchema.safeParse(
      this.ownDataProperty(source, 'threadId'),
    );
    const persona = this.materializePersonaScope(this.ownDataProperty(source, 'persona'));
    const approvedCapabilities = this.materializeStringArray(
      this.ownDataProperty(source, 'approvedCapabilities'),
    );
    const hasApprovedCapabilities = Object.hasOwn(source, 'approvedCapabilities');
    const aggregateValue = this.ownDataProperty(source, 'aggregate');
    const hasAggregate = Object.hasOwn(source, 'aggregate');
    const aggregate =
      aggregateValue === undefined
        ? undefined
        : LifecycleAggregateIdentitySchema.safeParse(aggregateValue);
    const materializedAggregate =
      aggregate?.success === true
        ? (Object.freeze({
            type: aggregate.data.type,
            id: aggregate.data.id,
          }) as Readonly<{ type: string; id: string }>)
        : undefined;
    if (
      !threadId.success ||
      !persona ||
      (hasApprovedCapabilities && !approvedCapabilities) ||
      (hasAggregate && !materializedAggregate)
    ) {
      return undefined;
    }
    return Object.freeze({
      threadId: threadId.data,
      persona,
      ...(approvedCapabilities === undefined ? {} : { approvedCapabilities }),
      ...(materializedAggregate === undefined ? {} : { aggregate: materializedAggregate }),
    });
  }

  private materializePersonaScope(value: unknown): LifecycleSubagentPersonaScope | undefined {
    if (!this.hasExactKeys(value, PERSONA_KEYS)) return undefined;
    const source = value as Record<string, unknown>;
    const id = LifecycleFilterOwnerNameSchema.safeParse(this.ownDataProperty(source, 'id'));
    const subagents = this.materializeStringArray(this.ownDataProperty(source, 'subagents'));
    const capabilities = this.materializeCapabilities(this.ownDataProperty(source, 'capabilities'));
    const nameValue = this.ownDataProperty(source, 'name');
    const name =
      nameValue === undefined ? undefined : LifecycleFilterOwnerNameSchema.safeParse(nameValue);
    if (!id.success || !subagents || !capabilities || (name !== undefined && !name.success))
      return undefined;
    return Object.freeze({
      id: id.data,
      ...(name?.success ? { name: name.data } : {}),
      subagents,
      capabilities,
    });
  }

  private materializeCapabilities(value: unknown): ResolvedCapabilities | undefined {
    if (!this.hasExactKeys(value, CAPABILITIES_KEYS)) return undefined;
    const source = value as Record<string, unknown>;
    const allow = this.materializeStringArray(this.ownDataProperty(source, 'allow'));
    const requireApproval = this.materializeStringArray(
      this.ownDataProperty(source, 'requireApproval'),
    );
    if (!allow || !requireApproval) return undefined;
    const capabilities: ResolvedCapabilities = {
      allow: [...allow],
      requireApproval: [...requireApproval],
    };
    return Object.freeze(capabilities);
  }

  private materializeStringArray(value: unknown): readonly string[] | undefined {
    if (
      types.isProxy(value) ||
      !Array.isArray(value) ||
      value.length > MAX_LIFECYCLE_BOUNDARY_ARRAY_LENGTH
    ) {
      return undefined;
    }
    const copied: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const entry = this.ownDataProperty(value, String(index));
      if (typeof entry !== 'string' || entry.length > MAX_LIFECYCLE_BOUNDARY_STRING_LENGTH) {
        return undefined;
      }
      copied.push(entry);
    }
    return Object.freeze(copied);
  }

  private hasExactKeys(value: unknown, allowedKeys: ReadonlySet<string>): value is object {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) {
      return false;
    }
    try {
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      ) {
        return false;
      }
      const keys = Reflect.ownKeys(value);
      return (
        keys.length <= allowedKeys.size &&
        keys.every((key) => typeof key === 'string' && allowedKeys.has(key))
      );
    } catch {
      return false;
    }
  }

  /** Read a runner Result without invoking getters, proxies, or Result methods. */
  private materializeLifecycleOutput(result: unknown): unknown {
    if (!result || typeof result !== 'object' || types.isProxy(result)) return undefined;
    const value = this.ownDataProperty(result, 'value');
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const data = this.ownDataProperty(value, 'data');
    if (!data || typeof data !== 'object' || types.isProxy(data)) return undefined;
    const output = this.ownDataProperty(data, LIFECYCLE_SUBAGENT_RESULT_KEY);
    return output === undefined ? undefined : this.cloneData(output);
  }

  private ownDataProperty(source: object, key: PropertyKey): unknown {
    try {
      if (types.isProxy(source)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Bounded detached JSON snapshot for authority and model output boundaries. */
  private cloneData(value: unknown): unknown {
    try {
      const seen = new WeakSet<object>();
      let nodes = 0;
      const clone = (candidate: unknown, depth: number): unknown => {
        if (depth > MAX_LIFECYCLE_BOUNDARY_DEPTH || ++nodes > MAX_LIFECYCLE_BOUNDARY_NODES) {
          return undefined;
        }
        if (candidate === null || typeof candidate === 'boolean') {
          return candidate;
        }
        if (typeof candidate === 'string') {
          return candidate.length <= MAX_LIFECYCLE_BOUNDARY_STRING_LENGTH ? candidate : undefined;
        }
        if (typeof candidate === 'number')
          return Number.isFinite(candidate) ? candidate : undefined;
        if (!candidate || typeof candidate !== 'object' || types.isProxy(candidate))
          return undefined;
        if (seen.has(candidate)) return undefined;
        seen.add(candidate);
        if (Array.isArray(candidate)) {
          const length = this.ownDataProperty(candidate, 'length');
          if (
            typeof length !== 'number' ||
            !Number.isSafeInteger(length) ||
            length > MAX_LIFECYCLE_BOUNDARY_ARRAY_LENGTH
          ) {
            return undefined;
          }
          const result: unknown[] = [];
          for (let index = 0; index < length; index += 1) {
            const entry = this.ownDataProperty(candidate, String(index));
            const copied = clone(entry, depth + 1);
            if (copied === undefined) return undefined;
            result.push(copied);
          }
          return Object.freeze(result);
        }
        if (
          Object.getPrototypeOf(candidate) !== Object.prototype &&
          Object.getPrototypeOf(candidate) !== null
        ) {
          return undefined;
        }
        const keys = Reflect.ownKeys(candidate);
        if (keys.length > MAX_LIFECYCLE_BOUNDARY_OBJECT_KEYS) return undefined;
        const result = Object.create(null) as Record<string, unknown>;
        for (const key of keys) {
          if (typeof key !== 'string') return undefined;
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
          if (descriptor.value === undefined) return undefined;
          const copied = clone(descriptor.value, depth + 1);
          if (copied === undefined) return undefined;
          Object.defineProperty(result, key, {
            configurable: false,
            enumerable: true,
            value: copied,
            writable: false,
          });
        }
        return Object.freeze(result);
      };
      return clone(value, 0);
    } catch {
      return undefined;
    }
  }
}
