/**
 * Offline integration coverage for the browser voice composition.
 *
 * These tests deliberately cross the HTTP/auth, SQLite, lifecycle, durable
 * queue, and AgentRunner boundaries. The live provider is replaced by a fake
 * normalized transport, so no external provider call, microphone, or paid API
 * is needed.
 */

import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import pino from 'pino';
import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import {
  AgentRunnerProviderConfigSchema,
  PersonaConfigSchema,
} from '../../../src/core/config/config-schema.js';
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
import {
  BrowserVoiceTransport,
  DurableVoiceSessionService,
  IndexedVoiceAuth,
} from '../../../src/voice/voice-session-service.js';
import { DurableVoiceStore } from '../../../src/voice/voice-store.js';
import { BrowserVoiceServer } from '../../../src/voice/transports/browser/browser-server.js';
import type {
  LiveVoiceEvent,
  LiveVoiceProvider,
  LiveVoiceSession,
  LiveVoiceSideband,
  LiveVoiceCommand,
  VoiceAsyncResult,
  VoiceClientSessionDescriptor,
  VoiceContextSnapshot,
  VoiceEventHandler,
  VoiceOwnerContext,
  VoiceTransport,
  VoiceTransportEvent,
  VoiceTransportHandle,
  VoiceTransportOpenRequest,
  VoiceTransportStatus,
  VoiceUnsubscribe,
  VoiceUsageUpdate,
} from '../../../src/voice/voice-types.js';

const ORIGIN = 'https://voice.example.test';
const ACCESS_TOKEN = 'offline-voice-secret';
const PERSONA_ID = 'voice-persona-id';
const CHANNEL_ID = 'voice-channel-id';
const BACKEND_PROVIDER = 'voice-backend';
const BACKEND_MODEL = 'backend-model';
const LIVE_MODEL = 'gpt-live-offline';

function context(version: number, digest: string, text: string): VoiceContextSnapshot {
  return {
    version,
    digest,
    capturedAt: Date.now(),
    text,
    fragments: [],
    truncated: false,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('timed out waiting for browser voice integration state'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

class FakeSideband implements LiveVoiceSideband {
  readonly commands: LiveVoiceCommand[] = [];
  readonly contexts = new Map<string, VoiceContextSnapshot>();
  latestUsage: VoiceUsageUpdate | undefined;
  private handler: VoiceEventHandler<LiveVoiceEvent> | undefined;

  constructor(readonly providerSessionId: string) {}

  contextForDelegation(providerDelegationId: string): VoiceContextSnapshot | null {
    return this.contexts.get(providerDelegationId) ?? null;
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
    return Promise.resolve(ok(undefined));
  }

  emit(event: LiveVoiceEvent): void {
    void this.handler?.(event);
  }
}

class FakeLiveProvider implements LiveVoiceProvider {
  readonly name = 'offline-live-provider';
  readonly sessions = new Map<string, FakeSideband>();
  readonly createInputs: string[] = [];
  runDelayMs: number;
  runStarted = false;
  private sequence = 0;

  constructor(runDelayMs = 0) {
    this.runDelayMs = runDelayMs;
  }

  createSession(input: import('../../../src/voice/voice-types.js').LiveVoiceSessionRequest) {
    this.createInputs.push(input.modelName);
    const providerSessionId = `provider-session-${++this.sequence}`;
    this.sessions.set(providerSessionId, new FakeSideband(providerSessionId));
    const client: VoiceClientSessionDescriptor = {
      transport: input.transport.type,
      sessionId: input.sessionId,
      providerSessionId,
      answer: { type: input.transport.type, sdp: 'offline-answer' },
      expiresAt: Date.now() + 60_000,
    };
    const session: LiveVoiceSession = { providerSessionId, client };
    return Promise.resolve(ok(session));
  }

  attachSideband(session: LiveVoiceSession): VoiceAsyncResult<LiveVoiceSideband> {
    const sideband = this.sessions.get(session.providerSessionId);
    return Promise.resolve(
      sideband ? ok(sideband) : err(new Error('fake provider session missing')),
    );
  }

  closeSession(providerSessionId: string): VoiceAsyncResult<void> {
    this.sessions.delete(providerSessionId);
    return Promise.resolve(ok(undefined));
  }

  sidebandFor(sessionId: string): FakeSideband {
    const sideband = this.sessions.get(sessionId);
    if (!sideband) throw new Error(`fake sideband not found: ${sessionId}`);
    return sideband;
  }
}

class FakeAgentProvider implements AgentProvider {
  readonly name = BACKEND_PROVIDER;
  readonly skillLoaderTransport = 'stdio' as const;
  constructor(private readonly provider: FakeLiveProvider) {}

  createExecutionStrategy() {
    return {
      type: 'sdk' as const,
      supportsSessionResumption: false as const,
      run: async function* (input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
        this.provider.runStarted = true;
        if (this.provider.runDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.provider.runDelayMs));
        }
        yield { type: 'text' as const, content: 'Backend verified the voice request.' };
        yield {
          type: 'result' as const,
          result: {
            output: 'Backend verified the voice request.',
            usage: { inputTokens: 11, outputTokens: 7, totalCostUsd: 0.002 } satisfies AgentUsage,
            isError: false,
          },
        };
        void input;
      }.bind(this),
    };
  }

  prepareBackgroundInvocation(_input: ProviderSpawnInput) {
    const invocation: PreparedProviderInvocation = {
      command: 'offline-fake-provider',
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

class FakeSipTransport implements VoiceTransport {
  readonly kind = 'fake-sip';
  private readonly statuses = new Map<string, VoiceTransportStatus>();
  private readonly handlers = new Map<string, Set<VoiceEventHandler<VoiceTransportEvent>>>();

  open(input: VoiceTransportOpenRequest): VoiceAsyncResult<VoiceTransportHandle> {
    if (input.client.transport !== this.kind) {
      return Promise.resolve(err(new Error('fake SIP descriptor mismatch')));
    }
    this.statuses.set(input.sessionId, 'connected');
    return Promise.resolve(
      ok({
        sessionId: input.sessionId,
        transportSessionId: `sip:${input.sessionId}`,
        kind: this.kind,
        status: 'connected' as const,
      }),
    );
  }

  status(sessionId: string) {
    return ok(this.statuses.get(sessionId) ?? 'idle');
  }

  onEvent(sessionId: string, handler: VoiceEventHandler<VoiceTransportEvent>): VoiceUnsubscribe {
    const handlers = this.handlers.get(sessionId) ?? new Set();
    handlers.add(handler);
    this.handlers.set(sessionId, handlers);
    return () => handlers.delete(handler);
  }

  close(sessionId: string, _reason: string): VoiceAsyncResult<void> {
    this.statuses.set(sessionId, 'closed');
    return Promise.resolve(ok(undefined));
  }
}

interface SseState {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}

async function nextSseEvent(state: SseState): Promise<Record<string, unknown> | null> {
  const decoder = new TextDecoder();
  for (;;) {
    const separator = state.buffer.indexOf('\n\n');
    if (separator >= 0) {
      const block = state.buffer.slice(0, separator);
      state.buffer = state.buffer.slice(separator + 2);
      const data = block
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice('data:'.length)
        .trim();
      if (data) return JSON.parse(data) as Record<string, unknown>;
      continue;
    }
    const next = await state.reader.read();
    if (next.done) return null;
    state.buffer += decoder.decode(next.value, { stream: true }).replaceAll('\r\n', '\n');
  }
}

async function waitForSse(
  state: SseState,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          const event = await nextSseEvent(state);
          if (event === null) throw new Error('voice SSE stream ended before expected event');
          if (predicate(event)) return event;
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for voice SSE event')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
  const channels = new ChannelRepository(db);
  channels.insert({
    id: CHANNEL_ID,
    type: 'voice',
    name: 'browser-voice',
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });
  const personas = new PersonaRepository(db);
  personas.insert({
    id: PERSONA_ID,
    name: 'voice-persona',
    model: BACKEND_MODEL,
    system_prompt_file: null,
    skills: '[]',
    capabilities: '{"allow":[],"requireApproval":[]}',
    mounts: '[]',
    max_concurrent: null,
  });
  return db;
}

function makePolicy(
  generation: () => number,
  owner: VoiceOwnerContext,
): {
  policy: VoicePolicy;
  capture: (candidate: VoiceOwnerContext) => ReturnType<VoicePolicy['capture']>;
} {
  const policy = new VoicePolicy({
    providerTypes: new Map([[BACKEND_PROVIDER, 'openai-compatible']]),
  });
  const capture = (candidate: VoiceOwnerContext) =>
    policy.capture({
      generation: generation(),
      ownerId: candidate.ownerId,
      personaId: PERSONA_ID,
      providerName: BACKEND_PROVIDER,
      modelName: BACKEND_MODEL,
      voiceName: 'marin',
      capabilityNames: [],
      allowedToolNames: [],
      allowedMcpServerNames: [],
      nativeToolNames: [],
      requireApproval: false,
      loginRevision: candidate.loginRevision,
    });
  void owner;
  return { policy, capture };
}

function makeDaemonContext(
  db: Database.Database,
  queueManager: QueueManager,
  provider: FakeLiveProvider,
  bridge: DurableVoiceBackendBridge,
  sink: VoiceOutputSink,
  dataDir: string,
): DaemonContext {
  const queue = new QueueRepository(db);
  const thread = new ThreadRepository(db);
  const channel = new ChannelRepository(db);
  const persona = new PersonaRepository(db);
  const run = new RunRepository(db);
  const providerConfig = AgentRunnerProviderConfigSchema.parse({
    enabled: true,
    type: 'openai-compatible',
    command: 'offline-fake-provider',
    contextWindowTokens: 2_000,
    contextManagement: { enabled: false },
  });
  const providerRegistry = new ProviderRegistry(
    { [BACKEND_PROVIDER]: providerConfig },
    { 'openai-compatible': () => new FakeAgentProvider(provider) },
  );
  const personaConfig = PersonaConfigSchema.parse({
    name: 'voice-persona',
    model: BACKEND_MODEL,
    provider: BACKEND_PROVIDER,
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
      dataDir,
      channels: [],
      agentRunner: {
        defaultProvider: BACKEND_PROVIDER,
        providers: { [BACKEND_PROVIDER]: providerConfig },
      },
      langfuse: { owner: undefined },
    },
    configPath: '',
    dataDir,
    repos: {
      queue,
      thread,
      channel,
      persona,
      run,
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
    queueManager,
    scheduler: {},
    personaLoader: {
      getByName: (name: string) =>
        name === personaConfig.name
          ? ok({
              config: personaConfig,
              systemPromptContent: 'Answer the admitted request.',
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
    threadWorkspace: {
      ensureDirectories: (threadId: string) => ok(join(dataDir, threadId)),
    },
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
      path: join(dataDir, 'host-tools.sock'),
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
  return context;
}

interface Harness {
  readonly db: Database.Database;
  readonly dataDir: string;
  readonly provider: FakeLiveProvider;
  readonly store: DurableVoiceStore;
  readonly bridge: DurableVoiceBackendBridge;
  readonly service: DurableVoiceSessionService;
  readonly auth: IndexedVoiceAuth;
  readonly server: BrowserVoiceServer;
  readonly queueManager: QueueManager;
  readonly startRunner: () => void;
  readonly close: () => Promise<void>;
  generation: number;
}

async function createHarness(runDelayMs = 0, usdPerMinute?: number): Promise<Harness> {
  const db = createDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'talon-voice-integration-'));
  const queueRepository = new QueueRepository(db);
  const threadRepository = new ThreadRepository(db);
  const store = new DurableVoiceStore(db, queueRepository);
  const provider = new FakeLiveProvider(runDelayMs);
  const auth = new IndexedVoiceAuth({ accessToken: ACCESS_TOKEN, ownerId: 'offline-owner' });
  let generation = 1;
  const owner: VoiceOwnerContext = { ownerId: 'offline-owner', loginRevision: 1 };
  const policyParts = makePolicy(() => generation, owner);
  const currentPolicy = (candidate: VoiceOwnerContext) => policyParts.capture(candidate);
  const bridge = new DurableVoiceBackendBridge(store, queueRepository, {
    executionGate: (input) => {
      const sessionResult = store.findSession(input.request.sessionId);
      if (sessionResult.isErr() || !sessionResult.value)
        return err(new Error('voice session missing'));
      const current = currentPolicy(input.owner);
      if (current.isErr()) return err(current.error);
      const eligible = policyParts.policy.checkExecution({
        session: sessionResult.value,
        admitted: input.request.policy,
        current: current.value,
        now: Date.now(),
      });
      return eligible.isOk() && eligible.value.eligible
        ? ok(undefined)
        : err(
            new Error(
              `voice execution blocked: ${eligible.isOk() ? eligible.value.reason : 'policy_error'}`,
            ),
          );
    },
  });
  const service = new DurableVoiceSessionService({
    store,
    provider,
    transport: new BrowserVoiceTransport(),
    backendBridge: bridge,
    policy: policyParts.policy,
    threadRepository,
    channelId: CHANNEL_ID,
    personaId: PERSONA_ID,
    providerName: BACKEND_PROVIDER,
    modelName: BACKEND_MODEL,
    liveModelName: LIVE_MODEL,
    instructions: 'Offline browser voice integration test.',
    voiceName: 'marin',
    capturePolicy: currentPolicy,
    currentPolicy,
    isOwnerActive: (candidate) => auth.resolve(candidate) !== undefined,
    maxSessionLifetimeMs: 30_000,
    usdPerMinute,
  });
  const sink = new VoiceOutputSink(store, (result) => bridge.notifyResult(result));
  const queueManager = new QueueManager(
    queueRepository,
    threadRepository,
    { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
    pino({ level: 'silent' }),
    bridge.claimQueueItem.bind(bridge),
  );
  const context = makeDaemonContext(db, queueManager, provider, bridge, sink, dataDir);
  const runner = new AgentRunner(context, {
    voiceOutputSink: sink,
    voiceExecutionGate: bridge.beforeProvider.bind(bridge),
  });
  let runnerStarted = false;
  const startRunner = (): void => {
    if (runnerStarted) return;
    runnerStarted = true;
    queueManager.startProcessing((item) => runner.run(item));
  };
  const server = new BrowserVoiceServer(
    {
      accessToken: ACCESS_TOKEN,
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [ORIGIN],
      allowedTransportTypes: ['webrtc'],
      sessionTtlMs: 30_000,
    },
    { sessionService: service, auth, logger: pino({ level: 'silent' }) },
  );
  await server.start();
  return {
    db,
    dataDir,
    provider,
    store,
    bridge,
    service,
    auth,
    server,
    queueManager,
    startRunner,
    get generation() {
      return generation;
    },
    set generation(value: number) {
      generation = value;
    },
    close: async () => {
      queueManager.stopProcessing();
      await service.shutdown();
      await server.stop();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function baseUrl(server: BrowserVoiceServer): string {
  return `http://127.0.0.1:${server.port}`;
}

function cookieParts(response: Response): { cookie: string; csrf: string } {
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  const all = setCookies.join('; ');
  const cookie = all.match(/talon_voice_session=([^;]+)/)?.[1];
  const csrf = all.match(/talon_voice_csrf=([^;]+)/)?.[1];
  if (!cookie || !csrf) throw new Error('voice login did not return both cookies');
  return { cookie: `talon_voice_session=${cookie}; talon_voice_csrf=${csrf}`, csrf };
}

function requestHeaders(auth?: { cookie: string; csrf: string }): Record<string, string> {
  return {
    origin: ORIGIN,
    ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : {}),
  };
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('browser voice offline integration', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.close();
  });

  it('authenticates, admits SQLite work, runs AgentRunner, streams lifecycle, and retains closed cost state', async () => {
    const harness = await createHarness(0, 0.06);
    harnesses.push(harness);
    const url = baseUrl(harness.server);

    const unauthenticated = await fetch(`${url}/voice/sessions`, {
      method: 'POST',
      headers: { ...requestHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offline-offer' } }),
    });
    expect(unauthenticated.status).toBe(401);

    const wrongOrigin = await fetch(`${url}/voice/login`, {
      method: 'POST',
      headers: { origin: 'https://not-allowed.test', 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: ACCESS_TOKEN }),
    });
    expect(wrongOrigin.status).toBe(403);

    const invalidLogin = await fetch(`${url}/voice/login`, {
      method: 'POST',
      headers: {
        ...requestHeaders(),
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ accessToken: 'wrong-token' }),
    });
    expect(invalidLogin.status).toBe(401);
    expect(harness.provider.createInputs).toHaveLength(0);

    const login = await fetch(`${url}/voice/login`, {
      method: 'POST',
      headers: {
        ...requestHeaders(),
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ accessToken: ACCESS_TOKEN }),
    });
    expect(login.status).toBe(200);
    const auth = cookieParts(login);
    expect(login.headers.getSetCookie().every((value) => value.includes('Secure'))).toBe(true);

    const created = await fetch(`${url}/voice/sessions`, {
      method: 'POST',
      headers: {
        ...requestHeaders(auth),
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offline-offer' } }),
    });
    expect(created.status).toBe(201);
    const createdBody = await jsonResponse(created);
    const session = createdBody.session as { id: string; status: string; transport: string };
    expect(session).toMatchObject({ status: 'connected', transport: 'webrtc' });
    expect(JSON.stringify(createdBody)).not.toContain(ACCESS_TOKEN);
    expect(harness.provider.createInputs).toEqual([LIVE_MODEL]);
    const providerSessionId = (createdBody.client as { providerSessionId: string })
      .providerSessionId;
    const sessionId = session.id;

    const streamAbort = new AbortController();
    const streamResponse = await fetch(`${url}/voice/sessions/${sessionId}/events`, {
      headers: { ...requestHeaders(auth), 'x-forwarded-proto': 'https' },
      signal: streamAbort.signal,
    });
    expect(streamResponse.status).toBe(200);
    const streamState: SseState = { reader: streamResponse.body!.getReader(), buffer: '' };
    await waitForSse(
      streamState,
      (event) =>
        event.kind === 'session' && (event.session as { status: string }).status === 'connected',
    );

    const sideband = harness.provider.sidebandFor(providerSessionId);
    sideband.contexts.set(
      'delegation-1',
      context(1, 'digest-1', 'Verify the offline voice request.'),
    );
    harness.startRunner();
    sideband.emit({
      kind: 'usage',
      eventId: 'usage-1',
      sequence: 1,
      update: {
        voiceSeconds: 4,
        inputTokens: 12,
        outputTokens: 8,
        receivedAt: Date.now(),
        final: false,
      },
    });
    sideband.emit({
      kind: 'delegation',
      eventId: 'delegation-event-1',
      sequence: 2,
      proposal: { providerDelegationId: 'delegation-1', offsetMs: 0, receivedAt: Date.now() },
    });

    const delegationEvent = await waitForSse(
      streamState,
      (event) =>
        event.kind === 'delegation' &&
        (event.delegation as { execution: string }).execution === 'succeeded',
    );
    const delegation = delegationEvent.delegation as {
      output: { playback: string; providerAcknowledgement: string };
      outputs: Array<{ id: string; text?: string }>;
    };
    const finalOutput = delegation.outputs.find((output) => output.text !== undefined);
    expect(finalOutput?.text).toBe('Backend verified the voice request.');
    expect(harness.db.prepare('SELECT status FROM queue_items').get()).toMatchObject({
      status: 'completed',
    });
    expect(harness.db.prepare('SELECT status FROM runs').get()).toMatchObject({
      status: 'completed',
    });
    expect(
      harness.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%audio%'")
        .all(),
    ).toEqual([]);

    const outputId = finalOutput!.id;
    sideband.emit({
      kind: 'provider_acknowledgement',
      eventId: 'provider-ack-1',
      sequence: 3,
      delegationId: 'delegation-1',
      outputId,
      receivedAt: Date.now(),
    });
    const played = await fetch(`${url}/voice/sessions/${sessionId}/playback`, {
      method: 'POST',
      headers: {
        ...requestHeaders(auth),
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ outputId, status: 'played' }),
    });
    expect(played.status).toBe(204);
    await waitFor(() => {
      const projection = harness.store.readSession(sessionId);
      return (
        projection.isOk() &&
        projection.value?.delegations[0]?.output.providerAcknowledgement === 'acknowledged'
      );
    });

    sideband.latestUsage = { voiceSeconds: 4, receivedAt: Date.now(), final: true };
    const closed = await fetch(`${url}/voice/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: {
        ...requestHeaders(auth),
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ reason: 'hangup' }),
    });
    expect(closed.status).toBe(200);
    expect((await jsonResponse(closed)).session).toMatchObject({ status: 'closed' });
    await waitForSse(
      streamState,
      (event) =>
        event.kind === 'session' && (event.session as { status: string }).status === 'closed',
    );
    streamAbort.abort();

    const relogin = await fetch(`${url}/voice/login`, {
      method: 'POST',
      headers: { ...requestHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: ACCESS_TOKEN }),
    });
    const retainedAuth = cookieParts(relogin);
    const retained = await fetch(`${url}/voice/sessions/${sessionId}`, {
      headers: { ...requestHeaders(retainedAuth), 'x-forwarded-proto': 'https' },
    });
    expect(retained.status).toBe(200);
    const retainedBody = await jsonResponse(retained);
    expect(retainedBody.session).toMatchObject({
      status: 'closed',
      usage: { voiceSeconds: 4, voiceCostStatus: 'estimated' },
      finalization: { status: 'confirmed' },
    });
    expect(
      (retainedBody.session as { usage: { voiceCostUsd: number } }).usage.voiceCostUsd,
    ).toBeCloseTo(0.004, 10);
    expect(JSON.stringify(retainedBody)).not.toContain(ACCESS_TOKEN);

    const retainedStreamAbort = new AbortController();
    const retainedStream = await fetch(`${url}/voice/sessions/${sessionId}/events`, {
      headers: { ...requestHeaders(retainedAuth), 'x-forwarded-proto': 'https' },
      signal: retainedStreamAbort.signal,
    });
    const retainedState: SseState = { reader: retainedStream.body!.getReader(), buffer: '' };
    await waitForSse(
      retainedState,
      (event) =>
        event.kind === 'session' && (event.session as { status: string }).status === 'closed',
    );
    retainedStreamAbort.abort();

    const logout = await fetch(`${url}/voice/logout`, {
      method: 'POST',
      headers: { ...requestHeaders(retainedAuth), 'x-forwarded-proto': 'https' },
    });
    expect(logout.status).toBe(200);
    const revokedRead = await fetch(`${url}/voice/sessions/${sessionId}`, {
      headers: { ...requestHeaders(retainedAuth), 'x-forwarded-proto': 'https' },
    });
    expect(revokedRead.status).toBe(401);
  });

  it('keeps a claimed AgentRunner result after hangup and retains it for a new login', async () => {
    const harness = await createHarness(250);
    harnesses.push(harness);
    const url = baseUrl(harness.server);
    const login = await fetch(`${url}/voice/login`, {
      method: 'POST',
      headers: { ...requestHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: ACCESS_TOKEN }),
    });
    const auth = cookieParts(login);
    const created = await fetch(`${url}/voice/sessions`, {
      method: 'POST',
      headers: { ...requestHeaders(auth), 'content-type': 'application/json' },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offline-offer' } }),
    });
    const body = await jsonResponse(created);
    const sessionId = (body.session as { id: string }).id;
    const providerSessionId = (body.client as { providerSessionId: string }).providerSessionId;
    const sideband = harness.provider.sidebandFor(providerSessionId);
    sideband.contexts.set('late-delegation', context(1, 'late-digest', 'Finish after hangup.'));
    harness.startRunner();
    sideband.emit({
      kind: 'delegation',
      eventId: 'late-event',
      sequence: 1,
      proposal: { providerDelegationId: 'late-delegation', offsetMs: 0, receivedAt: Date.now() },
    });
    await waitFor(() => harness.provider.runStarted);

    const closed = await fetch(`${url}/voice/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: { ...requestHeaders(auth), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'hangup' }),
    });
    expect(closed.status).toBe(200);
    expect((await jsonResponse(closed)).pendingDelegation).toBe(true);
    await waitFor(() => {
      const projection = harness.store.readSession(sessionId);
      return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
    });
    const retained = harness.store.readSession(sessionId)._unsafeUnwrap();
    expect(retained?.session.status).toBe('closed');
    expect(retained?.outputs.find((output) => output.text !== undefined)?.text).toBe(
      'Backend verified the voice request.',
    );
  });

  it('blocks queued work when policy generation changes before admission', async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const url = baseUrl(harness.server);
    const login = await fetch(`${url}/voice/login`, {
      method: 'POST',
      headers: { ...requestHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: ACCESS_TOKEN }),
    });
    const auth = cookieParts(login);
    const created = await fetch(`${url}/voice/sessions`, {
      method: 'POST',
      headers: { ...requestHeaders(auth), 'content-type': 'application/json' },
      body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offline-offer' } }),
    });
    const body = await jsonResponse(created);
    const sessionId = (body.session as { id: string }).id;
    const providerSessionId = (body.client as { providerSessionId: string }).providerSessionId;
    const sideband = harness.provider.sidebandFor(providerSessionId);
    sideband.contexts.set(
      'revoked-delegation',
      context(1, 'revoked-digest', 'This request must be blocked.'),
    );
    harness.generation = 2;
    sideband.emit({
      kind: 'delegation',
      eventId: 'revoked-event',
      sequence: 1,
      proposal: { providerDelegationId: 'revoked-delegation', offsetMs: 0, receivedAt: Date.now() },
    });
    await waitFor(() =>
      sideband.commands.some(
        (command) =>
          command.kind === 'instruction' && command.content.includes('no longer permitted'),
      ),
    );
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM queue_items').get()).toMatchObject({
      count: 0,
    });
    expect(harness.provider.runStarted).toBe(false);
    expect(
      sideband.commands.some((command) =>
        JSON.stringify(command).includes('This request must be blocked.'),
      ),
    ).toBe(false);
  });

  it('runs a second normalized transport through the durable AgentRunner path', async () => {
    const db = createDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), 'talon-voice-sip-integration-'));
    const queueRepository = new QueueRepository(db);
    const threadRepository = new ThreadRepository(db);
    const store = new DurableVoiceStore(db, queueRepository);
    const provider = new FakeLiveProvider();
    const policyParts = makePolicy(() => 1, { ownerId: 'sip-owner', loginRevision: 1 });
    const transport = new FakeSipTransport();
    const bridge = new DurableVoiceBackendBridge(store, queueRepository, {
      executionGate: (input) =>
        input.providerType === 'openai-compatible' &&
        input.nativeToolsDisabled &&
        !input.requireApproval
          ? ok(undefined)
          : err(new Error('fake SIP voice execution posture mismatch')),
    });
    const service = new DurableVoiceSessionService({
      store,
      provider,
      transport,
      backendBridge: bridge,
      policy: policyParts.policy,
      threadRepository,
      channelId: CHANNEL_ID,
      personaId: PERSONA_ID,
      providerName: BACKEND_PROVIDER,
      modelName: BACKEND_MODEL,
      liveModelName: LIVE_MODEL,
      instructions: 'fake SIP seam',
      voiceName: 'marin',
      capturePolicy: (owner) => policyParts.capture(owner),
      currentPolicy: (owner) => policyParts.capture(owner),
    });
    const sink = new VoiceOutputSink(store, (result) => bridge.notifyResult(result));
    const queueManager = new QueueManager(
      queueRepository,
      threadRepository,
      { maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1, concurrencyLimit: 1 },
      pino({ level: 'silent' }),
      bridge.claimQueueItem.bind(bridge),
    );
    const daemonContext = makeDaemonContext(db, queueManager, provider, bridge, sink, dataDir);
    const runner = new AgentRunner(daemonContext, {
      voiceOutputSink: sink,
      voiceExecutionGate: bridge.beforeProvider.bind(bridge),
    });
    const owner = { ownerId: 'sip-owner', loginRevision: 1 };

    try {
      const created = await service.createSession(owner, {
        transport: { type: 'fake-sip', sdp: 'offer' },
      });
      expect(created.isOk()).toBe(true);
      const session = created._unsafeUnwrap().session;
      expect(created._unsafeUnwrap().client.transport).toBe('fake-sip');
      expect(session.transport).toBe('fake-sip');
      expect(transport.status(session.id)._unsafeUnwrap()).toBe('connected');

      const sideband = provider.sidebandFor(created._unsafeUnwrap().client.providerSessionId);
      sideband.contexts.set(
        'sip-delegation',
        context(1, 'sip-digest', 'Run the normalized fake SIP request.'),
      );
      queueManager.startProcessing((item) => runner.run(item));
      sideband.emit({
        kind: 'delegation',
        eventId: 'sip-delegation-event',
        sequence: 1,
        proposal: {
          providerDelegationId: 'sip-delegation',
          offsetMs: 0,
          receivedAt: Date.now(),
        },
      });

      await waitFor(() => {
        const projection = store.readSession(session.id);
        return projection.isOk() && projection.value?.delegations[0]?.execution === 'succeeded';
      });

      const retained = store.readSession(session.id)._unsafeUnwrap();
      const delegation = retained.delegations[0];
      const queueItem = queueRepository.findById(delegation.queueItemId!)._unsafeUnwrap();
      const finalOutput = retained.outputs.find(
        (output) => output.delegationId === delegation.id && output.kind === 'final',
      );
      expect(provider.runStarted).toBe(true);
      expect(delegation.providerDelegationId).toBe('sip-delegation');
      expect(delegation.status).toBe('completed');
      expect(delegation.claimedAt).toEqual(expect.any(Number));
      expect(queueItem.status).toBe('completed');
      expect(finalOutput).toMatchObject({
        kind: 'final',
        text: 'Backend verified the voice request.',
        lifecycle: { execution: 'succeeded' },
      });

      const closed = await service.closeSession(owner, session.id, { reason: 'hangup' });
      expect(closed.isOk()).toBe(true);
      expect(closed._unsafeUnwrap().session.status).toBe('closed');
      expect(transport.status(session.id)._unsafeUnwrap()).toBe('closed');
      const retainedAfterClose = store.readSession(session.id)._unsafeUnwrap();
      expect(
        retainedAfterClose.outputs.find(
          (output) => output.delegationId === delegation.id && output.kind === 'final',
        ),
      ).toMatchObject({
        kind: 'final',
        text: 'Backend verified the voice request.',
        lifecycle: { execution: 'succeeded' },
      });
    } finally {
      queueManager.stopProcessing();
      await service.shutdown();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
