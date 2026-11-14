/**
 * `talonctl unbind` command.
 *
 * Removes a persona-channel binding from talond.yaml.
 */

import {
  DEFAULT_CONFIG_PATH,
  validateName,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnbindOptions {
  persona: string;
  channel: string;
  configPath?: string;
}

export interface UnbindResult {
  persona: string;
  channel: string;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Removes a persona-channel binding from the config file.
 *
 * @throws Error if the binding doesn't exist.
 */
export async function unbind(options: UnbindOptions): Promise<UnbindResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Validate names.
  const personaError = validateName(options.persona, 'Persona');
  if (personaError) throw new Error(personaError);
  const channelError = validateName(options.channel, 'Channel');
  if (channelError) throw new Error(channelError);

  const doc = await readConfig(configPath);

  if (!Array.isArray(doc.bindings) || doc.bindings.length === 0) {
    throw new Error(
      `No binding exists between persona "${options.persona}" and channel "${options.channel}".`,
    );
  }

  const idx = doc.bindings.findIndex(
    (b) => b.persona === options.persona && b.channel === options.channel,
  );
  if (idx === -1) {
    throw new Error(
      `No binding exists between persona "${options.persona}" and channel "${options.channel}".`,
    );
  }

  const wasDefault = doc.bindings[idx].isDefault === true;
  doc.bindings.splice(idx, 1);

  // If we removed the default binding, promote the next binding on this channel.
  if (wasDefault) {
    const nextOnChannel = doc.bindings.find((b) => b.channel === options.channel);
    if (nextOnChannel) {
      nextOnChannel.isDefault = true;
    }
  }

  await writeConfigAtomic(configPath, doc);

  return { persona: options.persona, channel: options.channel };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function unbindCommand(options: UnbindOptions): Promise<void> {
  try {
    const result = await unbind(options);
    console.log(`Removed binding: persona "${result.persona}" from channel "${result.channel}".`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
