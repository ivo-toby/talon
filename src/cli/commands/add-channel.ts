/**
 * `talonctl add-channel` command.
 *
 * Adds a new channel connector entry to talond.yaml. The entry is appended
 * to the `channels` array with the given name and type, and a placeholder
 * `config` object that the user can fill in.
 */

import {
  DEFAULT_CONFIG_PATH,
  VALID_CHANNEL_TYPES,
  validateName,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddChannelOptions {
  name: string;
  type: string;
  configPath?: string;
}

export interface AddChannelEntry {
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: true;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Adds a channel to the config file.
 *
 * Pure business logic — no console output or process.exit.
 * Can be called from CLI, setup skill, or terminal agent.
 *
 * @returns The channel entry that was added.
 * @throws Error with a user-facing message on any failure.
 */
export async function addChannel(options: AddChannelOptions): Promise<AddChannelEntry> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Validate name.
  const nameError = validateName(options.name, 'Channel');
  if (nameError) {
    throw new Error(nameError);
  }

  // Validate type.
  if (!VALID_CHANNEL_TYPES.includes(options.type as (typeof VALID_CHANNEL_TYPES)[number])) {
    throw new Error(
      `Unknown channel type "${options.type}". Valid types: ${VALID_CHANNEL_TYPES.join(', ')}.`,
    );
  }

  // Read existing config.
  const doc = await readConfig(configPath);

  // Ensure channels array exists.
  if (!Array.isArray(doc.channels)) {
    doc.channels = [];
  }

  // Check for duplicate channel name.
  const duplicate = doc.channels.find((c) => c.name === options.name);
  if (duplicate) {
    throw new Error(
      `A channel named "${options.name}" already exists in "${configPath}". Choose a different name or edit the existing entry directly.`,
    );
  }

  // Build and append the new channel entry.
  const entry: AddChannelEntry = {
    name: options.name,
    type: options.type,
    config: buildPlaceholderConfig(options.type),
    enabled: true,
  };

  doc.channels.push(entry);

  // Write atomically.
  await writeConfigAtomic(configPath, doc);

  return entry;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl add-channel`.
 *
 * Thin wrapper around {@link addChannel} that prints output and exits.
 */
export async function addChannelCommand(options: AddChannelOptions): Promise<void> {
  try {
    const entry = await addChannel(options);
    console.log(`Added channel "${entry.name}" (type: ${entry.type}) to "${options.configPath ?? DEFAULT_CONFIG_PATH}".`);
    console.log(`Edit "${options.configPath ?? DEFAULT_CONFIG_PATH}" to fill in the channel credentials.`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns a type-specific placeholder config object for the channel entry.
 * Exported for use by the setup skill preview flow.
 */
export function buildPlaceholderConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'telegram':
      return { botToken: '${TELEGRAM_BOT_TOKEN}', pollingTimeoutSec: 30 };
    case 'slack':
      return { botToken: '${SLACK_BOT_TOKEN}', appToken: '${SLACK_APP_TOKEN}', signingSecret: '${SLACK_SIGNING_SECRET}' };
    case 'discord':
      return { botToken: '${DISCORD_BOT_TOKEN}', applicationId: 'YOUR_APPLICATION_ID' };
    case 'whatsapp':
    case 'whatsappBusiness':
      return { phoneNumberId: 'YOUR_PHONE_NUMBER_ID', accessToken: '${WHATSAPP_ACCESS_TOKEN}', verifyToken: '${WHATSAPP_VERIFY_TOKEN}', appSecret: '${WHATSAPP_APP_SECRET}' };
    case 'whatsappBaileys':
      return { authDir: './baileys-auth', selfChat: false, triggerWords: [] };
    case 'email':
      return {
        imapHost: 'imap.gmail.com', imapPort: 993, imapUser: 'bot@gmail.com', imapPass: '${EMAIL_PASSWORD}', imapSecure: true,
        smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpUser: 'bot@gmail.com', smtpPass: '${EMAIL_PASSWORD}', smtpSecure: false,
        fromAddress: 'Talon <bot@gmail.com>',
      };
    case 'terminal':
      return { port: 8089, host: '127.0.0.1', token: '${TERMINAL_TOKEN}' };
    default:
      return {};
  }
}
