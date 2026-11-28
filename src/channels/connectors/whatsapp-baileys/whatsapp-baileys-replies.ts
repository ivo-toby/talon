/**
 * WhatsApp Web (Baileys) reply and reaction mapping.
 *
 * Pure translation between Baileys message shapes and Talon's reply/reaction
 * types. WhatsApp addresses a message by its key — chat JID, message ID,
 * whether this account sent it, and in groups the author's JID — so a quote
 * or a reaction on a stored message is rebuilt from what the message ledger
 * recorded rather than from the original Baileys object.
 */

import type { InboundReaction, InboundReplyContext, MessageTarget } from '../../channel-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Text of a quoted message: plain text, extended text, or a media caption. */
function quotedText(quoted: unknown): string | undefined {
  if (!isRecord(quoted)) return undefined;
  const conversation = nonEmptyString(quoted['conversation']);
  if (conversation !== undefined) return conversation;
  for (const key of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage']) {
    const part = quoted[key];
    if (isRecord(part)) {
      const text = nonEmptyString(part['text']) ?? nonEmptyString(part['caption']);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

/**
 * The message an (unwrapped) inbound message quotes, or undefined.
 *
 * WhatsApp carries the quote in the `contextInfo` of whichever content part
 * the message has (`extendedTextMessage`, `imageMessage`, …): `stanzaId` is
 * the quoted message's ID, `participant` its author, `quotedMessage` its
 * content. Whether Talon sent the quoted message is NOT derived here — the
 * account is shared with its human owner, so only the message ledger knows.
 */
export function extractQuotedContext(
  content: Record<string, unknown> | undefined,
): InboundReplyContext | undefined {
  if (content === undefined) return undefined;
  for (const part of Object.values(content)) {
    if (!isRecord(part)) continue;
    const contextInfo = part['contextInfo'];
    if (!isRecord(contextInfo)) continue;
    const stanzaId = nonEmptyString(contextInfo['stanzaId']);
    if (stanzaId === undefined) continue;
    const participant = nonEmptyString(contextInfo['participant']);
    const text = quotedText(contextInfo['quotedMessage']);
    return {
      externalMessageId: stanzaId,
      ...(participant !== undefined ? { senderId: participant } : {}),
      ...(text !== undefined ? { text } : {}),
    };
  }
  return undefined;
}

/**
 * The reaction an (unwrapped) inbound message carries, or undefined when it
 * is not a reaction. An empty `text` means the reaction was removed.
 */
export function extractReaction(
  content: Record<string, unknown> | undefined,
): InboundReaction | undefined {
  const reaction = content?.['reactionMessage'];
  if (!isRecord(reaction)) return undefined;
  const key = reaction['key'];
  const targetMessageId = isRecord(key) ? nonEmptyString(key['id']) : undefined;
  if (targetMessageId === undefined) return undefined;
  return {
    targetMessageId,
    emoji: typeof reaction['text'] === 'string' ? reaction['text'] : '',
  };
}

/** A WhatsApp message key, as Baileys expects it. */
export interface BaileysMessageKey {
  remoteJid: string;
  id: string;
  fromMe: boolean;
  participant?: string;
}

/**
 * Rebuilds the key of a stored message. In a group the author's JID is
 * required for someone else's message; for Talon's own messages `fromMe`
 * identifies the author and no participant is set.
 */
export function buildMessageKey(jid: string, target: MessageTarget): BaileysMessageKey {
  const fromMe = target.fromSelf === true;
  const isGroup = jid.endsWith('@g.us');
  return {
    remoteJid: jid,
    id: target.externalMessageId,
    fromMe,
    ...(isGroup && !fromMe && target.author !== undefined && target.author !== ''
      ? { participant: target.author }
      : {}),
  };
}

/**
 * Rebuilds a minimal quoted message for Baileys' `quoted` send option. The
 * quote preview shows the ledger excerpt; the key is what links the reply to
 * the original message.
 */
export function buildQuotedMessage(
  jid: string,
  target: MessageTarget,
): { key: BaileysMessageKey; message: { conversation: string } } {
  return {
    key: buildMessageKey(jid, target),
    message: { conversation: target.text ?? '' },
  };
}
