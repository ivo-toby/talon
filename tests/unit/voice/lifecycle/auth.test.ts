import { describe, expect, it } from 'vitest';

import { IndexedVoiceAuth } from '../../../../src/voice/voice-session-service.js';

describe('indexed voice lifecycle auth', () => {
  it('keeps independent logins valid until each exact session is revoked', () => {
    const auth = new IndexedVoiceAuth({ accessToken: 'voice-token', ownerId: 'owner-1' });
    const first = auth.login('voice-token')._unsafeUnwrap().session;
    const second = auth.login('voice-token')._unsafeUnwrap().session;

    expect(auth.resolve(first.owner)).toBe(first);
    expect(auth.resolve(second.owner)).toBe(second);

    auth.revoke(first);
    expect(auth.resolve(first.owner)).toBeUndefined();
    expect(auth.resolve(second.owner)).toBe(second);

    auth.invalidateRuntime();
    expect(auth.resolve(second.owner)).toBeUndefined();
  });
});
