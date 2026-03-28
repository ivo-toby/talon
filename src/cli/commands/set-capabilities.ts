/**
 * `talonctl set-capabilities` command.
 *
 * Programmatically set capability labels on a persona.
 */

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';
import { ALL_CAPABILITY_LABELS } from '../../tools/tool-filter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetCapabilitiesOptions {
  persona: string;
  configPath?: string;
  /** Replace entire allow list (comma-separated). */
  allow?: string;
  /** Append to allow list (comma-separated). */
  add?: string;
  /** Remove from allow list (comma-separated). */
  remove?: string;
  /** Replace entire requireApproval list (comma-separated). */
  requireApproval?: string;
  /** Print current capabilities and return without writing. */
  show?: boolean;
}

export interface CapabilitiesResult {
  allow: string[];
  requireApproval: string[];
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Sets capabilities on a persona in the config file.
 *
 * @returns The final capabilities after modification.
 * @throws Error on validation failures or config errors.
 */
export async function setCapabilities(options: SetCapabilitiesOptions): Promise<CapabilitiesResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const doc = await readConfig(configPath);

  // Find persona.
  const personas = Array.isArray(doc.personas) ? doc.personas : [];
  const persona = personas.find((p) => p.name === options.persona);
  if (!persona) {
    throw new Error(`Persona "${options.persona}" not found in "${configPath}".`);
  }

  // Ensure capabilities object exists.
  if (!persona.capabilities) {
    persona.capabilities = { allow: [], requireApproval: [] };
  }
  const caps = persona.capabilities as { allow?: string[]; requireApproval?: string[] };
  if (!Array.isArray(caps.allow)) caps.allow = [];
  if (!Array.isArray(caps.requireApproval)) caps.requireApproval = [];

  // --show: read-only mode.
  if (options.show) {
    return { allow: caps.allow, requireApproval: caps.requireApproval };
  }

  // Validate mutual exclusivity.
  if (options.allow && (options.add || options.remove)) {
    throw new Error('--allow and --add/--remove are mutually exclusive. Use --allow to replace, or --add/--remove for incremental changes.');
  }

  // Apply changes.
  if (options.allow !== undefined) {
    caps.allow = parseLabels(options.allow);
  }

  if (options.add !== undefined) {
    const toAdd = parseLabels(options.add);
    for (const label of toAdd) {
      if (!caps.allow!.includes(label)) {
        caps.allow!.push(label);
      }
    }
  }

  if (options.remove !== undefined) {
    const toRemove = new Set(parseLabels(options.remove));
    caps.allow = caps.allow!.filter((l) => !toRemove.has(l));
  }

  if (options.requireApproval !== undefined) {
    caps.requireApproval = parseLabels(options.requireApproval);
  }

  // Warn on unrecognized labels.
  const allLabels = [...caps.allow!, ...caps.requireApproval!];
  const unknown = allLabels.filter((l) => !ALL_CAPABILITY_LABELS.includes(l));
  if (unknown.length > 0) {
    console.warn(`Warning: unrecognized capability label(s): ${unknown.join(', ')}`);
  }

  await writeConfigAtomic(configPath, doc);

  return { allow: caps.allow!, requireApproval: caps.requireApproval! };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function setCapabilitiesCommand(options: SetCapabilitiesOptions): Promise<void> {
  try {
    const result = await setCapabilities(options);

    if (options.show) {
      console.log(`Capabilities for persona "${options.persona}":`);
      console.log(`  allow: ${result.allow.length > 0 ? result.allow.join(', ') : '(none)'}`);
      console.log(`  requireApproval: ${result.requireApproval.length > 0 ? result.requireApproval.join(', ') : '(none)'}`);
      return;
    }

    console.log(`Updated capabilities for persona "${options.persona}":`);
    console.log(`  allow: ${result.allow.length > 0 ? result.allow.join(', ') : '(none)'}`);
    console.log(`  requireApproval: ${result.requireApproval.length > 0 ? result.requireApproval.join(', ') : '(none)'}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLabels(input: string): string[] {
  return input.split(',').map((l) => l.trim()).filter((l) => l.length > 0);
}
