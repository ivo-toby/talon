/**
 * Unit tests for outbound attachments on channel.send: the channel.attach
 * capability, connector support negotiation, refusal before any provider
 * call, mixed delivery results, ledger refs and persisted metadata.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelSendHandler } from '../../../../src/tools/host-tools/channel-send.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { ChannelRegistry } from '../../../../src/channels/channel-registry.js';
import type { ChannelConnector, SendReceipt } from '../../../../src/channels/channel-types.js';
import type { OutboundAttachmentPolicy } from '../../../../src/attachments/outbound-attachment-resolver.js';
import type { ResolvedCapabilities } from '../../../../src/personas/persona-types.js';
import { ChannelError } from '../../../../src/core/errors/error-types.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1),
]);
const THREAD = {
  id: 'thread-001',
  external_id: 'chat-1',
  channel_id: 'chan-001',
  metadata: '{}',
  created_at: 0,
  updated_at: 0,
};

let dataDir: string;
let artifacts: string;

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeConnector(
  receipt: SendReceipt | undefined,
  opts: { supports?: boolean; type?: string } = {},
): ChannelConnector {
  return {
    type: opts.type ?? 'telegram',
    name: 'my-telegram',
    ...(opts.supports === false
      ? {}
      : { outboundAttachments: { maxBytes: 1_000_000, maxFiles: 10 } }),
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(ok(receipt)),
    format: vi.fn((s: string) => s),
  };
}

function setup(
  connector: ChannelConnector,
  capabilities: ResolvedCapabilities = {
    allow: ['channel.send:*', 'channel.attach'],
    requireApproval: [],
  },
) {
  const messageRepository = { insert: vi.fn().mockReturnValue(ok({})) };
  const messageRefRepository = {
    find: vi.fn().mockReturnValue(ok(null)),
    record: vi.fn().mockReturnValue(ok(undefined)),
  };
  const logger = makeLogger();
  const policy: OutboundAttachmentPolicy = {
    allowedRoots: [],
    deniedPaths: [dataDir],
    maxBytes: 1_000_000,
    maxPerMessage: 5,
    allowedMimeTypes: ['image/png', 'text/plain'],
  };
  const handler = new ChannelSendHandler({
    channelRegistry: { get: vi.fn().mockReturnValue(connector) } as unknown as ChannelRegistry,
    threadRepository: {
      findById: vi.fn().mockReturnValue(ok(THREAD)),
      findByExternalId: vi.fn().mockReturnValue(ok(THREAD)),
    } as any,
    channelRepository: {
      findByName: vi
        .fn()
        .mockReturnValue(ok({ id: 'chan-001', type: 'telegram', name: 'my-telegram' })),
      findById: vi.fn(),
    } as any,
    messageRepository,
    messageRefRepository,
    resolveCapabilities: () => capabilities,
    attachmentPolicy: policy,
    threadArtifactsDir: () => artifacts,
    logger,
  });
  return { handler, messageRepository, messageRefRepository, logger };
}

const context: ToolExecutionContext = {
  runId: 'run-1',
  threadId: 'thread-001',
  personaId: 'p-1',
  requestId: 'req-1',
};

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'talon-send-')));
  artifacts = join(dataDir, 'threads', 'thread-001', 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'shot.png'), PNG);
  writeFileSync(join(artifacts, 'log.txt'), 'build ok\n');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('channel.send attachments', () => {
  it('delivers files from the thread artifacts dir and records ledger refs and metadata', async () => {
    const connector = makeConnector({
      externalMessageId: '10',
      attachments: [
        { index: 0, status: 'sent', externalMessageId: '11' },
        { index: 1, status: 'sent', externalMessageId: '12' },
      ],
    });
    const { handler, messageRepository, messageRefRepository } = setup(connector);

    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: 'Here you go',
        attachments: [
          { path: join(artifacts, 'shot.png'), caption: 'Screenshot' },
          { path: join(artifacts, 'log.txt') },
        ],
      },
      context,
    );

    expect(result.status).toBe('success');
    const output = vi.mocked(connector.send).mock.calls[0]![1];
    expect(output.attachments?.map((a) => [a.filename, a.mimeType, a.kind, a.caption])).toEqual([
      ['shot.png', 'image/png', 'image', 'Screenshot'],
      ['log.txt', 'text/plain', 'file', undefined],
    ]);
    expect(result.result).toMatchObject({
      sent: true,
      attachments: [
        { index: 0, filename: 'shot.png', status: 'sent' },
        { index: 1, filename: 'log.txt', status: 'sent' },
      ],
    });

    const persisted = JSON.parse(messageRepository.insert.mock.calls[0]![0].content);
    expect(persisted.body).toBe(
      'Here you go\n[Attached: shot.png (image/png, 24 B), log.txt (text/plain, 9 B)]',
    );
    expect(persisted.attachments).toEqual([
      expect.objectContaining({
        filename: 'shot.png',
        mimeType: 'image/png',
        size: 24,
        sha256: expect.any(String),
      }),
      expect.objectContaining({ filename: 'log.txt', mimeType: 'text/plain', size: 9 }),
    ]);
    expect(JSON.stringify(persisted)).not.toContain(dataDir);

    const refs = messageRefRepository.record.mock.calls.map((c) => [c[0].external_id, c[0].text]);
    expect(refs).toEqual([
      ['10', persisted.body],
      ['11', '[Attachment: shot.png] Screenshot'],
      ['12', '[Attachment: log.txt]'],
    ]);
  });

  it('allows empty content when attachments are given', async () => {
    const connector = makeConnector({
      externalMessageId: '11',
      attachments: [{ index: 0, status: 'sent', externalMessageId: '11' }],
    });
    const { handler } = setup(connector);
    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: '',
        attachments: [{ path: join(artifacts, 'shot.png') }],
      },
      context,
    );
    expect(result.status).toBe('success');
  });

  it('refuses without channel.attach and sends nothing', async () => {
    const connector = makeConnector(undefined);
    const { handler } = setup(connector, { allow: ['channel.send:*'], requireApproval: [] });
    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: 'x',
        attachments: [{ path: join(artifacts, 'shot.png') }],
      },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('[capability_denied]');
    expect(connector.send).not.toHaveBeenCalled();
  });

  it('refuses a channel without attachment support (terminal) and sends nothing', async () => {
    const connector = makeConnector(undefined, { supports: false, type: 'terminal' });
    const { handler } = setup(connector);
    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: 'x',
        attachments: [{ path: join(artifacts, 'shot.png') }],
      },
      context,
    );
    expect(result.error).toContain('[channel_unsupported]');
    expect(result.error).toContain('does not support attachments');
    expect(connector.send).not.toHaveBeenCalled();
  });

  it('refuses paths outside the artifacts dir (including the rest of the data dir) before any provider call', async () => {
    writeFileSync(join(dataDir, 'talond.sqlite'), 'x');
    const connector = makeConnector(undefined);
    const { handler, logger } = setup(connector);
    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: 'x',
        attachments: [
          { path: join(dataDir, 'talond.sqlite') },
          { path: join(artifacts, '..', '..', '..', 'talond.sqlite') },
        ],
      },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('[outside_allowed_roots]');
    expect(result.error).not.toContain(dataDir);
    expect(connector.send).not.toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain(dataDir);
  });

  it('refuses attachments in voice runs', async () => {
    const connector = makeConnector(undefined);
    const { handler } = setup(connector);
    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: 'x',
        attachments: [{ path: join(artifacts, 'shot.png') }],
      },
      { ...context, voiceObservation: { runId: 'run-1', threadId: 'thread-001' } as any },
    );
    expect(result.status).toBe('error');
    expect(connector.send).not.toHaveBeenCalled();
  });

  it('reports a partly failed delivery to the agent and tells the human', async () => {
    const connector = makeConnector({
      externalMessageId: '10',
      attachments: [
        {
          index: 0,
          status: 'failed',
          error: 'Telegram sendDocument failed (413): Request Entity Too Large',
        },
        { index: 1, status: 'sent', externalMessageId: '12' },
      ],
    });
    const { handler, messageRepository } = setup(connector);
    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: 'Results',
        attachments: [{ path: join(artifacts, 'shot.png') }, { path: join(artifacts, 'log.txt') }],
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(result.result).toMatchObject({
      attachments: [
        { index: 0, status: 'failed', error: expect.stringContaining('413') },
        { index: 1, status: 'sent' },
      ],
      note: expect.stringContaining('1 of 2 attachments failed'),
    });
    const calls = vi.mocked(connector.send).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1].body).toBe('⚠️ An attachment could not be sent: shot.png');
    const persisted = JSON.parse(messageRepository.insert.mock.calls[0]![0].content);
    expect(persisted.attachments.map((a: { filename: string }) => a.filename)).toEqual(['log.txt']);
  });

  it('returns an error when there was no text and every attachment failed', async () => {
    const connector = makeConnector({
      attachments: [{ index: 0, status: 'failed', error: 'boom' }],
    });
    const { handler } = setup(connector);
    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: '',
        attachments: [{ path: join(artifacts, 'shot.png') }],
      },
      context,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('nothing was sent');
  });

  it('fails like a text send when the connector rejects the message', async () => {
    const connector = makeConnector(undefined);
    vi.mocked(connector.send).mockResolvedValue(err(new ChannelError('down')));
    const { handler, messageRepository } = setup(connector);
    const result = await handler.execute(
      {
        channelId: 'my-telegram',
        content: 'x',
        attachments: [{ path: join(artifacts, 'shot.png') }],
      },
      context,
    );
    expect(result.status).toBe('error');
    expect(messageRepository.insert).not.toHaveBeenCalled();
  });
});
