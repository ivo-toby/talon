/**
 * `talonctl add-channel` command.
 *
 * Adds a new channel connector entry to talond.yaml. The entry is appended
 * to the `channels` array with the given name and type. Ordinary channels
 * receive placeholders; Signal requires operator-supplied canonical config.
 */

import { ChannelConfigSchema } from '../../core/config/config-schema.js';
import { ConfigError } from '../../core/errors/error-types.js';
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
  /** Untrusted operator setup input; required for Signal, never used as a placeholder. */
  signalConfig?: unknown;
  /** Signal channel-level notice policy, validated by ChannelConfigSchema. */
  showToolCalls?: boolean;
}

export interface AddChannelEntry {
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: true;
  showToolCalls?: boolean;
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
  const doc = await readConfig(configPath).catch((error: unknown) => {
    if (options.type === 'signal') {
      throw new ConfigError('Signal config file not found, unreadable, or invalid YAML');
    }
    throw error;
  });

  // YAML timestamp/binary scalar objects discard attached properties when serialized.
  if (
    options.type === 'signal' &&
    (typeof doc !== 'object' || doc === null ||
      (Object.getPrototypeOf(doc) !== Object.prototype && Object.getPrototypeOf(doc) !== null))
  ) {
    throw new ConfigError('Signal config file not found, unreadable, or invalid YAML');
  }

  // Ensure channels array exists.
  if (!Array.isArray(doc.channels)) {
    doc.channels = [];
  }

  // Check for duplicate channel name.
  const duplicate = doc.channels.find((c) => c.name === options.name);
  if (duplicate) {
    if (options.type === 'signal') {
      throw new ConfigError(
        'A channel with that name already exists. Choose a different name or edit the existing entry directly.',
      );
    }
    throw new Error(
      `A channel named "${options.name}" already exists in "${configPath}". Choose a different name or edit the existing entry directly.`,
    );
  }

  // Signal must pass the same normalization and channel-level policy as daemon config.
  // Never expose Zod issues, unknown input keys, or operator identities in errors.
  let entry: AddChannelEntry;
  if (options.type === 'signal') {
    const parsed = ChannelConfigSchema.safeParse({
      name: options.name,
      type: 'signal',
      config: options.signalConfig,
      showToolCalls: options.showToolCalls,
    });
    if (!parsed.success) {
      throw new ConfigError('Invalid Signal configuration');
    }
    entry = {
      name: options.name,
      type: 'signal',
      config: parsed.data.config,
      enabled: true,
      ...(parsed.data.showToolCalls === undefined ? {} : { showToolCalls: parsed.data.showToolCalls }),
    };
  } else {
    entry = {
      name: options.name,
      type: options.type,
      config: buildPlaceholderConfig(options.type),
      enabled: true,
    };
  }

  doc.channels.push(entry);

  // Write atomically.
  await writeConfigAtomic(configPath, doc).catch((error: unknown) => {
    if (options.type === 'signal') {
      throw new ConfigError('Unable to write Signal config file');
    }
    throw error;
  });

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
    if (entry.type === 'signal') {
      console.log('Signal configuration validated; runtime socket/account/device verification is still required.');
    } else {
      console.log(`Edit "${options.configPath ?? DEFAULT_CONFIG_PATH}" to fill in the channel credentials.`);
    }
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
    case 'signal':
      throw new ConfigError('Signal requires operator-supplied configuration');
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
