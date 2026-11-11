/**
 * Delegation description for a persona: what other personas (and the model)
 * see when choosing a `persona_send` target.
 */

import type { LoadedPersona } from './persona-types.js';

/** Removes a leading YAML frontmatter block (`---` ... `---`), if present. */
function stripFrontmatter(content: string): string {
  const normalized = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  return match ? normalized.slice(match[0].length) : normalized;
}

/**
 * Returns the persona's delegation description, or `null` when none exists.
 *
 * Order: the `description:` frontmatter value (`LoadedPersona.description`),
 * then the first non-empty content line of the in-memory system prompt
 * (frontmatter skipped, leading `#`s stripped). Never touches the filesystem.
 */
export function getPersonaDescription(
  persona: Pick<LoadedPersona, 'description' | 'systemPromptContent'> | null | undefined,
): string | null {
  if (!persona) return null;
  const explicit = persona.description?.trim();
  if (explicit) return explicit;
  if (!persona.systemPromptContent) return null;
  for (const line of stripFrontmatter(persona.systemPromptContent).split(/\r?\n/)) {
    const trimmed = line.replace(/^\s*#+\s*/, '').trim();
    if (trimmed) return trimmed;
  }
  return null;
}
