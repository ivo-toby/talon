/**
 * Sub-agent runner — the core orchestrator for sub-agent execution.
 *
 * Validates that the requested sub-agent exists, is assigned to the calling
 * persona, and that the persona's capabilities satisfy the sub-agent's
 * requirements. Then resolves the model, assembles the system prompt from
 * prompt fragments, and invokes the sub-agent's run function with a timeout.
 */

import { ok, err, type Result } from 'neverthrow';
import type { LanguageModel } from 'ai';
import type { JSONObject } from '@ai-sdk/provider';
import type {
  LoadedSubAgent,
  SubAgentInput,
  SubAgentResult,
  SubAgentServices,
} from './subagent-types.js';
import type { ModelResolver } from './model-resolver.js';
import type { ResolvedCapabilities } from '../personas/persona-types.js';
import { ToolError } from '../core/errors/index.js';
import { extractCapabilityPrefix } from '../tools/tool-filter.js';
import { createChildLogger } from '../core/logging/index.js';
import type pino from 'pino';
import type { ObservabilityService } from '../observability/langfuse/observability-types.js';
import { NoopObservabilityService } from '../observability/langfuse/noop-observability.js';
import type { SubAgentsConfig } from '../core/config/config-types.js';

// ---------------------------------------------------------------------------
// Timeout sentinel
// ---------------------------------------------------------------------------

class SubAgentTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Sub-agent "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'SubAgentTimeoutError';
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
    try {
      const result = await this.observability.observe(
        {
          type: 'agent',
          name: `subagent:${name}`,
          input,
          metadata: {
            threadId: ctx.threadId,
            personaId: ctx.personaId,
          },
        },
        async (observation) => {
          const executeResult = await this.executeInternal(name, input, ctx);
          if (executeResult.isErr()) {
            throw executeResult.error;
          }
          const { _model, _modelSource, ...value } = executeResult.value;
          observation.update({
            output: value,
            model: _model,
            metadata: { modelSource: _modelSource },
          });
          return value;
        },
      );

      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        error instanceof ToolError
          ? error
          : new ToolError(message, error instanceof Error ? error : undefined),
      );
    }
  }

  private async executeInternal(
    name: string,
    input: SubAgentInput,
    ctx: SubAgentInvokeContext,
  ): Promise<Result<SubAgentResult & { _model?: string; _modelSource?: string }, ToolError>> {
    // 1. Sub-agent must exist (was loaded)
    const agent = this.agents.get(name);
    if (!agent) {
      return err(new ToolError(`Unknown sub-agent "${name}"`));
    }

    // 2. Sub-agent must be in persona's assignment list
    if (!ctx.personaSubagents.includes(name)) {
      return err(
        new ToolError(
          `Sub-agent "${name}" is not assigned to persona "${ctx.personaId}"`,
        ),
      );
    }

    // 3. Persona capabilities must satisfy sub-agent's required capabilities
    const unsatisfied = this.findUnsatisfiedCapabilities(
      agent.manifest.requiredCapabilities,
      ctx.personaCapabilities,
    );
    if (unsatisfied.length > 0) {
      return err(
        new ToolError(
          `Persona "${ctx.personaId}" lacks capabilities required by sub-agent "${name}": ${unsatisfied.join(', ')}`,
        ),
      );
    }

    // 4. Build model chain: config overrides (if any) + manifest fallback
    const overrideConfig = this.subagentOverrides[name];
    const modelChain: Array<{ provider: string; name: string; maxTokens: number; timeoutMs: number; providerOptions?: Record<string, unknown>; source: string }> = [];

    if (overrideConfig) {
      for (const entry of overrideConfig.model) {
        modelChain.push({
          provider: entry.provider,
          name: entry.name,
          maxTokens: entry.maxTokens ?? agent.manifest.model.maxTokens,
          timeoutMs: entry.timeoutMs ?? agent.manifest.timeoutMs,
          providerOptions: entry.providerOptions,
          source: 'override',
        });
      }
    }

    // Always append manifest model as final fallback
    modelChain.push({
      provider: agent.manifest.model.provider,
      name: agent.manifest.model.name,
      maxTokens: agent.manifest.model.maxTokens,
      timeoutMs: agent.manifest.timeoutMs,
      source: 'manifest',
    });

    // Build once — these don't depend on which model is being tried.
    const systemPrompt = agent.promptContents.join('\n\n');
    const childLogger = createChildLogger(this.logger, {
      tool: `subagent:${name}`,
      threadId: ctx.threadId,
      persona: ctx.personaId,
    });

    const failures: string[] = [];

    for (const modelEntry of modelChain) {
      // Resolve model
      const modelResult = await this.modelResolver.resolve({
        provider: modelEntry.provider,
        name: modelEntry.name,
        maxTokens: modelEntry.maxTokens,
      });

      if (modelResult.isErr()) {
        const failMsg = `${modelEntry.provider}/${modelEntry.name} (${modelEntry.source}): ${modelResult.error.message}`;
        failures.push(failMsg);
        this.logger.warn(
          { subagent: name, model: `${modelEntry.provider}/${modelEntry.name}`, source: modelEntry.source },
          `Model resolution failed, trying next: ${modelResult.error.message}`,
        );
        continue;
      }

      const model: LanguageModel = modelResult.value;

      // Per-model AbortController for timeout cancellation
      const abortController = new AbortController();

      const wrappedProviderOptions = modelEntry.providerOptions
        ? { [modelEntry.provider]: modelEntry.providerOptions as JSONObject }
        : undefined;

      const agentContext = {
        threadId: ctx.threadId,
        personaId: ctx.personaId,
        systemPrompt,
        model,
        maxOutputTokens: modelEntry.maxTokens,
        rootPaths: agent.manifest.rootPaths,
        services: { ...this.services, logger: childLogger },
        telemetry: { isEnabled: !(this.observability instanceof NoopObservabilityService) },
        abortSignal: abortController.signal,
        providerOptions: wrappedProviderOptions,
      };

      try {
        const runResult = await this.runWithTimeout(
          agent.run(agentContext, input),
          modelEntry.timeoutMs,
          name,
          abortController,
        );

        if (runResult.isErr()) {
          const failMsg = `${modelEntry.provider}/${modelEntry.name} (${modelEntry.source}): ${runResult.error.message}`;
          failures.push(failMsg);
          this.logger.warn(
            { subagent: name, model: `${modelEntry.provider}/${modelEntry.name}` },
            `Sub-agent run failed, trying next: ${runResult.error.message}`,
          );
          continue;
        }

        const modelLabel = `${modelEntry.provider}/${modelEntry.name}`;
        if (failures.length > 0) {
          this.logger.info(
            { subagent: name, model: modelLabel, source: modelEntry.source, failedAttempts: failures.length },
            'Sub-agent succeeded after failover',
          );
        } else {
          this.logger.info(
            { subagent: name, model: modelLabel, source: modelEntry.source },
            'Sub-agent completed',
          );
        }

        return ok({ ...runResult.value, _model: modelLabel, _modelSource: modelEntry.source });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failMsg = `${modelEntry.provider}/${modelEntry.name} (${modelEntry.source}): ${message}`;
        failures.push(failMsg);

        if (error instanceof SubAgentTimeoutError) {
          this.logger.warn(
            { subagent: name, model: `${modelEntry.provider}/${modelEntry.name}`, timeoutMs: modelEntry.timeoutMs },
            `Sub-agent timed out, failing over to next model`,
          );
          continue;
        }

        this.logger.warn(
          { subagent: name, model: `${modelEntry.provider}/${modelEntry.name}` },
          `Sub-agent execution threw, trying next: ${message}`,
        );
        continue;
      }
    }

    // All models exhausted
    return err(
      new ToolError(
        `All models failed for sub-agent "${name}":\n  ${failures.map((f, i) => `${i + 1}. ${f}`).join('\n  ')}`,
      ),
    );
  }

  /**
   * Returns the list of required capability prefixes that are not satisfied
   * by the persona's capabilities.
   */
  private findUnsatisfiedCapabilities(
    required: string[],
    capabilities: ResolvedCapabilities,
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
      timeoutId = setTimeout(
        () => {
          abortController.abort();
          reject(new SubAgentTimeoutError(name, timeoutMs));
        },
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }
}
