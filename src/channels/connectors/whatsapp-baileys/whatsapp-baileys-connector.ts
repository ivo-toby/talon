/**
 * WhatsApp Baileys connector.
 *
 * Connects to WhatsApp Web via the Baileys library (@whiskeysockets/baileys)
 * as an alternative to the WhatsApp Cloud API. Works with any regular WhatsApp
 * number — no Meta Business account required.
 *
 * Authentication:
 * - Run `talonctl whatsapp-auth` before starting the daemon. It prints a QR
 *   code to the terminal — scan it with the WhatsApp app under Linked Devices.
 * - Credentials are persisted to `authDir` and reused on subsequent starts.
 * - The daemon itself never prints QR codes; it logs a warning if not authenticated.
 *
 * Inbound messages:
 * - Text messages from individual chats are normalised to InboundEvent and
 *   forwarded to the registered handler.
 * - Group messages and non-text messages are logged and ignored in v1.
 *
 * Outbound messages:
 * - `send()` accepts a standard WhatsApp JID, e.g. `447700900000@s.whatsapp.net`
 *   for individual chats or `<groupId>@g.us` for groups.
 *
 * Reconnection:
 * - On `connectionUpdate` with `DisconnectReason.loggedOut`, the session is
 *   cleared and the connector stops (re-authenticate required).
 * - On other disconnect reasons the connector reconnects automatically.
 */

import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import { markdownToWhatsApp } from '../whatsapp-business/whatsapp-format.js';
import type { WhatsAppBaileysConfig } from './whatsapp-baileys-types.js';

/** Baileys socket type — resolved dynamically to avoid hard import-time dependency. */
type BaileysSocket = ReturnType<typeof import('@whiskeysockets/baileys').makeWASocket>;

/** Loose representation of a Baileys WAMessage for the inbound handler. */
interface InboundWAMessage {
  key: {
    fromMe?: boolean | null;
    remoteJid?: string | null;
    id?: string | null;
  };
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | { low: number; high: number; unsigned: boolean } | null;
}

export class WhatsAppBaileysConnector implements ChannelConnector {
  readonly type = 'whatsappBaileys';
  readonly name: string;

  private handler?: (event: InboundEvent) => void | Promise<void>;
  private running = false;
  private sock: BaileysSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set of bare self-identifiers (stripped of @domain and :device).
   * Baileys exposes the phone-number JID via sock.user.id but self-chat
   * messages may arrive under the LID JID. We store both so the self-chat
   * comparison matches either format.
   */
  private selfIds = new Set<string>();

  constructor(
    private readonly config: WhatsAppBaileysConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
  }

  async start(): Promise<void> {
    if (this.running) {
      this.logger.debug({ channelName: this.name }, 'whatsapp-baileys: already running');
      return;
    }

    const baileys = await import('@whiskeysockets/baileys').catch(() => {
      throw new Error(
        'whatsapp-baileys requires @whiskeysockets/baileys. Run: npm install @whiskeysockets/baileys',
      );
    });

    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;

    const authDir = this.config.authDir ?? './baileys-auth';
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Fetch the latest WhatsApp Web version to avoid 405 protocol rejections.
    // Baileys' bundled default goes stale as WhatsApp increments server-side.
    let version: [number, number, number] | undefined;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
      this.logger.info(
        { channelName: this.name, version },
        'whatsapp-baileys: fetched latest WA web version',
      );
    } catch {
      this.logger.warn(
        { channelName: this.name },
        'whatsapp-baileys: failed to fetch latest version, using bundled default',
      );
    }

    const sock = makeWASocket({
      auth: state,
      version,
      browser: this.config.browser ?? Browsers.appropriate('Talon'),
      logger: this.logger.child({ component: 'baileys' }) as unknown as ReturnType<
        typeof pino
      >,
      markOnlineOnConnect: this.config.markOnlineOnConnect ?? false,
    });

    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.logger.warn(
            { channelName: this.name },
            'whatsapp-baileys: not authenticated. Run "talonctl whatsapp-auth" to scan a QR code and link this device.',
          );
        }

        if (connection === 'open') {
          this.running = true;
          // Capture own identifiers for self-chat mode.
          // sock.user.id is the phone-number JID (e.g. "31612345678:49@s.whatsapp.net").
          // sock.user.lid is the LID JID (e.g. "96490886312027:49@lid").
          // Self-chat messages may arrive under either format, so store both.
          this.selfIds.clear();
          const userPn = sock.user?.id;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const userLid = (sock.user as any)?.lid as string | undefined;
          if (userPn) this.selfIds.add(userPn.replace(/@.*$/, '').replace(/:\d+$/, ''));
          if (userLid) this.selfIds.add(userLid.replace(/@.*$/, '').replace(/:\d+$/, ''));
          const allowedSenders = this.config.allowedSenders;
          this.logger.info(
            {
              channelName: this.name,
              authDir,
              selfIds: [...this.selfIds],
              selfChat: this.config.selfChat ?? false,
              triggerWords: this.config.triggerWords?.length ? this.config.triggerWords : 'none',
              allowedSenders: allowedSenders?.length ? allowedSenders : 'none (open to all)',
            },
            'whatsapp-baileys connector connected',
          );
          if (!settled) {
            settled = true;
            resolve();
          }
        }

        if (connection === 'close') {
          const statusCode = (
            lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          this.running = false;
          this.sock = null;

          if (loggedOut) {
            this.logger.warn(
              { channelName: this.name },
              'whatsapp-baileys: logged out — re-authentication required. Delete authDir and restart.',
            );
            if (!settled) {
              settled = true;
              reject(new Error('WhatsApp Baileys: logged out, re-authentication required'));
            }
          } else {
            this.logger.info(
              { channelName: this.name, statusCode },
              'whatsapp-baileys: disconnected, reconnecting in 5s...',
            );
            if (!settled) {
              settled = true;
              resolve();
            }
            this.scheduleReconnect();
          }
        }
      });

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          this.handleInboundMessage(msg as unknown as InboundWAMessage).catch((handlerErr: unknown) => {
            this.logger.error(
              { err: handlerErr, channelName: this.name },
              'whatsapp-baileys: handler error',
            );
          });
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.running && !this.sock) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.running = false;
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // ignore errors during shutdown
      }
      this.sock = null;
    }
    this.logger.info({ channelName: this.name }, 'whatsapp-baileys connector stopped');
  }

  onMessage(handler: (event: InboundEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  async send(
    externalThreadId: string,
    output: AgentOutput,
  ): Promise<Result<void, ChannelError>> {
    if (!this.running || !this.sock) {
      return err(new ChannelError('whatsapp-baileys connector is not running'));
    }
    const text = this.format(output.body);
    try {
      await this.sock.sendMessage(externalThreadId, { text });
      return ok(undefined);
    } catch (sendErr) {
      const cause = sendErr instanceof Error ? sendErr : undefined;
      return err(
        new ChannelError(`whatsapp-baileys send failed: ${String(sendErr)}`, cause),
      );
    }
  }

  async sendTyping(externalThreadId: string): Promise<void> {
    if (!this.running || !this.sock) return;
    try {
      await this.sock.sendPresenceUpdate('composing', externalThreadId);
    } catch {
      // Non-critical — swallow errors silently.
    }
  }

  format(markdown: string): string {
    return markdownToWhatsApp(markdown);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async handleInboundMessage(msg: InboundWAMessage): Promise<void> {
    if (!msg.message || !msg.key.remoteJid || !msg.key.id) return;

    const jid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe ?? false;
    const selfChat = this.config.selfChat ?? false;

    this.logger.debug(
      { channelName: this.name, jid, fromMe, messageId: msg.key.id },
      'whatsapp-baileys: inbound message received',
    );

    // ── Self-chat mode ────────────────────────────────────────────────
    // In self-chat mode the bot only listens to the user's own "Message
    // Yourself" thread. Accept fromMe messages in the self-JID thread;
    // reject everything else.
    if (selfChat) {
      if (this.selfIds.size === 0) return; // not yet connected
      // Compare bare ID against all known self-identifiers (PN + LID).
      const bareJid = jid.replace(/@.*$/, '').replace(/:\d+$/, '');
      if (!this.selfIds.has(bareJid)) {
        this.logger.debug(
          { channelName: this.name, jid, bareJid, selfIds: [...this.selfIds] },
          'whatsapp-baileys: self-chat mode, ignoring non-self JID',
        );
        return;
      }
      // In self-chat, only accept fromMe (the user typing to themselves).
      if (!fromMe) return;
    } else {
      // ── Normal mode ───────────────────────────────────────────────
      if (fromMe) return;

      // Enforce allowedSenders restriction if configured.
      // Accepts the identifier part of any JID format:
      //   - Phone-based: "31612345678@s.whatsapp.net" or "31612345678:42@s.whatsapp.net"
      //   - LID-based:   "96490886312027@lid"
      // Strip the @domain suffix and any :device suffix to get the bare sender ID.
      const allowedSenders = this.config.allowedSenders;
      if (allowedSenders && allowedSenders.length > 0) {
        const senderId = jid.replace(/@.*$/, '').replace(/:\d+$/, '');
        if (!allowedSenders.includes(senderId)) {
          this.logger.warn(
            { channelName: this.name, jid, senderId },
            'whatsapp-baileys: message from disallowed sender, dropping',
          );
          return;
        }
      }

      // Skip group messages in normal mode.
      if (jid.endsWith('@g.us')) {
        this.logger.debug(
          { channelName: this.name, jid },
          'whatsapp-baileys: skipping group message',
        );
        return;
      }
    }

    // ── Extract text content ──────────────────────────────────────────
    let text =
      (msg.message['conversation'] as string | undefined) ??
      (msg.message['extendedTextMessage'] as { text?: string } | undefined)?.text;

    if (!text) {
      this.logger.debug(
        { channelName: this.name, jid, messageType: Object.keys(msg.message)[0] },
        'whatsapp-baileys: skipping non-text message',
      );
      return;
    }

    // ── Trigger word filter ───────────────────────────────────────────
    const triggerWords = this.config.triggerWords;
    if (triggerWords && triggerWords.length > 0) {
      const lower = text.toLowerCase();
      const matched = triggerWords.find((tw) => lower.startsWith(tw.toLowerCase()));
      if (!matched) {
        this.logger.debug(
          { channelName: this.name, jid },
          'whatsapp-baileys: no trigger word matched, dropping',
        );
        return;
      }
      // Strip the trigger word and any leading whitespace after it.
      text = text.slice(matched.length).trimStart();
      if (!text) return; // trigger word only, no actual message
    }

    const rawTimestamp = msg.messageTimestamp;
    const epochMs =
      (typeof rawTimestamp === 'number'
        ? rawTimestamp
        : typeof rawTimestamp === 'object' && rawTimestamp !== null
          ? Number(rawTimestamp)
          : 0) * 1000;

    const event: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId: jid,
      senderId: jid,
      idempotencyKey: msg.key.id,
      content: text,
      timestamp: epochMs,
      raw: msg,
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'whatsapp-baileys: no handler registered',
      );
      return;
    }

    try {
      await this.handler(event);
    } catch (handlerErr) {
      this.logger.error(
        { channelName: this.name, err: handlerErr },
        'whatsapp-baileys: message handler threw',
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((reconnectErr: unknown) => {
        this.logger.error(
          { channelName: this.name, err: reconnectErr },
          'whatsapp-baileys: reconnect failed',
        );
      });
    }, 5000);
  }
}
