import Database from 'better-sqlite3';
import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok } from 'neverthrow';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { VoiceSipRepository } from '../../../src/core/database/repositories/voice-sip-repository.js';
import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import { AgentRunnerProviderConfigSchema, PersonaConfigSchema } from '../../../src/core/config/config-schema.js';
import { ProviderRegistry } from '../../../src/providers/provider-registry.js';
import type { AgentProvider, AgentRunInput, AgentStreamEvent } from '../../../src/providers/provider.js';
import type { AgentUsage, PreparedProviderInvocation, PreparedProviderResultFiles, ProviderResult, ProviderSpawnInput } from '../../../src/providers/provider-types.js';
import { rowToQueueItem } from '../../../src/queue/queue-mapper.js';
import { DurableVoiceBackendBridge } from '../../../src/voice/voice-backend-bridge.js';
import { VoiceOutputSink } from '../../../src/voice/voice-output-sink.js';
import { VoicePolicy } from '../../../src/voice/voice-policy.js';
import { createVoiceAdapterSelection } from '../../../src/voice/voice-adapters.js';
import { SipTransport } from '../../../src/voice/transports/sip/sip-transport.js';
import { SipIngressService, type IncomingSipEvent } from '../../../src/voice/transports/sip/sip-ingress-service.js';
import {
  ConfiguredSipAuthorizationResolver,
  SIP_ASSERTION_ALGORITHM,
  SIP_ASSERTION_VERSION,
  encodeSipAssertion,
} from '../../../src/voice/transports/sip/sip-authorization.js';
import { BrowserVoiceTransport, DurableVoiceSessionService } from '../../../src/voice/voice-session-service.js';
import { DurableVoiceStore } from '../../../src/voice/voice-store.js';
import type {
  LiveVoiceCommand,
  LiveVoiceEvent,
  LiveVoiceIncomingSessionRequest,
  LiveVoiceProvider,
  LiveVoiceSession,
  LiveVoiceSessionRequest,
  LiveVoiceSideband,
  VoiceAsyncResult,
  VoiceClientSessionDescriptor,
  VoiceContextSnapshot,
  VoiceEventHandler,
  VoiceOwnerContext,
  VoiceUnsubscribe,
  VoiceUsageUpdate,
} from '../../../src/voice/voice-types.js';

function signedSipAssertion(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  providerSessionId: string,
  nowSeconds: number,
): string {
  const claims = {
    issuer: 'issuer-1',
    keyId: 'key-1',
    audience: 'talon-incoming',
    subject: 'endpoint-1',
    nonce: `nonce-${providerSessionId}-012345`,
    callBinding: `pbx-call-${providerSessionId}`,
    issuedAt: nowSeconds - 5,
    expiresAt: nowSeconds + 55,
  };
  const payload = Buffer.from(
    JSON.stringify({ version: 1, algorithm: SIP_ASSERTION_ALGORITHM, ...claims }),
    'utf8',
  ).toString('base64url');
  const signedBytes = Buffer.from(`${SIP_ASSERTION_VERSION}.${payload}`, 'utf8');
  return encodeSipAssertion(claims, sign(null, signedBytes, privateKey));
}

function tamperSipAssertion(proof: string): string {
  const parts = proof.split('.');
  const signature = Buffer.from(parts[2] ?? '', 'base64url');
  if (signature.length === 0) return `${parts[0]}.${parts[1]}.A`;
  signature[0] ^= 1;
  return `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`;
}

class FakeIncomingSideband implements LiveVoiceSideband {
  readonly commands: LiveVoiceCommand[] = [];
  readonly contexts = new Map<string, VoiceContextSnapshot>();
  readonly providerSessionId: string;
  finalizationStatus: 'pending' | 'confirmed' | 'incomplete' = 'pending';
  usage: VoiceUsageUpdate | undefined;
  private handler: VoiceEventHandler<LiveVoiceEvent> | undefined;
  private finalizationWaiter?: (result: VoiceAsyncResult<void>) => void;
  closeCalls = 0;

  constructor(providerSessionId: string) {
    this.providerSessionId = providerSessionId;
  }

  contextForDelegation(id: string): VoiceContextSnapshot | null {
    return this.contexts.get(id) ?? null;
  }

  send(command: LiveVoiceCommand): VoiceAsyncResult<void> {
    this.commands.push(command);
    return Promise.resolve(ok(undefined));
  }

  onEvent(handler: VoiceEventHandler<LiveVoiceEvent>): VoiceUnsubscribe {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  close(_graceful: boolean): VoiceAsyncResult<void> {
    this.closeCalls += 1;
    this.finalizationStatus = 'incomplete';
    return Promise.resolve(ok(undefined));
  }

  waitForFinalization(): VoiceAsyncResult<void> {
    if (this.finalizationStatus === 'confirmed') return Promise.resolve(ok(undefined));
    if (this.finalizationStatus === 'incomplete') {
      return Promise.resolve(err(new Error('missing finalization')));
    }
    return new Promise((resolve) => {
      this.finalizationWaiter = resolve;
    });
  }

  emit(event: LiveVoiceEvent): void {
    if (event.kind === 'session_closed') {
      this.finalizationStatus = 'confirmed';
      this.usage = event.usage;
      this.finalizationWaiter?.(ok(undefined));
      this.finalizationWaiter = undefined;
    }
    void this.handler?.(event);
  }
}

class FakeIncomingProvider implements LiveVoiceProvider {
  readonly name = 'fake-live';
  readonly capabilities = {
    audio_streaming: 'supported',
    interruptions: 'supported',
    delegation: 'supported',
    transcript_stability: 'supported',
    usage_reporting: 'supported',
  } as const;
  readonly accepted: LiveVoiceIncomingSessionRequest[] = [];
  readonly created: LiveVoiceSessionRequest[] = [];
  readonly attached: string[] = [];
  readonly closed: string[] = [];
  readonly sessionIds = new Map<string, string>();
  readonly sidebands = new Map<string, FakeIncomingSideband>();
  closeEmitsFinalization = false;
  closeFails = false;
  attachGate?: { readonly promise: Promise<void>; readonly release: () => void };

  createSession(input: LiveVoiceSessionRequest): VoiceAsyncResult<LiveVoiceSession> {
    this.created.push(input);
    return Promise.resolve(err(new Error('SIP must not create a session')));
  }

  acceptIncomingSession(input: LiveVoiceIncomingSessionRequest): VoiceAsyncResult<LiveVoiceSession> {
    this.accepted.push(input);
    this.sessionIds.set(input.providerSessionId, input.sessionId);
    const sideband = new FakeIncomingSideband(input.providerSessionId);
    this.sidebands.set(input.providerSessionId, sideband);
    const client: VoiceClientSessionDescriptor = {
      transport: 'sip',
      sessionId: input.sessionId,
      providerSessionId: input.providerSessionId,
      answer: { type: 'sip', reference: input.providerSessionId },
      expiresAt: input.sessionExpiresAt,
    };
    return Promise.resolve(ok({ providerSessionId: input.providerSessionId, client }));
  }

  attachSideband(session: LiveVoiceSession): VoiceAsyncResult<LiveVoiceSideband> {
    this.attached.push(session.providerSessionId);
    const sideband = this.sidebands.get(session.providerSessionId);
    const attach = async (): VoiceAsyncResult<LiveVoiceSideband> => {
      if (this.attachGate) await this.attachGate.promise;
      return sideband ? ok(sideband) : err(new Error('sideband missing'));
    };
    return attach();
  }

  closeSession(providerSessionId: string): VoiceAsyncResult<void> {
    this.closed.push(providerSessionId);
    if (this.closeFails) return Promise.resolve(err(new Error('hangup failed')));
    if (this.closeEmitsFinalization) {
      this.sidebands.get(providerSessionId)?.emit({
        kind: 'session_closed',
        eventId: 'close-final-event',
        sequence: 99,
        reason: 'remote_hangup',
        usage: { voiceSeconds: 4, receivedAt: Date.now(), final: true },
        receivedAt: Date.now(),
      });
    }
    return Promise.resolve(ok(undefined));
  }
}

class FakeBackendProvider implements AgentProvider {
  readonly name = 'backend';
  readonly skillLoaderTransport = 'stdio' as const;
  readonly runInputs: AgentRunInput[] = [];

  createExecutionStrategy() {
    return {
      type: 'sdk' as const,
      supportsSessionResumption: false as const,
      run: async function* (input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
        this.runInputs.push(input);
        yield { type: 'text' as const, content: 'Backend retained result.' };
        yield {
          type: 'result' as const,
          result: {
            output: 'Backend retained result.',
            usage: { inputTokens: 3, outputTokens: 2, totalCostUsd: 0 } satisfies AgentUsage,
            isError: false,
          },
        };
      }.bind(this),
    };
  }

  prepareBackgroundInvocation(_input: ProviderSpawnInput) {
    const invocation: PreparedProviderInvocation = {
      command: 'offline-backend',
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

function snapshot(): VoiceContextSnapshot {
  return {
    version: 1,
    digest: 'sip-context-digest',
    capturedAt: 1,
    text: 'Read the status for the incoming caller.',
    fragments: [],
    truncated: false,
  };
}

function createVoiceAgentRunner(
  db: Database.Database,
  queue: QueueRepository,
  threads: ThreadRepository,
  channels: ChannelRepository,
  personas: PersonaRepository,
  runs: RunRepository,
  store: DurableVoiceStore,
  bridge: DurableVoiceBackendBridge,
  sink: VoiceOutputSink,
  provider: FakeIncomingProvider,
  backendProvider: FakeBackendProvider,
  service: DurableVoiceSessionService,
): AgentRunner {
  const providerConfig = AgentRunnerProviderConfigSchema.parse({
    enabled: true,
    type: 'openai-compatible',
    command: 'offline-backend',
    contextWindowTokens: 2_000,
    contextManagement: { enabled: false },
  });
  const providerRegistry = new ProviderRegistry(
    { backend: providerConfig },
    { 'openai-compatible': () => backendProvider },
  );
  const personaConfig = PersonaConfigSchema.parse({
    name: 'sip-persona',
    model: 'backend-model',
    provider: 'backend',
    capabilities: { allow: [], requireApproval: [] },
  });
  const observation = {
    update: (): void => undefined,
    getTraceparent: (): string | null => null,
  };
  const logger = pino({ level: 'silent' });
  const context = {
    db,
    config: {
      dataDir: process.cwd(),
      channels: [],
      agentRunner: {
        defaultProvider: 'backend',
        providers: { backend: providerConfig },
      },
      langfuse: { owner: undefined },
    },
    configPath: '',
    dataDir: process.cwd(),
    repos: {
      queue,
      thread: threads,
      channel: channels,
      persona: personas,
      run: runs,
      backgroundTask: {},
      executionEnv: {},
      executionEnvCheckpoint: {},
      schedule: {},
      audit: {},
      message: {},
      binding: {},
      memory: {},
      a2aTask: {},
    },
    channelRegistry: { listAll: () => [], get: () => undefined },
    queueManager: {},
    scheduler: {},
    personaLoader: {
      getByName: (name: string) =>
        name === 'sip-persona'
          ? ok({
              config: personaConfig,
              systemPromptContent: 'Answer the admitted backend request.',
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
    threadWorkspace: { ensureDirectories: (threadId: string) => ok(join(process.cwd(), threadId)) },
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
      path: join(process.cwd(), 'offline-host-tools.sock'),
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
    contextAssembler: {
      assemble: () => ({ text: '', summaryFound: false, recentMessageCount: 0, charCount: 0 }),
    },
    logger,
    toolInstructions: new Map(),
    a2aServer: null,
    a2aTaskMapper: null,
    voiceStore: store,
    voicePolicy: null,
    voiceAuth: null,
    voiceBackendBridge: bridge,
    voiceOutputSink: sink,
    voiceSessionService: service,
    voiceProvider: provider,
    voiceTransport: new SipTransport(),
    voiceServer: null,
  } as unknown as DaemonContext;
  return new AgentRunner(context, {
    voiceOutputSink: sink,
    voiceExecutionGate: bridge.beforeProvider.bind(bridge),
  });
}

describe('incoming SIP voice flow', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('accepts the existing session, queues through the ordinary bridge, and settles final usage', async () => {
    db = new Database(':memory:');
    runMigrations(db, join(import.meta.dirname, '../../../src/core/database/migrations'));
    const queue = new QueueRepository(db);
    const threads = new ThreadRepository(db);
    const channels = new ChannelRepository(db);
    const personas = new PersonaRepository(db);
    const runs = new RunRepository(db);
    const sipRepository = new VoiceSipRepository(db);
    channels.insert({
      id: 'voice-channel',
      type: 'voice',
      name: 'browser-voice',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    personas.insert({
      id: 'persona-1',
      name: 'sip-persona',
      model: 'backend-model',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{"allow":[],"requireApproval":[]}',
      mounts: '[]',
      max_concurrent: null,
    });
    const store = new DurableVoiceStore(db, queue);
    const provider = new FakeIncomingProvider();
    const browser = new BrowserVoiceTransport();
    const sip = new SipTransport();
    const browserSelection = createVoiceAdapterSelection({ transport: browser, engine: provider });
    const sipSelection = createVoiceAdapterSelection({ transport: sip, engine: provider });
    if (browserSelection.isErr() || sipSelection.isErr()) throw new Error('adapter selection failed');
    const policy = new VoicePolicy({ providerTypes: new Map([['backend', 'openai-compatible']]) });
    const owner = { ownerId: 'sip-owner', loginRevision: 1 };
    const capture = () =>
      policy.capture({
        generation: 1,
        ownerId: owner.ownerId,
        personaId: 'persona-1',
        providerName: 'backend',
        modelName: 'backend-model',
        voiceName: 'marin',
        capabilityNames: [],
        allowedToolNames: [],
        allowedMcpServerNames: [],
        nativeToolNames: [],
        requireApproval: false,
        loginRevision: owner.loginRevision,
      });
    const bridge = new DurableVoiceBackendBridge(store, queue, { executionGate: () => ok(undefined) });
    const closedCalls: string[] = [];
    const acceptedCalls: string[] = [];
    const signingKeys = generateKeyPairSync('ed25519');
    const publicKey = signingKeys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url');
    const authorization = new ConfiguredSipAuthorizationResolver({
      issuer: 'issuer-1',
      audience: 'talon-incoming',
      publicKeys: { 'key-1': publicKey },
      endpointMappings: { 'endpoint-1': { ownerId: owner.ownerId, personaId: 'persona-1' } },
    });
    let ingress: SipIngressService | undefined;
    const service = new DurableVoiceSessionService({
      store,
      provider,
      transport: browser,
      transports: new Map([['webrtc', browser], ['sip', sip]]),
      adapterSelection: browserSelection.value,
      adapterSelections: new Map([
        ['webrtc', browserSelection.value],
        ['sip', sipSelection.value],
      ]),
      backendBridge: bridge,
      policy,
      threadRepository: threads,
      channelId: 'voice-channel',
      personaId: 'persona-1',
      modelName: 'backend-model',
      liveModelName: 'gpt-live-1',
      instructions: 'incoming SIP test',
      voiceName: 'marin',
      capturePolicy: capture,
      currentPolicy: capture,
      isIncomingOwnerActive: (candidate, providerSessionId) =>
        ingress?.isProviderSessionActive(providerSessionId, candidate) ?? false,
      onIncomingAccepted: (callId) => {
        acceptedCalls.push(callId);
        return ingress?.markAccepted(callId) ?? ok(false);
      },
      onIncomingClosed: (callId) => {
        closedCalls.push(callId);
        ingress?.markClosed(callId);
      },
    });
    ingress = new SipIngressService({
      repository: sipRepository,
      authorization,
      acceptCall: async (input) => {
        const accepted = await service.acceptIncomingSession({
          callId: input.callId,
          providerSessionId: input.providerSessionId,
          owner: { ownerId: input.grant.owner_id, loginRevision: input.grant.revision },
          personaId: input.grant.persona_id,
          admissionExpiresAt: input.grant.expires_at * 1_000,
        });
        return accepted.isOk() ? { outcome: 'accepted' as const } : { outcome: 'unknown' as const };
      },
    });
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const validProof = signedSipAssertion(signingKeys.privateKey, 'provider-sip-1', nowSeconds);
    const invalidProof = tamperSipAssertion(validProof);
    const invalidProofResult = await ingress.ingest(
      {
        id: 'incoming-event-invalid-proof',
        createdAt: nowSeconds,
        type: 'live.transport.incoming',
        data: {
          type: 'sip',
          sessionId: 'provider-sip-invalid-proof',
          sipHeaders: [{ name: 'X-Talon-Voice-Assertion', value: invalidProof }],
        },
      } satisfies IncomingSipEvent,
      { deliveryId: 'delivery-invalid-proof', deliveredAt: nowSeconds },
    );
    expect(invalidProofResult.isOk()).toBe(true);
    expect(invalidProofResult._unsafeUnwrap().outcome).toBe('rejected');
    expect(invalidProofResult._unsafeUnwrap().reason).toBe('authority_denied');
    expect(provider.accepted).toHaveLength(0);
    const accepted = await ingress.ingest(
      {
        id: 'incoming-event-1',
        createdAt: Math.floor(Date.now() / 1_000),
        type: 'live.transport.incoming',
        data: {
          type: 'sip',
          sessionId: 'provider-sip-1',
          sipHeaders: [{ name: 'X-Talon-Voice-Assertion', value: validProof }],
        },
      } satisfies IncomingSipEvent,
      { deliveryId: 'delivery-1', deliveredAt: Math.floor(Date.now() / 1_000) },
    );
    expect(accepted.isOk(), accepted.isErr() ? accepted.error.message : undefined).toBe(true);
    if (accepted.isErr()) return;
    expect(accepted.value.outcome).toBe('accepted');
    const ingressCallId = accepted.value.callId;
    expect(ingressCallId).toBeTruthy();
    const sessionId = provider.sessionIds.get('provider-sip-1');
    expect(sessionId).toBeTruthy();
    if (!sessionId) return;
    expect(provider.created).toHaveLength(0);
    expect(provider.accepted).toHaveLength(1);
    expect(provider.attached).toEqual(['provider-sip-1']);
    expect(store.readSession(sessionId)._unsafeUnwrap()?.session.transport).toBe('sip');
    expect(store.readSession(sessionId)._unsafeUnwrap()?.session.providerSessionId).toBe('provider-sip-1');

    const sideband = provider.sidebands.get('provider-sip-1');
    if (!sideband) throw new Error('sideband missing');
    sideband.contexts.set('delegation-1', snapshot());
    sideband.emit({
      kind: 'delegation',
      eventId: 'delegation-event-1',
      sequence: 1,
      proposal: {
        providerDelegationId: 'delegation-1',
        offsetMs: 100,
        receivedAt: Date.now(),
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect((db.prepare('SELECT COUNT(*) AS count FROM queue_items').get() as { count: number }).count).toBe(1);

    const sink = new VoiceOutputSink(store, (result) => bridge.notifyResult(result));
    const backendProvider = new FakeBackendProvider();
    const runner = createVoiceAgentRunner(
      db,
      queue,
      threads,
      channels,
      personas,
      runs,
      store,
      bridge,
      sink,
      provider,
      backendProvider,
      service,
    );
    const pendingQueue = queue.findPending()._unsafeUnwrap()[0];
    expect(pendingQueue).toBeDefined();
    if (!pendingQueue) return;
    const claimedVoice = bridge.claimQueueItem(pendingQueue)._unsafeUnwrap();
    expect(claimedVoice).not.toBeNull();
    if (!claimedVoice) return;
    const runResult = await runner.run(rowToQueueItem(claimedVoice));
    expect(runResult.isOk(), runResult.isErr() ? runResult.error.message : undefined).toBe(true);
    queue.complete(claimedVoice.id);
    const executed = store.readSession(sessionId)._unsafeUnwrap();
    expect(executed?.delegations[0]?.execution).toBe('succeeded');
    expect(executed?.outputs.find((output) => output.text !== undefined)?.text).toBe(
      'Backend retained result.',
    );
    expect(backendProvider.runInputs[0]?.prompt).toContain('Read the status for the incoming caller.');

    const notification = await service.notifyThread({
      threadId: store.readSession(sessionId)._unsafeUnwrap()!.session.threadId,
      text: 'The backend result is ready.',
    });
    expect(notification.isOk()).toBe(true);
    expect(notification._unsafeUnwrap().speechRequested).toBe(true);
    expect(sideband.commands).toContainEqual({
      kind: 'instruction',
      delegationId: null,
      content: 'The backend result is ready.',
      outputId: notification._unsafeUnwrap().notificationId,
    });

    provider.closeEmitsFinalization = true;
    const closed = await service.closeSession(owner, sessionId, { reason: 'hangup' });
    expect(closed.isOk()).toBe(true);
    if (closed.isErr()) return;
    const projection = store.readSession(sessionId)._unsafeUnwrap();
    expect(projection?.session.status).toBe('closed');
    expect(projection?.session.finalization.status).toBe('confirmed');
    expect(projection?.session.usage.voiceSeconds).toBe(4);
    expect(provider.closed).toEqual(['provider-sip-1']);
    expect(closedCalls).toEqual([ingressCallId]);
    expect(acceptedCalls).toEqual([ingressCallId]);

    let releaseAttach: () => void = () => undefined;
    provider.attachGate = {
      promise: new Promise<void>((resolve) => {
        releaseAttach = resolve;
      }),
      release: () => releaseAttach(),
    };
    provider.closeEmitsFinalization = false;
    provider.closeFails = true;
    service.openAdmission();
    const delayedNowSeconds = Math.floor(Date.now() / 1_000);
    const delayedProof = signedSipAssertion(
      signingKeys.privateKey,
      'provider-sip-2',
      delayedNowSeconds,
    );
    const delayed = ingress.ingest(
      {
        id: 'incoming-event-2',
        createdAt: delayedNowSeconds,
        type: 'live.transport.incoming',
        data: {
          type: 'sip',
          sessionId: 'provider-sip-2',
          sipHeaders: [{ name: 'X-Talon-Voice-Assertion', value: delayedProof }],
        },
      } satisfies IncomingSipEvent,
      { deliveryId: 'delivery-2', deliveredAt: delayedNowSeconds },
    );
    for (let attempt = 0; attempt < 10 && !provider.attached.includes('provider-sip-2'); attempt += 1) {
      await Promise.resolve();
    }
    expect(provider.attached).toContain('provider-sip-2');
    service.closeAdmission();
    service.bumpGeneration();
    provider.attachGate.release();
    const delayedResult = await delayed;
    expect(delayedResult.isOk()).toBe(true);
    expect(delayedResult._unsafeUnwrap().outcome).toBe('accepted');
    expect(provider.closed).toContain('provider-sip-2');
    expect(provider.sidebands.get('provider-sip-2')?.closeCalls).toBe(0);
    expect(closedCalls).not.toContain(delayedResult._unsafeUnwrap().callId);
    expect(
      sipRepository.findByCallId(delayedResult._unsafeUnwrap().callId!)._unsafeUnwrap()?.decision.state,
    ).toBe('accepted');

    provider.attachGate = undefined;
    provider.closeFails = false;
    service.openAdmission();
    const incompleteNowSeconds = Math.floor(Date.now() / 1_000);
    const incompleteProof = signedSipAssertion(
      signingKeys.privateKey,
      'provider-sip-3',
      incompleteNowSeconds,
    );
    const incomplete = await ingress.ingest(
      {
        id: 'incoming-event-3',
        createdAt: incompleteNowSeconds,
        type: 'live.transport.incoming',
        data: {
          type: 'sip',
          sessionId: 'provider-sip-3',
          sipHeaders: [{ name: 'X-Talon-Voice-Assertion', value: incompleteProof }],
        },
      } satisfies IncomingSipEvent,
      { deliveryId: 'delivery-3', deliveredAt: incompleteNowSeconds },
    );
    expect(incomplete.isOk()).toBe(true);
    expect(incomplete._unsafeUnwrap().outcome).toBe('accepted');
    const incompleteSessionId = provider.sessionIds.get('provider-sip-3');
    expect(incompleteSessionId).toBeTruthy();
    if (!incompleteSessionId) return;
    const incompleteReservation = sipRepository
      .findByCallId(incomplete._unsafeUnwrap().callId!)
      ._unsafeUnwrap();
    expect(incompleteReservation).toBeTruthy();
    if (!incompleteReservation) return;
    const incompleteOwner = {
      ownerId: owner.ownerId,
      loginRevision: incompleteReservation.grant.revision,
    };
    const incompleteClose = await service.closeSession(incompleteOwner, incompleteSessionId, {
      reason: 'hangup',
    });
    expect(incompleteClose.isOk(), incompleteClose.isErr() ? incompleteClose.error.message : undefined).toBe(true);
    const incompleteProjection = store.readSession(incompleteSessionId)._unsafeUnwrap();
    expect(incompleteProjection?.session.finalization.status).toBe('incomplete');
    expect(closedCalls).not.toContain(incomplete._unsafeUnwrap().callId);
    expect(
      sipRepository.findByCallId(incomplete._unsafeUnwrap().callId!)._unsafeUnwrap()?.decision.state,
    ).toBe('accepted');
  });
});
