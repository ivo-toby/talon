/**
 * Host-side tool: subagent.invoke
 *
 * Delegates a task to a specialized sub-agent that runs a single-turn LLM call
 * with a cheap model and returns structured results. The tool is gated by the
 * `subagent.invoke` capability.
 */

import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import type { SubAgentRunner } from '../../subagents/subagent-runner.js';
import type { PersonaLoader } from '../../personas/persona-loader.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';

/** Arguments accepted by the subagent.invoke tool. */
export interface SubAgentInvokeArgs {
  /** Name of the sub-agent to invoke (must match a loaded sub-agent definition). */
  name: string;
  /** Arbitrary input payload forwarded to the sub-agent's run function. */
  input?: Record<string, unknown>;
}

/**
 * Handler class for the subagent.invoke host tool.
 *
 * Resolves the calling persona's config (to obtain the sub-agent assignment
 * list and resolved capabilities), then delegates to SubAgentRunner.execute()
 * which performs validation, model resolution, and sub-agent execution.
 */
export class SubAgentInvokeHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'subagent.invoke',
    description:
      'Delegates a task to a specialized sub-agent that runs a single-turn LLM call with a cheap model and returns structured results.',
    capabilities: ['subagent.invoke'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      runner: SubAgentRunner;
      personaLoader: PersonaLoader;
      personaRepository: PersonaRepository;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the subagent.invoke tool.
   *
   * @param args    - Validated tool arguments (name + optional input).
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  async execute(args: SubAgentInvokeArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    // Validate required args
    if (!args.name || typeof args.name !== 'string' || args.name.trim() === '') {
      return {
        requestId,
        tool: 'subagent.invoke',
        status: 'error',
        error: 'Missing required field: name',
      };
    }

    // Resolve persona from DB to get its name
    const personaRowResult = this.deps.personaRepository.findById(context.personaId);
    if (personaRowResult.isErr() || personaRowResult.value === null) {
      return {
        requestId,
        tool: 'subagent.invoke',
        status: 'error',
        error: `Persona not found: ${context.personaId}`,
      };
    }

    // Load the full persona (config + resolved capabilities)
    const loadedResult = this.deps.personaLoader.getByName(personaRowResult.value.name);
    if (loadedResult.isErr() || loadedResult.value === undefined) {
      return {
        requestId,
        tool: 'subagent.invoke',
        status: 'error',
        error: `Loaded persona not found: ${personaRowResult.value.name}`,
      };
    }

    const loadedPersona = loadedResult.value;

    // Delegate to the sub-agent runner
    const result = await this.deps.runner.execute(args.name, args.input ?? {}, {
      threadId: context.threadId,
      personaId: context.personaId,
      personaSubagents: loadedPersona.config.subagents ?? [],
      personaCapabilities: loadedPersona.resolvedCapabilities,
      traceparent: context.traceparent,
    });

    if (result.isErr()) {
      return {
        requestId,
        tool: 'subagent.invoke',
        status: 'error',
        error: result.error.message,
      };
    }

    return {
      requestId,
      tool: 'subagent.invoke',
      status: 'success',
      result: result.value,
    };
  }
}
