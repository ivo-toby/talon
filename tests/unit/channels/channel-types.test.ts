import { describe, it, expect } from 'vitest';
import {
  resolveReplyToTriggerMode,
  shouldSendAsReply,
} from '../../../src/channels/channel-types.js';

describe('resolveReplyToTriggerMode', () => {
  it('passes the three valid modes through', () => {
    expect(resolveReplyToTriggerMode('never')).toBe('never');
    expect(resolveReplyToTriggerMode('groups')).toBe('groups');
    expect(resolveReplyToTriggerMode('always')).toBe('always');
  });

  it.each([undefined, null, '', 'sometimes', true, 1])('defaults %j to groups', (value) => {
    expect(resolveReplyToTriggerMode(value)).toBe('groups');
  });
});

describe('shouldSendAsReply', () => {
  const implicit = { externalMessageId: '10', implicit: true };
  const explicit = { externalMessageId: '10' };

  it('is false without a target or with an empty id', () => {
    expect(shouldSendAsReply(undefined, 'always', true)).toBe(false);
    expect(shouldSendAsReply({ externalMessageId: '' }, 'always', true)).toBe(false);
  });

  it('always replies to an explicit target, whatever the mode', () => {
    expect(shouldSendAsReply(explicit, 'never', false)).toBe(true);
    expect(shouldSendAsReply(explicit, 'groups', false)).toBe(true);
    expect(shouldSendAsReply({ ...explicit, implicit: false }, 'never', true)).toBe(true);
  });

  it('applies the mode to an implicit target', () => {
    expect(shouldSendAsReply(implicit, 'never', true)).toBe(false);
    expect(shouldSendAsReply(implicit, 'never', false)).toBe(false);
    expect(shouldSendAsReply(implicit, 'groups', true)).toBe(true);
    expect(shouldSendAsReply(implicit, 'groups', false)).toBe(false);
    expect(shouldSendAsReply(implicit, 'always', true)).toBe(true);
    expect(shouldSendAsReply(implicit, 'always', false)).toBe(true);
  });
});
