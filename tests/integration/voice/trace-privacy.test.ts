import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { err, ok } from 'neverthrow';

import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { BackgroundTaskRepository } from '../../../src/core/database/repositories/background-task-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import { ContextRoller } from '../../../src/daemon/context-roller.js';
import {
  PersonaConfigSchema,
  AgentRunnerProviderConfigSchema,
} from '../../../src/core/config/config-schema.js';
import { LangfuseObservabilityService } from '../../../src/observability/langfuse/langfuse-observability.js';
import {
  createVoiceSafeLogger,
  createVoiceObservationContext,
  observeVoiceSafely,
  startVoiceObservationSafely,
} from '../../../src/observability/langfuse/voice-observation.js';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import { BackgroundAgentManager } from '../../../src/subagents/background/background-agent-manager.js';
import { QueueManager, createQueueDiagnosticResolver } from '../../../src/queue/queue-manager.js';
import { rowToQueueItem } from '../../../src/queue/queue-mapper.js';
import { QueueItemStatus } from '../../../src/queue/queue-types.js';
import { ProviderRegistry } from '../../../src/providers/provider-registry.js';
import type { AgentProvider } from '../../../src/providers/provider.js';
import type { AgentRunResult } from '../../../src/providers/provider.js';
import type {
  ObservationHandle,
  ObservationInput,
  ObservabilityService,
  StartedObservationHandle,
} from '../../../src/observability/langfuse/observability-types.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import type { ModelResolver } from '../../../src/subagents/model-resolver.js';
import { SubAgentRunner } from '../../../src/subagents/subagent-runner.js';
import type { LoadedSubAgent, SubAgentServices } from '../../../src/subagents/subagent-types.js';
import { ChannelSendHandler } from '../../../src/tools/host-tools/channel-send.js';
import type { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import type { ChannelConnector } from '../../../src/channels/channel-types.js';
import type { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';

describe('voice trace privacy integration', () => {
  it('keeps nested voice observations content-free and disables native AI SDK telemetry', async () => {
    const exporter = new InMemorySpanExporter();
    const service = new LangfuseObservabilityService(
      {
        enabled: true,
        publicKey: 'pk-test',
        secretKey: 'sk-test',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        exportMode: 'immediate',
        flushAt: 1,
        flushIntervalSeconds: 1,
      },
      pino({ level: 'silent' }),
      { exporter, shouldExportSpan: () => true },
    );
    const voice = createVoiceObservationContext({
      callId: 'call-voice-1',
      delegationId: 'delegation-voice-1',
      queueItemId: 'queue-voice-1',
      runId: 'run-voice-1',
      threadId: 'thread-voice-1',
      personaId: 'persona-voice-1',
      provider: 'fake-provider',
      model: 'fake-model',
    });
    const sentinel = 'voice transcript, tool argument, tool result, and raw exception';
    let nativeTelemetryEnabled: boolean | undefined;

    const subagent: LoadedSubAgent = {
      manifest: {
        name: 'privacy-agent',
        version: '1.0.0',
        description: 'privacy test agent',
        model: { provider: 'fake', name: 'fake-model', maxTokens: 128 },
        requiredCapabilities: ['memory.access'],
        rootPaths: [],
        timeoutMs: 1_000,
      },
      promptContents: ['privacy test prompt'],
      rootDir: '/tmp/privacy-agent',
      run: async (context) => {
        nativeTelemetryEnabled = context.telemetry.isEnabled;
        return ok({ summary: sentinel, data: { result: sentinel } });
      },
    };
    const runner = new SubAgentRunner(
      new Map([['privacy-agent', subagent]]),
      { resolve: async () => ok({} as never) } as unknown as ModelResolver,
      {} as SubAgentServices,
      pino({ level: 'silent' }),
      service,
    );

    await expect(
      observeVoiceSafely({
        service,
        input: {
          type: 'agent',
          name: 'voice-run',
          input: { transcript: sentinel },
          output: { response: sentinel },
          metadata: { secret: sentinel },
        },
        context: voice,
        callback: async (root) => {
          const traceparent = root.getTraceparent();
          await observeVoiceSafely({
            service,
            traceparent,
            input: {
              type: 'tool',
              name: 'channel.send',
              input: { argument: sentinel },
              output: { result: sentinel },
            },
            context: voice,
            callback: async () => {
              const result = await runner.execute(
                'privacy-agent',
                { input: sentinel },
                {
                  threadId: voice.threadId ?? 'thread-voice-1',
                  personaId: voice.personaId ?? 'persona-voice-1',
                  personaSubagents: ['privacy-agent'],
                  personaCapabilities: { allow: ['memory.access'], requireApproval: [] },
                  traceparent: traceparent ?? undefined,
                  voiceObservation: voice,
                },
              );
              expect(result.isOk()).toBe(true);
              return result;
            },
          });
          return root;
        },
      }),
    ).resolves.toBeDefined();

    const serializedSpans = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(serializedSpans).not.toContain(sentinel);
    expect(nativeTelemetryEnabled).toBe(false);
    expect(exporter.getFinishedSpans().length).toBeGreaterThanOrEqual(3);

    await service.shutdown();
  });

  it('does not turn a failed voice callback into a second execution', async () => {
    const service = {
      observe: async (
        _input: unknown,
        callback: (handle: { update: () => void; getTraceparent: () => null }) => Promise<void>,
      ) => {
        await callback({ update: () => {}, getTraceparent: () => null });
      },
      observeWithTraceparent: async (
        _parent: unknown,
        _input: unknown,
        callback: (handle: { update: () => void; getTraceparent: () => null }) => Promise<void>,
      ) => {
        await callback({ update: () => {}, getTraceparent: () => null });
      },
      start: () => ({ update: () => {}, getTraceparent: () => null, end: () => {} }),
      startWithTraceparent: () => ({ update: () => {}, getTraceparent: () => null, end: () => {} }),
      shutdown: async () => {},
    };
    const voice = createVoiceObservationContext({ runId: 'run-voice-2' });
    const callback = vi.fn().mockRejectedValue(new Error('raw voice exception'));

    await expect(
      observeVoiceSafely({
        service,
        input: { type: 'tool', name: 'memory.access', input: { secret: 'raw' } },
        context: voice,
        callback,
      }),
    ).rejects.toThrow('raw voice exception');
    expect(callback).toHaveBeenCalledOnce();
  });

  it('preserves one provider and tool execution when observation and logger failures are injected', async () => {
    const promptSentinel = 'VOICE_TELEMETRY_PROMPT_SENTINEL';
    const outputSentinel = 'VOICE_TELEMETRY_OUTPUT_SENTINEL';
    const errorSentinel = 'VOICE_TELEMETRY_ERROR_SENTINEL';
    const startSentinel = 'VOICE_TELEMETRY_START_FAILURE_SENTINEL';
    const updateSentinel = 'VOICE_TELEMETRY_UPDATE_FAILURE_SENTINEL';
    const exportSentinel = 'VOICE_TELEMETRY_EXPORT_FAILURE_SENTINEL';
    const voice = createVoiceObservationContext({
      callId: 'voice-telemetry-call',
      runId: 'voice-telemetry-run',
      threadId: 'voice-telemetry-thread',
    });
    const faulting = makeFaultingObservability({
      startError: startSentinel,
      updateError: updateSentinel,
      exportError: exportSentinel,
    });
    let providerExecutions = 0;
    let toolExecutions = 0;

    const result = await observeVoiceSafely({
      service: faulting.service,
      input: {
        type: 'agent',
        name: 'provider-name-that-must-not-be-exported',
        input: { prompt: promptSentinel },
      },
      context: voice,
      callback: async (providerObservation) => {
        providerExecutions += 1;
        providerObservation.update({
          input: promptSentinel,
          output: outputSentinel,
          metadata: { secret: promptSentinel },
        });
        const toolResult = await observeVoiceSafely({
          service: faulting.service,
          traceparent: providerObservation.getTraceparent(),
          input: {
            type: 'tool',
            name: 'regex-safe-tool-name',
            input: { argument: promptSentinel },
            output: outputSentinel,
          },
          context: voice,
          callback: async (toolObservation) => {
            toolExecutions += 1;
            toolObservation.update({ output: outputSentinel });
            return { output: outputSentinel };
          },
        });
        return { output: toolResult.output };
      },
    });

    expect(result).toEqual({ output: outputSentinel });
    expect(providerExecutions).toBe(1);
    expect(toolExecutions).toBe(1);
    expect(JSON.stringify(faulting.records)).not.toContain(promptSentinel);
    expect(JSON.stringify(faulting.records)).not.toContain(outputSentinel);
    expect(JSON.stringify(faulting.records)).not.toContain(errorSentinel);
    expect(JSON.stringify(faulting.records)).not.toContain(startSentinel);
    expect(JSON.stringify(faulting.records)).not.toContain(updateSentinel);
    expect(JSON.stringify(faulting.records)).not.toContain(exportSentinel);

    const callbackError = vi.fn().mockRejectedValue(new Error(errorSentinel));
    await expect(
      observeVoiceSafely({
        service: faulting.service,
        input: { type: 'agent', name: 'provider-name-that-must-not-be-exported' },
        context: voice,
        callback: callbackError,
      }),
    ).rejects.toThrow(errorSentinel);
    expect(callbackError).toHaveBeenCalledOnce();
    expect(JSON.stringify(faulting.records)).not.toContain(errorSentinel);

    const startFailure = makeFaultingObservability({ startError: startSentinel });
    const started = startVoiceObservationSafely(
      startFailure.service,
      null,
      { type: 'tool', name: 'regex-safe-tool-name', input: promptSentinel },
      voice,
    );
    expect(() => {
      started.update({ output: outputSentinel });
      started.end();
    }).not.toThrow();

    const throwingLogger = makeThrowingLogger();
    const safeLogger = createVoiceSafeLogger(throwingLogger);
    expect(() => {
      safeLogger.info({ prompt: promptSentinel }, promptSentinel);
      safeLogger.warn({ output: outputSentinel }, outputSentinel);
      safeLogger.error({ error: errorSentinel }, errorSentinel);
    }).not.toThrow();
  });

  it('keeps connector failure diagnostics free of voice content and caller arguments', async () => {
    const logger = makeInspectableLogger();
    const connectorError = 'VOICE_CONNECTOR_ERROR_SENTINEL';
    const connector = makeConnector(err(new Error(connectorError)));
    const handler = makeChannelSendHandler({ connector, logger });
    const voice = createVoiceObservationContext({
      runId: 'trusted-run',
      threadId: 'trusted-thread',
      personaId: 'trusted-persona',
    });

    const result = await handler.execute(
      {
        channelId: 'VOICE_CALLER_CHANNEL_SENTINEL',
        content: 'VOICE_TRANSCRIPT_SENTINEL',
        externalChatId: 'VOICE_CALLER_EXTERNAL_SENTINEL',
      },
      {
        runId: 'trusted-run',
        threadId: 'trusted-thread',
        personaId: 'trusted-persona',
        requestId: 'trusted-request',
        voiceObservation: voice,
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain(connectorError);
    expect(connector.send).toHaveBeenCalledWith(
      'VOICE_CALLER_EXTERNAL_SENTINEL',
      expect.objectContaining({ body: 'VOICE_TRANSCRIPT_SENTINEL' }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('VOICE_CALLER_CHANNEL_SENTINEL');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(connectorError);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('VOICE_CALLER_EXTERNAL_SENTINEL');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('VOICE_TRANSCRIPT_SENTINEL');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ voice: true, runId: 'trusted-run', errorCategory: 'unknown' }),
      'channel.send: connector send failed',
    );
  });

  it('keeps outbound persistence channel failures free of voice content and caller arguments', async () => {
    const logger = makeInspectableLogger();
    const persistenceError = 'VOICE_CHANNEL_REPOSITORY_ERROR_SENTINEL';
    const connector = makeConnector(ok(undefined));
    const channelRepository = {
      findByName: vi.fn().mockReturnValue(err(new Error(persistenceError))),
    };
    const messageRepository = { insert: vi.fn().mockReturnValue(ok({})) };
    const handler = makeChannelSendHandler({
      connector,
      logger,
      channelRepository,
      messageRepository,
    });
    const voice = createVoiceObservationContext({
      runId: 'trusted-run',
      threadId: 'trusted-thread',
      personaId: 'trusted-persona',
    });

    const result = await handler.execute(
      {
        channelId: 'VOICE_CALLER_CHANNEL_SENTINEL',
        content: 'VOICE_TRANSCRIPT_SENTINEL',
        externalChatId: 'VOICE_CALLER_EXTERNAL_SENTINEL',
      },
      {
        runId: 'trusted-run',
        threadId: 'trusted-thread',
        personaId: 'trusted-persona',
        requestId: 'trusted-request',
        voiceObservation: voice,
      },
    );

    expect(result.status).toBe('success');
    expect(connector.send).toHaveBeenCalledWith(
      'VOICE_CALLER_EXTERNAL_SENTINEL',
      expect.objectContaining({ body: 'VOICE_TRANSCRIPT_SENTINEL' }),
    );
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(persistenceError);
    expect(logged).not.toContain('VOICE_CALLER_CHANNEL_SENTINEL');
    expect(logged).not.toContain('VOICE_CALLER_EXTERNAL_SENTINEL');
    expect(logged).not.toContain('VOICE_TRANSCRIPT_SENTINEL');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ voice: true, runId: 'trusted-run', errorCategory: 'unknown' }),
      'channel.send: outbound persistence channel lookup failed',
    );
  });

  it('keeps outbound recipient lookup failures free of voice repository errors', async () => {
    const logger = makeInspectableLogger();
    const persistenceError = 'VOICE_RECIPIENT_REPOSITORY_ERROR_SENTINEL';
    const connector = makeConnector(ok(undefined));
    const channelRepository = {
      findByName: vi.fn().mockReturnValue(ok({ id: 'trusted-channel' })),
    };
    const messageRepository = { insert: vi.fn().mockReturnValue(ok({})) };
    const threadRepository = makeThreadRepository({
      findByExternalId: vi.fn().mockReturnValue(err(new Error(persistenceError))),
    });
    const handler = makeChannelSendHandler({
      connector,
      logger,
      channelRepository,
      messageRepository,
      threadRepository,
    });
    const voice = createVoiceObservationContext({
      runId: 'trusted-run',
      threadId: 'trusted-thread',
      personaId: 'trusted-persona',
    });

    const result = await handler.execute(
      {
        channelId: 'VOICE_CALLER_CHANNEL_SENTINEL',
        content: 'VOICE_TRANSCRIPT_SENTINEL',
        externalChatId: 'VOICE_CALLER_EXTERNAL_SENTINEL',
      },
      {
        runId: 'trusted-run',
        threadId: 'trusted-thread',
        personaId: 'trusted-persona',
        requestId: 'trusted-request',
        voiceObservation: voice,
      },
    );

    expect(result.status).toBe('success');
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(persistenceError);
    expect(logged).not.toContain('VOICE_CALLER_CHANNEL_SENTINEL');
    expect(logged).not.toContain('VOICE_CALLER_EXTERNAL_SENTINEL');
    expect(logged).not.toContain('VOICE_TRANSCRIPT_SENTINEL');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ voice: true, runId: 'trusted-run', errorCategory: 'unknown' }),
      'channel.send: outbound persistence recipient lookup failed',
    );
  });

  it('preserves background parse, timeout, cancellation, shutdown, and provider outcomes once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'talon-task39-background-'));
    const databasePath = join(dataDir, 'talon.sqlite');
    const logger = makeInspectableLogger();
    const faulting = makeFaultingObservability({
      updateError: 'VOICE_BACKGROUND_UPDATE_FAILURE_SENTINEL',
      exportError: 'VOICE_BACKGROUND_EXPORT_FAILURE_SENTINEL',
    });
    let db: Database.Database | undefined;
    let manager: BackgroundAgentManager | undefined;

    const promptSentinel = 'VOICE_BACKGROUND_PROMPT_SENTINEL';
    const successOutput = 'VOICE_BACKGROUND_SUCCESS_OUTPUT_SENTINEL';
    const providerError = 'VOICE_BACKGROUND_PROVIDER_ERROR_SENTINEL';
    const parseOutput = 'VOICE_BACKGROUND_PARSE_OUTPUT_SENTINEL';
    const parseStderr = 'VOICE_BACKGROUND_PARSE_STDERR_SENTINEL';
    const parseError = 'VOICE_BACKGROUND_PARSE_ERROR_SENTINEL';
    const timeoutOutput = 'VOICE_BACKGROUND_TIMEOUT_OUTPUT_SENTINEL';
    const timeoutError = 'VOICE_BACKGROUND_TIMEOUT_ERROR_SENTINEL';
    const exitOutput = 'VOICE_BACKGROUND_EXIT_OUTPUT_SENTINEL';
    const exitError = 'VOICE_BACKGROUND_EXIT_ERROR_SENTINEL';
    const personaId = 'task39-background-persona';
    const channelId = 'task39-background-channel';
    const threadId = 'task39-background-thread';
    const completionResolvers: Array<(value: unknown) => void> = [];
    const killCalls: ReturnType<typeof vi.fn>[] = [];
    let processStarts = 0;
    const parser = vi.fn(
      (raw: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }) => {
        if (raw.stdout === parseOutput) throw new Error(parseError);
        return {
          output: raw.stdout,
          stderr: raw.stderr,
          exitCode: raw.exitCode,
          timedOut: raw.timedOut,
        };
      },
    );

    try {
      db = createTracePrivacyDatabase(databasePath, { personaId, channelId, threadId });
      const channelRepository = new ChannelRepository(db);
      const threadRepository = new ThreadRepository(db);
      const queueRepository = new QueueRepository(db);
      const queueManager = new QueueManager(
        queueRepository,
        threadRepository,
        { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
        logger,
        undefined,
        createQueueDiagnosticResolver(threadRepository, channelRepository),
      );
      vi.spyOn(queueManager, 'enqueue');

      const backgroundTaskRepository = new BackgroundTaskRepository(db);
      const provider = makeBackgroundPrivacyProvider(dataDir, successOutput);
      provider.parseBackgroundResult = parser;
      const providerEntry = {
        name: 'background-fake',
        type: 'background-fake',
        provider,
        config: {
          enabled: true,
          command: 'task39-background-fake',
          contextWindowTokens: 1_000,
          options: { defaultModel: 'background-model' },
        },
      };
      const bridge = {
        registerRunAuthentication: vi.fn(),
        unregisterRunAuthentication: vi.fn(),
      };
      manager = new BackgroundAgentManager({
        repository: backgroundTaskRepository,
        queueManager,
        maxConcurrent: 2,
        defaultTimeoutMinutes: 15,
        defaultProvider: 'background-fake',
        providerRegistry: {
          get: vi.fn(() => providerEntry),
          getDefault: vi.fn(() => providerEntry),
          listEnabled: vi.fn(() => ['background-fake']),
          hasProvider: vi.fn(() => true),
        },
        logger,
        processFactory: vi.fn(() => {
          processStarts += 1;
          let resolveCompletion: (value: unknown) => void = () => {};
          const completion = new Promise<unknown>((resolve) => {
            resolveCompletion = resolve;
          });
          completionResolvers.push(resolveCompletion);
          const kill = vi.fn();
          killCalls.push(kill);
          return {
            start: vi.fn(() => ok({ pid: null, completion })),
            kill,
          };
        }) as any,
        hostToolsSocketPath: join(dataDir, 'host-tools.sock'),
        hostToolsBridge: bridge,
        observability: faulting.service,
      });

      const spawnTask = async (
        prompt: string,
        completion: unknown,
      ): Promise<
        NonNullable<ReturnType<BackgroundTaskRepository['findById']>['_unsafeUnwrap']>
      > => {
        const spawnResult = await manager!.spawn({
          prompt,
          personaPrompt: 'VOICE_BACKGROUND_SYSTEM_PROMPT_SENTINEL',
          mcpServers: {},
          personaId,
          workerPersonaId: personaId,
          threadId,
          channelId,
          channelName: 'task39-voice-channel',
          allowedMcpTools: [],
          voiceObservation: createVoiceObservationContext({
            callId: 'task39-background-call',
            delegationId: 'task39-background-delegation',
            queueItemId: 'task39-background-queue',
            runId: 'task39-parent-run',
            threadId,
            personaId,
            provider: 'background-fake',
            model: 'background-model',
          }),
        });
        const taskId = spawnResult._unsafeUnwrap();
        completionResolvers.at(-1)?.(completion);
        await waitForTracePrivacyCondition(() => {
          const task = backgroundTaskRepository.findById(taskId)._unsafeUnwrap();
          return task?.status !== 'running';
        });
        return backgroundTaskRepository.findById(taskId)._unsafeUnwrap()!;
      };

      const successTask = await spawnTask(
        promptSentinel,
        ok({
          stdout: successOutput,
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
      );
      const providerFailureTask = await spawnTask(promptSentinel, err(new Error(providerError)));
      const parseFailureTask = await spawnTask(
        promptSentinel,
        ok({
          stdout: parseOutput,
          stderr: parseStderr,
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
      );
      const timeoutTask = await spawnTask(
        promptSentinel,
        ok({
          stdout: timeoutOutput,
          stderr: timeoutError,
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
        }),
      );
      const exitTask = await spawnTask(
        promptSentinel,
        ok({
          stdout: exitOutput,
          stderr: exitError,
          exitCode: 17,
          signal: null,
          timedOut: false,
        }),
      );

      expect(successTask.status).toBe('completed');
      expect(successTask.output).toBe(successOutput);
      expect(providerFailureTask.status).toBe('failed');
      expect(providerFailureTask.error).toBe(providerError);
      expect(parseFailureTask.status).toBe('failed');
      expect(parseFailureTask.output).toContain(parseOutput);
      expect(parseFailureTask.output).toContain(parseStderr);
      expect(parseFailureTask.error).toBe(parseError);
      expect(timeoutTask.status).toBe('timed_out');
      expect(timeoutTask.output).toBe(timeoutOutput);
      expect(timeoutTask.error).toBe('Process timed out');
      expect(exitTask.status).toBe('failed');
      expect(exitTask.output).toBe(exitOutput);
      expect(exitTask.error).toBe(exitError);
      expect(successTask.prompt).toBe(promptSentinel);
      expect(providerFailureTask.prompt).toBe(promptSentinel);
      expect(parseFailureTask.prompt).toBe(promptSentinel);
      expect(timeoutTask.prompt).toBe(promptSentinel);
      expect(exitTask.prompt).toBe(promptSentinel);
      expect(processStarts).toBe(5);
      expect(parser).toHaveBeenCalledTimes(4);
      expect(queueManager.enqueue).toHaveBeenCalledTimes(10);

      const cancelSpawn = await manager.spawn({
        prompt: promptSentinel,
        personaPrompt: 'VOICE_BACKGROUND_SYSTEM_PROMPT_SENTINEL',
        mcpServers: {},
        personaId,
        workerPersonaId: personaId,
        threadId,
        channelId,
        channelName: 'task39-voice-channel',
        allowedMcpTools: [],
        voiceObservation: createVoiceObservationContext({ runId: 'task39-cancel-parent' }),
      });
      const cancelId = cancelSpawn._unsafeUnwrap();
      const cancelResult = await manager.cancel(cancelId);
      expect(cancelResult.isOk()).toBe(true);
      expect(cancelResult._unsafeUnwrap()).toBe(true);
      expect(backgroundTaskRepository.findById(cancelId)._unsafeUnwrap()?.status).toBe('cancelled');
      expect(killCalls.at(-1)).toHaveBeenCalledOnce();
      completionResolvers.at(-1)?.(
        ok({
          stdout: promptSentinel,
          stderr: timeoutError,
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queueManager.enqueue).toHaveBeenCalledTimes(10);
      expect(processStarts).toBe(6);

      const shutdownSpawn = await manager.spawn({
        prompt: promptSentinel,
        personaPrompt: 'VOICE_BACKGROUND_SYSTEM_PROMPT_SENTINEL',
        mcpServers: {},
        personaId,
        workerPersonaId: personaId,
        threadId,
        channelId,
        channelName: 'task39-voice-channel',
        allowedMcpTools: [],
        voiceObservation: createVoiceObservationContext({ runId: 'task39-shutdown-parent' }),
      });
      const shutdownId = shutdownSpawn._unsafeUnwrap();
      await manager.shutdown();
      expect(backgroundTaskRepository.findById(shutdownId)._unsafeUnwrap()?.status).toBe(
        'cancelled',
      );
      expect(killCalls.at(-1)).toHaveBeenCalledOnce();
      completionResolvers.at(-1)?.(
        ok({
          stdout: promptSentinel,
          stderr: timeoutError,
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queueManager.enqueue).toHaveBeenCalledTimes(10);
      expect(processStarts).toBe(7);
      expect(bridge.unregisterRunAuthentication).toHaveBeenCalled();
      expect(
        new Set(bridge.unregisterRunAuthentication.mock.calls.map(([runId]: [unknown]) => runId))
          .size,
      ).toBe(7);
      expect(JSON.stringify(faulting.records)).not.toContain(promptSentinel);
      expect(JSON.stringify(faulting.records)).not.toContain(successOutput);
      expect(JSON.stringify(faulting.records)).not.toContain(providerError);
      expect(JSON.stringify(faulting.records)).not.toContain(parseOutput);
      expect(JSON.stringify(faulting.records)).not.toContain(parseStderr);
      expect(JSON.stringify(faulting.records)).not.toContain(parseError);
      expect(JSON.stringify(faulting.records)).not.toContain(timeoutOutput);
      expect(JSON.stringify(faulting.records)).not.toContain(timeoutError);
      expect(JSON.stringify(faulting.records)).not.toContain(exitOutput);
      expect(JSON.stringify(faulting.records)).not.toContain(exitError);
      expect(
        JSON.stringify([
          logger.info.mock.calls,
          logger.warn.mock.calls,
          logger.error.mock.calls,
          logger.debug.mock.calls,
          logger.trace.mock.calls,
          logger.fatal.mock.calls,
        ]),
      ).not.toContain(promptSentinel);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(providerError);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(parseError);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(timeoutError);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(exitError);
    } finally {
      await manager?.shutdown();
      try {
        db?.close();
      } catch {
        // The database may already be closed after a setup failure.
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('derives queue diagnostics from persisted voice, unknown, and nonvoice channels after reopen', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'talon-task39-queue-'));
    const databasePath = join(dataDir, 'talon.sqlite');
    const logger = makeInspectableLogger();
    const voiceError = 'VOICE_QUEUE_ERROR_SENTINEL';
    const unknownError = 'UNKNOWN_QUEUE_ERROR_SENTINEL';
    const nonvoiceError = 'TERMINAL_QUEUE_ERROR_SENTINEL';
    const reopenedUnknownError = 'REOPENED_UNKNOWN_QUEUE_ERROR_SENTINEL';
    const voiceThreadId = 'task39-queue-voice-thread';
    const voiceChannelId = 'task39-queue-voice-channel';
    const personaId = 'task39-queue-persona';
    let db: Database.Database | undefined;

    try {
      db = createTracePrivacyDatabase(databasePath, {
        personaId,
        channelId: voiceChannelId,
        threadId: voiceThreadId,
      });
      const channelRepository = new ChannelRepository(db);
      const threadRepository = new ThreadRepository(db);
      channelRepository
        .insert({
          id: 'task39-queue-terminal-channel',
          type: 'terminal',
          name: 'task39-terminal-channel',
          config: '{}',
          credentials_ref: null,
          enabled: 1,
        })
        ._unsafeUnwrap();
      threadRepository
        .insert({
          id: 'task39-queue-terminal-thread',
          channel_id: 'task39-queue-terminal-channel',
          external_id: 'task39-terminal-chat',
          metadata: '{}',
        })
        ._unsafeUnwrap();
      channelRepository
        .insert({
          id: 'task39-queue-unknown-channel',
          type: 'future-channel-type',
          name: 'task39-unknown-channel',
          config: '{}',
          credentials_ref: null,
          enabled: 1,
        })
        ._unsafeUnwrap();
      threadRepository
        .insert({
          id: 'task39-queue-unknown-thread',
          channel_id: 'task39-queue-unknown-channel',
          external_id: 'task39-unknown-chat',
          metadata: '{}',
        })
        ._unsafeUnwrap();

      const queueRepository = new QueueRepository(db);
      const queueManager = new QueueManager(
        queueRepository,
        threadRepository,
        { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
        logger,
        undefined,
        createQueueDiagnosticResolver(threadRepository, channelRepository),
      );
      queueManager.enqueue(voiceThreadId, 'message', { content: voiceError })._unsafeUnwrap();
      queueManager
        .enqueue('task39-queue-unknown-thread', 'message', { content: unknownError })
        ._unsafeUnwrap();
      queueManager
        .enqueue('task39-queue-terminal-thread', 'message', { content: nonvoiceError })
        ._unsafeUnwrap();

      const errorByThread: Record<string, string> = {
        [voiceThreadId]: voiceError,
        'task39-queue-unknown-thread': unknownError,
        'task39-queue-terminal-thread': nonvoiceError,
      };
      const processedThreads: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const item = await (queueManager as any).processor.processNext(async (claimed: any) => {
          processedThreads.push(claimed.threadId);
          return err(new Error(errorByThread[claimed.threadId]));
        });
        expect(item).toBeDefined();
      }
      expect(processedThreads).toHaveLength(3);

      const firstLogs = JSON.stringify([
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
        logger.debug.mock.calls,
      ]);
      expect(firstLogs).not.toContain(voiceError);
      expect(firstLogs).not.toContain(unknownError);
      expect(firstLogs).toContain(nonvoiceError);
      expect(
        db
          .prepare('SELECT thread_id, status, error FROM queue_items ORDER BY created_at ASC')
          .all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            thread_id: voiceThreadId,
            status: 'dead_letter',
            error: voiceError,
          }),
          expect.objectContaining({
            thread_id: 'task39-queue-unknown-thread',
            status: 'dead_letter',
            error: unknownError,
          }),
          expect.objectContaining({
            thread_id: 'task39-queue-terminal-thread',
            status: 'dead_letter',
            error: nonvoiceError,
          }),
        ]),
      );

      db.close();
      db = createTracePrivacyDatabase(databasePath, {
        personaId,
        channelId: voiceChannelId,
        threadId: voiceThreadId,
      });
      const reopenedChannelRepository = new ChannelRepository(db);
      const reopenedThreadRepository = new ThreadRepository(db);
      const reopenedQueueRepository = new QueueRepository(db);
      const reopenedQueueManager = new QueueManager(
        reopenedQueueRepository,
        reopenedThreadRepository,
        { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
        logger,
        undefined,
        createQueueDiagnosticResolver(reopenedThreadRepository, reopenedChannelRepository),
      );
      reopenedQueueManager
        .enqueue('task39-queue-unknown-thread', 'message', { content: reopenedUnknownError })
        ._unsafeUnwrap();
      await (reopenedQueueManager as any).processor.processNext(async () => {
        return err(new Error(reopenedUnknownError));
      });
      const reopenedRow = db
        .prepare(
          "SELECT status, error FROM queue_items WHERE payload LIKE '%REOPENED_UNKNOWN_QUEUE_ERROR_SENTINEL%'",
        )
        .get() as { status: string; error: string | null };
      expect(reopenedRow).toEqual({ status: 'dead_letter', error: reopenedUnknownError });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(reopenedUnknownError);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(reopenedUnknownError);
    } finally {
      try {
        db?.close();
      } catch {
        // The database may already be closed after the reopen assertion.
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the composed background, bridge, queue, restart, and rotation path private', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'talon-task39-'));
    const databasePath = join(dataDir, 'talon.sqlite');
    const logger = makeInspectableLogger();
    const exporter = new InMemorySpanExporter();
    const observability = new LangfuseObservabilityService(
      {
        enabled: true,
        publicKey: 'pk-task39',
        secretKey: 'sk-task39',
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        exportMode: 'immediate',
        flushAt: 1,
        flushIntervalSeconds: 1,
      },
      pino({ level: 'silent' }),
      { exporter, shouldExportSpan: () => true },
    );
    let db: Database.Database | undefined;
    let bridge: HostToolsBridge | undefined;
    let manager: BackgroundAgentManager | undefined;

    const promptSentinel = 'VOICE_COMPOSED_PROMPT_SENTINEL';
    const toolSentinel = 'VOICE_COMPOSED_TOOL_SENTINEL';
    const nestedSentinel = 'VOICE_COMPOSED_NESTED_SENTINEL';
    const outputSentinel = 'VOICE_COMPOSED_OUTPUT_SENTINEL';
    const stderrSentinel = 'VOICE_COMPOSED_STDERR_SENTINEL';
    const queueErrorSentinel = 'VOICE_COMPOSED_QUEUE_ERROR_SENTINEL';
    const rotationSentinel = 'VOICE_COMPOSED_ROTATION_SENTINEL';
    const personaId = 'task39-persona';
    const channelId = 'task39-channel';
    const threadId = 'task39-thread';

    try {
      db = createTracePrivacyDatabase(databasePath, { personaId, channelId, threadId });
      const channelRepository = new ChannelRepository(db);
      const threadRepository = new ThreadRepository(db);
      const personaRepository = new PersonaRepository(db);
      const messageRepository = new MessageRepository(db);
      const memoryRepository = new MemoryRepository(db);
      const queueRepository = new QueueRepository(db);
      const runRepository = new RunRepository(db);
      const backgroundTaskRepository = new BackgroundTaskRepository(db);
      const bindingRepository = new BindingRepository(db);
      const scheduleRepository = new ScheduleRepository(db);
      const personaConfig = PersonaConfigSchema.parse({
        name: 'task39-persona',
        model: 'fake-model',
        provider: 'agent-fake',
        backgroundProvider: 'background-fake',
        backgroundModel: 'background-model',
        subagents: ['nested-agent'],
        capabilities: {
          allow: ['subagent.background', 'subagent.invoke', 'channel.send:*'],
          requireApproval: [],
        },
      });
      const loadedPersona = {
        config: personaConfig,
        systemPromptContent: 'Task 39 integration persona.',
        resolvedCapabilities: personaConfig.capabilities,
      };
      bindingRepository
        .insert({
          id: 'task39-binding',
          channel_id: channelId,
          thread_id: null,
          persona_id: personaId,
          is_default: 1,
        })
        ._unsafeUnwrap();
      runRepository
        .insert({
          id: 'task39-foreground-run',
          thread_id: threadId,
          persona_id: personaId,
          provider_name: 'agent-fake',
          sandbox_id: null,
          session_id: null,
          status: 'running',
          parent_run_id: null,
          queue_item_id: null,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: 0,
          error: null,
          started_at: Date.now(),
          ended_at: null,
        })
        ._unsafeUnwrap();

      const voiceConnector: ChannelConnector = {
        type: 'voice',
        name: 'task39-voice-channel',
        start: vi.fn(),
        stop: vi.fn(),
        onMessage: vi.fn(),
        send: vi.fn().mockResolvedValue(ok(undefined)),
        format: vi.fn((value: string) => value),
      };
      const channelRegistry = {
        get: vi.fn((name: string) => (name === voiceConnector.name ? voiceConnector : undefined)),
        listAll: vi.fn(() => [voiceConnector]),
      } as unknown as ChannelRegistry;
      const personaLoader = {
        getByName: vi.fn((name: string) =>
          name === personaConfig.name ? ok(loadedPersona) : ok(undefined),
        ),
        listNames: vi.fn(() => [personaConfig.name]),
        listProfiles: vi.fn(() => [{ name: personaConfig.name }]),
      };
      let nestedTelemetry: boolean | undefined;
      const nestedAgent: LoadedSubAgent = {
        manifest: {
          name: 'nested-agent',
          version: '1.0.0',
          description: 'Task 39 nested agent',
          model: { provider: 'fake', name: 'nested-model', maxTokens: 128 },
          requiredCapabilities: [],
          rootPaths: [],
          timeoutMs: 1_000,
          requiresEnv: [],
        },
        promptContents: ['Nested task 39 prompt.'],
        rootDir: dataDir,
        run: async (context) => {
          nestedTelemetry = context.telemetry.isEnabled;
          return ok({ summary: nestedSentinel, data: { value: nestedSentinel } });
        },
      };
      const subagentServices = {
        memory: memoryRepository,
        schedules: scheduleRepository,
        personas: personaRepository,
        channels: channelRepository,
        threads: threadRepository,
        messages: messageRepository,
        runs: runRepository,
        queue: queueRepository,
        logger,
      } as unknown as SubAgentServices;
      const subagentRunner = new SubAgentRunner(
        new Map([['nested-agent', nestedAgent]]),
        { resolve: async () => ok({} as never) } as unknown as ModelResolver,
        subagentServices,
        logger,
        observability,
      );

      const diagnosticResolver = createQueueDiagnosticResolver(threadRepository, channelRepository);
      const queueManager = new QueueManager(
        queueRepository,
        threadRepository,
        { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
        logger,
        undefined,
        diagnosticResolver,
      );

      let resolveBackgroundProcess: ((result: unknown) => void) | undefined;
      const backgroundProcessCompletion = new Promise<unknown>((resolve) => {
        resolveBackgroundProcess = resolve;
      });
      const backgroundProvider = makeBackgroundPrivacyProvider(dataDir, outputSentinel);
      const backgroundProviderEntry = {
        name: 'background-fake',
        type: 'background-fake',
        provider: backgroundProvider,
        config: {
          enabled: true,
          command: 'task39-background-fake',
          contextWindowTokens: 1_000,
          options: { defaultModel: 'background-model' },
        },
      };
      const backgroundProviderRegistry = {
        get: vi.fn(() => backgroundProviderEntry),
        getDefault: vi.fn(() => backgroundProviderEntry),
        listEnabled: vi.fn(() => ['background-fake']),
        hasProvider: vi.fn(() => true),
      };
      manager = new BackgroundAgentManager({
        repository: backgroundTaskRepository,
        queueManager,
        maxConcurrent: 2,
        defaultTimeoutMinutes: 15,
        defaultProvider: 'background-fake',
        providerRegistry: backgroundProviderRegistry,
        logger,
        processFactory: vi.fn(() => ({
          start: vi.fn(() => ok({ pid: null, completion: backgroundProcessCompletion })),
          kill: vi.fn(),
        })) as any,
        hostToolsSocketPath: join(dataDir, 'host-tools.sock'),
        observability,
      });

      const bridgeContext = {
        db,
        config: { storage: { path: databasePath }, channels: [], langfuse: {} },
        configPath: '',
        dataDir,
        repos: {
          queue: queueRepository,
          thread: threadRepository,
          channel: channelRepository,
          persona: personaRepository,
          message: messageRepository,
          binding: bindingRepository,
          run: runRepository,
          backgroundTask: backgroundTaskRepository,
          memory: memoryRepository,
          schedule: scheduleRepository,
          a2aTask: {},
        },
        channelRegistry,
        sessionTracker: { rotateSession: vi.fn() },
        personaLoader,
        skillResolver: { mergePromptFragments: vi.fn(() => '') },
        loadedSkills: [],
        toolInstructions: new Map(),
        contextAssembler: { assemble: vi.fn(() => ({ text: '' })) },
        subAgentRunner: subagentRunner,
        backgroundAgentManager: manager,
        backgroundProviderRegistry,
        observability,
        logger,
        oauthTokenStore: {},
      } as unknown as DaemonContext;
      bridge = new HostToolsBridge(bridgeContext);
      manager.setHostToolsBridge(bridge);

      const voiceObservation = createVoiceObservationContext({
        callId: 'task39-call',
        delegationId: 'task39-delegation',
        queueItemId: 'task39-foreground-queue',
        runId: 'task39-foreground-run',
        threadId,
        personaId,
        provider: 'agent-fake',
        model: 'fake-model',
      });
      bridge.registerRunAuthentication({
        runId: 'task39-foreground-run',
        threadId,
        personaId,
        bridgeSecret: 'task39-foreground-secret',
        voiceObservation,
      });

      const spawnResponse = await invokeTracePrivacyBridge(bridge, {
        id: 'task39-parent-spawn',
        tool: 'background_agent',
        bridgeSecret: 'task39-foreground-secret',
        args: { action: 'spawn', prompt: promptSentinel },
        context: {
          runId: 'task39-foreground-run',
          threadId,
          personaId,
          requestId: 'task39-parent-request',
        },
      });
      expect(spawnResponse.result?.status).toBe('success');
      const taskId = (spawnResponse.result?.result as { taskId: string }).taskId;
      const childRegistration = (bridge as any).bridgeAuthByRunId.get(taskId) as {
        bridgeSecret: string;
      };

      const forgedResponse = await invokeTracePrivacyBridge(bridge, {
        id: 'task39-forged-downgrade',
        tool: 'subagent_invoke',
        bridgeSecret: childRegistration.bridgeSecret,
        args: { name: 'nested-agent', input: { value: toolSentinel } },
        context: {
          runId: taskId,
          threadId,
          personaId,
          requestId: 'task39-forged-request',
          backgroundTaskId: taskId,
          voiceObservation: { privacy: 'nonvoice' },
        },
      });
      expect(forgedResponse.error).toBe('Voice observation context is server-owned');

      const rejectedName = 'regex-safe-rejected-subagent-name';
      const rejectedResponse = await invokeTracePrivacyBridge(bridge, {
        id: 'task39-rejected-name',
        tool: 'subagent_invoke',
        bridgeSecret: childRegistration.bridgeSecret,
        args: { name: rejectedName, input: { value: toolSentinel } },
        context: {
          runId: taskId,
          threadId,
          personaId,
          requestId: 'task39-rejected-name-request',
          backgroundTaskId: taskId,
        },
      });
      expect(JSON.stringify(rejectedResponse)).not.toContain(rejectedName);

      const nestedResponse = await invokeTracePrivacyBridge(bridge, {
        id: 'task39-child-subagent',
        tool: 'subagent_invoke',
        bridgeSecret: childRegistration.bridgeSecret,
        args: { name: 'nested-agent', input: { value: toolSentinel } },
        context: {
          runId: taskId,
          threadId,
          personaId,
          requestId: 'task39-child-request',
          backgroundTaskId: taskId,
        },
      });
      expect(nestedResponse.result?.status).toBe('success');
      expect(nestedResponse.result?.result).toEqual(
        expect.objectContaining({ summary: nestedSentinel }),
      );
      expect(nestedTelemetry).toBe(false);

      const sendResponse = await invokeTracePrivacyBridge(bridge, {
        id: 'task39-child-send',
        tool: 'channel_send',
        bridgeSecret: childRegistration.bridgeSecret,
        args: { channelId: voiceConnector.name, content: toolSentinel },
        context: {
          runId: taskId,
          threadId,
          personaId,
          requestId: 'task39-child-send-request',
          backgroundTaskId: taskId,
        },
      });
      expect(sendResponse.result?.status).toBe('success');
      expect(voiceConnector.send).toHaveBeenCalledWith(
        'task39-external-chat',
        expect.objectContaining({ body: toolSentinel }),
      );

      resolveBackgroundProcess?.(
        ok({
          stdout: outputSentinel,
          stderr: stderrSentinel,
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
      );
      await waitForTracePrivacyCondition(() => {
        const task = backgroundTaskRepository.findById(taskId)._unsafeUnwrap();
        return (
          task?.status === 'completed' && queueRepository.findPending()._unsafeUnwrap().length === 2
        );
      });
      expect((bridge as any).bridgeAuthByRunId.has(taskId)).toBe(false);
      const taskAfterCompletion = backgroundTaskRepository.findById(taskId)._unsafeUnwrap();
      expect(taskAfterCompletion?.output).toContain(outputSentinel);

      const spansAfterBackground = JSON.stringify(
        exporter.getFinishedSpans().map((span) => ({
          name: span.name,
          attributes: span.attributes,
          events: span.events,
          status: span.status,
        })),
      );
      expect(spansAfterBackground).not.toContain(promptSentinel);
      expect(spansAfterBackground).not.toContain(toolSentinel);
      expect(spansAfterBackground).not.toContain(nestedSentinel);
      expect(spansAfterBackground).not.toContain(outputSentinel);
      expect(spansAfterBackground).not.toContain(stderrSentinel);
      expect(
        JSON.stringify([
          logger.info.mock.calls,
          logger.warn.mock.calls,
          logger.error.mock.calls,
          logger.debug.mock.calls,
          logger.trace.mock.calls,
          logger.fatal.mock.calls,
        ]),
      ).not.toContain(promptSentinel);

      bridge.stop();
      bridge = undefined;
      db.close();
      db = createTracePrivacyDatabase(databasePath, { personaId, channelId, threadId });
      const reopenedChannelRepository = new ChannelRepository(db);
      const reopenedThreadRepository = new ThreadRepository(db);
      const reopenedPersonaRepository = new PersonaRepository(db);
      const reopenedMessageRepository = new MessageRepository(db);
      const reopenedMemoryRepository = new MemoryRepository(db);
      const reopenedQueueRepository = new QueueRepository(db);
      const reopenedRunRepository = new RunRepository(db);
      const reopenedResolver = createQueueDiagnosticResolver(
        reopenedThreadRepository,
        reopenedChannelRepository,
      );
      const reopenedQueueManager = new QueueManager(
        reopenedQueueRepository,
        reopenedThreadRepository,
        { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
        logger,
        undefined,
        reopenedResolver,
      );
      const processedTypes: string[] = [];
      const processOne = async () =>
        (reopenedQueueManager as any).processor.processNext(async (item: any) => {
          processedTypes.push(item.type);
          return item.type === 'message' ? err(new Error(queueErrorSentinel)) : ok(undefined);
        });
      await processOne();
      await processOne();
      expect(processedTypes).toEqual(['collaboration', 'message']);
      const persistedRows = db
        .prepare('SELECT * FROM queue_items WHERE thread_id = ? ORDER BY created_at ASC')
        .all(threadId) as Array<{ status: string; error: string | null }>;
      expect(persistedRows).toHaveLength(2);
      expect(persistedRows.map((row) => row.status)).toEqual(
        expect.arrayContaining(['completed', 'dead_letter']),
      );
      expect(persistedRows.find((row) => row.status === 'dead_letter')?.error).toBe(
        queueErrorSentinel,
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(queueErrorSentinel);

      const rotationMessages = reopenedMessageRepository;
      rotationMessages
        .insert({
          id: 'task39-rotation-inbound',
          thread_id: threadId,
          direction: 'inbound',
          content: JSON.stringify({ body: rotationSentinel }),
          idempotency_key: 'task39-rotation-inbound',
          provider_id: null,
          run_id: null,
        })
        ._unsafeUnwrap();
      const rotationProvider = makeAgentRunnerPrivacyProvider(rotationSentinel);
      const rotationConfig = AgentRunnerProviderConfigSchema.parse({
        enabled: true,
        type: 'agent-fake',
        command: 'task39-agent-fake',
        contextWindowTokens: 1_000,
        contextManagement: {
          enabled: true,
          triggerMetric: 'input_tokens',
          thresholdRatio: 0.001,
          recentMessageCount: 10,
          summarizer: 'session-summarizer',
        },
      });
      const rotationRegistry = new ProviderRegistry(
        { 'agent-fake': rotationConfig },
        { 'agent-fake': () => rotationProvider },
      );
      const rotationTracker = {
        getSessionId: vi.fn(() => undefined),
        setSessionId: vi.fn(),
        clearSession: vi.fn(),
        wasRotated: vi.fn(() => false),
        rotateSession: vi.fn(),
      };
      const roller = new ContextRoller({
        messageRepo: reopenedMessageRepository,
        threadRepo: reopenedThreadRepository,
        memoryRepo: reopenedMemoryRepository,
        sessionTracker: rotationTracker,
        summarizerRun: async () =>
          ok({
            summary: rotationSentinel,
            data: { summary: rotationSentinel, keyFacts: [], openThreads: [] },
          }),
        logger,
      });
      const agentQueueItem = reopenedQueueManager
        .enqueue(threadId, 'message', { personaId, content: rotationSentinel })
        ._unsafeUnwrap();
      const claimed = reopenedQueueRepository.claimNext(threadId)._unsafeUnwrap();
      expect(claimed?.id).toBe(agentQueueItem.id);
      const agentContext = makeTracePrivacyAgentContext({
        db,
        dataDir,
        queueManager: reopenedQueueManager,
        providerRegistry: rotationRegistry,
        providerConfig: rotationConfig,
        personaLoader,
        channelRegistry,
        repos: {
          queue: reopenedQueueRepository,
          thread: reopenedThreadRepository,
          channel: reopenedChannelRepository,
          persona: reopenedPersonaRepository,
          message: reopenedMessageRepository,
          memory: reopenedMemoryRepository,
          run: reopenedRunRepository,
        },
        sessionTracker: rotationTracker,
        contextRoller: roller,
        hostToolsBridge: {
          registerRunAuthentication: vi.fn(),
          unregisterRunAuthentication: vi.fn(),
          path: join(dataDir, 'host-tools.sock'),
        },
        observability,
        logger,
      });
      const agentResult = await new AgentRunner(agentContext).run(rowToQueueItem(claimed!));
      expect(agentResult.isOk()).toBe(true);
      expect(rotationProvider.executionCount).toBe(1);
      expect(rotationTracker.rotateSession).toHaveBeenCalledWith(threadId);
      const storedRotation = reopenedMemoryRepository
        .findByThread(threadId)
        ._unsafeUnwrap()
        .map((item) => item.content)
        .join('\n');
      expect(storedRotation).toContain(rotationSentinel);
      const finalSpans = JSON.stringify(
        exporter.getFinishedSpans().map((span) => ({
          name: span.name,
          attributes: span.attributes,
          events: span.events,
          status: span.status,
        })),
      );
      expect(finalSpans).not.toContain(rotationSentinel);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(rotationSentinel);
    } finally {
      await manager?.shutdown();
      bridge?.stop();
      try {
        db?.close();
      } catch {
        // The database may already have been closed before a reopen failure.
      }
      await observability.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function makeFaultingObservability(options: {
  startError?: string;
  updateError?: string;
  exportError?: string;
}): { service: ObservabilityService; records: unknown[] } {
  const records: unknown[] = [];
  const handle: StartedObservationHandle = {
    update: vi.fn(() => {
      if (options.updateError) throw new Error(options.updateError);
    }),
    getTraceparent: vi.fn(() => null),
    end: vi.fn(() => {
      if (options.exportError) throw new Error(options.exportError);
    }),
  };
  const observe = async (
    input: ObservationInput,
    callback: (observation: ObservationHandle) => Promise<unknown> | unknown,
  ): Promise<unknown> => {
    records.push(input);
    await callback(handle);
    if (options.exportError) throw new Error(options.exportError);
    return undefined;
  };
  const start = vi.fn((input: ObservationInput) => {
    records.push(input);
    if (options.startError) throw new Error(options.startError);
    return handle;
  });
  const startWithTraceparent = vi.fn(
    (_traceparent: string | null | undefined, input: ObservationInput) => {
      records.push(input);
      if (options.startError) throw new Error(options.startError);
      return handle;
    },
  );
  return {
    records,
    service: {
      start,
      startWithTraceparent,
      observe,
      observeWithTraceparent: async (
        _traceparent: string | null | undefined,
        input: ObservationInput,
        callback: (observation: ObservationHandle) => Promise<unknown> | unknown,
      ) => await observe(input, callback),
      shutdown: async () => {},
    },
  };
}

function makeThrowingLogger(): any {
  const throwFailure = (): never => {
    throw new Error('VOICE_LOGGER_FAILURE_SENTINEL');
  };
  return {
    info: throwFailure,
    warn: throwFailure,
    error: throwFailure,
    debug: throwFailure,
    trace: throwFailure,
    fatal: throwFailure,
    child: vi.fn(),
  };
}

function makeInspectableLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeConnector(
  sendResult: ReturnType<typeof ok> | ReturnType<typeof err>,
): ChannelConnector {
  return {
    type: 'voice',
    name: 'VOICE_CALLER_CHANNEL_SENTINEL',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(sendResult),
    format: vi.fn((value: string) => value),
  };
}

function makeThreadRepository(overrides: Record<string, unknown> = {}): ThreadRepository {
  return {
    findById: vi.fn().mockReturnValue(
      ok({
        id: 'trusted-thread',
        channel_id: 'trusted-channel',
        external_id: 'trusted-external-id',
        metadata: '{}',
        created_at: 0,
        updated_at: 0,
      }),
    ),
    findByExternalId: vi.fn().mockReturnValue(null),
    findByChannelId: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    ...overrides,
  } as unknown as ThreadRepository;
}

function makeChannelSendHandler(options: {
  connector: ChannelConnector;
  logger: any;
  channelRepository?: { findByName: ReturnType<typeof vi.fn> };
  messageRepository?: { insert: ReturnType<typeof vi.fn> };
  threadRepository?: ThreadRepository;
}): ChannelSendHandler {
  const registry = {
    get: vi.fn().mockReturnValue(options.connector),
  } as unknown as ChannelRegistry;
  return new ChannelSendHandler({
    channelRegistry: registry,
    threadRepository: options.threadRepository ?? makeThreadRepository(),
    ...(options.channelRepository ? { channelRepository: options.channelRepository as any } : {}),
    ...(options.messageRepository ? { messageRepository: options.messageRepository as any } : {}),
    logger: options.logger,
  });
}

function createTracePrivacyDatabase(
  databasePath: string,
  ids: { personaId: string; channelId: string; threadId: string },
): Database.Database {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  const migrated = runMigrations(
    db,
    join(import.meta.dirname, '../../../src/core/database/migrations'),
  );
  if (migrated.isErr()) throw new Error(migrated.error.message);

  const channels = new ChannelRepository(db);
  if (channels.findById(ids.channelId)._unsafeUnwrap() === null) {
    channels
      .insert({
        id: ids.channelId,
        type: 'voice',
        name: 'task39-voice-channel',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
  }
  const personas = new PersonaRepository(db);
  if (personas.findById(ids.personaId)._unsafeUnwrap() === null) {
    personas
      .insert({
        id: ids.personaId,
        name: 'task39-persona',
        model: 'fake-model',
        system_prompt_file: null,
        skills: '[]',
        capabilities: JSON.stringify({
          allow: ['subagent.background', 'subagent.invoke', 'channel.send:*'],
          requireApproval: [],
        }),
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
  }
  const threads = new ThreadRepository(db);
  if (threads.findById(ids.threadId)._unsafeUnwrap() === null) {
    threads
      .insert({
        id: ids.threadId,
        channel_id: ids.channelId,
        external_id: 'task39-external-chat',
        metadata: '{}',
      })
      ._unsafeUnwrap();
  }
  return db;
}

async function invokeTracePrivacyBridge(
  bridge: HostToolsBridge,
  request: Record<string, unknown>,
): Promise<Record<string, any>> {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
  };
  await (
    bridge as unknown as {
      handleRequest: (line: string, socket: unknown) => Promise<void>;
    }
  ).handleRequest(JSON.stringify(request), socket);
  const response = writes.at(-1);
  if (!response) throw new Error('host-tools bridge produced no response');
  return JSON.parse(response) as Record<string, any>;
}

async function waitForTracePrivacyCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for composed trace privacy state');
}

function makeBackgroundPrivacyProvider(dataDir: string, output: string): AgentProvider {
  return {
    name: 'background-fake',
    skillLoaderTransport: 'stdio',
    createExecutionStrategy: () => ({
      type: 'cli',
      supportsSessionResumption: false,
      run: async (): Promise<AgentRunResult> => ({
        output,
        usage: { inputTokens: 1, outputTokens: 1 },
        isError: false,
        sessionId: undefined,
      }),
    }),
    prepareBackgroundInvocation: () =>
      ok({
        command: 'task39-background-fake',
        args: [],
        stdin: 'task39-background-stdin',
        cwd: dataDir,
        timeoutMs: 15 * 60 * 1000,
        cleanupPaths: [],
      }),
    parseBackgroundResult: (raw) => ({
      output: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
    }),
    estimateContextUsage: (usage) => ({
      inputTokens: usage.inputTokens,
      metrics: { input_tokens: usage.inputTokens },
    }),
  };
}

function makeAgentRunnerPrivacyProvider(
  output: string,
): AgentProvider & { executionCount: number } {
  const provider = {
    name: 'agent-fake',
    skillLoaderTransport: 'stdio' as const,
    executionCount: 0,
    createExecutionStrategy: () => ({
      type: 'cli' as const,
      supportsSessionResumption: false as const,
      run: async (): Promise<AgentRunResult> => {
        provider.executionCount += 1;
        return {
          output,
          usage: { inputTokens: 10, outputTokens: 1 },
          lastStepUsage: { inputTokens: 10, outputTokens: 1 },
          isError: false,
        };
      },
    }),
    prepareBackgroundInvocation: () =>
      ok({
        command: 'task39-agent-fake',
        args: [],
        stdin: '',
        cwd: process.cwd(),
        timeoutMs: 1_000,
        cleanupPaths: [],
      }),
    parseBackgroundResult: (raw: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    }) => ({
      output: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
    }),
    estimateContextUsage: (usage: { inputTokens: number }) => ({
      inputTokens: usage.inputTokens,
      metrics: { input_tokens: usage.inputTokens },
    }),
  } as unknown as AgentProvider & { executionCount: number };
  return provider;
}

function makeTracePrivacyAgentContext(options: {
  db: Database.Database;
  dataDir: string;
  queueManager: QueueManager;
  providerRegistry: ProviderRegistry;
  providerConfig: unknown;
  personaLoader: unknown;
  channelRegistry: ChannelRegistry;
  repos: {
    queue: QueueRepository;
    thread: ThreadRepository;
    channel: ChannelRepository;
    persona: PersonaRepository;
    message: MessageRepository;
    memory: MemoryRepository;
    run: RunRepository;
  };
  sessionTracker: unknown;
  contextRoller: ContextRoller;
  hostToolsBridge: unknown;
  observability: LangfuseObservabilityService;
  logger: any;
}): DaemonContext {
  return {
    db: options.db,
    config: {
      dataDir: options.dataDir,
      channels: [],
      agentRunner: {
        defaultProvider: 'agent-fake',
        providers: { 'agent-fake': options.providerConfig },
      },
      langfuse: {},
    },
    configPath: '',
    dataDir: options.dataDir,
    repos: {
      queue: options.repos.queue,
      thread: options.repos.thread,
      channel: options.repos.channel,
      persona: options.repos.persona,
      message: options.repos.message,
      memory: options.repos.memory,
      run: options.repos.run,
      binding: {},
      a2aTask: {},
      schedule: {},
    },
    channelRegistry: options.channelRegistry,
    queueManager: options.queueManager,
    scheduler: {},
    personaLoader: options.personaLoader,
    sessionTracker: options.sessionTracker,
    contextRoller: options.contextRoller,
    contextAssembler: {
      assemble: () => ({ text: '', summaryFound: false, recentMessageCount: 0, charCount: 0 }),
    },
    threadWorkspace: { ensureDirectories: () => ok(options.dataDir) },
    auditLogger: {},
    skillResolver: { mergePromptFragments: () => '' },
    loadedSkills: [],
    toolInstructions: new Map(),
    messagePipeline: {},
    observability: options.observability,
    hostToolsBridge: options.hostToolsBridge,
    oauthTokenStore: {},
    providerRegistry: options.providerRegistry,
    backgroundProviderRegistry: {},
    subAgentRunner: null,
    backgroundAgentManager: null,
    executionEnvManager: null,
    a2aTaskMapper: null,
    voiceStore: null,
    voicePolicy: null,
    voiceAuth: null,
    voiceBackendBridge: null,
    voiceOutputSink: null,
    voiceSessionService: null,
    voiceProvider: null,
    voiceTransport: null,
    voiceServer: null,
    logger: options.logger,
  } as unknown as DaemonContext;
}
