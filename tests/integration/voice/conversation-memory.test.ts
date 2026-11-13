import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok } from 'neverthrow';

import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import { ContextAssembler } from '../../../src/daemon/context-assembler.js';
import {
  AgentRunnerProviderConfigSchema,
  PersonaConfigSchema,
} from '../../../src/core/config/config-schema.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { QueueManager } from '../../../src/queue/queue-manager.js';
import type {
  AgentProvider,
  AgentRunInput,
  AgentStreamEvent,
} from '../../../src/providers/provider.js';
import type {
  AgentUsage,
  PreparedProviderInvocation,
  PreparedProviderResultFiles,
  ProviderResult,
  ProviderSpawnInput,
} from '../../../src/providers/provider-types.js';
import { ProviderRegistry } from '../../../src/providers/provider-registry.js';
import { DurableVoiceBackendBridge } from '../../../src/voice/voice-backend-bridge.js';
import { VoiceOutputSink } from '../../../src/voice/voice-output-sink.js';
import { VoicePolicy } from '../../../src/voice/voice-policy.js';
import { createVoiceAdapterSelection } from '../../../src/voice/voice-adapters.js';
import {
  BrowserVoiceTransport,
  DurableVoiceSessionService,
} from '../../../src/voice/voice-session-service.js';
import { DurableVoiceStore } from '../../../src/voice/voice-store.js';
import { voiceTranscriptIdempotencyKey } from '../../../src/voice/voice-types.js';
import type {
  LiveVoiceEvent,
  LiveVoiceProvider,
  LiveVoiceSession,
  LiveVoiceSideband,
  VoiceAsyncResult,
  VoiceClientSessionDescriptor,
  VoiceContextSnapshot,
  VoiceEventHandler,
  VoiceOwnerContext,
  VoiceTransport,
  VoiceUnsubscribe,
} from '../../../src/voice/voice-types.js';

const CHANNEL_ID = 'conversation-memory-channel';
const PERSONA_ID = 'conversation-memory-persona';
const PROVIDER_NAME = 'conversation-memory-provider';
const MODEL_NAME = 'conversation-memory-model';
const TEST_VOICE_CAPABILITIES = {
  audio_streaming: 'supported',
  interruptions: 'supported',
  delegation: 'supported',
  transcript_stability: 'supported',
  usage_reporting: 'supported',
} as const;

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('timed out waiting for conversation-memory composition'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function context(version: number, digest: string, text: string): VoiceContextSnapshot {
  return {
    version,
    digest,
    capturedAt: version,
    text,
    fragments: [],
    truncated: false,
  };
}

class FakeSideband implements LiveVoiceSideband {
  readonly commands: string[] = [];
  private handler: VoiceEventHandler<LiveVoiceEvent> | undefined;
  private readonly contexts = new Map<string, VoiceContextSnapshot>();

  constructor(readonly providerSessionId: string) {}

  contextForDelegation(providerDelegationId: string): VoiceContextSnapshot | null {
    return this.contexts.get(providerDelegationId) ?? null;
  }

  setContext(providerDelegationId: string, value: VoiceContextSnapshot): void {
    this.contexts.set(providerDelegationId, value);
  }

  send(
    command: import('../../../src/voice/voice-types.js').LiveVoiceCommand,
  ): VoiceAsyncResult<void> {
    this.commands.push(command.content);
    return Promise.resolve(ok(undefined));
  }

  onEvent(handler: VoiceEventHandler<LiveVoiceEvent>): VoiceUnsubscribe {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  close(_graceful: boolean): VoiceAsyncResult<void> {
    return Promise.resolve(ok(undefined));
  }

  emit(event: LiveVoiceEvent): void {
    void this.handler?.(event);
  }
}

class FakeLiveProvider implements LiveVoiceProvider {
  readonly name = 'conversation-memory-live';
  readonly capabilities = TEST_VOICE_CAPABILITIES;
  readonly sidebands = new Map<string, FakeSideband>();
  readonly createInstructions: string[] = [];
  readonly backendInputs: AgentRunInput[] = [];
  private sequence = 0;

  createSession(input: import('../../../src/voice/voice-types.js').LiveVoiceSessionRequest) {
    const providerSessionId = `conversation-provider-${++this.sequence}`;
    const sideband = new FakeSideband(providerSessionId);
    this.sidebands.set(providerSessionId, sideband);
    this.createInstructions.push(input.instructions);
    const client: VoiceClientSessionDescriptor = {
      transport: input.transport.type,
      sessionId: input.sessionId,
      providerSessionId,
      answer: { type: input.transport.type, sdp: 'answer' },
      expiresAt: Date.now() + 60_000,
    };
    const session: LiveVoiceSession = { providerSessionId, client };
    return Promise.resolve(ok(session));
  }

  attachSideband(session: LiveVoiceSession): VoiceAsyncResult<LiveVoiceSideband> {
    const sideband = this.sidebands.get(session.providerSessionId);
    return Promise.resolve(sideband ? ok(sideband) : err(new Error('fake sideband missing')));
  }

  closeSession(_providerSessionId: string): VoiceAsyncResult<void> {
    return Promise.resolve(ok(undefined));
  }
}

class FakeAgentProvider implements AgentProvider {
  readonly name = PROVIDER_NAME;
  readonly skillLoaderTransport = 'stdio' as const;

  constructor(private readonly liveProvider: FakeLiveProvider) {}

  createExecutionStrategy() {
    return {
      type: 'sdk' as const,
      supportsSessionResumption: false as const,
      run: async function* (input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
        this.liveProvider.backendInputs.push(input);
        yield { type: 'text' as const, content: 'Backend result.' };
        yield {
          type: 'result' as const,
          result: {
            output: 'Backend result.',
            usage: { inputTokens: 1, outputTokens: 1 } satisfies AgentUsage,
            isError: false,
          },
        };
      }.bind(this),
    };
  }

  prepareBackgroundInvocation(_input: ProviderSpawnInput) {
    const invocation: PreparedProviderInvocation = {
      command: 'conversation-memory-provider',
      args: [],
      stdin: '',
      cwd: process.cwd(),
      timeoutMs: 1_000,
      cleanupPaths: [],
    };
    return ok(invocation);
  }

  parseBackgroundResult(
    _raw: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean },
    _resultFiles?: PreparedProviderResultFiles,
  ): ProviderResult {
    return { output: '', exitCode: 0, timedOut: false, stderr: '' };
  }

  estimateContextUsage(usage: AgentUsage) {
    return { inputTokens: usage.inputTokens, metrics: { input_tokens: usage.inputTokens } };
  }
}

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrated = runMigrations(
    db,
    join(import.meta.dirname, '../../../src/core/database/migrations'),
  );
  if (migrated.isErr()) throw new Error(migrated.error.message);
  new ChannelRepository(db).insert({
    id: CHANNEL_ID,
    type: 'voice',
    name: 'conversation-memory-voice',
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });
  new PersonaRepository(db).insert({
    id: PERSONA_ID,
    name: 'conversation-memory-persona',
    model: MODEL_NAME,
    system_prompt_file: null,
    skills: '[]',
    capabilities: '{"allow":[],"requireApproval":[]}',
    mounts: '[]',
    max_concurrent: null,
  });
  return db;
}

function createDaemonContext(
  db: Database.Database,
  queueManager: QueueManager,
  liveProvider: FakeLiveProvider,
  bridge: DurableVoiceBackendBridge,
  sink: VoiceOutputSink,
): DaemonContext {
  const queue = new QueueRepository(db);
  const thread = new ThreadRepository(db);
  const channel = new ChannelRepository(db);
  const persona = new PersonaRepository(db);
  const message = new MessageRepository(db);
  const memory = new MemoryRepository(db);
  const run = new RunRepository(db);
  const providerConfig = AgentRunnerProviderConfigSchema.parse({
    enabled: true,
    type: 'openai-compatible',
    command: 'conversation-memory-provider',
    contextWindowTokens: 2_000,
    contextManagement: { enabled: false },
  });
  const personaConfig = PersonaConfigSchema.parse({
    name: 'conversation-memory-persona',
    model: MODEL_NAME,
    provider: PROVIDER_NAME,
    capabilities: { allow: [], requireApproval: [] },
  });
  const observation = {
    update: (): void => undefined,
    getTraceparent: (): string | null => null,
  };
  const providerRegistry = new ProviderRegistry(
    { [PROVIDER_NAME]: providerConfig },
    { 'openai-compatible': () => new FakeAgentProvider(liveProvider) },
  );
  return {
    db,
    config: {
      dataDir: '/tmp/conversation-memory',
      channels: [],
      agentRunner: {
        defaultProvider: PROVIDER_NAME,
        providers: { [PROVIDER_NAME]: providerConfig },
      },
      langfuse: { owner: undefined },
    },
    configPath: '',
    dataDir: '/tmp/conversation-memory',
    repos: {
      queue,
      thread,
      channel,
      persona,
      run,
      message,
      memory,
      backgroundTask: {},
      executionEnv: {},
      executionEnvCheckpoint: {},
      schedule: {},
      audit: {},
      binding: {},
      a2aTask: {},
    },
    channelRegistry: { listAll: () => [], get: () => undefined },
    queueManager,
    scheduler: {},
    personaLoader: {
      getByName: (name: string) =>
        name === personaConfig.name
          ? ok({
              config: personaConfig,
              systemPromptContent: 'Answer the admitted voice request.',
              resolvedCapabilities: { allow: [], requireApproval: [] },
            })
          : ok(undefined),
    },
    sessionTracker: {
      wasRotated: () => false,
      setSessionId: () => undefined,
      getSessionId: () => undefined,
      clearSession: () => undefined,
      rotateSession: () => undefined,
    },
    threadWorkspace: { ensureDirectories: () => ok('/tmp/conversation-memory') },
    auditLogger: {},
    skillResolver: { mergePromptFragments: () => '' },
    loadedSkills: [],
    messagePipeline: {},
    observability: {
      observe: async <T>(
        _input: unknown,
        callback: (handle: typeof observation) => T | Promise<T>,
      ) => callback(observation),
      start: () => ({ ...observation, end: () => undefined }),
      startWithTraceparent: () => ({ ...observation, end: () => undefined }),
      observeWithTraceparent: async <T>(
        _trace: unknown,
        _input: unknown,
        callback: (handle: typeof observation) => T | Promise<T>,
      ) => callback(observation),
      shutdown: async () => undefined,
    },
    hostToolsBridge: {
      path: '/tmp/conversation-memory/host-tools.sock',
      registerRunAuthentication: () => undefined,
      unregisterRunAuthentication: () => undefined,
    },
    oauthTokenStore: {},
    providerRegistry,
    backgroundProviderRegistry: {},
    subAgentRunner: null,
    backgroundAgentManager: null,
    executionEnvManager: null,
    contextRoller: null,
    contextAssembler: new ContextAssembler({ messageRepo: message, memoryRepo: memory }),
    logger: pino({ level: 'silent' }),
    toolInstructions: new Map(),
    a2aServer: null,
    a2aTaskMapper: null,
    voiceStore: null,
    voicePolicy: null,
    voiceAuth: null,
    voiceBackendBridge: bridge,
    voiceOutputSink: sink,
    voiceSessionService: null,
    voiceProvider: null,
    voiceTransport: null,
    voiceServer: null,
  } as unknown as DaemonContext;
}

describe('voice conversation memory integration', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('carries conversation history through live, backend, and durable output recovery', async () => {
    db = createDatabase();
    const queueRepository = new QueueRepository(db);
    const threadRepository = new ThreadRepository(db);
    const messageRepository = new MessageRepository(db);
    const store = new DurableVoiceStore(db, queueRepository);
    const liveProvider = new FakeLiveProvider();
    const policy = new VoicePolicy({
      providerTypes: new Map([[PROVIDER_NAME, 'openai-compatible']]),
    });
    const owner: VoiceOwnerContext = { ownerId: 'conversation-owner', loginRevision: 1 };
    const capturePolicy = (candidate: VoiceOwnerContext) =>
      policy.capture({
        generation: 1,
        ownerId: candidate.ownerId,
        personaId: PERSONA_ID,
        providerName: PROVIDER_NAME,
        modelName: MODEL_NAME,
        voiceName: 'marin',
        capabilityNames: [],
        allowedToolNames: [],
        allowedMcpServerNames: [],
        nativeToolNames: [],
        requireApproval: false,
        loginRevision: candidate.loginRevision,
      });
    const bridge = new DurableVoiceBackendBridge(store, queueRepository, {
      executionGate: () => ok(undefined),
      now: () => 20,
    });
    const transport = new BrowserVoiceTransport({ now: () => 20 });
    const adapterSelection = createVoiceAdapterSelection({
      transport,
      engine: liveProvider,
    });
    if (adapterSelection.isErr()) throw adapterSelection.error;
    const serviceOptions = {
      store,
      provider: liveProvider,
      transport,
      adapterSelection: adapterSelection.value,
      backendBridge: bridge,
      policy,
      threadRepository,
      messageRepository,
      channelId: CHANNEL_ID,
      personaId: PERSONA_ID,
      providerName: PROVIDER_NAME,
      modelName: MODEL_NAME,
      instructions: 'Base voice instructions.',
      voiceName: 'marin',
      capturePolicy,
      currentPolicy: capturePolicy,
    };
    const service = new DurableVoiceSessionService(serviceOptions);
    const sink = new VoiceOutputSink(store, (result) => bridge.notifyResult(result));
    const queueManager = new QueueManager(
      queueRepository,
      threadRepository,
      { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
      pino({ level: 'silent' }),
      bridge.claimQueueItem.bind(bridge),
    );

    const first = await service.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(first.isOk()).toBe(true);
    const firstSession = first._unsafeUnwrap().session;
    const firstSideband = liveProvider.sidebands.get(
      first._unsafeUnwrap().client.providerSessionId,
    );
    expect(firstSideband).toBeDefined();
    firstSideband!.emit({
      kind: 'transcript',
      eventId: 'fact-event',
      sequence: 1,
      fragment: {
        id: 'fact-fragment',
        role: 'user',
        kind: 'completed',
        sequence: 1,
        text: 'My cat is called Nori.',
        receivedAt: 30,
      },
    });
    await waitFor(
      () =>
        messageRepository.findLatestByThread(firstSession.threadId, 10)._unsafeUnwrap().length ===
        1,
    );
    expect((await service.closeSession(owner, firstSession.id, { reason: 'hangup' })).isOk()).toBe(
      true,
    );

    const second = await service.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(second.isOk()).toBe(true);
    const secondSession = second._unsafeUnwrap().session;
    expect(secondSession.threadId).toBe(firstSession.threadId);
    expect(liveProvider.createInstructions.at(-1)).toContain('My cat is called Nori.');

    const secondSideband = liveProvider.sidebands.get(
      second._unsafeUnwrap().client.providerSessionId,
    );
    expect(secondSideband).toBeDefined();
    secondSideband!.setContext(
      'current-delegation',
      context(1, 'current-digest', 'Current request only.'),
    );
    secondSideband!.emit({
      kind: 'transcript',
      eventId: 'current-transcript-event',
      sequence: 2,
      fragment: {
        id: 'current-fragment',
        role: 'user',
        kind: 'completed',
        sequence: 2,
        text: 'Current request only.',
        receivedAt: 31,
      },
    });
    await waitFor(
      () =>
        messageRepository.findLatestByThread(secondSession.threadId, 10)._unsafeUnwrap().length ===
        2,
    );
    for (let index = 0; index < 199; index += 1) {
      const fragmentId = `current-history-${index}`;
      const persisted = messageRepository.upsertVoiceTranscript({
        id: fragmentId,
        thread_id: secondSession.threadId,
        direction: 'inbound',
        content: JSON.stringify({
          body: `Current history row ${index}.`,
          voice: {
            kind: 'transcript',
            sessionId: secondSession.id,
            fragmentId,
            role: 'user',
            state: 'completed',
            sequence: index + 3,
          },
        }),
        idempotency_key: voiceTranscriptIdempotencyKey(secondSession.id, 'user', fragmentId),
        provider_id: fragmentId,
        run_id: null,
      });
      expect(persisted.isOk()).toBe(true);
    }
    await waitFor(
      () =>
        messageRepository.findLatestByThread(secondSession.threadId, 300)._unsafeUnwrap().length ===
        201,
    );

    const runnerContext = createDaemonContext(db, queueManager, liveProvider, bridge, sink);
    const runner = new AgentRunner(runnerContext, {
      voiceOutputSink: sink,
      voiceExecutionGate: bridge.beforeProvider.bind(bridge),
    });
    queueManager.startProcessing((item) => runner.run(item));
    secondSideband!.emit({
      kind: 'delegation',
      eventId: 'current-delegation-event',
      sequence: 3,
      proposal: {
        providerDelegationId: 'current-delegation',
        offsetMs: 0,
        receivedAt: 32,
      },
    });
    await waitFor(() => {
      const projection = store.readSession(secondSession.id);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
    });
    queueManager.stopProcessing();

    const backendInput = liveProvider.backendInputs.at(-1);
    expect(backendInput).toBeDefined();
    expect(backendInput?.sessionId).toBeUndefined();
    expect(backendInput?.systemPrompt).toContain(
      '[previous voice turn, user]: My cat is called Nori.',
    );
    expect(backendInput?.systemPrompt).not.toContain(
      '[previous voice turn, user]: Current request only.',
    );
    expect(backendInput?.prompt).toContain('Current request only.');
    await waitFor(
      () =>
        messageRepository.findLatestByThread(secondSession.threadId, 300)._unsafeUnwrap().length ===
        202,
    );
    await service.closeSession(owner, secondSession.id, { reason: 'hangup' });

    const reconstructedService = new DurableVoiceSessionService(serviceOptions);
    const third = await reconstructedService.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(third.isOk()).toBe(true);
    expect(liveProvider.createInstructions.at(-1)).toContain('Backend result.');
    expect(liveProvider.createInstructions.at(-1)).toContain(
      '[verified voice result, succeeded]: Backend result.',
    );
    await reconstructedService.closeSession(owner, third._unsafeUnwrap().session.id, {
      reason: 'hangup',
    });

    const noCallbackSink = new VoiceOutputSink(store);
    const noCallbackQueueManager = new QueueManager(
      queueRepository,
      threadRepository,
      { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
      pino({ level: 'silent' }),
      bridge.claimQueueItem.bind(bridge),
    );
    const noCallbackContext = createDaemonContext(
      db,
      noCallbackQueueManager,
      liveProvider,
      bridge,
      noCallbackSink,
    );
    const noCallbackRunner = new AgentRunner(noCallbackContext, {
      voiceOutputSink: noCallbackSink,
      voiceExecutionGate: bridge.beforeProvider.bind(bridge),
    });
    const fourth = await reconstructedService.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(fourth.isOk()).toBe(true);
    const fourthSession = fourth._unsafeUnwrap().session;
    const fourthSideband = liveProvider.sidebands.get(
      fourth._unsafeUnwrap().client.providerSessionId,
    );
    expect(fourthSideband).toBeDefined();
    fourthSideband!.setContext(
      'lost-callback-delegation',
      context(1, 'lost-callback-digest', 'Lost callback request.'),
    );
    noCallbackQueueManager.startProcessing((item) => noCallbackRunner.run(item));
    fourthSideband!.emit({
      kind: 'delegation',
      eventId: 'lost-callback-delegation-event',
      sequence: 1,
      proposal: {
        providerDelegationId: 'lost-callback-delegation',
        offsetMs: 0,
        receivedAt: 40,
      },
    });
    await waitFor(() => {
      const projection = store.readSession(fourthSession.id);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
    });
    noCallbackQueueManager.stopProcessing();
    expect(
      messageRepository.findLatestByThread(fourthSession.threadId, 300)._unsafeUnwrap(),
    ).toHaveLength(202);
    await reconstructedService.closeSession(owner, fourthSession.id, { reason: 'hangup' });

    const recoveredService = new DurableVoiceSessionService(serviceOptions);
    const fifth = await recoveredService.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(fifth.isOk()).toBe(true);
    const recoveredInstructions = liveProvider.createInstructions.at(-1) ?? '';
    expect(recoveredInstructions).toContain(
      '[verified voice result, succeeded]: Backend result.',
    );
    expect(
      recoveredInstructions.match(/\[verified voice result, succeeded\]: Backend result\./g),
    ).toHaveLength(2);

    const fifthSession = fifth._unsafeUnwrap().session;
    const fifthSideband = liveProvider.sidebands.get(
      fifth._unsafeUnwrap().client.providerSessionId,
    );
    expect(fifthSideband).toBeDefined();
    fifthSideband!.setContext(
      'recovered-context-delegation',
      context(1, 'recovered-context-digest', 'Recovered backend request.'),
    );
    fifthSideband!.emit({
      kind: 'transcript',
      eventId: 'recovered-transcript-event',
      sequence: 1,
      fragment: {
        id: 'recovered-fragment',
        role: 'user',
        kind: 'completed',
        sequence: 1,
        text: 'Recovered backend request.',
        receivedAt: 41,
      },
    });
    await waitFor(
      () =>
        messageRepository.findLatestByThread(fifthSession.threadId, 300)._unsafeUnwrap().length ===
        204,
    );
    noCallbackQueueManager.startProcessing((item) => noCallbackRunner.run(item));
    fifthSideband!.emit({
      kind: 'delegation',
      eventId: 'recovered-context-delegation-event',
      sequence: 2,
      proposal: {
        providerDelegationId: 'recovered-context-delegation',
        offsetMs: 0,
        receivedAt: 42,
      },
    });
    await waitFor(() => {
      const projection = store.readSession(fifthSession.id);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
    });
    noCallbackQueueManager.stopProcessing();
    const recoveredBackendInput = liveProvider.backendInputs.at(-1);
    expect(recoveredBackendInput?.systemPrompt).toContain(
      '[verified voice result, succeeded]: Backend result.',
    );
    expect(recoveredBackendInput?.prompt).toContain('Recovered backend request.');
    await recoveredService.closeSession(owner, fifthSession.id, { reason: 'hangup' });

    const recordTerminalWithoutCallback = async (
      service: DurableVoiceSessionService,
      execution: 'failed' | 'unknown',
      providerDelegationId: string,
    ): Promise<void> => {
      const created = await service.createSession(owner, {
        transport: { type: 'webrtc', sdp: 'offer' },
      });
      expect(created.isOk()).toBe(true);
      const session = created._unsafeUnwrap().session;
      const sideband = liveProvider.sidebands.get(
        created._unsafeUnwrap().client.providerSessionId,
      );
      expect(sideband).toBeDefined();
      sideband!.setContext(
        providerDelegationId,
        context(1, `${providerDelegationId}-digest`, `${execution} request.`),
      );
      sideband!.emit({
        kind: 'delegation',
        eventId: `${providerDelegationId}-event`,
        sequence: 1,
        proposal: {
          providerDelegationId,
          offsetMs: 0,
          receivedAt: 50,
        },
      });
      await waitFor(() => {
        const projection = store.readSession(session.id);
        return projection.isOk() && projection.value?.delegations[0]?.status === 'queued';
      });
      const projection = store.readSession(session.id);
      expect(projection.isOk()).toBe(true);
      const delegationId = projection._unsafeUnwrap()?.delegations[0]?.id;
      expect(delegationId).toBeDefined();
      const terminal =
        execution === 'failed'
          ? noCallbackSink.failure(delegationId!, 'VOICE_EXECUTION_FAILED')
          : noCallbackSink.unknown(delegationId!, 'VOICE_EXECUTION_UNKNOWN');
      expect(terminal.isOk()).toBe(true);
      await waitFor(() => {
        const current = store.readSession(session.id);
        return current.isOk() && current.value?.delegations[0]?.execution === execution;
      });
      await service.closeSession(owner, session.id, { reason: 'hangup' });
    };

    await recordTerminalWithoutCallback(recoveredService, 'failed', 'failed-recovery-delegation');
    const failureRecoveredService = new DurableVoiceSessionService(serviceOptions);
    const afterFailure = await failureRecoveredService.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(afterFailure.isOk()).toBe(true);
    expect(liveProvider.createInstructions.at(-1)).toContain(
      '[verified voice result, failed]: The request could not be completed safely. Please try again.',
    );
    await failureRecoveredService.closeSession(
      owner,
      afterFailure._unsafeUnwrap().session.id,
      { reason: 'hangup' },
    );

    await recordTerminalWithoutCallback(
      failureRecoveredService,
      'unknown',
      'unknown-recovery-delegation',
    );
    const unknownRecoveredService = new DurableVoiceSessionService(serviceOptions);
    const afterUnknown = await unknownRecoveredService.createSession(owner, {
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(afterUnknown.isOk()).toBe(true);
    expect(liveProvider.createInstructions.at(-1)).toContain(
      '[verified voice result, unknown]: The request could not be completed safely. Please try again.',
    );
    await unknownRecoveredService.closeSession(
      owner,
      afterUnknown._unsafeUnwrap().session.id,
      { reason: 'hangup' },
    );
  });
});
