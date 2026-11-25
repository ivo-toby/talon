import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';
import { MessagePipeline } from '../../../src/pipeline/message-pipeline.js';
import type { InboundEvent } from '../../../src/channels/channel-types.js';
import type { InboundCommandHandler } from '../../../src/pipeline/pipeline-types.js';

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelType: 'telegram',
    channelName: 'test-bot',
    externalThreadId: 'ext-1',
    senderId: 'user-1',
    idempotencyKey: 'key-1',
    content: '/approve ABC123',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function setup() {
  const messageRepo = {
    insert: vi.fn(() => ok({})),
    existsByIdempotencyKey: vi.fn(() => false),
  };
  const threadRepo = {
    findByExternalId: vi.fn(() => ok({ id: 'thread-1' })),
    insert: vi.fn(() => ok({})),
  };
  const channelRepo = { findByName: vi.fn(() => ok({ id: 'chan-1' })) };
  const queueManager = { enqueue: vi.fn(() => ok({ id: 'q1' })) };
  const router = { resolvePersona: vi.fn(() => ok('persona-1')) };
  const auditLogger = { logChannelSend: vi.fn() };
  const logger = pino({ level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  const pipeline = new MessagePipeline(
    messageRepo as never,
    threadRepo as never,
    channelRepo as never,
    queueManager as never,
    router as never,
    auditLogger as never,
    logger,
  );
  const handle = vi.fn<InboundCommandHandler['handle']>();
  const matches = vi.fn<InboundCommandHandler['matches']>(() => true);
  const sendReply = vi.fn(async (_c: string, _t: string, _b: string) =>
    ok<unknown, unknown>(undefined),
  );
  pipeline.setInboundCommandHandler({ matches, handle }, sendReply);
  return {
    pipeline,
    matches,
    handle,
    sendReply,
    messageRepo,
    threadRepo,
    queueManager,
    warn,
    error,
  };
}

describe('MessagePipeline inbound command hook', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('does not call handle when matches returns false', async () => {
    s.matches.mockReturnValue(false);
    const result = await s.pipeline.handleInboundEvent(makeEvent());
    expect(result._unsafeUnwrap()).toBe('enqueued');
    expect(s.handle).not.toHaveBeenCalled();
  });

  it('treats a throwing matches as not handled and logs without content', async () => {
    s.matches.mockImplementation(() => {
      throw new Error('boom ABC123');
    });
    const result = await s.pipeline.handleInboundEvent(makeEvent());
    expect(result._unsafeUnwrap()).toBe('enqueued');
    expect(s.handle).not.toHaveBeenCalled();
    expect(s.error).toHaveBeenCalled();
    expect(JSON.stringify(s.error.mock.calls)).not.toContain('ABC123');
  });

  it('reaches the thread lookup synchronously when matches returns false', () => {
    s.matches.mockReturnValue(false);
    const p = s.pipeline.handleInboundEvent(makeEvent({ content: '/approve ABCDEFGH' }));
    expect(s.threadRepo.findByExternalId).toHaveBeenCalled();
    return p;
  });

  it('sends the reply and persists and enqueues nothing for a handled command', async () => {
    s.handle.mockResolvedValue({ reply: 'Approved.' });
    const result = await s.pipeline.handleInboundEvent(makeEvent());
    expect(result._unsafeUnwrap()).toBe('ignored');
    expect(s.sendReply).toHaveBeenCalledWith('test-bot', 'ext-1', 'Approved.');
    expect(s.threadRepo.findByExternalId).not.toHaveBeenCalled();
    expect(s.threadRepo.insert).not.toHaveBeenCalled();
    expect(s.messageRepo.insert).not.toHaveBeenCalled();
    expect(s.queueManager.enqueue).not.toHaveBeenCalled();
  });

  it('continues normally when the handler returns undefined', async () => {
    s.handle.mockResolvedValue(undefined);
    const result = await s.pipeline.handleInboundEvent(makeEvent({ content: '/help me' }));
    expect(result._unsafeUnwrap()).toBe('enqueued');
    expect(s.sendReply).not.toHaveBeenCalled();
    expect(s.queueManager.enqueue).toHaveBeenCalled();
  });

  it('treats a rejecting handler as not handled and logs without content', async () => {
    s.handle.mockRejectedValue(new Error('boom'));
    const result = await s.pipeline.handleInboundEvent(makeEvent());
    expect(result._unsafeUnwrap()).toBe('enqueued');
    expect(s.error).toHaveBeenCalled();
    expect(JSON.stringify(s.error.mock.calls)).not.toContain('ABC123');
  });

  it('never offers a reaction event', async () => {
    const event = makeEvent({ reaction: { emoji: '👍', targetMessageId: 'm1' } } as never);
    await s.pipeline.handleInboundEvent(event);
    expect(s.handle).not.toHaveBeenCalled();
  });

  it('consumes an event with an attachment whose caption is a command', async () => {
    s.handle.mockResolvedValue({ reply: 'Approved.' });
    const event = makeEvent({
      attachments: [{ kind: 'image', mimeType: 'image/png' }],
    } as never);
    const result = await s.pipeline.handleInboundEvent(event);
    expect(result._unsafeUnwrap()).toBe('ignored');
    expect(s.handle).toHaveBeenCalledWith(event);
    expect(s.messageRepo.insert).not.toHaveBeenCalled();
    expect(s.queueManager.enqueue).not.toHaveBeenCalled();
  });

  it('offers a long message and one without a leading slash', async () => {
    s.matches.mockReturnValue(false);
    const long = makeEvent({ content: 'quote ' + 'a'.repeat(5000) });
    const plain = makeEvent({ content: 'hello /approve X' });
    await s.pipeline.handleInboundEvent(long);
    await s.pipeline.handleInboundEvent(plain);
    expect(s.matches).toHaveBeenCalledWith(long);
    expect(s.matches).toHaveBeenCalledWith(plain);
  });

  it('consumes silently when the handler returns an object with no reply', async () => {
    s.handle.mockResolvedValue({});
    const result = await s.pipeline.handleInboundEvent(makeEvent());
    expect(result._unsafeUnwrap()).toBe('ignored');
    expect(s.sendReply).not.toHaveBeenCalled();
    expect(s.threadRepo.findByExternalId).not.toHaveBeenCalled();
    expect(s.messageRepo.insert).not.toHaveBeenCalled();
    expect(s.queueManager.enqueue).not.toHaveBeenCalled();
  });

  it('still stops the pipeline when the send fails or throws', async () => {
    s.handle.mockResolvedValue({ reply: 'Approved.' });
    s.sendReply.mockResolvedValueOnce(err('no connector'));
    expect((await s.pipeline.handleInboundEvent(makeEvent()))._unsafeUnwrap()).toBe('ignored');
    s.sendReply.mockRejectedValueOnce(new Error('x'));
    expect((await s.pipeline.handleInboundEvent(makeEvent()))._unsafeUnwrap()).toBe('ignored');
    expect(s.warn).toHaveBeenCalledTimes(2);
    expect(s.queueManager.enqueue).not.toHaveBeenCalled();
  });
});

describe('MessagePipeline without a command handler', () => {
  function bare() {
    const threadRepo = {
      findByExternalId: vi.fn(() => ok({ id: 'thread-1' })),
      insert: vi.fn(() => ok({})),
    };
    const queueManager = { enqueue: vi.fn(() => ok({ id: 'q1' })) };
    const pipeline = new MessagePipeline(
      { insert: vi.fn(() => ok({})), existsByIdempotencyKey: vi.fn(() => false) } as never,
      threadRepo as never,
      { findByName: vi.fn(() => ok({ id: 'chan-1' })) } as never,
      queueManager as never,
      { resolvePersona: vi.fn(() => ok('persona-1')) } as never,
      { logChannelSend: vi.fn() } as never,
      pino({ level: 'silent' }),
    );
    return { pipeline, threadRepo, queueManager };
  }

  it('enqueues /approve text as a normal message', async () => {
    const b = bare();
    const result = await b.pipeline.handleInboundEvent(makeEvent({ content: '/approve ABCDEFGH' }));
    expect(result._unsafeUnwrap()).toBe('enqueued');
    expect(b.queueManager.enqueue).toHaveBeenCalled();
  });

  it('reaches the thread lookup synchronously, before the promise is awaited', () => {
    const b = bare();
    const p = b.pipeline.handleInboundEvent(makeEvent({ content: 'plain text' }));
    expect(b.threadRepo.findByExternalId).toHaveBeenCalled();
    return p;
  });
});
