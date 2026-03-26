/**
 * `talonctl init-persona` command.
 *
 * Copies a persona template (system.md) from templates/<name>/ to personas/<name>/.
 * If the target already exists it is never overwritten.
 * Falls back to the generic inline template when no named template is found.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { buildSystemPromptTemplate } from './add-persona.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitPersonaOptions {
  name: string;
  templatesDir?: string; // defaults to 'templates'
  personasDir?: string;  // defaults to 'personas'
}

export interface InitPersonaResult {
  systemPromptFile: string;
  created: boolean;        // false if file already existed
  usedTemplate: string | null; // path to template used, or null if generic fallback
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Initialises a persona directory from a template.
 *
 * 1. If `templates/<name>/system.md` exists → copy it to `personas/<name>/system.md`.
 * 2. Otherwise → write the generic inline template from `buildSystemPromptTemplate`.
 * 3. Never overwrites an existing `personas/<name>/system.md`.
 */
export async function initPersona(options: InitPersonaOptions): Promise<InitPersonaResult> {
  const templatesDir = options.templatesDir ?? 'templates';
  const personasDir = options.personasDir ?? 'personas';

  const personaDir = path.join(personasDir, options.name);
  const systemPromptFile = path.join(personaDir, 'system.md');

  // Never overwrite.
  if (existsSync(systemPromptFile)) {
    return { systemPromptFile, created: false, usedTemplate: null };
  }

  // Ensure target directory exists.
  await fs.mkdir(personaDir, { recursive: true });

  // Check for a named template.
  const templateFile = path.join(templatesDir, options.name, 'system.md');
  let usedTemplate: string | null = null;

  if (existsSync(templateFile)) {
    const content = await fs.readFile(templateFile, 'utf-8');
    await fs.writeFile(systemPromptFile, content, 'utf-8');
    usedTemplate = templateFile;
  } else {
    await fs.writeFile(systemPromptFile, buildSystemPromptTemplate(options.name), 'utf-8');
  }

  return { systemPromptFile, created: true, usedTemplate };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl init-persona`.
 */
export async function initPersonaCommand(options: InitPersonaOptions): Promise<void> {
  try {
    const result = await initPersona(options);

    if (!result.created) {
      console.log(`Already exists: ${result.systemPromptFile} (skipped)`);
      return;
    }

    if (result.usedTemplate) {
      console.log(`Created ${result.systemPromptFile} from template ${result.usedTemplate}`);
    } else {
      console.log(`Created ${result.systemPromptFile} using generic template (no named template found)`);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
