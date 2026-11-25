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
  const sendReply = vi.fn(async (_c: string, _t: string, _b: string) =>
    ok<unknown, unknown>(undefined),
  );
  pipeline.setInboundCommandHandler({ handle }, sendReply);
  return { pipeline, handle, sendReply, messageRepo, threadRepo, queueManager, warn, error };
}

describe('MessagePipeline inbound command hook', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('sends the reply and persists and enqueues nothing for a handled command', async () => {
    s.handle.mockResolvedValue('Approved.');
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

  it('never offers an event with an attachment', async () => {
    const event = makeEvent({
      attachments: [{ kind: 'image', mimeType: 'image/png' }],
    } as never);
    await s.pipeline.handleInboundEvent(event);
    expect(s.handle).not.toHaveBeenCalled();
  });

  it('does not offer a long message or one without a leading slash', async () => {
    await s.pipeline.handleInboundEvent(makeEvent({ content: '/' + 'a'.repeat(64) }));
    await s.pipeline.handleInboundEvent(makeEvent({ content: 'hello /approve X' }));
    expect(s.handle).not.toHaveBeenCalled();
  });

  it('still stops the pipeline when the send fails or throws', async () => {
    s.handle.mockResolvedValue('Approved.');
    s.sendReply.mockResolvedValueOnce(err('no connector'));
    expect((await s.pipeline.handleInboundEvent(makeEvent()))._unsafeUnwrap()).toBe('ignored');
    s.sendReply.mockRejectedValueOnce(new Error('x'));
    expect((await s.pipeline.handleInboundEvent(makeEvent()))._unsafeUnwrap()).toBe('ignored');
    expect(s.warn).toHaveBeenCalledTimes(2);
    expect(s.queueManager.enqueue).not.toHaveBeenCalled();
  });
});
