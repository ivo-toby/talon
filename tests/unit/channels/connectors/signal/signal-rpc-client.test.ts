import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SignalRpcClient } from '../../../../../src/channels/connectors/signal/signal-rpc-client.js';
import {
  parseSignalRpcFrame,
  parseSignalSendEvidence,
  type SignalRpcRequest,
} from '../../../../../src/channels/connectors/signal/signal-wire.js';
import { SignalDeliveryError } from '../../../../../src/core/errors/error-types.js';

// Pinned source contracts, NOT live Signal evidence: signal-cli v0.14.9,
// 3997429779095ff3a2d64c877126e84fce9852aa. All paths below are relative to upstream.
const account = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const recipientAddress = {
  uuid: 'cccccccc-1111-2222-3333-dddddddddddd',
  number: null,
  username: null,
};
// SendCommand.java:47-55,125-142; man/signal-cli-jsonrpc.5.adoc:92-99.
const send = {
  method: 'send',
  params: { account, noteToSelf: true, message: 'fixture 😀' },
} as const;
const maximum = 1024 * 1024;
const notification = (subscription: number, envelope: unknown = {}) => ({
  jsonrpc: '2.0',
  method: 'receive',
  params: { subscription, result: { account, envelope } },
});
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await pause();
  expect(predicate()).toBe(true);
}

// JsonRpcResponse.java:13-46,75-105 defines mutual exclusion, IDs and typed errors.
describe('signal-wire outer JSONRPC conformance', () => {
  it('parses string/numeric/null IDs without coercing correlation', () => {
    for (const id of ['7', 7, null]) {
      expect(
        parseSignalRpcFrame(
          Buffer.from(line({ jsonrpc: '2.0', id, result: {} }).trim()),
        )._unsafeUnwrap(),
      ).toMatchObject({ kind: 'result', id, value: {} });
    }
  });

  it.each([
    '[]',
    '{}',
    '{"jsonrpc":"1.0","id":"a","result":1}',
    '{"jsonrpc":"2.0","id":{},"result":1}',
    '{"jsonrpc":"2.0","id":"a","result":1,"error":{"code":-3,"message":"private"}}',
    '{"jsonrpc":"2.0","id":"a"}',
    '{"jsonrpc":"2.0","id":"a","error":{"code":1.2,"message":"private"}}',
    '{"jsonrpc":"2.0","method":"receive","id":"a","params":{}}',
    '{"jsonrpc":"2.0","method":2,"params":{}}',
    '{"private-key":',
  ])('rejects outer failure with a fixed safe diagnostic: %s', (input) => {
    const error = parseSignalRpcFrame(Buffer.from(input))._unsafeUnwrapErr();
    expect(error.message).toBe('Signal wire rejected: INVALID_FRAME');
    expect(error.cause).toBeUndefined();
  });

  it('accepts bounded wide and deeply nested payloads without call-stack-dependent limits', () => {
    const wide = `{"jsonrpc":"2.0","id":"a","result":[${'0,'.repeat(200_000)}0]}`;
    const deep = `{"jsonrpc":"2.0","id":"a","result":${'['.repeat(20_000)}0${']'.repeat(20_000)}}`;
    expect(parseSignalRpcFrame(Buffer.from(wide)).isOk()).toBe(true);
    expect(parseSignalRpcFrame(Buffer.from(deep)).isOk()).toBe(true);
  });

  it('rejects invalid UTF-8 rather than replacing malformed bytes', () => {
    const bytes = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    expect(parseSignalRpcFrame(bytes).isErr()).toBe(true);
  });

  it('strips remote text/data while retaining known codes and error.data.response evidence', () => {
    // SignalJsonRpcCommandHandler.java:40-44,249-290; SendMessageResultUtils.java:43-68.
    const frame = parseSignalRpcFrame(
      Buffer.from(
        line({
          jsonrpc: '2.0',
          id: 'a',
          error: {
            code: -5,
            message: 'private error',
            data: {
              response: {
                timestamp: 100,
                results: [
                  {
                    recipientAddress,
                    type: 'RATE_LIMIT_FAILURE',
                    retryAfterSeconds: 50,
                    token: 'secret-token',
                  },
                ],
              },
              privateField: 'private-data',
            },
          },
        }).trim(),
      ),
    )._unsafeUnwrap();
    expect(frame.kind).toBe('failure');
    if (frame.kind !== 'failure') return;
    expect(frame.error.remoteCode).toBe('RATE_LIMIT');
    expect(frame.error.sendEvidence).toMatchObject({
      complete: true,
      timestampValid: true,
      results: [
        {
          type: 'RATE_LIMIT_FAILURE',
          challengeRequired: true,
          retryAfter: { kind: 'valid', seconds: 50 },
        },
      ],
    });
    expect(JSON.stringify(frame.error)).not.toMatch(/private|secret-token|cccccccc/);
    expect(frame.error.sendEvidence).not.toHaveProperty('timestamp');
    expect(frame.error.message).toBe('Signal RPC rejected: RATE_LIMIT');
  });

  it('retains incomplete/unknown send evidence and valid successes without inventing defaults', () => {
    // JsonSendMessageResult.java:10-48; JsonRecipientAddress.java:9-15.
    const evidence = parseSignalSendEvidence({
      timestamp: 100,
      results: [
        { recipientAddress, type: 'SUCCESS' },
        {
          recipientAddress,
          type: 'RATE_LIMIT_FAILURE',
          retryAfterSeconds: 'private',
          token: 'secret',
        },
        { recipientAddress: {}, type: 'SUCCESS' },
        { recipientAddress, type: 'FUTURE_TYPE' },
      ],
    });
    expect(evidence.complete).toBe(false);
    expect(evidence.results).toHaveLength(4);
    expect(evidence.results[0]?.type).toBe('SUCCESS');
    expect(evidence.results[1]).toMatchObject({
      challengeRequired: true,
      retryAfter: { kind: 'invalid' },
    });
    expect(evidence.results[2]?.valid).toBe(false);
    expect(evidence.results[3]?.type).toBe('UNKNOWN');
    expect(parseSignalSendEvidence({ results: [] }).timestampValid).toBe(false);
    expect(parseSignalSendEvidence({ timestamp: 100, results: [] }).complete).toBe(false);
    expect(Object.isFrozen(evidence.results)).toBe(true);
  });
});

describe('signal-rpc-client real Unix socket boundary', () => {
  let directory: string;
  let socketPath: string;
  let server: Server;
  let peer: Socket;
  let client: SignalRpcClient;
  let requests: { id: string; method: string; params?: Record<string, unknown> }[];
  const received: unknown[] = [];
  const closed: string[] = [];

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(homedir(), '.sig-rpc-'));
    socketPath = join(directory, 'rpc.sock');
    requests = [];
    received.length = 0;
    closed.length = 0;
    server = createServer((socket) => {
      peer = socket;
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          requests.push(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
    client = new SignalRpcClient({
      socketPath,
      requestTimeoutMs: 1000,
      onReceive: (event) => {
        received.push(event);
      },
      onClose: (error) => {
        closed.push(error.transportCode);
      },
    });
  });

  afterEach(async () => {
    client.stop();
    peer?.destroy();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function connect(): Promise<void> {
    expect((await client.connect()).isOk()).toBe(true);
    await until(() => peer !== undefined && !peer.destroyed);
  }

  async function subscribe(): Promise<void> {
    const promise = client.request({ method: 'subscribeReceive', params: { account } });
    const index = requests.length;
    await until(() => requests.length > index);
    peer.write(line({ jsonrpc: '2.0', id: requests.at(-1)!.id, result: 4 }));
    expect((await promise).isOk()).toBe(true);
  }

  it('writes pinned newline UTF-8 requests and correlates out-of-order responses exactly', async () => {
    // man/signal-cli-jsonrpc.5.adoc:48-50,83-99; SocketHandler.java:114-118.
    await connect();
    const a = client.request({ method: 'version' });
    const b = client.request({ method: 'listDevices', params: { account } });
    await until(() => requests.length === 2);
    expect(requests[0]).toEqual({ jsonrpc: '2.0', id: requests[0]!.id, method: 'version' });
    expect(requests[1]?.params).toEqual({ account });
    expect(requests[0]?.id).not.toBe(requests[1]?.id);
    peer.write(
      line({ jsonrpc: '2.0', id: requests[1]!.id, result: [] }) +
        line({ jsonrpc: '2.0', id: requests[0]!.id, result: { version: '0.14.9' } }),
    );
    expect((await b)._unsafeUnwrap()).toEqual({ kind: 'result', value: [] });
    expect((await a)._unsafeUnwrap()).toEqual({ kind: 'result', value: { version: '0.14.9' } });
  });

  it('writes the reviewed account lookup and plain-text target variants without extra parameters', async () => {
    // ListAccountsCommand.java:12-47; ListDevicesCommand.java:24-42;
    // ListGroupsCommand.java:35-40; ListContactsCommand.java:30-65;
    // SendCommand.java:47-55,125-142 and man/signal-cli-jsonrpc.5.adoc:83-99,156-164.
    await connect();
    const inputs: SignalRpcRequest[] = [
      { method: 'listAccounts' },
      { method: 'listGroups', params: { account, groupId: ['+/8='] } },
      {
        method: 'listContacts',
        params: { account, recipient: [recipientAddress.uuid], allRecipients: true },
      },
      {
        method: 'send',
        params: { account, recipient: [recipientAddress.uuid], message: 'fixture DM' },
      },
      { method: 'send', params: { account, groupId: '+/8=', message: 'fixture group' } },
    ];
    const pending = inputs.map((request) => client.request(request));
    await until(() => requests.length === inputs.length);
    requests.forEach((request, index) => {
      expect(request).toEqual({ jsonrpc: '2.0', id: request.id, ...inputs[index] });
      peer.write(
        line({
          jsonrpc: '2.0',
          id: request.id,
          result:
            request.method === 'send'
              ? { timestamp: 100, results: [{ recipientAddress, type: 'SUCCESS' }] }
              : [],
        }),
      );
    });
    expect((await Promise.all(pending)).every((result) => result.isOk())).toBe(true);
  });

  it('buffers early manual notifications, checks subscription, and excludes invalid events without closing', async () => {
    // SignalJsonRpcDispatcherHandler.java:179-199,255-280: nested result, integer subscription.
    await connect();
    const pending = client.request({ method: 'subscribeReceive', params: { account } });
    await until(() => requests.length === 1);
    peer.write(line(notification(4, { dataMessage: { message: '😀' } })));
    await pause();
    expect(received).toHaveLength(0);
    const packet = Buffer.from(
      line({ jsonrpc: '2.0', id: requests[0]!.id, result: 4 }) +
        line(notification(5)) +
        line({
          jsonrpc: '2.0',
          method: 'receive',
          params: { subscription: 'invalid', result: null },
        }) +
        line(notification(4, { sourceDevice: 'invalid' })),
    );
    const cut = packet.indexOf(Buffer.from('invalid')) + 1;
    peer.write(packet.subarray(0, cut));
    peer.write(packet.subarray(cut));
    expect((await pending).isOk()).toBe(true);
    await until(() => received.length === 2);
    expect(closed).toEqual([]);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it.each([0, -1, 2147483647, -2147483648])(
    'correlates the signed Java integer subscription ID %s',
    async (subscription) => {
      // DispatcherHandler.java:158-171 uses AtomicInteger, not an unsigned counter.
      await connect();
      const pending = client.request({ method: 'subscribeReceive', params: { account } });
      await until(() => requests.length === 1);
      peer.write(
        line({ jsonrpc: '2.0', id: requests[0]!.id, result: subscription }) +
          line(notification(subscription)),
      );
      expect((await pending).isOk()).toBe(true);
      await until(() => received.length === 1);
      expect(closed).toEqual([]);
    },
  );

  it('does not expose receive exception text and does not close for payload faults', async () => {
    // JsonReceiveMessageHandler.java:23-35; JsonError.java:5-9.
    await connect();
    await subscribe();
    peer.write(
      line({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          subscription: 4,
          result: {
            account,
            exception: { message: 'private receive error', type: 'UntrustedIdentityException' },
            envelope: {},
          },
        },
      }),
    );
    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({ hasException: true });
    expect(JSON.stringify(received)).not.toContain('private');
    expect(closed).toEqual([]);
  });

  it('handles UTF-8 code points split across socket packets', async () => {
    await connect();
    const pending = client.request({ method: 'version' });
    await until(() => requests.length === 1);
    const bytes = Buffer.from(
      line({ jsonrpc: '2.0', id: requests[0]!.id, result: { fixture: '😀' } }),
    );
    const split = bytes.indexOf(Buffer.from('😀')) + 2;
    peer.write(bytes.subarray(0, split));
    await pause();
    peer.write(bytes.subarray(split));
    expect((await pending)._unsafeUnwrap()).toEqual({ kind: 'result', value: { fixture: '😀' } });
  });

  it.each(['{invalid}\n', '{"jsonrpc":"2.0","id":{},"result":1}\n'])(
    'closes/discards on outer failure without resynchronizing: %s',
    async (bad) => {
      await connect();
      await subscribe();
      const pending = client.request(send);
      await until(() => requests.length === 2);
      peer.write(
        bad + line(notification(4)) + line({ jsonrpc: '2.0', id: requests[1]!.id, result: {} }),
      );
      const error = (await pending)._unsafeUnwrapErr();
      expect(error).toBeInstanceOf(SignalDeliveryError);
      expect(error).toMatchObject({
        transportCode: 'PROTOCOL_FAILURE',
        outcome: 'UNKNOWN',
        currentChunkAcceptance: 'unknown',
        retryScope: 'none',
      });
      expect(received).toHaveLength(0);
      expect(closed).toEqual(['PROTOCOL_FAILURE']);
    },
  );

  it('applies the exact 1 MiB line bound in bytes, including unterminated Unicode', async () => {
    await connect();
    const pending = client.request({ method: 'version' });
    await until(() => requests.length === 1);
    const prefix = `{"jsonrpc":"2.0","id":"${requests[0]!.id}","result":"`;
    peer.write(`${prefix}${'x'.repeat(maximum - Buffer.byteLength(prefix) - 2)}"}\n`);
    expect((await pending).isOk()).toBe(true);
    const next = client.request(send);
    peer.write('😀'.repeat(maximum / 4 + 1));
    expect((await next)._unsafeUnwrapErr()).toMatchObject({
      transportCode: 'FRAME_TOO_LARGE',
      outcome: 'UNKNOWN',
    });
  });

  it('caps early-notification bytes and discards them on overflow', async () => {
    await connect();
    const pending = client.request({ method: 'subscribeReceive', params: { account } });
    await until(() => requests.length === 1);
    const event = line(notification(4, { fixture: '😀'.repeat(140_000) }));
    peer.write(event + event);
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      transportCode: 'PRE_RESPONSE_OVERFLOW',
    });
    expect(received).toHaveLength(0);
  });

  it('refuses request 65 before writing with typed transient NOT_SENT metadata', async () => {
    await connect();
    const pending = Array.from({ length: 64 }, () => client.request({ method: 'version' }));
    const refused = await client.request(send);
    expect(refused._unsafeUnwrapErr()).toMatchObject({
      reason: 'RPC_CAPACITY',
      outcome: 'NOT_SENT',
      currentChunkAcceptance: 'unwritten',
      retryScope: 'delivery_only',
    });
    await until(() => requests.length === 64);
    client.stop();
    await Promise.all(pending);
    expect(requests.every((request) => request.method === 'version')).toBe(true);
  });

  it('rejects provisioning/media methods and media send parameters before writing', async () => {
    await connect();
    for (const request of [
      { method: 'startLink' },
      { method: 'getAttachment' },
      { ...send, params: { ...send.params, attachment: '/private' } },
    ]) {
      // Deliberately exercise the runtime boundary as an untyped caller.
      // @ts-expect-error disallowed runtime input
      expect((await client.request(request))._unsafeUnwrapErr()).toMatchObject({
        outcome: 'NOT_SENT',
        transportCode: 'INVALID_REQUEST',
      });
    }
    expect(requests).toHaveLength(0);
  });

  it('distinguishes pre-abort/unconnected unwritten from submitted abort/disconnect/stop', async () => {
    expect((await client.request(send))._unsafeUnwrapErr()).toMatchObject({ outcome: 'NOT_SENT' });
    await connect();
    const before = new AbortController();
    before.abort();
    expect(
      (await client.request(send, { signal: before.signal }))._unsafeUnwrapErr(),
    ).toMatchObject({ outcome: 'NOT_SENT' });
    const after = new AbortController();
    const pending = client.request(send, { signal: after.signal });
    await until(() => requests.length === 1);
    after.abort();
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'CANCELLED',
    });
    const disconnected = client.request(send);
    await until(() => requests.length === 2);
    peer.destroy();
    expect((await disconnected)._unsafeUnwrapErr()).toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'DISCONNECTED',
    });
  });

  function captureConnectingSockets(): Socket[] {
    const sockets: Socket[] = [];
    const original = Socket.prototype.connect;
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket['connect']>
    ) {
      sockets.push(this);
      return original.apply(this, args);
    });
    return sockets;
  }

  // ListContactsCommand.java:30-65 (pinned v0.14.9): this is a permitted, sub-1-MiB request.
  // Node stream.d.ts:816-830: write(false) requires waiting for drain, independently of RPC settlement.
  const largeLookup: SignalRpcRequest = {
    method: 'listContacts',
    params: {
      account,
      recipient: Array.from({ length: 20_000 }, () => recipientAddress.uuid),
      allRecipients: true,
    },
  };

  it.each(['abort', 'timeout'])(
    'bounds actual paused-peer write buffering across repeated %s settlements and recovers only on drain',
    async (settlement) => {
      const sockets = captureConnectingSockets();
      await connect();
      const socket = sockets[0]!;
      const adjacent = client.request({ method: 'version' });
      await until(() => requests.length === 1);
      peer.pause();
      const write = vi.spyOn(socket, 'write'); // Pass through to the real non-reading Unix peer.
      vi.useFakeTimers();
      try {
        const initialAbort = new AbortController();
        const initial = client.request(largeLookup, { signal: initialAbort.signal });
        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.results[0]?.value).toBe(false);
        expect(socket.writableNeedDrain).toBe(true);
        const bufferedBytes = socket.writableLength;
        expect(bufferedBytes).toBeGreaterThan(0);
        expect(bufferedBytes).toBeLessThanOrEqual(socket.writableHighWaterMark + maximum + 1);

        // Receiving an adjacent response must work, but must not reopen outgoing capacity.
        peer.write(line({ jsonrpc: '2.0', id: requests[0]!.id, result: { version: '0.14.9' } }));
        expect((await adjacent).isOk()).toBe(true);
        if (settlement === 'abort') initialAbort.abort();
        else await vi.advanceTimersByTimeAsync(1000);
        expect((await initial)._unsafeUnwrapErr()).toMatchObject({
          reason: settlement === 'abort' ? 'CANCELLED' : 'TIMEOUT',
          outcome: 'UNKNOWN',
          currentChunkAcceptance: 'unknown',
          retryScope: 'none',
        });

        // Exercise multiple replenished RPC slots, not just one mocked false write.
        const refused = [];
        for (let attempt = 0; attempt < 12; attempt++) {
          const abort = new AbortController();
          const pending = client.request(largeLookup, { signal: abort.signal });
          if (settlement === 'abort') abort.abort();
          else await vi.advanceTimersByTimeAsync(1000);
          refused.push((await pending)._unsafeUnwrapErr());
        }
        expect(write).toHaveBeenCalledOnce();
        expect(socket.writableLength).toBeLessThanOrEqual(bufferedBytes);
        expect(socket.writableNeedDrain).toBe(true);
        for (const error of refused)
          expect(error).toMatchObject({
            transportCode: 'CAPACITY',
            reason: 'RPC_CAPACITY',
            outcome: 'NOT_SENT',
            currentChunkAcceptance: 'unwritten',
            retryScope: 'delivery_only',
          });
        expect((await client.request(send))._unsafeUnwrapErr()).toMatchObject({
          transportCode: 'CAPACITY',
          outcome: 'NOT_SENT',
          retryScope: 'delivery_only',
        });
      } finally {
        vi.useRealTimers();
      }

      peer.resume();
      await until(() => !socket.writableNeedDrain && requests.length === 2);
      const recovered = client.request(send);
      await until(() => requests.length === 3);
      // A late response to the settled lookup cannot resolve the new send or replay the lookup.
      peer.write(
        line({ jsonrpc: '2.0', id: requests[1]!.id, result: [] }) +
          line({
            jsonrpc: '2.0',
            id: requests[2]!.id,
            result: { timestamp: 100, results: [{ recipientAddress, type: 'SUCCESS' }] },
          }),
      );
      expect((await recovered)._unsafeUnwrap()).toMatchObject({
        kind: 'send',
        evidence: { complete: true },
      });
      expect(requests.map((request) => request.method)).toEqual([
        'version',
        'listContacts',
        'send',
      ]);
      expect(write).toHaveBeenCalledTimes(2);
      expect(closed).toEqual([]);
    },
  );

  it.each(['stop', 'disconnect'])(
    'removes %s backpressure state/listener and ignores an old connection drain after replacement',
    async (closure) => {
      const sockets = captureConnectingSockets();
      await connect();
      const oldSocket = sockets[0]!;
      const oldPeer = peer;
      oldPeer.pause();
      const initial = client.request(largeLookup);
      expect(oldSocket.writableNeedDrain).toBe(true);
      const oldDrain = oldSocket.listeners('drain')[0];
      expect(oldDrain).toBeTypeOf('function');
      if (closure === 'stop') client.stop();
      else oldPeer.destroy();
      expect((await initial)._unsafeUnwrapErr()).toMatchObject({
        transportCode: closure === 'stop' ? 'STOPPED' : 'DISCONNECTED',
        outcome: 'UNKNOWN',
      });
      expect(oldSocket.listenerCount('drain')).toBe(0);
      oldPeer.destroy();

      await connect();
      const newSocket = sockets[1]!;
      peer.pause();
      const write = vi.spyOn(newSocket, 'write');
      const current = client.request(largeLookup);
      expect(newSocket.writableNeedDrain).toBe(true);
      oldSocket.emit('drain');
      oldDrain?.(); // Also model a previously captured callback racing with replacement.
      expect((await client.request(send))._unsafeUnwrapErr()).toMatchObject({
        transportCode: 'CAPACITY',
        outcome: 'NOT_SENT',
        currentChunkAcceptance: 'unwritten',
      });
      expect(write).toHaveBeenCalledOnce();
      client.stop();
      expect((await current)._unsafeUnwrapErr()).toMatchObject({
        transportCode: 'STOPPED',
        outcome: 'UNKNOWN',
      });
      expect(newSocket.listenerCount('drain')).toBe(0);
    },
  );

  it('treats write(false) backpressure as possibly written and never retries', async () => {
    await connect();
    const original = Socket.prototype.write;
    vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket['write']>
    ) {
      original.apply(this, args);
      return false;
    });
    const pending = client.request(send);
    await until(() => requests.length === 1);
    client.stop();
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      outcome: 'UNKNOWN',
      retryScope: 'none',
    });
    expect(requests).toHaveLength(1);
  });

  it('times out once, ignores late IDs, and stop clears handlers/timers across a fresh connection', async () => {
    client.stop();
    client = new SignalRpcClient({
      socketPath,
      requestTimeoutMs: 1000,
      onReceive: (event) => {
        received.push(event);
      },
    });
    await connect();
    const timed = client.request(send);
    await until(() => requests.length === 1);
    const oldId = requests[0]!.id;
    expect((await timed)._unsafeUnwrapErr()).toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'TIMEOUT',
    });
    client.stop();
    client.stop();
    await connect();
    const pending = client.request({ method: 'version' });
    await until(() => requests.length === 2);
    expect(requests[1]!.id).not.toBe(oldId);
    peer.write(
      line({ jsonrpc: '2.0', id: oldId, result: 'stale' }) +
        line({ jsonrpc: '2.0', id: requests[1]!.id, result: {} }),
    );
    expect((await pending)._unsafeUnwrap()).toEqual({ kind: 'result', value: {} });
    expect(received).toHaveLength(0);
  });

  it('normalizes actual send success and remote failure at the public request boundary', async () => {
    // SendMessageResultUtils.java:53-68; CommandHandler.java:249-290.
    await connect();
    const successful = client.request(send);
    await until(() => requests.length === 1);
    expect(requests[0]?.params).toEqual(send.params);
    const payload = { timestamp: 100, results: [{ recipientAddress, type: 'SUCCESS' }] };
    peer.write(line({ jsonrpc: '2.0', id: requests[0]!.id, result: payload }));
    expect((await successful)._unsafeUnwrap()).toMatchObject({
      kind: 'send',
      evidence: { complete: true, results: [{ type: 'SUCCESS' }] },
    });
    const refused = client.request(send);
    await until(() => requests.length === 2);
    peer.write(
      line({
        jsonrpc: '2.0',
        id: requests[1]!.id,
        error: { code: -6, message: 'private challenge text', data: { response: payload } },
      }),
    );
    const failure = (await refused)._unsafeUnwrapErr();
    expect(failure).toMatchObject({
      remoteCode: 'CHALLENGE_REQUIRED',
      sendEvidence: { complete: true },
    });
    expect(JSON.stringify(failure)).not.toMatch(/private|cccccccc/);
  });

  it('rejects over-limit Unicode send text rather than implicitly requesting an attachment', async () => {
    // ServiceConfig.java:24 and ManagerImpl.java:947-959: above 2000 UTF-8 bytes creates media.
    await connect();
    expect(
      (
        await client.request({ ...send, params: { ...send.params, message: '😀'.repeat(501) } })
      )._unsafeUnwrapErr(),
    ).toMatchObject({ transportCode: 'INVALID_REQUEST', outcome: 'NOT_SENT' });
    expect(requests).toHaveLength(0);
  });

  it('does not coerce numeric/null IDs and cancellation affects only its own pending request', async () => {
    await connect();
    const cancelled = new AbortController();
    const first = client.request(send, { signal: cancelled.signal });
    const second = client.request({ method: 'version' });
    await until(() => requests.length === 2);
    peer.write(
      line({ jsonrpc: '2.0', id: 0, result: 'stale' }) +
        line({ jsonrpc: '2.0', id: null, result: 'stale' }),
    );
    cancelled.abort();
    peer.write(line({ jsonrpc: '2.0', id: requests[1]!.id, result: { version: '0.14.9' } }));
    expect((await first)._unsafeUnwrapErr()).toMatchObject({
      reason: 'CANCELLED',
      outcome: 'UNKNOWN',
    });
    expect((await second).isOk()).toBe(true);
    expect(closed).toEqual([]);
  });

  it('clears request deadlines/abort handlers on stop and never resends submitted writes', async () => {
    await connect();
    vi.useFakeTimers();
    try {
      const signal = new AbortController();
      const remove = vi.spyOn(signal.signal, 'removeEventListener');
      const pending = client.request(send, { signal: signal.signal });
      expect(vi.getTimerCount()).toBe(1);
      client.stop();
      expect((await pending)._unsafeUnwrapErr()).toMatchObject({
        transportCode: 'STOPPED',
        outcome: 'UNKNOWN',
      });
      expect(remove).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      signal.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an outstanding connect and clears its deadline, without any request write', async () => {
    const signal = new AbortController();
    const pending = client.connect({ signal: signal.signal });
    signal.abort();
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({
      reason: 'CANCELLED',
      outcome: 'NOT_SENT',
    });
    expect(requests).toHaveLength(0);
  });

  it('treats a throwing write as uncertain rather than asserting that bytes were unwritten', async () => {
    await connect();
    vi.spyOn(Socket.prototype, 'write').mockImplementation(() => {
      throw new Error('private IO error');
    });
    const failure = (await client.request(send))._unsafeUnwrapErr();
    expect(failure).toMatchObject({ outcome: 'UNKNOWN', retryScope: 'none' });
    expect(failure.cause).toBeUndefined();
    expect(failure.message).not.toContain('private');
  });

  it('clears early notifications and closes an uncertain cancelled subscription', async () => {
    await connect();
    const signal = new AbortController();
    const pending = client.request(
      { method: 'subscribeReceive', params: { account } },
      { signal: signal.signal },
    );
    await until(() => requests.length === 1);
    peer.write(line(notification(4)));
    await pause();
    signal.abort();
    expect((await pending)._unsafeUnwrapErr()).toMatchObject({ outcome: 'UNKNOWN' });
    expect(received).toHaveLength(0);
    expect(closed).toEqual(['CANCELLED']);
  });

  it('unsubscribes only the confirmed connection subscription and refuses duplicate subscriptions', async () => {
    // DispatcherHandler.java:283-331; CommandHandler.java:282-290 gives {} for no output.
    await connect();
    await subscribe();
    expect(
      (await client.request({ method: 'subscribeReceive', params: { account } })).isErr(),
    ).toBe(true);
    const pending = client.request({
      method: 'unsubscribeReceive',
      params: { account, subscription: 4 },
    });
    await until(() => requests.length === 2);
    peer.write(line({ jsonrpc: '2.0', id: requests[1]!.id, result: {} }) + line(notification(4)));
    expect((await pending).isOk()).toBe(true);
    await pause();
    expect(received).toHaveLength(0);
  });

  it('detects a substituted valid socket inode immediately after connecting, without identity RPCs', async () => {
    const replacement = createServer();
    const replacementPath = join(directory, 'replacement.sock');
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(replacementPath, resolve);
    });
    fs.chmodSync(replacementPath, 0o600);
    try {
      const original = Socket.prototype.connect;
      vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
        this: Socket,
        ...args: Parameters<Socket['connect']>
      ) {
        this.prependOnceListener('connect', () => {
          fs.renameSync(socketPath, join(directory, 'original.sock'));
          fs.renameSync(replacementPath, socketPath);
        });
        return original.apply(this, args);
      });
      expect((await client.connect())._unsafeUnwrapErr().reason).toBe('UNTRUSTED_SOCKET');
      expect(requests).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
    }
  });

  it('rechecks socket trust after connect and before any request', async () => {
    const original = Socket.prototype.connect;
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket['connect']>
    ) {
      this.prependOnceListener('connect', () => fs.chmodSync(socketPath, 0o666));
      return original.apply(this, args);
    });
    expect((await client.connect())._unsafeUnwrapErr().reason).toBe('UNTRUSTED_SOCKET');
    expect(requests).toHaveLength(0);
  });
});
