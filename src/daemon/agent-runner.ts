import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';

import type { DaemonContext } from './daemon-context.js';
import type { AssembledContext } from './context-assembler.js';
import type { QueueItem } from '../queue/queue-types.js';
import { filterAllowedMcpTools } from '../tools/tool-filter.js';
import { resolveToolInstructions } from '../tools/tool-instructions.js';
import { resolveMcpServers } from '../mcp/resolve-mcp-servers.js';
import { buildPersonaRuntimeContext } from '../personas/persona-runtime-context.js';
import {
  TALON_SKILL_LOAD_TOOL_DESCRIPTION,
  formatMissingTalonSkillError,
} from '../skills/skill-runtime-text.js';
import { getProviderAffinityResetAt } from '../threads/thread-metadata.js';
import { readScheduleOriginExternalId } from './schedule-thread-utils.js';
import { buildTimeContext } from '../core/time-context.js';
import type { ReasoningEffort } from '../core/config/config-types.js';
import { formatToolCall } from './tool-name-formatter.js';
import {
  buildLifecycleContentPreview,
  resolveLifecycleOutboundContent,
} from '../lifecycle/outbound-content-preview.js';
import type { ChannelConnector } from '../channels/channel-types.js';
import type {
  AgentUsage,
  ContextUsage,
  ContextMetricName,
  ResolvedContextUsage,
  CanonicalMcpSdkServer,
  CanonicalMcpServer,
} from '../providers/provider-types.js';
import type { LifecycleEventEnvelope } from '../lifecycle/contracts/index.js';
import type { TransactionContext } from '../lifecycle/transaction-context.js';
import type { ContextRotationResult } from './context-roller.js';
import type { StartedObservationHandle } from '../observability/langfuse/observability-types.js';
import { generateBridgeSecret, TALOND_BRIDGE_SECRET_ENV } from '../tools/host-tools-bridge-auth.js';

/** Default maximum time (ms) a provider query (SDK or CLI) may run before being aborted. */
const DEFAULT_QUERY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface OutboundDeliveryIdentity {
  readonly messageId: string;
  readonly idempotencyKey: string;
}

interface DurableContextRotationState {
  readonly boundary: number;
  readonly hasOpenThreads: boolean;
  readonly rotationCauseQueueItemId?: string;
}

interface PendingNoIdProviderToolObservation {
  readonly observation: StartedObservationHandle;
  readonly toolCallId: string;
}

class AgentQueryAttemptError extends Error {
  constructor(
    message: string,
    readonly resumeSessionId: string | undefined,
    readonly sawEvents: boolean,
  ) {
    super(message);
    this.name = 'AgentQueryAttemptError';
  }
}

/**
 * AgentRunner — executes queue items through the configured agent provider.
 *
 * Extracted from TalondDaemon.handleQueueItem to enable isolated testing
 * and cleaner separation of concerns.
 */
export class AgentRunner {
  private readonly ctx: DaemonContext;
  private readonly queryTimeoutMs: number;

  constructor(ctx: DaemonContext, options?: { queryTimeoutMs?: number }) {
    this.ctx = ctx;
    this.queryTimeoutMs = options?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  }

  /**
   * Processes a single queue item by loading the persona, initializing
   * the workspace, running the Agent SDK query, and sending the response
   * back through the channel connector.
   */
  async run(item: QueueItem): Promise<Result<void, Error>> {
    const backgroundTaskNotification = this.parseBackgroundTaskNotification(item);
    if (backgroundTaskNotification) {
      return this.deliverBackgroundTaskNotification(item.threadId, backgroundTaskNotification);
    }

    // Detect A2A task collaboration items and flag for special handling.
    // isA2ATask is only true when taskId is a non-empty string, preventing null ID updates.
    const payloadTaskId = item.payload?.taskId;
    const a2aTaskId =
      item.type === 'collaboration' &&
      item.payload?.kind === 'a2a_task' &&
      typeof payloadTaskId === 'string' &&
      payloadTaskId.length > 0
        ? payloadTaskId
        : null;
    const isA2ATask = a2aTaskId !== null;
    const isScheduleTask = item.type === 'schedule';

    const personaId = typeof item.payload.personaId === 'string' ? item.payload.personaId : null;
    if (personaId === null) {
      this.failA2ATask(
        a2aTaskId,
        'MISSING_PERSONA_ID',
        `queue item ${item.id} is missing payload.personaId`,
      );
      return err(new Error(`queue item ${item.id} is missing payload.personaId`));
    }

    const personaRowResult = this.ctx.repos.persona.findById(personaId);
    if (personaRowResult.isErr() || personaRowResult.value === null) {
      this.failA2ATask(a2aTaskId, 'PERSONA_NOT_FOUND', `persona not found for id ${personaId}`);
      return err(new Error(`persona not found for id ${personaId}`));
    }

    const personaName = personaRowResult.value.name;
    const loadedPersonaResult = this.ctx.personaLoader.getByName(personaName);
    if (loadedPersonaResult.isErr() || loadedPersonaResult.value === undefined) {
      this.failA2ATask(
        a2aTaskId,
        'PERSONA_LOAD_FAILED',
        `loaded persona not found for ${personaName}`,
      );
      return err(new Error(`loaded persona not found for ${personaName}`));
    }
    const loadedPersona = loadedPersonaResult.value;
    const queryTimeoutMs =
      loadedPersona.config.queryTimeoutMinutes !== undefined
        ? loadedPersona.config.queryTimeoutMinutes * 60 * 1000
        : this.queryTimeoutMs;
    let model = loadedPersona.config.model;
    const reasoningEffort = loadedPersona.config.reasoningEffort;

    const threadResult = this.ctx.repos.thread.findById(item.threadId);
    const providerAffinityResetAt =
      threadResult.isOk() && threadResult.value
        ? getProviderAffinityResetAt(threadResult.value.metadata)
        : undefined;

    const affinityProviderResult =
      !isA2ATask && !isScheduleTask
        ? this.ctx.repos.run.getLatestProviderName(item.threadId, {
            excludeCollaboration: true,
            ...(providerAffinityResetAt !== undefined
              ? { sinceCreatedAt: providerAffinityResetAt }
              : {}),
          })
        : ok(null);
    const affinityProviderName =
      affinityProviderResult.isOk() && affinityProviderResult.value
        ? affinityProviderResult.value
        : null;
    const personaProviderName =
      typeof loadedPersona.config.provider === 'string' && loadedPersona.config.provider.length > 0
        ? loadedPersona.config.provider
        : null;
    const configuredDefaultProvider = this.ctx.config.agentRunner?.defaultProvider ?? 'claude-code';
    const preferredProviderOrder = (
      isA2ATask
        ? [
            // A2A tasks execute under the target persona on the source thread.
            // Source-thread provider affinity must not override the delegated
            // persona's provider selection.
            personaProviderName,
            configuredDefaultProvider,
          ]
        : [affinityProviderName, personaProviderName, configuredDefaultProvider]
    ).filter((name): name is string => typeof name === 'string' && name.length > 0);

    let providerEntry = this.ctx.providerRegistry.getDefault(preferredProviderOrder);
    if (!providerEntry) {
      this.failA2ATask(a2aTaskId, 'NO_PROVIDER', 'No enabled agent runner provider is configured');
      return err(new Error('No enabled agent runner provider is configured'));
    }

    const runId = uuidv4();
    const runInterception = this.interceptRunBeforeExecute({
      runId,
      threadId: item.threadId,
      personaName,
      provider: providerEntry.provider.name,
      model,
      queueItemId: item.id,
      itemType: item.type,
    });
    if (runInterception.isErr()) {
      const finalized = this.insertAndFinalizePreExecutionFailedRun(
        runId,
        {
          threadId: item.threadId,
          personaId,
          queueItemId: item.id,
          provider: providerEntry.provider.name,
          model,
          reasoningEffort,
          error: runInterception.error.message,
        },
        personaName,
      );
      if (finalized.isErr()) {
        this.ctx.logger.error(
          { runId, err: finalized.error.message },
          'agent-runner: failed to finalize blocked run',
        );
      }
      this.failA2ATask(a2aTaskId, 'RUN_BLOCKED', runInterception.error.message);
      return err(runInterception.error);
    }
    const lifecycleRunContextAdditions = runInterception.value.contextAdditions;
    if (runInterception.value.provider !== providerEntry.provider.name) {
      const transformedProvider = this.ctx.providerRegistry.get(runInterception.value.provider);
      if (!transformedProvider) {
        const error = new Error(
          `Lifecycle run interceptor selected unavailable provider "${runInterception.value.provider}"`,
        );
        const finalized = this.insertAndFinalizePreExecutionFailedRun(
          runId,
          {
            threadId: item.threadId,
            personaId,
            queueItemId: item.id,
            provider: runInterception.value.provider,
            model: runInterception.value.model,
            reasoningEffort,
            error: error.message,
          },
          personaName,
        );
        if (finalized.isErr()) {
          this.ctx.logger.error(
            { runId, err: finalized.error.message },
            'agent-runner: failed to finalize unavailable transformed provider run',
          );
        }
        this.failA2ATask(a2aTaskId, 'NO_PROVIDER', error.message);
        return err(error);
      }
      providerEntry = transformedProvider;
    }
    model = runInterception.value.model;

    const strategy = providerEntry.provider.createExecutionStrategy();
    const sessionProviderName = providerEntry.provider.name;

    // Resolve session ID only for providers that support session resumption.
    // We do NOT seed the tracker here — only after a successful run
    // to avoid stranding a thread on a stale/expired session ID.
    //
    // A2A tasks run on the *source* thread but execute under the *target* persona.
    // Restoring a session keyed by the source thread would attach the wrong
    // persona's session history. Skip session restoration for A2A items entirely
    // so each delegation starts a fresh context.
    let resolvedSessionId: string | undefined;
    if (strategy.supportsSessionResumption && !isA2ATask && !isScheduleTask) {
      const durableContextRotation = this.latestDurableContextRotationState(item.threadId);
      const durableContextRotationAt = durableContextRotation?.boundary;
      const sessionLookupSinceCreatedAt =
        providerAffinityResetAt === undefined
          ? durableContextRotationAt
          : durableContextRotationAt === undefined
            ? providerAffinityResetAt
            : Math.max(providerAffinityResetAt, durableContextRotationAt);
      const sessionLookupOptions = {
        excludeCollaboration: true,
        modelName: model,
        reasoningEffort: reasoningEffort ?? null,
        ...(sessionLookupSinceCreatedAt !== undefined
          ? { sinceCreatedAt: sessionLookupSinceCreatedAt }
          : {}),
      };

      if (providerAffinityResetAt !== undefined) {
        const latestPostResetSessionResult = this.ctx.repos.run.getLatestSessionId(
          item.threadId,
          sessionProviderName,
          sessionLookupOptions,
        );
        const hasPostResetSession =
          latestPostResetSessionResult.isOk() && latestPostResetSessionResult.value !== null;

        if (!hasPostResetSession) {
          this.ctx.sessionTracker.clearSession(item.threadId, sessionProviderName);
        } else {
          resolvedSessionId =
            reasoningEffort !== undefined
              ? this.ctx.sessionTracker.getSessionId(
                  item.threadId,
                  sessionProviderName,
                  model,
                  reasoningEffort,
                )
              : this.ctx.sessionTracker.getSessionId(item.threadId, sessionProviderName, model);
        }
      } else {
        resolvedSessionId =
          reasoningEffort !== undefined
            ? this.ctx.sessionTracker.getSessionId(
                item.threadId,
                sessionProviderName,
                model,
                reasoningEffort,
              )
            : this.ctx.sessionTracker.getSessionId(item.threadId, sessionProviderName, model);
      }
      if (!resolvedSessionId && !this.ctx.sessionTracker.wasRotated(item.threadId)) {
        const dbSessionResult = this.ctx.repos.run.getLatestSessionId(
          item.threadId,
          sessionProviderName,
          sessionLookupOptions,
        );
        if (dbSessionResult.isOk() && dbSessionResult.value) {
          resolvedSessionId = dbSessionResult.value;
          this.ctx.logger.info(
            { threadId: item.threadId, sessionId: resolvedSessionId },
            'agent-runner: restored session from DB after restart',
          );
        }
      }
    }

    const now = Date.now();

    const runInput = {
      id: runId,
      thread_id: item.threadId,
      persona_id: personaId,
      provider_name: providerEntry.provider.name,
      model_name: model,
      reasoning_effort: reasoningEffort ?? null,
      sandbox_id: null,
      session_id: resolvedSessionId ?? null,
      status: 'running',
      parent_run_id: null,
      queue_item_id: item.id,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: now,
      ended_at: null,
    } as const;

    const runInsert = this.ctx.lifecycleRuntime
      ? this.ctx.lifecycleRuntime.transaction((transaction) => {
          const inserted = this.ctx.repos.run.insert(runInput);
          if (inserted.isErr()) return err(inserted.error);
          const published = this.publishRunEvent(
            'run.started.v1',
            {
              runId,
              threadId: item.threadId,
              personaId,
              queueItemId: item.id,
              provider: providerEntry.provider.name,
              model,
              status: 'running',
            },
            personaName,
            transaction,
          );
          return published.isErr() ? err(published.error) : ok(inserted.value);
        })
      : this.ctx.repos.run.insert(runInput);

    if (runInsert.isErr()) {
      // Mark A2A task as failed — run record creation failed, so the task cannot proceed.
      if (isA2ATask && a2aTaskId) {
        this.ctx.repos.a2aTask
          .markFailed(a2aTaskId, 'RUN_INSERT_ERROR', runInsert.error.message)
          .mapErr((e) => {
            this.ctx.logger.warn(
              { a2aTaskId, err: e.message },
              'agent-runner: failed to mark A2A task as failed after run insert error',
            );
          });
      }
      return err(new Error(`failed to create run record: ${runInsert.error.message}`));
    }

    // Mark A2A task as 'working' now that a run record exists.
    if (isA2ATask && a2aTaskId) {
      this.ctx.repos.a2aTask.markWorking(a2aTaskId, runId).mapErr((e) => {
        this.ctx.logger.warn(
          { a2aTaskId, runId, err: e.message },
          'agent-runner: failed to mark A2A task as working',
        );
      });
    }

    const content = typeof item.payload.content === 'string' ? item.payload.content : '';
    let runFinalized = false;
    const bridgeSecret = generateBridgeSecret();
    this.ctx.hostToolsBridge.registerRunAuthentication?.({
      runId,
      threadId: item.threadId,
      personaId,
      bridgeSecret,
    });

    const observedRunInput = {
      content,
      itemType: item.type,
      persona: personaName,
      provider: providerEntry.provider.name,
    };

    const runMetadata = {
      runId,
      threadId: item.threadId,
      personaId,
      personaName,
      provider: providerEntry.provider.name,
    };

    try {
      await this.ctx.observability.observe(
        {
          type: 'agent',
          name: 'foreground-run',
          input: observedRunInput,
          metadata: runMetadata,
          trace: {
            sessionId: item.threadId,
            userId: this.ctx.config.langfuse?.owner,
            tags: [
              `persona:${personaName}`,
              `itemType:${item.type}`,
              `provider:${providerEntry.provider.name}`,
            ],
            input: observedRunInput,
            metadata: runMetadata,
          },
        },
        async (runObservation) => {
          let typingInterval: ReturnType<typeof setInterval> | undefined;
          try {
            const workspaceResult = this.ctx.threadWorkspace.ensureDirectories(item.threadId);
            if (workspaceResult.isErr()) {
              throw new Error(workspaceResult.error.message);
            }

            const personaSkills = this.ctx.loadedSkills.filter((skill) =>
              loadedPersona.config.skills.includes(skill.manifest.name),
            );
            const skillContentMap = new Map<string, string>();
            for (const skill of personaSkills) {
              skillContentMap.set(skill.manifest.name, skill.promptContents.join('\n'));
            }
            const personaRuntimeContext = buildPersonaRuntimeContext({
              loadedPersona,
              resolvedSkills: personaSkills,
              skillResolver: this.ctx.skillResolver,
              logger: this.ctx.logger,
            });

            // Build channel context so the agent knows which channels are available.
            const threadRow = this.ctx.repos.thread.findById(item.threadId);
            const currentChannelRow =
              threadRow.isOk() && threadRow.value
                ? this.ctx.repos.channel.findById(threadRow.value.channel_id)
                : null;
            const currentChannelName =
              currentChannelRow && currentChannelRow.isOk() && currentChannelRow.value
                ? currentChannelRow.value.name
                : undefined;
            const allChannels = this.ctx.channelRegistry.listAll().map((c) => c.name);

            const channelContext = [
              'Available channels for channel_send tool:',
              ...allChannels.map((name) =>
                name === currentChannelName ? `  - ${name} (current thread)` : `  - ${name}`,
              ),
              currentChannelName
                ? `When sending messages, use channelId: "${currentChannelName}".`
                : '',
            ]
              .filter(Boolean)
              .join('\n');

            // Generate a cache-friendly time context (10-min window instead of exact timestamp).
            const timeContext = buildTimeContext();
            const existingSessionId = strategy.supportsSessionResumption
              ? resolvedSessionId
              : undefined;

            const baseMcpServers: Record<string, CanonicalMcpServer> = {
              ...personaRuntimeContext.mcpServers,
            };

            // Determine which host tools this persona may use based on capabilities.
            let allowedMcpTools = filterAllowedMcpTools(
              loadedPersona.resolvedCapabilities ?? { allow: [], requireApproval: [] },
            );
            if (!this.ctx.backgroundAgentManager) {
              allowedMcpTools = allowedMcpTools.filter(
                (toolName) => toolName !== 'background_agent',
              );
            }

            this.ctx.logger.info(
              { runId, personaId, allowedMcpTools },
              'agent-sdk: persona tool restrictions applied',
            );

            // Resolve channel connector early so we can send typing indicators.
            const threadResult = this.ctx.repos.thread.findById(item.threadId);
            const channelRow =
              threadResult.isOk() && threadResult.value
                ? this.ctx.repos.channel.findById(threadResult.value.channel_id)
                : null;
            const connector =
              channelRow && channelRow.isOk() && channelRow.value
                ? this.ctx.channelRegistry.get(channelRow.value.name)
                : undefined;
            // For dedicated schedule execution threads (kind='schedule'),
            // the thread's own external_id is a synthetic marker, not a
            // valid provider recipient. Prefer metadata.originExternalId
            // so typing indicators and any agent-runner-originated
            // outbound reach the originating chat (issue #200).
            const externalId =
              threadResult.isOk() && threadResult.value
                ? (readScheduleOriginExternalId(threadResult.value.metadata) ??
                  threadResult.value.external_id)
                : undefined;
            const channelName =
              channelRow?.isOk() && channelRow.value ? channelRow.value.name : undefined;
            const channelConfig = channelName
              ? this.ctx.config.channels?.find((c) => c.name === channelName)
              : undefined;
            const showToolCalls = channelConfig?.showToolCalls ?? false;

            // Send typing indicator and keep it alive every 4s while the agent works.
            // A2A tasks must not send typing indicators to the source thread's channel
            // — the human should not see activity from a delegated persona.
            if (!isA2ATask && connector?.sendTyping && externalId) {
              connector.sendTyping(externalId).catch((e: unknown) => {
                this.ctx.logger.debug({ err: e }, 'sendTyping failed');
              });
              typingInterval = setInterval(() => {
                connector.sendTyping!(externalId).catch((e: unknown) => {
                  this.ctx.logger.debug({ err: e }, 'sendTyping failed');
                });
              }, 4000);
            }

            let previousContextResolved = false;
            let previousContext: AssembledContext | undefined;
            const contextManagement = providerEntry.config.contextManagement;
            if (
              contextManagement?.enabled &&
              (contextManagement.triggerMetric === undefined ||
                contextManagement.thresholdRatio === undefined ||
                contextManagement.recentMessageCount === undefined ||
                ((contextManagement.mode ?? 'summarizer') === 'observation'
                  ? contextManagement.observer === undefined ||
                    contextManagement.reducer === undefined
                  : contextManagement.summarizer === undefined))
            ) {
              throw new Error(
                `Provider "${providerEntry.provider.name}" has incomplete contextManagement configuration. Check agentRunner.providers.${providerEntry.provider.name}.contextManagement.`,
              );
            }
            const enabledContextManagement = contextManagement?.enabled
              ? {
                  triggerMetric: contextManagement.triggerMetric!,
                  thresholdRatio: contextManagement.thresholdRatio!,
                  recentMessageCount: contextManagement.recentMessageCount,
                  mode: contextManagement.mode ?? 'summarizer',
                  summarizer: contextManagement.summarizer,
                  observer: contextManagement.observer,
                  reducer: contextManagement.reducer,
                  reflectionThresholdChars: contextManagement.reflectionThresholdChars,
                }
              : null;
            // Fresh-session history injection is independent of automatic rotation.
            // Non-resumable providers (e.g. Gemini) always run fresh sessions and
            // need recent messages for multi-turn continuity even when automatic
            // context management (rotation) is disabled.
            const DEFAULT_FRESH_SESSION_RECENT_MESSAGES = 10;
            const freshSessionRecentMessageCount = enabledContextManagement
              ? enabledContextManagement.recentMessageCount
              : (contextManagement?.recentMessageCount ?? DEFAULT_FRESH_SESSION_RECENT_MESSAGES);
            const getPreviousContext = async (): Promise<AssembledContext> => {
              if (!previousContextResolved) {
                previousContext = await this.ctx.observability.observe(
                  {
                    type: 'retriever',
                    name: 'previous-context',
                    metadata: {
                      threadId: item.threadId,
                    },
                  },
                  (retrieverObservation) => {
                    // Exclude the message being processed (if any) from the
                    // "Recent Messages" block. That message is already passed
                    // as the live prompt (`content`), and re-echoing it in
                    // the system prompt made stateless providers respond
                    // twice — once to the `[previous turn, user]: …` entry
                    // and once to the prompt itself.
                    const assembled = this.ctx.contextAssembler.assemble(
                      item.threadId,
                      freshSessionRecentMessageCount,
                      { excludeMessageId: item.messageId },
                    );
                    retrieverObservation.update({
                      output: assembled.text,
                      metadata: {
                        threadId: item.threadId,
                        summaryFound: assembled.summaryFound,
                        recentMessageCount: assembled.recentMessageCount,
                        charCount: assembled.charCount,
                      },
                    });
                    return assembled;
                  },
                );
                previousContextResolved = true;
              }

              return previousContext!;
            };

            const suppressCliWaitingMessage =
              providerEntry.type === 'gemini-cli' ||
              providerEntry.type === 'codex-cli' ||
              providerEntry.type === 'openai-compatible';

            if (
              strategy.type === 'cli' &&
              !suppressCliWaitingMessage &&
              !isA2ATask &&
              connector &&
              externalId &&
              !isScheduleTask
            ) {
              const waitingResult = await this.sendLifecycleOutboundMessage({
                content: 'Thinking...',
                connector,
                externalId,
                runId,
                threadId: item.threadId,
                personaName,
                channelName,
                itemOrigin: 'run',
                itemType: 'message',
                messageId: `outbound:${item.id}:waiting`,
              });
              if (waitingResult.isErr()) {
                this.ctx.logger.debug(
                  { err: waitingResult.error },
                  'agent-runner: waiting notification failed',
                );
              }
            }

            const executeAgentQuery = async (
              resumeSessionId?: string,
            ): Promise<{
              outputText: string;
              fullOutputText: string;
              resultSessionId: string | undefined;
              usage: AgentUsage;
              lastStepUsage: AgentUsage | undefined;
            }> => {
              const toolInstructionsBlock = resolveToolInstructions(
                this.ctx.toolInstructions,
                allowedMcpTools,
              );
              const systemPromptParts = [
                personaRuntimeContext.personaPrompt,
                toolInstructionsBlock,
                channelContext,
                timeContext,
              ];
              if (lifecycleRunContextAdditions) {
                systemPromptParts.push(
                  `Lifecycle Context Additions:\n${JSON.stringify(lifecycleRunContextAdditions)}`,
                );
              }
              if (!resumeSessionId && !isScheduleTask) {
                const previous = await getPreviousContext();
                if (previous.text) {
                  systemPromptParts.push(previous.text);
                }
              }

              const systemPrompt = systemPromptParts.filter(Boolean).join('\n\n');

              return await this.ctx.observability.observe(
                {
                  type: 'generation',
                  name: 'provider-attempt',
                  input: {
                    prompt: content,
                    systemPrompt,
                    resumeSessionId: resumeSessionId ?? null,
                  },
                  metadata: {
                    runId,
                    threadId: item.threadId,
                    provider: providerEntry.provider.name,
                    resumeSessionId: resumeSessionId ?? null,
                  },
                  model,
                },
                async (generationObservation) => {
                  const sdkSkillServer: Record<string, CanonicalMcpSdkServer> = {};
                  if (
                    providerEntry.provider.skillLoaderTransport === 'in-process' &&
                    skillContentMap.size > 0
                  ) {
                    const skillLoaderServer = createSdkMcpServer({
                      name: '__talond_skill_loader',
                      tools: [
                        tool(
                          'skill_load',
                          TALON_SKILL_LOAD_TOOL_DESCRIPTION,
                          { name: z.string().describe('Skill name') },
                          async (args) => {
                            await Promise.resolve();
                            const content = skillContentMap.get(args.name);
                            if (content === undefined) {
                              return {
                                content: [
                                  {
                                    type: 'text' as const,
                                    text: `Error: ${formatMissingTalonSkillError(args.name, [...skillContentMap.keys()])}`,
                                  },
                                ],
                                isError: true,
                              };
                            }

                            this.ctx.logger.info({ runId, skill: args.name }, 'skill.loaded');
                            return {
                              content: [{ type: 'text' as const, text: content }],
                            };
                          },
                        ),
                      ],
                    });
                    sdkSkillServer.__talond_skill_loader = {
                      transport: 'sdk',
                      instance: skillLoaderServer,
                    };
                  }

                  const mcpServers: Record<string, CanonicalMcpServer> = {
                    ...baseMcpServers,
                    ...sdkSkillServer,
                    __talond_host_tools: {
                      transport: 'stdio',
                      command: 'node',
                      args: [
                        join(import.meta.dirname, '../../dist/tools/host-tools-mcp-server.js'),
                      ],
                      env: {
                        ...process.env,
                        [TALOND_BRIDGE_SECRET_ENV]: bridgeSecret,
                        TALOND_SOCKET: this.ctx.hostToolsBridge.path,
                        TALOND_RUN_ID: runId,
                        TALOND_THREAD_ID: item.threadId,
                        TALOND_PERSONA_ID: personaId,
                        TALOND_ALLOWED_TOOLS: allowedMcpTools.join(','),
                        TALOND_ALLOWED_HOST_ROOTS: JSON.stringify([workspaceResult.value]),
                        TALOND_TRACEPARENT: generationObservation.getTraceparent() ?? '',
                        ...(isA2ATask && a2aTaskId
                          ? {
                              TALOND_A2A_TASK_ID: a2aTaskId,
                              TALOND_A2A_HOP_COUNT: String(
                                typeof item.payload?.hopCount === 'number'
                                  ? item.payload.hopCount
                                  : 0,
                              ),
                            }
                          : {}),
                      },
                    },
                  };

                  if (
                    providerEntry.provider.skillLoaderTransport === 'stdio' &&
                    skillContentMap.size > 0
                  ) {
                    mcpServers.__talond_skill_loader = {
                      transport: 'stdio',
                      command: 'node',
                      args: [
                        join(import.meta.dirname, '../../dist/tools/skill-loader-mcp-server.js'),
                      ],
                      env: {
                        ...process.env,
                        [TALOND_BRIDGE_SECRET_ENV]: bridgeSecret,
                        TALOND_SOCKET: this.ctx.hostToolsBridge.path,
                        TALOND_RUN_ID: runId,
                        TALOND_THREAD_ID: item.threadId,
                        TALOND_PERSONA_ID: personaId,
                        TALOND_TRACEPARENT: generationObservation.getTraceparent() ?? '',
                      },
                    };
                  }

                  this.ctx.logger.info(
                    {
                      runId,
                      personaId,
                      model,
                      threadId: item.threadId,
                      provider: providerEntry.provider.name,
                      resumeSession: resumeSessionId ?? null,
                    },
                    'agent-runner: starting query',
                  );

                  let outputText = '';
                  let fullOutputText = '';
                  let resultSessionId: string | undefined;
                  let usage: AgentUsage = {
                    inputTokens: 0,
                    outputTokens: 0,
                  };
                  // Distinct accumulator for per-step usage (final model
                  // turn only). When the provider reports it, rotation
                  // gating uses this in preference to the cumulative
                  // `usage` so multi-tool runs don't trigger spurious
                  // rotations from inflated cross-turn token sums.
                  let lastStepUsage: AgentUsage | undefined;
                  let sawEvents = false;
                  const activeProviderToolObservations = new Map<
                    string,
                    StartedObservationHandle
                  >();
                  const ignoredProviderToolUseIds = new Set<string>();
                  const pendingProviderToolTasks: Array<Promise<void>> = [];
                  // FIFO queue for tool events that lack a toolUseId (e.g. claude-code tool_use/tool_result
                  // streaming events). Events are sequential so FIFO order correctly pairs starts with ends.
                  const pendingNoIdToolObservations: PendingNoIdProviderToolObservation[] = [];

                  // Materialize dynamic auth (OAuth bearers) on HTTP MCP
                  // entries before handing them to the provider. Providers
                  // stay completely unaware of `auth` — the resolver
                  // strips the field and merges Authorization into headers.
                  // Failure here surfaces with a "run talonctl auth-mcp …"
                  // message so the operator can fix it without restarting.
                  const resolvedMcpServers = await resolveMcpServers(mcpServers, {
                    tokenStore: this.ctx.oauthTokenStore,
                  });

                  const queryInput = {
                    threadId: item.threadId,
                    prompt: content,
                    systemPrompt,
                    mcpServers: resolvedMcpServers,
                    cwd: workspaceResult.value,
                    model,
                    maxTurns: 25,
                    timeoutMs: queryTimeoutMs,
                    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
                    ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
                  };

                  let activeIterator: AsyncIterator<unknown> | undefined;

                  const queryPromise = (async (): Promise<void> => {
                    if (strategy.type === 'sdk') {
                      let stream: ReturnType<typeof strategy.run>;
                      try {
                        stream = strategy.run(queryInput);
                      } catch (cause) {
                        const message = cause instanceof Error ? cause.message : String(cause);
                        throw new AgentQueryAttemptError(message, resumeSessionId, false);
                      }

                      const iterator = stream[Symbol.asyncIterator]();
                      activeIterator = iterator;

                      // Manually drive the iterator so the catch block can abort this exact instance
                      for (;;) {
                        const next = await iterator.next();
                        if (next.done) break;
                        const event = next.value;
                        sawEvents = true;
                        if (event.type === 'text') {
                          outputText += event.content;
                          fullOutputText += event.content;
                        } else if (event.type === 'result') {
                          resultSessionId = event.result.sessionId;
                          usage = event.result.usage;
                          lastStepUsage = event.result.lastStepUsage;

                          if (!fullOutputText && event.result.output) {
                            outputText = event.result.output;
                            fullOutputText = event.result.output;
                          }

                          if (event.result.isError) {
                            this.ctx.logger.warn(
                              { runId, result: event.result.output },
                              'agent-runner: run ended with provider error',
                            );
                          }
                        } else if (event.type === 'tool_event') {
                          // Flush buffered text before tool execution so each text block
                          // is delivered as a separate channel message (issue #102).
                          const isToolUse =
                            event.messageType === 'tool_use' ||
                            event.messageType === 'server_tool_use' ||
                            event.messageType === 'mcp_tool_use';
                          if (
                            isToolUse &&
                            item.type !== 'schedule' &&
                            !isA2ATask &&
                            connector !== undefined &&
                            externalId
                          ) {
                            // Flush preceding text first, then show tool description (issue #102 + #108).
                            if (outputText) {
                              const originalOutputText = outputText;
                              const flushIdentity = this.runOutboundDeliveryIdentity(
                                item.id,
                                `stream:${streamOutboundMessageIndex++}`,
                              );
                              const flushResult = await this.sendLifecycleOutboundMessage({
                                content: outputText,
                                connector,
                                externalId,
                                runId,
                                threadId: item.threadId,
                                personaName,
                                channelName,
                                itemOrigin: 'run',
                                itemType: 'message',
                                messageId: flushIdentity.messageId,
                                idempotencyKey: flushIdentity.idempotencyKey,
                              });
                              if (flushResult.isErr()) {
                                throw new Error(
                                  `channel send failed: ${flushResult.error.message}`,
                                );
                              }
                              fullOutputText = fullOutputText.endsWith(originalOutputText)
                                ? `${fullOutputText.slice(0, -originalOutputText.length)}${flushResult.value.content}`
                                : fullOutputText;
                              hasReservedIntermediateTextOutbound = true;
                              outputText = '';
                              fullOutputText += '\n\n';
                            }
                            // Optionally send human-readable tool description after preceding text (issue #108).
                            const isInternalServer =
                              event.messageType === 'mcp_tool_use' &&
                              event.serverName?.startsWith('__talond_');
                            if (showToolCalls && !isInternalServer) {
                              const toolCallId =
                                event.messageType === 'mcp_tool_use' && event.serverName
                                  ? `mcp__${event.serverName}__${event.tool ?? ''}`
                                  : (event.tool ?? '');
                              const toolNoticeIdentity = this.runOutboundDeliveryIdentity(
                                item.id,
                                `tool:${streamOutboundMessageIndex++}`,
                              );
                              const toolCallResult = await this.sendLifecycleOutboundMessage({
                                content: formatToolCall(toolCallId),
                                connector,
                                externalId,
                                runId,
                                threadId: item.threadId,
                                personaName,
                                channelName,
                                itemOrigin: 'run',
                                itemType: 'message',
                                messageId: toolNoticeIdentity.messageId,
                                idempotencyKey: toolNoticeIdentity.idempotencyKey,
                              });
                              if (toolCallResult.isErr()) {
                                this.ctx.logger.warn(
                                  { runId, error: toolCallResult.error.message },
                                  'agent-runner: tool call message send failed, continuing',
                                );
                              }
                            }
                          }
                          this.handleProviderToolEvent(
                            generationObservation.getTraceparent(),
                            {
                              runId,
                              threadId: item.threadId,
                              provider: providerEntry.provider.name,
                              persona: personaName,
                            },
                            activeProviderToolObservations,
                            ignoredProviderToolUseIds,
                            pendingProviderToolTasks,
                            pendingNoIdToolObservations,
                            event,
                          );
                          this.ctx.logger.debug(
                            {
                              runId,
                              messageType: event.messageType,
                              tool: event.tool,
                              subtype: event.subtype,
                            },
                            'agent-sdk: streaming event',
                          );
                        } else {
                          throw new Error(event.message);
                        }
                      }

                      return;
                    }

                    const result = await strategy.run(queryInput);
                    sawEvents = true;
                    outputText = result.output;
                    fullOutputText = result.output;
                    resultSessionId = result.sessionId;
                    usage = result.usage;
                    lastStepUsage = result.lastStepUsage;

                    if (result.isError) {
                      throw new Error(
                        `CLI provider returned error: ${result.output || 'unknown error'}`,
                      );
                    }
                  })();

                  let timeoutId: ReturnType<typeof setTimeout>;
                  const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(
                      () =>
                        reject(new Error(`Agent query timed out after ${queryTimeoutMs / 1000}s`)),
                      queryTimeoutMs,
                    );
                  });

                  try {
                    await Promise.race([queryPromise, timeoutPromise]);
                  } catch (cause) {
                    // Abort the in-flight provider stream to prevent leaked work
                    if (activeIterator?.return) {
                      activeIterator.return(undefined).catch(() => {});
                    }
                    this.finishProviderToolObservations(
                      activeProviderToolObservations,
                      pendingNoIdToolObservations,
                      {
                        level: 'ERROR',
                        statusMessage: cause instanceof Error ? cause.message : String(cause),
                      },
                    );
                    ignoredProviderToolUseIds.clear();
                    await Promise.allSettled(pendingProviderToolTasks);
                    const message = cause instanceof Error ? cause.message : String(cause);
                    throw new AgentQueryAttemptError(message, resumeSessionId, sawEvents);
                  } finally {
                    clearTimeout(timeoutId!);
                  }

                  this.finishProviderToolObservations(
                    activeProviderToolObservations,
                    pendingNoIdToolObservations,
                  );
                  ignoredProviderToolUseIds.clear();
                  await Promise.allSettled(pendingProviderToolTasks);

                  generationObservation.update({
                    output: fullOutputText,
                    metadata: {
                      resultSessionId: resultSessionId ?? null,
                      resumeSessionId: resumeSessionId ?? null,
                    },
                    usageDetails: {
                      // Snake_case keys align with Anthropic's API field names and
                      // match LangFuse's pricing lookup regex (e.g. "^input" → input_tokens).
                      input_tokens: usage.inputTokens,
                      output_tokens: usage.outputTokens,
                      cache_read_input_tokens: usage.cacheReadTokens ?? 0,
                      cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
                    },
                    costDetails:
                      usage.totalCostUsd !== undefined
                        ? { totalCostUsd: usage.totalCostUsd }
                        : undefined,
                  });

                  return {
                    outputText,
                    fullOutputText: fullOutputText.replace(/\n\n$/, ''),
                    resultSessionId,
                    usage,
                    lastStepUsage,
                  };
                },
              );
            };

            let outputText = '';
            let fullOutputText = '';
            const finalOutboundIdentity = this.runOutboundDeliveryIdentity(item.id);
            let finalOutboundReservationHandled = false;
            let streamOutboundMessageIndex = 0;
            let hasReservedIntermediateTextOutbound = false;
            let resultSessionId: string | undefined;
            let usage: AgentUsage = {
              inputTokens: 0,
              outputTokens: 0,
            };
            let lastStepUsage: AgentUsage | undefined;
            // Tracks whether the successful run executed on a resumed
            // codex-cli session. When true, `usage` reflects the provider's
            // cumulative total_token_usage (the session log size on the
            // provider's side), which is the right metric for rotation
            // gating — see the comment at the rotation check below.
            let ranOnResumedCodexSession = false;

            try {
              ({ outputText, fullOutputText, resultSessionId, usage, lastStepUsage } =
                await executeAgentQuery(existingSessionId));
              ranOnResumedCodexSession =
                existingSessionId !== undefined && providerEntry.type === 'codex-cli';
            } catch (cause) {
              if (strategy.type === 'sdk' && this.shouldRetryFreshSession(cause)) {
                this.ctx.sessionTracker.rotateSession(item.threadId);
                this.ctx.logger.warn(
                  {
                    threadId: item.threadId,
                    sessionId: cause.resumeSessionId,
                    error: cause.message,
                  },
                  'agent-sdk: resumed session failed before any events, retrying fresh session',
                );
                ({ outputText, fullOutputText, resultSessionId, usage, lastStepUsage } =
                  await executeAgentQuery(undefined));
              } else {
                throw cause;
              }
            }

            // Store session ID for future conversation resumption (memory + DB).
            // A2A items execute for a different persona on the source thread, so
            // persisting their session ID would contaminate the source thread state.
            if (resultSessionId && !isA2ATask && !isScheduleTask) {
              if (reasoningEffort !== undefined) {
                this.ctx.sessionTracker.setSessionId(
                  item.threadId,
                  resultSessionId,
                  sessionProviderName,
                  model,
                  reasoningEffort,
                );
              } else {
                this.ctx.sessionTracker.setSessionId(
                  item.threadId,
                  resultSessionId,
                  sessionProviderName,
                  model,
                );
              }
              this.ctx.repos.run.updateSessionId(runId, resultSessionId);
            }

            // Stop typing indicator.
            if (typingInterval) clearInterval(typingInterval);

            this.ctx.logger.info(
              {
                runId,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens ?? 0,
                cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                totalCostUsd: usage.totalCostUsd ?? 0,
                sessionId: resultSessionId,
              },
              'agent-runner: query completed',
            );

            // Persist token usage to the run record.
            const tokenResult = this.ctx.repos.run.updateTokens(runId, {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cache_read_tokens: usage.cacheReadTokens ?? 0,
              cache_write_tokens: usage.cacheWriteTokens ?? 0,
              cost_usd: usage.totalCostUsd ?? 0,
            });
            if (tokenResult.isErr()) {
              this.ctx.logger.error(
                { runId, err: tokenResult.error },
                'agent-runner: failed to persist token usage',
              );
            }

            if (isA2ATask && a2aTaskId) {
              // A2A collaboration task: store result in a2a_tasks, skip channel send.
              this.ctx.repos.a2aTask.markCompleted(a2aTaskId, fullOutputText).mapErr((e) => {
                this.ctx.logger.warn(
                  { a2aTaskId, runId, err: e.message },
                  'agent-runner: failed to mark A2A task as completed',
                );
              });
              this.ctx.logger.info(
                { runId, a2aTaskId, outputLength: fullOutputText.length },
                'agent-sdk: A2A task completed, result stored (no channel send)',
              );
            } else if (isScheduleTask) {
              // Scheduled prompts must invoke channel.send explicitly to
              // deliver. The agent's final assistant text on a scheduled
              // run is a self-narration / wrap-up (e.g. "Silent — lunch
              // window, items from 11:05 still pending. Log written.")
              // and is not meant to reach the originating chat.
              //
              // The actual #205 bug was a corrupted thread metadata
              // shape that made channel.send fail with "chat not found".
              // That is fixed by the migration refusal in
              // src/scheduler/legacy-schedule-migration.ts plus operator
              // rebinds onto healthy dedicated threads. With those in
              // place, channel.send delivers correctly and this skip
              // remains the right contract for scheduled runs.
              this.ctx.logger.info(
                { runId, outputLength: fullOutputText.length },
                'agent-sdk: skipping outbound reply for schedule item (agent must use channel.send to deliver)',
              );
            } else if (connector !== undefined && externalId && outputText) {
              // Send remaining text (final block). Intermediate blocks were flushed
              // during the stream when tool_use events were encountered (issue #102).
              const sendResult = await this.sendLifecycleOutboundMessage({
                content: outputText,
                persistedContent: fullOutputText,
                connector,
                externalId,
                runId,
                threadId: item.threadId,
                personaName,
                channelName,
                itemOrigin: 'run',
                itemType: 'message',
                messageId: finalOutboundIdentity.messageId,
                idempotencyKey: finalOutboundIdentity.idempotencyKey,
                ...(hasReservedIntermediateTextOutbound
                  ? { reservationContent: outputText }
                  : {}),
              });
              if (sendResult.isErr()) {
                throw new Error(`channel send failed: ${sendResult.error.message}`);
              }
              outputText = sendResult.value.content;
              fullOutputText = sendResult.value.fullContent;
              finalOutboundReservationHandled = true;
            }

            // When streamed text was already flushed as physical outbound rows
            // and the provider emits no final text segment, do not synthesize a
            // final transcript row containing the previously flushed content.
            if (
              !isA2ATask &&
              !isScheduleTask &&
              !finalOutboundReservationHandled &&
              !hasReservedIntermediateTextOutbound
            ) {
              const persistedOutbound = this.ctx.repos.message.insert({
                id: finalOutboundIdentity.messageId,
                thread_id: item.threadId,
                direction: 'outbound',
                content: JSON.stringify({ body: fullOutputText }),
                idempotency_key: finalOutboundIdentity.idempotencyKey,
                provider_id: null,
                run_id: runId,
              });
              if (persistedOutbound.isErr()) {
                throw new Error(
                  `failed to persist outbound message: ${persistedOutbound.error.message}`,
                );
              }
            }

            // Check if context needs rotation (rolling window).
            // Runs AFTER connector.send() and the final outbound reservation so
            // the user receives their response before projection starts. The
            // current queue item remains claimed until projection settles, which
            // keeps ordering durable through the queue lease/recovery path while
            // still allowing collaboration items to use the queue's existing
            // in-flight bypass.
            if (this.ctx.contextRoller && enabledContextManagement && !isScheduleTask) {
              // Gate rotation on per-step usage when the provider reports
              // it; cumulative `usage` across a multi-tool agent loop can
              // easily exceed the per-call context window even when each
              // individual prompt fits, which would trigger spurious
              // rotations. Telemetry/accounting still uses the cumulative
              // `usage` further down (it's what the user was billed for).
              //
              // Exception: codex-cli with a resumed session. Codex's
              // total_token_usage is the cumulative session log size kept
              // on the provider's side — exactly what we want to bound —
              // while last_token_usage is just the new turn's tokens (the
              // rest are cache hits). Gating on lastStepUsage here means a
              // resumed session can grow to any size without triggering
              // rotation, as long as each individual call stays under the
              // threshold. Observed in production: a 644K-token session
              // across 5 runs never rotated because no single call crossed
              // the 524K threshold. Use cumulative `usage` for codex-cli
              // resumed runs so the roller fires when the session log
              // itself crosses the threshold.
              const usageForRotation = ranOnResumedCodexSession
                ? usage
                : lastStepUsage ?? usage;
              const contextUsage: ContextUsage =
                providerEntry.provider.estimateContextUsage(usageForRotation);
              const triggerMetric = enabledContextManagement.triggerMetric as ContextMetricName;
              const selectedMetricValue: number | undefined = contextUsage.metrics[triggerMetric];
              let requiredContinuationError: Error | null = null;
              let continuationEnsured = false;
              const needsContinuationAfterRotation =
                !strategy.supportsSessionResumption ||
                strategy.requiresContinuationAfterContextRotation === true;
              const canAutoContinueAfterRotation =
                needsContinuationAfterRotation && !isA2ATask && item.type !== 'schedule';
              if (selectedMetricValue === undefined) {
                this.ctx.logger.error(
                  {
                    threadId: item.threadId,
                    metric: enabledContextManagement.triggerMetric,
                    provider: providerEntry.provider.name,
                  },
                  'agent-runner: configured trigger metric not available from provider, skipping context rotation',
                );
              } else {
                try {
                  if (selectedMetricValue > 0) {
                    const contextUsagePayload = {
                      ratio:
                        selectedMetricValue / Math.max(1, providerEntry.config.contextWindowTokens),
                      inputTokens: contextUsage.inputTokens,
                      rawMetric: selectedMetricValue,
                      rawMetricName: triggerMetric,
                      rotationCauseQueueItemId: item.id,
                    };
                    if (contextUsagePayload.ratio >= enabledContextManagement.thresholdRatio) {
                      this.publishContextEvent(
                        'context.threshold_exceeded.v1',
                        {
                          runId,
                          queueItemId: item.id,
                          threadId: item.threadId,
                          personaName,
                          provider: providerEntry.provider.name,
                          model,
                          contextUsage: contextUsagePayload,
                        },
                      );

                      try {
                        const rotation = await this.runContextProjection({
                          item,
                          personaId,
                          personaName,
                          runId,
                          model,
                          provider: providerEntry.provider.name,
                          contextUsage: contextUsagePayload,
                          contextManagement: enabledContextManagement,
                          threadMetadata:
                            threadResult.isOk() && threadResult.value
                              ? threadResult.value.metadata
                              : null,
                          channelId:
                            threadResult.isOk() && threadResult.value
                              ? threadResult.value.channel_id
                              : undefined,
                        });

                        this.publishPostProjectionEvents({
                          runId,
                          queueItemId: item.id,
                          threadId: item.threadId,
                          personaName,
                          provider: providerEntry.provider.name,
                          model,
                          contextUsage: contextUsagePayload,
                          rotation,
                        });

                        if (
                          rotation.rotated &&
                          rotation.hasOpenThreads &&
                          canAutoContinueAfterRotation
                        ) {
                          const continuation = this.enqueueContextContinuation(
                            item.threadId,
                            personaId,
                            personaName,
                            item.id,
                          );
                          if (continuation.isErr()) {
                            requiredContinuationError = continuation.error;
                          } else {
                            continuationEnsured = true;
                          }
                        }
                      } catch (e: unknown) {
                        this.ctx.logger.error(
                          { threadId: item.threadId, err: e },
                          'agent-runner: context rotation failed',
                        );
                      }
                    }
                  }
                } catch (e: unknown) {
                  this.ctx.logger.error(
                    { threadId: item.threadId, err: e },
                    'agent-runner: context rotation failed',
                  );
                }
              }

              if (
                !requiredContinuationError &&
                !continuationEnsured &&
                canAutoContinueAfterRotation
              ) {
                const repair = this.repairContextContinuationAfterDurableRotation({
                  threadId: item.threadId,
                  personaId,
                  personaName,
                  queueItemId: item.id,
                });
                if (repair.isErr()) {
                  requiredContinuationError = repair.error;
                }
              }
              if (requiredContinuationError) {
                throw requiredContinuationError;
              }
            }

            runObservation.update({
              output: {
                text: fullOutputText,
              },
              metadata: {
                resultSessionId: resultSessionId ?? null,
              },
              trace: {
                output: fullOutputText,
              },
            });

            const finalized = this.finalizeRunWithLifecycle(
              runId,
              'completed',
              {
                threadId: item.threadId,
                personaId,
                queueItemId: item.id,
                provider: providerEntry.provider.name,
                model,
              },
              personaName,
              { ended_at: Date.now() },
            );
            if (finalized.isErr()) {
              throw new Error(`failed to finalize completed run: ${finalized.error.message}`);
            }
            runFinalized = true;
          } catch (cause) {
            if (typingInterval) clearInterval(typingInterval);
            const error = this.toError(cause);
            const finalized = this.finalizeRunWithLifecycle(
              runId,
              'failed',
              {
                threadId: item.threadId,
                personaId,
                queueItemId: item.id,
                provider: providerEntry.provider.name,
                model,
                error: error.message,
              },
              personaName,
              { ended_at: Date.now(), error: error.message },
            );
            // Mark A2A task as failed on agent execution error.
            if (isA2ATask && a2aTaskId) {
              this.ctx.repos.a2aTask
                .markFailed(a2aTaskId, 'EXECUTION_ERROR', error.message)
                .mapErr((e) => {
                  this.ctx.logger.warn(
                    { a2aTaskId, runId, err: e.message },
                    'agent-runner: failed to mark A2A task as failed',
                  );
                });
            }
            if (finalized.isErr()) {
              throw new Error(
                `${error.message}; additionally failed to finalize failed run: ${finalized.error.message}`,
              );
            }
            runFinalized = true;
            throw error;
          }
        },
      );

      return ok(undefined);
    } catch (cause) {
      const error = this.toError(cause);
      if (!runFinalized) {
        const finalized = this.finalizeRunWithLifecycle(
          runId,
          'failed',
          {
            threadId: item.threadId,
            personaId,
            queueItemId: item.id,
            provider: providerEntry.provider.name,
            model,
            error: error.message,
          },
          personaName,
          { ended_at: Date.now(), error: error.message },
        );
        if (finalized.isErr()) {
          return err(
            new Error(
              `${error.message}; additionally failed to finalize failed run: ${finalized.error.message}`,
            ),
          );
        }
      }
      return err(error);
    } finally {
      this.ctx.hostToolsBridge.unregisterRunAuthentication?.(runId);
    }
  }

  private interceptRunBeforeExecute(input: {
    runId: string;
    threadId: string;
    personaName: string;
    provider: string;
    model: string;
    queueItemId: string;
    itemType: string;
  }): Result<
    { provider: string; model: string; contextAdditions?: Record<string, unknown> },
    Error
  > {
    if (!this.ctx.lifecycleRuntime) {
      return ok({ provider: input.provider, model: input.model });
    }

    const interception = this.ctx.lifecycleRuntime.intercept(
      {
        persona: input.personaName,
        hook: 'run.before_execute',
        itemOrigin: 'run',
        itemType: 'run',
      },
      {
        version: 'v1',
        interceptionId: uuidv4(),
        hook: 'run.before_execute',
        context: this.lifecycleContext('run', input.runId, input.queueItemId, 'run'),
        input: {
          runId: input.runId,
          provider: input.provider,
          model: input.model,
          persona: input.personaName,
        },
      },
    );
    if (interception.isErr()) {
      return err(new Error(`Lifecycle run interception failed: ${interception.error.message}`));
    }
    if (interception.value.outcome !== 'allow') {
      return err(new Error(`Lifecycle run policy blocked execution: ${interception.value.reason}`));
    }

    const runInput = interception.value.input.input as {
      provider: string;
      model: string;
      contextAdditions?: Record<string, unknown>;
    };
    return ok({
      provider: runInput.provider,
      model: runInput.model,
      ...(runInput.contextAdditions ? { contextAdditions: runInput.contextAdditions } : {}),
    });
  }

  private runOutboundDeliveryIdentity(
    queueItemId: string,
    segment: string = 'final',
  ): OutboundDeliveryIdentity {
    const key = segment === 'final' ? `outbound:${queueItemId}` : `outbound:${queueItemId}:${segment}`;
    return {
      messageId: key,
      idempotencyKey: key,
    };
  }

  private latestDurableContextRotationState(
    threadId: string,
  ): DurableContextRotationState | undefined {
    const memoryItems = this.ctx.repos.memory.findByThread(threadId);
    if (memoryItems.isErr()) {
      this.ctx.logger.warn(
        { threadId, err: memoryItems.error.message },
        'agent-runner: failed to inspect durable context rotation boundary',
      );
      return undefined;
    }
    let latest: DurableContextRotationState | undefined;
    for (const item of memoryItems.value) {
      try {
        const metadata = JSON.parse(item.metadata) as unknown;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
        const record = metadata as Record<string, unknown>;
        const source = typeof record.source === 'string' ? record.source : undefined;
        const isObservationRotation =
          item.type === 'observation' &&
          (source === 'context-roller-om' ||
            source === 'context-projector-reduced-observation-tombstone');
        const isSummaryRotation = item.type === 'summary' && source === 'context-roller';
        if (!isObservationRotation && !isSummaryRotation) {
          continue;
        }
        const rotatedThroughTs = Number(record.rotatedThroughTs);
        if (!Number.isFinite(rotatedThroughTs) || rotatedThroughTs <= 0) continue;
        const rotationPersistedAt = Number(item.created_at);
        const durableBoundary =
          Number.isFinite(rotationPersistedAt) && rotationPersistedAt > 0
            ? Math.max(rotatedThroughTs, rotationPersistedAt)
            : rotatedThroughTs;
        if (latest !== undefined && latest.boundary >= durableBoundary) continue;
        latest = {
          boundary: durableBoundary,
          hasOpenThreads: isObservationRotation
            ? this.observationRotationHasOpenThreads(record)
            : this.summaryRotationHasOpenThreads(record),
          ...(this.readRotationCauseQueueItemId(record)
            ? { rotationCauseQueueItemId: this.readRotationCauseQueueItemId(record) }
            : {}),
        };
      } catch {
        continue;
      }
    }
    return latest;
  }

  private observationRotationHasOpenThreads(record: Record<string, unknown>): boolean {
    return (
      record.taskComplete === false &&
      typeof record.suggestedContinuation === 'string' &&
      record.suggestedContinuation.trim().length > 0
    );
  }

  private summaryRotationHasOpenThreads(record: Record<string, unknown>): boolean {
    if (record.hasOpenThreads === true) return true;
    const openThreadCount = Number(record.openThreadCount);
    return Number.isFinite(openThreadCount) && openThreadCount > 0;
  }

  private readRotationCauseQueueItemId(record: Record<string, unknown>): string | undefined {
    if (
      typeof record.rotationCauseQueueItemId === 'string' &&
      record.rotationCauseQueueItemId.length > 0
    ) {
      return record.rotationCauseQueueItemId;
    }
    const contextUsage = record.contextUsage;
    if (!contextUsage || typeof contextUsage !== 'object' || Array.isArray(contextUsage)) {
      return undefined;
    }
    const usageRecord = contextUsage as Record<string, unknown>;
    return typeof usageRecord.rotationCauseQueueItemId === 'string' &&
      usageRecord.rotationCauseQueueItemId.length > 0
      ? usageRecord.rotationCauseQueueItemId
      : undefined;
  }

  private async sendLifecycleOutboundMessage(input: {
    content: string;
    persistedContent?: string;
    connector: ChannelConnector;
    externalId: string;
    runId: string;
    threadId: string;
    personaName: string;
    channelName?: string;
    itemOrigin: 'run' | 'tool';
    itemType: 'message';
    messageId: string;
    idempotencyKey?: string;
    reservationContent?: string;
  }): Promise<Result<{ content: string; fullContent: string; skipped: boolean }, Error>> {
    const originalContent = input.content;
    let content = input.content;
    let fullContent = input.persistedContent ?? input.content;
    let idempotentReservationInserted = false;

    if (this.ctx.lifecycleRuntime) {
      const lifecycleContent = buildLifecycleContentPreview(content);
      const interception = this.ctx.lifecycleRuntime.intercept(
        {
          persona: input.personaName,
          hook: 'message.before_send',
          itemOrigin: input.itemOrigin,
          itemType: input.itemType,
          ...(input.channelName ? { channel: input.channelName } : {}),
          messageSource: 'outbound',
        },
        {
          version: 'v1',
          interceptionId: uuidv4(),
          hook: 'message.before_send',
          context: this.lifecycleContext('message', input.messageId, input.runId, input.itemOrigin),
          input: {
            messageId: input.messageId,
            content: lifecycleContent.content,
            source: 'outbound',
            recipientId: input.externalId,
            ...(input.channelName ? { channel: input.channelName } : {}),
            persona: input.personaName,
          },
        },
      );
      if (interception.isErr()) {
        return err(new Error(`Lifecycle outbound interception failed: ${interception.error.message}`));
      }
      if (interception.value.outcome !== 'allow') {
        return err(new Error(`Lifecycle outbound policy blocked delivery: ${interception.value.reason}`));
      }
      const resolvedContent = resolveLifecycleOutboundContent({
        originalContent: content,
        preview: lifecycleContent,
        interceptedContent: (interception.value.input.input as { content: string }).content,
      });
      if (resolvedContent.isErr()) {
        return err(resolvedContent.error);
      }
      content = resolvedContent.value;
    }

    fullContent = input.persistedContent
      ? input.persistedContent.endsWith(originalContent)
        ? `${input.persistedContent.slice(0, -originalContent.length)}${content}`
        : content
      : content;

    if (input.idempotencyKey) {
      const reservationContent = input.reservationContent ?? fullContent;
      const reserved = this.ctx.repos.message.insertIfAbsent({
        id: input.messageId,
        thread_id: input.threadId,
        direction: 'outbound',
        content: JSON.stringify({ body: reservationContent }),
        idempotency_key: input.idempotencyKey,
        provider_id: null,
        run_id: input.runId,
      });
      if (reserved.isErr()) {
        return err(
          new Error(`failed to reserve outbound delivery: ${reserved.error.message}`),
        );
      }
      if (!reserved.value.inserted) {
        this.ctx.logger.info(
          { runId: input.runId, messageId: input.messageId },
          'agent-runner: skipping already reserved outbound delivery',
        );
        return ok({ content, fullContent, skipped: true });
      }
      idempotentReservationInserted = true;
    }

    const sendResult = await input.connector.send(input.externalId, { body: content });
    if (sendResult.isErr()) {
      if (input.idempotencyKey && idempotentReservationInserted) {
        const cleared = this.ctx.repos.message.deleteByIdempotencyKey(input.idempotencyKey);
        if (cleared.isErr()) {
          return err(
            new Error(
              `channel send failed: ${sendResult.error.message}; failed to clear outbound delivery reservation: ${cleared.error.message}`,
            ),
          );
        }
      }
      this.publishMessageSendEvent('message.send_failed.v1', input, content, {
        status: 'failed',
        errorLength: sendResult.error.message.length,
      });
      return err(new Error(sendResult.error.message));
    }

    this.publishMessageSendEvent('message.sent.v1', input, content, { status: 'sent' });
    return ok({ content, fullContent, skipped: false });
  }

  private publishMessageSendEvent(
    type: 'message.sent.v1' | 'message.send_failed.v1',
    input: {
      runId: string;
      threadId: string;
      personaName: string;
      channelName?: string;
      itemOrigin: 'run' | 'tool';
      itemType: 'message';
      messageId: string;
      externalId: string;
    },
    content: string,
    metadata: Record<string, string | number | boolean | null>,
  ): void {
    if (!this.ctx.lifecycleRuntime) return;
    const publication = this.ctx.lifecycleRuntime.publish({
      event: this.lifecycleEvent(
        type,
        'message',
        input.messageId,
        input.runId,
        input.itemOrigin,
        [
          { type: 'message', id: input.messageId },
          { type: 'thread', id: input.threadId },
          { type: 'run', id: input.runId },
        ],
        {
          direction: 'outbound',
          source: input.itemOrigin,
          contentLength: content.length,
          ...metadata,
        },
      ),
      persona: input.personaName,
      itemOrigin: input.itemOrigin,
      itemType: input.itemType,
      ...(input.channelName ? { channel: input.channelName } : {}),
      messageSource: 'outbound',
    });
    if (publication.isErr()) {
      this.ctx.logger.error(
        { err: publication.error.message, runId: input.runId, messageId: input.messageId, type },
        'agent-runner: failed to publish outbound lifecycle event',
      );
    }
  }

  private async runContextProjection(input: {
    item: QueueItem;
    personaId: string;
    personaName: string;
    runId: string;
    provider: string;
    model: string;
    contextUsage: ResolvedContextUsage;
    contextManagement: {
      mode: unknown;
      thresholdRatio: number;
      summarizer?: string;
      observer?: string;
      reducer?: string;
      reflectionThresholdChars: number;
    };
    threadMetadata: string | null;
    channelId?: string;
  }): Promise<ContextRotationResult> {
    const noRotation: ContextRotationResult = { rotated: false, hasOpenThreads: false };
    if (!this.ctx.contextRoller) return noRotation;

    if (input.contextManagement.mode === 'observation') {
      if (!input.contextManagement.observer || !input.contextManagement.reducer) {
        this.ctx.logger.error(
          {
            threadId: input.item.threadId,
            provider: input.provider,
            mode: input.contextManagement.mode,
          },
          'agent-runner: context observation mode missing observer or reducer handler',
        );
        return noRotation;
      }

      return await this.ctx.contextRoller.checkAndRotateOM(
        input.item.threadId,
        input.personaId,
        input.contextUsage,
        input.contextManagement.thresholdRatio,
        input.contextManagement.observer,
        input.contextManagement.reducer,
        input.contextManagement.reflectionThresholdChars,
        input.threadMetadata,
        input.channelId,
      );
    }

    if (!input.contextManagement.summarizer) {
      this.ctx.logger.error(
        {
          threadId: input.item.threadId,
          provider: input.provider,
          mode: input.contextManagement.mode,
        },
        'agent-runner: context summarizer mode missing summarizer handler',
      );
      return noRotation;
    }

    return await this.ctx.contextRoller.checkAndRotate(
      input.item.threadId,
      input.personaId,
      input.contextUsage,
      input.contextManagement.thresholdRatio,
      input.contextManagement.summarizer,
    );
  }

  private publishPostProjectionEvents(input: {
    runId: string;
    queueItemId: string;
    threadId: string;
    personaName: string;
    provider: string;
    model: string;
    contextUsage: ResolvedContextUsage;
    rotation: ContextRotationResult;
  }): void {
    if (input.rotation.reduction?.thresholdExceeded) {
      this.publishContextEvent('context.observation_log_threshold_exceeded.v1', {
        ...input,
        observationChars: input.rotation.reduction.observationChars,
        thresholdChars: input.rotation.reduction.thresholdChars,
        reduced: input.rotation.reduction.reduced,
        projectionId: input.rotation.reduction.projectionId,
        memoryItemId: input.rotation.reduction.memoryItemId,
      });
    }

    if (!input.rotation.rotated) {
      return;
    }

    this.publishContextEvent('context.rotated.v1', {
      ...input,
      hasOpenThreads: input.rotation.hasOpenThreads,
    });
  }

  private enqueueContextContinuation(
    threadId: string,
    personaId: string,
    personaName: string,
    queueItemId: string,
  ): Result<void, Error> {
    const continuationKey = this.contextContinuationKey(queueItemId);
    const inserted = this.ctx.repos.message.insertIfAbsent({
      id: continuationKey,
      thread_id: threadId,
      direction: 'inbound',
      content: JSON.stringify({ body: 'continue' }),
      idempotency_key: continuationKey,
      provider_id: null,
      run_id: null,
    });
    if (inserted.isErr()) {
      const error = new Error(
        `failed to persist continuation after context rotation: ${inserted.error.message}`,
      );
      this.ctx.logger.warn(
        { threadId, err: inserted.error.message },
        'agent-runner: failed to persist continuation after context rotation',
      );
      return err(error);
    }
    if (!inserted.value.inserted) {
      this.ctx.logger.info(
        { threadId, messageId: inserted.value.message.id },
        'agent-runner: continuation after context rotation already persisted, ensuring queue item',
      );
    }

    const enqueueResult = this.ctx.queueManager.enqueueWithId(
      continuationKey,
      threadId,
      'message',
      { personaId, content: 'continue' },
      inserted.value.message.id,
      { persona: personaName, itemType: 'message' },
    );
    if (enqueueResult.isOk()) {
      this.ctx.logger.info(
        { threadId },
        'agent-runner: auto-enqueued continuation after context rotation for stateless provider',
      );
      return ok(undefined);
    } else {
      const error = new Error(
        `failed to enqueue continuation after context rotation: ${enqueueResult.error.message}`,
      );
      this.ctx.logger.warn(
        { threadId, err: enqueueResult.error.message },
        'agent-runner: failed to auto-enqueue continuation after context rotation',
      );
      return err(error);
    }
  }

  private repairContextContinuationAfterDurableRotation(input: {
    threadId: string;
    personaId: string;
    personaName: string;
    queueItemId: string;
  }): Result<boolean, Error> {
    const continuationKey = this.contextContinuationKey(input.queueItemId);
    let shouldEnsureContinuation = false;
    try {
      shouldEnsureContinuation =
        this.ctx.repos.message.existsByIdempotencyKey(continuationKey) === true;
    } catch (cause) {
      return err(
        new Error(
          `failed to inspect continuation after context rotation: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      );
    }

    if (!shouldEnsureContinuation) {
      const rotation = this.latestDurableContextRotationState(input.threadId);
      shouldEnsureContinuation =
        rotation?.hasOpenThreads === true &&
        rotation.rotationCauseQueueItemId === input.queueItemId;
    }

    if (!shouldEnsureContinuation) {
      return ok(false);
    }

    const ensured = this.enqueueContextContinuation(
      input.threadId,
      input.personaId,
      input.personaName,
      input.queueItemId,
    );
    if (ensured.isErr()) return err(ensured.error);
    return ok(true);
  }

  private contextContinuationKey(queueItemId: string): string {
    return `context-rotation-continue:${queueItemId}`;
  }

  private publishContextEvent(
    type:
      | 'context.threshold_exceeded.v1'
      | 'context.rotated.v1'
      | 'context.observation_log_threshold_exceeded.v1',
    input: {
      runId: string;
      queueItemId: string;
      threadId: string;
      personaName: string;
      provider: string;
      model: string;
      contextUsage: ResolvedContextUsage;
      hasOpenThreads?: boolean;
      observationChars?: number;
      thresholdChars?: number;
      reduced?: boolean;
      projectionId?: string;
      memoryItemId?: string;
    },
  ): void {
    if (!this.ctx.lifecycleRuntime) return;
    const projectionId = input.projectionId ?? `context-projection:${input.runId}`;
    const publication = this.ctx.lifecycleRuntime.publish({
      event: this.lifecycleEvent(
        type,
        'context_projection',
        projectionId,
        input.runId,
        'context',
        [
          { type: 'context_projection', id: projectionId },
          { type: 'thread', id: input.threadId },
          { type: 'run', id: input.runId },
          { type: 'queue_item', id: input.queueItemId },
          ...(input.memoryItemId ? [{ type: 'memory_item', id: input.memoryItemId }] : []),
        ],
        {
          provider: input.provider,
          model: input.model,
          ratio: input.contextUsage.ratio,
          inputTokens: input.contextUsage.inputTokens,
          rawMetric: input.contextUsage.rawMetric,
          rawMetricName: input.contextUsage.rawMetricName,
          ...(input.hasOpenThreads !== undefined
            ? { hasOpenThreads: input.hasOpenThreads }
            : {}),
          ...(input.observationChars !== undefined
            ? { observationChars: input.observationChars }
            : {}),
          ...(input.thresholdChars !== undefined ? { thresholdChars: input.thresholdChars } : {}),
          ...(input.reduced !== undefined ? { reduced: input.reduced } : {}),
        },
      ),
      persona: input.personaName,
      itemOrigin: 'context',
      itemType: 'context_projection',
    });
    if (publication.isErr()) {
      this.ctx.logger.error(
        { err: publication.error.message, runId: input.runId, type },
        'agent-runner: failed to publish context lifecycle event',
      );
    }
  }

  private finalizeRunWithLifecycle(
    runId: string,
    status: 'completed' | 'failed',
    eventInput: {
      threadId: string;
      personaId: string;
      queueItemId: string;
      provider: string;
      model: string;
      error?: string;
    },
    personaName: string,
    timestamps: { ended_at: number; error?: string },
  ): Result<void, Error> {
    if (!this.ctx.lifecycleRuntime) {
      const updated = this.ctx.repos.run.updateStatus(runId, status, timestamps);
      return updated.isErr() ? err(new Error(updated.error.message)) : ok(undefined);
    }
    const result = this.ctx.lifecycleRuntime.transaction((transaction) => {
      const updated = this.ctx.repos.run.updateStatus(runId, status, timestamps);
      if (updated.isErr()) return err(updated.error);
      const published = this.publishRunEvent(
        status === 'completed' ? 'run.completed.v1' : 'run.failed.v1',
        {
          runId,
          threadId: eventInput.threadId,
          personaId: eventInput.personaId,
          queueItemId: eventInput.queueItemId,
          provider: eventInput.provider,
          model: eventInput.model,
          status,
          ...(eventInput.error ? { errorLength: eventInput.error.length } : {}),
        },
        personaName,
        transaction,
      );
      return published.isErr() ? err(published.error) : ok(undefined);
    });
    if (result.isErr()) {
      this.ctx.logger.error(
        { err: result.error.message, runId, status },
        'agent-runner: failed to finalize run lifecycle event',
      );
    }
    return result.isErr() ? err(new Error(result.error.message)) : ok(undefined);
  }

  private insertAndFinalizePreExecutionFailedRun(
    runId: string,
    input: {
      threadId: string;
      personaId: string;
      queueItemId: string;
      provider: string;
      model: string;
      reasoningEffort?: ReasoningEffort | null;
      error: string;
    },
    personaName: string,
  ): Result<void, Error> {
    const inserted = this.ctx.repos.run.insert({
      id: runId,
      thread_id: input.threadId,
      persona_id: input.personaId,
      provider_name: input.provider,
      model_name: input.model,
      reasoning_effort: input.reasoningEffort ?? null,
      sandbox_id: null,
      session_id: null,
      status: 'running',
      parent_run_id: null,
      queue_item_id: input.queueItemId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: Date.now(),
      ended_at: null,
    });
    if (inserted.isErr()) {
      return err(new Error(inserted.error.message));
    }
    return this.finalizeRunWithLifecycle(
      runId,
      'failed',
      {
        threadId: input.threadId,
        personaId: input.personaId,
        queueItemId: input.queueItemId,
        provider: input.provider,
        model: input.model,
        error: input.error,
      },
      personaName,
      { ended_at: Date.now(), error: input.error },
    );
  }

  private publishRunEvent(
    type: 'run.started.v1' | 'run.completed.v1' | 'run.failed.v1',
    input: {
      runId: string;
      threadId: string;
      personaId: string;
      queueItemId: string;
      provider: string;
      model: string;
      status: string;
      errorLength?: number;
    },
    personaName: string,
    transaction: TransactionContext,
  ): Result<void, Error> {
    if (!this.ctx.lifecycleRuntime) return ok(undefined);
    const publication = this.ctx.lifecycleRuntime.publish(
      {
        event: this.lifecycleEvent(
          type,
          'run',
          input.runId,
          input.queueItemId,
          'run',
          [
            { type: 'run', id: input.runId },
            { type: 'thread', id: input.threadId },
            { type: 'persona', id: input.personaId },
            { type: 'queue_item', id: input.queueItemId },
          ],
          {
            provider: input.provider,
            model: input.model,
            status: input.status,
            ...(input.errorLength !== undefined ? { errorLength: input.errorLength } : {}),
          },
        ),
        persona: personaName,
        itemOrigin: 'run',
        itemType: 'run',
      },
      transaction,
    );
    return publication.isErr() ? err(new Error(publication.error.message)) : ok(undefined);
  }

  private publishProviderToolLifecycleEvent(
    type: 'provider.tool.started.v1' | 'provider.tool.completed.v1',
    metadata: {
      runId: string;
      threadId: string;
      provider: string;
      persona: string;
    },
    event: {
      messageType: string;
      tool?: string;
      toolUseId?: string;
      isError?: boolean;
      serverName?: string;
    },
    toolCallIdOverride?: string,
  ): void {
    if (!this.ctx.lifecycleRuntime) return;
    const toolCallId = toolCallIdOverride ?? event.toolUseId ?? uuidv4();
    const publication = this.ctx.lifecycleRuntime.publish({
      event: this.lifecycleEvent(
        type,
        'tool_call',
        toolCallId,
        metadata.runId,
        'run',
        [
          { type: 'tool_call', id: toolCallId },
          { type: 'run', id: metadata.runId },
          { type: 'thread', id: metadata.threadId },
        ],
        {
          provider: metadata.provider,
          toolName: event.tool ?? event.messageType,
          messageType: event.messageType,
          ...(event.serverName ? { serverName: event.serverName } : {}),
          status: type === 'provider.tool.started.v1' ? 'started' : event.isError ? 'error' : 'completed',
        },
      ),
      persona: metadata.persona,
      itemOrigin: 'run',
      itemType: 'tool_call',
    });
    if (publication.isErr()) {
      this.ctx.logger.error(
        { err: publication.error.message, runId: metadata.runId, type },
        'agent-runner: failed to publish provider tool lifecycle event',
      );
    }
  }

  private lifecycleContext(
    aggregateType: string,
    aggregateId: string,
    correlationId: string,
    source: string,
  ): LifecycleEventEnvelope['context'] {
    return {
      aggregate: { type: aggregateType, id: aggregateId },
      correlationId,
      recursion: { depth: 0, maxDepth: 8 },
      provenance: { source, sourceEventIds: [], sourceReferences: [] },
    };
  }

  private lifecycleEvent(
    type: LifecycleEventEnvelope['type'],
    aggregateType: string,
    aggregateId: string,
    correlationId: string,
    source: string,
    references: LifecycleEventEnvelope['payload']['references'],
    metadata: LifecycleEventEnvelope['payload']['metadata'],
  ): LifecycleEventEnvelope {
    return {
      version: 'v1',
      type,
      eventId: uuidv4(),
      occurredAt: new Date().toISOString(),
      context: this.lifecycleContext(aggregateType, aggregateId, correlationId, source),
      payload: { references, metadata },
    };
  }

  private toError(cause: unknown): Error {
    return cause instanceof Error ? cause : new Error(String(cause));
  }

  private handleProviderToolEvent(
    traceparent: string | null,
    metadata: {
      runId: string;
      threadId: string;
      provider: string;
      persona: string;
    },
    activeProviderToolObservations: Map<string, StartedObservationHandle>,
    ignoredProviderToolUseIds: Set<string>,
    pendingProviderToolTasks: Array<Promise<void>>,
    pendingNoIdToolObservations: PendingNoIdProviderToolObservation[],
    event: {
      messageType: string;
      tool?: string;
      toolUseId?: string;
      input?: unknown;
      output?: unknown;
      isError?: boolean;
      subtype?: string;
      serverName?: string;
    },
  ): void {
    if (this.shouldSkipProviderToolObservation(event)) {
      if (event.toolUseId) {
        ignoredProviderToolUseIds.add(event.toolUseId);
      }
      return;
    }

    if (event.toolUseId && ignoredProviderToolUseIds.has(event.toolUseId)) {
      if (this.isProviderToolResultEvent(event.messageType)) {
        ignoredProviderToolUseIds.delete(event.toolUseId);
      }
      return;
    }

    if (this.isProviderToolStartEvent(event.messageType) && event.toolUseId) {
      this.publishProviderToolLifecycleEvent('provider.tool.started.v1', metadata, event);
      const observation = this.ctx.observability.startWithTraceparent(traceparent, {
        type: 'tool',
        name: this.getProviderToolObservationName(event),
        input: event.input ?? {},
        metadata: {
          ...metadata,
          messageType: event.messageType,
          toolUseId: event.toolUseId,
          subtype: event.subtype ?? null,
          serverName: event.serverName ?? null,
        },
      });
      activeProviderToolObservations.set(event.toolUseId, observation);
      return;
    }

    if (this.isProviderToolResultEvent(event.messageType) && event.toolUseId) {
      this.publishProviderToolLifecycleEvent('provider.tool.completed.v1', metadata, event);
      const observation = activeProviderToolObservations.get(event.toolUseId);
      if (!observation) {
        return;
      }

      observation.update({
        output: event.output,
        level: event.isError ? 'ERROR' : undefined,
        statusMessage: event.isError ? `Tool call ${event.toolUseId} returned an error` : undefined,
      });
      observation.end();
      activeProviderToolObservations.delete(event.toolUseId);
      return;
    }

    // Handle result events for tools that had no toolUseId — match by FIFO order.
    if (this.isProviderToolResultEvent(event.messageType) && !event.toolUseId) {
      const pending = pendingNoIdToolObservations.shift();
      this.publishProviderToolLifecycleEvent(
        'provider.tool.completed.v1',
        metadata,
        event,
        pending?.toolCallId,
      );
      if (pending) {
        pending.observation.update({
          output: event.output,
          level: event.isError ? 'ERROR' : undefined,
          statusMessage: event.isError ? 'Tool call returned an error' : undefined,
        });
        pending.observation.end();
      }
      return;
    }

    if (!this.isProviderToolStartEvent(event.messageType)) {
      return;
    }

    // Start events without toolUseId: track with FIFO queue so we can end them when the
    // matching result event arrives. This avoids the zero-latency observation problem.
    const noIdToolCallId = uuidv4();
    this.publishProviderToolLifecycleEvent(
      'provider.tool.started.v1',
      metadata,
      event,
      noIdToolCallId,
    );
    const noIdObservation = this.ctx.observability.startWithTraceparent(traceparent, {
      type: 'tool',
      name: this.getProviderToolObservationName(event),
      input: event.input ?? {},
      metadata: {
        ...metadata,
        messageType: event.messageType,
        subtype: event.subtype ?? null,
        serverName: event.serverName ?? null,
      },
    });
    pendingNoIdToolObservations.push({
      observation: noIdObservation,
      toolCallId: noIdToolCallId,
    });
  }

  private finishProviderToolObservations(
    activeProviderToolObservations: Map<string, StartedObservationHandle>,
    pendingNoIdToolObservations: PendingNoIdProviderToolObservation[],
    update?: {
      level?: 'ERROR';
      statusMessage?: string;
    },
  ): void {
    for (const observation of activeProviderToolObservations.values()) {
      if (update) {
        observation.update(update);
      }
      observation.end();
    }
    activeProviderToolObservations.clear();

    // End any unmatched no-id observations (e.g. on error path where result never arrived)
    for (const pending of pendingNoIdToolObservations) {
      if (update) {
        pending.observation.update(update);
      }
      pending.observation.end();
    }
    pendingNoIdToolObservations.splice(0);
  }

  private shouldSkipProviderToolObservation(event: {
    messageType: string;
    serverName?: string;
  }): boolean {
    return (
      event.messageType === 'mcp_tool_use' &&
      (event.serverName === '__talond_host_tools' || event.serverName === '__talond_skill_loader')
    );
  }

  private isProviderToolStartEvent(messageType: string): boolean {
    return (
      messageType === 'tool_use' ||
      messageType === 'mcp_tool_use' ||
      messageType === 'server_tool_use'
    );
  }

  private isProviderToolResultEvent(messageType: string): boolean {
    return (
      messageType === 'tool_result' ||
      messageType === 'mcp_tool_result' ||
      messageType.endsWith('_tool_result')
    );
  }

  private getProviderToolObservationName(event: {
    messageType: string;
    tool?: string;
    serverName?: string;
  }): string {
    if (event.serverName) {
      return `${event.serverName}.${event.tool ?? event.messageType}`;
    }

    return event.tool ?? event.messageType;
  }

  private shouldRetryFreshSession(cause: unknown): cause is AgentQueryAttemptError {
    if (!(cause instanceof AgentQueryAttemptError)) {
      return false;
    }
    if (!cause.resumeSessionId || cause.sawEvents) {
      return false;
    }

    const message = cause.message.toLowerCase();
    return (
      message.includes('session') ||
      message.includes('resume') ||
      message.includes('expired') ||
      message.includes('not found') ||
      message.includes('timed out')
    );
  }

  /**
   * Marks an A2A task as failed if a task ID is present.
   * Safe to call even when the task ID is null (non-A2A items).
   */
  private failA2ATask(a2aTaskId: string | null, errorCode: string, message: string): void {
    if (!a2aTaskId) return;
    this.ctx.repos.a2aTask.markFailed(a2aTaskId, errorCode, message).mapErr((e) => {
      this.ctx.logger.warn(
        { a2aTaskId, errorCode, err: e.message },
        'agent-runner: failed to mark A2A task as failed',
      );
    });
  }

  private parseBackgroundTaskNotification(item: QueueItem): {
    content: string;
    taskId: string;
    status: string;
  } | null {
    if (item.type !== 'collaboration') {
      return null;
    }

    const kind = typeof item.payload.kind === 'string' ? item.payload.kind : null;
    const content = typeof item.payload.content === 'string' ? item.payload.content : null;
    const taskId = typeof item.payload.taskId === 'string' ? item.payload.taskId : null;
    const status = typeof item.payload.status === 'string' ? item.payload.status : null;

    if (
      kind !== 'background_task_notification' ||
      content === null ||
      taskId === null ||
      status === null
    ) {
      return null;
    }

    return { content, taskId, status };
  }

  private async deliverBackgroundTaskNotification(
    threadId: string,
    notification: { content: string; taskId: string; status: string },
  ): Promise<Result<void, Error>> {
    const threadResult = this.ctx.repos.thread.findById(threadId);
    if (threadResult.isErr() || threadResult.value === null) {
      return err(new Error(`thread not found for id ${threadId}`));
    }

    const channelResult = this.ctx.repos.channel.findById(threadResult.value.channel_id);
    if (channelResult.isErr() || channelResult.value === null) {
      return err(new Error(`channel not found for id ${threadResult.value.channel_id}`));
    }

    const connector = this.ctx.channelRegistry.get(channelResult.value.name);
    if (!connector) {
      return err(new Error(`channel connector not found: ${channelResult.value.name}`));
    }

    const sendResult = await connector.send(threadResult.value.external_id, {
      body: notification.content,
    });
    if (sendResult.isErr()) {
      return err(new Error(`channel send failed: ${sendResult.error.message}`));
    }

    this.ctx.repos.message.insert({
      id: uuidv4(),
      thread_id: threadId,
      direction: 'outbound',
      content: JSON.stringify({ body: notification.content }),
      idempotency_key: `background-task:${notification.taskId}:${notification.status}`,
      provider_id: null,
      run_id: null,
    });

    return ok(undefined);
  }
}
