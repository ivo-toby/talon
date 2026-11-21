/**
 * Signal reply and reaction contracts.
 *
 * Pure mapping between Talon's channel-agnostic reply/reaction types
 * (`MessageTarget`, `SendReceipt`) and the signal-cli JSON-RPC parameters that
 * address an existing message. No I/O and no connector wiring: this is the
 * outbound half of the contract, for the connector tasks to consume.
 *
 * Signal has no message ID. A message is identified by its author plus its
 * sent timestamp, so Talon's `externalMessageId` for Signal is the timestamp
 * in canonical decimal form and `MessageTarget.author` is the author's ACI.
 *
 * Every wire name below is pinned to signal-cli v0.14.9, commit
 * 3997429779095ff3a2d64c877126e84fce9852aa (`R/` = the epic's
 * `research/signal-cli-v0.14.9/`):
 *
 * - JSON-RPC parameter names are the camelCase form of the CLI flags
 *   (`R/man/signal-cli-jsonrpc.5.adoc:95`).
 * - `send` quotes with `--quote-timestamp`, `--quote-author`, `--quote-message`;
 *   the author is mandatory once a timestamp is given and an absent message
 *   becomes the empty string
 *   (`R/src/main/java/org/asamk/signal/commands/SendCommand.java:82-86,204-225`).
 * - `sendReaction` takes `--emoji` ("a single unicode grapheme cluster"),
 *   `--target-author`, `--target-timestamp` and `--remove`
 *   (`R/man/signal-cli.1.adoc:615-644`).
 * - A send result reports the sent message's `timestamp`
 *   (`R/src/main/java/org/asamk/signal/util/SendMessageResultUtils.java:38,55`),
 *   and an inbound data message carries its own `timestamp`
 *   (`R/src/main/java/org/asamk/signal/json/JsonDataMessage.java:14`).
 *
 * NOT covered, deliberately: parsing an inbound `dataMessage.reaction` or
 * `dataMessage.quote`, and removing a reaction. `JsonDataMessage.java:23-24`
 * shows both inbound objects exist, but `JsonReaction.java`, `JsonQuote.java`
 * and `SendReactionCommand.java` are not part of the pinned snapshot, so their
 * field names and the `--remove` requirements cannot be cited. See
 * `research/replies-reactions-amendment.md`.
 */

import type { MessageTarget, SendReceipt } from '../../channel-types.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import { normalizeSignalUuid } from './signal-identities.js';

export type SignalMessageTargetReason =
  | 'INVALID_TIMESTAMP'
  | 'MISSING_AUTHOR'
  | 'INVALID_AUTHOR'
  | 'INVALID_EMOJI'
  | 'REMOVE_UNSUPPORTED';

export class SignalMessageTargetError extends ChannelError {
  constructor(readonly reason: SignalMessageTargetReason) {
    super(`Signal message target rejected: ${reason}`);
  }
}

/** A Signal message address: who sent it, and when. */
export interface SignalMessageAddress {
  readonly authorUuid: string;
  readonly timestamp: number;
}

/** `send` parameters that turn a message into a quote of another one. */
export interface SignalQuoteParams {
  readonly quoteTimestamp: number;
  readonly quoteAuthor: string;
  readonly quoteMessage: string;
}

/** `sendReaction` parameters that identify the reaction and its target. */
export interface SignalReactionParams {
  readonly emoji: string;
  readonly targetAuthor: string;
  readonly targetTimestamp: number;
  readonly remove: false;
}

const rejected = (reason: SignalMessageTargetReason): Result<never, SignalMessageTargetError> =>
  err(new SignalMessageTargetError(reason));

/** Talon's external message ID for a Signal message: its timestamp, in decimal. */
export function signalMessageIdFromTimestamp(
  timestamp: unknown,
): Result<string, SignalMessageTargetError> {
  return typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0
    ? ok(String(timestamp))
    : rejected('INVALID_TIMESTAMP');
}

/** Parses an external message ID back to a timestamp; only the canonical form is accepted. */
export function parseSignalMessageId(value: unknown): Result<number, SignalMessageTargetError> {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return rejected('INVALID_TIMESTAMP');
  }
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? ok(timestamp) : rejected('INVALID_TIMESTAMP');
}

/** The send receipt for a signal-cli send result timestamp. */
export function signalSendReceipt(
  timestamp: unknown,
): Result<SendReceipt, SignalMessageTargetError> {
  return signalMessageIdFromTimestamp(timestamp).map((externalMessageId) => ({
    externalMessageId,
  }));
}

/**
 * Resolves a message target to its Signal address. A message Talon sent is
 * authored by the bridge account; anyone else's needs the author's ACI from
 * the message ledger.
 */
export function resolveSignalMessageAddress(
  target: MessageTarget,
  accountUuid: string,
): Result<SignalMessageAddress, SignalMessageTargetError> {
  const timestamp = parseSignalMessageId(target.externalMessageId);
  if (timestamp.isErr()) return rejected('INVALID_TIMESTAMP');

  if (target.fromSelf !== true && (target.author === undefined || target.author === '')) {
    return rejected('MISSING_AUTHOR');
  }
  const author = normalizeSignalUuid(target.fromSelf === true ? accountUuid : target.author);
  return author.isOk()
    ? ok({ authorUuid: author.value, timestamp: timestamp.value })
    : rejected('INVALID_AUTHOR');
}

/** `send` quote parameters for a reply target. */
export function buildSignalQuoteParams(
  target: MessageTarget,
  accountUuid: string,
): Result<SignalQuoteParams, SignalMessageTargetError> {
  return resolveSignalMessageAddress(target, accountUuid).map((address) => ({
    quoteTimestamp: address.timestamp,
    quoteAuthor: address.authorUuid,
    quoteMessage: target.text ?? '',
  }));
}

/** True when `value` is exactly one user-perceived character. */
function isSingleGrapheme(value: string): boolean {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(value)].length === 1;
}

/**
 * `sendReaction` parameters for placing a reaction. An empty emoji is Talon's
 * "remove my reaction", which is refused until the removal contract is pinned.
 */
export function buildSignalReactionParams(
  target: MessageTarget,
  emoji: string,
  accountUuid: string,
): Result<SignalReactionParams, SignalMessageTargetError> {
  if (emoji === '') return rejected('REMOVE_UNSUPPORTED');
  if (!isSingleGrapheme(emoji)) return rejected('INVALID_EMOJI');
  return resolveSignalMessageAddress(target, accountUuid).map((address) => ({
    emoji,
    targetAuthor: address.authorUuid,
    targetTimestamp: address.timestamp,
    remove: false as const,
  }));
}
