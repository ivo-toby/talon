import { describe, it, expect } from 'vitest';
import { NO_REPLY_SENTINEL, isNoReplyOutput } from '../../../src/channels/no-reply.js';

describe('isNoReplyOutput', () => {
  it('matches the bare sentinel', () => {
    expect(isNoReplyOutput(NO_REPLY_SENTINEL)).toBe(true);
  });

  it.each([
    '  NO_REPLY  ',
    'NO_REPLY\n',
    '`NO_REPLY`',
    '**NO_REPLY**',
    '"NO_REPLY"',
    '[NO_REPLY]',
    'NO_REPLY.',
    'no_reply',
  ])('tolerates decoration around the sentinel: %j', (text) => {
    expect(isNoReplyOutput(text)).toBe(true);
  });

  it.each([
    '',
    'NO REPLY',
    'NO_REPLY needed here, but thanks!',
    'Sure — NO_REPLY',
    'NO_REPLY\nActually, one more thing.',
    'NO_REPLY_EXTRA',
  ])('does not match real text: %j', (text) => {
    expect(isNoReplyOutput(text)).toBe(false);
  });
});
