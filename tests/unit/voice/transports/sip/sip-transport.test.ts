import { describe, expect, it } from 'vitest';
import { SipTransport } from '../../../../../src/voice/transports/sip/sip-transport.js';

describe('SipTransport', () => {
  it('opens only a verified provider-owned SIP descriptor and carries no browser media', async () => {
    const transport = new SipTransport({ now: () => 1_000 });
    const events: string[] = [];
    const sessionId = 'voice-sip-session';
    transport.onEvent(sessionId, (event) => {
      if (event.kind === 'status') events.push(event.status);
    });

    const opened = await transport.open({
      sessionId,
      ownerId: 'operator-1',
      client: {
        transport: 'sip',
        sessionId,
        answer: { type: 'sip', reference: 'provider-sip-session' },
        expiresAt: 10_000,
      },
    });

    expect(opened.isOk()).toBe(true);
    expect(opened._unsafeUnwrap()).toMatchObject({
      sessionId,
      kind: 'sip',
      transportSessionId: 'sip:provider-sip-session',
      status: 'connected',
    });
    expect(events).toEqual(['connecting', 'connected']);
    expect(transport.capabilities?.playback_evidence).toBeUndefined();

    await transport.close(sessionId, 'hangup');
    expect(transport.status(sessionId)._unsafeUnwrap()).toBe('closed');
    expect(events).toEqual(['connecting', 'connected', 'closing', 'closed']);
  });

  it('rejects a browser-style or unverified descriptor', async () => {
    const transport = new SipTransport();
    const result = await transport.open({
      sessionId: 'voice-sip-invalid',
      ownerId: 'operator-1',
      client: {
        transport: 'webrtc',
        sessionId: 'voice-sip-invalid',
        answer: { type: 'webrtc', sdp: 'answer' },
        expiresAt: Date.now() + 1_000,
      },
    });
    expect(result.isErr()).toBe(true);
  });
});
