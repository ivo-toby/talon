import type pino from 'pino';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import type { BackgroundAgentManager } from '../../subagents/background/background-agent-manager.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import type { PersonaLoader } from '../../personas/persona-loader.js';
import type { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import type { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import type { SkillResolver } from '../../skills/skill-resolver.js';
import type { ContextAssembler } from '../../daemon/context-assembler.js';
import type { LoadedSkill } from '../../skills/skill-types.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import { buildPersonaRuntimeContext } from '../../personas/persona-runtime-context.js';
import type { BackgroundTask } from '../../subagents/background/background-agent-types.js';
import { BackgroundAgentError } from '../../core/errors/error-types.js';
import { filterAllowedMcpTools } from '../tool-filter.js';
import { resolveToolInstructions } from '../tool-instructions.js';
import { buildTimeContext } from '../../core/time-context.js';
import type { PersonaExecutionEnvConfig } from '../../core/config/config-types.js';

const DEFAULT_BACKGROUND_CONTEXT_RECENT_MESSAGE_COUNT = 10;

export interface BackgroundAgentArgs {
  action: 'spawn' | 'status' | 'cancel' | 'result' | 'profiles';
  prompt?: string;
  taskId?: string;
  provider?: string;
  profile?: string;
  workingDirectory?: string;
  timeoutMinutes?: number;
  sandbox?: boolean;
}

interface BackgroundAgentHandlerDeps {
  backgroundAgentManager: BackgroundAgentManager;
  backgroundProviderRegistry: Pick<ProviderRegistry, 'hasProvider'>;
  personaRepository: PersonaRepository;
  personaLoader: PersonaLoader;
  threadRepository: ThreadRepository;
  channelRepository: ChannelRepository;
  skillResolver: SkillResolver;
  contextAssembler: ContextAssembler;
  loadedSkills: LoadedSkill[];
  toolInstructions: Map<string, string>;
  logger: pino.Logger;
}

type OwnedTaskResult =
  | { status: 'ok'; task: BackgroundTask }
  | { status: 'not_found' }
  | { status: 'wrong_thread' }
  | { status: 'error'; message: string };

export class BackgroundAgentHandler {
  static readonly manifest: ToolManifest = {
    name: 'subagent.background',
    description: 'Starts and manages background agent workers for the current thread.',
    capabilities: ['subagent.background'],
    executionLocation: 'host',
  };

  constructor(private readonly deps: BackgroundAgentHandlerDeps) {}

  async execute(args: BackgroundAgentArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    switch (args.action) {
      case 'spawn':
        return this.spawn(args, context, requestId);
      case 'status':
        return this.status(args, context, requestId);
      case 'cancel':
        return this.cancel(args, context, requestId);
      case 'result':
        return this.result(args, context, requestId);
      case 'profiles':
        return this.profiles(requestId);
      default:
        return this.errorResult(
          requestId,
          `Unsupported action: ${String((args as { action?: unknown }).action)}`,
        );
    }
  }

  private async spawn(
    args: BackgroundAgentArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
      return this.errorResult(requestId, 'Missing required field: prompt');
    }

    if (
      args.workingDirectory !== undefined &&
      (typeof args.workingDirectory !== 'string' || args.workingDirectory.trim() === '')
    ) {
      return this.errorResult(
        requestId,
        'workingDirectory must be a non-empty string when provided',
      );
    }

    if (
      args.timeoutMinutes !== undefined &&
      (!Number.isInteger(args.timeoutMinutes) || args.timeoutMinutes <= 0)
    ) {
      return this.errorResult(requestId, 'timeoutMinutes must be a positive integer when provided');
    }

    if (
      args.provider !== undefined &&
      (typeof args.provider !== 'string' || args.provider.trim() === '')
    ) {
      return this.errorResult(requestId, 'provider must be a non-empty string when provided');
    }

    if (
      args.profile !== undefined &&
      (typeof args.profile !== 'string' || args.profile.trim() === '')
    ) {
      return this.errorResult(requestId, 'profile must be a non-empty string when provided');
    }

    if (args.sandbox !== undefined && typeof args.sandbox !== 'boolean') {
      return this.errorResult(requestId, 'sandbox must be a boolean when provided');
    }

    const personaRowResult = this.deps.personaRepository.findById(context.personaId);
    if (personaRowResult.isErr() || !personaRowResult.value) {
      return this.errorResult(requestId, `Persona not found: ${context.personaId}`);
    }

    // Normalize profile name once upfront so lookup, error messages, and
    // manager input all use the same trimmed value.
    const profileName = args.profile?.trim();

    // When a profile is specified, use that persona instead of the spawning thread's persona
    // for building the runtime context (system prompt, skills, MCP servers, provider).
    // SECURITY NOTE: any persona with `subagent.background` can use any loaded profile.
    // This is intentional — the operator controls which personas exist in talond.yaml
    // and which have the `subagent.background` capability. The spawned background agent
    // inherits the *profile's* capabilities, not the caller's. A future enhancement
    // could restrict profile access via `subagent.background.profile:<name>`.
    const targetPersonaName = profileName ?? personaRowResult.value.name;
    const loadedPersonaResult = this.deps.personaLoader.getByName(targetPersonaName);
    if (loadedPersonaResult.isErr() || !loadedPersonaResult.value) {
      if (profileName) {
        const available = this.deps.personaLoader.listNames().join(', ') || 'none';
        return this.errorResult(
          requestId,
          `Profile "${profileName}" not found. Available profiles: ${available}`,
        );
      }
      return this.errorResult(requestId, `Loaded persona not found: ${personaRowResult.value.name}`);
    }

    const threadResult = this.deps.threadRepository.findById(context.threadId);
    if (threadResult.isErr() || !threadResult.value) {
      return this.errorResult(requestId, `Thread not found: ${context.threadId}`);
    }

    const channelResult = this.deps.channelRepository.findById(threadResult.value.channel_id);
    if (channelResult.isErr() || !channelResult.value) {
      return this.errorResult(requestId, `Channel not found: ${threadResult.value.channel_id}`);
    }

    // Build channel context so the background agent knows which channels are available.
    const currentChannelName = channelResult.value.name;
    const enabledChannelsResult = this.deps.channelRepository.findEnabled();
    const allChannelNames = enabledChannelsResult.isOk()
      ? enabledChannelsResult.value.map((c) => c.name)
      : [currentChannelName];
    const channelContext = [
      'Available channels for channel_send tool:',
      ...allChannelNames.map((name) =>
        name === currentChannelName ? `  - ${name} (current thread)` : `  - ${name}`,
      ),
      `When sending messages, use channelId: "${currentChannelName}".`,
    ].join('\n');

    // Generate a cache-friendly time context (10-min window instead of exact timestamp).
    const timeContext = buildTimeContext();

    const loadedPersona = loadedPersonaResult.value;
    const workerPersonaRowResult = profileName
      ? this.deps.personaRepository.findByName(targetPersonaName)
      : personaRowResult;

    if (workerPersonaRowResult.isErr() || !workerPersonaRowResult.value) {
      return this.errorResult(requestId, `Worker persona not found: ${targetPersonaName}`);
    }

    const personaSkills = this.deps.loadedSkills.filter((skill) =>
      loadedPersona.config.skills.includes(skill.manifest.name),
    );
    const runtimeContext = buildPersonaRuntimeContext({
      loadedPersona,
      resolvedSkills: personaSkills,
      skillResolver: this.deps.skillResolver,
      excludeServerNames: ['__talond_host_tools'],
      skillLoadingMode: 'lazy',
      logger: this.deps.logger,
    });

    let previousContext: string | undefined;
    try {
      previousContext = this.deps.contextAssembler.assemble(
        context.threadId,
        DEFAULT_BACKGROUND_CONTEXT_RECENT_MESSAGE_COUNT,
      ).text || undefined;
    } catch (cause) {
      this.deps.logger.warn(
        {
          threadId: context.threadId,
          error: cause instanceof Error ? cause.message : String(cause),
        },
        'background-agent: failed to assemble prior thread context',
      );
    }

    // Resolution chain (most specific to least specific):
    //   1. args.provider — strict, honored as-is; manager validates registry membership
    //   2. persona.backgroundProvider — config-load validated against background registry
    //   3. persona.provider — only if also enabled in background registry (safety net
    //      for personas whose foreground runtime is unsuitable for background work,
    //      e.g. local Ollama on a small model)
    //   4. undefined — manager picks backgroundAgent.defaultProvider
    const explicitProvider =
      typeof args.provider === 'string' && args.provider.trim().length > 0
        ? args.provider.trim()
        : undefined;
    const personaBackgroundProvider =
      typeof loadedPersona.config.backgroundProvider === 'string' &&
      loadedPersona.config.backgroundProvider.trim().length > 0
        ? loadedPersona.config.backgroundProvider.trim()
        : undefined;
    const personaProvider =
      typeof loadedPersona.config.provider === 'string' &&
      loadedPersona.config.provider.trim().length > 0
        ? loadedPersona.config.provider.trim()
        : undefined;
    // Tier 3 registry lookup is only needed when tiers 1 and 2 don't apply —
    // avoid calling hasProvider unnecessarily (short-circuit for explicit provider).
    const personaProviderIfAvailable =
      !explicitProvider &&
      !personaBackgroundProvider &&
      personaProvider &&
      this.deps.backgroundProviderRegistry.hasProvider(personaProvider)
        ? personaProvider
        : undefined;
    const resolvedProvider =
      explicitProvider ?? personaBackgroundProvider ?? personaProviderIfAvailable;
    const allowedMcpTools = filterAllowedMcpTools(
      loadedPersona.resolvedCapabilities ?? { allow: [], requireApproval: [] },
    ).filter((toolName) => toolName !== 'background_agent');
    const sandbox = args.sandbox ?? loadedPersona.config.executionEnv?.sandboxDefault ?? false;

    if (sandbox && !allowedMcpTools.includes('execution_env')) {
      return this.errorResult(
        requestId,
        `Profile "${targetPersonaName}" must allow execution.env when sandbox=true`,
      );
    }

    // Only forward the persona's model when:
    // 1. No explicit provider override was given in the tool args, AND
    // 2. The persona itself has an explicit provider configured.
    //
    // When the persona has no provider, the background agent falls back to
    // backgroundAgent.defaultProvider, which may differ from the agentRunner's
    // default. Forwarding the persona's model (configured for the agent-runner
    // provider) to a different background provider causes cross-provider model
    // mismatches (e.g. "gpt-5.4" sent to claude-code).
    const shouldForwardModel = !explicitProvider && !!personaProvider && !!loadedPersona.config.model;

    const toolInstructionsBlock = resolveToolInstructions(
      this.deps.toolInstructions,
      allowedMcpTools,
    );

    const spawnResult = await this.deps.backgroundAgentManager.spawn({
      prompt: args.prompt,
      personaPrompt: runtimeContext.personaPrompt,
      threadContext: previousContext,
      channelContext,
      timeContext,
      toolInstructions: toolInstructionsBlock || undefined,
      hasSkills: personaSkills.length > 0,
      mcpServers: runtimeContext.mcpServers,
      personaId: context.personaId,
      workerPersonaId: workerPersonaRowResult.value.id,
      threadId: context.threadId,
      channelId: threadResult.value.channel_id,
      channelName: channelResult.value.name,
      provider: resolvedProvider,
      allowedMcpTools,
      sandbox,
      executionEnvDefaults: loadedPersona.config.executionEnv as PersonaExecutionEnvConfig,
      ...(profileName ? { profileName } : {}),
      // TODO(Task 5): shouldForwardModel should consult resolvedProvider rather
      // than raw personaProvider. Today this can forward the persona's model
      // even when personaProviderIfAvailable resolved to undefined (the persona's
      // foreground provider isn't enabled for background runs), causing cross-
      // provider model leaks (e.g. an Ollama model name passed to claude-code).
      ...(shouldForwardModel ? { model: loadedPersona.config.model } : {}),
      ...(args.workingDirectory ? { workingDirectory: args.workingDirectory } : {}),
      ...(args.timeoutMinutes ? { timeoutMinutes: args.timeoutMinutes } : {}),
      traceparent: context.traceparent,
    });

    if (spawnResult.isErr()) {
      return this.errorResult(requestId, spawnResult.error.message);
    }

    return {
      requestId,
      tool: BackgroundAgentHandler.manifest.name,
      status: 'success',
      result: { taskId: spawnResult.value },
    };
  }

  private async status(
    args: BackgroundAgentArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    if (!args.taskId) {
      const tasksResult = this.deps.backgroundAgentManager.listTasksForThread(context.threadId);
      if (tasksResult.isErr()) {
        return this.errorResult(requestId, tasksResult.error.message);
      }

      return {
        requestId,
        tool: BackgroundAgentHandler.manifest.name,
        status: 'success',
        result: { tasks: tasksResult.value },
      };
    }

    const ownership = this.ensureTaskOwnership(args.taskId, context.threadId, requestId);
    if (ownership.status !== 'ok') {
      return this.taskOwnershipError(args.taskId, ownership, requestId);
    }

    return {
      requestId,
      tool: BackgroundAgentHandler.manifest.name,
      status: 'success',
      result: { task: ownership.task },
    };
  }

  private async cancel(
    args: BackgroundAgentArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim() === '') {
      return this.errorResult(requestId, 'Missing required field: taskId');
    }

    const ownership = this.ensureTaskOwnership(args.taskId, context.threadId, requestId);
    if (ownership.status !== 'ok') {
      return this.taskOwnershipError(args.taskId, ownership, requestId);
    }

    const cancelResult = await this.deps.backgroundAgentManager.cancel(ownership.task.id);
    if (cancelResult.isErr()) {
      return this.errorResult(requestId, cancelResult.error.message);
    }

    return {
      requestId,
      tool: BackgroundAgentHandler.manifest.name,
      status: 'success',
      result: { success: cancelResult.value },
    };
  }

  private async result(
    args: BackgroundAgentArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim() === '') {
      return this.errorResult(requestId, 'Missing required field: taskId');
    }

    const ownership = this.ensureTaskOwnership(args.taskId, context.threadId, requestId);
    if (ownership.status !== 'ok') {
      return this.taskOwnershipError(args.taskId, ownership, requestId);
    }

    const result = this.deps.backgroundAgentManager.getResult(ownership.task.id);
    if (result.isErr()) {
      return this.errorResult(requestId, result.error.message);
    }

    return {
      requestId,
      tool: BackgroundAgentHandler.manifest.name,
      status: 'success',
      result: result.value,
    };
  }

  private profiles(requestId: string): ToolCallResult {
    const profiles = this.deps.personaLoader.listProfiles();
    return {
      requestId,
      tool: BackgroundAgentHandler.manifest.name,
      status: 'success',
      result: { profiles },
    };
  }

  private ensureTaskOwnership(
    taskId: string,
    threadId: string,
    requestId: string,
  ): OwnedTaskResult {
    const taskResult = this.deps.backgroundAgentManager.getTask(taskId);
    if (taskResult.isErr()) {
      this.deps.logger.warn(
        { requestId, taskId, err: taskResult.error.message },
        'background-agent: failed to load task for ownership check',
      );
      return { status: 'error', message: taskResult.error.message };
    }

    if (!taskResult.value) {
      return { status: 'not_found' };
    }

    if (taskResult.value.threadId !== threadId) {
      return { status: 'wrong_thread' };
    }

    return { status: 'ok', task: taskResult.value };
  }

  private taskOwnershipError(
    taskId: string,
    ownership: Exclude<OwnedTaskResult, { status: 'ok'; task: BackgroundTask }>,
    requestId: string,
  ): ToolCallResult {
    switch (ownership.status) {
      case 'not_found':
        return this.errorResult(requestId, `Background task not found: ${taskId}`);
      case 'wrong_thread':
        return this.errorResult(
          requestId,
          `Background task ${taskId} does not belong to the current thread`,
        );
      case 'error':
        return this.errorResult(requestId, ownership.message);
      default:
        return this.errorResult(requestId, new BackgroundAgentError('Unknown task error').message);
    }
  }

  private errorResult(requestId: string, error: string): ToolCallResult {
    return {
      requestId,
      tool: BackgroundAgentHandler.manifest.name,
      status: 'error',
      error,
    };
  }
}
