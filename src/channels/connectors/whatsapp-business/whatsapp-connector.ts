/**
 * WhatsApp channel connector.
 *
 * Implements the ChannelConnector interface using the WhatsApp Cloud API.
 * Translates between the canonical InboundEvent / AgentOutput types and
 * WhatsApp Cloud API payloads.
 *
 * Two inbound modes are supported:
 * - **Webhook server mode** (default when `appSecret` is configured): an
 *   embedded HTTP server receives and validates POST requests from the Meta
 *   Cloud API and routes them to `feedWebhook()` automatically.
 * - **External proxy mode** (when `appSecret` is absent): no server is
 *   started; the caller is expected to proxy inbound webhook payloads to
 *   `feedWebhook()` directly.
 *
 * Outbound messages are always sent via the WhatsApp Cloud API graph endpoint.
 */

import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type {
  WhatsAppConfig,
  WhatsAppWebhookPayload,
  WhatsAppSendResult,
} from './whatsapp-types.js';
import { markdownToWhatsApp } from './whatsapp-format.js';
import { WhatsAppWebhookServer } from './whatsapp-webhook-server.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_API_VERSION = 'v18.0';
const GRAPH_API_BASE = 'https://graph.facebook.com';

// ---------------------------------------------------------------------------
// WhatsAppConnector
// ---------------------------------------------------------------------------

/**
 * Channel connector for WhatsApp via the Cloud API.
 *
 * Usage:
 * 1. Construct with a WhatsAppConfig and a channel name.
 * 2. Call `onMessage()` to register an inbound event handler.
 * 3. Call `start()` to mark the connector as active.
 * 4. Route incoming webhook payloads via `feedWebhook()`.
 * 5. Call `stop()` to mark the connector as inactive.
 */
export class WhatsAppConnector implements ChannelConnector {
  readonly type = 'whatsappBusiness';
  readonly name: string;

  private handler?: (event: InboundEvent) => void | Promise<void>;
  private running = false;
  private webhookServer: WhatsAppWebhookServer | null = null;

  constructor(
    private readonly config: WhatsAppConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
  }

  // ---------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Mark the connector as started and, if configured, start the inbound
   * webhook HTTP server.
   *
   * The webhook server is started when both `appSecret` and `webhookPort` (or
   * a default port) are present in the config. When `appSecret` is absent the
   * connector operates in send-only mode and no server is started.
   *
   * Idempotent — no-op if already running.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.debug({ channelName: this.name }, 'whatsapp-business connector already running');
      return;
    }

    if (this.config.appSecret) {
      const srv = new WhatsAppWebhookServer(
        {
          verifyToken: this.config.verifyToken,
          appSecret: this.config.appSecret,
          webhookPath: this.config.webhookPath,
        },
        this.logger,
      );
      srv.onPayload((payload) => this.feedWebhook(payload));
      const host = this.config.webhookHost ?? '0.0.0.0';
      const port = this.config.webhookPort ?? 3000;
      // Only mark as running after the server successfully binds — if start()
      // rejects (e.g. port in use) the connector stays in a stopped state and
      // can be retried or reconstructed cleanly.
      const boundPort = await srv.start(host, port);
      this.running = true;
      this.webhookServer = srv;
      this.logger.info(
        { channelName: this.name, host, port: boundPort },
        'whatsapp-business connector started with webhook server',
      );
    } else {
      this.running = true;
      this.logger.info(
        { channelName: this.name },
        'whatsapp-business connector started (send-only; no appSecret configured)',
      );
    }
  }

  /**
   * Stop the connector and shut down the webhook server if one is running.
   * Idempotent — no-op if already stopped.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.webhookServer) {
      await this.webhookServer.stop();
      this.webhookServer = null;
    }
    this.logger.info({ channelName: this.name }, 'whatsapp-business connector stopped');
  }

  /**
   * Register the inbound message handler.
   * A second call replaces the previous handler.
   */
  onMessage(handler: (event: InboundEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  /**
   * Send an AgentOutput to a WhatsApp conversation.
   *
   * @param externalThreadId - WhatsApp phone number (the recipient's `wa_id`).
   * @param output            - Agent output to deliver.
   */
  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const text = this.format(output.body);
    const apiVersion = this.config.apiVersion ?? DEFAULT_API_VERSION;
    const url = `${GRAPH_API_BASE}/${apiVersion}/${this.config.phoneNumberId}/messages`;

    const requestBody = JSON.stringify({
      messaging_product: 'whatsapp',
      to: externalThreadId,
      type: 'text',
      text: { body: text },
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.accessToken}`,
        },
        body: requestBody,
      });
    } catch (fetchErr) {
      const cause = fetchErr instanceof Error ? fetchErr : undefined;
      return err(new ChannelError(`WhatsApp send network error: ${String(fetchErr)}`, cause));
    }

    let data: WhatsAppSendResult;
    try {
      data = (await response.json()) as WhatsAppSendResult;
    } catch {
      return err(
        new ChannelError(`WhatsApp send: could not parse response (HTTP ${response.status})`),
      );
    }

    if (data.error) {
      const { code, message } = data.error;
      return err(new ChannelError(`WhatsApp send failed (${code}): ${message}`));
    }

    if (!response.ok) {
      return err(new ChannelError(`WhatsApp send failed with HTTP ${response.status}`));
    }

    return ok(undefined);
  }

  /**
   * Convert a Markdown string to WhatsApp's native format.
   */
  format(markdown: string): string {
    return markdownToWhatsApp(markdown);
  }

  // ---------------------------------------------------------------------------
  // Inbound webhook ingestion
  // ---------------------------------------------------------------------------

  /**
   * Accept a raw WhatsApp Cloud API webhook payload, normalise each text
   * message into an InboundEvent, and invoke the registered handler.
   *
   * This method is the integration point for the daemon's HTTP endpoint.
   * Non-text message types (image, document, audio, etc.) are logged and
   * skipped — they are not surfaced to the handler in v1.
   *
   * @param payload - Raw webhook payload from the WhatsApp Cloud API.
   */
  async feedWebhook(payload: WhatsAppWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') {
      this.logger.debug(
        { channelName: this.name, object: payload.object },
        'whatsapp webhook: ignoring non-whatsapp_business_account payload',
      );
      return;
    }

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') {
          continue;
        }

        const value = change.value;
        const messages = value.messages ?? [];

        for (const message of messages) {
          await this.handleMessage(message, value.contacts ?? []);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal message handling
  // ---------------------------------------------------------------------------

  /**
   * Normalise a single WhatsApp message into an InboundEvent and invoke the
   * registered handler. Non-text messages are logged and skipped.
   */
  private async handleMessage(
    message: import('./whatsapp-types.js').WhatsAppMessage,
    contacts: import('./whatsapp-types.js').WhatsAppContact[],
  ): Promise<void> {
    if (message.type !== 'text' || !message.text?.body) {
      this.logger.info(
        { channelName: this.name, messageId: message.id, type: message.type },
        'whatsapp message type not supported, skipping',
      );
      return;
    }

    // Resolve sender display name from contacts list if available.
    const contact = contacts.find((c) => c.wa_id === message.from);
    const senderId = message.from;

    // WhatsApp thread identity is the sender's phone number (wa_id).
    // For group messaging this would be different, but Cloud API v1 targets
    // individual conversations.
    const externalThreadId = message.from;

    const event: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId,
      senderId,
      idempotencyKey: message.id,
      content: message.text.body,
      timestamp: Number(message.timestamp) * 1000, // WhatsApp sends seconds; we want ms
      raw: { message, contact: contact ?? null },
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'whatsapp-business connector received message but no handler is registered',
      );
      return;
    }

    try {
      await this.handler(event);
    } catch (handlerErr) {
      this.logger.error(
        { channelName: this.name, err: handlerErr },
        'whatsapp-business connector handler threw an error',
      );
    }
  }
}
