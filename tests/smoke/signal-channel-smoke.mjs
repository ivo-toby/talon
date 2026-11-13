#!/usr/bin/env node
// Packaged Signal fake smoke (no cost, no real Signal account).
//
// Boots the BUILT daemon (node dist/index.js) against:
//   - a private Unix-socket fake signal-cli JSON-RPC bridge whose wire shapes come from the one
//     shared fixture module .agents/skills/run-talon-smoke/scripts/signal-wire-fixtures.mjs
//     (pinned v0.14.9 citations; the conformance test parses the same builders through the
//     production parser/policy);
//   - a fake codex-cli provider (counts invocations in a private log).
// Everything lives under a private directory in the home cache, never /tmp, so the connector's
// socket-ancestry trust check (signal-socket-trust.ts) accepts the socket. The trust rule
// requires an owner-only socket with no group/other bits and a 0700 parent; this harness does not
// depend on the exact socket mode (it creates 0600 and a 0700 parent).
// Assertions observe only external effects: bridge-received RPCs, provider invocation log and
// SQLite rows. Diagnostics never echo raw RPC frames, envelopes, identifiers or message text.
//
// Scenarios run concurrently, each with its own root, bridge, daemon and database.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_VERSION,
  dmEnvelope,
  groupEnvelope,
  ioError,
  listAccountsRows,
  listContactsRow,
  listDevicesRows,
  listGroupsRow,
  methodNotFoundError,
  rateLimitError,
  receiveException,
  receiveParams,
  sendSuccessResult,
  syncEnvelope,
  userError,
} from '../../.agents/skills/run-talon-smoke/scripts/signal-wire-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

const NUMBER = '+15550000001';
const NUMBER_CHANGED = '+15550000002';
const PEER = randomUUID();
const STRANGER = randomUUID();
const GROUP_ONE = Buffer.alloc(32, 1).toString('base64');
const GROUP_TWO = Buffer.alloc(32, 2).toString('base64');
const UNSUBSCRIBE_TIMEOUT_MS = 5_000;
const STEP_TIMEOUT_MS = 30_000;
// One device check per account per 60 s (design proof-refresh budget) plus scheduling slack.
const RESUBSCRIBE_TIMEOUT_MS = 120_000;
const SETTLE_MS = 1_000;
const HARNESS_DEADLINE_MS = 20 * 60_000;
const PROOF_TTL_MS = 300_000; // signal-device-registry.ts:75, signal-account-verifier.ts:541.
const MAX_CHUNK_BYTES = 2_000; // ServiceConfig.java:24 MAX_MESSAGE_SIZE_BYTES.

const LONG_BODY =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(60) + '€'.repeat(500) + ' END';
const LONGX_BODY = LONG_BODY.repeat(4);
const expectedReply = (marker) =>
  `Reply to SMOKE-${marker}` +
  (marker.startsWith('LONGX')
    ? `: ${LONGX_BODY}`
    : marker.startsWith('LONG')
      ? `: ${LONG_BODY}`
      : '');

let failures = 0;
const log = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------------------------
// Resource registry: every exit path (success, failure, SIGINT, SIGTERM, uncaught error, exit)
// kills each detached daemon's process group, closes bridges and removes private roots.
// ---------------------------------------------------------------------------------------------
const live = { daemons: new Set(), bridges: new Set(), roots: new Set() };

function killGroups() {
  for (const daemon of live.daemons) {
    try {
      process.kill(-daemon.pid, 'SIGKILL');
    } catch {}
  }
}
function removeRoots() {
  if (process.env.SIGNAL_SMOKE_KEEP === '1') return;
  for (const root of live.roots) rmSync(root, { recursive: true, force: true });
}
function emergency(code, reason) {
  log(`FAIL harness ${reason}; killing daemons and removing disposable state`);
  killGroups();
  for (const bridge of live.bridges) bridge.destroyNow();
  removeRoots();
  process.exit(code);
}
process.on('SIGINT', () => emergency(130, 'interrupted (SIGINT)'));
process.on('SIGTERM', () => emergency(143, 'terminated (SIGTERM)'));
process.on('uncaughtException', () => emergency(1, 'uncaught error'));
process.on('unhandledRejection', () => emergency(1, 'unhandled rejection'));
process.on('exit', () => {
  // Last resort for any path that reached exit without the async cleanup.
  killGroups();
  removeRoots();
});
setTimeout(() => emergency(1, 'overall deadline exceeded'), HARNESS_DEADLINE_MS).unref();

/** Private, mode-restricted root. The socket parent must be 0700 and every ancestor must be
 * non-group/other-writable (signal-socket-trust.ts). ~/.cache satisfies that; /tmp does not. */
function createPrivateRoot() {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'talon-signal-smoke-'));
  chmodSync(root, 0o700);
  live.roots.add(root);
  return root;
}

function writeProviderScript(root) {
  const scriptPath = join(root, 'fake-codex.mjs');
  const providerLog = join(root, 'provider-invocations.log');
  const eventLog = join(root, 'provider-events.log');
  // Mirrors the existing run-talon-smoke fake: JSONL on stdout plus the -o last-message file.
  // The marker is the last SMOKE-<id> token in the prompt (the current inbound message).
  // Markers G1..G4 form pairs (G1/G2, G3/G4): each run holds until its partner has been invoked
  // (bounded wait, recorded) so overlap is proven by the provider's own event log.
  const script = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
const outputFlagIndex = args.indexOf('-o');
const outputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : undefined;
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const matches = [...input.matchAll(/SMOKE-([A-Z0-9-]+)/g)];
const marker = matches.length > 0 ? matches[matches.length - 1][1] : 'UNKNOWN';
const event = (name) => appendFileSync(${JSON.stringify(eventLog)}, JSON.stringify({ event: name, marker, t: Date.now() }) + '\\n', 'utf8');
appendFileSync(${JSON.stringify(providerLog)}, marker + '\\n', 'utf8');
event('start');
const pair = /^G([0-9])$/.exec(marker);
if (pair) {
  const n = Number(pair[1]);
  const partner = 'G' + (n % 2 === 1 ? n + 1 : n - 1);
  const deadline = Date.now() + 20000;
  const seen = () => existsSync(${JSON.stringify(providerLog)}) && readFileSync(${JSON.stringify(providerLog)}, 'utf8').split('\\n').includes(partner);
  while (!seen() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!seen()) event('hold-timeout');
}
const longBody = ${JSON.stringify(LONG_BODY)};
const longXBody = ${JSON.stringify(LONGX_BODY)};
const response = marker.startsWith('LONGX') ? 'Reply to SMOKE-' + marker + ': ' + longXBody
  : marker.startsWith('LONG') ? 'Reply to SMOKE-' + marker + ': ' + longBody
  : 'Reply to SMOKE-' + marker;
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, response + '\\n', 'utf8');
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'signal-smoke-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'assistant_message', content: [{ type: 'output_text', text: response }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 9 } }) + '\\n');
event('end');
`;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return { scriptPath, providerLog, eventLog };
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}
const readInvocations = (provider) => readLines(provider.providerLog);
const readEvents = (provider) => readLines(provider.eventLog).map((line) => JSON.parse(line));
const providerCount = (provider, marker) =>
  readInvocations(provider).filter((entry) => entry === marker).length;

function writeConfig(root, { mode, socketPath, aci, account, deviceCreated, provider }) {
  const systemPrompt = join(root, 'system.md');
  writeFileSync(
    systemPrompt,
    '---\ndescription: Signal fake smoke persona.\n---\n\nReply with the text you are given.\n',
  );
  const personal = mode === 'personal';
  const channel = {
    type: 'signal',
    name: 'signal-main',
    enabled: true,
    config: {
      accountMode: mode,
      socketPath,
      account,
      accountUuid: aci,
      deviceId: personal ? 2 : 1,
      ...(personal ? { deviceCreatedTimestamp: deviceCreated } : {}),
      allowedDmPeers: [PEER],
      allowedSenders: [PEER],
      allowedGroups: [GROUP_ONE, GROUP_TWO],
      triggerPrefix: '!talon',
      requestTimeoutMs: 5_000,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1_000,
    },
  };
  // JSON is a YAML 1.2 subset; the loader accepts it and it avoids quoting bugs.
  const config = {
    dataDir: join(root, 'data'),
    storage: { type: 'sqlite', path: join(root, 'data', 'talond.sqlite') },
    channels: [channel],
    personas: [
      {
        name: 'signal',
        model: 'signal-smoke-model',
        provider: 'codex-cli',
        systemPromptFile: systemPrompt,
        skills: [],
        subagents: [],
        capabilities: { allow: ['channel.send:signal', 'memory.access:*'] },
        maxConcurrent: 5,
      },
    ],
    bindings: [{ persona: 'signal', channel: 'signal-main', isDefault: true }],
    ipc: { pollIntervalMs: 250, daemonSocketDir: join(root, 'data', 'ipc', 'daemon') },
    queue: { maxAttempts: 3, backoffBaseMs: 250, backoffMaxMs: 1000, concurrencyLimit: 5 },
    agentRunner: {
      defaultProvider: 'codex-cli',
      providers: {
        'codex-cli': {
          enabled: true,
          command: provider.scriptPath,
          contextWindowTokens: 100000,
          contextManagement: { enabled: false },
          options: { defaultModel: 'signal-smoke-model' },
        },
      },
    },
    backgroundAgent: {
      enabled: false,
      maxConcurrent: 1,
      defaultTimeoutMinutes: 30,
      defaultProvider: 'codex-cli',
      providers: {
        'codex-cli': {
          enabled: true,
          command: provider.scriptPath,
          contextWindowTokens: 100000,
          options: { defaultModel: 'signal-smoke-model' },
        },
      },
    },
    scheduler: { tickIntervalMs: 1000 },
    logLevel: 'info',
  };
  const configPath = join(root, 'talond-signal.yaml');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const envFile = join(root, 'empty.env');
  writeFileSync(envFile, '', { mode: 0o600 });
  return { configPath, envFile };
}

/** Fake signal-cli JSON-RPC bridge over a private Unix socket. Wire shapes come from the shared
 * fixture module; this file only decides WHEN to answer, delay, refuse or stall. */
function createFakeBridge({ socketPath, aci, number: initialNumber, devices }) {
  const sockets = new Set();
  const requests = [];
  const unexpected = [];
  const sends = [];
  const listDevicesCalls = [];
  const emittedAccounts = [];
  let number = initialNumber;
  let server = null;
  let nextSubscription = 0; // SignalJsonRpcDispatcherHandler.java:158 AtomicInteger(0), :165 getAndIncrement.
  let subscription = null; // { socket, id }
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  let listDevicesFailing = false;
  let sendDelayMs = 0;
  let sendPolicy = () => 'ok';
  let deviceRows = devices;

  const write = (socket, value) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  };
  const reply = (socket, id, result) => write(socket, { id, result });
  const failRpc = (socket, id, error) => write(socket, { id, error });

  const accountMatches = (value) => value === aci || (number !== null && value === number);

  function handleSend(socket, id, params) {
    // SendCommand.java:52,132 / man:156-164: one of recipient, groupId or noteToSelf.
    const recipientUuid = params.noteToSelf === true ? aci : params.recipient?.[0];
    const groupId = params.groupId;
    const record = {
      kind: groupId ? 'group' : params.noteToSelf ? 'self' : 'dm',
      recipientUuid: recipientUuid ?? null,
      groupId: groupId ?? null,
      message: String(params.message ?? ''),
      at: Date.now(),
      outcome: 'pending',
    };
    sends.push(record);
    const action = sendPolicy(record, sends.length - 1);
    if (action === 'hold') {
      record.outcome = 'held';
      return;
    }
    const respond = () => {
      const timestamp = Date.now();
      if (action === 'rate') {
        record.outcome = 'rate_limited';
        failRpc(
          socket,
          id,
          rateLimitError({
            timestamp,
            recipientUuid: recipientUuid ?? aci,
            groupId,
            retryAfterSeconds: 1,
          }),
        );
        return;
      }
      record.outcome = 'accepted';
      reply(
        socket,
        id,
        sendSuccessResult({ timestamp, recipientUuid: recipientUuid ?? aci, groupId }),
      );
    };
    if (sendDelayMs > 0) setTimeout(respond, sendDelayMs);
    else respond();
  }

  function handle(socket, request) {
    const { id, method, params } = request;
    requests.push({ method, at: Date.now() });
    switch (method) {
      case 'version':
        return reply(socket, id, { version: BRIDGE_VERSION });
      case 'listAccounts':
        return reply(socket, id, listAccountsRows({ number, aci }));
      case 'listDevices':
        listDevicesCalls.push(Date.now());
        if (!accountMatches(params?.account)) return failRpc(socket, id, userError('account'));
        if (listDevicesFailing) return failRpc(socket, id, ioError('device read failed'));
        return reply(socket, id, listDevicesRows(deviceRows));
      case 'subscribeReceive': {
        if (!accountMatches(params?.account)) return failRpc(socket, id, userError('account'));
        const subscriptionId = nextSubscription;
        nextSubscription += 1;
        subscription = { socket, id: subscriptionId };
        subscribeCount += 1;
        return reply(socket, id, subscriptionId);
      }
      case 'unsubscribeReceive':
        unsubscribeCount += 1;
        if (subscription && subscription.id === params?.subscription) subscription = null;
        return reply(socket, id, {});
      case 'listContacts':
        return reply(socket, id, [listContactsRow({ uuid: params?.recipient?.[0] })]);
      case 'listGroups':
        return reply(socket, id, [
          listGroupsRow({ groupId: params?.groupId?.[0], memberAci: aci }),
        ]);
      case 'send':
        return handleSend(socket, id, params ?? {});
      default:
        unexpected.push(String(method));
        return failRpc(socket, id, methodNotFoundError());
    }
  }

  function onSocket(socket) {
    sockets.add(socket);
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (line.length === 0) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          unexpected.push('<unparseable>');
          continue;
        }
        if (request && typeof request === 'object' && 'id' in request) handle(socket, request);
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      if (subscription?.socket === socket) subscription = null;
    });
    socket.on('error', () => {});
  }

  function listen() {
    return new Promise((resolveListen, rejectListen) => {
      const next = createServer(onSocket);
      next.once('error', rejectListen);
      next.listen(socketPath, () => {
        chmodSync(socketPath, 0o600); // owner-only; the trust rule accepts 0600 or 0700 (no group/other).
        server = next;
        resolveListen();
      });
    });
  }
  const closeServer = () =>
    new Promise((resolveClose) => (server ? server.close(() => resolveClose()) : resolveClose()));

  const bridge = {
    start: listen,
    async restart() {
      subscription = null;
      for (const socket of sockets) socket.destroy();
      await closeServer();
      server = null;
      await sleep(300);
      await listen();
    },
    /** Emit one manual-mode receive notification for the active subscription. */
    emit({ envelope, exception }) {
      if (!subscription) throw new Error('no active subscription');
      const params = receiveParams({
        subscription: subscription.id,
        number,
        aci,
        envelope,
        exception,
      });
      emittedAccounts.push(params.result.account);
      write(subscription.socket, { method: 'receive', params });
    },
    setNumber(next) {
      number = next;
    },
    setListDevicesFailing(value) {
      listDevicesFailing = value;
    },
    setDevices(rows) {
      deviceRows = rows;
    },
    setSendDelay(ms) {
      sendDelayMs = ms;
    },
    /** policy(record, index) -> 'ok' | 'rate' | 'hold'. */
    setSendPolicy(policy) {
      sendPolicy = policy;
    },
    get hasSubscription() {
      return subscription !== null;
    },
    get listening() {
      return server?.listening === true;
    },
    get subscribeCount() {
      return subscribeCount;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
    get sends() {
      return sends;
    },
    get unexpected() {
      return unexpected;
    },
    get requests() {
      return requests;
    },
    get emittedAccounts() {
      return emittedAccounts;
    },
    get listDevicesCalls() {
      return listDevicesCalls;
    },
    /** Synchronous teardown for emergency exit paths. */
    destroyNow() {
      for (const socket of sockets) socket.destroy();
      try {
        server?.close();
      } catch {}
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await closeServer();
      server = null;
      live.bridges.delete(bridge);
    },
  };
  live.bridges.add(bridge);
  return bridge;
}

const timestamp = (() => {
  let last = Math.max(Date.now(), 3000);
  return () => {
    last += 1;
    return last;
  };
})();

function spawnDaemon(configPath, envFile, root) {
  const out = openSync(join(root, 'daemon.log'), 'a');
  const child = spawn(
    process.execPath,
    [join(ROOT, 'dist/index.js'), '--config', configPath, '--env-file', envFile],
    { cwd: ROOT, stdio: ['ignore', out, out], detached: true },
  );
  const handle = { pid: child.pid, exited: false };
  live.daemons.add(handle);
  child.once('exit', () => {
    handle.exited = true;
  });
  handle.signal = (name) => process.kill(child.pid, name);
  handle.hasExited = () => handle.exited;
  handle.killGroup = async () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    while (!handle.exited) await sleep(50);
  };
  handle.stop = async () => {
    if (!handle.exited) {
      try {
        process.kill(-child.pid, 'SIGINT');
      } catch {}
      const deadline = Date.now() + UNSUBSCRIBE_TIMEOUT_MS;
      while (!handle.exited && Date.now() < deadline) await sleep(100);
      if (!handle.exited) await handle.killGroup();
    }
    // Any provider child that outlived the daemon dies with the group.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  };
  return handle;
}

const processGroupGone = (pid) => {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
};

function openDb(dbPath, { write = false } = {}) {
  const Database = require('better-sqlite3');
  const db = write
    ? new Database(dbPath, { fileMustExist: true })
    : new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}
function dbAll(dbPath, sql, ...params) {
  if (!existsSync(dbPath)) return [];
  const db = openDb(dbPath);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
const dbOne = (dbPath, sql, ...params) => dbAll(dbPath, sql, ...params)[0];

/** Scenario runner. `body(s)` drives the packaged daemon through external effects only. */
async function runScenario(name, options, body) {
  const mode = options.mode ?? 'dedicated';
  const root = createPrivateRoot();
  const aci = randomUUID();
  const aciOnly = options.aciOnly === true;
  const number = aciOnly ? null : NUMBER;
  const socketDir = join(root, 'bridge');
  mkdirSync(socketDir, { mode: 0o700 });
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, 'signal.sock');
  const bridgeCreated = options.bridgeDeviceCreated ?? 2000;
  const devices =
    mode === 'personal'
      ? [
          { id: 1, name: 'phone', createdTimestamp: 1000, lastSeenTimestamp: Date.now() },
          { id: 2, name: 'talon', createdTimestamp: bridgeCreated, lastSeenTimestamp: Date.now() },
        ]
      : [{ id: 1, name: 'talon', createdTimestamp: 1000, lastSeenTimestamp: Date.now() }];
  const provider = writeProviderScript(root);
  for (const dir of ['threads', 'backups', 'ipc/daemon'])
    mkdirSync(join(root, 'data', dir), { recursive: true });
  const { configPath, envFile } = writeConfig(root, {
    mode,
    socketPath,
    aci,
    account: aciOnly ? aci : NUMBER,
    deviceCreated: 2000,
    provider,
  });
  const bridge = createFakeBridge({ socketPath, aci, number, devices });
  const dbPath = join(root, 'data', 'talond.sqlite');
  const daemons = [];
  let stage = `${name} setup`;
  const label = (text) => `${name}: ${text}`;
  const s = {
    name,
    mode,
    root,
    aci,
    bridge,
    provider,
    dbPath,
    daemon: null,
    me: { uuid: aci, number },
    peer: { uuid: PEER, number: null },
    stranger: { uuid: STRANGER, number: null },
    step(text) {
      stage = `${name}: ${text}`;
    },
    check(text, condition, detail) {
      if (condition) log(`PASS ${label(text)}`);
      else {
        failures += 1;
        log(`FAIL ${label(text)}${detail ? `: ${detail}` : ''}`);
      }
      return condition;
    },
    note: (text) => log(`INFO ${label(text)}`),
    timestamp,
    expectedReply,
    sendsFrom: (index) => bridge.sends.slice(index),
    sendCount: (predicate) => bridge.sends.filter(predicate).length,
    isNotice: (send) => send.message === 'Thinking...',
    async awaitSend(predicate, text, timeout = STEP_TIMEOUT_MS) {
      s.step(text);
      await waitFor(() => bridge.sends.some(predicate), timeout, text);
    },
    async awaitInvocation(marker, text, timeout = STEP_TIMEOUT_MS) {
      s.step(text);
      await waitFor(() => providerCount(provider, marker) >= 1, timeout, text);
    },
    providerCount: (marker) => providerCount(provider, marker),
    invocations: () => readInvocations(provider),
    events: () => readEvents(provider),
    dm(author, device, message) {
      return dmEnvelope({ author, device, message, timestamp: timestamp() });
    },
    group(author, device, message, groupId) {
      return groupEnvelope({ author, device, message, timestamp: timestamp(), groupId });
    },
    sync(device, destination, message, groupId) {
      return syncEnvelope({
        author: s.me,
        device,
        destination,
        message,
        timestamp: timestamp(),
        groupId,
      });
    },
    emit: (envelope) => bridge.emit({ envelope }),
    db: (sql, ...params) => dbAll(dbPath, sql, ...params),
    dbOne: (sql, ...params) => dbOne(dbPath, sql, ...params),
    openWritableDb: () => openDb(dbPath, { write: true }),
    async startDaemon() {
      const daemon = spawnDaemon(configPath, envFile, root);
      daemons.push(daemon);
      s.daemon = daemon;
      return daemon;
    },
    async awaitSubscribed(text, timeout = STEP_TIMEOUT_MS) {
      s.step(text);
      const before = bridge.subscribeCount;
      await waitFor(() => bridge.subscribeCount > before || s.daemon.hasExited(), timeout, text);
      if (s.daemon.hasExited() || !bridge.hasSubscription)
        throw new Error(`${text}: no subscription`);
      await sleep(500);
    },
    async restartBridge() {
      const before = bridge.subscribeCount;
      await bridge.restart();
      // The shared device-check budget allows one listDevices per account per 60 s including
      // reconnects (design proof-refresh budget); resubscribe may wait for that slot.
      s.step('resubscribe after bridge restart');
      await waitFor(() => bridge.subscribeCount > before, RESUBSCRIBE_TIMEOUT_MS, s.name);
      await sleep(500);
    },
    /** Exact bookkeeping: every admitted turn is one inbound row, run and outbound row. */
    expectDatabase(admitted, text = 'sqlite rows are exact') {
      const inbound = s.dbOne("select count(*) as c from messages where direction = 'inbound'").c;
      const outbound = s.dbOne("select count(*) as c from messages where direction = 'outbound'").c;
      const runs = s.dbOne('select count(*) as c from runs').c;
      const open = s.dbOne("select count(*) as c from queue_items where status != 'completed'").c;
      const items = s.dbOne('select count(*) as c from queue_items').c;
      s.check(
        text,
        inbound === admitted &&
          outbound === admitted &&
          runs === admitted &&
          items === admitted &&
          open === 0,
        `inbound=${inbound} outbound=${outbound} runs=${runs} queue=${items} open=${open} expected=${admitted}`,
      );
    },
    /** Pinned wire: result.account is the NUMBER when set, the ACI only when numberless. */
    expectAccountForm(allowed, text = 'receive notifications carried the pinned account form') {
      const seen = new Set(bridge.emittedAccounts);
      s.check(
        text,
        seen.size > 0 && [...seen].every((value) => allowed.includes(value)),
        `forms=${[...seen].map((v) => (v === aci ? 'aci' : v)).join(',')}`,
      );
    },
    expectNoUnexpectedRpc() {
      s.check(
        'bridge received only RPCs inside the pinned subset',
        bridge.unexpected.length === 0,
        'unexpected method observed',
      );
    },
  };

  try {
    check_private_socket(s, socketDir, socketPath);
    await bridge.start();
    log(`PASS ${label('bridge listening on private socket')}`);
    await s.startDaemon();
    if (options.expectSubscription !== false) {
      await s.awaitSubscribed('daemon subscribes', STEP_TIMEOUT_MS);
      log(`PASS ${label('daemon subscribes')}`);
    }
    await body(s);
    s.expectNoUnexpectedRpc();
    s.check('daemon still running', !s.daemon.hasExited(), 'daemon exited early');
  } catch (error) {
    failures += 1;
    log(`FAIL ${stage}: ${error instanceof Error ? error.message : 'unknown failure'}`);
  } finally {
    for (const daemon of daemons) await daemon.stop();
    await bridge.stop();
    for (const daemon of daemons) live.daemons.delete(daemon);
    const keep = process.env.SIGNAL_SMOKE_KEEP === '1';
    if (keep) log(`INFO ${label('kept disposable state for debugging')}: ${root}`);
    else rmSync(root, { recursive: true, force: true });
    live.roots.delete(root);
    // The PASS line is a verified fact, not a banner.
    const gone =
      daemons.every((daemon) => processGroupGone(daemon.pid)) &&
      !bridge.listening &&
      !existsSync(socketPath) &&
      (keep || !existsSync(root));
    if (gone)
      log(`PASS ${label('cleanup: daemon process groups, bridge, socket and state are gone')}`);
    else {
      failures += 1;
      log(`FAIL ${label('cleanup: a daemon process group, listener, socket or state remains')}`);
    }
  }
}

function check_private_socket(s, socketDir, socketPath) {
  const mode = statSync(socketDir).mode & 0o777;
  s.check(
    'socket directory is private and outside /tmp',
    (mode & 0o077) === 0 && !socketPath.startsWith('/tmp/'),
    'socket parent must have no group/other bits and not be under /tmp',
  );
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const rebuild = (sends) => sends.map((send) => send.message).join('');
const chunksOf = (sends, predicate) =>
  sends.filter((send) => predicate(send) && send.message !== 'Thinking...');

async function dedicatedScenario(s) {
  const admitted = [];
  const pairOverlapped = (first, second, text) => {
    const events = s.events();
    const start = (marker) => events.find((e) => e.event === 'start' && e.marker === marker)?.t;
    const end = (marker) => events.find((e) => e.event === 'end' && e.marker === marker)?.t;
    const hold = events.filter((e) => e.event === 'hold-timeout').length;
    s.check(
      text,
      hold === 0 &&
        start(first) !== undefined &&
        start(second) !== undefined &&
        end(first) !== undefined &&
        end(second) !== undefined &&
        Math.max(start(first), start(second)) < Math.min(end(first), end(second)),
      `holdTimeouts=${hold}`,
    );
  };

  // Admitted DM: one provider run, one reply to the same peer.
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-DM1'));
  admitted.push('DM1');
  await s.awaitSend(
    (x) => x.recipientUuid === PEER && x.message.includes('Reply to SMOKE-DM1'),
    'DM reply',
  );
  s.check('DM reply sent once', s.sendCount((x) => x.message.includes('SMOKE-DM1')) === 1);
  s.check('DM provider ran once', s.providerCount('DM1') === 1);

  // Excluded inputs: unselected stranger, untriggered DM, and own dedicated transcript echo.
  s.step('excluded inputs');
  const before = s.invocations().length;
  const sendsBefore = s.bridge.sends.length;
  s.emit(s.dm(s.stranger, 1, '!talon SMOKE-STRANGER'));
  s.emit(s.dm(s.peer, 1, 'SMOKE-NOPREFIX'));
  s.emit(s.sync(1, s.peer, '!talon SMOKE-ECHO'));
  await sleep(SETTLE_MS * 2);
  s.check('excluded DM/stranger/echo create no provider run', s.invocations().length === before);
  s.check('excluded inputs send nothing', s.sendsFrom(sendsBefore).length === 0);

  // Two group replies at once: the provider holds each run until its partner is invoked.
  s.emit(s.group(s.peer, 1, '!talon SMOKE-G1', GROUP_ONE));
  s.emit(s.group(s.peer, 1, '!talon SMOKE-G2', GROUP_TWO));
  admitted.push('G1', 'G2');
  await s.awaitSend(
    (x) => x.groupId === GROUP_ONE && x.message.includes('Reply to SMOKE-G1'),
    'group one reply',
  );
  await s.awaitSend(
    (x) => x.groupId === GROUP_TWO && x.message.includes('Reply to SMOKE-G2'),
    'group two reply',
  );
  await sleep(SETTLE_MS);
  s.check(
    'two group replies each sent once',
    s.sendCount((x) => x.message.includes('SMOKE-G1')) === 1 &&
      s.sendCount((x) => x.message.includes('SMOKE-G2')) === 1,
  );
  s.check(
    'two group runs each executed once',
    s.providerCount('G1') === 1 && s.providerCount('G2') === 1,
  );
  pairOverlapped('G1', 'G2', 'two group provider runs overlapped (concurrency 5)');

  // Long Unicode reply: chunks stay within the 2000-byte bound, in order, and rebuild the reply.
  const longFrom = s.bridge.sends.length;
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-LONG1'));
  admitted.push('LONG1');
  s.step('long reply final chunk');
  await waitFor(
    () =>
      s.bridge.sends.some(
        (x) => x.kind === 'dm' && x.recipientUuid === PEER && x.message.endsWith(' END'),
      ),
    STEP_TIMEOUT_MS,
    'long reply final chunk',
  );
  await sleep(SETTLE_MS);
  const chunks = chunksOf(
    s.sendsFrom(longFrom),
    (x) => x.kind === 'dm' && x.recipientUuid === PEER,
  );
  s.check(
    'long reply chunks within 2000 bytes',
    chunks.every((c) => Buffer.byteLength(c.message, 'utf8') <= MAX_CHUNK_BYTES),
  );
  s.check(
    'long reply chunks rebuild the reply exactly, in order',
    rebuild(chunks) === expectedReply('LONG1') && chunks.length >= 3,
    `chunks=${chunks.length}`,
  );

  // Bridge restart: daemon reconnects, re-subscribes, and a group pair still replies once each.
  await s.restartBridge();
  s.emit(s.group(s.peer, 1, '!talon SMOKE-G3', GROUP_ONE));
  s.emit(s.group(s.peer, 1, '!talon SMOKE-G4', GROUP_TWO));
  admitted.push('G3', 'G4');
  await s.awaitSend(
    (x) => x.groupId === GROUP_ONE && x.message.includes('Reply to SMOKE-G3'),
    'group three reply after restart',
    RESUBSCRIBE_TIMEOUT_MS,
  );
  await s.awaitSend(
    (x) => x.groupId === GROUP_TWO && x.message.includes('Reply to SMOKE-G4'),
    'group four reply after restart',
  );
  await sleep(SETTLE_MS);
  s.check(
    'group pair after bridge restart replies once each',
    s.sendCount((x) => x.message.includes('SMOKE-G3')) === 1 &&
      s.sendCount((x) => x.message.includes('SMOKE-G4')) === 1 &&
      s.providerCount('G3') === 1 &&
      s.providerCount('G4') === 1,
  );
  pairOverlapped('G3', 'G4', 'group pair after restart overlapped');
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-AFTER'));
  admitted.push('AFTER');
  await s.awaitSend((x) => x.message.includes('Reply to SMOKE-AFTER'), 'reply after restart');
  s.check(
    'reply after bridge restart sent once',
    s.sendCount((x) => x.message.includes('SMOKE-AFTER')) === 1,
  );

  // Per-message receive fault: an exception-only notification does not block later chats.
  s.bridge.emit({ exception: receiveException('simulated receive fault') });
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-POSTFAULT'));
  admitted.push('POSTFAULT');
  await s.awaitSend(
    (x) => x.message.includes('Reply to SMOKE-POSTFAULT'),
    'reply after receive fault',
  );
  s.check(
    'receive fault does not block later DM',
    s.sendCount((x) => x.message.includes('SMOKE-POSTFAULT')) === 1,
  );

  // Number alias change: listAccounts now reports a different number for the same ACI and the
  // receive notification carries the new number. No reconnect, one reply.
  const subscribesBefore = s.bridge.subscribeCount;
  s.bridge.setNumber(NUMBER_CHANGED);
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-ALIAS'));
  admitted.push('ALIAS');
  await s.awaitSend((x) => x.message.includes('Reply to SMOKE-ALIAS'), 'reply after number change');
  s.check(
    'number change replies once',
    s.sendCount((x) => x.message.includes('SMOKE-ALIAS')) === 1 && s.providerCount('ALIAS') === 1,
  );
  s.check(
    'number change refreshes aliases without reconnect',
    s.bridge.subscribeCount === subscribesBefore && s.bridge.unsubscribeCount === 0,
  );

  await sleep(SETTLE_MS);
  const invoked = s.invocations();
  s.check(
    'total provider runs equal admitted inputs (no extra run)',
    invoked.length === admitted.length && admitted.every((m) => invoked.includes(m)),
    `runs=${invoked.length} expected=${admitted.length}`,
  );
  s.expectAccountForm([NUMBER, NUMBER_CHANGED]);
  s.expectDatabase(admitted.length);
}

async function personalScenario(s) {
  const admitted = [];
  // Note to Self is the sync transcript sentMessage with destination = the account itself,
  // typed on the human phone (device 1). It needs no trigger prefix.
  s.emit(s.sync(1, s.me, 'SMOKE-NTS1'));
  admitted.push('NTS1');
  await s.awaitSend(
    (x) => x.kind === 'self' && x.message.includes('Reply to SMOKE-NTS1'),
    'note to self reply',
  );
  s.check(
    'note to self reply sent once',
    s.sendCount((x) => x.message.includes('SMOKE-NTS1')) === 1,
  );
  s.check('note to self provider ran once', s.providerCount('NTS1') === 1);

  // Echo of our own reply arrives from the bridge device (2); it must not start another run.
  let before = s.invocations().length;
  s.emit(s.sync(2, s.me, 'Reply to SMOKE-NTS1'));
  await sleep(SETTLE_MS * 2);
  s.check('bridge-device echo creates no extra run', s.invocations().length === before);

  // Operator command typed on the human device, addressed to a selected DM.
  s.emit(s.sync(1, s.peer, '!talon SMOKE-SYNC1'));
  admitted.push('SYNC1');
  await s.awaitSend(
    (x) =>
      x.kind === 'dm' && x.recipientUuid === PEER && x.message.includes('Reply to SMOKE-SYNC1'),
    'linked-device command reply',
  );
  s.check(
    'linked-device command replies once',
    s.sendCount((x) => x.message.includes('SMOKE-SYNC1')) === 1,
  );

  // Personal group command: the human's own group message (sync transcript with groupInfo).
  s.emit(s.sync(1, undefined, '!talon SMOKE-PG1', GROUP_ONE));
  admitted.push('PG1');
  await s.awaitSend(
    (x) =>
      x.kind === 'group' && x.groupId === GROUP_ONE && x.message.includes('Reply to SMOKE-PG1'),
    'personal group command reply',
  );
  s.check(
    'personal group command replies once',
    s.sendCount((x) => x.message.includes('SMOKE-PG1')) === 1 && s.providerCount('PG1') === 1,
  );

  // Excluded: untriggered group chatter from the human is not a command.
  before = s.invocations().length;
  s.emit(s.sync(1, undefined, 'SMOKE-PGNOPREFIX', GROUP_ONE));
  await sleep(SETTLE_MS * 2);
  s.check('personal untriggered group message creates no run', s.invocations().length === before);

  // Personal restart/reconnect: Note to Self still works after the bridge restarts.
  await s.restartBridge();
  s.emit(s.sync(1, s.me, 'SMOKE-NTS2'));
  admitted.push('NTS2');
  await s.awaitSend(
    (x) => x.kind === 'self' && x.message.includes('Reply to SMOKE-NTS2'),
    'note to self reply after restart',
    RESUBSCRIBE_TIMEOUT_MS,
  );
  s.check(
    'personal reply after bridge restart sent once',
    s.sendCount((x) => x.message.includes('SMOKE-NTS2')) === 1,
  );

  await sleep(SETTLE_MS);
  s.check(
    'personal total provider runs equal admitted inputs',
    s.invocations().length === admitted.length,
    `runs=${s.invocations().length} expected=${admitted.length}`,
  );
  // Progress ("Thinking...") is suppressed in personal mode: every send is a reply, one per run.
  s.check(
    'personal progress text absent: sends equal replies',
    s.bridge.sends.length === admitted.length &&
      s.bridge.sends.every((x) => x.message.startsWith('Reply to SMOKE-')),
    `sends=${s.bridge.sends.length} replies=${admitted.length}`,
  );
  s.expectAccountForm([NUMBER]);
  s.expectDatabase(admitted.length);
}

async function staleDeviceScenario(s) {
  // Bridge device 2 is created at 2500 but the configured device creation timestamp is 2000.
  s.step('stale device setup refused');
  await waitFor(
    () => s.bridge.requests.some((r) => r.method === 'listDevices') || s.daemon.hasExited(),
    STEP_TIMEOUT_MS,
    'device check',
  );
  await sleep(SETTLE_MS * 4);
  s.check('stale device setup is refused: no subscribeReceive', s.bridge.subscribeCount === 0);
  s.check('stale device setup sends nothing', s.bridge.sends.length === 0);
  s.check('refused setup stayed up for the operator (no crash loop)', !s.daemon.hasExited());
}

async function aciOnlyScenario(s) {
  // Numberless account: listAccounts number null and receive account is the ACI
  // (ListAccountsCommand.java:34, Manager.java:104-107 getSelfIdentifier falls back to the ACI).
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-ACI1'));
  await s.awaitSend(
    (x) => x.recipientUuid === PEER && x.message.includes('Reply to SMOKE-ACI1'),
    'ACI-only DM reply',
  );
  s.check(
    'ACI-only account replies once',
    s.sendCount((x) => x.message.includes('SMOKE-ACI1')) === 1 && s.providerCount('ACI1') === 1,
  );
  await sleep(SETTLE_MS);
  s.expectAccountForm([s.aci]);
  s.expectDatabase(1);
}

async function rollbackScenario(s) {
  // Hold an exclusive write lock so the daemon's ingress transaction fails (busy_timeout 5 s),
  // rolls back, and is retried by the receipt buffer after the lock is released.
  const lock = s.openWritableDb();
  s.step('hold write lock during ingress');
  lock.exec('BEGIN IMMEDIATE');
  let released = 0;
  try {
    s.emit(s.dm(s.peer, 1, '!talon SMOKE-RB1'));
    await sleep(2 * 5_000 + 1_000); // >= 2x the daemon's 5 s busy timeout
    s.check(
      'no provider run while ingress is blocked',
      s.providerCount('RB1') === 0 && s.bridge.sends.length === 0,
    );
  } finally {
    lock.exec('ROLLBACK');
    released = Date.now();
    lock.close();
  }
  // Observable retry signal: the daemon logs a fixed, content-free warning for every failed
  // (rolled back) ingress attempt. At least one must precede the release.
  const failedAttempts = readLines(join(s.root, 'daemon.log'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    })
    .filter((entry) => entry.reason === 'LOCAL_ACCEPTANCE_FAILED' && entry.time < released);
  s.check(
    'ingress failed and rolled back before the lock was released (logged LOCAL_ACCEPTANCE_FAILED)',
    failedAttempts.length >= 1,
    `failedAttempts=${failedAttempts.length}`,
  );
  await s.awaitSend((x) => x.message.includes('Reply to SMOKE-RB1'), 'reply after lock release');
  await sleep(SETTLE_MS * 2);
  s.check(
    'rollback retry yields exactly one provider run',
    s.providerCount('RB1') === 1,
    `runs=${s.providerCount('RB1')}`,
  );
  s.check(
    'rollback retry yields exactly one reply',
    s.sendCount((x) => x.message.includes('SMOKE-RB1')) === 1,
  );
  s.check(
    'the run began only after the lock was released',
    (s.events().find((e) => e.event === 'start')?.t ?? 0) >= released,
  );
  s.expectDatabase(
    1,
    'rollback retry produced exactly one accepted turn (one inbound row, run, outbound row)',
  );
}

const deferredItem = (s) =>
  s.dbOne(
    "select id, status, attempts, max_attempts, next_retry_at, error from queue_items where error = 'SIGNAL_DELIVERY_DEFERRED' and status = 'failed'",
  );
const pauseRow = (s) => s.dbOne('select rate_limit_not_before from signal_account_state');

/** Waits for a NEW delivery deferral (not the stale row of an earlier, already fast-forwarded
 * round: next_retry_at and the pause are both far in the future), then asserts that the persisted
 * rate-limit pause exists and that no send happens while it is active. */
async function awaitPausedDeferral(s, label) {
  s.step(label);
  const far = () => Date.now() + 60_000;
  await waitFor(
    () => {
      const item = deferredItem(s);
      const pause = pauseRow(s);
      return (
        item !== undefined &&
        pause !== undefined &&
        item.next_retry_at > far() &&
        pause.rate_limit_not_before > far()
      );
    },
    STEP_TIMEOUT_MS,
    label,
  );
  const item = deferredItem(s);
  const sendsBefore = s.bridge.sends.length;
  await sleep(2_000);
  s.check(
    `${label}: persisted rate-limit pause is active and nothing is sent during it`,
    pauseRow(s).rate_limit_not_before > Date.now() && s.bridge.sends.length === sendsBefore,
  );
  return item;
}

/** Simulated elapsed time: clears the persisted pause and makes the deferred item due. The
 * account-state revision is bumped like every repository write; last_send_start is left alone. */
function fastForwardPause(s, item) {
  const db = s.openWritableDb();
  try {
    const now = Date.now();
    db.prepare(
      'UPDATE signal_account_state SET rate_limit_not_before = 0, recovery_not_before = 0, revision = revision + 1, updated_at = ?',
    ).run(now);
    db.prepare('UPDATE queue_items SET next_retry_at = ? WHERE id = ?').run(now, item.id);
  } finally {
    db.close();
  }
}

async function deferralScenario(s) {
  // The pinned rate-limit error (code -5, data.response RATE_LIMIT_FAILURE) is returned for the
  // reply four times. Each is a delivery-only deferral (no provider attempt) with maxAttempts 3.
  // The persisted rate-limit pause is >= 15 minutes, so the harness fast-forwards that persisted
  // state between rounds (simulated elapsed time) instead of waiting.
  let limited = 0;
  s.bridge.setSendPolicy((send) => {
    if (send.message.includes('Reply to SMOKE-DEFER1') && limited < 4) {
      limited += 1;
      return 'rate';
    }
    return 'ok';
  });
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-DEFER1'));
  for (let round = 1; round <= 4; round += 1) {
    const item = await awaitPausedDeferral(s, `deferral ${round}`);
    s.check(
      `deferral ${round} is saved delivery-only (attempts stay below max)`,
      limited === round && item.attempts < item.max_attempts && s.providerCount('DEFER1') === 1,
      `attempts=${item.attempts}/${item.max_attempts} runs=${s.providerCount('DEFER1')}`,
    );
    fastForwardPause(s, item);
  }
  await s.awaitSend(
    (x) => x.outcome === 'accepted' && x.message.includes('Reply to SMOKE-DEFER1'),
    'delivery after four deferrals',
  );
  await sleep(SETTLE_MS * 2);
  const attempts = s.sendCount((x) => x.message.includes('SMOKE-DEFER1'));
  s.check(
    'five send attempts: four rate-limited, one accepted',
    attempts === 5 &&
      limited === 4 &&
      s.sendCount((x) => x.outcome === 'accepted' && x.message.includes('SMOKE-DEFER1')) === 1,
    `attempts=${attempts}`,
  );
  s.check(
    'one provider run despite four deferrals (maxAttempts 3)',
    s.providerCount('DEFER1') === 1,
  );
  s.expectDatabase(1);
}

async function chunkResumeScenario(s) {
  // A long multi-chunk reply gets the pinned rate-limit error on chunk 3. The saved cursor must
  // resume at chunk 3 after the (fast-forwarded) pause: chunks 1-2 are never resent, chunks 3..n
  // are each accepted exactly once, and the provider is not run again.
  let attempts = 0;
  s.bridge.setSendPolicy((send) => {
    if (send.message === 'Thinking...') return 'ok';
    attempts += 1;
    return attempts === 3 ? 'rate' : 'ok';
  });
  s.emit(s.group(s.peer, 1, '!talon SMOKE-LONGX2', GROUP_ONE));
  const item = await awaitPausedDeferral(s, 'rate limit on chunk 3');
  const replies = () => s.bridge.sends.filter((x) => x.message !== 'Thinking...');
  const beforeResume = replies();
  s.check(
    'before the deferral exactly chunks 1-2 were accepted once and chunk 3 was refused',
    beforeResume.length === 3 &&
      beforeResume[0].outcome === 'accepted' &&
      beforeResume[1].outcome === 'accepted' &&
      beforeResume[2].outcome === 'rate_limited',
    `outcomes=${beforeResume.map((x) => x.outcome).join(',')}`,
  );
  s.check(
    'deferral kept attempts below max with one provider run',
    item.attempts < item.max_attempts && s.providerCount('LONGX2') === 1,
    `attempts=${item.attempts}/${item.max_attempts}`,
  );
  fastForwardPause(s, item);
  s.step('delivery resumes from the saved cursor');
  await waitFor(
    () => replies().some((x) => x.message.endsWith(' END') && x.outcome === 'accepted'),
    STEP_TIMEOUT_MS * 2,
    'final chunk after resume',
  );
  await sleep(SETTLE_MS * 2);
  const all = replies();
  const accepted = all.filter((x) => x.outcome === 'accepted');
  s.check(
    'resume re-sends only the refused chunk 3 (one retry, same text), nothing earlier',
    all.length === accepted.length + 1 &&
      all[3].outcome === 'accepted' &&
      all[3].message === all[2].message &&
      all[3].message !== all[0].message &&
      all[3].message !== all[1].message,
    `sends=${all.length} accepted=${accepted.length}`,
  );
  s.check(
    'chunks 3..n each accepted exactly once; the reply rebuilds byte-exactly',
    accepted.length >= 5 && rebuild(accepted) === expectedReply('LONGX2'),
    `accepted=${accepted.length}`,
  );
  s.check('exactly one provider run', s.providerCount('LONGX2') === 1);
  s.expectDatabase(1, 'queue item completed after resume (exact sqlite rows)');
}

async function chunkFairnessScenario(s) {
  // A very long group-one reply (many chunks, saved cursor) is interleaved with a short group-two
  // reply. Chunks of group one stay contiguous and ordered; group two is not starved.
  s.bridge.setSendDelay(150);
  const from = s.bridge.sends.length;
  s.emit(s.group(s.peer, 1, '!talon SMOKE-LONGX1', GROUP_ONE));
  await s.awaitSend(
    (x) => x.groupId === GROUP_ONE && x.message.startsWith('Reply to SMOKE-LONGX1'),
    'first chunk of the long reply',
  );
  s.emit(s.group(s.peer, 1, '!talon SMOKE-S2', GROUP_TWO));
  s.step('both groups delivered');
  await waitFor(
    () =>
      s.bridge.sends.some(
        (x) => x.groupId === GROUP_ONE && x.message.endsWith(' END') && x.outcome === 'accepted',
      ) &&
      s.bridge.sends.some(
        (x) => x.groupId === GROUP_TWO && x.message.includes('Reply to SMOKE-S2'),
      ),
    STEP_TIMEOUT_MS * 3,
    'both groups delivered',
  );
  await sleep(SETTLE_MS * 2);
  const sends = s.sendsFrom(from).filter((x) => x.message !== 'Thinking...');
  const one = sends.filter((x) => x.groupId === GROUP_ONE);
  const two = sends.filter((x) => x.groupId === GROUP_TWO);
  s.check(
    'group one chunks are contiguous, ordered and rebuild the reply exactly',
    rebuild(one) === expectedReply('LONGX1') && one.length >= 5,
    `chunks=${one.length}`,
  );
  s.check(
    'every chunk is within 2000 bytes',
    one.every((x) => Buffer.byteLength(x.message, 'utf8') <= MAX_CHUNK_BYTES),
  );
  s.check(
    'group two replied exactly once',
    two.length === 1 && two[0].message === expectedReply('S2'),
  );
  s.check(
    'other-group reply is not starved behind the long reply',
    sends.indexOf(two[0]) < sends.indexOf(one[one.length - 1]),
    `groupTwoAt=${sends.indexOf(two[0])} lastChunkAt=${sends.indexOf(one[one.length - 1])}`,
  );
  s.check('one provider run each', s.providerCount('LONGX1') === 1 && s.providerCount('S2') === 1);
  s.expectDatabase(2);
}

async function crashMarkerScenario(s) {
  // SIGKILL the daemon while a chunk RPC is in flight (the bridge never answers it). After
  // restart the in-flight chunk is classified uncertain and terminal: nothing is replayed.
  let chunkIndex = 0;
  let held = false;
  s.bridge.setSendPolicy((send) => {
    if (send.message === 'Thinking...') return 'ok';
    chunkIndex += 1;
    if (chunkIndex === 2) {
      held = true;
      return 'hold';
    }
    return 'ok';
  });
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-LONGC1'));
  s.step('chunk two in flight');
  await waitFor(() => held, STEP_TIMEOUT_MS, 'chunk two in flight');
  await sleep(300);
  await s.daemon.killGroup();
  s.check('daemon was killed mid-delivery', s.daemon.hasExited());
  const sendsAtKill = s.bridge.sends.length;
  s.bridge.setSendPolicy(() => 'ok');
  await s.startDaemon();
  await s.awaitSubscribed('daemon re-subscribes after crash restart', RESUBSCRIBE_TIMEOUT_MS);
  s.step('crash recovery settles the delivery');
  await waitFor(
    () => {
      const row = s.dbOne(
        "select status from queue_items where status in ('completed','dead_letter') limit 1",
      );
      return row !== undefined;
    },
    STEP_TIMEOUT_MS * 2,
    'terminal state after restart',
  );
  await sleep(SETTLE_MS * 3);
  const row = s.dbOne('select status from queue_items limit 1');
  s.check(
    'uncertain in-flight delivery is terminal (dead letter), not retried',
    row?.status === 'dead_letter',
    `status=${row?.status}`,
  );
  s.check(
    'crash marker: no chunk replay after restart',
    s.bridge.sends.length === sendsAtKill,
    `before=${sendsAtKill} after=${s.bridge.sends.length}`,
  );
  s.check('crash marker: provider did not re-run', s.providerCount('LONGC1') === 1);
  // Startup recovers without a reload: a new message is served by the restarted daemon.
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-CRASHAFTER'));
  await s.awaitSend(
    (x) => x.message.includes('Reply to SMOKE-CRASHAFTER'),
    'reply after crash restart',
  );
  s.check(
    'restarted daemon serves new messages once',
    s.sendCount((x) => x.message.includes('SMOKE-CRASHAFTER')) === 1,
  );
}

async function activeReloadScenario(s) {
  // SIGHUP while a multi-chunk reply is being delivered. The reload drains or recovers from the
  // saved cursor; the reply is delivered contiguously with no chunk resent.
  s.bridge.setSendDelay(400);
  const from = s.bridge.sends.length;
  s.emit(s.dm(s.peer, 1, '!talon SMOKE-LONGX3'));
  await s.awaitSend((x) => x.message.startsWith('Reply to SMOKE-LONGX3'), 'first chunk in flight');
  s.daemon.signal('SIGHUP');
  s.step('reply completes across the reload');
  await waitFor(
    () => s.bridge.sends.some((x) => x.message.endsWith(' END') && x.outcome === 'accepted'),
    RESUBSCRIBE_TIMEOUT_MS * 2,
    'reply completes across the reload',
  );
  await sleep(SETTLE_MS * 2);
  const chunks = chunksOf(s.sendsFrom(from), (x) => x.kind === 'dm' && x.recipientUuid === PEER);
  const accepted = chunks.filter((x) => x.outcome === 'accepted');
  s.check(
    'reload during send: chunks contiguous, ordered, none resent',
    rebuild(accepted) === expectedReply('LONGX3') && accepted.length === chunks.length,
    `sent=${chunks.length} accepted=${accepted.length}`,
  );
  s.check('reload during send: one provider run', s.providerCount('LONGX3') === 1);
  const logText = readLines(join(s.root, 'daemon.log')).join('\n');
  s.check(
    'daemon completed the reload',
    logText.includes('config reload complete') && !logText.includes('config reload failed'),
  );
  // The reload finished while chunks were still pending: at least one chunk was accepted after
  // the daemon logged completion (pino "time" and the bridge clock are both epoch ms).
  const reloadDone = readLines(join(s.root, 'daemon.log'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    })
    .find((entry) => String(entry.msg).includes('config reload complete'))?.time;
  const afterReload = accepted.filter((x) => x.at > (reloadDone ?? Infinity));
  s.check(
    'reload completed while chunks were still pending (a chunk was sent after it)',
    reloadDone !== undefined &&
      afterReload.length >= 1 &&
      accepted[accepted.length - 1].at > reloadDone &&
      accepted[0].at < reloadDone,
    `chunks=${accepted.length} afterReload=${afterReload.length}`,
  );
  s.check(
    'reload created a new subscription generation',
    s.bridge.subscribeCount >= 2,
    `subscribes=${s.bridge.subscribeCount}`,
  );
  s.expectDatabase(1);
}

async function proofExpiryScenario(s) {
  // Personal mode: only the account's own human-device text needs device provenance (a DM from
  // a selected peer carries none), so Note to Self is the input that expiry must quarantine.
  // listDevices starts failing after a healthy subscription. The refresh failure must not close
  // the subscription; once the 300 s proof expires, inbound text is quarantined (no run, no
  // reply) until a refresh succeeds, then processed exactly once. Refresh calls obey the budget.
  s.emit(s.sync(1, s.me, 'SMOKE-EXP0'));
  await s.awaitSend(
    (x) => x.message.includes('Reply to SMOKE-EXP0'),
    'healthy reply before failures',
  );
  const failureStart = Date.now();
  const callsBefore = s.bridge.listDevicesCalls.length;
  s.bridge.setListDevicesFailing(true);
  s.step('wait for proof expiry');
  await sleep(PROOF_TTL_MS + 15_000);
  s.check(
    'refresh failures did not close the healthy subscription',
    s.bridge.subscribeCount === 1 && s.bridge.unsubscribeCount === 0 && !s.daemon.hasExited(),
  );
  s.emit(s.sync(1, s.me, 'SMOKE-EXP1'));
  await sleep(SETTLE_MS * 4);
  s.check(
    'expired proof quarantines inbound text (no run, no reply)',
    s.providerCount('EXP1') === 0 && s.sendCount((x) => x.message.includes('SMOKE-EXP1')) === 0,
    `runs=${s.providerCount('EXP1')} sends=${s.sendCount((x) => x.message.includes('SMOKE-EXP1'))} sinceFailureMs=${Date.now() - failureStart} deviceCalls=${s.bridge.listDevicesCalls.length - callsBefore}`,
  );
  const window = Date.now() - failureStart;
  const calls = s.bridge.listDevicesCalls.length - callsBefore;
  const budget = Math.ceil(window / 60_000) + 1;
  s.check(
    'device checks during failures stay within one per 60 s',
    calls >= 1 && calls <= budget,
    `calls=${calls} budget=${budget}`,
  );
  s.bridge.setListDevicesFailing(false);
  await s.awaitSend(
    (x) => x.message.includes('Reply to SMOKE-EXP1'),
    'quarantined message released after refresh',
    RESUBSCRIBE_TIMEOUT_MS,
  );
  await sleep(SETTLE_MS * 2);
  s.check(
    'released message ran once and replied once',
    s.providerCount('EXP1') === 1 && s.sendCount((x) => x.message.includes('SMOKE-EXP1')) === 1,
  );
  s.check(
    'subscription stayed open throughout',
    s.bridge.subscribeCount === 1 && s.bridge.unsubscribeCount === 0,
  );
  s.expectDatabase(2);
}

const SCENARIOS = {
  dedicated: [{ mode: 'dedicated' }, dedicatedScenario],
  personal: [{ mode: 'personal' }, personalScenario],
  'stale-device': [
    { mode: 'personal', bridgeDeviceCreated: 2500, expectSubscription: false },
    staleDeviceScenario,
  ],
  'aci-only': [{ mode: 'dedicated', aciOnly: true }, aciOnlyScenario],
  'ingress-rollback': [{ mode: 'dedicated' }, rollbackScenario],
  deferrals: [{ mode: 'dedicated' }, deferralScenario],
  'chunk-resume': [{ mode: 'dedicated' }, chunkResumeScenario],
  'chunk-fairness': [{ mode: 'dedicated' }, chunkFairnessScenario],
  'crash-marker': [{ mode: 'dedicated' }, crashMarkerScenario],
  'active-reload': [{ mode: 'dedicated' }, activeReloadScenario],
  'proof-expiry': [{ mode: 'personal' }, proofExpiryScenario],
};

async function main() {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : Object.keys(SCENARIOS);
  const unknown = names.filter((name) => !(name in SCENARIOS));
  if (unknown.length > 0) {
    log(`FAIL unknown scenario(s): ${unknown.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  await Promise.all(names.map((name) => runScenario(name, SCENARIOS[name][0], SCENARIOS[name][1])));
  const leftovers = live.daemons.size + live.bridges.size + live.roots.size;
  if (leftovers !== 0 && process.env.SIGNAL_SMOKE_KEEP !== '1') {
    failures += 1;
    log('FAIL harness resources remain after all scenarios');
  }
  if (failures > 0) {
    log(`signal fake smoke FAILED (${failures} failure(s))`);
    process.exitCode = 1;
  } else {
    log('signal fake smoke OK');
  }
}

main().catch(() => {
  log('signal fake smoke FAILED: harness error');
  process.exitCode = 1;
});
