import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../core/database/repositories/helpers.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { QueueRepository } from '../../../../../src/core/database/repositories/queue-repository.js';
import {
  SignalAccountStateRepository,
  SignalStateError,
} from '../../../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../../../src/core/database/repositories/signal-destination-lease-repository.js';
import {
  SignalConfigSchema,
  type SignalConfig,
} from '../../../../../src/channels/connectors/signal/signal-config.js';
import { SignalDeviceRegistry } from '../../../../../src/channels/connectors/signal/signal-device-registry.js';
import {
  SignalConnector,
  type SignalConnectorDependencies,
} from '../../../../../src/channels/connectors/signal/index.js';
import { PipelineError } from '../../../../../src/core/errors/error-types.js';
import { err, ok } from '../../../../../src/core/types/result.js';
import type {
  InboundReceiptHandler,
  TrustedDeliveryContext,
} from '../../../../../src/channels/channel-types.js';

// Source-derived contracts ONLY, not live evidence. signal-cli v0.14.9 commit
// 3997429779095ff3a2d64c877126e84fce9852aa. VersionCommand.java:60-66;
// ListAccountsCommand.java:33-47; ListDevicesCommand.java:40-67;
// SignalJsonRpcCommandHandler.java:68-139,249-290; DispatcherHandler.java:164-199,255-280;
// JsonReceiveMessageHandler.java:23-35; JsonSyncDataMessage.java:14-30 (@JsonUnwrapped).
const account = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const foreign = 'cccccccc-1111-2222-3333-dddddddddddd';
const peer = 'eeeeeeee-1111-2222-3333-ffffffffffff';
const initial = 1_000_000;
const target = `signal:v1:${account}:self`;
const roster = [
  { id: 1, name: null, createdTimestamp: 1, lastSeenTimestamp: 500 },
  { id: 2, name: null, createdTimestamp: 100, lastSeenTimestamp: 500 },
  { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 },
];
interface Request {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}
function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
function receive(
  subscription = 7,
  timestamp = 500,
  text = 'self command',
  alias = account,
  author = account,
  device = 2,
): unknown {
  return {
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      subscription,
      result: {
        account: alias,
        envelope: {
          sourceUuid: author,
          sourceDevice: device,
          timestamp: timestamp + 1,
          ...(author === account
            ? {
                syncMessage: {
                  sentMessage: {
                    destinationUuid: account,
                    timestamp,
                    message: text,
                    expiresInSeconds: 0,
                  },
                },
              }
            : { dataMessage: { timestamp, message: text, expiresInSeconds: 0 } }),
        },
      },
    },
  };
}
async function until(predicate: () => boolean, details?: () => string): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !predicate(); attempt++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate(), details?.()).toBe(true);
}
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe('SignalConnector actual socket/parser/verifier/buffer/sender/SQLite integration', () => {
  let directory: string;
  let socketPath: string;
  let server: Server | undefined;
  let sockets: Socket[];
  let db: Database.Database;
  let accounts: SignalAccountStateRepository;
  let leases: SignalDestinationLeaseRepository;
  let queue: QueueRepository;
  let registry: SignalDeviceRegistry;
  let config: SignalConfig;
  let connector: SignalConnector;
  let connectors: SignalConnector[];
  let requests: Request[];
  let receipt: ReturnType<typeof vi.fn<InboundReceiptHandler>>;
  let logs: {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  let answer: (request: Request, socket: Socket) => void;
  let number: string | null;
  let version: unknown;
  let accountRows: unknown;
  let deviceReply: 'valid' | 'io' | 'invalid' | 'challenge';
  let early: boolean;
  let sendHold: Request | undefined;
  let holdSend: boolean;
  let sequence: number;

  function reply(socket: Socket, request: Request, result: unknown): void {
    socket.write(line({ jsonrpc: '2.0', id: request.id, result }));
  }
  function failure(socket: Socket, request: Request, code: number, results?: unknown[]): void {
    socket.write(
      line({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code,
          message: 'private unlink challenge value',
          data: { response: { timestamp: 900, results }, secret: 'never log' },
        },
      }),
    );
  }
  function defaultAnswer(request: Request, socket: Socket): void {
    if (request.method === 'version') reply(socket, request, { version });
    else if (request.method === 'listAccounts')
      reply(socket, request, accountRows ?? [{ number, aci: account.toUpperCase() }]);
    else if (request.method === 'listDevices') {
      if (deviceReply === 'io') failure(socket, request, -3);
      else if (deviceReply === 'challenge') failure(socket, request, -6);
      else reply(socket, request, deviceReply === 'invalid' ? roster.slice(0, 2) : roster);
    } else if (request.method === 'subscribeReceive') {
      if (early) socket.write(line(receive()));
      reply(socket, request, 7);
    } else if (request.method === 'listContacts') {
      // ListContactsCommand.java:117-167 / JsonContact.java:9-49. Required safe target fields.
      reply(socket, request, [
        {
          uuid: request.params?.recipient instanceof Array ? request.params.recipient[0] : account,
          isBlocked: false,
          unregistered: false,
          messageExpirationTime: 0,
        },
      ]);
    } else if (request.method === 'send') {
      if (holdSend) sendHold = request;
      else reply(socket, request, success());
    } else reply(socket, request, {});
  }
  function success(): unknown {
    // SendMessageResultUtils.java:43-68; JsonSendMessageResult.java:10-48; JsonRecipientAddress.java:9-15.
    return {
      timestamp: 900,
      results: [
        { recipientAddress: { uuid: account, number: null, username: null }, type: 'SUCCESS' },
      ],
    };
  }
  async function listen(): Promise<void> {
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)) as Request;
          buffer = buffer.slice(end + 1);
          requests.push(request);
          answer(request, socket);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
  }
  function create(
    overrides: Partial<SignalConnectorDependencies> = {},
    selected = config,
  ): SignalConnector {
    const result = new SignalConnector(selected, 'synthetic-channel', logs, {
      accounts,
      leases,
      queue,
      registry,
      random: () => 0.5,
      monotonicNow: () => performance.now(),
      ...overrides,
    });
    connectors.push(result);
    return result;
  }
  async function ready(): Promise<void> {
    await connector.start();
    await until(() => connector.status().state === 'ready');
  }
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  }
  function count(method: string): number {
    return requests.filter((request) => request.method === method).length;
  }
  function context(
    purpose: TrustedDeliveryContext['purpose'] = 'explicit',
  ): TrustedDeliveryContext {
    const id = ++sequence;
    new ThreadRepository(db)
      .insert({
        id: `thread-${id}`,
        channel_id: 'channel',
        external_id: `fixture-${id}`,
        metadata: '{}',
      })
      ._unsafeUnwrap();
    queue
      .enqueue({
        id: `queue-${id}`,
        thread_id: `thread-${id}`,
        message_id: null,
        type: 'message',
        payload: '{}',
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    return { queueItemId: `queue-${id}`, deliveryId: `delivery-${id}`, purpose };
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(initial);
    directory = fs.mkdtempSync(join(homedir(), '.sig-connector-'));
    fs.chmodSync(directory, 0o700);
    socketPath = join(directory, 'rpc.sock');
    db = createTestDb();
    accounts = new SignalAccountStateRepository(db);
    leases = new SignalDestinationLeaseRepository(db);
    queue = new QueueRepository(db);
    new ChannelRepository(db)
      .insert({
        id: 'channel',
        type: 'signal',
        name: 'synthetic-channel',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    config = SignalConfigSchema.parse({
      accountMode: 'personal',
      socketPath,
      account: '+12025550123',
      accountUuid: account,
      deviceId: 3,
      deviceCreatedTimestamp: 200,
      allowedDmPeers: [peer, foreign],
      allowedSenders: [peer, foreign],
      requestTimeoutMs: 1000,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
    });
    registry = SignalDeviceRegistry.create(19, [config])._unsafeUnwrap();
    sockets = [];
    requests = [];
    connectors = [];
    sequence = 0;
    logs = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    receipt = vi.fn<InboundReceiptHandler>(() => ok('accepted'));
    number = '+12025550123';
    version = '0.14.9';
    accountRows = undefined;
    deviceReply = 'valid';
    early = false;
    holdSend = false;
    sendHold = undefined;
    answer = defaultAnswer;
    connector = create();
    connector.onMessageWithReceipt(receipt);
  });
  afterEach(async () => {
    const stopped = connectors.map((entry) => entry.stopWithResult());
    await advance(30_000);
    await Promise.all(stopped);
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('does not lose actual RPC early matching receives flushed BEFORE the subscribe await continuation', async () => {
    early = true;
    await listen();
    await ready();
    await advance(0);
    expect(receipt).toHaveBeenCalledOnce();
    expect(receipt.mock.calls[0][0]).toMatchObject({ content: 'self command' });
    expect(receipt.mock.calls[0][0]).not.toHaveProperty('raw');
    expect(count('subscribeReceive')).toBe(1);
  });

  it('bounds absent first bridge, retries automatically and owns one idempotent start/subscription/stop', async () => {
    await connector.start();
    expect(connector.status().state).toBe('reconnecting');
    await connector.start();
    expect(count('version')).toBe(0);
    await listen();
    await advance(100);
    await until(() => connector.status().state === 'ready');
    await Promise.all([connector.start(), connector.start()]);
    expect(count('version')).toBe(1);
    expect(count('listDevices')).toBe(1);
    expect(count('subscribeReceive')).toBe(1);
    expect((await connector.stopWithResult()).isOk()).toBe(true);
    await connector.stop();
    await connector.start();
    await advance(300_000);
    expect(count('version')).toBe(1);
    expect(connector.status()).toMatchObject({ state: 'stopped', replacementAllowed: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('public preparation/ordinary sends retain actual attachment and trusted-context boundaries without fabricating identities', async () => {
    expect(connector.prepare(target, { body: '**hello**' })._unsafeUnwrap().chunks).toEqual([
      'hello',
    ]);
    expect(
      (
        await connector.send(target, {
          body: 'no socket',
          attachments: [{ filename: 'synthetic', mimeType: 'text/plain', data: '', size: 0 }],
        })
      )._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'UNSUPPORTED_ATTACHMENT', retryScope: 'none' });
    await listen();
    await ready();
    expect(
      (await connector.send(target, { body: 'no trusted actor' }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'CHECKPOINT_INVALID', retryScope: 'none' });
    expect(count('listContacts') + count('send')).toBe(0);
    expect(count('listDevices')).toBe(1);
  });

  it('requires a receipt, never treating legacy void registration as durable acceptance', async () => {
    const legacy = create();
    const handler = vi.fn();
    legacy.onMessage(handler);
    await legacy.start();
    expect(legacy.status()).toMatchObject({ state: 'needs_setup', reason: 'RECEIPT_REQUIRED' });
    expect(handler).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it.each(['unknown', '0.14.9-dev', '0.14.10', '0.15.0', null])(
    'pins EXACT version, refusing %s without account/device/subscription work',
    async (value) => {
      version = value;
      await listen();
      await connector.start();
      expect(connector.status()).toMatchObject({
        state: 'needs_setup',
        reason: 'UNSUPPORTED_VERSION',
      });
      expect(count('listAccounts') + count('listDevices') + count('subscribeReceive')).toBe(0);
      expect(
        (await connector.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'UNSUPPORTED_VERSION' });
      await advance(120_000);
      expect(count('version')).toBe(1);
    },
  );

  it('dedicated mode uses the same verified connector, excludes self events and admits only selected triggered external text', async () => {
    config = SignalConfigSchema.parse({
      ...config,
      accountMode: 'dedicated',
      deviceId: 1,
      deviceCreatedTimestamp: undefined,
    });
    registry = SignalDeviceRegistry.create(19, [config])._unsafeUnwrap();
    connector = create();
    connector.onMessageWithReceipt(receipt);
    await listen();
    await ready();
    sockets[0].write(
      line(receive(7, 500, 'own output')) +
        line(receive(7, 501, '!talon dedicated command', account, peer, 1)),
    );
    await until(() => connector.status().buffers?.receipt.held === 1);
    await advance(0);
    expect(receipt.mock.calls.map(([event]) => event.content)).toEqual(['dedicated command']);
    expect(registry.snapshot()[0]).toMatchObject({
      accountMode: 'dedicated',
      bridgeDeviceId: 1,
      status: 'verified',
    });
    expect(
      (
        await connector.send(target, {
          body: 'not a personal self target',
          trustedDelivery: context(),
        })
      ).isErr(),
    ).toBe(true);
    expect(count('send')).toBe(0);
  });

  it.each([0, -2147483648])(
    'retains actual signed Java subscription result %s without truthiness loss',
    async (subscription) => {
      answer = (request, socket) =>
        request.method === 'subscribeReceive'
          ? reply(socket, request, subscription)
          : defaultAnswer(request, socket);
      await listen();
      await ready();
      sockets[0].write(line(receive(subscription, 500, 'signed subscription')));
      await until(() => connector.status().buffers?.receipt.held === 1);
      await advance(0);
      expect(receipt).toHaveBeenCalledOnce();
      expect(count('subscribeReceive')).toBe(1);
    },
  );

  it('requires multi-account listAccounts and preserves safe remote-error classification', async () => {
    answer = (request, socket) =>
      request.method === 'listAccounts'
        ? failure(socket, request, -32601)
        : defaultAnswer(request, socket);
    await listen();
    await connector.start();
    expect(connector.status()).toMatchObject({
      state: 'needs_setup',
      reason: 'UNSUPPORTED_BRIDGE_MODE',
    });
    expect(count('listDevices')).toBe(0);
  });

  it.each(
    [
      [{ number: '+12025550123', aci: foreign }],
      [
        { number: '+12025550123', aci: foreign },
        { number: null, aci: account },
      ],
      [
        { number: null, aci: account },
        { number: '+12025550456', aci: account.toUpperCase() },
      ],
      [{ number: null, aci: account, deviceId: 3 }, { number: null }],
    ].map((rows) => ({ rows })),
  )(
    'rejects missing/ambiguous ACI or selector reassignment without invented registration fields: %j',
    async ({ rows }) => {
      accountRows = rows;
      await listen();
      await connector.start();
      expect(connector.status()).toMatchObject({
        state: 'needs_setup',
        reason: 'ACCOUNT_MISMATCH',
      });
      expect(count('listDevices') + count('subscribeReceive')).toBe(0);
    },
  );

  it.each([null, '+12025550456'])(
    'pinned ACI wins over absent old-phone selector with source-shaped alias %s',
    async (value) => {
      number = value;
      await listen();
      await ready();
      sockets.at(-1)!.write(line(receive(7, 500, 'valid alias', value ?? account)));
      await until(() => (connector.status().buffers?.receipt.held ?? 0) > 0);
      await advance(0);
      expect(receipt).toHaveBeenCalledOnce();
      const sent = connector.send(target, { body: '**hello**', trustedDelivery: context() });
      await until(() => count('send') === 1);
      expect((await sent).isOk()).toBe(true);
      expect(
        requests
          .filter((request) => request.params !== undefined)
          .every((request) => request.params?.account === account),
      ).toBe(true);
      expect(connector.format('**hello**')).toBe('hello');
    },
  );

  it('bounds every initial metadata request; healthy application failures stay pending, budgeted and do not infer unlink', async () => {
    answer = (request, socket) => {
      if (request.method !== 'version') defaultAnswer(request, socket);
    };
    await listen();
    const starting = connector.start();
    await until(() => count('version') === 1);
    await advance(1000);
    await starting;
    expect(connector.status().state).toBe('reconnecting');
    answer = defaultAnswer;
    deviceReply = 'io';
    await advance(100);
    await until(() => count('listDevices') === 1);
    await flush();
    expect(connector.status()).toMatchObject({
      state: 'reconnecting',
      verification: { state: 'pending' },
    });
    for (let i = 0; i < 50; i++) await connector.requestVerificationRefresh();
    expect(count('listDevices')).toBe(1);
    deviceReply = 'valid';
    await advance(60_000);
    await until(() => connector.status().state === 'ready');
    expect(count('version')).toBe(2);
    expect(count('subscribeReceive')).toBe(1);
  });

  it('does not repair an unsafe existing path and latches trust failure before identity RPCs', async () => {
    await listen();
    fs.chmodSync(socketPath, 0o666);
    await connector.start();
    expect(connector.status()).toMatchObject({ state: 'needs_setup', reason: 'UNTRUSTED_SOCKET' });
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o666);
    expect(requests).toEqual([]);
    fs.chmodSync(socketPath, 0o600);
    await connector.start();
    await advance(60_000);
    expect(requests).toEqual([]);
  });

  it('number changes refresh only local aliases, releasing quarantine once without reconnect or proof amplification', async () => {
    await listen();
    await ready();
    number = '+12025550456';
    sockets[0].write(
      line(receive(7, 500, 'number changed', number)) +
        line(receive(7, 501, 'wrong alias', '+12025550789')),
    );
    await until(() => connector.status().buffers?.alias.held === 2);
    await advance(0);
    await until(() => count('listAccounts') === 2);
    await flush();
    await advance(1);
    expect(receipt.mock.calls.map(([event]) => event.content)).toEqual(['number changed']);
    expect(count('version')).toBe(1);
    expect(count('subscribeReceive')).toBe(1);
    expect(count('listDevices')).toBe(1);
    expect(connector.status().buffers?.alias.held).toBe(0);
    const sent = connector.send(target, { body: 'new number reply', trustedDelivery: context() });
    await until(() => count('send') === 1);
    expect((await sent).isOk()).toBe(true);
    expect(requests.at(-1)?.params?.account).toBe(account);
  });

  it('alias IO does not admit a new alias or disturb a healthy subscription; coalesces at5s and expires at30s', async () => {
    await listen();
    await ready();
    answer = (request, socket) =>
      request.method === 'listAccounts'
        ? failure(socket, request, -3)
        : defaultAnswer(request, socket);
    sockets[0].write(
      Array.from({ length: 10 }, (_, i) =>
        line(receive(7, 500 + i, 'unknown alias', '+12025550456')),
      ).join(''),
    );
    await until(() => connector.status().buffers?.alias.held === 10);
    await advance(0);
    await until(() => count('listAccounts') === 2);
    await flush();
    await advance(4999);
    expect(count('listAccounts')).toBe(2);
    await advance(1);
    await until(() => count('listAccounts') === 3);
    await flush();
    expect(receipt).not.toHaveBeenCalled();
    expect(connector.status().state).toBe('ready');
    await advance(25_000);
    expect(connector.status().buffers?.alias).toMatchObject({ held: 0, dropped: 10 });
    expect(count('listDevices')).toBe(1);
    expect(count('subscribeReceive')).toBe(1);
  });

  it('periodic successful discovery proving missing pinned ACI is permanent setup, not unlink-from-text', async () => {
    await listen();
    await ready();
    accountRows = [{ number: null, aci: foreign }];
    await advance(60_000);
    await until(() => connector.status().state === 'needs_setup');
    expect(connector.status().reason).toBe('ACCOUNT_MISMATCH');
    expect(
      (await connector.sendPreparedChunk(target, 'no', context()))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'NEEDS_SETUP', retryScope: 'none' });
    expect(
      (await connector.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'ACCOUNT_MISMATCH' });
  });

  it('many per-event exceptions, controls and malformed envelopes do not increment the actual outer framing failure loop', async () => {
    await listen();
    await ready();
    const events = Array.from({ length: 80 }, (_, i) =>
      line({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          subscription: 7,
          result: {
            account,
            exception: {
              type: i % 2 ? 'UntrustedIdentityException' : 'new secret type',
              message: 'private remote body',
            },
            envelope: {},
          },
        },
      }),
    );
    events.push(
      line({
        jsonrpc: '2.0',
        method: 'receive',
        params: { subscription: 7, result: { account, envelope: { sourceUuid: {} } } },
      }),
    );
    events.push(
      line({
        jsonrpc: '2.0',
        method: 'receive',
        params: { subscription: 8, result: { account, envelope: {} } },
      }),
    );
    events.push(line(receive(7, 501, 'still works')));
    sockets[0].write(events.join(''));
    await until(() => connector.status().buffers?.receipt.held === 1);
    await advance(0);
    expect(receipt).toHaveBeenCalledOnce();
    expect(connector.status().state).toBe('ready');
    expect(count('listDevices')).toBe(1);
    expect(count('subscribeReceive')).toBe(1);
    await advance(60_000);
    await flush();
    expect(JSON.stringify(logs)).not.toMatch(/private|remote body|new secret type/);
    expect(JSON.stringify(logs.debug.mock.calls)).not.toContain(account);
  });

  it('third genuine protocol fault within5min latches setup while stale callbacks cannot revoke a new socket', async () => {
    await listen();
    await ready();
    const oldSocket = sockets[0];
    for (let i = 0; i < 3; i++) {
      sockets.at(-1)!.write('{invalid json}\n');
      await until(() => connector.status().state !== 'ready');
      if (i < 2) {
        await advance(100);
        await until(
          () =>
            count('version') === i + 2 &&
            sockets.length === i + 2 &&
            connector.status().verification?.nextCheckAt !== undefined,
          () =>
            JSON.stringify({
              i,
              status: connector.status(),
              methods: requests.map((request) => request.method),
            }),
        );
        await flush();
        await advance(60_000);
        await until(() => connector.status().state === 'ready');
        oldSocket.emit('close');
        expect(connector.status().state).toBe('ready');
      }
    }
    expect(connector.status()).toMatchObject({
      state: 'needs_setup',
      reason: 'PROTOCOL_FAILURE_LOOP',
    });
    expect(
      (await connector.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'PROTOCOL_FAILURE_LOOP' });
    await advance(120_000);
    expect(count('version')).toBe(3);
  });

  it('genuine actual pre-response1MiB overflow closes the current subscription attempt rather than accepting any raw early event', async () => {
    answer = (request, socket) => {
      if (request.method === 'subscribeReceive')
        socket.write(
          line(receive(7, 500, 'x'.repeat(540_000))) + line(receive(7, 501, 'x'.repeat(540_000))),
        );
      else defaultAnswer(request, socket);
    };
    await listen();
    await connector.start();
    expect(connector.status().state).toBe('reconnecting');
    expect(connector.status().buffers?.receipt.held).toBe(0);
    expect(receipt).not.toHaveBeenCalled();
    expect(count('subscribeReceive')).toBe(1);
    expect(JSON.stringify(logs.info.mock.calls).length).toBeLessThan(2000);
  });

  it('failed receipt retries expire after5minutes with the exact same normalized object/key, never manual replay', async () => {
    receipt.mockImplementation(() => err(new PipelineError('synthetic rollback')));
    await listen();
    await ready();
    sockets[0].write(line(receive()));
    await until(() => connector.status().buffers?.receipt.held === 1);
    await advance(0);
    const held = receipt.mock.calls[0][0];
    for (let i = 0; i < 5; i++) {
      const prior = count('listDevices');
      await advance(60_000);
      await until(() => count('listDevices') === prior + 1);
      await flush();
    }
    await advance(1);
    expect(connector.status().buffers?.receipt).toMatchObject({ held: 0, dropped: 1 });
    expect(receipt.mock.calls.length).toBeGreaterThan(5);
    expect(receipt.mock.calls.length).toBeLessThan(50);
    expect(
      receipt.mock.calls.every(
        ([event]) => event === held && event.idempotencyKey === held.idempotencyKey,
      ),
    ).toBe(true);
  });

  it('actual receipt FIFO retains the SAME event/key on Err, releases duplicate/dropped sequentially and retries across reconnect', async () => {
    receipt
      .mockImplementationOnce(() => err(new PipelineError('private write failure')))
      .mockImplementationOnce(() => ok('duplicate'))
      .mockImplementationOnce(() => ok('dropped'));
    await listen();
    await ready();
    sockets[0].write(line(receive(7, 500, 'first')) + line(receive(7, 501, 'second')));
    await until(() => connector.status().buffers?.receipt.held === 2);
    await advance(0);
    const event = receipt.mock.calls[0][0];
    expect(receipt).toHaveBeenCalledOnce();
    sockets[0].destroy();
    await until(() => connector.status().state === 'reconnecting');
    await advance(100);
    await until(
      () =>
        count('listAccounts') === 2 && connector.status().verification?.nextCheckAt !== undefined,
    );
    await flush();
    await advance(59_900);
    await until(() => connector.status().state === 'ready');
    await advance(1000);
    expect(receipt.mock.calls.map(([value]) => value.content)).toEqual([
      'first',
      'first',
      'second',
    ]);
    expect(receipt.mock.calls[1][0]).toBe(event);
    expect(connector.status().buffers?.receipt.held).toBe(0);
    expect(count('listDevices')).toBe(2);
  });

  it('receipt overflow reconnects WITHOUT discarding64 existing FIFO entries; stop clears only preacceptance work', async () => {
    receipt.mockImplementation(() => err(new PipelineError('local rollback')));
    await listen();
    await ready();
    sockets[0].write(
      Array.from({ length: 65 }, (_, i) => line(receive(7, 500 + i, `fifo ${i}`))).join(''),
    );
    await until(() => connector.status().state === 'reconnecting');
    expect(connector.status().buffers?.receipt).toMatchObject({ held: 64, dropped: 1 });
    await advance(100);
    await until(
      () =>
        count('listAccounts') === 2 && connector.status().verification?.nextCheckAt !== undefined,
    );
    await flush();
    receipt.mockImplementation(() => ok('accepted'));
    await advance(59_900);
    await until(() => connector.status().state === 'ready');
    await advance(1000);
    expect(receipt.mock.calls.map(([event]) => event.content)).toEqual(
      Array.from({ length: 64 }, (_, i) => `fifo ${i}`),
    );
    expect(connector.status().buffers?.receipt.held).toBe(0);
    sockets.at(-1)!.write(line(receive(7, 900, 'pending stop')));
    await until(() => connector.status().buffers?.receipt.held === 1);
    await connector.stopWithResult();
    await advance(300_000);
    expect(receipt).toHaveBeenCalledTimes(64);
    expect(connector.status().buffers?.receipt).toMatchObject({ held: 0, dropped: 2 });
  });

  it('transient healthy proof expiry preserves known human roster for3 held commands while independent peers remain usable', async () => {
    await listen();
    await ready();
    deviceReply = 'io';
    for (let i = 0; i < 5; i++) {
      await advance(60_000);
      await until(() => count('listDevices') === i + 2);
      await flush();
    }
    expect(connector.status()).toMatchObject({ state: 'ready', verification: { state: 'stale' } });
    expect(registry.snapshot()[0]).toMatchObject({
      status: 'verified',
      humanDevices: [
        { deviceId: 1, createdTimestamp: 1 },
        { deviceId: 2, createdTimestamp: 100 },
      ],
    });
    sockets[0].write(
      [0, 1, 2].map((i) => line(receive(7, 500 + i, `held ${i}`))).join('') +
        line(receive(7, 600, '!talon independent', account, peer, 1)),
    );
    await until(() => connector.status().buffers?.proof.held === 3);
    await advance(0);
    expect(receipt.mock.calls.map(([event]) => event.content)).toEqual(['independent']);
    const pending = connector.send(target, { body: 'deferred', trustedDelivery: context() });
    await advance(30_000);
    expect((await pending).isErr()).toBe(true);
    expect(count('send')).toBe(0);
    deviceReply = 'valid';
    await advance(30_000);
    await until(() => count('listDevices') === 7);
    await flush();
    await advance(1);
    expect(receipt.mock.calls.map(([event]) => event.content)).toEqual([
      'independent',
      'held 0',
      'held 1',
      'held 2',
    ]);
    expect(connector.status().buffers?.proof.held).toBe(0);
    expect(count('version')).toBe(1);
    expect(count('subscribeReceive')).toBe(1);
  });

  it('DB-suspended metadata blocks actual sender even with fresh cached proof, then retries ONLY state writes', async () => {
    await listen();
    await ready();
    const prior = registry.snapshot();
    deviceReply = 'challenge';
    db.exec(
      "CREATE TRIGGER fail_hint BEFORE UPDATE OF challenge ON signal_account_state BEGIN SELECT RAISE(ABORT, 'private'); END",
    );
    await advance(60_000);
    await until(() => count('listDevices') === 2);
    await flush();
    expect(connector.status()).toMatchObject({
      state: 'ready',
      verification: { state: 'suspended' },
      persistenceBlocked: true,
    });
    expect(registry.snapshot()).toBe(prior);
    const pending = connector.send(target, { body: 'must not send', trustedDelivery: context() });
    await advance(30_000);
    expect((await pending).isErr()).toBe(true);
    expect(count('listContacts') + count('send')).toBe(0);
    expect(count('subscribeReceive')).toBe(1);
    db.exec('DROP TRIGGER fail_hint');
    await advance(10_000);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('challenge');
    expect(count('listDevices')).toBe(2);
    expect(connector.status().verification?.state).toBe('verified');
  });

  it('foreign personal unknown-device advisories route existing author owner exactly once, not receiving owner/doublecoalescer', async () => {
    const otherConfig = { ...config, account: foreign, accountUuid: foreign };
    registry = SignalDeviceRegistry.create(19, [config, otherConfig])._unsafeUnwrap();
    accountRows = [
      { number, aci: account },
      { number: null, aci: foreign },
    ];
    const other = create({}, otherConfig);
    other.onMessageWithReceipt(receipt);
    const byAci = new Map([[foreign, other]]);
    const dispatch = vi.fn((aci: string) => {
      void byAci.get(aci)?.requestVerificationRefresh();
    });
    const foreignRefresh = vi.spyOn(other, 'requestVerificationRefresh');
    connector = create({ requestDeviceRefresh: dispatch });
    connector.onMessageWithReceipt(receipt);
    await listen();
    await other.start();
    await until(() => other.status().state === 'ready');
    await ready();
    sockets[1].write(
      Array.from({ length: 50 }, (_, i) =>
        line(receive(7, 500 + i, '!talon foreign', account, foreign, 99)),
      ).join(''),
    );
    await until(() => dispatch.mock.calls.length === 1);
    expect(dispatch.mock.calls).toEqual([[foreign]]);
    expect(foreignRefresh).toHaveBeenCalledOnce();
    expect(
      requests
        .filter((request) => request.method === 'listDevices')
        .map((request) => request.params?.account),
    ).toEqual([foreign, account]);
    expect(receipt).not.toHaveBeenCalled();
  });

  it.each(['success', 'forced unknown', 'write fault'] as const)(
    'actual sender stop drains %s before transport close; no new dispatch/reconnect, Result-gated ownership',
    async (kind) => {
      config = { ...config, requestTimeoutMs: 120_000 };
      connector = create();
      connector.onMessageWithReceipt(receipt);
      await listen();
      await ready();
      holdSend = true;
      const ctx = context();
      const pending = connector.send(target, { body: 'active text', trustedDelivery: ctx });
      await until(() => sendHold !== undefined);
      const socket = sockets[0];
      const stopped = connector.stopWithResult();
      expect(connector.status()).toMatchObject({
        state: 'stopped',
        replacementAllowed: false,
        draining: true,
      });
      expect(socket.destroyed).toBe(false);
      if (kind === 'write fault')
        vi.spyOn(accounts, 'clearReservation').mockReturnValue(
          err(new SignalStateError('DATABASE')),
        );
      if (kind === 'success') reply(socket, sendHold!, success());
      else await advance(30_000);
      const sent = await pending;
      const result = await stopped;
      expect(result.isOk()).toBe(kind !== 'write fault');
      expect(sent.isOk()).toBe(kind === 'success');
      if (kind !== 'success') expect(sent._unsafeUnwrapErr().outcome).toBe('UNKNOWN');
      expect(connector.status().replacementAllowed).toBe(kind !== 'write fault');
      const replacement = create();
      replacement.onMessageWithReceipt(receipt);
      await replacement.start();
      if (kind === 'write fault') {
        expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
        expect(replacement.status()).toMatchObject({ state: 'needs_setup', reason: 'OWNER_BUSY' });
        expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
        expect(count('version')).toBe(1);
      } else {
        expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
          reservation: null,
          recoveryNotBefore: kind === 'forced unknown' ? initial + 90_000 : 0,
        });
        await advance(60_000);
        await until(() => replacement.status().state === 'ready');
        holdSend = false;
        const distinct = replacement.send(target, { body: 'distinct', trustedDelivery: context() });
        await until(() => count('send') === 2);
        expect((await distinct).isOk()).toBe(true);
      }
      await connector.start();
      await advance(1000);
      expect(count('send')).toBe(kind === 'write fault' ? 1 : 2);
    },
  );

  it.each(['success', 'forced unknown'] as const)(
    'saved prepared chunk stop drains %s into ACTUAL durable checkpoint, never recovery/replay',
    async (kind) => {
      config = { ...config, requestTimeoutMs: 120_000 };
      connector = create();
      connector.onMessageWithReceipt(receipt);
      await listen();
      await ready();
      holdSend = true;
      const ctx = context('reply');
      const prepared = connector.prepare(target, { body: 'saved text' })._unsafeUnwrap();
      queue
        .saveSignalCheckpoint(
          {
            version: 1,
            queueItemId: ctx.queueItemId,
            deliveryId: ctx.deliveryId,
            kind: 'reply',
            personaId: 'persona',
            threadId: 'thread-1',
            channelName: 'synthetic-channel',
            accountUuid: account,
            destination: target,
            body: 'saved text',
            chunks: prepared.chunks,
            nextChunk: 0,
            phase: 'ready',
            currentChunkAcceptance: 'unwritten',
            acceptedChunks: 0,
            successCount: 0,
            failureCount: 0,
            createdAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
          },
          Date.now(),
        )
        ._unsafeUnwrap();
      const recovery = vi.spyOn(queue, 'recoverSignalQueue');
      const pending = connector.sendPreparedChunk(target, prepared.chunks[0], ctx);
      await until(() => sendHold !== undefined);
      const stopped = connector.stopWithResult();
      if (kind === 'success') reply(sockets[0], sendHold!, success());
      else await advance(30_000);
      expect((await stopped).isOk()).toBe(true);
      expect((await pending).isOk()).toBe(kind === 'success');
      const state = queue.inspectSignalDelivery(ctx.queueItemId, Date.now())._unsafeUnwrap();
      expect(state).toMatchObject({
        kind: 'checkpoint',
        checkpoint:
          kind === 'success'
            ? { phase: 'delivered', nextChunk: 1, successCount: 1 }
            : { phase: 'terminal', nextChunk: 0, terminalOutcome: 'UNKNOWN' },
      });
      expect(recovery).not.toHaveBeenCalled();
      expect(count('send')).toBe(1);
    },
  );

  it('start awaits the one bounded manual-subscription attempt, including timeout, without duplicate subscriptions', async () => {
    answer = (request, socket) => {
      if (request.method !== 'subscribeReceive') defaultAnswer(request, socket);
    };
    await listen();
    let completed = false;
    const starting = connector.start().then(() => {
      completed = true;
    });
    await until(() => count('subscribeReceive') === 1);
    const repeated = connector.start();
    expect(completed).toBe(false);
    await advance(1000);
    await Promise.all([starting, repeated]);
    expect(connector.status().state).toBe('reconnecting');
    expect(count('subscribeReceive')).toBe(1);
  });

  it('repeats actual socket trust checks after connect before ANY version/account call', async () => {
    await listen();
    const original = Socket.prototype.connect;
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket['connect']>
    ) {
      this.prependOnceListener('connect', () => fs.chmodSync(socketPath, 0o666));
      return original.apply(this, args);
    });
    await connector.start();
    expect(connector.status()).toMatchObject({ state: 'needs_setup', reason: 'UNTRUSTED_SOCKET' });
    expect(requests).toEqual([]);
  });

  it('stop during an unanswered handshake cancels its actual request and every reconnect/alias schedule', async () => {
    answer = () => undefined;
    await listen();
    const starting = connector.start();
    await until(() => count('version') === 1);
    expect((await connector.stopWithResult()).isOk()).toBe(true);
    await starting;
    await advance(300_000);
    expect(requests.map((request) => request.method)).toEqual(['version']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('owns actual repository AND registry identities and old repeated stop cannot revoke a replacement proof', async () => {
    await listen();
    await ready();
    const otherRegistry = SignalDeviceRegistry.create(20, [config])._unsafeUnwrap();
    const sameRepository = create({ registry: otherRegistry });
    sameRepository.onMessageWithReceipt(receipt);
    await sameRepository.start();
    const sameRegistry = create({ accounts: new SignalAccountStateRepository(db) });
    sameRegistry.onMessageWithReceipt(receipt);
    await sameRegistry.start();
    expect(sameRepository.status().reason).toBe('OWNER_BUSY');
    expect(sameRegistry.status().reason).toBe('OWNER_BUSY');
    await connector.stopWithResult();
    const replacement = create();
    replacement.onMessageWithReceipt(receipt);
    await replacement.start();
    await advance(60_000);
    await until(() => replacement.status().state === 'ready');
    const current = registry.snapshot();
    await connector.stopWithResult();
    connector.status();
    expect(registry.snapshot()).toBe(current);
    expect(replacement.status().state).toBe('ready');
    expect(count('subscribeReceive')).toBe(2);
  });

  it('verifier stop persistence Err retains connector ownership through DB-only repair and exact Result release', async () => {
    await listen();
    await ready();
    deviceReply = 'challenge';
    db.exec(
      "CREATE TRIGGER fail_stop_hint BEFORE UPDATE OF challenge ON signal_account_state BEGIN SELECT RAISE(ABORT, 'private'); END",
    );
    await advance(60_000);
    await until(() => count('listDevices') === 2);
    await flush();
    const result = await connector.stopWithResult();
    expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
    expect(connector.status()).toMatchObject({
      state: 'stopped',
      replacementAllowed: false,
      persistenceBlocked: true,
    });
    const blocked = create();
    blocked.onMessageWithReceipt(receipt);
    await blocked.start();
    expect(blocked.status().reason).toBe('OWNER_BUSY');
    db.exec('DROP TRIGGER fail_stop_hint');
    await advance(250);
    connector.retryStateWrites();
    expect((await connector.stopWithResult()).isOk()).toBe(true);
    expect(connector.status().replacementAllowed).toBe(true);
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('challenge');
    expect(count('listDevices')).toBe(2);
    expect(count('send')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expired proof quarantine is bounded and expires original commands without replay after renewal', async () => {
    await listen();
    await ready();
    deviceReply = 'io';
    for (let i = 0; i < 5; i++) {
      await advance(60_000);
      await until(() => count('listDevices') === i + 2);
      await flush();
    }
    sockets[0].write(
      Array.from({ length: 65 }, (_, i) => line(receive(7, 500 + i, `held ${i}`))).join(''),
    );
    await until(() => connector.status().buffers?.proof.dropped === 1);
    expect(connector.status().buffers?.proof.held).toBe(64);
    // Keep actual IO replies settling between native timer advances, rather than simulating RPC.
    for (let i = 0; i < 10; i++) {
      const prior = count('listDevices');
      await advance(60_000);
      await until(() => count('listDevices') === prior + 1);
      await flush();
    }
    await advance(1);
    expect(connector.status().buffers?.proof).toMatchObject({ held: 0, dropped: 65 });
    deviceReply = 'valid';
    const prior = count('listDevices');
    await advance(60_000);
    await until(() => count('listDevices') === prior + 1);
    await flush();
    await advance(1);
    expect(receipt).not.toHaveBeenCalled();
    expect(logs.warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toMatch(/held 0|aaaaaaaa|1202555/);
  });

  it('real parser invalidates genuine oversized frames, while stale old data/close callbacks cannot touch new epoch', async () => {
    const clients: Socket[] = [];
    const original = Socket.prototype.connect;
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket['connect']>
    ) {
      clients.push(this);
      return original.apply(this, args);
    });
    await listen();
    await ready();
    const staleData = clients[0].listeners('data')[0];
    const staleClose = clients[0].listeners('close')[0];
    sockets[0].write('x'.repeat(1_048_577));
    await until(() => connector.status().state === 'reconnecting');
    await advance(100);
    await until(
      () =>
        count('listAccounts') === 2 && connector.status().verification?.nextCheckAt !== undefined,
    );
    await advance(59_900);
    await until(() => connector.status().state === 'ready');
    staleData?.(Buffer.from(line(receive(7, 500, 'stale'))));
    staleClose?.();
    expect(connector.status().state).toBe('ready');
    sockets.at(-1)!.write(line(receive(7, 501, 'current')));
    await until(() => connector.status().buffers?.receipt.held === 1);
    await advance(0);
    expect(receipt.mock.calls.map(([event]) => event.content)).toEqual(['current']);
    expect(count('subscribeReceive')).toBe(2);
  });

  it.each(['device', 'trust'] as const)(
    'privileged assertion rejects unrelated %s setup WITHOUT a verifier resume or test send',
    async (reason) => {
      if (reason === 'device') deviceReply = 'invalid';
      await listen();
      if (reason === 'trust') fs.chmodSync(socketPath, 0o666);
      await connector.start();
      expect(connector.status().state).toBe('needs_setup');
      const prior = count('listDevices');
      expect((await connector.resumeChallenge({ externalChallengeResolved: true })).isErr()).toBe(
        true,
      );
      await advance(120_000);
      expect(count('listDevices')).toBe(prior);
      expect(count('send')).toBe(0);
    },
  );

  it('privileged challenge assertion is not auto-reasserted across newer challenge/budget, sends nothing, and requires fresh authentication upstream', async () => {
    await listen();
    await ready();
    let state = accounts.findByAccount(account)._unsafeUnwrap()!;
    state = accounts
      .recordPause(account, state.revision, { kind: 'challenge' }, Date.now())
      ._unsafeUnwrap();
    // @ts-expect-error intentionally missing explicit external-resolution assertion
    expect((await connector.resumeChallenge({})).isErr()).toBe(true);
    expect(
      (await connector.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'BUDGET' });
    state = accounts
      .recordPause(account, state.revision, { kind: 'challenge' }, Date.now())
      ._unsafeUnwrap();
    await advance(60_250);
    await flush();
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(state);
    expect(count('listDevices')).toBe(1);
    expect((await connector.resumeChallenge({ externalChallengeResolved: true })).isOk()).toBe(
      true,
    );
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('none');
    expect(count('listDevices')).toBe(2);
    expect(count('send')).toBe(0);
    expect(JSON.stringify(connector.status())).not.toMatch(
      /aaaaaaaa|1202555|subscription|self command|private/,
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toMatch(
      /aaaaaaaa|1202555|subscription|private/,
    );
  });
  describe('review F1/F2: actual retained sender repair and outbound health', () => {
    function failSenderWrites(): void {
      db.exec(`CREATE TRIGGER fail_sender_repair BEFORE UPDATE OF reservation_delivery_id ON signal_account_state
        WHEN NEW.reservation_delivery_id IS NULL
        BEGIN SELECT RAISE(ABORT, 'synthetic settlement outage'); END`);
    }
    function saveReply(body = 'a'.repeat(2000) + 'tail'): TrustedDeliveryContext {
      const ctx = context('reply');
      const prepared = connector.prepare(target, { body })._unsafeUnwrap();
      queue
        .saveSignalCheckpoint(
          {
            version: 1,
            queueItemId: ctx.queueItemId,
            deliveryId: ctx.deliveryId,
            kind: 'reply',
            personaId: 'persona',
            threadId: `thread-${sequence}`,
            channelName: 'synthetic-channel',
            accountUuid: account,
            destination: target,
            body,
            chunks: prepared.chunks,
            nextChunk: 0,
            phase: 'ready',
            currentChunkAcceptance: 'unwritten',
            acceptedChunks: 0,
            successCount: 0,
            failureCount: 0,
            createdAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
          },
          Date.now(),
        )
        ._unsafeUnwrap();
      return ctx;
    }
    function saved(ctx: TrustedDeliveryContext) {
      const state = queue.inspectSignalDelivery(ctx.queueItemId, Date.now())._unsafeUnwrap();
      if (state.kind !== 'checkpoint') throw new Error('Missing actual saved fixture');
      return state.checkpoint;
    }
    async function poison(): Promise<TrustedDeliveryContext> {
      const body = 'a'.repeat(2000) + 'tail';
      const ctx = saveReply(body);
      holdSend = true;
      const pending = connector.send(target, { body, trustedDelivery: ctx });
      await until(() => sendHold !== undefined);
      failSenderWrites();
      const settle = vi.spyOn(queue, 'settleSignalChunk'); // Pass through to the REAL failed SQLite transaction.
      reply(sockets[0], sendHold!, success());
      await until(() => settle.mock.calls.length === 1);
      await advance(8000);
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        reason: 'STATE_WRITE_FAILED',
        currentChunkAcceptance: 'complete',
        successCount: 1,
      });
      expect(settle).toHaveBeenCalledTimes(6);
      expect(saved(ctx)).toMatchObject({ phase: 'in_flight', nextChunk: 0, successCount: 0 });
      return ctx;
    }

    it('ordinary actual sender poisoning suspends outbound status/readiness but preserves proof, subscription and actual inbound receipts', async () => {
      await listen();
      await ready();
      const proof = registry.snapshot();
      await poison();
      await flush();
      expect(connector.status()).toMatchObject({
        state: 'ready',
        reason: 'STATE_WRITE_FAILED',
        verification: { state: 'verified' },
        sender: { state: 'blocked', stopped: true, pendingWrites: 1 },
        persistenceBlocked: true,
        outboundSuspended: true,
        replacementAllowed: false,
      });
      expect(registry.snapshot()).toBe(proof);
      sockets[0].write(line(receive(7, 700, '!talon still receiving', account, peer, 1)));
      await until(() => connector.status().buffers?.receipt.held === 1);
      await advance(0);
      expect(receipt.mock.calls.map(([event]) => event.content)).toEqual(['still receiving']);
      expect(
        (
          await connector.send(target, { body: 'not replayed', trustedDelivery: context() })
        ).isErr(),
      ).toBe(true);
      expect(count('send')).toBe(1);
      expect(count('listContacts')).toBe(1);
      expect(count('version')).toBe(1);
      expect(count('listDevices')).toBe(1);
      expect(count('subscribeReceive')).toBe(1);
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
        pauseKind: 'none',
        recoveryNotBefore: 0,
      });
      expect(JSON.stringify(connector.status())).not.toMatch(
        /aaaaaaaa|1202555|subscription|still receiving|synthetic settlement/,
      );
      expect(JSON.stringify(logs.info.mock.calls)).not.toMatch(
        /aaaaaaaa|1202555|synthetic settlement/,
      );
    });

    it('repairs the ORIGINAL observed COMPLETE sender through B, then requires final stop Results before legitimate replacement and DISTINCT send', async () => {
      await listen();
      await ready();
      const ctx = await poison();
      const recovery = vi.spyOn(queue, 'recoverSignalQueue');
      const failed = await connector.stopWithResult();
      expect(failed._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
      const blocked = create();
      blocked.onMessageWithReceipt(receipt);
      await blocked.start();
      expect(blocked.status().reason).toBe('OWNER_BUSY');
      db.exec('DROP TRIGGER fail_sender_repair');
      expect(connector.retryStateWrites().isOk()).toBe(true);
      expect(saved(ctx)).toMatchObject({
        phase: 'ready',
        nextChunk: 1,
        acceptedChunks: 1,
        successCount: 1,
        currentChunkAcceptance: 'unwritten',
      });
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
        reservation: null,
        recoveryNotBefore: 0,
        pauseKind: 'none',
      });
      expect(connector.status()).toMatchObject({
        outboundSuspended: true,
        replacementAllowed: false,
        sender: { state: 'healthy', stopped: true, pendingWrites: 0 },
      });
      const stillBlocked = create();
      stillBlocked.onMessageWithReceipt(receipt);
      await stillBlocked.start();
      expect(stillBlocked.status().reason).toBe('OWNER_BUSY');
      expect((await connector.stopWithResult()).isOk()).toBe(true);
      expect(connector.status().replacementAllowed).toBe(true);
      const checkpoint = saved(ctx);
      const replacement = create();
      replacement.onMessageWithReceipt(receipt);
      await replacement.start();
      await advance(52_000);
      await until(() => replacement.status().state === 'ready');
      expect(replacement.status()).toMatchObject({
        outboundSuspended: false,
        persistenceBlocked: false,
        sender: { state: 'healthy', stopped: false },
      });
      const current = registry.snapshot();
      connector.retryStateWrites();
      await connector.stopWithResult();
      connector.status();
      expect(registry.snapshot()).toBe(current);
      holdSend = false;
      const distinct = replacement.send(`signal:v1:${account}:dm:${peer}`, {
        body: 'distinct command',
        trustedDelivery: context(),
      });
      await until(() => count('send') === 2);
      expect((await distinct).isOk()).toBe(true);
      expect(saved(ctx)).toEqual(checkpoint);
      expect(
        requests
          .filter((request) => request.method === 'send')
          .map((request) => request.params?.message),
      ).toEqual(['a'.repeat(2000), 'distinct command']);
      expect(recovery).not.toHaveBeenCalled();
      expect(count('listDevices')).toBe(2);
      expect(count('subscribeReceive')).toBe(2);
    });

    it('DB-only repair while receiving never reopens a healthy-but-STOPPED original sender, even after proof renewal or privileged verification', async () => {
      await listen();
      await ready();
      const ctx = await poison();
      db.exec('DROP TRIGGER fail_sender_repair');
      expect(connector.retryStateWrites().isOk()).toBe(true);
      expect(saved(ctx)).toMatchObject({ phase: 'ready', nextChunk: 1, successCount: 1 });
      await flush();
      expect(connector.status()).toMatchObject({
        state: 'ready',
        reason: 'OUTBOUND_STOPPED',
        outboundSuspended: true,
        persistenceBlocked: false,
        sender: { state: 'healthy', stopped: true, pendingWrites: 0 },
      });
      await advance(52_000);
      await until(() => count('listDevices') === 2);
      await flush();
      let state = accounts.findByAccount(account)._unsafeUnwrap()!;
      state = accounts
        .recordPause(account, state.revision, { kind: 'challenge' }, Date.now())
        ._unsafeUnwrap();
      expect(
        (await connector.resumeChallenge({ externalChallengeResolved: true }))._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'BUDGET' });
      await advance(60_000);
      await until(
        () =>
          count('listDevices') === 3 &&
          accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind === 'none',
      );
      expect(
        (
          await connector.send(target, {
            body: 'old sender cannot send',
            trustedDelivery: context(),
          })
        ).isErr(),
      ).toBe(true);
      expect(connector.status()).toMatchObject({
        reason: 'OUTBOUND_STOPPED',
        outboundSuspended: true,
        sender: { state: 'healthy', stopped: true },
      });
      sockets[0].write(line(receive(7, 701, 'own command still accepted')));
      await until(() => connector.status().buffers?.receipt.held === 1);
      await advance(0);
      expect(receipt).toHaveBeenCalledOnce();
      expect(count('send')).toBe(1);
      expect(count('listContacts')).toBe(1);
      expect(count('subscribeReceive')).toBe(1);
      expect((await connector.stopWithResult()).isOk()).toBe(true);
    });

    it('real preflight DATABASE refusal is not sender poison and does not suspend a later distinct invocation', async () => {
      await listen();
      await ready();
      db.exec(`CREATE TRIGGER fail_preflight BEFORE UPDATE OF last_send_start ON signal_account_state
        BEGIN SELECT RAISE(ABORT, 'synthetic preflight outage'); END`);
      expect(
        (
          await connector.send(target, { body: 'unwritten', trustedDelivery: context() })
        )._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'STATE_WRITE_FAILED', currentChunkAcceptance: 'unwritten' });
      expect(connector.status()).toMatchObject({
        outboundSuspended: false,
        persistenceBlocked: false,
        sender: { state: 'healthy', stopped: false, pendingWrites: 0 },
      });
      expect(count('send')).toBe(0);
      db.exec('DROP TRIGGER fail_preflight');
      const pending = connector.send(target, {
        body: 'distinct after preflight',
        trustedDelivery: context(),
      });
      await until(() => count('send') === 1);
      expect((await pending).isOk()).toBe(true);
      expect(count('subscribeReceive')).toBe(1);
    });

    it('public repair returns the ACTUAL sender BUSY during an active request rather than a verifier-only success', async () => {
      await listen();
      await ready();
      holdSend = true;
      const pending = connector.send(target, { body: 'active', trustedDelivery: context() });
      await until(() => sendHold !== undefined);
      const busy = connector.retryStateWrites();
      expect(busy._unsafeUnwrapErr()).toBeInstanceOf(SignalStateError);
      expect(busy._unsafeUnwrapErr()).toMatchObject({ reason: 'BUSY' });
      reply(sockets[0], sendHold!, success());
      expect((await pending).isOk()).toBe(true);
      expect(count('send')).toBe(1);
    });

    it('public repair cannot overtake a registered unwritten finalizer even when no RPC or retained-write count is active', async () => {
      const initialState = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
      accounts.startDeviceCheck(account, initialState.revision, Date.now())._unsafeUnwrap();
      await listen();
      await connector.start();
      expect(connector.status()).toMatchObject({
        state: 'reconnecting',
        verification: { state: 'pending', checking: false },
      });
      const ctx = saveReply('waiting');
      const pending = connector.sendPreparedChunk(target, 'waiting', ctx);
      expect(connector.cancelWaiter(ctx)).toBe(true);
      const repair = connector.retryStateWrites();
      expect(repair._unsafeUnwrapErr()).toBeInstanceOf(SignalStateError);
      expect(repair._unsafeUnwrapErr()).toMatchObject({ reason: 'BUSY' });
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        reason: 'CANCELLED',
        retryScope: 'delivery_only',
      });
      expect(saved(ctx)).toMatchObject({ phase: 'ready', nextChunk: 0 });
      expect(count('send') + count('listContacts') + count('listDevices')).toBe(0);
      expect((await connector.stopWithResult()).isOk()).toBe(true);
    });

    it.each(['sender-first', 'verifier-first'] as const)(
      'repairs independent A and sender failures %s without releasing on the other producer health/count0',
      async (order) => {
        await listen();
        await ready();
        const ctx = await poison();
        deviceReply = 'challenge';
        db.exec(`CREATE TRIGGER fail_independent_verifier BEFORE UPDATE OF challenge ON signal_account_state
        BEGIN SELECT RAISE(ABORT, 'synthetic verifier outage'); END`);
        await advance(52_000);
        await until(() => count('listDevices') === 2);
        await flush();
        expect(connector.status()).toMatchObject({ verification: { state: 'suspended' } });
        expect((await connector.stopWithResult()).isErr()).toBe(true);
        const settle = vi.spyOn(accounts, 'clearReservation');
        const hint = vi.spyOn(accounts, 'recordPause');
        const first = connector.retryStateWrites()._unsafeUnwrapErr();
        expect(first).toMatchObject({ reason: 'DATABASE' });
        const initialCalls = [settle.mock.calls.length, hint.mock.calls.length];
        for (let i = 0; i < 25; i++)
          expect(connector.retryStateWrites()._unsafeUnwrapErr()).toBe(first);
        expect([settle.mock.calls.length, hint.mock.calls.length]).toEqual(initialCalls);
        db.exec(
          order === 'sender-first'
            ? 'DROP TRIGGER fail_sender_repair'
            : 'DROP TRIGGER fail_independent_verifier',
        );
        await advance(250);
        const partial = connector.retryStateWrites();
        expect(partial.isErr()).toBe(true);
        expect(partial._unsafeUnwrapErr()).toMatchObject({ reason: 'DATABASE' });
        if (order === 'sender-first') {
          expect(saved(ctx)).toMatchObject({ phase: 'ready', nextChunk: 1, successCount: 1 });
          expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('none');
        } else {
          expect(saved(ctx).phase).toBe('in_flight');
          expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('challenge');
        }
        expect((await connector.stopWithResult()).isErr()).toBe(true);
        expect(connector.status().replacementAllowed).toBe(false);
        const blocked = create();
        blocked.onMessageWithReceipt(receipt);
        await blocked.start();
        expect(blocked.status().reason).toBe('OWNER_BUSY');
        db.exec(
          order === 'sender-first'
            ? 'DROP TRIGGER fail_independent_verifier'
            : 'DROP TRIGGER fail_sender_repair',
        );
        await advance(1000);
        const repaired = connector.retryStateWrites();
        if (order === 'sender-first')
          expect(repaired._unsafeUnwrapErr()).toMatchObject({ reason: 'STALE_CONNECTION' });
        else expect(repaired.isOk()).toBe(true);
        expect(connector.retryStateWrites().isOk()).toBe(true);
        expect((await connector.stopWithResult()).isOk()).toBe(true);
        expect(connector.status().replacementAllowed).toBe(true);
        expect(saved(ctx)).toMatchObject({ phase: 'ready', nextChunk: 1, successCount: 1 });
        expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
          reservation: null,
          pauseKind: 'challenge',
          recoveryNotBefore: 0,
        });
        expect(count('send')).toBe(1);
        expect(count('listContacts')).toBe(1);
        expect(count('listDevices')).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it.each(['listAccounts', 'listDevices', 'subscribeReceive'])(
      'stop while actual %s stage is pending cancels requests/late health reactions without reviving schedules',
      async (stage) => {
        answer = (request, socket) => {
          if (request.method !== stage) defaultAnswer(request, socket);
        };
        await listen();
        const starting = connector.start();
        await until(() => count(stage) === 1);
        expect((await connector.stopWithResult()).isOk()).toBe(true);
        await starting;
        await advance(300_000);
        expect(connector.status()).toMatchObject({ state: 'stopped', replacementAllowed: true });
        expect(count('send')).toBe(0);
        expect(count(stage)).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  });
});
