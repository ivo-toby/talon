/**
 * Repository for the admission side of the image ledger: recovery source references
 * (`image_source_messages`), per-message Ingestion (`image_ingestions`), and terminal
 * admission records (`image_admission_records`).
 *
 * Ingestion is per owning Message and is the record of whether that message still
 * needs queue admission:
 *   * `pending` — Images exist, the message has not been enqueued yet;
 *   * `completed` — the message was enqueued, durably. Purging or deleting the queue
 *     item never reopens it, because completion lives here and is never inferred from
 *     `queue_items`. `queue_item_id` is traceability only and has no foreign key, so
 *     queue retention cannot cascade the completion away.
 *
 * Pending queries are ordered and bounded and read no Message or queue tables, so a
 * Messages history cutoff, a purged queue item, or a redelivery cannot hide work that
 * still needs admission. `UNIQUE (message_id)` is the "one owner per message"
 * guarantee: repeated recovery adopts the existing row instead of admitting twice.
 *
 * A Message that is intentionally not routed gets a terminal admission record and no
 * Images or Ingestion. Text-only Messages get neither.
 *
 * Source references and admission records are internal recovery data: they are never
 * projected onto a public Image descriptor. Every stored column holds bounded ledger
 * text or numbers — no pixels, no download credentials.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

/** Default bound for one pending-Ingestion recovery query. */
export const DEFAULT_PENDING_INGESTION_LIMIT = 100;

/** Ingestion lifecycle. `completed` is final and cannot be reopened. */
export type ImageIngestionStatus = 'pending' | 'completed';

/** Row shape matching the `image_ingestions` table exactly. */
export interface ImageIngestionRow {
  id: string;
  message_id: string;
  thread_id: string;
  status: ImageIngestionStatus;
  /** Traceability only; the referenced queue item may already have been purged. */
  queue_item_id: string | null;
  /**
   * The admitted route: persona selected at Admission, persisted in the same
   * transaction as the pending row. Completion (fresh, redelivery, or
   * recovery) enqueues under this route — never under a re-resolved current
   * binding, which could reroute or strand pending work.
   */
  persona_id: string | null;
  admitted_at: number;
  completed_at: number | null;
}

/** Row shape matching the `image_source_messages` table exactly. */
export interface ImageSourceMessageRow {
  id: string;
  channel: string;
  external_message_id: string;
  external_chat_id: string;
  created_at: number;
}

/**
 * Why an image-bearing Message was admitted without routing. Closed vocabulary:
 * each value names the decision that produced the terminal outcome.
 */
export type ImageAdmissionReason =
  | 'no_binding'
  | 'channel_unsupported'
  | 'policy_denied'
  | 'images_disallowed';

/** Row shape matching the `image_admission_records` table exactly. */
export interface ImageAdmissionRecordRow {
  message_id: string;
  thread_id: string;
  channel: string;
  reason: ImageAdmissionReason;
  created_at: number;
}

/** Identity of one image-bearing inbound message, as trusted by the pipeline. */
export interface ResolveSourceMessageInput {
  /** Existing reference id, when the caller already recovered one. */
  id?: string;
  channel: string;
  externalMessageId: string;
  externalChatId: string;
}

/** Outcome of opening Ingestion for a Message. */
export interface CreateIngestionResult {
  ingestion: ImageIngestionRow;
  /** False when an existing row was adopted, leaving it untouched. */
  created: boolean;
}

/** Outcome of completing Ingestion for a Message. */
export interface CompleteIngestionResult {
  ingestion: ImageIngestionRow;
  /**
   * True when Ingestion was already completed. The stored queue item id is then
   * preserved, so recovery learns which item was already admitted instead of
   * creating a second one.
   */
  alreadyCompleted: boolean;
}

/** Scope and bound for a pending-Ingestion query. */
export interface FindPendingIngestionInput {
  threadId?: string;
  messageId?: string;
  limit?: number;
}

/** Fields accepted when recording a terminal admission outcome. */
export interface InsertTerminalAdmissionInput {
  messageId: string;
  threadId: string;
  channel: string;
  reason: ImageAdmissionReason;
}

interface MessageOwnerRow {
  thread_id: string;
  direction: 'inbound' | 'outbound';
}

/** Repository for pending Ingestion, source references, and admission records. */
export class ImageIngestionRepository extends BaseRepository {
  private readonly insertSourceStmt: Database.Statement;
  private readonly findSourceByExternalStmt: Database.Statement;
  private readonly findSourceByIdStmt: Database.Statement;
  private readonly insertIngestionStmt: Database.Statement;
  private readonly completeIngestionStmt: Database.Statement;
  private readonly findByMessageStmt: Database.Statement;
  private readonly isCompleteStmt: Database.Statement;
  private readonly findPendingStmt: Database.Statement;
  private readonly insertAdmissionStmt: Database.Statement;
  private readonly findAdmissionStmt: Database.Statement;
  private readonly messageOwnerStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.insertSourceStmt = db.prepare(`
      INSERT INTO image_source_messages
        (id, channel, external_message_id, external_chat_id, created_at)
      VALUES
        (@id, @channel, @external_message_id, @external_chat_id, @created_at)
    `);

    this.findSourceByExternalStmt = db.prepare(`
      SELECT * FROM image_source_messages
      WHERE channel = @channel AND external_message_id = @external_message_id
        AND external_chat_id = @external_chat_id
    `);

    this.findSourceByIdStmt = db.prepare(`
      SELECT * FROM image_source_messages WHERE id = ?
    `);

    this.insertIngestionStmt = db.prepare(`
      INSERT INTO image_ingestions (id, message_id, thread_id, status, queue_item_id, persona_id, admitted_at, completed_at)
      VALUES (@id, @message_id, @thread_id, 'pending', NULL, @persona_id, @admitted_at, NULL)
    `);

    // Completion is written once. The `status = 'pending'` guard means a concurrent
    // or repeated recovery can never move a completed row back or re-stamp it.
    this.completeIngestionStmt = db.prepare(`
      UPDATE image_ingestions
      SET status = 'completed', queue_item_id = @queue_item_id, completed_at = @completed_at
      WHERE message_id = @message_id
        AND status = 'pending'
    `);

    this.findByMessageStmt = db.prepare(`
      SELECT * FROM image_ingestions WHERE message_id = ?
    `);

    this.isCompleteStmt = db.prepare(`
      SELECT 1 AS hit FROM image_ingestions WHERE message_id = ? AND status = 'completed'
    `);

    // Recovery reads the ledger only — never queue_items, never messages — so a
    // purged queue item or a history cutoff cannot conceal pending work.
    this.findPendingStmt = db.prepare(`
      SELECT * FROM image_ingestions
      WHERE status = 'pending'
        AND (@thread_id IS NULL OR thread_id = @thread_id)
        AND (@message_id IS NULL OR message_id = @message_id)
      ORDER BY admitted_at ASC, message_id ASC
      LIMIT @limit
    `);

    this.insertAdmissionStmt = db.prepare(`
      INSERT INTO image_admission_records (message_id, thread_id, channel, reason, created_at)
      VALUES (@message_id, @thread_id, @channel, @reason, @created_at)
    `);

    this.findAdmissionStmt = db.prepare(`
      SELECT * FROM image_admission_records WHERE message_id = ?
    `);

    this.messageOwnerStmt = db.prepare(`
      SELECT thread_id, direction FROM messages WHERE id = ?
    `);
  }

  /**
   * Gets or creates the internal recovery source reference for one image-bearing
   * inbound message.
   *
   * An existing reference for the same trusted channel, external message id, and
   * external chat id is reused, so restart or redelivery re-links the Images it
   * already owns instead of creating a second ledger lineage.
   */
  resolveSourceMessage(input: ResolveSourceMessageInput): Result<ImageSourceMessageRow, DbError> {
    try {
      const existing = this.findSourceByExternalStmt.get({
        channel: input.channel,
        external_message_id: input.externalMessageId,
        external_chat_id: input.externalChatId,
      }) as ImageSourceMessageRow | undefined;
      if (existing) {
        return ok(existing);
      }

      const row: ImageSourceMessageRow = {
        id: input.id ?? randomUUID(),
        channel: input.channel,
        external_message_id: input.externalMessageId,
        external_chat_id: input.externalChatId,
        created_at: this.now(),
      };
      this.insertSourceStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(this.fail('resolve source message', cause));
    }
  }

  /** Returns a recovery source reference by id, or null. */
  findSourceMessage(sourceRef: string): Result<ImageSourceMessageRow | null, DbError> {
    try {
      const row = this.findSourceByIdStmt.get(sourceRef) as ImageSourceMessageRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.fail('find source message', cause));
    }
  }

  /**
   * Opens pending Ingestion for a Message whose Images were just admitted.
   *
   * Idempotent under recovery: when a row already exists it is returned untouched —
   * `admitted_at`, status, and any recorded queue item id keep their original
   * values — so recovery cannot reset the admission clock or duplicate ownership.
   *
   * The write is validated against the owning Message first: the Message must exist,
   * be inbound, and belong to the supplied thread. A cross-owner admission is
   * rejected rather than trusted, and nothing is written.
   *
   * `personaId` is the admitted route and is stored with the pending row so
   * completion and recovery never have to re-resolve (or guess) it later.
   */
  createPending(input: {
    messageId: string;
    threadId: string;
    personaId: string;
  }): Result<CreateIngestionResult, DbError> {
    const owner = this.readMessageOwner(input.messageId);
    if (owner.isErr()) {
      return err(owner.error);
    }
    const rejection = this.checkOwner(owner.value, input.messageId, input.threadId, 'open ingestion');
    if (rejection) {
      return err(rejection);
    }

    try {
      const existing = this.readByMessage(input.messageId);
      if (existing.isErr()) {
        return err(existing.error);
      }
      if (existing.value) {
        return ok({ ingestion: existing.value, created: false });
      }

      const row: ImageIngestionRow = {
        id: randomUUID(),
        message_id: input.messageId,
        thread_id: input.threadId,
        status: 'pending',
        queue_item_id: null,
        persona_id: input.personaId,
        admitted_at: this.now(),
        completed_at: null,
      };
      this.insertIngestionStmt.run(row);
      return ok({ ingestion: row, created: true });
    } catch (cause) {
      return err(this.fail('create pending ingestion', cause));
    }
  }

  /**
   * Marks Ingestion completed together with the queue item the Message was admitted
   * as. Designed to run inside the coordinator's enqueue transaction.
   *
   * Completion is final and survives deletion of that queue item. A repeated call
   * reports `alreadyCompleted` and keeps the originally recorded queue item id, which
   * is what lets recovery skip the enqueue instead of issuing a second one.
   */
  markComplete(input: {
    messageId: string;
    queueItemId: string;
    completedAt?: number;
  }): Result<CompleteIngestionResult, DbError> {
    if (input.queueItemId === '') {
      return err(new DbError('Cannot complete ingestion: a queue item id is required'));
    }

    const existing = this.readByMessage(input.messageId);
    if (existing.isErr()) {
      return err(existing.error);
    }
    if (existing.value === null) {
      return err(
        new DbError(`Cannot complete ingestion: no ledger row for message ${input.messageId}`),
      );
    }
    if (existing.value.status === 'completed') {
      return ok({ ingestion: existing.value, alreadyCompleted: true });
    }

    try {
      const info = this.completeIngestionStmt.run({
        message_id: input.messageId,
        queue_item_id: input.queueItemId,
        completed_at: input.completedAt ?? this.now(),
      });
      if (info.changes === 0) {
        // Someone else completed it between the read and the write; adopt their row.
        const raced = this.readByMessage(input.messageId);
        if (raced.isErr()) {
          return err(raced.error);
        }
        if (raced.value === null) {
          return err(
            new DbError(`Cannot complete ingestion: ledger row for ${input.messageId} vanished`),
          );
        }
        return ok({ ingestion: raced.value, alreadyCompleted: raced.value.status === 'completed' });
      }
      const updated = this.readByMessage(input.messageId);
      if (updated.isErr()) {
        return err(updated.error);
      }
      if (updated.value === null) {
        return err(
          new DbError(`Cannot complete ingestion: ledger row for ${input.messageId} vanished`),
        );
      }
      return ok({ ingestion: updated.value, alreadyCompleted: false });
    } catch (cause) {
      return err(this.fail('complete ingestion', cause));
    }
  }

  /** Returns the Ingestion row of one Message, or null. */
  findByMessage(messageId: string): Result<ImageIngestionRow | null, DbError> {
    return this.readByMessage(messageId);
  }

  /**
   * True when a Message's Ingestion is already completed.
   *
   * This is the recovery question "may I enqueue?" and it is answered from the ledger
   * alone: a deleted queue item keeps the answer true.
   */
  isComplete(messageId: string): Result<boolean, DbError> {
    try {
      const row = this.isCompleteStmt.get(messageId) as { hit: number } | undefined;
      return ok(row !== undefined);
    } catch (cause) {
      return err(this.fail('check ingestion completion', cause));
    }
  }

  /**
   * Returns Ingestion that still needs admission, oldest first.
   *
   * Both filters are optional. With a `threadId` and/or `messageId` the result is
   * scoped accordingly; with neither it is the bounded global sweep the startup and
   * periodic recovery passes need, because a restarting daemon does not yet know
   * which threads hold pending work. The query reads the ledger only, so a Messages
   * history cutoff never hides pending work, and it is always bounded by `limit`.
   * Completion is excluded, so a completed Message never re-enters recovery even
   * after its queue item is purged.
   *
   * `limit` must be a positive integer: SQLite treats a negative LIMIT as
   * unbounded, so an unchecked value would silently turn the sweep into a
   * full-table read. Invalid limits return an Err instead.
   */
  findPending(input: FindPendingIngestionInput = {}): Result<ImageIngestionRow[], DbError> {
    const limit = input.limit ?? DEFAULT_PENDING_INGESTION_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      return err(
        new DbError(
          `findPending requires a positive integer limit, got ${String(input.limit)}`,
        ),
      );
    }
    try {
      const rows = this.findPendingStmt.all({
        thread_id: input.threadId ?? null,
        message_id: input.messageId ?? null,
        limit,
      }) as ImageIngestionRow[];
      return ok(rows);
    } catch (cause) {
      return err(this.fail('find pending ingestion', cause));
    }
  }

  /**
   * Records that an image-bearing Message was admitted without routing.
   *
   * Exactly one record per Message: a second call is rejected rather than duplicated.
   * The record is terminal on write — it has no lifecycle — and the Message itself
   * stays readable in ordinary history. Text-only and routed Messages never get one,
   * which holds because nothing else in the ledger writes this table.
   */
  insertTerminalAdmission(
    input: InsertTerminalAdmissionInput,
  ): Result<ImageAdmissionRecordRow, DbError> {
    const owner = this.readMessageOwner(input.messageId);
    if (owner.isErr()) {
      return err(owner.error);
    }
    const rejection = this.checkOwner(
      owner.value,
      input.messageId,
      input.threadId,
      'record admission',
    );
    if (rejection) {
      return err(rejection);
    }

    const row: ImageAdmissionRecordRow = {
      message_id: input.messageId,
      thread_id: input.threadId,
      channel: input.channel,
      reason: input.reason,
      created_at: this.now(),
    };

    try {
      this.insertAdmissionStmt.run(row);
      return ok(row);
    } catch (cause) {
      return err(this.fail('record terminal admission', cause));
    }
  }

  /** Returns the terminal admission record of a Message, or null. */
  findAdmissionByMessage(messageId: string): Result<ImageAdmissionRecordRow | null, DbError> {
    try {
      const row = this.findAdmissionStmt.get(messageId) as
        | ImageAdmissionRecordRow
        | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.fail('find terminal admission', cause));
    }
  }

  private readByMessage(messageId: string): Result<ImageIngestionRow | null, DbError> {
    try {
      const row = this.findByMessageStmt.get(messageId) as ImageIngestionRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.fail('read ingestion by message', cause));
    }
  }

  private readMessageOwner(messageId: string): Result<MessageOwnerRow | null, DbError> {
    try {
      const row = this.messageOwnerStmt.get(messageId) as MessageOwnerRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.fail('read message owner', cause));
    }
  }

  /** Ownership rule shared by every message-scoped ledger write. */
  private checkOwner(
    owner: MessageOwnerRow | null,
    messageId: string,
    threadId: string,
    context: string,
  ): DbError | null {
    if (owner === null) {
      return new DbError(`Failed to ${context}: unknown message ${messageId}`);
    }
    if (owner.direction !== 'inbound') {
      return new DbError(
        `Failed to ${context}: message ${messageId} is ${owner.direction}, not inbound`,
      );
    }
    if (owner.thread_id !== threadId) {
      return new DbError(
        `Failed to ${context}: message ${messageId} belongs to thread ${owner.thread_id}, ` +
          `not ${threadId}`,
      );
    }
    return null;
  }

  private fail(context: string, cause: unknown): DbError {
    return new DbError(
      `Failed to ${context}: ${String(cause)}`,
      cause instanceof Error ? cause : undefined,
    );
  }
}
