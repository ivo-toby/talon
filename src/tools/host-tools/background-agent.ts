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
import { buildPersonaRuntimeContext } from '../../personas/persona-runtime-context.js';
import type { BackgroundTask } from '../../subagents/background/background-agent-types.js';
import { BackgroundAgentError } from '../../core/errors/error-types.js';
import { filterAllowedMcpTools } from '../tool-filter.js';
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
  personaRepository: PersonaRepository;
  personaLoader: PersonaLoader;
  threadRepository: ThreadRepository;
  channelRepository: ChannelRepository;
  skillResolver: SkillResolver;
  contextAssembler: ContextAssembler;
  loadedSkills: LoadedSkill[];
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
      skillLoadingMode: 'eager',
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

    // Resolve provider: explicit arg > persona/profile config > undefined (daemon default).
    const explicitProvider =
      typeof args.provider === 'string' && args.provider.trim().length > 0
        ? args.provider.trim()
        : undefined;
    const personaProvider =
      typeof loadedPersona.config.provider === 'string' && loadedPersona.config.provider.trim().length > 0
        ? loadedPersona.config.provider.trim()
        : undefined;
    const resolvedProvider = explicitProvider ?? personaProvider;
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

    // Only forward the persona's model when no explicit provider override was given.
    // When the user passes an explicit provider, the persona's model name may be
    // invalid for that provider (e.g. "claude-opus-4-6" on gemini-cli).
    // When no explicit override is given the resolved provider comes from the persona
    // config itself (or daemon default), so the persona's model is expected to match.
    const shouldForwardModel = !explicitProvider && !!loadedPersona.config.model;

    const spawnResult = await this.deps.backgroundAgentManager.spawn({
      prompt: args.prompt,
      personaPrompt: runtimeContext.personaPrompt,
      threadContext: previousContext,
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
      // Only pass the persona's model when the resolved provider matches the persona's
      // configured provider (or when the persona has no provider set). This prevents
      // cross-provider model mismatches (e.g. "claude-opus-4-6" on gemini-cli) that
      // occur when the daemon default provider differs from the profile's provider.
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
