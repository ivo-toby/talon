/**
 * Persona roster rendering for the persona-delegation system prompt block.
 */

import type { PersonaLoader } from './persona-loader.js';
import { getPersonaDescription } from './persona-description.js';

export const ROSTER_MAX_PERSONAS = 30;
export const ROSTER_MAX_DESCRIPTION_CHARS = 200;
export const ROSTER_NO_DESCRIPTION =
  '(no description — add "description:" to its system.md frontmatter)';

export interface RosterPersona {
  name: string;
  description?: string | null;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > ROSTER_MAX_DESCRIPTION_CHARS
    ? `${collapsed.slice(0, ROSTER_MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`
    : collapsed;
}

/**
 * Renders the "Available personas:" roster, excluding `selfName`, sorted by
 * name, bounded to 30 entries with one-line descriptions of at most 200 chars.
 */
export function renderPersonaRoster(
  personas: readonly RosterPersona[],
  selfName: string,
): string {
  const others = personas
    .filter((p) => p.name !== selfName)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (others.length === 0) {
    return 'Available personas: none (no other personas are loaded).';
  }

  const lines = others.slice(0, ROSTER_MAX_PERSONAS).map((p) => {
    const description = p.description ? oneLine(p.description) : '';
    return `- ${p.name}: ${description || ROSTER_NO_DESCRIPTION}`;
  });
  if (others.length > ROSTER_MAX_PERSONAS) {
    lines.push(`- … and ${others.length - ROSTER_MAX_PERSONAS} more (use persona_list)`);
  }
  return `Available personas:\n${lines.join('\n')}`;
}

/**
 * Builds the roster from the live loader (reflects hot reload). Returns the
 * appendix map for `resolveToolInstructions`, or `undefined` when
 * `persona_send` is not among the allowed tools.
 */
export function buildPersonaRosterAppendix(
  loader: Pick<PersonaLoader, 'listNames' | 'getByName'>,
  allowedMcpTools: readonly string[],
  selfName: string,
): Record<string, string> | undefined {
  if (!allowedMcpTools.includes('persona_send')) return undefined;
  const personas = loader.listNames().map((name) => {
    const loaded = loader.getByName(name);
    const persona = loaded.isOk() ? loaded.value : undefined;
    return { name, description: getPersonaDescription(persona) };
  });
  return { 'persona.send': renderPersonaRoster(personas, selfName) };
}
