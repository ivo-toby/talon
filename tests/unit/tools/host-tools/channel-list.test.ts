/**
 * Unit tests for ChannelListHandler.
 *
 * Tests cover:
 *   - Bound channels + thread external_ids returned for the persona
 *   - Null-thread bindings surface as channel-only entries
 *   - Empty bindings returns an empty list
 *   - Binding repository failure surfaces as a tool error
 */

import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { ChannelListHandler } from '../../../../src/tools/host-tools/channel-list.js';

function makeBindingRepo(rows: any[]) {
  return {
    findByPersona: vi.fn().mockReturnValue(ok(rows)),
  } as any;
}

function makeChannelRepo() {
  return {
    findById: vi.fn().mockReturnValue(
      ok({
        id: 'chan-001',
        type: 'telegram',
        name: 'telegram-main',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
        created_at: 0,
        updated_at: 0,
      }),
    ),
  } as any;
}

function makeThreadRepo() {
  return {
    findById: vi.fn().mockReturnValue(
      ok({
        id: 'thread-abc',
        channel_id: 'chan-001',
        external_id: 'chat-42',
        metadata: '{}',
        created_at: 0,
        updated_at: 0,
      }),
    ),
  } as any;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

describe('ChannelListHandler', () => {
  it('returns bound channels and thread external_ids for the persona', async () => {
    const handler = new ChannelListHandler({
      bindingRepository: makeBindingRepo([
        { id: 'b1', channel_id: 'chan-001', thread_id: 'thread-abc', persona_id: 'persona-1', is_default: 0, created_at: 0, updated_at: 0 },
      ]),
      channelRepository: makeChannelRepo(),
      threadRepository: makeThreadRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {},
      { runId: 'r1', threadId: 't1', personaId: 'persona-1', requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual([
      {
        channelName: 'telegram-main',
        channelType: 'telegram',
        threadId: 'thread-abc',
        externalChatId: 'chat-42',
      },
    ]);
  });

  it('includes bound channels with null thread_id as channel-only entries', async () => {
    const handler = new ChannelListHandler({
      bindingRepository: makeBindingRepo([
        { id: 'b1', channel_id: 'chan-001', thread_id: null, persona_id: 'persona-1', is_default: 1, created_at: 0, updated_at: 0 },
      ]),
      channelRepository: makeChannelRepo(),
      threadRepository: makeThreadRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {},
      { runId: 'r1', threadId: 't1', personaId: 'persona-1', requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual([
      {
        channelName: 'telegram-main',
        channelType: 'telegram',
        threadId: null,
        externalChatId: null,
      },
    ]);
  });

  it('returns an empty list when the persona has no bindings', async () => {
    const handler = new ChannelListHandler({
      bindingRepository: makeBindingRepo([]),
      channelRepository: makeChannelRepo(),
      threadRepository: makeThreadRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {},
      { runId: 'r1', threadId: 't1', personaId: 'persona-1', requestId: 'req-1' },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual([]);
  });

  it('errors when the binding repository fails', async () => {
    const bindingRepo = {
      findByPersona: vi.fn().mockReturnValue(err(new Error('db offline'))),
    } as any;
    const handler = new ChannelListHandler({
      bindingRepository: bindingRepo,
      channelRepository: makeChannelRepo(),
      threadRepository: makeThreadRepo(),
      logger: makeLogger(),
    });

    const result = await handler.execute(
      {},
      { runId: 'r1', threadId: 't1', personaId: 'persona-1', requestId: 'req-1' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/db offline/);
  });
});