/**
 * `talonctl list-skills` command.
 *
 * Prints all skills for a persona (or all personas) from talond.yaml.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListSkillsOptions {
  configPath?: string;
  personaName?: string;
}

export interface SkillInfo {
  personaName: string;
  skillName: string;
  format: 'yaml' | 'skillmd' | 'unknown';
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Returns all skills from the config file, optionally filtered by persona.
 *
 * @throws Error if the config file can't be read or persona not found.
 */
export async function listSkills(options: ListSkillsOptions = {}): Promise<SkillInfo[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const doc = await readConfig(configPath);

  if (!Array.isArray(doc.personas)) {
    return [];
  }

  // If a specific persona is requested, filter to it.
  let personas = doc.personas;
  if (options.personaName) {
    const found = personas.find((p) => p.name === options.personaName);
    if (!found) {
      throw new Error(`Persona "${options.personaName}" not found in "${configPath}".`);
    }
    personas = [found];
  }

  const skillsDir = 'skills';
  const result: SkillInfo[] = [];
  for (const p of personas) {
    const skills = Array.isArray(p.skills) ? p.skills : [];
    for (const skillName of skills) {
      let format: SkillInfo['format'] = 'unknown';
      if (existsSync(path.join(skillsDir, skillName, 'SKILL.md'))) {
        format = 'skillmd';
      } else if (existsSync(path.join(skillsDir, skillName, 'skill.yaml'))) {
        format = 'yaml';
      }
      result.push({ personaName: p.name, skillName, format });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function listSkillsCommand(options: ListSkillsOptions = {}): Promise<void> {
  try {
    const skills = await listSkills(options);

    if (skills.length === 0) {
      console.log('No skills configured.');
      return;
    }

    console.log(`${'PERSONA'.padEnd(25)} ${'SKILL'.padEnd(25)} FORMAT`);
    console.log(`${'─'.repeat(25)} ${'─'.repeat(25)} ${'─'.repeat(10)}`);

    for (const s of skills) {
      console.log(`${s.personaName.padEnd(25)} ${s.skillName.padEnd(25)} ${s.format}`);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
