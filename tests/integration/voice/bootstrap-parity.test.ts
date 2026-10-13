/**
 * Bootstrap-backed browser voice parity checks.
 *
 * The daemon, SQLite migrations, BrowserVoiceServer, voice queue, AgentRunner,
 * host-tools bridge, channel connector, and OAuth resolver are production
 * composition.  Only the live provider and external backend command are fake.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok } from 'neverthrow';

import { TalondDaemon } from '../../../src/daemon/daemon.js';
import { createVoiceAdapterSelection } from '../../../src/voice/voice-adapters.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import type {
  LiveVoiceEvent,
  LiveVoiceProvider,
  LiveVoiceSession,
  LiveVoiceSessionRequest,
  LiveVoiceSideband,
  LiveVoiceCommand,
  VoiceAsyncResult,
  VoiceClientSessionDescriptor,
  VoiceContextSnapshot,
  VoiceEventHandler,
  VoiceTransport,
  VoiceUnsubscribe,
} from '../../../src/voice/voice-types.js';

const ORIGIN = 'https://voice.example.test';
const ACCESS_TOKEN = 'offline-voice-secret';
const PERSONA_NAME = 'Marin';
const LIVE_MODEL = 'gpt-live-offline';
const BACKEND_PROVIDER = 'voice-backend-alt';
const BACKEND_MODEL = 'backend-alt-model';
const OTHER_BACKEND_PROVIDER = 'voice-backend';
let providerSessionSequence = 0;

interface AuthCookies {
  readonly cookie: string;
  readonly csrf: string;
}

interface CreatedSession {
  readonly id: string;
  readonly providerSessionId: string;
  readonly threadId: string;
}

interface Harness {
  readonly root: string;
  readonly configPath: string;
  readonly backendRunLog: string;
  daemon: TalondDaemon;
  context: DaemonContext;
  live: FakeLiveProvider;
  url: string;
  close(): Promise<void>;
}

class FakeSideband implements LiveVoiceSideband {
  readonly commands: LiveVoiceCommand[] = [];
  private readonly contexts = new Map<string, VoiceContextSnapshot>();
  private handler: VoiceEventHandler<LiveVoiceEvent> | undefined;

  constructor(readonly providerSessionId: string) {}

  contextForDelegation(providerDelegationId: string): VoiceContextSnapshot | null {
    return this.contexts.get(providerDelegationId) ?? null;
  }

  setContext(providerDelegationId: string, value: VoiceContextSnapshot): void {
    this.contexts.set(providerDelegationId, value);
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
  readonly capabilities = {
    audio_streaming: 'supported',
    interruptions: 'supported',
    delegation: 'supported',
    transcript_stability: 'supported',
    usage_reporting: 'supported',
  } as const;
  readonly sessions = new Map<string, FakeSideband>();
  readonly createInputs: LiveVoiceSessionRequest[] = [];
  private sequence = 0;

  createSession(input: LiveVoiceSessionRequest): VoiceAsyncResult<LiveVoiceSession> {
    this.createInputs.push(input);
    const providerSessionId = `offline-provider-session-${++providerSessionSequence}-${++this.sequence}`;
    this.sessions.set(providerSessionId, new FakeSideband(providerSessionId));
    const client: VoiceClientSessionDescriptor = {
      transport: input.transport.type,
      sessionId: input.sessionId,
      providerSessionId,
      answer: { type: input.transport.type, sdp: 'offline-answer' },
      expiresAt: Date.now() + 60_000,
    };
    return Promise.resolve(ok({ providerSessionId, client }));
  }

  attachSideband(session: LiveVoiceSession): VoiceAsyncResult<LiveVoiceSideband> {
    const sideband = this.sessions.get(session.providerSessionId);
    return Promise.resolve(sideband ? ok(sideband) : err(new Error('offline sideband is missing')));
  }

  closeSession(_providerSessionId: string): VoiceAsyncResult<void> {
    return Promise.resolve(ok(undefined));
  }

  sidebandFor(providerSessionId: string): FakeSideband {
    const sideband = this.sessions.get(providerSessionId);
    if (!sideband) throw new Error(`offline sideband not found: ${providerSessionId}`);
    return sideband;
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('timed out waiting for bootstrap voice state'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function snapshot(version: number, text: string): VoiceContextSnapshot {
  return {
    version,
    digest: `digest-${version}`,
    capturedAt: Date.now(),
    text,
    fragments: [],
    truncated: false,
  };
}

function installFakeLiveProvider(context: DaemonContext, provider: FakeLiveProvider): void {
  const service = context.voiceSessionService;
  if (!service) throw new Error('bootstrap did not create voice session service');
  const options = (
    service as unknown as {
      options: {
        provider: LiveVoiceProvider;
        transport: VoiceTransport;
        adapterSelection: import('../../../src/voice/voice-adapters.js').VoiceAdapterSelection;
      };
    }
  ).options;
  options.provider = provider;
  const adapterSelection = createVoiceAdapterSelection({
    transport: options.transport,
    engine: provider,
  });
  if (adapterSelection.isErr()) throw adapterSelection.error;
  options.adapterSelection = adapterSelection.value;
  (context as unknown as { voiceProvider: LiveVoiceProvider }).voiceProvider = provider;
}

function createFakeBackendCommand(root: string): { command: string; runLog: string } {
  const runLog = join(root, 'backend-runs.ndjson');
  const scriptPath = join(root, 'fake-backend.mjs');
  const script = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import net from 'node:net';

const runLog = ${JSON.stringify(runLog)};
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on('end', async () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  let toolResult;
  let toolInput;
  if (prompt.includes('send notification') || prompt.includes('approval bypass')) {
    toolInput = { channelId: 'browser-voice', content: prompt.includes('approval') ? 'approval bypass notification' : 'bootstrap channel notification' };
    const host = payload.mcpServers?.__talond_host_tools;
    const env = host?.env ?? {};
    const request = {
      id: 'offline-bridge-request',
      tool: 'channel_send',
      args: toolInput,
      bridgeSecret: env.TALOND_BRIDGE_SECRET,
      context: {
        runId: env.TALOND_RUN_ID,
        threadId: env.TALOND_THREAD_ID,
        personaId: env.TALOND_PERSONA_ID,
        requestId: 'offline-channel-send',
        traceparent: env.TALOND_TRACEPARENT,
      },
    };
    toolResult = await callBridge(env.TALOND_SOCKET, request);
    process.stdout.write(JSON.stringify({
      type: 'tool_event',
      messageType: 'mcp_tool_use',
      tool: 'channel_send',
      serverName: '__talond_host_tools',
      input: toolInput,
      output: toolResult,
      isError: toolResult?.result?.status === 'error' || Boolean(toolResult?.error),
    }) + '\\n');
  }
  payload.bridgeResult = toolResult;
  appendFileSync(runLog, JSON.stringify(payload) + '\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'result',
    output: prompt.includes('memory') ? 'Backend remembered the prior voice turn.' : 'Backend verified the voice request.',
    usage: { inputTokens: 11, outputTokens: 7 },
  }) + '\\n');
});

function callBridge(socketPath, request) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify(request) + '\\n');
    });
    socket.setTimeout(5000, () => finish({ error: 'bridge request timed out' }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\\n');
      if (newline < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish({ error: String(error) });
      }
    });
    socket.on('error', (error) => finish({ error: String(error) }));
  });
}
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return { command: scriptPath, runLog };
}

function createOAuthSkill(dataDir: string): void {
  const skillDir = join(dataDir, 'skills', 'oauth-check');
  const mcpDir = join(skillDir, 'mcp');
  const tokenDir = join(dataDir, 'mcp-auth', 'oauth-check');
  mkdirSync(mcpDir, { recursive: true });
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: oauth-check\nversion: 1.0.0\ndescription: Offline OAuth integration fixture\nrequiredCapabilities: []\neager: false\n---\nUse the configured remote service when the persona requests it.\n`,
  );
  writeFileSync(
    join(mcpDir, 'oauth.json'),
    JSON.stringify({
      name: 'oauth-check',
      config: {
        transport: 'http',
        url: 'https://mcp.example.test/api',
        auth: { kind: 'oauth2', tokenStore: 'oauth-check/oauth' },
      },
    }),
  );
  writeFileSync(
    join(tokenDir, 'oauth.json'),
    JSON.stringify({
      accessToken: 'cached-oauth-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      requestedScopes: [],
      resource: 'https://mcp.example.test/api',
      tokenEndpoint: 'https://issuer.example.test/token',
    }),
  );
}

function createConfig(
  root: string,
  command: string,
  options: {
    readonly capabilities: { allow: string[]; requireApproval: string[] };
    readonly includeOAuthSkill: boolean;
  },
): string {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (options.includeOAuthSkill) createOAuthSkill(dataDir);
  const configPath = join(root, 'talond.yaml');
  const config = `storage:\n  path: ${JSON.stringify(join(root, 'talon.sqlite'))}\ndataDir: ${JSON.stringify(dataDir)}\nlogLevel: error\nchannels: []\npersonas:\n  - name: ${PERSONA_NAME}\n    model: ${BACKEND_MODEL}\n    provider: ${BACKEND_PROVIDER}\n    skills: ${options.includeOAuthSkill ? '[oauth-check]' : '[]'}\n    capabilities:\n      allow: ${JSON.stringify(options.capabilities.allow)}\n      requireApproval: ${JSON.stringify(options.capabilities.requireApproval)}\nagentRunner:\n  defaultProvider: ${BACKEND_PROVIDER}\n  providers:\n    ${BACKEND_PROVIDER}:\n      enabled: true\n      type: openai-compatible\n      command: ${JSON.stringify(command)}\n      contextWindowTokens: 2000\n      contextManagement:\n        enabled: false\n      options:\n        baseUrl: https://backend-alt.example.test/v1\n    ${OTHER_BACKEND_PROVIDER}:\n      enabled: true\n      type: openai-compatible\n      command: ${JSON.stringify(command)}\n      contextWindowTokens: 2000\n      contextManagement:\n        enabled: false\n      options:\n        baseUrl: https://backend.example.test/v1\nbackgroundAgent:\n  enabled: false\n  defaultProvider: ${BACKEND_PROVIDER}\n  providers: {}\nvoice:\n  enabled: true\n  host: 127.0.0.1\n  port: 0\n  accessTokenRef: voice\n  liveApiKeyRef: openai\n  model: ${LIVE_MODEL}\n  voice: marin\n  persona: ${PERSONA_NAME}\n  allowedTransportTypes: [webrtc]\n  allowedOrigins: [${ORIGIN}]\n  allowedToolNames: []\n  allowedMcpServerNames: []\nauth:\n  providers:\n    voice:\n      apiKey: ${ACCESS_TOKEN}\n    openai:\n      apiKey: offline-live-key\nqueue:\n  maxAttempts: 1\n  backoffBaseMs: 1\n  backoffMaxMs: 1\n  concurrencyLimit: 1\n`;
  writeFileSync(configPath, config);
  return configPath;
}

async function login(url: string): Promise<AuthCookies> {
  const response = await fetch(`${url}/voice/login`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-forwarded-proto': 'https',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ accessToken: ACCESS_TOKEN }),
  });
  if (!response.ok) throw new Error(`voice login failed: ${response.status}`);
  const values =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  const all = values.join('; ');
  const session = all.match(/talon_voice_session=([^;]+)/)?.[1];
  const csrf = all.match(/talon_voice_csrf=([^;]+)/)?.[1];
  if (!session || !csrf) throw new Error('voice login did not return cookies');
  return { cookie: `talon_voice_session=${session}; talon_voice_csrf=${csrf}`, csrf };
}

async function createSession(url: string, auth: AuthCookies): Promise<CreatedSession> {
  const response = await fetch(`${url}/voice/sessions`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-forwarded-proto': 'https',
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ transport: { type: 'webrtc', sdp: 'offline-offer' } }),
  });
  const body = (await response.json()) as {
    session?: { id: string };
    client?: { providerSessionId: string };
  };
  if (!response.ok || !body.session || !body.client) {
    throw new Error(`voice session creation failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return { id: body.session.id, providerSessionId: body.client.providerSessionId, threadId: '' };
}

async function closeSession(url: string, auth: AuthCookies, sessionId: string): Promise<void> {
  const response = await fetch(`${url}/voice/sessions/${sessionId}/close`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-forwarded-proto': 'https',
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'hangup' }),
  });
  if (!response.ok) throw new Error(`voice close failed: ${response.status}`);
}

function projection(context: DaemonContext, sessionId: string) {
  const result = context.voiceStore.readSession(sessionId);
  if (result.isErr()) throw result.error;
  return result.value;
}

function runLogCount(path: string): number {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function createHarness(options: {
  readonly capabilities: { allow: string[]; requireApproval: string[] };
  readonly includeOAuthSkill: boolean;
}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'talon-task18-bootstrap-'));
  const backend = createFakeBackendCommand(root);
  const configPath = createConfig(root, backend.command, options);
  const daemon = new TalondDaemon(pino({ level: 'silent' }));
  const started = await daemon.start(configPath);
  if (started.isErr()) {
    rmSync(root, { recursive: true, force: true });
    throw started.error;
  }
  const context = (daemon as unknown as { ctx: DaemonContext }).ctx;
  if (!context || !context.voiceServer || !context.voiceSessionService) {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
    throw new Error('bootstrap did not initialize browser voice');
  }
  const live = new FakeLiveProvider();
  installFakeLiveProvider(context, live);
  const url = `http://127.0.0.1:${context.voiceServer.port}`;
  return {
    root,
    configPath,
    backendRunLog: backend.runLog,
    daemon,
    context,
    live,
    url,
    close: async () => {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function admitDelegation(
  harness: Harness,
  session: CreatedSession,
  text: string,
  providerDelegationId: string,
): Promise<void> {
  const stored = projection(harness.context, session.id);
  if (!stored) throw new Error('voice session projection is missing');
  session = { ...session, threadId: stored.session.threadId };
  const sideband = harness.live.sidebandFor(session.providerSessionId);
  sideband.setContext(providerDelegationId, snapshot(1, text));
  sideband.emit({
    kind: 'delegation',
    eventId: `event-${providerDelegationId}`,
    sequence: 1,
    proposal: { providerDelegationId, offsetMs: 0, receivedAt: Date.now() },
  });
  await waitFor(() => {
    const current = projection(harness.context, session.id);
    return (
      current?.delegations.some(
        (entry) =>
          entry.providerDelegationId === providerDelegationId && entry.execution === 'succeeded',
      ) ?? false
    );
  });
}

describe('browser voice bootstrap parity', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.close();
  });

  it('resolves the named persona, uses both backend providers, runs OAuth-safe AgentRunner work, and sends through channel_send', async () => {
    const harness = await createHarness({
      capabilities: { allow: ['channel.send:*'], requireApproval: [] },
      includeOAuthSkill: true,
    });
    harnesses.push(harness);
    const { context } = harness;
    const persona = context.personaLoader.getByName(PERSONA_NAME);
    expect(persona.isOk() && persona.value).toBeTruthy();
    const personaRow = context.repos.persona.findByName(PERSONA_NAME);
    expect(personaRow.isOk() && personaRow.value?.id).toEqual(
      context.voiceSessionService &&
        (context.voiceSessionService as unknown as { options: { personaId: string } }).options
          .personaId,
    );
    expect(context.providerRegistry.listEnabled()).toEqual(
      expect.arrayContaining([BACKEND_PROVIDER, OTHER_BACKEND_PROVIDER]),
    );

    const auth = await login(harness.url);
    const first = await createSession(harness.url, auth);
    const firstProjection = projection(context, first.id);
    if (!firstProjection) throw new Error('first voice session projection is missing');
    const firstWithThread = { ...first, threadId: firstProjection.session.threadId };
    expect(firstProjection.session.personaId).toBe(personaRow._unsafeUnwrap().id);
    expect(harness.live.createInputs[0]?.modelName).toBe(LIVE_MODEL);
    expect(harness.live.createInputs[0]?.instructions).toContain(`persona "${PERSONA_NAME}"`);

    await admitDelegation(
      harness,
      firstWithThread,
      'send notification with oauth',
      'delegation-send',
    );
    const firstDone = projection(context, first.id);
    if (!firstDone) throw new Error('completed voice projection is missing');
    expect(firstDone.delegations[0]?.execution).toBe('succeeded');
    expect(firstDone.outputs.some((output) => output.kind === 'final' && output.text)).toBe(true);

    const runPayload = JSON.parse(readFileSync(harness.backendRunLog, 'utf8').trim()) as {
      model: string;
      disableNativeShellAndFilesystemTools?: boolean;
      mcpServers?: Record<
        string,
        { auth?: unknown; headers?: Record<string, string>; env?: Record<string, string> }
      >;
    };
    expect(runPayload.model).toBe(BACKEND_MODEL);
    expect(runPayload.disableNativeShellAndFilesystemTools).toBe(true);
    expect(runPayload.mcpServers?.['oauth-check']?.auth).toBeUndefined();
    expect(runPayload.mcpServers?.['oauth-check']?.headers?.Authorization).toBe(
      'Bearer cached-oauth-token',
    );
    expect(runPayload.mcpServers?.__talond_host_tools?.env?.TALOND_ALLOWED_TOOLS).toContain(
      'channel_send',
    );

    const instruction = harness.live
      .sidebandFor(first.providerSessionId)
      .commands.find((command) => command.kind === 'instruction' && command.delegationId === null);
    expect(instruction?.content).toBe('bootstrap channel notification');
    expect(instruction?.outputId).toBeTruthy();
    const messageRows = context.repos.message.findByThread(firstWithThread.threadId, 50, 0);
    expect(messageRows.isOk()).toBe(true);
    const deliveredRow = messageRows._unsafeUnwrap().find((row) => {
      try {
        return JSON.parse(row.content).body === 'bootstrap channel notification';
      } catch {
        return false;
      }
    });
    expect(deliveredRow?.id).toBe(instruction?.outputId);
    expect(deliveredRow?.run_id).toBeTruthy();

    await closeSession(harness.url, auth, first.id);
    const second = await createSession(harness.url, auth);
    const secondProjection = projection(context, second.id);
    if (!secondProjection) throw new Error('second voice session projection is missing');
    expect(secondProjection.session.threadId).toBe(firstWithThread.threadId);
    expect(harness.live.createInputs[1]?.instructions).toContain('bootstrap channel notification');
    expect(harness.live.createInputs[1]?.instructions).toContain('[previous voice turn, agent');
    expect(harness.live.createInputs[1]?.instructions).toContain(
      '[verified voice result, succeeded]',
    );
    expect(runLogCount(harness.backendRunLog)).toBe(1);
    await closeSession(harness.url, auth, second.id);
  });

  it('denies an approval-only tool at the bridge even when a provider bypasses its empty voice tool list', async () => {
    const harness = await createHarness({
      capabilities: { allow: [], requireApproval: ['channel.send:*'] },
      includeOAuthSkill: false,
    });
    harnesses.push(harness);
    const auth = await login(harness.url);
    const session = await createSession(harness.url, auth);
    await admitDelegation(harness, session, 'approval bypass', 'delegation-approval');

    const payload = JSON.parse(readFileSync(harness.backendRunLog, 'utf8').trim()) as {
      mcpServers?: { __talond_host_tools?: { env?: Record<string, string> } };
    };
    expect(payload.mcpServers?.__talond_host_tools?.env?.TALOND_ALLOWED_TOOLS ?? '').toBe('');
    const bridgeResult = projection(harness.context, session.id);
    if (!bridgeResult) throw new Error('approval session projection is missing');
    expect(
      harness.live
        .sidebandFor(session.providerSessionId)
        .commands.some(
          (command) => command.kind === 'instruction' && command.delegationId === null,
        ),
    ).toBe(false);

    const output = JSON.parse(readFileSync(harness.backendRunLog, 'utf8').trim()) as {
      prompt: string;
      bridgeResult?: { result?: { status?: string; error?: string } };
    };
    expect(output.prompt).toContain('approval bypass');
    expect(output.bridgeResult?.result?.status).toBe('error');
    expect(output.bridgeResult?.result?.error).toContain('requires approval');
    expect(bridgeResult.delegations[0]?.execution).toBe('succeeded');
    await closeSession(harness.url, auth, session.id);
  });

  it('keeps the shared owner/persona thread across a daemon restart without replaying old work', async () => {
    const harness = await createHarness({
      capabilities: { allow: [], requireApproval: [] },
      includeOAuthSkill: false,
    });
    harnesses.push(harness);
    const auth = await login(harness.url);
    const first = await createSession(harness.url, auth);
    const firstProjection = projection(harness.context, first.id);
    if (!firstProjection) throw new Error('first memory projection is missing');
    const firstWithThread = { ...first, threadId: firstProjection.session.threadId };
    const sideband = harness.live.sidebandFor(first.providerSessionId);
    sideband.emit({
      kind: 'transcript',
      eventId: 'transcript-remember',
      sequence: 1,
      fragment: {
        id: 'remembered-fact',
        role: 'user',
        kind: 'completed',
        sequence: 1,
        text: 'Remember that the project uses Dutch Marin.',
        receivedAt: Date.now(),
      },
    });
    await waitFor(() => {
      const rows = harness.context.repos.message.findByThread(firstWithThread.threadId, 50, 0);
      return rows.isOk() && rows.value.some((row) => row.content.includes('Dutch Marin'));
    });
    await admitDelegation(harness, firstWithThread, 'memory first turn', 'delegation-memory-1');
    await closeSession(harness.url, auth, first.id);
    expect(runLogCount(harness.backendRunLog)).toBe(1);

    await harness.daemon.stop();
    const restartedDaemon = new TalondDaemon(pino({ level: 'silent' }));
    const restarted = await restartedDaemon.start(harness.configPath);
    expect(restarted.isOk()).toBe(true);
    const restartedContext = (restartedDaemon as unknown as { ctx: DaemonContext }).ctx;
    if (!restartedContext?.voiceServer || !restartedContext.voiceSessionService) {
      throw new Error('restart did not rebuild browser voice');
    }
    const restartedLive = new FakeLiveProvider();
    installFakeLiveProvider(restartedContext, restartedLive);
    harness.daemon = restartedDaemon;
    harness.context = restartedContext;
    harness.live = restartedLive;
    harness.url = `http://127.0.0.1:${restartedContext.voiceServer.port}`;

    expect(runLogCount(harness.backendRunLog)).toBe(1);
    const restartedAuth = await login(harness.url);
    const second = await createSession(harness.url, restartedAuth);
    const secondProjection = projection(restartedContext, second.id);
    if (!secondProjection) throw new Error('restarted voice projection is missing');
    expect(secondProjection.session.threadId).toBe(firstWithThread.threadId);
    expect(restartedLive.createInputs[0]?.instructions).toContain('Dutch Marin');
    expect(restartedLive.createInputs[0]?.instructions).toContain('[previous voice turn, user');
    expect(runLogCount(harness.backendRunLog)).toBe(1);

    const secondWithThread = { ...second, threadId: secondProjection.session.threadId };
    await admitDelegation(harness, secondWithThread, 'memory followup', 'delegation-memory-2');
    expect(runLogCount(harness.backendRunLog)).toBe(2);
    await closeSession(harness.url, restartedAuth, second.id);
  });
});
