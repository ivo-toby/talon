/**
 * The "no reply" directive.
 *
 * An agent that has nothing to say — it acknowledged a message with an emoji
 * reaction, or a user's reaction needs no answer — makes its whole response
 * this sentinel. The agent runner then delivers nothing to the channel
 * instead of posting the sentinel as a message.
 */

/** The exact text an agent returns to suppress its channel reply. */
export const NO_REPLY_SENTINEL = 'NO_REPLY';

/**
 * Matches an output that consists of nothing but the sentinel, tolerating the
 * decoration models tend to add around a bare token (whitespace, backticks,
 * emphasis markers, quotes, brackets, trailing punctuation).
 */
const NO_REPLY_PATTERN = /^[\s`*_"'[(<]*NO_REPLY[\s`*_"'\])>.!]*$/i;

/** True when `text` is only the no-reply sentinel. */
export function isNoReplyOutput(text: string): boolean {
  return NO_REPLY_PATTERN.test(text);
}
