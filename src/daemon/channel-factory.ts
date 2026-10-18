/**
 * Channel connector factory.
 *
 * Creates channel connectors by type string. Extracted from daemon.ts
 * to decouple connector construction from the daemon orchestrator.
 */

import type pino from 'pino';
import type { ChannelConnector } from '../channels/channel-types.js';
import type { ImageSelectionSettings } from '../images/image-selection.js';
import { TelegramConnector } from '../channels/connectors/telegram/telegram-connector.js';
import type { TelegramConfig } from '../channels/connectors/telegram/telegram-types.js';
import { SlackConnector } from '../channels/connectors/slack/slack-connector.js';
import type { SlackConfig } from '../channels/connectors/slack/slack-types.js';
import { DiscordConnector } from '../channels/connectors/discord/discord-connector.js';
import type { DiscordConfig } from '../channels/connectors/discord/discord-types.js';
import { WhatsAppConnector } from '../channels/connectors/whatsapp-business/whatsapp-connector.js';
import type { WhatsAppConfig } from '../channels/connectors/whatsapp-business/whatsapp-types.js';
import { WhatsAppBaileysConnector } from '../channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.js';
import type { WhatsAppBaileysConfig } from '../channels/connectors/whatsapp-baileys/whatsapp-baileys-types.js';
import { EmailConnector } from '../channels/connectors/email/email-connector.js';
import type { EmailConfig } from '../channels/connectors/email/email-types.js';
import { TerminalConnector } from '../channels/connectors/terminal/terminal-connector.js';
import type { TerminalConfig } from '../channels/connectors/terminal/terminal-types.js';

/**
 * Daemon-level image intake settings forwarded to the connectors that
 * accept image Attachments. Values come from the validated `images` config
 * section; connectors merge them over their own defaults.
 */
export type ConnectorImageSettings = Partial<ImageSelectionSettings>;

/**
 * Creates a channel connector instance for the given type.
 *
 * @param type          - Channel type string (e.g. 'telegram', 'slack').
 * @param name          - Instance name from config.
 * @param config        - Channel-specific configuration object.
 * @param logger        - Pino logger.
 * @param imageSettings - Validated `images` intake limits, forwarded only to
 *                        the image-capable connectors (telegram, WhatsApp
 *                        Business, WhatsApp Baileys, email). Connectors
 *                        without image intake ignore it.
 * @returns The constructed connector, or null if the type is unknown.
 */
export function createConnector(
  type: string,
  name: string,
  config: Record<string, unknown>,
  logger: pino.Logger,
  imageSettings?: ConnectorImageSettings,
): ChannelConnector | null {
  switch (type) {
    case 'telegram':
      return new TelegramConnector(config as unknown as TelegramConfig, name, logger, {
        imageSettings,
      });
    case 'slack':
      return new SlackConnector(config as unknown as SlackConfig, name, logger);
    case 'discord':
      return new DiscordConnector(config as unknown as DiscordConfig, name, logger);
    case 'whatsapp':
    case 'whatsappBusiness':
      return new WhatsAppConnector(config as unknown as WhatsAppConfig, name, logger, {
        imageSettings,
      });
    case 'whatsappBaileys':
      return new WhatsAppBaileysConnector(
        config as unknown as WhatsAppBaileysConfig,
        name,
        logger,
        imageSettings,
      );
    case 'email':
      return new EmailConnector(config as unknown as EmailConfig, name, logger, { imageSettings });
    case 'terminal':
      return new TerminalConnector(config as unknown as TerminalConfig, name, logger);
    default:
      return null;
  }
}
