import { describe, expect, it } from 'vitest';
import { ok } from 'neverthrow';
import {
  buildPersonaRosterAppendix,
  renderPersonaRoster,
  ROSTER_NO_DESCRIPTION,
} from '../../../src/personas/persona-roster.js';
import { getPersonaDescription } from '../../../src/personas/persona-description.js';

describe('getPersonaDescription', () => {
  it('prefers frontmatter description', () => {
    expect(getPersonaDescription({ description: ' D ', systemPromptContent: '# X' })).toBe('D');
  });
  it('skips frontmatter in fallback and strips #', () => {
    expect(getPersonaDescription({ systemPromptContent: '---\na: b\n---\n# Title\n' })).toBe('Title');
  });
  it('returns null when nothing is available', () => {
    expect(getPersonaDescription({})).toBeNull();
    expect(getPersonaDescription(undefined)).toBeNull();
    expect(getPersonaDescription({ systemPromptContent: '  \n\n' })).toBeNull();
  });
});

describe('renderPersonaRoster', () => {
  it('excludes self and sorts by name', () => {
    const out = renderPersonaRoster(
      [
        { name: 'zed', description: 'Z' },
        { name: 'me', description: 'M' },
        { name: 'alpha', description: 'A' },
      ],
      'me',
    );
    expect(out).toBe('Available personas:\n- alpha: A\n- zed: Z');
  });

  it('collapses to one line and truncates to 200 chars', () => {
    const out = renderPersonaRoster([{ name: 'a', description: `x\n${'y'.repeat(300)}` }], 'me');
    const line = out.split('\n')[1]!;
    expect(line.includes('\n')).toBe(false);
    expect(line.startsWith('- a: x yyy')).toBe(true);
    expect(line.length).toBe('- a: '.length + 200);
    expect(line.endsWith('…')).toBe(true);
  });

  it('caps at 30 personas with an overflow line', () => {
    const personas = Array.from({ length: 35 }, (_, i) => ({
      name: `p${String(i).padStart(2, '0')}`,
      description: 'd',
    }));
    const lines = renderPersonaRoster(personas, 'none').split('\n');
    expect(lines).toHaveLength(1 + 30 + 1);
    expect(lines.at(-1)).toBe('- … and 5 more (use persona_list)');
  });

  it('says so when there are no other personas', () => {
    expect(renderPersonaRoster([{ name: 'me' }], 'me')).toContain('none');
    expect(renderPersonaRoster([], 'me').split('\n')).toHaveLength(1);
  });

  it('shows a hint for personas without description', () => {
    expect(renderPersonaRoster([{ name: 'a' }, { name: 'b', description: '  ' }], 'me')).toBe(
      `Available personas:\n- a: ${ROSTER_NO_DESCRIPTION}\n- b: ${ROSTER_NO_DESCRIPTION}`,
    );
  });
});

const ALL = { allow: ['persona.send:*'], requireApproval: [] };

describe('buildPersonaRosterAppendix', () => {
  const loader = {
    listNames: () => ['me', 'b'],
    getByName: (n: string) => ok(n === 'b' ? { description: 'Bee' } : undefined),
  } as never;

  it('returns undefined when persona_send is not allowed', () => {
    expect(buildPersonaRosterAppendix(loader, ['persona_list'], 'me', ALL)).toBeUndefined();
  });

  it('keys the roster by the persona.send prefix', () => {
    expect(buildPersonaRosterAppendix(loader, ['persona_send'], 'me', ALL)).toEqual({
      'persona.send': 'Available personas:\n- b: Bee',
    });
  });

  describe('scoped delegation targets', () => {
    const wide = {
      listNames: () => ['me', 'b', 'c', 'd'],
      getByName: (n: string) => ok({ description: `desc ${n}` }),
    } as never;

    it('lists only personas named by scoped labels', () => {
      expect(
        buildPersonaRosterAppendix(wide, ['persona_send'], 'me', {
          allow: ['persona.send:b', 'persona.send:d'],
          requireApproval: [],
        }),
      ).toEqual({ 'persona.send': 'Available personas:\n- b: desc b\n- d: desc d' });
    });

    it('reports none when no scoped name is loaded', () => {
      const out = buildPersonaRosterAppendix(wide, ['persona_send'], 'me', {
        allow: ['persona.send:ghost'],
        requireApproval: [],
      });
      expect(out?.['persona.send']).toMatch(/^Available personas: none/);
    });

    it('lists all other personas for persona.send:* and unscoped persona.send', () => {
      for (const label of ['persona.send:*', 'persona.send']) {
        const out = buildPersonaRosterAppendix(wide, ['persona_send'], 'me', {
          allow: [label],
          requireApproval: [],
        });
        expect(out?.['persona.send']).toBe('Available personas:\n- b: desc b\n- c: desc c\n- d: desc d');
      }
    });
  });
});
