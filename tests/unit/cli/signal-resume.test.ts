import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { DaemonCommandSchema, DaemonIpcServer } from '../../../src/ipc/daemon-ipc.js';
import { signalResume } from '../../../src/cli/commands/signal-resume.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-resume-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const payload = { channel: 'signal-personal', externalChallengeResolved: true };

describe('canonical Signal management boundary', () => {
  it('accepts the actual local daemon command, not an agent/container message', () => {
    expect(DaemonCommandSchema.safeParse({ id: randomUUID(), command: 'signal-resume', payload }).success).toBe(true);
  });

  it.each([
    undefined, {}, { ...payload, externalChallengeResolved: false },
    { ...payload, externalChallengeResolved: 'true' }, { ...payload, channel: '' },
    { ...payload, channel: '../PRIVATE' },
    { ...payload, PRIVATE_DYNAMIC_KEY: 'PRIVATE_TOKEN' },
  ])('rejects invalid assertion/channel/extra fields with safe server diagnostics: %j', (input) => {
    const parsed = DaemonCommandSchema.safeParse({ id: randomUUID(), command: 'signal-resume', payload: input });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).not.toMatch(/PRIVATE/);
  });

  it('dispatches exactly once through actual command files and server.pollOnce', async () => {
    const seen: unknown[] = [];
    const server = new DaemonIpcServer({
      inputDir: path.join(root, 'input'), outputDir: path.join(root, 'output'), errorsDir: path.join(root, 'errors'),
      logger: pino({ enabled: false }),
      commandHandler: async (command) => {
        seen.push(command);
        return { id: randomUUID(), commandId: command.id, success: true, data: { outcome: 'verified' } };
      },
    });
    const pending = signalResume({ ...payload, ipcDir: root, timeoutMs: 2000 });
    for (let i = 0; i < 100; i++) {
      if ((await server.pollOnce()).length) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    {
      const result = await pending;
      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value).toEqual({ outcome: 'verified' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ command: 'signal-resume', payload });
      expect(await fs.readdir(path.join(root, 'input'))).toEqual([]);
    }
  });

  it.each([{}, { channel: 'signal-personal' }, { ...payload, externalChallengeResolved: false }])('refuses before any IPC mutation: %j', async (input) => {
    const result = await signalResume({ ...input, ipcDir: root });
    expect(result.isErr()).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

import { vi } from 'vitest';
import {
  DaemonIpcClient, SignalManagementError, SignalResumeRequestSchema, parseSignalResumeResponse, projectSignalResumeResult,
} from '../../../src/ipc/daemon-ipc.js';
import { signalResumeCommand } from '../../../src/cli/commands/signal-resume.js';
import { SignalStateError } from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalVerificationError } from '../../../src/channels/connectors/signal/signal-account-verifier.js';
import { SignalConnectorError } from '../../../src/channels/connectors/signal/signal-connector.js';
import { err, ok } from '../../../src/core/types/result.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('actual producer result projection', () => {
  it('projects THIS invocation Ok verified without reason, regardless active-promise bookkeeping', () => {
    for (const checking of [true, false]) {
      expect(projectSignalResumeResult(ok({ state: 'verified', checking }))).toEqual({ outcome: 'verified' });
      for (const state of ['pending', 'stale', 'suspended', 'stopped', 'needs_setup'] as const)
        expect(projectSignalResumeResult(ok({ state, checking })).outcome).not.toBe('verified');
      expect(projectSignalResumeResult(ok({ state: 'verified', reason: 'PAUSED', checking })).outcome).not.toBe('verified');
    }
  });
  it.each(['BUDGET', 'DATABASE', 'CONFLICT', 'BUSY', 'PAUSED'] as const)('preserves fixed typed %s refusal without retry authority', (reason) => {
    expect(projectSignalResumeResult(err(new SignalStateError(reason, 12345)))).toEqual({ outcome: 'blocked', reason });
  });
  it('keeps setup and pending refusal distinct', () => {
    expect(projectSignalResumeResult(err(new SignalConnectorError('DEVICE_METADATA_INVALID')))).toEqual({ outcome: 'blocked', reason: 'NEEDS_SETUP' });
    expect(projectSignalResumeResult(err(new SignalVerificationError('VERIFICATION_PENDING')))).toEqual({ outcome: 'blocked', reason: 'VERIFICATION_PENDING' });
  });
});

describe('typed client/CLI local response guards', () => {
  async function runWithResponse(data: unknown, success = false, error?: string, cli = false): Promise<unknown> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const pending = cli
      ? signalResumeCommand({ ...payload, ipcDir: root, timeoutMs: 2000 })
      : signalResume({ ...payload, ipcDir: root, timeoutMs: 2000 });
    let commandId = '';
    for (let i = 0; i < 100; i++) {
      const files = (await fs.readdir(path.join(root, 'input')).catch(() => [])).filter((file) => file.endsWith('.json'));
      if (files.length) {
        const parsed = DaemonCommandSchema.parse(JSON.parse(await fs.readFile(path.join(root, 'input', files[0]!), 'utf8')));
        commandId = parsed.id;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(commandId).not.toBe('');
    await fs.mkdir(path.join(root, 'output'));
    await fs.writeFile(path.join(root, 'output', 'reply.json'), JSON.stringify({
      id: randomUUID(), commandId, success, data, ...(error === undefined ? {} : { error }),
    }));
    const result = await pending;
    expect(await fs.readdir(path.join(root, 'input'))).toHaveLength(1); // one assertion command, never a retry
    if (cli) expect(log).not.toHaveBeenCalled();
    return result;
  }
  it.each(['NEEDS_SETUP', 'RATE_LIMITED', 'CHALLENGE_REQUIRED', 'RECOVERY_PENDING', 'BUDGET', 'DATABASE', 'CONFLICT', 'BUSY', 'VERIFICATION_PENDING', 'VERIFICATION_STALE'])('reports typed daemon refusal %s without success or replay', async (reason) => {
    await runWithResponse({ outcome: 'blocked', reason }, false, undefined, true);
    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(`blocked: ${reason}`);
  });
  it.each([
    undefined, {}, { recovered: true }, { outcome: 'pending' },
    { outcome: 'verified', PRIVATE_DYNAMIC_KEY: 'PRIVATE_TOKEN' },
    { outcome: 'blocked', reason: 'PRIVATE_TOKEN' },
  ])('malformed or pending response cannot become success: %j', async (data) => {
    const result = await runWithResponse(data, true);
    expect(result).toMatchObject({ error: { name: 'SignalManagementError', reason: 'INVALID_RESPONSE' } });
    expect(result).not.toHaveProperty('error.cause');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('does not print legacy daemon handler errors or their causes', async () => {
    await runWithResponse(undefined, false, 'PRIVATE_TOKEN /PRIVATE/socket body', true);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toMatch(/PRIVATE|body|socket/);
  });
  it('times out without retrying privileged assertion', async () => {
    const result = await signalResume({ ...payload, ipcDir: root, timeoutMs: 10 });
    expect(result).toMatchObject({ error: { reason: 'TIMEOUT' } });
    expect(await fs.readdir(path.join(root, 'input'))).toHaveLength(1);
  });
  it('keeps transport failures typed and safe, even when actual filesystem path is private', async () => {
    const file = path.join(root, 'PRIVATE_TOKEN');
    await fs.writeFile(file, 'fixture');
    const result = await signalResume({ ...payload, ipcDir: file, timeoutMs: 10 });
    expect(result).toMatchObject({ error: { reason: 'UNAVAILABLE' } });
    expect(result).not.toHaveProperty('error.cause');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('rejects extra request/envelope fields on actual client/server before dispatch and keeps server schema annotations safe', async () => {
    const client = new DaemonIpcClient({ inputDir: path.join(root, 'input'), outputDir: path.join(root, 'output') });
    const result = await client.signalResume({ ...payload, PRIVATE_KEY: 'PRIVATE_VALUE' });
    expect(result).toMatchObject({ error: { reason: 'INVALID_REQUEST' } });
    expect(await fs.readdir(root)).toEqual([]);
    const logs: string[] = [];
    const logger = pino({}, { write: (line: string) => { logs.push(line); } });
    const handler = vi.fn();
    const server = new DaemonIpcServer({ inputDir: path.join(root, 'input'), outputDir: path.join(root, 'output'), errorsDir: path.join(root, 'errors'), logger, commandHandler: handler });
    await fs.mkdir(path.join(root, 'input'));
    await fs.writeFile(path.join(root, 'input', 'invalid.json'), JSON.stringify({ id: randomUUID(), command: 'signal-resume', payload: { ...payload, PRIVATE_KEY: 'PRIVATE_VALUE' }, PRIVATE_TOP: 'PRIVATE_TOKEN' }));
    expect(await server.pollOnce()).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    const annotation = await fs.readFile(path.join(root, 'errors', 'invalid.error.json'), 'utf8');
    expect(annotation + logs.join('')).not.toMatch(/PRIVATE/);
  });
  it('requires correct success/outcome correlation and command id at the real response guard', () => {
    const commandId = randomUUID();
    for (const response of [
      { id: randomUUID(), commandId, success: true, data: { outcome: 'blocked', reason: 'BUDGET' } },
      { id: randomUUID(), commandId, success: false, data: { outcome: 'verified' } },
      { id: randomUUID(), commandId: randomUUID(), success: true, data: { outcome: 'verified' } },
      { id: randomUUID(), commandId, success: true, data: { outcome: 'verified' }, PRIVATE_KEY: 'PRIVATE_TOKEN' },
    ]) {
      const result = parseSignalResumeResponse(response, commandId);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error).toBeInstanceOf(SignalManagementError);
    }
  });
});

import { createServer, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createTestDb } from '../core/database/repositories/helpers.js';
import { SignalAccountStateRepository } from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { SignalConnector } from '../../../src/channels/connectors/signal/signal-connector.js';
import { SignalDeviceRegistry } from '../../../src/channels/connectors/signal/signal-device-registry.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';
import { projectSignalConnectorStatus } from '../../../src/ipc/daemon-ipc.js';

// Source-only socket/SQLite fixture, NOT TASK-012 handler/authentication or live evidence.
// signal-cli 0.14.9 / 3997429779095ff3a2d64c877126e84fce9852aa:
// VersionCommand.java:60-66; ListAccountsCommand.java:33-47; ListDevicesCommand.java:40-67;
// ManagerImpl.java:483-504; DispatcherHandler.java:164-199; JsonRpcResponse.java:13-46.
it('composes real IPC client/server with actual connector revision-bound resume, persisted budget and safe status projection', async () => {
  // /tmp and this workspace have writable ancestors; the trust checker intentionally rejects them.
  const socketDirectory = await fs.mkdtemp(path.join(os.homedir(), '.talon-cli-socket-fixture-'));
  await fs.chmod(socketDirectory, 0o700);
  const socketPath = path.join(socketDirectory, 'bridge.sock');
  const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const config = SignalConfigSchema.parse({ accountMode: 'personal', socketPath, account: accountUuid,
    accountUuid, deviceId: 3, deviceCreatedTimestamp: 200, requestTimeoutMs: 1000 });
  const db = createTestDb();
  const accounts = new SignalAccountStateRepository(db);
  let now = 1000000;
  const sockets: Socket[] = [];
  const methods: string[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request: unknown = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (typeof request !== 'object' || request === null || !('id' in request) || !('method' in request) || typeof request.method !== 'string') throw new Error('Invalid fixture request');
        methods.push(request.method);
        let result: unknown = {};
        if (request.method === 'version') result = { version: '0.14.9' };
        if (request.method === 'listAccounts') result = [{ number: null, aci: accountUuid }];
        if (request.method === 'listDevices') result = [
          { id: 1, name: null, createdTimestamp: 1, lastSeenTimestamp: 500 },
          { id: 2, name: null, createdTimestamp: 100, lastSeenTimestamp: 500 },
          { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 },
        ];
        if (request.method === 'subscribeReceive') result = 7;
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      }
    });
  });
  const connector = new SignalConnector(config, 'signal-personal', pino({ enabled: false }), {
    accounts, leases: new SignalDestinationLeaseRepository(db), queue: new QueueRepository(db),
    registry: SignalDeviceRegistry.create(1, [config])._unsafeUnwrap(), now: () => now,
  });
  try {
    const before = projectSignalConnectorStatus(connector.status())._unsafeUnwrap();
    expect(before.state).toBe('stopped');
    expect(before.outboundSuspended).toBe(true);
    expect(before.sender).toBeUndefined(); // unavailable is not healthy zero
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(socketPath, done); });
    await fs.chmod(socketPath, 0o600);
    connector.onMessageWithReceipt(() => ok('accepted'));
    await connector.start();
    expect(connector.status().state).toBe('ready');
    const current = accounts.findByAccount(accountUuid)._unsafeUnwrap()!;
    accounts.recordPause(accountUuid, current.revision, { kind: 'challenge' }, now)._unsafeUnwrap();
    const returnedChecking: boolean[] = [];
    const local = new DaemonIpcServer({
      inputDir: path.join(root, 'input'), outputDir: path.join(root, 'output'), errorsDir: path.join(root, 'errors'), logger: pino({ enabled: false }),
      commandHandler: async (command) => {
        if (command.command !== 'signal-resume') throw new Error('Wrong fixture command');
        const result = await connector.resumeChallenge(SignalResumeRequestSchema.parse(command.payload));
        if (result.isOk()) returnedChecking.push(result.value.checking);
        const data = projectSignalResumeResult(result);
        return { id: randomUUID(), commandId: command.id, success: data.outcome === 'verified', data };
      },
    });
    async function invoke(): Promise<Awaited<ReturnType<typeof signalResume>>> {
      const pending = signalResume({ ...payload, ipcDir: root, timeoutMs: 2000 });
      for (let i = 0; i < 100; i++) {
        if ((await local.pollOnce()).length) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      return pending;
    }
    const budget = await invoke();
    expect(budget._unsafeUnwrap()).toEqual({ outcome: 'blocked', reason: 'BUDGET' });
    expect(accounts.findByAccount(accountUuid)._unsafeUnwrap()?.pauseKind).toBe('challenge');
    expect(methods.filter((method) => method === 'listDevices')).toHaveLength(1);
    now += 61000;
    // Deliberate NEW assertion via the real source CLI, not a client retry.
    const child = promisify(execFile)(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'), path.resolve('src/cli/index.ts'),
      'signal-resume', '--channel', 'signal-personal', '--external-challenge-resolved',
      '--ipc-dir', root, '--timeout', '2000',
    ], { cwd: root, timeout: 10000, env: { ...process.env, TALOND_ENV_FILE: path.join(root, 'missing.env') } });
    for (let i = 0; i < 700; i++) {
      if ((await local.pollOnce()).length) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    const verified = await child;
    expect(verified.stdout).toContain('Signal challenge clearance verified by daemon');
    expect(verified.stdout).not.toMatch(/accountUuid|deviceId|aaaaaaaa|bridge.sock/);
    expect(verified.stderr).toBe('');
    expect(returnedChecking).toEqual([true]); // Ok snapshot precedes producer finally; no extra status poll
    expect(accounts.findByAccount(accountUuid)._unsafeUnwrap()?.pauseKind).toBe('none');
    expect(methods.filter((method) => method === 'listDevices')).toHaveLength(2);
    expect(methods).not.toContain('send');
    const projected = projectSignalConnectorStatus(connector.status())._unsafeUnwrap();
    expect(projected.verification?.state).toBe('verified');
    expect(JSON.stringify(projected)).not.toMatch(/nextCheckAt|accountUuid|deviceId/);
  } finally {
    await connector.stopWithResult();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    db.close();
    await fs.rm(socketDirectory, { recursive: true, force: true });
  }
}, 15000);

it.each([0, -1, 1.5, NaN, Infinity, 120001])('bounds direct typed-client timeout before privileged IPC mutation too: %s', async (timeoutMs) => {
  const client = new DaemonIpcClient({ inputDir: path.join(root, 'input'), outputDir: path.join(root, 'output'), timeoutMs });
  expect(await client.signalResume(payload)).toMatchObject({ error: { reason: 'INVALID_REQUEST' } });
  expect(await fs.readdir(root)).toEqual([]);
});

import { parseSignalRpcFrame } from '../../../src/channels/connectors/signal/signal-wire.js';
// Pinned SignalJsonRpcCommandHandler.java:40-44,249-290: safe parser reduces -5/-6
// and discards message/data; a challenge token is never a management diagnostic.
it.each([{ code: -5, reason: 'RATE_LIMITED' }, { code: -6, reason: 'CHALLENGE_REQUIRED' }])('projects actual parsed remote refusal without private evidence: %j', ({ code, reason }) => {
  const frame = parseSignalRpcFrame(Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 'fixture', error: { code, message: 'PRIVATE_BODY', data: { token: 'PRIVATE_TOKEN' } },
  })))._unsafeUnwrap();
  if (frame.kind !== 'failure') throw new Error('Invalid fixture');
  const data = projectSignalResumeResult(err(frame.error));
  expect(data).toEqual({ outcome: 'blocked', reason });
  expect(JSON.stringify(data)).not.toContain('PRIVATE');
});

import { addChannel } from '../../../src/cli/commands/add-channel.js';
import { readConfig } from '../../../src/cli/config-utils.js';
import { ChannelConfigSchema } from '../../../src/core/config/config-schema.js';
import { parseSignalStatusData } from '../../../src/ipc/daemon-ipc.js';
import { SignalRpcTransportError } from '../../../src/channels/connectors/signal/signal-rpc-client.js';

it.each([64, 65, 256])('F2 preserves actual admitted name of length %s through request and connector status', async (length) => {
  const channel = 'a'.repeat(length);
  const filename = path.join(root, 'talond.yaml');
  await fs.writeFile(filename, 'channels: []\n');
  const config = SignalConfigSchema.parse({ accountMode: 'dedicated', socketPath: '/run/signal/bridge.sock',
    account: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', accountUuid: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', deviceId: 1 });
  const entry = await addChannel({ name: channel, type: 'signal', configPath: filename, signalConfig: config });
  expect(ChannelConfigSchema.safeParse(entry).success).toBe(true);
  expect((await readConfig(filename)).channels?.[0]?.name).toBe(channel);
  const db = createTestDb();
  const connector = new SignalConnector(config, entry.name, pino({ enabled: false }), {
    accounts: new SignalAccountStateRepository(db), leases: new SignalDestinationLeaseRepository(db),
    queue: new QueueRepository(db), registry: SignalDeviceRegistry.create(1, [config])._unsafeUnwrap(),
  });
  try {
    const request = { ...payload, channel: entry.name };
    expect.soft(SignalResumeRequestSchema.safeParse(request).success).toBe(true);
    expect.soft(DaemonCommandSchema.safeParse({ id: randomUUID(), command: 'signal-resume', payload: request }).success).toBe(true);
    const status = { channels: [{ channel: entry.name, ...projectSignalConnectorStatus(connector.status())._unsafeUnwrap() }] };
    const parsed = parseSignalStatusData(status);
    expect.soft(parsed.isOk()).toBe(true);
    if (parsed.isOk()) expect(parsed.value.channels?.[0]?.channel).toBe(channel);
  } finally {
    await connector.stopWithResult();
    db.close();
  }
});

it.each([
  'DISCONNECTED', 'TIMEOUT', 'CANCELLED', 'STOPPED', 'CAPACITY', 'INVALID_REQUEST',
  'PROTOCOL_FAILURE', 'FRAME_TOO_LARGE', 'PRE_RESPONSE_OVERFLOW', 'UNTRUSTED_SOCKET',
] as const)('F3 preserves actual transportCode %s instead of inherited delivery reason', (transportCode) => {
  const failure = new SignalRpcTransportError(transportCode);
  expect(failure.transportCode).toBe(transportCode);
  if (transportCode === 'CAPACITY') expect(failure.reason).toBe('RPC_CAPACITY');
  if (transportCode === 'STOPPED') expect(failure.reason).toBe('CANCELLED');
  const data = projectSignalResumeResult(err(failure));
  expect.soft(data).toEqual({ outcome: 'unavailable', reason: transportCode });
  const commandId = randomUUID();
  const guarded = parseSignalResumeResponse({ id: randomUUID(), commandId, success: false, data: { outcome: 'unavailable', reason: transportCode } }, commandId);
  expect.soft(guarded.isOk()).toBe(true);
  expect(data.outcome).not.toBe('verified');
  expect(JSON.stringify(data)).not.toMatch(/cause|socketPath|accountUuid|PRIVATE/);
});

// Pinned 0.14.9 source fixture, same citations as the successful-check fixture above.
// TIMEOUT is a request settlement, not a socket-close notification on listDevices.
it.each(['TIMEOUT', 'DISCONNECTED'] as const)('F3 actual privileged resume %s remains non-success with truthful local CLI output', async (fault) => {
  const directory = await fs.mkdtemp(path.join(os.homedir(), '.talon-resume-fault-fixture-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'bridge.sock');
  const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const config = SignalConfigSchema.parse({ accountMode: 'personal', socketPath, account: accountUuid,
    accountUuid, deviceId: 3, deviceCreatedTimestamp: 200, requestTimeoutMs: 1000 });
  const db = createTestDb();
  const accounts = new SignalAccountStateRepository(db);
  const sockets: Socket[] = [];
  const methods: string[] = [];
  let checks = 0;
  let now = 1000000;
  const bridge = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    let buffer = '';
    socket.on('data', (bytes) => {
      buffer += bytes.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request: unknown = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (typeof request !== 'object' || request === null || !('id' in request) || !('method' in request) || typeof request.method !== 'string') throw new Error('Invalid fixture request');
        methods.push(request.method);
        let result: unknown = {};
        if (request.method === 'version') result = { version: '0.14.9' };
        if (request.method === 'listAccounts') result = [{ number: null, aci: accountUuid }];
        if (request.method === 'subscribeReceive') result = 7;
        if (request.method === 'listDevices') {
          checks++;
          if (checks > 1) {
            if (fault === 'DISCONNECTED') socket.destroy();
            continue;
          }
          result = [
            { id: 1, name: null, createdTimestamp: 1, lastSeenTimestamp: 500 },
            { id: 2, name: null, createdTimestamp: 100, lastSeenTimestamp: 500 },
            { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 },
          ];
        }
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      }
    });
  });
  const connector = new SignalConnector(config, 'signal-personal', pino({ enabled: false }), {
    accounts, leases: new SignalDestinationLeaseRepository(db), queue: new QueueRepository(db),
    registry: SignalDeviceRegistry.create(1, [config])._unsafeUnwrap(), now: () => now,
  });
  try {
    await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(socketPath, done); });
    await fs.chmod(socketPath, 0o600);
    connector.onMessageWithReceipt(() => ok('accepted'));
    await connector.start();
    expect(connector.status().state).toBe('ready');
    const initial = accounts.findByAccount(accountUuid)._unsafeUnwrap()!;
    const challenged = accounts.recordPause(accountUuid, initial.revision, { kind: 'challenge' }, now)._unsafeUnwrap();
    now += 61000;
    const results: Array<Awaited<ReturnType<SignalConnector['resumeChallenge']>>> = [];
    const local = new DaemonIpcServer({
      inputDir: path.join(root, 'input'), outputDir: path.join(root, 'output'), errorsDir: path.join(root, 'errors'), logger: pino({ enabled: false }),
      commandHandler: async (command) => {
        expect(command.command).toBe('signal-resume');
        const result = await connector.resumeChallenge(SignalResumeRequestSchema.parse(command.payload));
        results.push(result);
        const data = projectSignalResumeResult(result);
        return { id: randomUUID(), commandId: command.id, success: data.outcome === 'verified', data };
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const pending = signalResumeCommand({ ...payload, ipcDir: root, timeoutMs: 3000 });
    for (let i = 0; i < 100; i++) {
      if ((await local.pollOnce()).length) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    await pending;
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.isErr()).toBe(true);
    if (result.isErr() && fault === 'TIMEOUT') {
      expect(result.error).toBeInstanceOf(SignalRpcTransportError);
      expect(result.error).toHaveProperty('transportCode', 'TIMEOUT');
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.destroyed).toBe(false);
      expect(connector.status().state).toBe('ready');
    }
    if (fault === 'DISCONNECTED') {
      expect(sockets[0]?.destroyed).toBe(true);
      expect(connector.status().state).toBe('reconnecting');
    }
    expect(accounts.findByAccount(accountUuid)._unsafeUnwrap()).toMatchObject({ pauseKind: 'challenge', revision: challenged.revision + 1 });
    expect.soft(error.mock.calls.flat().join('\n')).toContain(`unavailable: ${fault}`);
    expect(error.mock.calls.flat().join('\n')).not.toMatch(/bridge.sock|aaaaaaaa|cause|PRIVATE/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
    expect(checks).toBe(2); // startup plus this one fresh assertion, no automatic reassertion
    expect(methods).not.toContain('send');
    expect(await fs.readdir(path.join(root, 'input'))).toEqual([]);
  } finally {
    await connector.stopWithResult();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => bridge.close(() => done()));
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 10000);

import { SignalRpcClient, type SignalRpcResult } from '../../../src/channels/connectors/signal/signal-rpc-client.js';

it.each(['CAPACITY', 'STOPPED', 'CANCELLED', 'PROTOCOL_FAILURE'] as const)('F3 projects %s from the real bounded RPC client/socket, not inherited deliveryReason', async (fault) => {
  const directory = await fs.mkdtemp(path.join(os.homedir(), '.talon-rpc-management-fixture-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'bridge.sock');
  const sockets: Socket[] = [];
  const bridge = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.on('data', () => {
      if (fault === 'PROTOCOL_FAILURE') socket.write('PRIVATE_INVALID_JSON\n');
    });
  });
  const rpc = new SignalRpcClient({ socketPath, requestTimeoutMs: 1000 });
  const pending: Array<Promise<SignalRpcResult>> = [];
  try {
    await new Promise<void>((done, reject) => { bridge.once('error', reject); bridge.listen(socketPath, done); });
    await fs.chmod(socketPath, 0o600);
    expect((await rpc.connect()).isOk()).toBe(true);
    for (let i = 0; i < 100 && sockets.length === 0; i++)
      await new Promise((done) => setTimeout(done, 5));
    expect(sockets).toHaveLength(1);
    const controller = new AbortController();
    const request = { method: 'listDevices' as const, params: { account: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb' } };
    if (fault === 'CAPACITY') for (let i = 0; i < 64; i++) pending.push(rpc.request(request));
    const response = rpc.request(request, { signal: controller.signal });
    if (fault === 'STOPPED') rpc.stop();
    if (fault === 'CANCELLED') controller.abort();
    const result = await response;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(SignalRpcTransportError);
      expect(result.error).toHaveProperty('transportCode', fault);
      const data = projectSignalResumeResult(err(result.error));
      expect(data).toEqual({ outcome: 'unavailable', reason: fault });
      expect(JSON.stringify(data)).not.toContain('PRIVATE');
    }
    if (fault === 'CAPACITY' || fault === 'CANCELLED') {
      expect(sockets[0]?.destroyed).toBe(false);
    }
  } finally {
    rpc.stop();
    await Promise.all(pending);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => bridge.close(() => done()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 10000);
