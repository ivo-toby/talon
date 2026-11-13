/**
 * Operator skills live in two trees: `.claude/skills/` and `.agents/skills/`.
 * Most pairs differ on purpose, because they name a different harness.
 * A skill that names no harness must stay byte-identical in both trees.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Skills with no harness-specific text. Add a skill here when both copies must match. */
const HARNESS_NEUTRAL_SKILLS = ['optimize-personas'];

const repoRoot = join(import.meta.dirname, '..', '..', '..');

describe('harness-neutral operator skills', () => {
  it.each(HARNESS_NEUTRAL_SKILLS)(
    '%s is identical in .claude/skills and .agents/skills',
    async (skill) => {
      const [claudeCopy, agentsCopy] = await Promise.all(
        ['.claude', '.agents'].map((tree) =>
          readFile(join(repoRoot, tree, 'skills', skill, 'SKILL.md'), 'utf-8'),
        ),
      );

      expect(agentsCopy).toBe(claudeCopy);
    },
  );
});
