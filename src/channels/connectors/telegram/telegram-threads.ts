/**
 * Telegram thread addressing.
 *
 * A Talon thread on Telegram is normally one chat, keyed by its `chat_id`.
 * A message sent inside a topic (a forum supergroup topic, or a topic in a
 * private chat with the bot) belongs to its own Talon thread instead, keyed
 * `<chat_id>:<message_thread_id>`, so each topic keeps its own conversation,
 * session and memory, and answers are delivered back into that topic.
 */

import type { TelegramMessage } from './telegram-types.js';

/** A parsed Telegram thread address. */
export interface TelegramThreadAddress {
  /** The `chat_id` to pass to the Bot API. */
  chatId: string;
  /** The `message_thread_id` of the topic, when the thread is a topic. */
  topicId?: number;
}

/** `<chat_id>:<topic_id>` — a numeric chat ID or `@username`, then a numeric topic. */
const TOPIC_THREAD_PATTERN = /^(-?\d+|@[A-Za-z0-9_]+):(\d+)$/;

/** Splits a Talon external thread ID into its chat and optional topic. */
export function parseTelegramThreadId(externalThreadId: string): TelegramThreadAddress {
  const match = TOPIC_THREAD_PATTERN.exec(externalThreadId);
  if (match === null) {
    return { chatId: externalThreadId };
  }
  return { chatId: match[1], topicId: Number(match[2]) };
}

/** The Talon external thread ID a message belongs to. */
export function telegramThreadIdForMessage(message: TelegramMessage): string {
  const chatId = String(message.chat.id);
  return message.is_topic_message === true && typeof message.message_thread_id === 'number'
    ? `${chatId}:${message.message_thread_id}`
    : chatId;
}

/** True for group and supergroup chat IDs, which Telegram assigns as negative numbers. */
export function isTelegramGroupChatId(chatId: string): boolean {
  return chatId.startsWith('-');
}
