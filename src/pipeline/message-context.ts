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

/** Where a cross-thread outbound came from, as far as the ledger can tell. */
export type OutboundNoticeSource = 'schedule' | 'other_conversation' | 'background_task';

/** One outbound message the resumed session has not seen yet. */
export interface OutboundNotice {
  /** Full stored body of the message. */
  body: string;
  /** Local `YYYY-MM-DD HH:MM` the message was stored. */
  sentAt: string;
  source: OutboundNoticeSource;
  /** Provider message ID, when the ledger recorded one. */
  externalMessageId?: string;
}

const OUTBOUND_SOURCE_LABEL: Record<OutboundNoticeSource, string> = {
  schedule: 'from a scheduled task',
  other_conversation: 'from another conversation',
  background_task: 'from a background task',
};

/**
 * Header line for an outbound message sent to this conversation outside its
 * own turns, e.g.
 * `[You sent this message to this chat at 2026-11-28 08:00, from a scheduled task (id 4521)]`.
 */
export function renderOutboundNoticeHeader(notice: OutboundNotice): string {
  const id =
    notice.externalMessageId !== undefined && notice.externalMessageId !== ''
      ? ` (id ${notice.externalMessageId})`
      : '';
  return (
    `[You sent this message to this chat at ${notice.sentAt}, ` +
    `${OUTBOUND_SOURCE_LABEL[notice.source]}${id}]`
  );
}

/** Header line followed by the message body. */
export function renderOutboundNotice(notice: OutboundNotice): string {
  return notice.body === ''
    ? renderOutboundNoticeHeader(notice)
    : `${renderOutboundNoticeHeader(notice)}\n${notice.body}`;
}

/** Line stating how many older outbound notices did not fit. */
export function renderOmittedOutboundLine(omitted: number): string {
  return omitted === 1
    ? '[1 earlier message you sent to this chat is omitted]'
    : `[${omitted} earlier messages you sent to this chat are omitted]`;
}

/** Line separating the outbound notices from the message being answered. */
export const OUTBOUND_NOTICES_END_LINE = '[New message in this chat]';

/**
 * Prefixes `content` with rendered outbound notices (chronological, already
 * budgeted) and an optional omitted-count line. Returns `content` unchanged
 * when there is nothing to show.
 */
export function prependOutboundNotices(
  rendered: string[],
  omitted: number,
  content: string,
): string {
  if (rendered.length === 0 && omitted === 0) return content;
  const parts = [
    ...(omitted > 0 ? [renderOmittedOutboundLine(omitted)] : []),
    ...rendered,
    OUTBOUND_NOTICES_END_LINE,
  ];
  const block = parts.join('\n\n');
  return content === '' ? block : `${block}\n${content}`;
}
