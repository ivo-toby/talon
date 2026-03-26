/**
 * `talonctl add-skill` command.
 *
 * Scaffolds a new skill directory structure and registers the skill with a
 * persona in talond.yaml.
 *
 * Creates:
 *   skills/{name}/
 *   skills/{name}/skill.yaml     — skill manifest stub
 *   skills/{name}/prompts/       — prompts directory
 *
 * Updates talond.yaml:
 *   - Adds the skill name to the specified persona's `skills` list.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import {
  DEFAULT_CONFIG_PATH,
  validateName,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddSkillOptions {
  name: string;
  personaName: string;
  configPath?: string;
  skillsDir?: string;
  format?: 'yaml' | 'skillmd';
}

export interface AddSkillResult {
  name: string;
  personaName: string;
  skillDir: string;
  manifestPath: string;
  skillFilePath: string;
}

/** Skill manifest shape written to skill.yaml. */
interface SkillManifest {
  name: string;
  version: string;
  description: string;
  prompts: string[];
  capabilities: { allow: string[]; requireApproval: string[] };
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Adds a skill to a persona in the config file and scaffolds its directory.
 *
 * Pure business logic — no console output or process.exit.
 * Can be called from CLI, setup skill, or terminal agent.
 *
 * @returns Info about the added skill.
 * @throws Error with a user-facing message on any failure.
 */
export async function addSkill(options: AddSkillOptions): Promise<AddSkillResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const skillsDir = options.skillsDir ?? 'skills';

  // Validate skill name.
  const nameError = validateName(options.name, 'Skill');
  if (nameError) {
    throw new Error(nameError);
  }

  // Validate persona name.
  const personaError = validateName(options.personaName, 'Persona');
  if (personaError) {
    throw new Error(personaError);
  }

  // Read existing config.
  const doc = await readConfig(configPath);

  // Ensure personas array exists.
  if (!Array.isArray(doc.personas)) {
    doc.personas = [];
  }

  // Find the target persona.
  const persona = doc.personas.find((p) => p.name === options.personaName);
  if (!persona) {
    throw new Error(
      `Persona "${options.personaName}" not found in "${configPath}". Run \`talonctl add-persona --name ${options.personaName}\` to create it first.`,
    );
  }

  // Ensure persona has a skills array.
  if (!Array.isArray(persona.skills)) {
    persona.skills = [];
  }

  // Check if skill is already registered on this persona.
  if (persona.skills.includes(options.name)) {
    throw new Error(
      `Skill "${options.name}" is already registered on persona "${options.personaName}".`,
    );
  }

  // Scaffold skill directory.
  const skillDir = path.join(skillsDir, options.name);
  const format = options.format ?? 'yaml';

  // Prevent creating an ambiguous skill directory with both formats.
  if (format === 'skillmd' && existsSync(path.join(skillDir, 'skill.yaml'))) {
    throw new Error(
      `Skill "${options.name}" already has a skill.yaml. Cannot create SKILL.md alongside it (ambiguous format).`,
    );
  }
  if (format === 'yaml' && existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new Error(
      `Skill "${options.name}" already has a SKILL.md. Cannot create skill.yaml alongside it (ambiguous format).`,
    );
  }

  let skillFilePath: string;

  if (format === 'skillmd') {
    // SKILL.md format: single file with YAML frontmatter, no prompts/ subdir.
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    skillFilePath = skillMdPath;

    try {
      await fs.mkdir(skillDir, { recursive: true });
    } catch (cause) {
      throw new Error(`Error creating skill directory "${skillDir}": ${String(cause)}`);
    }

    if (!existsSync(skillMdPath)) {
      const stub = [
        '---',
        `name: ${options.name}`,
        'version: 0.1.0',
        `description: "${options.name} — replace with a meaningful description."`,
        '---',
        '',
        `# ${options.name}`,
        '',
        'Replace this with skill instructions.',
        '',
      ].join('\n');

      try {
        await fs.writeFile(skillMdPath, stub, 'utf-8');
      } catch (cause) {
        throw new Error(`Error writing SKILL.md "${skillMdPath}": ${String(cause)}`);
      }
    }
  } else {
    // Default yaml format: skill.yaml + prompts/ directory.
    const promptsDir = path.join(skillDir, 'prompts');
    const manifestPath = path.join(skillDir, 'skill.yaml');
    skillFilePath = manifestPath;

    try {
      await fs.mkdir(promptsDir, { recursive: true });
    } catch (cause) {
      throw new Error(`Error creating skill directory "${promptsDir}": ${String(cause)}`);
    }

    // Write skill manifest stub if it doesn't already exist.
    if (!existsSync(manifestPath)) {
      const manifest: SkillManifest = buildSkillManifest(options.name);
      const manifestYaml = yaml.dump(manifest, {
        lineWidth: 120,
        quotingType: '"',
        forceQuotes: false,
      });

      const header = [
        `# skill.yaml — ${options.name} skill manifest`,
        '# Edit this file to configure the skill.',
        '',
        '',
      ].join('\n');

      try {
        await fs.writeFile(manifestPath, header + manifestYaml, 'utf-8');
      } catch (cause) {
        throw new Error(`Error writing skill manifest "${manifestPath}": ${String(cause)}`);
      }
    }
  }

  // Register skill on persona.
  persona.skills.push(options.name);

  // Write atomically.
  await writeConfigAtomic(configPath, doc);

  return {
    name: options.name,
    personaName: options.personaName,
    skillDir,
    manifestPath: format === 'yaml' ? path.join(skillDir, 'skill.yaml') : path.join(skillDir, 'SKILL.md'),
    skillFilePath,
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl add-skill`.
 *
 * Thin wrapper around {@link addSkill} that prints output and exits.
 */
export async function addSkillCommand(options: AddSkillOptions): Promise<void> {
  try {
    const result = await addSkill(options);
    console.log(`Created skill directory:  ${result.skillDir}`);
    if (options.format !== 'skillmd') {
      console.log(`Created prompts directory: ${path.join(result.skillDir, 'prompts')}`);
    }
    console.log(`Created skill file:       ${result.skillFilePath}`);
    console.log(
      `Added skill "${result.name}" to persona "${result.personaName}" in "${options.configPath ?? DEFAULT_CONFIG_PATH}".`,
    );
    console.log(`Edit "${result.skillFilePath}" to configure the skill.`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a stub skill manifest object for the given skill name.
 */
export function buildSkillManifest(name: string): SkillManifest {
  return {
    name,
    version: '0.1.0',
    description: `${name} skill — replace this with a meaningful description.`,
    prompts: [],
    capabilities: {
      allow: [],
      requireApproval: [],
    },
  };
}
