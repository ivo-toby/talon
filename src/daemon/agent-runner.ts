import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';

import type { DaemonContext } from './daemon-context.js';
import type { AssembledContext } from './context-assembler.js';
import type { QueueItem } from '../queue/queue-types.js';
import { filterAllowedMcpTools } from '../tools/tool-filter.js';
import { buildPersonaRuntimeContext } from '../personas/persona-runtime-context.js';
import type {
  AgentUsage,
  CanonicalMcpSdkServer,
  CanonicalMcpServer,
} from '../providers/provider-types.js';
import type { StartedObservationHandle } from '../observability/langfuse/observability-types.js';

/** Default maximum time (ms) an Agent SDK query may run before being aborted. */
const DEFAULT_QUERY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

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

    const personaId = typeof item.payload.personaId === 'string' ? item.payload.personaId : null;
    if (personaId === null) {
      return err(new Error(`queue item ${item.id} is missing payload.personaId`));
    }

    const personaRowResult = this.ctx.repos.persona.findById(personaId);
    if (personaRowResult.isErr() || personaRowResult.value === null) {
      return err(new Error(`persona not found for id ${personaId}`));
    }

    const personaName = personaRowResult.value.name;
    const loadedPersonaResult = this.ctx.personaLoader.getByName(personaName);
    if (loadedPersonaResult.isErr() || loadedPersonaResult.value === undefined) {
      return err(new Error(`loaded persona not found for ${personaName}`));
    }
    const loadedPersona = loadedPersonaResult.value;

    const affinityProviderResult = this.ctx.repos.run.getLatestProviderName(item.threadId);
    const affinityProviderName =
      affinityProviderResult.isOk() && affinityProviderResult.value
        ? affinityProviderResult.value
        : null;
    const personaProviderName =
      typeof loadedPersona.config.provider === 'string' && loadedPersona.config.provider.length > 0
        ? loadedPersona.config.provider
        : null;
    const configuredDefaultProvider = this.ctx.config.agentRunner?.defaultProvider ?? 'claude-code';
    const preferredProviderOrder = [
      affinityProviderName,
      personaProviderName,
      configuredDefaultProvider,
    ].filter((name): name is string => typeof name === 'string' && name.length > 0);

    const providerEntry = this.ctx.providerRegistry.getDefault(preferredProviderOrder);
    if (!providerEntry) {
      return err(new Error('No enabled agent runner provider is configured'));
    }

    const strategy = providerEntry.provider.createExecutionStrategy();

    // Resolve session ID only for SDK providers.
    // We do NOT seed the tracker here — only after a successful run
    // to avoid stranding a thread on a stale/expired session ID.
    let resolvedSessionId: string | undefined;
    if (strategy.type === 'sdk') {
      resolvedSessionId = this.ctx.sessionTracker.getSessionId(item.threadId);
      if (!resolvedSessionId && !this.ctx.sessionTracker.wasRotated(item.threadId)) {
        const dbSessionResult = this.ctx.repos.run.getLatestSessionId(item.threadId);
        if (dbSessionResult.isOk() && dbSessionResult.value) {
          resolvedSessionId = dbSessionResult.value;
          this.ctx.logger.info(
            { threadId: item.threadId, sessionId: resolvedSessionId },
            'agent-sdk: restored session from DB after restart',
          );
        }
      }
    }

    const runId = uuidv4();
    const now = Date.now();
    const runInsert = this.ctx.repos.run.insert({
      id: runId,
      thread_id: item.threadId,
      persona_id: personaId,
      provider_name: providerEntry.provider.name,
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
    });

    if (runInsert.isErr()) {
      return err(new Error(`failed to create run record: ${runInsert.error.message}`));
    }

    const content = typeof item.payload.content === 'string' ? item.payload.content : '';
    let runFinalized = false;

    try {
      await this.ctx.observability.observe(
        {
          type: 'agent',
          name: 'foreground-run',
          input: {
            content,
            itemType: item.type,
            persona: personaName,
            provider: providerEntry.provider.name,
          },
          metadata: {
            runId,
            threadId: item.threadId,
            personaId,
            personaName,
            provider: providerEntry.provider.name,
          },
          trace: {
            sessionId: item.threadId,
            metadata: {
              runId,
              threadId: item.threadId,
              personaId,
              personaName,
              provider: providerEntry.provider.name,
            },
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

            const model = loadedPersona.config.model;

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
            const allChannels = this.ctx.channelRegistry
              .listAll()
              .map((c) => c.name);

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

            // Generate fresh timestamp per run so the agent can reason about time.
            const now_ = new Date();
            const pad = (n: number): string => String(n).padStart(2, '0');
            const offsetMin = now_.getTimezoneOffset();
            const offsetSign = offsetMin <= 0 ? '+' : '-';
            const absOffset = Math.abs(offsetMin);
            const offsetStr = `${offsetSign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
            const localISO = `${now_.getFullYear()}-${pad(now_.getMonth() + 1)}-${pad(now_.getDate())}T${pad(now_.getHours())}:${pad(now_.getMinutes())}:${pad(now_.getSeconds())}${offsetStr}`;
            const tzAbbr = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(now_).find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
            const dayName = now_.toLocaleDateString('en', { weekday: 'long' });
            const timeContext = `Current time: ${localISO} (${tzAbbr}, ${dayName})`;
            const existingSessionId = strategy.type === 'sdk' ? resolvedSessionId : undefined;

            const baseMcpServers: Record<string, CanonicalMcpServer> = {
              ...personaRuntimeContext.mcpServers,
            };

            // Determine which host tools this persona may use based on capabilities.
            let allowedMcpTools = filterAllowedMcpTools(
              loadedPersona.resolvedCapabilities ?? { allow: [], requireApproval: [] },
            );
            if (!this.ctx.backgroundAgentManager) {
              allowedMcpTools = allowedMcpTools.filter((toolName) => toolName !== 'background_agent');
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
            const externalId =
              threadResult.isOk() && threadResult.value ? threadResult.value.external_id : undefined;

            // Send typing indicator and keep it alive every 4s while the agent works.
            if (connector?.sendTyping && externalId) {
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
              contextManagement?.enabled
              && (
                contextManagement.triggerMetric === undefined
                || contextManagement.thresholdRatio === undefined
                || contextManagement.recentMessageCount === undefined
                || contextManagement.summarizer === undefined
              )
            ) {
              throw new Error(
                `Provider "${providerEntry.provider.name}" has incomplete contextManagement configuration. Check agentRunner.providers.${providerEntry.provider.name}.contextManagement.`,
              );
            }
            const enabledContextManagement = contextManagement?.enabled
              ? {
                  triggerMetric: contextManagement.triggerMetric!,
                  thresholdRatio: contextManagement.thresholdRatio!,
                  recentMessageCount: contextManagement.recentMessageCount!,
                  summarizer: contextManagement.summarizer!,
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
                  async (retrieverObservation) => {
                    const assembled = this.ctx.contextAssembler.assemble(
                      item.threadId,
                      freshSessionRecentMessageCount,
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

            if (strategy.type === 'cli' && connector && externalId && item.payload.type !== 'schedule') {
              const waitingResult = await connector.send(externalId, {
                body: 'Thinking...',
              });
              if (waitingResult.isErr()) {
                this.ctx.logger.debug({ err: waitingResult.error }, 'agent-runner: waiting notification failed');
              }
            }

            const executeAgentQuery = async (resumeSessionId?: string): Promise<{
              outputText: string;
              resultSessionId: string | undefined;
              usage: AgentUsage;
            }> => {
              const systemPromptParts = [
                personaRuntimeContext.personaPrompt,
                channelContext,
                timeContext,
              ];
              if (!(strategy.type === 'sdk' && resumeSessionId)) {
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
                  if (strategy.type === 'sdk' && skillContentMap.size > 0) {
                    const skillLoaderServer = createSdkMcpServer({
                      name: '__talond_skill_loader',
                      tools: [
                        tool(
                          'skill_load',
                          'Load the full instructions for a skill. Pass the skill name exactly as shown in Available Skills.',
                          { name: z.string().describe('Skill name') },
                          async (args) => {
                            const content = skillContentMap.get(args.name);
                            if (content === undefined) {
                              return {
                                content: [
                                  {
                                    type: 'text' as const,
                                    text: `Error: skill "${args.name}" not found. Available: ${[...skillContentMap.keys()].join(', ')}`,
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
                      args: [join(import.meta.dirname, '../../dist/tools/host-tools-mcp-server.js')],
                      env: {
                        ...process.env,
                        TALOND_SOCKET: this.ctx.hostToolsBridge.path,
                        TALOND_RUN_ID: runId,
                        TALOND_THREAD_ID: item.threadId,
                        TALOND_PERSONA_ID: personaId,
                        TALOND_ALLOWED_TOOLS: allowedMcpTools.join(','),
                        TALOND_TRACEPARENT: generationObservation.getTraceparent() ?? '',
                      },
                    },
                  };

                  if (strategy.type === 'cli' && skillContentMap.size > 0) {
                    mcpServers.__talond_skill_loader = {
                      transport: 'stdio',
                      command: 'node',
                      args: [join(import.meta.dirname, '../../dist/tools/skill-loader-mcp-server.js')],
                      env: {
                        ...process.env,
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
                  let resultSessionId: string | undefined;
                  let usage: AgentUsage = {
                    inputTokens: 0,
                    outputTokens: 0,
                  };
                  let sawEvents = false;
                  const activeProviderToolObservations = new Map<string, StartedObservationHandle>();
                  const ignoredProviderToolUseIds = new Set<string>();
                  const pendingProviderToolTasks: Array<Promise<void>> = [];

                  const queryInput = {
                    prompt: content,
                    systemPrompt,
                    mcpServers,
                    cwd: workspaceResult.value,
                    model,
                    maxTurns: 25,
                    timeoutMs: this.queryTimeoutMs,
                    ...(strategy.type === 'sdk' && resumeSessionId
                      ? { sessionId: resumeSessionId }
                      : {}),
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
                        const { value, done } = await iterator.next();
                        if (done) break;
                        const event = value;
                        sawEvents = true;
                        if (event.type === 'text') {
                          outputText += event.content;
                        } else if (event.type === 'result') {
                          resultSessionId = event.result.sessionId;
                          usage = event.result.usage;

                          if (!outputText && event.result.output) {
                            outputText = event.result.output;
                          }

                          if (event.result.isError) {
                            this.ctx.logger.warn(
                              { runId, result: event.result.output },
                              'agent-runner: run ended with provider error',
                            );
                          }
                        } else if (event.type === 'tool_event') {
                          this.handleProviderToolEvent(
                            generationObservation.getTraceparent(),
                            {
                              runId,
                              threadId: item.threadId,
                              provider: providerEntry.provider.name,
                            },
                            activeProviderToolObservations,
                            ignoredProviderToolUseIds,
                            pendingProviderToolTasks,
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
                    resultSessionId = result.sessionId;
                    usage = result.usage;

                    if (result.isError) {
                      throw new Error(`CLI provider returned error: ${result.output || 'unknown error'}`);
                    }
                  })();

                  let timeoutId: ReturnType<typeof setTimeout>;
                  const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(
                      () => reject(new Error(`agent-sdk query timed out after ${this.queryTimeoutMs / 1000}s`)),
                      this.queryTimeoutMs,
                    );
                  });

                  try {
                    await Promise.race([queryPromise, timeoutPromise]);
                  } catch (cause) {
                    // Abort the in-flight provider stream to prevent leaked work
                    if (activeIterator?.return) {
                      activeIterator.return(undefined).catch(() => {});
                    }
                    this.finishProviderToolObservations(activeProviderToolObservations, {
                      level: 'ERROR',
                      statusMessage: cause instanceof Error ? cause.message : String(cause),
                    });
                    ignoredProviderToolUseIds.clear();
                    await Promise.allSettled(pendingProviderToolTasks);
                    const message = cause instanceof Error ? cause.message : String(cause);
                    throw new AgentQueryAttemptError(message, resumeSessionId, sawEvents);
                  } finally {
                    clearTimeout(timeoutId!);
                  }

                  this.finishProviderToolObservations(activeProviderToolObservations);
                  ignoredProviderToolUseIds.clear();
                  await Promise.allSettled(pendingProviderToolTasks);

                  generationObservation.update({
                    output: outputText,
                    metadata: {
                      resultSessionId: resultSessionId ?? null,
                      resumeSessionId: resumeSessionId ?? null,
                    },
                    usageDetails: {
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      cacheReadTokens: usage.cacheReadTokens ?? 0,
                      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                    },
                    costDetails:
                      usage.totalCostUsd !== undefined
                        ? { totalCostUsd: usage.totalCostUsd }
                        : undefined,
                  });

                  return {
                    outputText,
                    resultSessionId,
                    usage,
                  };
                },
              );
            };

            let outputText = '';
            let resultSessionId: string | undefined;
            let usage: AgentUsage = {
              inputTokens: 0,
              outputTokens: 0,
            };

            try {
              ({
                outputText,
                resultSessionId,
                usage,
              } = await executeAgentQuery(existingSessionId));
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
                ({
                  outputText,
                  resultSessionId,
                  usage,
                } = await executeAgentQuery(undefined));
              } else {
                throw cause;
              }
            }

            // Store session ID for future conversation resumption (memory + DB).
            if (resultSessionId) {
              this.ctx.sessionTracker.setSessionId(item.threadId, resultSessionId);
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
              this.ctx.logger.error({ runId, err: tokenResult.error }, 'agent-runner: failed to persist token usage');
            }

            // Check if context needs rotation (rolling window).
            // Awaited to prevent race with next queue item for the same thread.
            if (this.ctx.contextRoller && enabledContextManagement) {
              const contextUsage = providerEntry.provider.estimateContextUsage(usage);
              const selectedMetricValue = contextUsage.metrics[enabledContextManagement.triggerMetric];
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
                    await this.ctx.contextRoller.checkAndRotate(
                      item.threadId,
                      personaId,
                      {
                        ratio: selectedMetricValue / Math.max(1, providerEntry.config.contextWindowTokens),
                        inputTokens: contextUsage.inputTokens,
                        rawMetric: selectedMetricValue,
                        rawMetricName: enabledContextManagement.triggerMetric,
                      },
                      enabledContextManagement.thresholdRatio,
                      enabledContextManagement.summarizer,
                    );
                  }
                } catch (e: unknown) {
                  this.ctx.logger.error(
                    { threadId: item.threadId, err: e },
                    'agent-runner: context rotation failed',
                  );
                }
              }
            }

            if (item.type === 'schedule') {
              this.ctx.logger.info(
                { runId, outputLength: outputText.length },
                'agent-sdk: skipping outbound reply for schedule item (agent already sent via channel_send)',
              );
            } else if (connector !== undefined && externalId) {
              const sendResult = await connector.send(externalId, {
                body: outputText,
              });
              if (sendResult.isErr()) {
                throw new Error(`channel send failed: ${sendResult.error.message}`);
              }
            }

            this.ctx.repos.message.insert({
              id: uuidv4(),
              thread_id: item.threadId,
              direction: 'outbound',
              content: JSON.stringify({ body: outputText }),
              idempotency_key: `outbound:${runId}`,
              provider_id: null,
              run_id: runId,
            });

            runObservation.update({
              output: {
                text: outputText,
              },
              metadata: {
                resultSessionId: resultSessionId ?? null,
              },
              trace: {
                output: outputText,
              },
            });

            this.ctx.repos.run.updateStatus(runId, 'completed', {
              ended_at: Date.now(),
            });
            runFinalized = true;
          } catch (cause) {
            if (typingInterval) clearInterval(typingInterval);
            const error = this.toError(cause);
            this.ctx.repos.run.updateStatus(runId, 'failed', {
              ended_at: Date.now(),
              error: error.message,
            });
            runFinalized = true;
            throw error;
          }
        },
      );

      return ok(undefined);
    } catch (cause) {
      const error = this.toError(cause);
      if (!runFinalized) {
        this.ctx.repos.run.updateStatus(runId, 'failed', {
          ended_at: Date.now(),
          error: error.message,
        });
      }
      return err(error);
    }
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
    },
    activeProviderToolObservations: Map<string, StartedObservationHandle>,
    ignoredProviderToolUseIds: Set<string>,
    pendingProviderToolTasks: Array<Promise<void>>,
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
      const observation = this.ctx.observability.startWithTraceparent(traceparent, {
        type: 'tool',
        name: this.getProviderToolObservationName(event),
        input: event.input,
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

    if (!this.isProviderToolStartEvent(event.messageType)) {
      return;
    }

    pendingProviderToolTasks.push(
      this.ctx.observability
        .observeWithTraceparent(
          traceparent,
          {
            type: 'tool',
            name: this.getProviderToolObservationName(event),
            input: event.input,
            metadata: {
              ...metadata,
              messageType: event.messageType,
              subtype: event.subtype ?? null,
              serverName: event.serverName ?? null,
            },
          },
          async () => undefined,
        )
        .catch((error) => {
          this.ctx.logger.debug({ err: error }, 'agent-runner: provider tool observation failed');
        }),
    );
  }

  private finishProviderToolObservations(
    activeProviderToolObservations: Map<string, StartedObservationHandle>,
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
  }

  private shouldSkipProviderToolObservation(event: {
    messageType: string;
    serverName?: string;
  }): boolean {
    return event.messageType === 'mcp_tool_use'
      && (
        event.serverName === '__talond_host_tools'
        || event.serverName === '__talond_skill_loader'
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

  private parseBackgroundTaskNotification(item: QueueItem): {
    content: string;
    taskId: string;
    status: string;
  } | null {
    if (item.type !== 'collaboration') {
      return null;
    }

    const kind =
      typeof item.payload.kind === 'string'
        ? item.payload.kind
        : null;
    const content =
      typeof item.payload.content === 'string'
        ? item.payload.content
        : null;
    const taskId =
      typeof item.payload.taskId === 'string'
        ? item.payload.taskId
        : null;
    const status =
      typeof item.payload.status === 'string'
        ? item.payload.status
        : null;

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
