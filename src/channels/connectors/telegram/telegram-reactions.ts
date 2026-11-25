/**
 * Telegram reaction helpers.
 *
 * Bots can only set reactions from Telegram's fixed standard set (Bot API
 * `ReactionTypeEmoji`); anything else is rejected with `REACTION_INVALID`.
 * The list below is that set, copied from the Bot API reference. Checking it
 * here turns a provider error into a message the agent can act on.
 */

import type { TelegramReactionType } from './telegram-types.js';

/** Emoji a bot may set as a reaction (Bot API `ReactionTypeEmoji.emoji`). */
export const TELEGRAM_REACTION_EMOJI: readonly string[] = [
  '❤',
  '👍',
  '👎',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '🤬',
  '😢',
  '🎉',
  '🤩',
  '🤮',
  '💩',
  '🙏',
  '👌',
  '🕊',
  '🤡',
  '🥱',
  '🥴',
  '😍',
  '🐳',
  '❤‍🔥',
  '🌚',
  '🌭',
  '💯',
  '🤣',
  '⚡',
  '🍌',
  '🏆',
  '💔',
  '🤨',
  '😐',
  '🍓',
  '🍾',
  '💋',
  '🖕',
  '😈',
  '😴',
  '😭',
  '🤓',
  '👻',
  '👨‍💻',
  '👀',
  '🎃',
  '🙈',
  '😇',
  '😨',
  '🤝',
  '✍',
  '🤗',
  '🫡',
  '🎅',
  '🎄',
  '☃',
  '💅',
  '🤪',
  '🗿',
  '🆒',
  '💘',
  '🙉',
  '🦄',
  '😘',
  '💊',
  '🙊',
  '😎',
  '👾',
  '🤷‍♂',
  '🤷',
  '🤷‍♀',
  '😡',
];

const ALLOWED = new Set(TELEGRAM_REACTION_EMOJI);

/** Variation selector-16 and the five skin-tone modifiers. */
const PRESENTATION_AND_SKIN_TONE = /\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]/gu;

/**
 * Maps an emoji to the form Telegram accepts, or null when it is not in the
 * allowed set. Telegram lists its reactions without the emoji presentation
 * selector and without skin tones, so "❤️" and "👍🏽" normalise to "❤" and "👍".
 */
export function normalizeTelegramReactionEmoji(emoji: string): string | null {
  const trimmed = emoji.trim();
  if (ALLOWED.has(trimmed)) return trimmed;
  const stripped = trimmed.replace(PRESENTATION_AND_SKIN_TONE, '');
  return ALLOWED.has(stripped) ? stripped : null;
}

/**
 * Standard emoji present in `newReaction` but not in `oldReaction` — what the
 * user just added. Custom-emoji and paid reactions carry no portable emoji
 * and are skipped; a pure removal yields an empty list.
 */
export function addedReactionEmoji(
  oldReaction: readonly TelegramReactionType[] | undefined,
  newReaction: readonly TelegramReactionType[] | undefined,
): string[] {
  const emojiOf = (reaction: TelegramReactionType): string | undefined =>
    reaction.type === 'emoji' && typeof reaction.emoji === 'string' && reaction.emoji !== ''
      ? reaction.emoji
      : undefined;
  const before = new Set((oldReaction ?? []).map(emojiOf));
  const added: string[] = [];
  for (const reaction of newReaction ?? []) {
    const emoji = emojiOf(reaction);
    if (emoji !== undefined && !before.has(emoji) && !added.includes(emoji)) {
      added.push(emoji);
    }
  }
  return added;
}
