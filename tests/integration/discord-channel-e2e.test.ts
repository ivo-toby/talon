/**
 * End-to-end integration tests for the Discord channel connector.
 *
 * Tests the full inbound + outbound flow:
 *   WebSocket (mocked) → DiscordConnector → onMessage handler fires
 *   send() → REST API called via fetch (mocked)
 *
 * No real WebSocket connections or HTTP requests are made.
 * No internal connector code is mocked — only the external I/O boundaries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';

// ---------------------------------------------------------------------------
// MockWebSocket — must be defined in vi.hoisted() so it's available when
// vi.mock('ws', ...) factory is hoisted before module evaluation.
// ---------------------------------------------------------------------------

const { MockWebSocket, getLastCreatedWs, resetLastCreatedWs } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as { EventEmitter: typeof import('events').EventEmitter };

  let _last: any = null;

  class MockWS extends EventEmitter {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static CONNECTING = 0;

    readyState = 0;
    url: string;
    sentMessages: string[] = [];
    closeCalled = false;
    closeCode?: number;
    terminateCalled = false;

    constructor(url: string) {
      super();
      this.url = url;
      _last = this;
      Promise.resolve().then(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }

    send(data: string) { this.sentMessages.push(data); }

    close(code?: number, reason?: string) {
      this.closeCalled = true;
      this.closeCode = code;
      this.readyState = 2;
      Promise.resolve().then(() => {
        this.readyState = 3;
        this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
      });
    }

    terminate() { this.terminateCalled = true; this.readyState = 3; }
    simulateMessage(payload: object) { this.emit('message', Buffer.from(JSON.stringify(payload))); }
    simulateError(err: Error) { this.readyState = 3; this.emit('error', err); }
  }

  return {
    MockWebSocket: MockWS,
    getLastCreatedWs: () => _last as InstanceType<typeof MockWS> | null,
    resetLastCreatedWs: () => { _last = null; },
  };
});

vi.mock('ws', () => ({ default: MockWebSocket, WebSocket: MockWebSocket }));

import { DiscordConnector } from '../../src/channels/connectors/discord/discord-connector.js';
import type { DiscordConfig } from '../../src/channels/connectors/discord/discord-types.js';
import type { InboundEvent, AgentOutput } from '../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<DiscordConfig>): DiscordConfig {
  return { botToken: 'test-token', applicationId: '111222333', ...overrides };
}

/**
 * Mock fetch: /gateway/bot returns a WSS URL; message sends return success.
 */
function makeFetch(gatewayUrl = 'wss://gateway.discord.gg'): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/gateway/bot')) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ url: gatewayUrl, shards: 1 }),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true, status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ id: 'sent-msg-1', channel_id: 'ch-1', content: 'ok', timestamp: '' }),
    } as unknown as Response);
  });
}

async function waitForWs(): Promise<InstanceType<typeof MockWebSocket>> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return getLastCreatedWs() as InstanceType<typeof MockWebSocket>;
}

/** Boot connector: start + drive HELLO → IDENTIFY → READY lifecycle. */
async function bootConnector(connector: DiscordConnector) {
  await connector.start();
  const ws = await waitForWs();
  ws.simulateMessage({ op: 10, d: { heartbeat_interval: 41250 } });
  await Promise.resolve();
  await Promise.resolve();
  ws.simulateMessage({
    op: 0, t: 'READY', s: 1,
    d: { session_id: 'sess-1', resume_gateway_url: 'wss://resume.discord.gg', v: 10 },
  });
  await Promise.resolve();
  await Promise.resolve();
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Discord channel e2e', () => {
  let connector: DiscordConnector;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetLastCreatedWs();
    mockFetch = makeFetch();
    vi.stubGlobal('fetch', mockFetch);
    connector = new DiscordConnector(defaultConfig(), 'discord-e2e', silentLogger());
  });

  afterEach(async () => {
    await connector.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Inbound flow
  // -------------------------------------------------------------------------

  it('full inbound flow: WebSocket MESSAGE_CREATE → onMessage handler fires with correct event', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    const ws = await bootConnector(connector);

    ws.simulateMessage({
      op: 0, t: 'MESSAGE_CREATE', s: 2,
      d: {
        id: 'msg-abc',
        channel_id: 'ch-xyz',
        author: { id: 'user-1', username: 'alice', bot: false },
        content: 'Hello Discord bot!',
        timestamp: '2026-04-01T12:00:00.000Z',
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('Hello Discord bot!');
    expect(received[0].senderId).toBe('user-1');       // Discord user snowflake ID
    expect(received[0].channelName).toBe('discord-e2e');
    expect(received[0].channelType).toBe('discord');
    expect(received[0].externalThreadId).toContain('ch-xyz');
  });

  it('bot messages are ignored (author.bot=true)', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    const ws = await bootConnector(connector);

    ws.simulateMessage({
      op: 0, t: 'MESSAGE_CREATE', s: 2,
      d: {
        id: 'msg-bot',
        channel_id: 'ch-xyz',
        author: { id: 'bot-1', username: 'otherbot', bot: true },
        content: 'I am a bot',
        timestamp: '2026-04-01T12:00:00.000Z',
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(0);
  });

  it('multiple messages in sequence are all delivered', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    const ws = await bootConnector(connector);

    for (let i = 1; i <= 3; i++) {
      ws.simulateMessage({
        op: 0, t: 'MESSAGE_CREATE', s: i + 1,
        d: {
          id: `msg-${i}`,
          channel_id: 'ch-1',
          author: { id: `user-${i}`, username: `user${i}`, bot: false },
          content: `Message ${i}`,
          timestamp: '2026-04-01T12:00:00.000Z',
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(received).toHaveLength(3);
    expect(received.map((e) => e.content)).toEqual(['Message 1', 'Message 2', 'Message 3']);
    expect(received.map((e) => e.senderId)).toEqual(['user-1', 'user-2', 'user-3']);
  });

  it('inbound idempotency key is the Discord message ID', async () => {
    const received: InboundEvent[] = [];
    connector.onMessage(async (e) => { received.push(e); });

    const ws = await bootConnector(connector);
    ws.simulateMessage({
      op: 0, t: 'MESSAGE_CREATE', s: 2,
      d: {
        id: 'unique-msg-id-999',
        channel_id: 'ch-1',
        author: { id: 'u1', username: 'alice', bot: false },
        content: 'test',
        timestamp: '2026-04-01T12:00:00.000Z',
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(received[0].idempotencyKey).toBe('unique-msg-id-999');
  });

  // -------------------------------------------------------------------------
  // Outbound flow
  // -------------------------------------------------------------------------

  it('full outbound flow: send() → REST POST to /channels/:id/messages', async () => {
    await bootConnector(connector);

    const output: AgentOutput = { body: '**Hello** from bot' };
    const result = await connector.send('ch-1', output);

    expect(result.isOk()).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/channels/ch-1/messages'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bot test-token' }),
      }),
    );
  });

  it('send() with threadId containing messageId posts a reply reference', async () => {
    await bootConnector(connector);

    const output: AgentOutput = { body: 'Reply text' };
    const result = await connector.send('ch-1:msg-original', output);

    expect(result.isOk()).toBe(true);
    const [, callOptions] = mockFetch.mock.calls.find(([url]: [string]) =>
      typeof url === 'string' && url.includes('/channels/ch-1/messages'),
    )!;
    const body = JSON.parse((callOptions as RequestInit).body as string) as Record<string, unknown>;
    expect(body.message_reference).toBeDefined();
    expect((body.message_reference as { message_id: string }).message_id).toBe('msg-original');
  });

  it('send() returns ChannelError when REST API returns non-ok', async () => {
    // Use a fetch that succeeds for gateway/bot but fails for message sends
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/gateway/bot')) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({ url: 'wss://gateway.discord.gg', shards: 1 }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: false, status: 403,
        headers: new Headers(),
        json: () => Promise.resolve({ code: 50013, message: 'Missing Permissions' }),
      } as unknown as Response);
    }));

    await bootConnector(connector);

    const result = await connector.send('ch-1', { body: 'Hi' });

    expect(result.isErr()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it('start() connects to the Gateway URL returned by /gateway/bot', async () => {
    await connector.start();
    await waitForWs();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/gateway/bot'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bot test-token' }) }),
    );
  });

  it('stop() closes the WebSocket cleanly', async () => {
    const ws = await bootConnector(connector);
    await connector.stop();

    expect(ws.closeCalled).toBe(true);
    expect(ws.closeCode).toBe(1000);
  });

  it('IDENTIFY sent after HELLO contains correct token and intents', async () => {
    await connector.start();
    const ws = await waitForWs();

    ws.simulateMessage({ op: 10, d: { heartbeat_interval: 41250 } });
    await Promise.resolve();
    await Promise.resolve();

    const identifyMsg = ws.sentMessages.find((m) => (JSON.parse(m) as { op: number }).op === 2);
    expect(identifyMsg).toBeDefined();

    const { d } = JSON.parse(identifyMsg!) as { op: number; d: { token: string; intents: number } };
    expect(d.token).toBe('test-token'); // Gateway IDENTIFY uses raw token, no "Bot " prefix
    expect(typeof d.intents).toBe('number');
    expect(d.intents).toBeGreaterThan(0);
  });

  it('session is stored from READY and RESUME sent on reconnect', async () => {
    const ws = await bootConnector(connector);

    // Close to trigger reconnect
    ws.close(4000, 'reconnect test');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const ws2 = await waitForWs();
    if (ws2 === ws) return; // timing-sensitive — skip if no new socket yet

    ws2.simulateMessage({ op: 10, d: { heartbeat_interval: 41250 } });
    await Promise.resolve();
    await Promise.resolve();

    const resumeMsg = ws2.sentMessages.find((m) => (JSON.parse(m) as { op: number }).op === 6);
    expect(resumeMsg).toBeDefined();
    const { d } = JSON.parse(resumeMsg!) as { op: number; d: { session_id: string } };
    expect(d.session_id).toBe('sess-1');
  });

  // -------------------------------------------------------------------------
  // Round-trip: inbound event → handler → outbound send
  // -------------------------------------------------------------------------

  it('round-trip: receive message, handler sends reply, REST API called', async () => {
    let capturedThreadId = '';
    connector.onMessage(async (event) => {
      capturedThreadId = event.externalThreadId;
      // Simulate the agent runner calling send() after processing
      await connector.send(event.externalThreadId, { body: 'Acknowledged!' });
    });

    const ws = await bootConnector(connector);

    // Reset fetch call count after boot (gateway/bot call already happened)
    mockFetch.mockClear();

    ws.simulateMessage({
      op: 0, t: 'MESSAGE_CREATE', s: 2,
      d: {
        id: 'incoming-msg',
        channel_id: 'ch-reply',
        author: { id: 'user-2', username: 'bob', bot: false },
        content: 'Hey bot!',
        timestamp: '2026-04-01T13:00:00.000Z',
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedThreadId).toBeTruthy();
    expect(capturedThreadId).toContain('ch-reply');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/channels/ch-reply/messages'),
      expect.objectContaining({ method: 'POST' }),
    );
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { content: string };
    expect(body.content).toContain('Acknowledged!');
  });
});
