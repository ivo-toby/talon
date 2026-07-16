/**
 * Sub-agent runner — the core orchestrator for sub-agent execution.
 *
 * Validates that the requested sub-agent exists, is assigned to the calling
 * persona, and that the persona's capabilities satisfy the sub-agent's
 * requirements. Then resolves the model, assembles the system prompt from
 * prompt fragments, and invokes the sub-agent's run function with a timeout.
 */

import { ok, err, type Result } from 'neverthrow';
import { types } from 'node:util';
import type { LanguageModel } from 'ai';
import type {
  LoadedSubAgent,
  LifecycleSubAgentContext,
  LifecycleSubAgentRunFn,
  LifecycleSubAgentServices,
  SubAgentContext,
  SubAgentInput,
  SubAgentResult,
  SubAgentRunFn,
  SubAgentServices,
} from './subagent-types.js';
import type { ModelResolver } from './model-resolver.js';
import type { ResolvedCapabilities } from '../personas/persona-types.js';
import { ToolError } from '../core/errors/index.js';
import { extractCapabilityPrefix } from '../tools/tool-filter.js';
import { createChildLogger } from '../core/logging/index.js';
import type pino from 'pino';
import type {
  ObservationHandle,
  ObservabilityService,
} from '../observability/langfuse/observability-types.js';
import { NoopObservabilityService } from '../observability/langfuse/noop-observability.js';
import type { SubAgentsConfig } from '../core/config/config-types.js';
import { wrapProviderOptions } from './provider-options.js';
import {
  LifecycleHandlerIdentityContractSchema,
  resolveLifecycleHandlerContract,
  type LifecycleHandlerIdentityContract,
} from '../lifecycle/contracts/index.js';

/** A lifecycle invocation must always have a finite end-to-end deadline. */
export const DEFAULT_LIFECYCLE_SUBAGENT_TIMEOUT_MS = 30_000;
/** Prevent an unbounded config fallback chain from extending lifecycle work. */
export const MAX_LIFECYCLE_SUBAGENT_MODEL_ATTEMPTS = 3;
const MAX_LIFECYCLE_CAPABILITY_LABELS = 128;

interface LifecycleExecutionSnapshot {
  readonly agent: Readonly<{
    manifest: Readonly<{
      name: string;
      version: string;
      model: Readonly<{ provider: string; name: string; maxTokens: number }>;
      requiredCapabilities: readonly string[];
      rootPaths: readonly string[];
      timeoutMs: number;
    }>;
    promptContents: readonly string[];
    run: LifecycleSubAgentRunFn;
    lifecycleCapabilities: readonly Readonly<{
      mode: 'event' | 'signal' | 'interceptor';
      inputContract: string;
      outputContract: string;
      interceptorSafety?: 'advisory' | 'enforcing';
    }>[];
  }>;
  readonly expectedIdentity: LifecycleHandlerIdentityContract;
  readonly personaCapabilities: Readonly<{
    allow: readonly string[];
    requireApproval: readonly string[];
  }>;
  readonly approvedCapabilities: readonly string[];
  /** Immutable invocation policy; callers cannot widen it after dispatch begins. */
  readonly threadId: string;
  readonly personaId: string;
  readonly personaSubagents: readonly string[];
  readonly executionLimits: Readonly<{
    maxOutputTokens?: number;
    timeoutMs?: number;
  }>;
  readonly traceparent?: string;
}

type InvocationContextClassification =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'lifecycle'; readonly snapshot: LifecycleExecutionSnapshot }
  | { readonly kind: 'invalid' };

// ---------------------------------------------------------------------------
// Timeout sentinel
// ---------------------------------------------------------------------------

class SubAgentTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(name: string, timeoutMs: number) {
    super(`Sub-agent "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'SubAgentTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Invoke context
// ---------------------------------------------------------------------------

/**
 * Context provided by the caller (tool handler) when invoking a sub-agent.
 * Contains the identity and policy information needed for validation.
 */
export interface SubAgentInvokeContext {
  threadId: string;
  personaId: string;
  personaSubagents: string[];
  personaCapabilities: ResolvedCapabilities;
  traceparent?: string;
  /** Additional caller-imposed bounds which can only reduce manifest/config limits. */
  executionLimits?: {
    maxOutputTokens?: number;
    timeoutMs?: number;
  };
  /** Lifecycle handlers reason over data only and must not receive repositories. */
  serviceScope?: 'full' | 'none';
  /**
   * Present only for trusted lifecycle dispatch. It binds execution to the
   * loader snapshot captured by the registry, and changes lifecycle policy
   * without changing ordinary sub-agent compatibility.
   */
  lifecycle?: {
    expectedIdentity: LifecycleHandlerIdentityContract;
    /** Explicit dispatcher approval, never inferred from requireApproval. */
    approvedCapabilities?: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class SubAgentRunner {
  private readonly agents: Map<string, LoadedSubAgent>;
  private readonly modelResolver: ModelResolver;
  private readonly services: SubAgentServices;
  private readonly logger: pino.Logger;
  private readonly observability: ObservabilityService;

  constructor(
    agents: Map<string, LoadedSubAgent>,
    modelResolver: ModelResolver,
    services: SubAgentServices,
    logger: pino.Logger,
    observability: ObservabilityService = new NoopObservabilityService(),
    private readonly subagentOverrides: SubAgentsConfig = {},
  ) {
    this.agents = agents;
    this.modelResolver = modelResolver;
    this.services = services;
    this.logger = logger;
    this.observability = observability;
  }

  /**
   * Execute a sub-agent by name.
   *
   * Validates assignment and capabilities, resolves the model, assembles
   * the system prompt, and runs the sub-agent with a timeout.
   */
  async execute(
    name: string,
    input: SubAgentInput,
    ctx: SubAgentInvokeContext,
  ): Promise<Result<SubAgentResult, ToolError>> {
    // Classification is an authority boundary. A malformed context must not
    // fall through to ordinary execution, and checking a proxy must not run
    // its traps. Lifecycle calls receive an immutable snapshot before any
    // observability code can defer their callback.
    let classification: InvocationContextClassification;
    try {
      classification = this.classifyInvocationContext(name, ctx);
    } catch {
      // Classification includes untrusted nested context values. Keep every
      // failure at this authority boundary inside the typed Result contract.
      return err(new ToolError('Lifecycle sub-agent execution failed'));
    }
    if (classification.kind === 'invalid') {
      return err(new ToolError('Lifecycle sub-agent execution failed'));
    }
    const lifecycleSnapshot =
      classification.kind === 'lifecycle' ? classification.snapshot : undefined;
    const lifecycleRequested = lifecycleSnapshot !== undefined;
    const lifecycleDeadline = lifecycleSnapshot
      ? this.executionDeadline(
          lifecycleSnapshot.executionLimits.timeoutMs ?? DEFAULT_LIFECYCLE_SUBAGENT_TIMEOUT_MS,
        )
      : undefined;

    try {
      const lifecycleMetadata = this.lifecycleMetadata(lifecycleSnapshot);
      const observationInput = {
        type: 'agent' as const,
        name: `subagent:${name}`,
        // Lifecycle payloads can contain message and tool material. Telemetry
        // receives stable identity metadata only, never inputs or summaries.
        input: lifecycleRequested ? { lifecycle: lifecycleMetadata } : input,
        metadata: {
          threadId: lifecycleSnapshot ? lifecycleSnapshot.threadId : ctx.threadId,
          personaId: lifecycleSnapshot ? lifecycleSnapshot.personaId : ctx.personaId,
          ...(lifecycleMetadata ? { lifecycle: lifecycleMetadata } : {}),
        },
      };
      const observeFn = (observation: ObservationHandle): Promise<SubAgentResult> => {
        const callback = (async (): Promise<SubAgentResult> => {
          // A deferred observer must not turn a timed-out lifecycle dispatch
          // into late model work. Reject so an observer cannot turn an expired
          // callback into a successful empty result; the catch below contains
          // a discarded late callback rejection.
          if (lifecycleDeadline !== undefined && this.remainingTimeoutMs(lifecycleDeadline) === 0) {
            throw new SubAgentTimeoutError(name, 0);
          }
          const executeResult = await this.executeInternal(
            name,
            input,
            ctx,
            lifecycleSnapshot,
            lifecycleDeadline,
          );
          if (executeResult.isErr()) {
            throw executeResult.error;
          }
          const { _model, _modelSource, ...value } = executeResult.value;
          if (lifecycleDeadline !== undefined && this.remainingTimeoutMs(lifecycleDeadline) === 0) {
            throw new SubAgentTimeoutError(name, 0);
          }
          observation.update({
            output: lifecycleRequested ? { lifecycle: { outcome: 'completed' } } : value,
            model: _model,
            metadata: {
              modelSource: _modelSource,
              ...(lifecycleMetadata ? { lifecycle: lifecycleMetadata } : {}),
            },
          });
          if (lifecycleDeadline !== undefined && this.remainingTimeoutMs(lifecycleDeadline) === 0) {
            throw new SubAgentTimeoutError(name, 0);
          }
          return value;
        })();
        // Keep the observer's returned promise intact while ensuring a broken
        // observer that discards it cannot cause an unhandled late rejection.
        void callback.catch(() => undefined);
        return callback;
      };

      const traceparent = lifecycleSnapshot ? lifecycleSnapshot.traceparent : ctx.traceparent;
      if (lifecycleDeadline !== undefined && this.remainingTimeoutMs(lifecycleDeadline) === 0) {
        throw new SubAgentTimeoutError(name, 0);
      }
      // Install the deadline before passing control to an observer. An
      // observer can invoke its callback or settle synchronously, including
      // at the exact deadline, so it must never get a chance to win a race
      // merely because the timer was registered afterwards.
      let settleObserved: (value: SubAgentResult | PromiseLike<SubAgentResult>) => void;
      let rejectObserved: (reason?: unknown) => void;
      const observed = new Promise<SubAgentResult>((resolve, reject) => {
        settleObserved = resolve;
        rejectObserved = reject;
      });
      const deadlineBoundObserved =
        lifecycleDeadline === undefined
          ? observed
          : this.waitForDeadline(observed, this.remainingTimeoutMs(lifecycleDeadline) ?? 0, name);
      try {
        const observerSettlement = traceparent
          ? this.observability.observeWithTraceparent(traceparent, observationInput, observeFn)
          : this.observability.observe(observationInput, observeFn);
        void Promise.resolve(observerSettlement).then(settleObserved!, rejectObserved!);
      } catch (error) {
        rejectObserved!(error);
      }

      const result = await deadlineBoundObserved;
      if (lifecycleDeadline !== undefined && this.remainingTimeoutMs(lifecycleDeadline) === 0) {
        throw new SubAgentTimeoutError(name, 0);
      }

      return ok(result);
    } catch (error) {
      const message = lifecycleRequested
        ? 'Lifecycle sub-agent execution failed'
        : error instanceof Error
          ? error.message
          : String(error);
      return err(
        !lifecycleRequested && error instanceof ToolError
          ? error
          : new ToolError(
              message,
              lifecycleRequested ? undefined : error instanceof Error ? error : undefined,
            ),
      );
    }
  }

  private async executeInternal(
    name: string,
    input: SubAgentInput,
    ctx: SubAgentInvokeContext,
    lifecycleSnapshot?: LifecycleExecutionSnapshot,
    lifecycleDeadline?: number,
  ): Promise<Result<SubAgentResult & { _model?: string; _modelSource?: string }, ToolError>> {
    // 1. Sub-agent must exist (was loaded)
    const agent = lifecycleSnapshot ? lifecycleSnapshot.agent : this.agents.get(name);
    if (!agent) {
      return err(new ToolError(`Unknown sub-agent "${name}"`));
    }

    const execution = agent;
    const lifecycle = lifecycleSnapshot !== undefined;

    const lifecycleIdentityError = this.validateLifecycleIdentity(
      name,
      execution,
      lifecycleSnapshot ? lifecycleSnapshot.expectedIdentity : undefined,
    );
    if (lifecycleIdentityError) {
      return err(lifecycleIdentityError);
    }

    // 2. Sub-agent must be in persona's assignment list
    const personaSubagents = lifecycle ? lifecycleSnapshot.personaSubagents : ctx.personaSubagents;
    const personaId = lifecycle ? lifecycleSnapshot.personaId : ctx.personaId;
    if (!personaSubagents.includes(name)) {
      return err(new ToolError(`Sub-agent "${name}" is not assigned to persona "${personaId}"`));
    }

    // 3. Persona capabilities must satisfy sub-agent's required capabilities
    const unsatisfied = lifecycleSnapshot
      ? this.findUnsatisfiedLifecycleCapabilities(
          execution.manifest.requiredCapabilities,
          lifecycleSnapshot.personaCapabilities,
          lifecycleSnapshot.approvedCapabilities,
        )
      : this.findUnsatisfiedCapabilities(
          execution.manifest.requiredCapabilities,
          ctx.personaCapabilities,
        );
    if (unsatisfied.length > 0) {
      return err(
        new ToolError(
          lifecycle
            ? 'Lifecycle sub-agent capabilities are not authorized by the dispatch scope'
            : `Persona "${ctx.personaId}" lacks capabilities required by sub-agent "${name}": ${unsatisfied.join(', ')}`,
        ),
      );
    }

    // 4. Build model chain: config overrides (if any) + manifest fallback
    const overrideConfig = this.subagentOverrides[name];
    const modelChain: Array<{
      provider: string;
      name: string;
      maxTokens: number;
      timeoutMs: number;
      providerOptions?: Record<string, unknown>;
      source: string;
    }> = [];

    if (overrideConfig) {
      for (const entry of overrideConfig.model) {
        modelChain.push({
          provider: entry.provider,
          name: entry.name,
          maxTokens: entry.maxTokens ?? execution.manifest.model.maxTokens,
          timeoutMs: entry.timeoutMs ?? execution.manifest.timeoutMs,
          providerOptions: entry.providerOptions,
          source: 'override',
        });
      }
    }

    // Always append manifest model as final fallback
    modelChain.push({
      provider: execution.manifest.model.provider,
      name: execution.manifest.model.name,
      maxTokens: execution.manifest.model.maxTokens,
      timeoutMs: execution.manifest.timeoutMs,
      source: 'manifest',
    });

    // Build once — these don't depend on which model is being tried.
    const systemPrompt = execution.promptContents.join('\n\n');
    const childLogger = createChildLogger(this.logger, {
      tool: `subagent:${name}`,
      threadId: lifecycle ? lifecycleSnapshot.threadId : ctx.threadId,
      persona: lifecycle ? lifecycleSnapshot.personaId : ctx.personaId,
    });

    const failures: string[] = [];
    const executionLimits = lifecycle ? lifecycleSnapshot.executionLimits : ctx.executionLimits;
    const deadline = lifecycle
      ? lifecycleDeadline
      : this.executionDeadline(executionLimits?.timeoutMs);

    const attemptChain = lifecycle
      ? modelChain.slice(0, MAX_LIFECYCLE_SUBAGENT_MODEL_ATTEMPTS)
      : modelChain;
    for (const [attemptIndex, modelEntry] of attemptChain.entries()) {
      if (this.remainingTimeoutMs(deadline) === 0) {
        return err(this.allModelsFailedError(name, lifecycle, failures, executionLimits));
      }

      const maxOutputTokens = this.limitMaxOutputTokens(
        modelEntry.maxTokens,
        executionLimits?.maxOutputTokens,
      );
      // Resolve model
      let modelResult: Awaited<ReturnType<ModelResolver['resolve']>>;
      try {
        modelResult = await this.resolveModelWithDeadline(
          {
            provider: modelEntry.provider,
            name: modelEntry.name,
            maxTokens: maxOutputTokens,
          },
          this.remainingTimeoutMs(deadline),
          name,
        );
      } catch (error) {
        if (error instanceof SubAgentTimeoutError) {
          if (lifecycle) {
            return err(new ToolError(this.timeoutDiagnostic(name, lifecycle, executionLimits)));
          }
          const timeoutError = new SubAgentTimeoutError(
            name,
            executionLimits?.timeoutMs ?? error.timeoutMs,
          );
          failures.push(
            this.failureDiagnostic(
              false,
              modelEntry.provider,
              modelEntry.name,
              modelEntry.source,
              timeoutError,
            ),
          );
          if (attemptIndex + 1 < attemptChain.length) {
            this.logger.warn(
              {
                subagent: name,
                model: `${modelEntry.provider}/${modelEntry.name}`,
                timeoutMs: timeoutError.timeoutMs,
              },
              'Model resolution timed out, failing over to next model',
            );
            continue;
          }
          continue;
        }
        return err(
          new ToolError(lifecycle ? 'Lifecycle sub-agent execution failed' : String(error)),
        );
      }

      if (modelResult.isErr()) {
        if (this.remainingTimeoutMs(deadline) === 0) {
          return err(new ToolError(this.timeoutDiagnostic(name, lifecycle, executionLimits)));
        }
        const failMsg = this.failureDiagnostic(
          lifecycle,
          modelEntry.provider,
          modelEntry.name,
          modelEntry.source,
          modelResult.error,
        );
        failures.push(failMsg);
        if (attemptIndex + 1 < attemptChain.length) {
          this.logger.warn(
            this.lifecycleLogContext(lifecycle, {
              subagent: name,
              model: `${modelEntry.provider}/${modelEntry.name}`,
              source: modelEntry.source,
            }),
            lifecycle
              ? 'Lifecycle model resolution failed, trying next'
              : `Model resolution failed, trying next: ${modelResult.error.message}`,
          );
        }
        continue;
      }

      const model: LanguageModel = modelResult.value;
      const remainingTimeoutMs = this.remainingTimeoutMs(deadline);
      if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
        return err(new ToolError(this.timeoutDiagnostic(name, lifecycle, executionLimits)));
      }
      const timeoutMs = this.limitTimeoutMs(modelEntry.timeoutMs, remainingTimeoutMs);

      // Per-model AbortController for timeout cancellation
      const abortController = new AbortController();

      const wrappedProviderOptions = wrapProviderOptions(
        modelEntry.provider,
        modelEntry.providerOptions,
        childLogger,
        { subagent: name, source: modelEntry.source },
      );

      let agentContext: import('./subagent-types.js').SubAgentContext | LifecycleSubAgentContext;
      if (lifecycle) {
        agentContext = {
          threadId: lifecycleSnapshot.threadId,
          personaId: lifecycleSnapshot.personaId,
          systemPrompt,
          model,
          maxOutputTokens,
          rootPaths: [],
          services: { logger: childLogger } satisfies LifecycleSubAgentServices,
          telemetry: { isEnabled: false },
          abortSignal: abortController.signal,
          providerOptions: wrappedProviderOptions,
        };
      } else if (ctx.serviceScope === 'none') {
        agentContext = {
          threadId: ctx.threadId,
          personaId: ctx.personaId,
          systemPrompt,
          model,
          maxOutputTokens,
          rootPaths: [],
          services: { logger: childLogger } satisfies LifecycleSubAgentServices,
          telemetry: { isEnabled: false },
          abortSignal: abortController.signal,
          providerOptions: wrappedProviderOptions,
        };
      } else {
        agentContext = {
          threadId: ctx.threadId,
          personaId: ctx.personaId,
          systemPrompt,
          model,
          maxOutputTokens,
          rootPaths: [...execution.manifest.rootPaths],
          services: { ...this.services, logger: childLogger },
          telemetry: { isEnabled: !(this.observability instanceof NoopObservabilityService) },
          abortSignal: abortController.signal,
          providerOptions: wrappedProviderOptions,
        };
      }

      try {
        if (this.remainingTimeoutMs(deadline) === 0) {
          return err(new ToolError(this.timeoutDiagnostic(name, lifecycle, executionLimits)));
        }
        const run = execution.run;
        const runResult = await this.runWithTimeout(
          lifecycle
            ? (run as LifecycleSubAgentRunFn)(agentContext as LifecycleSubAgentContext, input)
            : (run as SubAgentRunFn)(agentContext as SubAgentContext, input),
          timeoutMs,
          name,
          abortController,
        );

        if (runResult.isErr()) {
          const failMsg = this.failureDiagnostic(
            lifecycle,
            modelEntry.provider,
            modelEntry.name,
            modelEntry.source,
            runResult.error,
          );
          failures.push(failMsg);
          this.logger.warn(
            this.lifecycleLogContext(lifecycle, {
              subagent: name,
              model: `${modelEntry.provider}/${modelEntry.name}`,
            }),
            lifecycle
              ? 'Lifecycle sub-agent run failed, trying next'
              : `Sub-agent run failed, trying next: ${runResult.error.message}`,
          );
          continue;
        }

        const modelLabel = `${modelEntry.provider}/${modelEntry.name}`;
        if (failures.length > 0) {
          this.logger.info(
            this.lifecycleLogContext(lifecycle, {
              subagent: name,
              model: modelLabel,
              source: modelEntry.source,
              failedAttempts: failures.length,
            }),
            'Sub-agent succeeded after failover',
          );
        } else {
          this.logger.info(
            this.lifecycleLogContext(lifecycle, {
              subagent: name,
              model: modelLabel,
              source: modelEntry.source,
            }),
            'Sub-agent completed',
          );
        }

        return ok({ ...runResult.value, _model: modelLabel, _modelSource: modelEntry.source });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failMsg = this.failureDiagnostic(
          lifecycle,
          modelEntry.provider,
          modelEntry.name,
          modelEntry.source,
          error,
        );
        failures.push(failMsg);

        if (error instanceof SubAgentTimeoutError) {
          if (lifecycle) {
            this.logger.warn(
              this.lifecycleLogContext(lifecycle, {
                subagent: name,
                model: `${modelEntry.provider}/${modelEntry.name}`,
                timeoutMs,
              }),
              'Sub-agent timed out; lifecycle execution will not overlap a failover attempt',
            );
            return err(new ToolError(this.timeoutDiagnostic(name, lifecycle, executionLimits)));
          }
          if (attemptIndex + 1 < attemptChain.length) {
            this.logger.warn(
              this.lifecycleLogContext(lifecycle, {
                subagent: name,
                model: `${modelEntry.provider}/${modelEntry.name}`,
                timeoutMs,
              }),
              'Sub-agent timed out, failing over to next model',
            );
            continue;
          }
          continue;
        }

        this.logger.warn(
          this.lifecycleLogContext(lifecycle, {
            subagent: name,
            model: `${modelEntry.provider}/${modelEntry.name}`,
          }),
          lifecycle
            ? 'Lifecycle sub-agent execution threw, trying next'
            : `Sub-agent execution threw, trying next: ${message}`,
        );
        continue;
      }
    }

    // All models exhausted
    return err(this.allModelsFailedError(name, lifecycle, failures, executionLimits));
  }

  /**
   * Returns the list of required capability prefixes that are not satisfied
   * by the persona's capabilities.
   */
  private findUnsatisfiedCapabilities(
    required: readonly string[],
    capabilities: Readonly<{ allow: readonly string[]; requireApproval: readonly string[] }>,
  ): string[] {
    const allLabels = [...capabilities.allow, ...capabilities.requireApproval];

    // Build a set of capability prefixes the persona has
    const personaPrefixes = new Set<string>();
    for (const label of allLabels) {
      const prefix = extractCapabilityPrefix(label);
      if (prefix !== null) {
        personaPrefixes.add(prefix);
      }
    }

    // Check each required capability
    const unsatisfied: string[] = [];
    for (const req of required) {
      const reqPrefix = extractCapabilityPrefix(req);
      if (reqPrefix === null) {
        // Malformed capability label — treat as unsatisfied
        unsatisfied.push(req);
        continue;
      }
      if (!personaPrefixes.has(reqPrefix)) {
        unsatisfied.push(req);
      }
    }

    return unsatisfied;
  }

  /** Lifecycle grants are exact/scope-aware and never infer an approval. */
  private findUnsatisfiedLifecycleCapabilities(
    required: readonly string[],
    capabilities: Readonly<{ allow: readonly string[]; requireApproval: readonly string[] }>,
    approvedCapabilities: readonly string[] = [],
  ): string[] {
    return required.filter((requirement) => {
      const approvalPolicies = capabilities.requireApproval.filter((policy) =>
        this.isLifecycleCapabilityCompatible(requirement, policy),
      );
      if (approvalPolicies.length > 0) {
        return !approvalPolicies.some((policy) => approvedCapabilities.includes(policy));
      }
      return !capabilities.allow.some((grant) =>
        this.isLifecycleCapabilityCompatible(requirement, grant),
      );
    });
  }

  private isLifecycleCapabilityCompatible(requirement: string, grant: string): boolean {
    const parse = (value: string): { prefix: string; scope?: string } | undefined => {
      const match = /^(\w+\.\w+)(?::(\w+|\*))?$/.exec(value);
      return match ? { prefix: match[1], ...(match[2] ? { scope: match[2] } : {}) } : undefined;
    };
    const required = parse(requirement);
    const allowed = parse(grant);
    if (!required || !allowed || required.prefix !== allowed.prefix) {
      return false;
    }
    // Scope-less requirements are not silently upgraded by a narrowly scoped
    // grant; a wildcard explicitly covers every scope.
    if (required.scope === undefined) {
      return allowed.scope === undefined || allowed.scope === '*';
    }
    return allowed.scope === required.scope || allowed.scope === '*';
  }

  private validateLifecycleIdentity(
    name: string,
    agent: Readonly<{
      manifest: Readonly<{
        name: string;
        version: string;
        requiredCapabilities: readonly string[];
      }>;
      lifecycleCapabilities?: readonly Readonly<{
        mode: 'event' | 'signal' | 'interceptor';
        inputContract: string;
        outputContract: string;
        interceptorSafety?: 'advisory' | 'enforcing';
      }>[];
    }>,
    expected: LifecycleHandlerIdentityContract | undefined,
  ): ToolError | undefined {
    if (!expected) {
      return undefined;
    }
    if (
      expected.runtimeKind !== 'subagent' ||
      expected.implementationRef !== name ||
      agent.manifest.name !== expected.implementationRef ||
      agent.manifest.version !== expected.implementationVersion
    ) {
      return new ToolError(
        'Lifecycle sub-agent identity no longer matches the loaded implementation',
      );
    }

    const exactCapability = agent.lifecycleCapabilities?.some(
      (capability) =>
        capability.mode === expected.mode &&
        capability.inputContract === expected.inputContract &&
        capability.outputContract === expected.outputContract &&
        capability.interceptorSafety === expected.interceptorSafety,
    );
    if (!exactCapability) {
      return new ToolError(
        'Lifecycle sub-agent capability no longer matches the captured lifecycle contract',
      );
    }
    return undefined;
  }

  private lifecycleMetadata(
    snapshot: LifecycleExecutionSnapshot | undefined,
  ): Record<string, string> | undefined {
    const identity = snapshot?.expectedIdentity;
    if (!identity) {
      return undefined;
    }
    return {
      handlerId: identity.handlerId,
      implementationRef: identity.implementationRef,
      implementationVersion: identity.implementationVersion,
      mode: identity.mode,
      inputContract: identity.inputContract,
      outputContract: identity.outputContract,
    };
  }

  private failureDiagnostic(
    lifecycle: boolean,
    provider: string,
    model: string,
    source: string,
    error: unknown,
  ): string {
    if (lifecycle) {
      return `${provider}/${model} (${source}): failed`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `${provider}/${model} (${source}): ${message}`;
  }

  private allModelsFailedError(
    name: string,
    lifecycle: boolean,
    failures: readonly string[],
    executionLimits: Readonly<{ timeoutMs?: number }> | undefined,
  ): ToolError {
    if (lifecycle) return new ToolError('Lifecycle sub-agent execution failed');
    if (failures.length === 0) {
      return new ToolError(this.timeoutDiagnostic(name, false, executionLimits));
    }
    return new ToolError(
      `All models failed for sub-agent "${name}":\n  ${failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n  ')}`,
    );
  }

  private timeoutDiagnostic(
    name: string,
    lifecycle: boolean,
    executionLimits: Readonly<{ timeoutMs?: number }> | undefined,
  ): string {
    if (lifecycle) {
      return 'Lifecycle sub-agent execution timed out';
    }
    return `Sub-agent "${name}" timed out after ${executionLimits?.timeoutMs}ms`;
  }

  private lifecycleLogContext(
    lifecycle: boolean,
    ordinary: Record<string, unknown>,
  ): Record<string, unknown> {
    return lifecycle ? { subagent: ordinary.subagent, lifecycle: true } : ordinary;
  }

  /**
   * Race the given promise against a timeout.
   * Aborts the controller when the timeout fires, then rejects with SubAgentTimeoutError.
   */
  private async runWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    name: string,
    abortController: AbortController,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        reject(new SubAgentTimeoutError(name, timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  private executionDeadline(timeoutMs: number | undefined): number | undefined {
    const effectiveTimeoutMs = timeoutMs;
    return typeof effectiveTimeoutMs === 'number' &&
      Number.isFinite(effectiveTimeoutMs) &&
      effectiveTimeoutMs > 0
      ? Date.now() + Math.floor(effectiveTimeoutMs)
      : undefined;
  }

  private remainingTimeoutMs(deadline: number | undefined): number | undefined {
    return deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
  }

  private limitTimeoutMs(modelTimeoutMs: number, remainingTimeoutMs: number | undefined): number {
    return remainingTimeoutMs === undefined
      ? modelTimeoutMs
      : Math.min(modelTimeoutMs, remainingTimeoutMs);
  }

  private limitMaxOutputTokens(
    modelMaxTokens: number,
    requestedMaxTokens: number | undefined,
  ): number {
    return typeof requestedMaxTokens === 'number' && Number.isFinite(requestedMaxTokens)
      ? Math.min(modelMaxTokens, Math.max(1, Math.floor(requestedMaxTokens)))
      : modelMaxTokens;
  }

  private async resolveModelWithDeadline(
    model: { provider: string; name: string; maxTokens: number },
    timeoutMs: number | undefined,
    name: string,
  ): ReturnType<ModelResolver['resolve']> {
    const resolution = this.modelResolver.resolve(model);
    if (timeoutMs === undefined) {
      return resolution;
    }
    // Resolver APIs do not accept AbortSignal; a timeout is a caller deadline,
    // not a claim that the resolver itself was cancelled.
    return this.waitForDeadline(resolution, timeoutMs, name);
  }

  private async waitForDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    name: string,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new SubAgentTimeoutError(name, timeoutMs)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  private materializeLifecycleExecutionSnapshot(
    name: string,
    agent: LoadedSubAgent | undefined,
    ctx: SubAgentInvokeContext,
  ): LifecycleExecutionSnapshot | undefined {
    try {
      const lifecycle = this.safeOwnDataProperty(ctx, 'lifecycle');
      const expected = this.materializeIdentity(
        this.safeOwnDataProperty(lifecycle, 'expectedIdentity'),
      );
      const manifest = this.materializeManifest(agent);
      const capabilities = this.materializeLifecycleCapabilities(agent);
      const run = this.safeOwnDataProperty(agent, 'lifecycleRun');
      const prompts = this.materializeStringArray(
        this.safeOwnDataProperty(agent, 'promptContents'),
      );
      const personaCapabilities = this.materializeResolvedCapabilities(
        this.safeOwnDataProperty(ctx, 'personaCapabilities'),
      );
      const approvedCapabilities = this.materializeStringArray(
        this.safeOwnDataProperty(lifecycle, 'approvedCapabilities') ?? [],
      );
      const threadId = this.safeOwnDataProperty(ctx, 'threadId');
      const personaId = this.safeOwnDataProperty(ctx, 'personaId');
      const personaSubagents = this.materializeStringArray(
        this.safeOwnDataProperty(ctx, 'personaSubagents'),
      );
      const executionLimits = this.materializeExecutionLimits(
        this.safeOwnDataProperty(ctx, 'executionLimits'),
      );
      const traceparent = this.safeOwnDataProperty(ctx, 'traceparent');
      if (
        !expected ||
        !manifest ||
        !capabilities ||
        typeof run !== 'function' ||
        types.isProxy(run) ||
        !prompts ||
        !personaCapabilities ||
        !approvedCapabilities ||
        typeof threadId !== 'string' ||
        typeof personaId !== 'string' ||
        !personaSubagents ||
        !executionLimits ||
        (traceparent !== undefined && typeof traceparent !== 'string') ||
        expected.implementationRef !== name
      ) {
        return undefined;
      }
      return Object.freeze({
        agent: Object.freeze({
          manifest,
          promptContents: prompts,
          run: run as LifecycleSubAgentRunFn,
          lifecycleCapabilities: capabilities,
        }),
        expectedIdentity: expected,
        personaCapabilities,
        approvedCapabilities,
        threadId,
        personaId,
        personaSubagents,
        executionLimits,
        ...(traceparent === undefined ? {} : { traceparent }),
      });
    } catch {
      return undefined;
    }
  }

  private safeOwnDataProperty(source: unknown, key: PropertyKey): unknown {
    if (!source || typeof source !== 'object' || types.isProxy(source)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  }

  private classifyInvocationContext(
    name: string,
    ctx: SubAgentInvokeContext,
  ): InvocationContextClassification {
    if (!this.isValidInvocationContext(ctx)) return { kind: 'invalid' };
    const lifecycle = Object.getOwnPropertyDescriptor(ctx, 'lifecycle');
    if (lifecycle === undefined) return { kind: 'ordinary' };
    // Accessor-backed authority is malformed. Do not invoke it while trying
    // to distinguish lifecycle from ordinary execution.
    if (!('value' in lifecycle)) return { kind: 'invalid' };
    const snapshot = this.materializeLifecycleExecutionSnapshot(name, this.agents.get(name), ctx);
    return snapshot ? { kind: 'lifecycle', snapshot } : { kind: 'invalid' };
  }

  /**
   * Validate the complete invocation shape before it can enter either path.
   * `types.isProxy` is intentionally checked before any reflection API, which
   * keeps hostile proxy traps outside the runner's trust boundary.
   */
  private isValidInvocationContext(ctx: unknown): ctx is SubAgentInvokeContext {
    if (!ctx || typeof ctx !== 'object' || types.isProxy(ctx)) return false;
    const threadId = this.safeOwnDataProperty(ctx, 'threadId');
    const personaId = this.safeOwnDataProperty(ctx, 'personaId');
    const personaSubagents = this.hasStringArray(this.safeOwnDataProperty(ctx, 'personaSubagents'));
    const personaCapabilities = this.hasResolvedCapabilities(
      this.safeOwnDataProperty(ctx, 'personaCapabilities'),
    );
    if (
      typeof threadId !== 'string' ||
      typeof personaId !== 'string' ||
      !personaSubagents ||
      !personaCapabilities
    ) {
      return false;
    }

    for (const optionalKey of ['traceparent', 'executionLimits', 'serviceScope', 'lifecycle']) {
      const descriptor = Object.getOwnPropertyDescriptor(ctx, optionalKey);
      if (descriptor && !('value' in descriptor)) return false;
    }
    const traceparent = this.safeOwnDataProperty(ctx, 'traceparent');
    const serviceScope = this.safeOwnDataProperty(ctx, 'serviceScope');
    return (
      (traceparent === undefined || typeof traceparent === 'string') &&
      (serviceScope === undefined || serviceScope === 'full' || serviceScope === 'none') &&
      this.materializeExecutionLimits(this.safeOwnDataProperty(ctx, 'executionLimits')) !==
        undefined
    );
  }

  private hasResolvedCapabilities(value: unknown): boolean {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
    return (
      this.hasStringArray(this.safeOwnDataProperty(value, 'allow')) &&
      this.hasStringArray(this.safeOwnDataProperty(value, 'requireApproval'))
    );
  }

  private hasStringArray(value: unknown): value is string[] {
    if (types.isProxy(value) || !Array.isArray(value)) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string')
        return false;
    }
    return true;
  }

  private materializeExecutionLimits(
    value: unknown,
  ): LifecycleExecutionSnapshot['executionLimits'] | undefined {
    if (value === undefined) return Object.freeze({});
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const maxOutputTokens = this.ownDataProperty(value, 'maxOutputTokens');
    const timeoutMs = this.ownDataProperty(value, 'timeoutMs');
    if (
      maxOutputTokens.kind === 'accessor' ||
      timeoutMs.kind === 'accessor' ||
      (maxOutputTokens.kind === 'value' && !this.isPositiveInteger(maxOutputTokens.value)) ||
      (timeoutMs.kind === 'value' && !this.isPositiveInteger(timeoutMs.value))
    ) {
      return undefined;
    }
    const limits: { maxOutputTokens?: number; timeoutMs?: number } = {};
    if (maxOutputTokens.kind === 'value') {
      limits.maxOutputTokens = maxOutputTokens.value as number;
    }
    if (timeoutMs.kind === 'value') {
      limits.timeoutMs = timeoutMs.value as number;
    }
    return Object.freeze(limits);
  }

  /**
   * Read a limit without invoking user-controlled getters. Callers have
   * already rejected proxies before reaching this reflection boundary.
   */
  private ownDataProperty(
    source: object,
    key: PropertyKey,
  ): { kind: 'absent' } | { kind: 'accessor' } | { kind: 'value'; value: unknown } {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) return { kind: 'absent' };
    return 'value' in descriptor
      ? { kind: 'value', value: descriptor.value }
      : { kind: 'accessor' };
  }

  private isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  }

  private materializeIdentity(value: unknown): LifecycleHandlerIdentityContract | undefined {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const copied: Record<string, unknown> = {};
    for (const key of [
      'version',
      'handlerId',
      'runtimeKind',
      'implementationRef',
      'implementationVersion',
      'mode',
      'inputContract',
      'outputContract',
      'interceptorSafety',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) copied[key] = descriptor.value;
      else if (key !== 'interceptorSafety') return undefined;
    }
    const parsed = LifecycleHandlerIdentityContractSchema.safeParse(copied);
    return parsed.success ? Object.freeze({ ...parsed.data }) : undefined;
  }

  private materializeManifest(
    agent: unknown,
  ): LifecycleExecutionSnapshot['agent']['manifest'] | undefined {
    const value = this.safeOwnDataProperty(agent, 'manifest');
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const name = this.safeOwnDataProperty(value, 'name');
    const version = this.safeOwnDataProperty(value, 'version');
    const timeoutMs = this.safeOwnDataProperty(value, 'timeoutMs');
    const model = this.safeOwnDataProperty(value, 'model');
    const requiredCapabilities = this.materializeStringArray(
      this.safeOwnDataProperty(value, 'requiredCapabilities'),
    );
    const rootPaths = this.materializeStringArray(this.safeOwnDataProperty(value, 'rootPaths'));
    if (!model || typeof model !== 'object' || types.isProxy(model)) return undefined;
    const provider = this.safeOwnDataProperty(model, 'provider');
    const modelName = this.safeOwnDataProperty(model, 'name');
    const maxTokens = this.safeOwnDataProperty(model, 'maxTokens');
    if (
      typeof name !== 'string' ||
      typeof version !== 'string' ||
      typeof provider !== 'string' ||
      typeof modelName !== 'string' ||
      typeof maxTokens !== 'number' ||
      !Number.isInteger(maxTokens) ||
      maxTokens < 1 ||
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !requiredCapabilities ||
      !rootPaths
    )
      return undefined;
    return Object.freeze({
      name,
      version,
      model: Object.freeze({ provider, name: modelName, maxTokens }),
      requiredCapabilities,
      rootPaths,
      timeoutMs,
    });
  }

  private materializeLifecycleCapabilities(
    agent: unknown,
  ): LifecycleExecutionSnapshot['agent']['lifecycleCapabilities'] | undefined {
    const value = this.safeOwnDataProperty(agent, 'lifecycleCapabilities');
    if (types.isProxy(value) || !Array.isArray(value) || value.length > 32) return undefined;
    const tuples: LifecycleExecutionSnapshot['agent']['lifecycleCapabilities'][number][] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) return undefined;
      const tuple: unknown = descriptor.value;
      if (!tuple || typeof tuple !== 'object' || types.isProxy(tuple)) return undefined;
      const mode = this.safeOwnDataProperty(tuple, 'mode');
      const inputContract = this.safeOwnDataProperty(tuple, 'inputContract');
      const outputContract = this.safeOwnDataProperty(tuple, 'outputContract');
      const interceptorSafety = this.safeOwnDataProperty(tuple, 'interceptorSafety');
      if (
        (mode !== 'event' && mode !== 'signal' && mode !== 'interceptor') ||
        typeof inputContract !== 'string' ||
        typeof outputContract !== 'string' ||
        (interceptorSafety !== undefined &&
          interceptorSafety !== 'advisory' &&
          interceptorSafety !== 'enforcing')
      ) {
        return undefined;
      }
      const contract = resolveLifecycleHandlerContract(inputContract, outputContract);
      if (
        !contract ||
        contract.mode !== mode ||
        contract.requiredSafety !== interceptorSafety ||
        interceptorSafety === 'enforcing'
      )
        return undefined;
      const key = `${mode}\u0000${inputContract}\u0000${outputContract}\u0000${interceptorSafety ?? ''}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      tuples.push(
        Object.freeze({
          mode,
          inputContract,
          outputContract,
          ...(interceptorSafety === 'advisory' ? { interceptorSafety } : {}),
        }) as LifecycleExecutionSnapshot['agent']['lifecycleCapabilities'][number],
      );
    }
    return Object.freeze(tuples);
  }

  private materializeStringArray(value: unknown): readonly string[] | undefined {
    if (
      types.isProxy(value) ||
      !Array.isArray(value) ||
      value.length > MAX_LIFECYCLE_CAPABILITY_LABELS
    )
      return undefined;
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string')
        return undefined;
      values.push(descriptor.value);
    }
    return Object.freeze(values);
  }

  private materializeResolvedCapabilities(
    value: unknown,
  ): LifecycleExecutionSnapshot['personaCapabilities'] | undefined {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const allow = this.materializeStringArray(this.safeOwnDataProperty(value, 'allow'));
    const requireApproval = this.materializeStringArray(
      this.safeOwnDataProperty(value, 'requireApproval'),
    );
    return allow && requireApproval
      ? Object.freeze({
          allow: Object.freeze([...allow]),
          requireApproval: Object.freeze([...requireApproval]),
        })
      : undefined;
  }
}
