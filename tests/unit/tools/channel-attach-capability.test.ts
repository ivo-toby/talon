/**
 * Unit tests for the channel.attach modifier capability: it is a known
 * capability, exposes no tool by itself, and extends the channel_send
 * instructions only for personas that hold it.
 */

import { describe, it, expect } from 'vitest';
import {
  KNOWN_CAPABILITY_PREFIXES,
  filterAllowedMcpTools,
  hasCapabilityPrefix,
} from '../../../src/tools/tool-filter.js';
import { resolveToolInstructions } from '../../../src/tools/tool-instructions.js';

describe('channel.attach capability', () => {
  it('is known but exposes no tool on its own', () => {
    expect(KNOWN_CAPABILITY_PREFIXES.has('channel.attach')).toBe(true);
    expect(filterAllowedMcpTools({ allow: ['channel.attach'], requireApproval: [] })).toEqual([]);
  });

  it('is detected scoped or unscoped, in allow or requireApproval', () => {
    expect(
      hasCapabilityPrefix({ allow: ['channel.attach'], requireApproval: [] }, 'channel.attach'),
    ).toBe(true);
    expect(
      hasCapabilityPrefix({ allow: [], requireApproval: ['channel.attach:*'] }, 'channel.attach'),
    ).toBe(true);
    expect(
      hasCapabilityPrefix({ allow: ['channel.send:*'], requireApproval: [] }, 'channel.attach'),
    ).toBe(false);
  });

  it('appends its instructions to channel_send only when granted', () => {
    const cache = new Map([
      ['channel.send', '## Messaging'],
      ['channel.attach', '### Sending files'],
    ]);
    const granted = { allow: ['channel.send:*', 'channel.attach'], requireApproval: [] };
    const notGranted = { allow: ['channel.send:*'], requireApproval: [] };
    expect(resolveToolInstructions(cache, ['channel_send'], undefined, granted)).toBe(
      '## Messaging\n\n### Sending files',
    );
    expect(resolveToolInstructions(cache, ['channel_send'], undefined, notGranted)).toBe(
      '## Messaging',
    );
    expect(resolveToolInstructions(cache, [], undefined, granted)).toBe('');
  });
});
