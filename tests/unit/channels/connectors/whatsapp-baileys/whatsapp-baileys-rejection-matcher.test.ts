/**
 * Unit tests for the Baileys rejection matcher.
 *
 * The matcher decides whether an `unhandledRejection` reason looks like an
 * internal failure of the @whiskeysockets/baileys library (the kind that
 * leaks during forced reconnects) so the daemon's signal handler can keep
 * the process alive instead of exiting.
 */

import { describe, it, expect } from 'vitest';
import { isBaileysInternalRejection } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-rejection-matcher.js';

describe('isBaileysInternalRejection', () => {
  it('matches an Error whose stack references @whiskeysockets/baileys', () => {
    const e = new Error('boom');
    e.stack =
      'Error: boom\n    at Object.decodeFrame (file:///app/node_modules/@whiskeysockets/baileys/lib/Utils/noise-handler.js:141:17)';
    expect(isBaileysInternalRejection(e)).toBe(true);
  });

  it('matches a Boom-shaped error with the Baileys Stream Errored prefix', () => {
    const boomLike = {
      isBoom: true,
      message: 'Stream Errored (conflict)',
      output: { statusCode: 440, payload: { statusCode: 440 } },
    };
    expect(isBaileysInternalRejection(boomLike)).toBe(true);
  });

  it('does NOT match a plain Error with "Stream Errored" message but no Baileys provenance', () => {
    // Without the Boom shape OR a Baileys stack frame, "Stream Errored" is
    // ambiguous and could come from any other module — refuse to swallow it.
    const e = new Error('Stream Errored (conflict)');
    expect(isBaileysInternalRejection(e)).toBe(false);
  });

  it('does NOT match a stack that mentions noise-handler without the Baileys package path', () => {
    // `noise-handler` alone is too generic; some other module could use the
    // same name. Require the @whiskeysockets/baileys package fragment.
    const e = new Error('decode failed');
    e.stack = 'Error: decode failed\n    at Object.decodeFrame (noise-handler.js:141:17)';
    expect(isBaileysInternalRejection(e)).toBe(false);
  });

  it('does not match an unrelated Error', () => {
    expect(isBaileysInternalRejection(new Error('database connection lost'))).toBe(false);
  });

  it('does not match a Boom-shaped object whose message is unrelated', () => {
    const boomLike = {
      isBoom: true,
      message: 'Bad Request',
      output: { statusCode: 400 },
    };
    expect(isBaileysInternalRejection(boomLike)).toBe(false);
  });

  it('does not match plain non-Error rejection reasons', () => {
    expect(isBaileysInternalRejection(undefined)).toBe(false);
    expect(isBaileysInternalRejection(null)).toBe(false);
    expect(isBaileysInternalRejection('something')).toBe(false);
    expect(isBaileysInternalRejection({})).toBe(false);
    expect(isBaileysInternalRejection(42)).toBe(false);
  });

  it('does not throw on rejections with weird property shapes', () => {
    const weird = Object.create(null) as Record<string, unknown>;
    weird['stack'] = 12345;
    weird['message'] = { nested: true };
    expect(() => isBaileysInternalRejection(weird)).not.toThrow();
    expect(isBaileysInternalRejection(weird)).toBe(false);
  });
});
