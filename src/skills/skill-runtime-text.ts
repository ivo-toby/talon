export const TALON_SKILL_INDEX_HEADING = '## Talon Persona Skills';

export const TALON_SKILL_INDEX_INTRO =
  'These skills belong to the current Talon persona. They are separate from any built-in provider or host skills.';

export const TALON_SKILL_INDEX_GUIDANCE =
  'For Talon skills, `skill_load` is authoritative. If a skill is listed here, call `skill_load` before claiming it is unavailable. A listed skill may not already be loaded into context.';

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
