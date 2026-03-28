/**
 * WhatsApp channel connector — public API.
 *
 * Implements the Channel interface for WhatsApp via the Cloud API.
 * Handles webhook payload ingestion, message normalisation, and outbound
 * send with Markdown-to-WhatsApp format conversion.
 */

export { WhatsAppConnector } from './whatsapp-connector.js';
export { markdownToWhatsApp } from './whatsapp-format.js';
export type {
  WhatsAppConfig,
  WhatsAppMessage,
  WhatsAppMediaMessage,
  WhatsAppContact,
  WhatsAppTextBody,
  WhatsAppMediaBody,
  WhatsAppWebhookPayload,
  WhatsAppWebhookEntry,
  WhatsAppWebhookChange,
  WhatsAppWebhookValue,
  WhatsAppSendResult,
} from './whatsapp-types.js';
