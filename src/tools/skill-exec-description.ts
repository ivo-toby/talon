/**
 * Shared description builder for dynamic `<skill>_exec` MCP tools.
 *
 * Used by both the external MCP server (via `TALOND_SKILL_EXEC_TOOLS` env var)
 * and the in-process SDK MCP server to produce consistent, informative
 * tool descriptions. Secret values are never included — only names.
 */

import type { SkillSandboxProfile } from '../skills/skill-sandbox-schema.js';

/**
 * Metadata for a single dynamic skill-exec MCP tool.
 *
 * Serialised as JSON in the `TALOND_SKILL_EXEC_TOOLS` environment variable
 * for the external MCP server, or used directly in the in-process path.
 */
export interface SkillExecToolMeta {
  /** MCP tool name, e.g. "contentful_exec" */
  mcpName: string;
  /** Original skill name, e.g. "contentful" */
  skillName: string;
  /** Auto-generated description from sandbox profile */
  description: string;
}

/**
 * Builds a human-readable description for a `<skill>_exec` MCP tool.
 *
 * The description informs the agent about the sandbox capabilities without
 * leaking any secret values — only secret names are listed.
 *
 * @param profile - The skill's sandbox profile from the manifest
 * @param skillName - The original skill name (e.g. "contentful")
 * @returns A description string suitable for MCP tool registration
 */
export function buildSkillExecDescription(
  profile: SkillSandboxProfile,
  skillName: string,
): string {
  const secretsList = profile.secrets.length > 0
    ? profile.secrets.join(', ')
    : 'none';

  const binsList = profile.bins.join(', ');

  return [
    `Run bash commands in the '${skillName}' skill sandbox. Repo mounted at /workspace.`,
    `Secrets injected (names only): ${secretsList}. Network: ${profile.network}.`,
    `Allowed binaries: ${binsList}. Timeout ${profile.timeoutSeconds}s.`,
    `See \`skill_load ${skillName}\` for usage instructions.`,
  ].join(' ');
}

/**
 * JSON input schema for `<skill>_exec` MCP tools.
 *
 * Shared between the external MCP server and in-process SDK registration
 * to avoid definition drift.
 */
export const SKILL_EXEC_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    command: {
      type: 'string' as const,
      description: 'Bash command to execute in the skill sandbox',
    },
    timeoutSeconds: {
      type: 'integer' as const,
      minimum: 1,
      description: 'Optional timeout override in seconds',
    },
  },
  required: ['command'],
} as const;
