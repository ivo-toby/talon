/**
 * Sub-agent runner — the core orchestrator for sub-agent execution.
 *
 * Validates that the requested sub-agent exists, is assigned to the calling
 * persona, and that the persona's capabilities satisfy the sub-agent's
 * requirements. Then resolves the model, assembles the system prompt from
 * prompt fragments, and invokes the sub-agent's run function with a timeout.
 */

import { ok, err, type Result } from 'neverthrow';
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
import type {
  ObservationHandle,
  ObservabilityService,
} from '../observability/langfuse/observability-types.js';
import { NoopObservabilityService } from '../observability/langfuse/noop-observability.js';
import type { SubAgentsConfig } from '../core/config/config-types.js';
import { runSubAgentModelChain } from './subagent-model-chain.js';

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
      const observationInput = {
        type: 'agent' as const,
        name: `subagent:${name}`,
        input,
        metadata: {
          threadId: ctx.threadId,
          personaId: ctx.personaId,
        },
      };
      const observeFn = async (observation: ObservationHandle): Promise<SubAgentResult> => {
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
      };

      const result = ctx.traceparent
        ? await this.observability.observeWithTraceparent(
            ctx.traceparent,
            observationInput,
            observeFn,
          )
        : await this.observability.observe(observationInput, observeFn);

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
        new ToolError(`Sub-agent "${name}" is not assigned to persona "${ctx.personaId}"`),
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

    const systemPrompt = agent.promptContents.join('\n\n');
    const childLogger = createChildLogger(this.logger, {
      tool: `subagent:${name}`,
      threadId: ctx.threadId,
      persona: ctx.personaId,
    });
    const chainResult = await runSubAgentModelChain({
      name,
      agent,
      input,
      override: this.subagentOverrides[name],
      modelResolver: this.modelResolver,
      logger: childLogger,
      createContext: ({ model, entry, abortSignal, providerOptions }) => ({
        threadId: ctx.threadId,
        personaId: ctx.personaId,
        systemPrompt,
        model,
        maxOutputTokens: entry.maxTokens,
        rootPaths: agent.manifest.rootPaths,
        services: { ...this.services, logger: childLogger },
        telemetry: { isEnabled: !(this.observability instanceof NoopObservabilityService) },
        abortSignal,
        providerOptions,
      }),
    });

    if (chainResult.isErr()) {
      return err(new ToolError(chainResult.error.message, chainResult.error));
    }

    return ok({
      ...chainResult.value.result,
      _model: chainResult.value.model,
      _modelSource: chainResult.value.source,
    });
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
}
