/**
 * Repository for the `message_refs` table — the message ledger behind native
 * replies and reactions.
 *
 * A ref maps a provider-side message identifier to the Talon thread it lives
 * in. Inbound refs are written by the message pipeline, outbound refs by the
 * agent runner and `channel.send` from the connector's send receipt. Refs are
 * metadata: every write is INSERT OR IGNORE, so a redelivered message or a
 * repeated send can never overwrite the first record.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Maximum stored excerpt length, in JavaScript string units. */
export const MESSAGE_REF_EXCERPT_MAX_CHARS = 1_000;

/** Row shape matching the `message_refs` table exactly. */
export interface MessageRefRow {
  thread_id: string;
  external_id: string;
  direction: 'inbound' | 'outbound';
  /** `messages.id` of the stored message, or null when there is none. */
  message_id: string | null;
  /** Channel-specific author identity; null for Talon's own messages. */
  sender_id: string | null;
  excerpt: string;
  created_at: number;
}

/** Fields accepted when recording a ref. `created_at` is set automatically. */
export interface RecordMessageRefInput {
  thread_id: string;
  external_id: string;
  direction: 'inbound' | 'outbound';
  message_id?: string | null;
  sender_id?: string | null;
  /** Full or partial message text; truncated to the excerpt bound here. */
  text?: string;
}

/** Repository for reading and writing message ledger refs. */
export class MessageRefRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findStmt: Database.Statement;
  private readonly findInChatStmt: Database.Statement;
  private readonly findInboundByMessageIdStmt: Database.Statement;
  private readonly findTriggerForRunStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO message_refs
        (thread_id, external_id, direction, message_id, sender_id, excerpt, created_at)
      VALUES
        (@thread_id, @external_id, @direction, @message_id, @sender_id, @excerpt, @created_at)
    `);

    this.findStmt = db.prepare(`
      SELECT * FROM message_refs WHERE thread_id = ? AND external_id = ?
    `);

    // A chat can back several Talon threads: Telegram forum topics are keyed
    // `<chat_id>:<topic_id>`. Reactions arrive with the chat only, so the
    // target is searched across the chat's own thread and its topic threads.
    // The prefix is compared with substr() rather than LIKE so chat IDs never
    // need wildcard escaping.
    this.findInChatStmt = db.prepare(`
      SELECT r.* FROM message_refs r
      JOIN threads t ON t.id = r.thread_id
      WHERE t.channel_id = @channel_id
        AND r.external_id = @external_id
        AND (
          t.external_id = @chat_id
          OR substr(t.external_id, 1, length(@chat_id) + 1) = @chat_id || ':'
        )
      ORDER BY r.created_at DESC
      LIMIT 1
    `);

    this.findInboundByMessageIdStmt = db.prepare(`
      SELECT * FROM message_refs
      WHERE message_id = ? AND direction = 'inbound'
      ORDER BY created_at ASC
      LIMIT 1
    `);

    // The message a run answers: run -> its queue item -> the item's message
    // -> that message's inbound ref. Null for runs not started by a channel
    // message with a provider ID (reactions, schedules, collaboration items).
    this.findTriggerForRunStmt = db.prepare(`
      SELECT r.* FROM message_refs r
      JOIN queue_items q ON q.message_id = r.message_id
      JOIN runs ru ON ru.queue_item_id = q.id
      WHERE ru.id = ? AND r.direction = 'inbound'
      ORDER BY r.created_at ASC
      LIMIT 1
    `);
  }

  /**
   * Records a ref. A ref that already exists for `(thread_id, external_id)`
   * is left untouched.
   */
  record(input: RecordMessageRefInput): Result<void, DbError> {
    try {
      this.insertStmt.run({
        thread_id: input.thread_id,
        external_id: input.external_id,
        direction: input.direction,
        message_id: input.message_id ?? null,
        sender_id: input.sender_id ?? null,
        excerpt: (input.text ?? '').slice(0, MESSAGE_REF_EXCERPT_MAX_CHARS),
        created_at: this.now(),
      });
      return ok(undefined);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to record message ref: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Finds a ref by its provider message ID inside one thread. */
  find(threadId: string, externalId: string): Result<MessageRefRow | null, DbError> {
    try {
      const row = this.findStmt.get(threadId, externalId) as MessageRefRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find message ref: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Finds a ref by provider message ID across every thread of one chat on a
   * channel: the thread whose external ID equals `chatExternalId` plus any
   * `<chatExternalId>:<suffix>` sub-thread.
   */
  findInChat(
    channelId: string,
    chatExternalId: string,
    externalId: string,
  ): Result<MessageRefRow | null, DbError> {
    try {
      const row = this.findInChatStmt.get({
        channel_id: channelId,
        chat_id: chatExternalId,
        external_id: externalId,
      }) as MessageRefRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find message ref in chat: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Finds the inbound ref recorded for a stored message. */
  findInboundByMessageId(messageId: string): Result<MessageRefRow | null, DbError> {
    try {
      const row = this.findInboundByMessageIdStmt.get(messageId) as MessageRefRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find message ref by message id: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /** Finds the inbound ref of the channel message that started a run. */
  findTriggerForRun(runId: string): Result<MessageRefRow | null, DbError> {
    try {
      const row = this.findTriggerForRunStmt.get(runId) as MessageRefRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(
        new DbError(
          `Failed to find trigger message ref for run: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}
