export const TALON_SKILL_INDEX_HEADING = '## Talon Persona Skills';

export const TALON_SKILL_INDEX_INTRO =
  'These skills belong to the current Talon persona. They are separate from any built-in provider or host skills.';

export const TALON_SKILL_INDEX_GUIDANCE =
  'BEFORE acting on a user request, scan the skills above. If any "Use when…" trigger matches the request, call `skill_load` first and follow the loaded instructions — descriptions are triggers, not specifications, and intentionally omit conventions, exact tool names, and edge cases. Do not infer behavior from the description alone. When two skills could match, load both. A listed skill may not already be loaded into context, so do not assume you know what it says.';

export const TALON_SKILL_LOAD_TOOL_DESCRIPTION =
  'Load the full instructions for a Talon persona skill. `skill_load` is authoritative for skills listed under Talon Persona Skills. Pass the skill name exactly as shown there.';

export function normalizeSkillDescription(description: string): string {
  return description.replace(/\s+/gu, ' ').trim();
}

export function formatMissingTalonSkillError(
  skillName: string,
  availableSkillNames: string[],
): string {
  const available = availableSkillNames.length > 0 ? availableSkillNames.join(', ') : 'none';
  return `Talon persona skill "${skillName}" not found. Available Talon persona skills: ${available}`;
}
