/**
 * WhatsApp Cloud API types used by the connector.
 *
 * These represent only the fields that the connector uses from the WhatsApp
 * Cloud API payloads. Additional fields exist in the real API but are omitted
 * here unless needed.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a WhatsAppConnector instance.
 */
export interface WhatsAppConfig {
  /** WhatsApp Business phone number ID. */
  phoneNumberId: string;
  /** Permanent or temporary access token. */
  accessToken: string;
  /**
   * Webhook verify token used to validate incoming webhook subscriptions.
   * Must match the token configured in the Meta App Dashboard.
   */
  verifyToken: string;
  /**
   * App secret from the Meta App Dashboard.
   * Required to validate the HMAC-SHA256 signature on inbound webhook POSTs.
   * When set alongside `webhookPort`, the inbound webhook server is started.
   */
  appSecret?: string;
  /**
   * WhatsApp Cloud API version, e.g. 'v18.0'.
   * Defaults to 'v18.0' if not set.
   */
  apiVersion?: string;
  /**
   * TCP port for the local webhook HTTP server.
   * When set alongside `appSecret`, the server is started on connector start().
   * Defaults to 3000 when `appSecret` is provided and no explicit port is set.
   */
  webhookPort?: number;
  /**
   * Network interface to bind the webhook server to.
   * Defaults to '0.0.0.0' (all interfaces).
   */
  webhookHost?: string;
  /**
   * URL path to serve webhook requests on.
   * Defaults to '/webhook'.
   */
  webhookPath?: string;
}

// ---------------------------------------------------------------------------
// Inbound message objects
// ---------------------------------------------------------------------------

/**
 * A WhatsApp contact as it appears in the webhook payload.
 */
export interface WhatsAppContact {
  profile: {
    name: string;
  };
  wa_id: string;
}

/**
 * A text message payload within a WhatsApp message.
 */
export interface WhatsAppTextBody {
  body: string;
}

/**
 * A media message payload (image, document, audio, video, sticker).
 */
export interface WhatsAppMediaBody {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

/**
 * A single WhatsApp message as received in a webhook.
 */
export interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: WhatsAppTextBody;
  image?: WhatsAppMediaBody;
  document?: WhatsAppMediaBody;
  audio?: WhatsAppMediaBody;
  video?: WhatsAppMediaBody;
  sticker?: WhatsAppMediaBody;
}

/**
 * A media message — convenience alias used when we know the type is media.
 */
export type WhatsAppMediaMessage = WhatsAppMessage & {
  type: 'image' | 'document' | 'audio' | 'video' | 'sticker';
};

/**
 * The value object nested inside a webhook change entry.
 */
export interface WhatsAppWebhookValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
}

/**
 * A single change entry in a webhook payload.
 */
export interface WhatsAppWebhookChange {
  value: WhatsAppWebhookValue;
  field: string;
}

/**
 * A WhatsApp Business Account entry in the webhook.
 */
export interface WhatsAppWebhookEntry {
  id: string;
  changes: WhatsAppWebhookChange[];
}

/**
 * Top-level webhook payload from the WhatsApp Cloud API.
 */
export interface WhatsAppWebhookPayload {
  object: string;
  entry: WhatsAppWebhookEntry[];
}

// ---------------------------------------------------------------------------
// Outbound API response
// ---------------------------------------------------------------------------

/**
 * Result of a WhatsApp Cloud API send message call.
 */
export interface WhatsAppSendResult {
  messaging_product?: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string }>;
  /** Present when the API returns an error. */
  error?: {
    message: string;
    type: string;
    code: number;
    error_data?: { messaging_product: string; details: string };
    fbtrace_id?: string;
  };
}
