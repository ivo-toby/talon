import { describe, expect, it } from 'vitest';

import { lookupSkillContent } from '../../../src/tools/skill-loader-mcp-server.js';

describe('lookupSkillContent', () => {
  it('returns the content for an existing skill', () => {
    const skills = new Map<string, string>([
      ['brainstorming', 'Line 1\nLine 2'],
      ['debugging', 'Trace first'],
    ]);

    expect(lookupSkillContent(skills, 'brainstorming')).toBe('Line 1\nLine 2');
  });

  it('returns null when the skill does not exist', () => {
    const skills = new Map<string, string>([['brainstorming', 'Line 1\nLine 2']]);

    expect(lookupSkillContent(skills, 'missing')).toBeNull();
  });

  it('returns empty string for skill with no prompt content', () => {
    const skills = new Map<string, string>([['empty', '']]);

    expect(lookupSkillContent(skills, 'empty')).toBe('');
  });
});
