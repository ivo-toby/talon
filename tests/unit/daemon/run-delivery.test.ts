import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';
import { RunDelivery, implicitReplyTarget } from '../../../src/daemon/run-delivery.js';
import { ChannelError } from '../../../src/core/errors/error-types.js';
import type { ChannelConnector } from '../../../src/channels/channel-types.js';
import type {
  MessageRefRepository,
  MessageRefRow,
} from '../../../src/core/database/repositories/message-ref-repository.js';

function triggerRef(overrides: Partial<MessageRefRow> = {}): MessageRefRow {
  return {
    thread_id: 'thread-1',
    external_id: '900',
    direction: 'inbound',
    message_id: 'msg-in',
    sender_id: 'alice',
    excerpt: 'what time is it?',
    created_at: 1,
    ...overrides,
  };
}

describe('implicitReplyTarget', () => {
  it('maps an inbound ledger ref to an implicit reply target', () => {
    expect(implicitReplyTarget(triggerRef())).toEqual({
      externalMessageId: '900',
      implicit: true,
      fromSelf: false,
      author: 'alice',
      text: 'what time is it?',
    });
  });

  it('omits author and text the ledger does not have', () => {
    expect(implicitReplyTarget(triggerRef({ sender_id: null, excerpt: '' }))).toEqual({
      externalMessageId: '900',
      implicit: true,
      fromSelf: false,
    });
  });
});

describe('RunDelivery', () => {
  let send: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;

  function makeDelivery(
    overrides: Partial<ConstructorParameters<typeof RunDelivery>[0]> = {},
  ): RunDelivery {
    return new RunDelivery({
      connector: { send } as unknown as ChannelConnector,
      externalThreadId: 'chat-1',
      threadId: 'thread-1',
      outboundMessageId: 'msg-out',
      messageRefs: { record } as unknown as MessageRefRepository,
      trigger: null,
      recordRefs: true,
      logger: pino({ level: 'silent' }),
      ...overrides,
    });
  }

  beforeEach(() => {
    send = vi.fn().mockResolvedValue(ok({ externalMessageId: '901' }));
    record = vi.fn().mockReturnValue(ok(undefined));
  });

  it('sends a plain body when the run has no trigger message', async () => {
    const result = await makeDelivery().sendText('Hello');
    expect(result.isOk()).toBe(true);
    expect(send).toHaveBeenCalledWith('chat-1', { body: 'Hello' });
  });

  it('attaches the trigger as an implicit reply target on the first block only', async () => {
    const delivery = makeDelivery({ trigger: triggerRef() });

    await delivery.sendText('Let me check.');
    await delivery.sendText('It is 14:00.');

    expect(send).toHaveBeenNthCalledWith(1, 'chat-1', {
      body: 'Let me check.',
      replyTo: {
        externalMessageId: '900',
        implicit: true,
        fromSelf: false,
        author: 'alice',
        text: 'what time is it?',
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, 'chat-1', { body: 'It is 14:00.' });
  });

  it('keeps the reply target for the next block when the first send fails', async () => {
    const delivery = makeDelivery({ trigger: triggerRef() });
    send.mockResolvedValueOnce(err(new ChannelError('boom')));

    const failed = await delivery.sendText('first');
    expect(failed.isErr()).toBe(true);

    await delivery.sendText('second');
    expect(send.mock.calls[1][1]).toHaveProperty('replyTo.externalMessageId', '900');
  });

  it("records the sent message in the ledger under the run's outbound message", async () => {
    await makeDelivery().sendText('The answer');
    expect(record).toHaveBeenCalledWith({
      thread_id: 'thread-1',
      external_id: '901',
      direction: 'outbound',
      message_id: 'msg-out',
      text: 'The answer',
    });
  });

  it('records each flushed block separately', async () => {
    const delivery = makeDelivery();
    send
      .mockResolvedValueOnce(ok({ externalMessageId: '901' }))
      .mockResolvedValueOnce(ok({ externalMessageId: '902' }));
    await delivery.sendText('one');
    await delivery.sendText('two');
    expect(
      record.mock.calls.map((call) => (call[0] as { external_id: string }).external_id),
    ).toEqual(['901', '902']);
  });

  it('records nothing when the connector returns no receipt', async () => {
    send.mockResolvedValue(ok(undefined));
    const result = await makeDelivery().sendText('Hello');
    expect(result.isOk()).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing when recordRefs is false (schedule thread answering its origin chat)', async () => {
    await makeDelivery({ recordRefs: false }).sendText('Hello');
    expect(send).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('works without a ledger', async () => {
    const delivery = makeDelivery({ messageRefs: undefined });
    expect((await delivery.sendText('Hello')).isOk()).toBe(true);
  });

  it('does not fail the send when recording the ref fails', async () => {
    record.mockReturnValue(err(new Error('disk full')));
    expect((await makeDelivery().sendText('Hello')).isOk()).toBe(true);
  });

  it('returns the connector error and records nothing on a failed send', async () => {
    send.mockResolvedValue(err(new ChannelError('chat not found')));
    const result = await makeDelivery().sendText('Hello');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe('chat not found');
    expect(record).not.toHaveBeenCalled();
  });

  describe('no-reply directive', () => {
    it.each(['NO_REPLY', '  NO_REPLY\n', '`NO_REPLY`'])('does not send %j', async (text) => {
      const result = await makeDelivery({ trigger: triggerRef() }).sendText(text);
      expect(result.isOk()).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('sends text that merely mentions the sentinel', async () => {
      await makeDelivery().sendText('I will answer with NO_REPLY next time.');
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('leaves the implicit reply target available after a suppressed block', async () => {
      const delivery = makeDelivery({ trigger: triggerRef() });
      await delivery.sendText('NO_REPLY');
      await delivery.sendText('Actually, here is the answer.');
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toHaveProperty('replyTo.externalMessageId', '900');
    });
  });
});
