/**
 * Telegram channel connector — public API.
 *
 * Implements the Channel interface for Telegram via the Bot API.
 * Handles long polling, message normalisation, and send with
 * Markdown-to-MarkdownV2 conversion.
 */

export { TelegramConnector } from './telegram-connector.js';
export type { TelegramConnectorOptions } from './telegram-connector.js';
export { telegramEscape, markdownToTelegram } from './telegram-format.js';
export {
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  DEFAULT_TELEGRAM_IMAGE_SETTINGS,
  planTelegramMedia,
  planHasImageSlots,
  fetchTelegramMedia,
  photoPayloadMimeType,
} from './telegram-media.js';
export type {
  TelegramMediaPlan,
  TelegramMediaDeps,
  OpenedTelegramFile,
  MediaItem,
  MediaPlan,
  PhotoPlan,
  DocumentPlan,
} from './telegram-media.js';
export type {
  TelegramConfig,
  TelegramUpdate,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramPhotoSize,
  TelegramDocument,
  TelegramSticker,
  TelegramFile,
  TelegramFileResult,
  TelegramUser,
  TelegramChat,
  TelegramSendResult,
  TelegramUpdatesResult,
} from './telegram-types.js';
