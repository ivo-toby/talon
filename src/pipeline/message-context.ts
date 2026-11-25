/**
 * Renders native reply and reaction context into message text.
 *
 * The main agent only ever sees text, so a reply's target and a reaction are
 * expressed as one bracketed header line in the durable message content. That
 * keeps every provider, resumed sessions, fresh-session history and summaries
 * on the same representation without a provider-specific channel. The header
 * carries the provider message ID so the agent can address that message with
 * `channel_react` or `channel_send`'s `replyTo`.
 *
 * Pure functions: no I/O, no ledger access.
 */

import { NO_REPLY_SENTINEL } from '../channels/no-reply.js';

/** Maximum quoted excerpt length inside a context header, in string units. */
export const MESSAGE_CONTEXT_EXCERPT_MAX_CHARS = 280;

/** A reply or reaction target after ledger resolution. */
export interface ResolvedMessageReference {
  /** Provider message ID of the target. */
  externalMessageId: string;
  /** True when Talon sent the target; false when someone else did; undefined when unknown. */
  fromSelf?: boolean;
  /** Channel-specific identity of the target's author, when known. */
  senderId?: string;
  /** Text of the target, when known. */
  text?: string;
}

/**
 * Collapses whitespace and bounds a quoted excerpt. Returns '' for absent or
 * blank text.
 */
export function excerptForContext(
  text: string | undefined,
  maxChars: number = MESSAGE_CONTEXT_EXCERPT_MAX_CHARS,
): string {
  if (text === undefined) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** `: "<excerpt>"` when there is text to quote, otherwise ''. */
function quotedSuffix(text: string | undefined): string {
  const excerpt = excerptForContext(text);
  // JSON quoting keeps embedded quotes and brackets unambiguous.
  return excerpt === '' ? '' : `: ${JSON.stringify(excerpt)}`;
}

/** Describes whose message a target is, relative to the current sender. */
function describeTarget(target: ResolvedMessageReference, currentSenderId: string): string {
  if (target.fromSelf === true) return 'your message';
  if (target.senderId !== undefined && target.senderId !== '') {
    return target.senderId === currentSenderId
      ? 'their own earlier message'
      : `a message from ${target.senderId}`;
  }
  return 'an earlier message';
}

/**
 * Header line for a message that natively replies to another message, e.g.
 * `[Replying to your message (id 4521): "Shall I book the 14:00 slot?"]`.
 */
export function renderReplyHeader(
  target: ResolvedMessageReference,
  currentSenderId: string,
): string {
  return (
    `[Replying to ${describeTarget(target, currentSenderId)} ` +
    `(id ${target.externalMessageId})${quotedSuffix(target.text)}]`
  );
}

/** Prefixes `content` with a reply header; a header alone when content is empty. */
export function prependReplyHeader(header: string, content: string): string {
  return content === '' ? header : `${header}\n${content}`;
}

/**
 * Full message content for an emoji reaction on one of Talon's messages. The
 * trailing line tells the agent how to stay silent: a reaction often needs no
 * answer, and without the directive every reaction would produce a reply.
 */
export function renderReactionContent(emoji: string, target: ResolvedMessageReference): string {
  return (
    `[Reaction: the user reacted with ${emoji} to your message ` +
    `(id ${target.externalMessageId})${quotedSuffix(target.text)}]\n` +
    `(Treat it as feedback, or as an answer if your message asked something. ` +
    `If no reply is needed, respond with exactly ${NO_REPLY_SENTINEL}.)`
  );
}
