/**
 * Zod schema for YAML frontmatter in persona `system.md` files.
 *
 * Follows the same pattern as `SkillMdFrontmatterSchema` in
 * `src/skills/skill-schema.ts`. The frontmatter is parsed by
 * `PersonaLoader.readSystemPrompt()` using `gray-matter` and
 * stripped from the prompt content before it reaches the agent.
 */

import { z } from 'zod';

export const PersonaFrontmatterSchema = z.object({
  /** One-line summary of what this persona does, shown in profile listings. */
  description: z.string().min(1).optional(),
});

export type PersonaFrontmatter = z.infer<typeof PersonaFrontmatterSchema>;
