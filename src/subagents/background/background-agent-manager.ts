import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import { BackgroundAgentError } from '../../core/errors/error-types.js';
import type { PersonaExecutionEnvConfig } from '../../core/config/config-types.js';
import type { QueueManager } from '../../queue/queue-manager.js';
import type { BackgroundTask, BackgroundTaskResult } from './background-agent-types.js';
import { BackgroundAgentProcess, type BackgroundAgentProcessOptions } from './background-agent-process.js';
import type { BackgroundTaskRepository } from '../../core/database/repositories/background-task-repository.js';
import type { CanonicalMcpServer } from '../../providers/provider-types.js';
import type { AgentProvider } from '../../providers/provider.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { ObservabilityService, StartedObservationHandle } from '../../observability/langfuse/observability-types.js';
import type { ExecutionEnvManager } from '../../execution-env/execution-env-manager.js';

export interface SpawnBackgroundAgentInput {
  prompt: string;
  personaPrompt: string;
  threadContext?: string;
  /** Pre-formatted channel list so the background agent knows which channels are available. */
  channelContext?: string;
  /** Pre-formatted timestamp string so the background agent can reason about time. */
  timeContext?: string;
  mcpServers: Record<string, CanonicalMcpServer>;
  personaId: string;
  workerPersonaId: string;
  threadId: string;
  channelId: string;
  channelName: string;
  provider?: string;
  /** When set, indicates the spawn used a named persona profile instead of the thread's persona. */
  profileName?: string;
  /** Model override for the provider (e.g. "claude-opus-4-6"). Passed through to the provider. */
  model?: string;
  workingDirectory?: string;
  timeoutMinutes?: number;
  traceparent?: string;
  allowedMcpTools: string[];
  sandbox?: boolean;
  controlDirectory?: string;
  executionEnvDefaults?: PersonaExecutionEnvConfig;
}

interface BackgroundAgentManagerDeps {
  repository: BackgroundTaskRepository;
  queueManager: QueueManager;
  maxConcurrent: number;
  defaultTimeoutMinutes: number;
  defaultProvider: string;
  providerRegistry: Pick<ProviderRegistry, 'get' | 'getDefault' | 'listEnabled'>;
  logger: pino.Logger;
  processFactory?: (options: BackgroundAgentProcessOptions) => BackgroundAgentProcess;
  isPidAlive?: (pid: number) => boolean;
  readProcessCommandLine?: (pid: number) => string | null;
  observability?: ObservabilityService;
  executionEnvManager?: Pick<ExecutionEnvManager, 'create' | 'upload' | 'destroyOwnedByTask'> | null;
  hostToolsSocketPath?: string;
}

interface ManagedProcess {
  kill: () => void;
  cleanupPaths: string[];
  provider: AgentProvider;
  observation?: StartedObservationHandle;
}

interface SandboxContext {
  primaryExecutionEnvId: string;
  envWorkingDirectory: string;
  controlDirectory: string;
}

const MAX_STORED_OUTPUT = 100 * 1024;

export class BackgroundAgentManager {
  private readonly processFactory: (options: BackgroundAgentProcessOptions) => BackgroundAgentProcess;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly readProcessCommandLine: (pid: number) => string | null;
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(private readonly deps: BackgroundAgentManagerDeps) {
    this.processFactory = deps.processFactory ?? ((options) => new BackgroundAgentProcess(options));
    this.isPidAlive = deps.isPidAlive ?? ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    this.readProcessCommandLine = deps.readProcessCommandLine ?? ((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        return null;
      }
    });
  }

  async spawn(input: SpawnBackgroundAgentInput): Promise<Result<string, BackgroundAgentError>> {
    const countResult = this.deps.repository.countActive();
    if (countResult.isErr()) {
      return err(new BackgroundAgentError(countResult.error.message, countResult.error));
    }
    if (countResult.value >= this.deps.maxConcurrent) {
      return err(
        new BackgroundAgentError(
          `Background agent concurrency limit reached (${this.deps.maxConcurrent})`,
        ),
      );
    }

    const requestedProvider = typeof input.provider === 'string' && input.provider.trim().length > 0
      ? input.provider.trim()
      : undefined;

    // Explicit provider requests (from tool args) must be honored strictly.
    // If the requested provider is unavailable, fail with a clear error rather
    // than silently running on the wrong backend.
    let providerEntry;
    if (requestedProvider) {
      providerEntry = this.deps.providerRegistry.get(requestedProvider);
      if (!providerEntry) {
        const enabled = this.deps.providerRegistry.listEnabled().join(', ') || 'none';
        return err(
          new BackgroundAgentError(
            `Requested provider "${requestedProvider}" is not available. Enabled providers: ${enabled}.`,
          ),
        );
      }
    } else {
      providerEntry = this.deps.providerRegistry.getDefault([this.deps.defaultProvider]);
    }
    if (!providerEntry) {
      return err(
        new BackgroundAgentError(
          `No enabled background agent provider found (default: ${this.deps.defaultProvider})`,
        ),
      );
    }

    const taskId = randomUUID();
    this.deps.logger.info(
      { taskId, personaId: input.personaId, profileName: input.profileName },
      'background agent spawning',
    );
    const MIN_TIMEOUT_MINUTES = 15;
    const requested = input.timeoutMinutes ?? this.deps.defaultTimeoutMinutes;
    const timeoutMinutes = Math.max(MIN_TIMEOUT_MINUTES, requested);
    if (requested < MIN_TIMEOUT_MINUTES) {
      this.deps.logger.warn(
        { taskId, requested, clamped: timeoutMinutes },
        'background-agent: timeout clamped to minimum',
      );
    }

    // Start a LangFuse observation span if observability is available.
    const observation = this.deps.observability
      ? this.deps.observability.startWithTraceparent(input.traceparent ?? null, {
          type: 'agent',
          name: 'background-agent',
          input: { prompt: input.prompt, taskId, threadId: input.threadId },
          trace: {
            userId: undefined,
            tags: ['background-agent', `provider:${providerEntry.provider.name}`],
          },
        })
      : undefined;

    const childTraceparent = observation?.getTraceparent() ?? undefined;

    const systemPrompt = this.buildSystemPrompt({
      personaPrompt: input.personaPrompt,
      taskPrompt: input.prompt,
      taskId,
      threadId: input.threadId,
      channelName: input.channelName,
      threadContext: input.threadContext,
      channelContext: input.channelContext,
      timeContext: input.timeContext,
    });

    const sandboxContextResult = input.sandbox
      ? await this.createSandboxContext(taskId, input)
      : ok<SandboxContext | null, BackgroundAgentError>(null);
    if (sandboxContextResult.isErr()) {
      observation?.end();
      return err(sandboxContextResult.error);
    }
    const sandboxContext = sandboxContextResult.value;

    const workerMcpServers = this.buildWorkerMcpServers({
      baseMcpServers: input.mcpServers,
      taskId,
      threadId: input.threadId,
      workerPersonaId: input.workerPersonaId,
      allowedMcpTools: input.allowedMcpTools,
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      traceparent: childTraceparent,
      sandboxContext,
    });

    const invocationResult = providerEntry.provider.prepareBackgroundInvocation({
      prompt: input.prompt,
      systemPrompt,
      mcpServers: workerMcpServers,
      cwd: sandboxContext?.controlDirectory ?? input.workingDirectory ?? process.cwd(),
      timeoutMs: timeoutMinutes * 60 * 1000,
      traceparent: childTraceparent,
      ...(input.model ? { model: input.model } : {}),
    });
    if (invocationResult.isErr()) {
      observation?.end();
      this.cleanupPaths(this.mergeCleanupPaths([], sandboxContext));
      await this.destroyOwnedExecutionEnv(taskId);
      return err(invocationResult.error);
    }

    const invocation = invocationResult.value;
    const cleanupPaths = this.mergeCleanupPaths(invocation.cleanupPaths, sandboxContext);

    const createResult = this.deps.repository.create({
      id: taskId,
      personaId: input.personaId,
      providerName: providerEntry.provider.name,
      threadId: input.threadId,
      channelId: input.channelId,
      prompt: input.prompt,
      workingDirectory: input.workingDirectory ?? null,
      status: 'running',
      output: null,
      error: null,
      pid: null,
      timeoutMinutes,
      parentTraceparent: input.traceparent ?? null,
      sandboxEnabled: input.sandbox ?? false,
      primaryExecutionEnvId: sandboxContext?.primaryExecutionEnvId ?? null,
    });

    if (createResult.isErr()) {
      observation?.end();
      this.cleanupPaths(cleanupPaths);
      await this.destroyOwnedExecutionEnv(taskId);
      return err(new BackgroundAgentError(createResult.error.message, createResult.error));
    }

    if (sandboxContext && input.workingDirectory) {
      const uploadResult = await this.deps.executionEnvManager!.upload({
        envId: sandboxContext.primaryExecutionEnvId,
        sourcePath: input.workingDirectory,
        destinationPath: sandboxContext.envWorkingDirectory,
        recursive: true,
        allowedHostRoots: [input.workingDirectory],
      });
      if (uploadResult.isErr()) {
        observation?.end();
        this.deps.repository.updateStatus(taskId, 'failed', undefined, uploadResult.error.message);
        this.cleanupPaths(cleanupPaths);
        await this.destroyOwnedExecutionEnv(taskId);
        return err(new BackgroundAgentError(uploadResult.error.message, uploadResult.error));
      }
    }

    const processInstance = this.processFactory({
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      stdin: invocation.stdin,
      env: this.buildProviderEnv(taskId, invocation.env, sandboxContext),
      timeoutMs: invocation.timeoutMs,
    });

    const startResult = processInstance.start();
    if (startResult.isErr()) {
      observation?.end();
      this.deps.repository.updateStatus(taskId, 'failed', undefined, startResult.error.message);
      this.cleanupPaths(cleanupPaths);
      await this.destroyOwnedExecutionEnv(taskId);
      return err(startResult.error);
    }

    const { pid, completion } = startResult.value;
    if (pid !== null) {
      this.deps.repository.updatePid(taskId, pid);
    }

    this.processes.set(taskId, {
      kill: () => processInstance.kill(),
      cleanupPaths,
      provider: providerEntry.provider,
      observation,
    });

    void completion
      .then((result) => this.handleCompletion(taskId, result))
      .catch((cause) => {
        this.deps.logger.error({ err: cause, taskId }, 'background-agent: completion handling failed');
      });

    return ok(taskId);
  }

  getTask(taskId: string): Result<BackgroundTask | null, BackgroundAgentError> {
    const result = this.deps.repository.findById(taskId);
    return result.isOk()
      ? ok(result.value)
      : err(new BackgroundAgentError(result.error.message, result.error));
  }

  listTasksForThread(threadId: string, limit = 10): Result<BackgroundTask[], BackgroundAgentError> {
    const result = this.deps.repository.findByThread(threadId, limit);
    return result.isOk()
      ? ok(result.value)
      : err(new BackgroundAgentError(result.error.message, result.error));
  }

  getResult(taskId: string): Result<BackgroundTaskResult | null, BackgroundAgentError> {
    const taskResult = this.getTask(taskId);
    if (taskResult.isErr()) {
      return err(taskResult.error);
    }

    const task = taskResult.value;
    if (!task) {
      return ok(null);
    }

    const durationSeconds =
      task.completedAt && task.startedAt ? Math.max(0, Math.round((task.completedAt - task.startedAt) / 1000)) : 0;

    return ok({
      taskId: task.id,
      providerName: task.providerName,
      status: task.status,
      output: task.output,
      error: task.error,
      durationSeconds,
    });
  }

  async cancel(taskId: string): Promise<Result<boolean, BackgroundAgentError>> {
    const taskResult = this.deps.repository.findById(taskId);
    if (taskResult.isErr()) {
      return err(new BackgroundAgentError(taskResult.error.message, taskResult.error));
    }
    if (!taskResult.value || taskResult.value.status !== 'running') {
      return ok(false);
    }

    const managedProcess = this.processes.get(taskId);
    managedProcess?.kill();
    if (managedProcess) {
      managedProcess.observation?.update({ statusMessage: 'Cancelled by user' });
      managedProcess.observation?.end();
      this.cleanupPaths(managedProcess.cleanupPaths);
      this.processes.delete(taskId);
    }
    const updateResult = this.deps.repository.updateStatus(
      taskId,
      'cancelled',
      undefined,
      'Cancelled by user',
    );
    await this.destroyOwnedExecutionEnv(taskId);

    return updateResult.isOk()
      ? ok(true)
      : err(new BackgroundAgentError(updateResult.error.message, updateResult.error));
  }

  async recoverOrphanedTasks(): Promise<void> {
    const result = this.deps.repository.findActive();
    if (result.isErr()) {
      this.deps.logger.error({ err: result.error }, 'background-agent: failed to load active tasks');
      return;
    }

    for (const task of result.value) {
      if (!task.pid) {
        this.deps.repository.updateStatus(task.id, 'failed', undefined, 'daemon restarted during execution');
        await this.destroyOwnedExecutionEnv(task.id);
        continue;
      }

      if (!this.isPidAlive(task.pid)) {
        this.deps.repository.updateStatus(task.id, 'failed', undefined, 'daemon restarted during execution');
        await this.destroyOwnedExecutionEnv(task.id);
        continue;
      }

      const commandLine = this.readProcessCommandLine(task.pid);
      if (
        !commandLine
        || !this.enabledProviderCommands().some((command) => commandLine.includes(command))
      ) {
        this.deps.repository.updateStatus(task.id, 'failed', undefined, 'daemon restarted during execution (pid reused)');
        await this.destroyOwnedExecutionEnv(task.id);
        continue;
      }

      this.deps.repository.updateStatus(
        task.id,
        'failed',
        undefined,
        'daemon restarted during execution (cannot reattach)',
      );
      await this.destroyOwnedExecutionEnv(task.id);
    }
  }

  async shutdown(): Promise<void> {
    for (const [taskId, process] of this.processes) {
      process.kill();
      process.observation?.update({ statusMessage: 'Daemon shutting down' });
      process.observation?.end();
      this.deps.repository.updateStatus(taskId, 'cancelled', undefined, 'Daemon shutting down');
      this.cleanupPaths(process.cleanupPaths);
      await this.destroyOwnedExecutionEnv(taskId);
    }
    this.processes.clear();
  }

  private async handleCompletion(taskId: string, result: Result<unknown, BackgroundAgentError>): Promise<void> {
    const currentTaskResult = this.deps.repository.findById(taskId);
    if (currentTaskResult.isErr() || !currentTaskResult.value) {
      this.cleanupTask(taskId);
      return;
    }

    if (currentTaskResult.value.status === 'cancelled') {
      this.cleanupTask(taskId);
      return;
    }

    if (result.isErr()) {
      this.deps.repository.updateStatus(taskId, 'failed', undefined, this.truncate(result.error.message));
      this.enqueueNotification(taskId);
      const failedProcess = this.processes.get(taskId);
      failedProcess?.observation?.update({ statusMessage: result.error.message });
      failedProcess?.observation?.end();
      this.cleanupTask(taskId);
      await this.destroyOwnedExecutionEnv(taskId);
      return;
    }

    const processResult = result.value as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    };
    const managedProcess = this.processes.get(taskId);
    const parsedResult = managedProcess
      ? managedProcess.provider.parseBackgroundResult({
          stdout: processResult.stdout,
          stderr: processResult.stderr,
          exitCode: processResult.exitCode,
          timedOut: processResult.timedOut,
        })
      : {
          output: processResult.stdout,
          stderr: processResult.stderr,
          exitCode: processResult.exitCode,
          timedOut: processResult.timedOut,
        };

    let finalStatus: string;
    let finalStatusMessage: string | undefined;
    if (parsedResult.timedOut) {
      finalStatus = 'timed_out';
      finalStatusMessage = 'Process timed out';
      this.deps.repository.updateStatus(
        taskId,
        'timed_out',
        this.truncate(parsedResult.output),
        finalStatusMessage,
      );
    } else if (parsedResult.exitCode === 0) {
      finalStatus = 'completed';
      this.deps.repository.updateStatus(taskId, 'completed', this.truncate(parsedResult.output));
    } else {
      finalStatus = 'failed';
      finalStatusMessage = parsedResult.stderr || `Process exited with code ${parsedResult.exitCode}`;
      this.deps.repository.updateStatus(
        taskId,
        'failed',
        this.truncate(parsedResult.output),
        this.truncate(finalStatusMessage),
      );
    }

    managedProcess?.observation?.update({
      output: parsedResult.output?.trim(),
      statusMessage: finalStatusMessage ?? finalStatus,
    });
    managedProcess?.observation?.end();

    this.enqueueNotification(taskId);
    this.cleanupTask(taskId);
    await this.destroyOwnedExecutionEnv(taskId);
  }

  private enqueueNotification(taskId: string): void {
    const taskResult = this.deps.repository.findById(taskId);
    if (taskResult.isErr() || !taskResult.value) {
      return;
    }

    const task = taskResult.value;
    const title = this.notificationTitle(task.status);
    const preview = task.prompt.length > 80 ? `${task.prompt.slice(0, 77)}...` : task.prompt;
    const summary = this.notificationSummary(task).slice(0, 500);
    const durationSeconds =
      task.completedAt && task.startedAt ? Math.max(0, Math.round((task.completedAt - task.startedAt) / 1000)) : 0;

    const content = [
      `[Background Task ${title}] Task ${task.id}: "${preview}"`,
      `Status: ${task.status}`,
      `Provider: ${task.providerName}`,
      `Output summary: ${summary}`,
      `Working directory: ${task.workingDirectory ?? 'n/a'}`,
      `Duration: ${durationSeconds}s`,
    ].join('\n');

    const notifyResult = this.deps.queueManager.enqueue(task.threadId, 'collaboration', {
      personaId: task.personaId,
      kind: 'background_task_notification',
      taskId: task.id,
      providerName: task.providerName,
      status: task.status,
      content,
    });
    if (notifyResult.isErr()) {
      this.deps.logger.error(
        { taskId: task.id, err: notifyResult.error },
        'background-agent: failed to enqueue completion notification',
      );
    }

    const messageResult = this.deps.queueManager.enqueue(task.threadId, 'message', {
      personaId: task.personaId,
      content,
      providerName: task.providerName,
    });
    if (messageResult.isErr()) {
      this.deps.logger.error(
        { taskId: task.id, err: messageResult.error },
        'background-agent: failed to enqueue completion message',
      );
    }
  }

  private cleanupTask(taskId: string): void {
    const managedProcess = this.processes.get(taskId);
    if (managedProcess) {
      this.cleanupPaths(managedProcess.cleanupPaths);
      this.processes.delete(taskId);
    }
  }

  private cleanupPaths(paths: string[]): void {
    for (const path of new Set(paths)) {
      rmSync(path, { recursive: true, force: true });
    }
  }

  private async createSandboxContext(
    taskId: string,
    input: SpawnBackgroundAgentInput,
  ): Promise<Result<SandboxContext, BackgroundAgentError>> {
    if (!this.deps.executionEnvManager) {
      return err(
        new BackgroundAgentError(
          'Sandboxed background agents require execution environment support to be enabled',
        ),
      );
    }

    const controlDirectory = input.controlDirectory
      ?? mkdtempSync(join(tmpdir(), `talon-bg-control-${taskId}-`));
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });

    const envResult = await this.deps.executionEnvManager.create({
      threadId: input.threadId,
      personaId: input.workerPersonaId,
      ownerTaskId: taskId,
      ...(input.executionEnvDefaults?.baseSnapshot
        ? { baseSnapshot: input.executionEnvDefaults.baseSnapshot }
        : {}),
      ...(input.executionEnvDefaults?.workingDirectory
        ? { workingDirectory: input.executionEnvDefaults.workingDirectory }
        : {}),
      ...(input.executionEnvDefaults?.resourceLimits
        ? { resourceLimits: input.executionEnvDefaults.resourceLimits }
        : {}),
    });

    if (envResult.isErr()) {
      this.cleanupPaths([controlDirectory]);
      return err(new BackgroundAgentError(envResult.error.message, envResult.error));
    }

    return ok({
      primaryExecutionEnvId: envResult.value.id,
      envWorkingDirectory: envResult.value.workingDirectory,
      controlDirectory,
    });
  }

  private buildWorkerMcpServers(options: {
    baseMcpServers: Record<string, CanonicalMcpServer>;
    taskId: string;
    threadId: string;
    workerPersonaId: string;
    allowedMcpTools: string[];
    workingDirectory?: string;
    traceparent?: string;
    sandboxContext: SandboxContext | null;
  }): Record<string, CanonicalMcpServer> {
    const mcpServers: Record<string, CanonicalMcpServer> = {
      ...options.baseMcpServers,
    };

    if (!this.deps.hostToolsSocketPath || options.allowedMcpTools.length === 0) {
      return mcpServers;
    }

    mcpServers.__talond_host_tools = {
      transport: 'stdio',
      command: 'node',
      args: [join(import.meta.dirname, '../../../dist/tools/host-tools-mcp-server.js')],
      env: {
        ...process.env,
        TALOND_SOCKET: this.deps.hostToolsSocketPath,
        TALOND_RUN_ID: options.taskId,
        TALOND_THREAD_ID: options.threadId,
        TALOND_PERSONA_ID: options.workerPersonaId,
        TALOND_ALLOWED_TOOLS: options.allowedMcpTools.join(','),
        TALOND_TRACEPARENT: options.traceparent ?? '',
        TALOND_BACKGROUND_TASK_ID: options.taskId,
        ...(this.buildAllowedHostRootsEnv({
          workingDirectory: options.workingDirectory,
          sandboxContext: options.sandboxContext,
        })),
        ...(options.sandboxContext
          ? { TALOND_PRIMARY_EXECUTION_ENV_ID: options.sandboxContext.primaryExecutionEnvId }
          : {}),
      },
    };

    return mcpServers;
  }

  private buildAllowedHostRootsEnv(options: {
    workingDirectory?: string;
    sandboxContext: SandboxContext | null;
  }): Record<string, string> {
    const allowedHostRoots: string[] = [];

    if (options.workingDirectory) {
      allowedHostRoots.push(options.workingDirectory);
    }
    if (options.sandboxContext) {
      allowedHostRoots.push(options.sandboxContext.controlDirectory);
    }

    return allowedHostRoots.length > 0
      ? { TALOND_ALLOWED_HOST_ROOTS: JSON.stringify(allowedHostRoots) }
      : {};
  }

  private buildProviderEnv(
    taskId: string,
    invocationEnv: Record<string, string> | undefined,
    sandboxContext: SandboxContext | null,
  ): Record<string, string> | undefined {
    const env = {
      ...(invocationEnv ?? {}),
      TALON_BACKGROUND_TASK_ID: taskId,
      ...(sandboxContext
        ? {
            TALON_PRIMARY_EXECUTION_ENV_ID: sandboxContext.primaryExecutionEnvId,
            TALON_PRIMARY_EXECUTION_ENV_CWD: sandboxContext.envWorkingDirectory,
          }
        : {}),
    };

    return Object.keys(env).length > 0 ? env : undefined;
  }

  private mergeCleanupPaths(
    invocationCleanupPaths: string[],
    sandboxContext: SandboxContext | null,
  ): string[] {
    return sandboxContext
      ? [...invocationCleanupPaths, sandboxContext.controlDirectory]
      : invocationCleanupPaths;
  }

  private async destroyOwnedExecutionEnv(taskId: string): Promise<void> {
    if (!this.deps.executionEnvManager) {
      return;
    }

    try {
      await this.deps.executionEnvManager.destroyOwnedByTask(taskId);
    } catch (cause) {
      this.deps.logger.warn(
        { err: cause, taskId },
        'background-agent: failed to destroy owned execution environment',
      );
    }
  }

  private enabledProviderCommands(): string[] {
    return this.deps.providerRegistry
      .listEnabled()
      .map((name) => this.deps.providerRegistry.get(name)?.config.command)
      .filter((command): command is string => typeof command === 'string' && command.length > 0);
  }

  private buildSystemPrompt(options: {
    personaPrompt: string;
    taskPrompt: string;
    taskId: string;
    threadId: string;
    channelName: string;
    threadContext?: string;
    channelContext?: string;
    timeContext?: string;
  }): string {
    return [
      options.personaPrompt,
      options.channelContext || '',
      options.timeContext || '',
      '## Background Task Context',
      `Task ID: ${options.taskId}`,
      `Thread ID: ${options.threadId}`,
      `Channel: ${options.channelName}`,
      options.threadContext ? `Thread summary:\n${options.threadContext}` : '',
      '## Background Task Instructions',
      'You are running as an autonomous background agent.',
      'No human is watching this session, so make reasonable decisions and continue.',
      'Finish the task and leave a concise final summary of what you changed or learned.',
      '## Task',
      options.taskPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private truncate(value?: string): string | undefined {
    return value === undefined ? undefined : value.slice(0, MAX_STORED_OUTPUT);
  }

  private notificationTitle(status: BackgroundTask['status']): string {
    switch (status) {
      case 'completed':
        return 'Complete';
      case 'timed_out':
        return 'Timed Out';
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Failed';
    }
  }

  private notificationSummary(task: BackgroundTask): string {
    if (task.status === 'completed') {
      return task.output ?? 'No output';
    }

    return task.error ?? task.output ?? 'No output';
  }
}
