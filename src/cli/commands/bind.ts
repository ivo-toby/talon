/**
 * `talonctl bind` command.
 *
 * Binds a persona to a channel in talond.yaml.
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

export interface BindOptions {
  persona: string;
  channel: string;
  /**
   * Bind one conversation of the channel instead of the whole channel: the
   * channel-specific thread ID, e.g. a Telegram forum topic
   * (`-1001234567890:42`).
   */
  thread?: string;
  configPath?: string;
}

export interface BindResult {
  persona: string;
  channel: string;
  thread?: string;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Binds a persona to a channel in the config file.
 *
 * @throws Error if persona or channel don't exist, or binding already exists.
 */
export async function bind(options: BindOptions): Promise<BindResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Validate names.
  const personaError = validateName(options.persona, 'Persona');
  if (personaError) throw new Error(personaError);
  const channelError = validateName(options.channel, 'Channel');
  if (channelError) throw new Error(channelError);

  const doc = await readConfig(configPath);

  // Verify persona exists.
  const personas = Array.isArray(doc.personas) ? doc.personas : [];
  if (!personas.find((p) => p.name === options.persona)) {
    throw new Error(`Persona "${options.persona}" not found in "${configPath}".`);
  }

  // Verify channel exists.
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  if (!channels.find((c) => c.name === options.channel)) {
    throw new Error(`Channel "${options.channel}" not found in "${configPath}".`);
  }

  // Ensure bindings array exists.
  if (!Array.isArray(doc.bindings)) {
    doc.bindings = [];
  }

  // A thread-scoped binding routes one conversation; it is never a default
  // and a conversation can have only one persona.
  const thread = options.thread?.trim();
  if (options.thread !== undefined) {
    if (!thread) {
      throw new Error('Thread must be a non-empty thread ID.');
    }
    const bound = doc.bindings.find(
      (b) => b.channel === options.channel && String(b.thread ?? '') === thread,
    );
    if (bound) {
      throw new Error(
        `Thread "${thread}" on channel "${options.channel}" is already bound to persona "${bound.persona}". Unbind it first.`,
      );
    }
    doc.bindings.push({ persona: options.persona, channel: options.channel, thread });
    await writeConfigAtomic(configPath, doc);
    return { persona: options.persona, channel: options.channel, thread };
  }

  // Check for duplicate binding.
  const existing = doc.bindings.find(
    (b) => b.persona === options.persona && b.channel === options.channel && b.thread === undefined,
  );
  if (existing) {
    throw new Error(
      `Persona "${options.persona}" is already bound to channel "${options.channel}".`,
    );
  }

  // Determine if this is the first channel-level binding for this channel
  // (make it default). Thread-scoped bindings do not count.
  const isDefault = !doc.bindings.some(
    (b) => b.channel === options.channel && b.thread === undefined,
  );

  doc.bindings.push({
    persona: options.persona,
    channel: options.channel,
    isDefault,
  });

  await writeConfigAtomic(configPath, doc);

  return { persona: options.persona, channel: options.channel };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function bindCommand(options: BindOptions): Promise<void> {
  try {
    const result = await bind(options);
    console.log(
      result.thread !== undefined
        ? `Bound persona "${result.persona}" to thread "${result.thread}" on channel "${result.channel}". Restart talond to apply.`
        : `Bound persona "${result.persona}" to channel "${result.channel}".`,
    );
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
