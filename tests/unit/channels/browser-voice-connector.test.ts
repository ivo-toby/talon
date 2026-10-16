import { describe, expect, it } from 'vitest';
import { err, ok } from '../../../src/core/types/result.js';
import { ChannelError } from '../../../src/core/errors/error-types.js';
import { BrowserVoiceConnector } from '../../../src/channels/connectors/browser-voice.js';
import {
  createSharedVoiceThreadMetadata,
  createVoiceThreadExternalId,
} from '../../../src/voice/voice-types.js';

function voiceThread(sessionId = 'session-1') {
  return {
    id: sessionId,
    channel_id: 'voice-channel',
    external_id: `voice:${sessionId}`,
    metadata: JSON.stringify({ kind: 'voice', sessionId }),
    created_at: 1,
    updated_at: 1,
  };
}

describe('BrowserVoiceConnector', () => {
  it('resolves the durable voice thread before notifying the active session', async () => {
    const notifications: Array<{ threadId: string; text: string }> = [];
    const connector = new BrowserVoiceConnector({
      channelId: 'voice-channel',
      threadRepository: {
        findByExternalId: (channelId, externalId) => {
          expect(channelId).toBe('voice-channel');
          expect(externalId).toBe('voice:session-1');
          return ok(voiceThread());
        },
      },
      sessionService: {
        notifyThread: async (input) => {
          notifications.push(input);
          return ok({ sessionId: 'session-1', notificationId: 'message-1', speechRequested: true });
        },
      },
    });

    const sent = await connector.send('voice:session-1', { body: 'A background result is ready.' });

    expect(sent.isOk()).toBe(true);
    expect(notifications).toEqual([
      { threadId: 'session-1', text: 'A background result is ready.' },
    ]);
  });

  it('forwards the normal outbound message identity to the voice service', async () => {
    const output = { body: 'A stable background result.', messageId: 'message-42' };
    const notifications: Array<{ threadId: string; text: string; messageId?: string }> = [];
    const connector = new BrowserVoiceConnector({
      channelId: 'voice-channel',
      threadRepository: { findByExternalId: () => ok(voiceThread()) },
      sessionService: {
        notifyThread: async (input) => {
          notifications.push(input);
          return ok({ sessionId: 'session-1', notificationId: 'message-42', speechRequested: true });
        },
      },
    });

    const sent = await connector.send('voice:session-1', output);

    expect(sent.isOk()).toBe(true);
    expect(notifications).toEqual([
      { threadId: 'session-1', text: 'A stable background result.', messageId: 'message-42' },
    ]);
    expect(output.messageId).toBe('message-42');
  });

  it('accepts the shared owner and persona voice thread metadata', async () => {
    const externalId = createVoiceThreadExternalId('owner-1', 'persona-1');
    const stableThread = {
      ...voiceThread('durable-thread'),
      id: 'durable-thread',
      external_id: externalId,
      metadata: JSON.stringify(createSharedVoiceThreadMetadata('owner-1', 'persona-1')),
    };
    const notified: string[] = [];
    const connector = new BrowserVoiceConnector({
      channelId: 'voice-channel',
      threadRepository: { findByExternalId: () => ok(stableThread) },
      sessionService: {
        notifyThread: async (input) => {
          notified.push(input.threadId);
          return ok({
            sessionId: 'session-1',
            notificationId: 'message-1',
            speechRequested: false,
          });
        },
      },
    });

    const sent = await connector.send(externalId, { body: 'Retain this for the next call.' });

    expect(sent.isOk()).toBe(true);
    expect(notified).toEqual(['durable-thread']);
  });

  it('rejects stable external IDs with mismatched ownership metadata', async () => {
    const externalId = createVoiceThreadExternalId('owner-1', 'persona-1');
    const connector = new BrowserVoiceConnector({
      channelId: 'voice-channel',
      threadRepository: {
        findByExternalId: () =>
          ok({
            ...voiceThread('durable-thread'),
            id: 'durable-thread',
            external_id: externalId,
            metadata: JSON.stringify(createSharedVoiceThreadMetadata('owner-2', 'persona-1')),
          }),
      },
      sessionService: {
        notifyThread: async () =>
          ok({ sessionId: 'session-1', notificationId: 'message-1', speechRequested: false }),
      },
    });

    const sent = await connector.send(externalId, { body: 'Do not forward this.' });

    expect(sent.isErr()).toBe(true);
    expect(sent._unsafeUnwrapErr().message).toContain('authorized voice thread');
  });

  it('rejects arbitrary recipients and unsupported payloads', async () => {
    const connector = new BrowserVoiceConnector({
      channelId: 'voice-channel',
      threadRepository: {
        findByExternalId: (_channelId, externalId) =>
          externalId === 'voice:session-1'
            ? ok(voiceThread())
            : ok(null),
      },
      sessionService: {
        notifyThread: async () => ok({ sessionId: 'session-1', notificationId: 'message-1', speechRequested: false }),
      },
    });

    const wrongRecipient = await connector.send('voice:other-session', { body: 'Do not forward this.' });
    const attachment = await connector.send('voice:session-1', {
      body: 'Unsupported attachment',
      attachments: [{ filename: 'x.txt', mimeType: 'text/plain', data: 'x', size: 1 }],
    });

    expect(wrongRecipient.isErr()).toBe(true);
    expect(wrongRecipient._unsafeUnwrapErr()).toBeInstanceOf(ChannelError);
    expect(attachment.isErr()).toBe(true);
    expect(attachment._unsafeUnwrapErr().message).toContain('file attachments');
  });

  it('reports service failures as channel errors without changing the target', async () => {
    const connector = new BrowserVoiceConnector({
      channelId: 'voice-channel',
      threadRepository: { findByExternalId: () => ok(voiceThread()) },
      sessionService: {
        notifyThread: async () => err(new ChannelError('session is closed')),
      },
    });

    const sent = await connector.send('voice:session-1', { body: 'Retain this after hangup.' });

    expect(sent.isErr()).toBe(true);
    expect(sent._unsafeUnwrapErr().message).toContain('session is closed');
  });
});
