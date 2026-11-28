/**
 * WhatsApp Web (Baileys) group addressing.
 *
 * Decides whether a group message addresses Talon, mirroring the Telegram
 * connector: a native @mention of Talon's account, a leading trigger word, or
 * a quoted reply to a message from Talon's account. With `requireMention`
 * false every group message addresses Talon.
 *
 * Pure functions only — no Baileys objects, no I/O.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bare identifier of a JID: the part before `@`, without a `:device` suffix.
 * `31612345678:5@s.whatsapp.net` and `96490886312027@lid` become
 * `31612345678` and `96490886312027`.
 */
export function bareJid(jid: string): string {
  return jid.replace(/@.*$/, '').replace(/:\d+$/, '');
}

/**
 * JIDs @mentioned in an (unwrapped) inbound message. WhatsApp carries them in
 * `contextInfo.mentionedJid` of whichever content part the message has
 * (`extendedTextMessage`, `imageMessage`, ...).
 */
export function extractMentionedJids(content: Record<string, unknown> | undefined): string[] {
  if (content === undefined) return [];
  for (const part of Object.values(content)) {
    if (!isRecord(part)) continue;
    const contextInfo = part['contextInfo'];
    if (!isRecord(contextInfo)) continue;
    const mentioned = contextInfo['mentionedJid'];
    if (Array.isArray(mentioned)) {
      return mentioned.filter((j): j is string => typeof j === 'string' && j !== '');
    }
  }
  return [];
}

export interface GroupAddressingInput {
  /** Message text or media caption. */
  text: string;
  /** JIDs the message @mentions (see {@link extractMentionedJids}). */
  mentionedJids: readonly string[];
  /** Author JID of the quoted message, when the message is a quoted reply. */
  quotedSenderId?: string;
  /** Bare IDs of Talon's own account: phone number and LID. */
  selfIds: ReadonlySet<string>;
  /** Configured trigger words (case-insensitive prefixes). */
  triggerWords: readonly string[];
  /** Whether a group message must address Talon. */
  requireMention: boolean;
}

/**
 * The content to hand to the agent when a group message addresses Talon, or
 * null when it does not. The content may be the empty string when the
 * mention or trigger word was the whole text (an image may still proceed).
 *
 * Checked in Telegram's order: an @mention of Talon's account (its `@<id>`
 * token is stripped), a leading trigger word (stripped), a quoted reply to a
 * message from Talon's account, then `requireMention: false`.
 */
export function resolveGroupContent(input: GroupAddressingInput): string | null {
  const { text, selfIds } = input;

  const mentionsSelf = input.mentionedJids.some((jid) => selfIds.has(bareJid(jid)));
  if (mentionsSelf) {
    let stripped = text;
    for (const id of selfIds) {
      // WhatsApp renders a mention as "@<id>" in the text; the id is digits,
      // so a following digit means a different (longer) id.
      stripped = stripped.replace(new RegExp(`@${escapeRegExp(id)}(?!\\d)`, 'g'), '');
    }
    return stripped.replace(/[ \t]{2,}/g, ' ').trim();
  }

  const lower = text.toLowerCase();
  const matched = input.triggerWords.find((tw) => tw !== '' && lower.startsWith(tw.toLowerCase()));
  if (matched !== undefined) {
    return text.slice(matched.length).trimStart();
  }

  if (input.quotedSenderId !== undefined && selfIds.has(bareJid(input.quotedSenderId))) {
    return text;
  }

  if (!input.requireMention) {
    return text;
  }

  return null;
}
