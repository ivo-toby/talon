/**
 * Unit tests for ImageIngestionCoordinator.
 *
 * Uses a real migrated in-memory SQLite database, a real ImageStore over a
 * temp directory, and a real QueueManager, with only the normalizer (avoiding
 * native Sharp) and the clock injected. This keeps the durable-ledger,
 * transaction, and filesystem behavior under test while making deadlines,
 * attempts, and normalization outcomes deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { createTestDb } from '../queue/helpers.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { ImageRepository } from '../../../src/core/database/repositories/image-repository.js';
import { ImageIngestionRepository } from '../../../src/core/database/repositories/image-ingestion-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { DbError } from '../../../src/core/errors/index.js';
import { QueueManager } from '../../../src/queue/queue-manager.js';
import type { InboundAttachment } from '../../../src/channels/channel-types.js';
import type { ImagesConfig } from '../../../src/core/config/config-types.js';
import { ImageStore } from '../../../src/images/image-store.js';
import type {
  ImageNormalizationOptions,
  ImageNormalizationResult,
  ImageNormalizationError,
} from '../../../src/images/image-normalizer.js';
import type { ImageRejectionReason } from '../../../src/images/image-types.js';
import {
  ImageIngestionCoordinator,
  IMAGE_PROCESSING_DEADLINE_MS,
  MAX_ATTEMPTS_PER_IMAGE,
  type ImageIngestionRequest,
} from '../../../src/images/image-ingestion.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Fixture scaffolding
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const RETENTION_MS = 24 * 3_600_000;

type NormalizeFn = (
  source: Buffer,
  options: ImageNormalizationOptions,
) => Promise<Result<ImageNormalizationResult, ImageNormalizationError>>;

interface Fixture {
  db: Database.Database;
  store: ImageStore;
  tmpDir: string;
  imageRepo: ImageRepository;
  ingestionRepo: ImageIngestionRepository;
  messageRepo: MessageRepository;
  channelRepo: ChannelRepository;
  threadRepo: ThreadRepository;
  queueManager: QueueManager;
  config: ImagesConfig;
  now: number;
  normalizeCalls: Array<{ source: Buffer; tempFilePath: string }>;
  /** Structured log events captured from the coordinator's logger spy. */
  logEvents: Array<{ level: 'info' | 'warn'; payload: Record<string, unknown> }>;
  normalize: NormalizeFn;
  coordinator: ImageIngestionCoordinator;
  threadId: string;
  channelId: string;
  makeRequest(overrides?: Partial<ImageIngestionRequest>): ImageIngestionRequest;
}

function successNormalize(fixture: Pick<Fixture, 'normalizeCalls'>): NormalizeFn {
  return async (source, options) => {
    fixture.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
    try {
      fs.writeFileSync(options.tempFilePath, Buffer.from('JPEG-OUT'));
    } catch {
      return err({ code: 'io', retryable: true, message: 'temp write failed' });
    }
    return ok({
      filePath: options.tempFilePath,
      dimensions: { width: 10, height: 20 },
      sourceDimensions: { width: 10, height: 20 },
    });
  };
}

function setup(normalize?: NormalizeFn): Fixture {
  const db = createTestDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-ingest-test-'));
  const store = new ImageStore(tmpDir);

  const channelRepo = new ChannelRepository(db);
  const threadRepo = new ThreadRepository(db);
  const messageRepo = new MessageRepository(db);
  const imageRepo = new ImageRepository(db);
  const ingestionRepo = new ImageIngestionRepository(db);
  const queueRepo = new QueueRepository(db);

  const channelId = uuidv4();
  channelRepo.insert({
    id: channelId,
    type: 'telegram',
    name: 'test-bot',
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });
  const threadId = uuidv4();
  threadRepo.insert({
    id: threadId,
    channel_id: channelId,
    external_id: 'ext-chat-1',
    metadata: '{}',
  });

  const config: ImagesConfig = {
    maxInputBytes: 1_000,
    maxPerMessage: 2,
    maxPerInspection: 5,
    maxEdge: 512,
    jpegQuality: 85,
    retentionHours: 24,
  };

  const normalizeCalls: Fixture['normalizeCalls'] = [];
  const logEvents: Fixture['logEvents'] = [];
  const spyLogger = {
    info: (payload: Record<string, unknown>): void => {
      logEvents.push({ level: 'info', payload });
    },
    warn: (payload: Record<string, unknown>): void => {
      logEvents.push({ level: 'warn', payload });
    },
    error: (): void => undefined,
    debug: (): void => undefined,
    trace: (): void => undefined,
    fatal: (): void => undefined,
  } as unknown as pino.Logger;
  const fixture = {
    db,
    store,
    tmpDir,
    threadId,
    channelId,
    imageRepo,
    ingestionRepo,
    messageRepo,
    channelRepo,
    threadRepo,
    queueManager: new QueueManager(queueRepo, threadRepo, {
      maxAttempts: 3,
      backoffBaseMs: 100,
      backoffMaxMs: 1_000,
      concurrencyLimit: 1,
    }, pino({ level: 'silent' })),
    config,
    now: T0,
    normalizeCalls,
    logEvents,
    normalize: normalize ?? successNormalize({ normalizeCalls }),
  } as Fixture;

  // The coordinator reads `fixture.normalize` live so individual tests can
  // swap the normalization behavior without rebuilding the fixture.
  fixture.coordinator = new ImageIngestionCoordinator({
    messageRepo,
    imageRepo,
    ingestionRepo,
    queueManager: fixture.queueManager,
    store,
    threadRepo,
    channelRepo,
    imagesConfig: config,
    logger: spyLogger,
    now: () => fixture.now,
    normalize: (source, options) => fixture.normalize(source, options),
  });

  fixture.makeRequest = (overrides = {}) => ({
    channelId,
    channelName: 'test-bot',
    externalMessageId: 'ext-msg-1',
    externalChatId: 'ext-chat-1',
    threadId,
    message: {
      id: uuidv4(),
      content: 'look at this',
      senderId: 'user-1',
      idempotencyKey: 'ext-msg-1',
    },
    attachments: [payloadAttachment()],
    personaId: 'persona-1',
    ...overrides,
  });

  return fixture;
}

function payloadAttachment(data = Buffer.from('PNG-BYTES')): InboundAttachment {
  return { filename: 'photo.png', mimeType: 'image/png', data, size: data.length };
}

function rejectedAttachment(reason: ImageRejectionReason): InboundAttachment {
  return {
    kind: 'rejected',
    rejectionReason: reason,
    filename: 'x.gif',
    mimeType: 'image/gif',
    size: 999,
    sourcePosition: 1,
  };
}

// --- DB query helpers -------------------------------------------------------

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function imagesOf(f: Fixture, messageId: string) {
  return f.imageRepo.findByMessage(messageId)._unsafeUnwrap();
}

function ingestionOf(f: Fixture, messageId: string) {
  return f.ingestionRepo.findByMessage(messageId)._unsafeUnwrap();
}

function queueRows(f: Fixture) {
  return f.db
    .prepare('SELECT * FROM queue_items WHERE thread_id = ? ORDER BY created_at')
    .all(f.threadId) as Array<{ id: string; message_id: string | null; type: string; payload: string }>;
}

function stagingDeliveries(f: Fixture): string[] {
  return f.store.listStagingDeliveries();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImageIngestionCoordinator', () => {
  let f: Fixture;

  beforeEach(() => {
    f = setup();
  });

  afterEach(() => {
    f.db.close();
    fs.rmSync(f.tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Atomic admission
  // -------------------------------------------------------------------------

  describe('atomic admission', () => {
    it('persists the message, ordered Images, and pending Ingestion, then enqueues exactly once', async () => {
      const request = f.makeRequest({
        attachments: [payloadAttachment(), rejectedAttachment('unsupported_mime')],
      });

      const result = await f.coordinator.ingestMessage(request);
      expect(result._unsafeUnwrap()).toBe('enqueued');

      // One authoritative message, two ordered Images, one completed Ingestion.
      expect(count(f.db, 'messages')).toBe(1);
      const images = imagesOf(f, request.message.id);
      expect(images).toHaveLength(2);
      expect(images[0].ordinal).toBe(0);
      expect(images[0].state).toBe('available');
      expect(images[0].mime_type).toBe('image/jpeg');
      expect(images[0].width).toBe(10);
      expect(images[1].ordinal).toBe(1);
      expect(images[1].state).toBe('rejected');
      expect(images[1].rejection_reason).toBe('unsupported_mime');

      const ingestion = ingestionOf(f, request.message.id);
      expect(ingestion?.status).toBe('completed');
      expect(ingestion?.queue_item_id).not.toBeNull();
      // The admitted route is committed WITH the ledger row.
      expect(ingestion?.persona_id).toBe('persona-1');

      const rows = queueRows(f);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('message');
      expect(rows[0].message_id).toBe(request.message.id);
      // Completion enqueues under the persisted route.
      expect((JSON.parse(rows[0].payload) as Record<string, unknown>).personaId).toBe(
        'persona-1',
      );

      // Staging cleaned after publication.
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('rolls the whole admission back when a ledger write fails, leaving no message, Image, Ingestion, or staging', async () => {
      const spy = vi
        .spyOn(f.ingestionRepo, 'createPending')
        .mockReturnValue(err(new DbError('forced ledger failure')));

      const result = await f.coordinator.ingestMessage(f.makeRequest());
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('forced ledger failure');

      // The message row is inserted inside the same transaction: it must be gone.
      expect(count(f.db, 'messages')).toBe(0);
      expect(count(f.db, 'images')).toBe(0);
      expect(count(f.db, 'image_ingestions')).toBe(0);
      expect(count(f.db, 'queue_items')).toBe(0);
      // Newly downloaded staging was removed after the rollback.
      expect(stagingDeliveries(f)).toEqual([]);
      spy.mockRestore();
    });

    it('rejects over-slot Attachments with count_limit without staging them', async () => {
      const request = f.makeRequest({
        attachments: [payloadAttachment(), payloadAttachment(), payloadAttachment()],
      });

      await f.coordinator.ingestMessage(request);

      const images = imagesOf(f, request.message.id);
      expect(images.map((i) => i.ordinal)).toEqual([0, 1, 2]);
      expect(images[2].state).toBe('rejected');
      expect(images[2].rejection_reason).toBe('count_limit');
      // Only the two in-slot payloads were staged (and cleaned after processing).
      expect(f.normalizeCalls).toHaveLength(2);
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('rejects oversized actual bytes with size_limit and never normalizes them', async () => {
      const request = f.makeRequest({ attachments: [payloadAttachment(Buffer.alloc(1_001))] });

      const result = await f.coordinator.ingestMessage(request);
      expect(result._unsafeUnwrap()).toBe('enqueued');

      const images = imagesOf(f, request.message.id);
      expect(images[0].state).toBe('rejected');
      expect(images[0].rejection_reason).toBe('size_limit');
      expect(f.normalizeCalls).toHaveLength(0);
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('records a terminal admission for unrouted image messages without pending Ingestion or queue item', async () => {
      const request = f.makeRequest({ personaId: null });

      const result = await f.coordinator.ingestMessage(request);
      expect(result._unsafeUnwrap()).toBe('no_persona');

      expect(count(f.db, 'messages')).toBe(1);
      const record = f.ingestionRepo
        .findAdmissionByMessage(request.message.id)
        ._unsafeUnwrap();
      expect(record?.reason).toBe('no_binding');
      expect(ingestionOf(f, request.message.id)).toBeNull();
      expect(queueRows(f)).toHaveLength(0);
      // Staged bytes for a message that will never be processed are removed.
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('enqueues text and metadata only — no pixels or local paths in the queue payload', async () => {
      const bytes = Buffer.from('SUPER-SECRET-PIXELS');
      const request = f.makeRequest({ attachments: [payloadAttachment(bytes)] });

      await f.coordinator.ingestMessage(request);

      const rows = queueRows(f);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).not.toContain('SUPER-SECRET-PIXELS');
      expect(rows[0].payload).not.toContain(f.tmpDir);
      expect(rows[0].payload).not.toContain('source.bin');
      const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
      expect(payload.content).toBe('look at this');
      expect(payload.personaId).toBe('persona-1');
      // Identity is rebuilt from the COMMITTED message row.
      expect(payload.messageId).toBe(request.message.id);
    });

    it('starts the processing budget at the admission boundary, after staging', async () => {
      const original = f.store.writeStagingSource.bind(f.store);
      f.store.writeStagingSource = async (imageId: string, bytes: Buffer) => {
        const result = await original(imageId, bytes);
        // Staging consumed 30 seconds of wall time before admission.
        f.now = T0 + 30_000;
        return result;
      };

      const request = f.makeRequest();
      await f.coordinator.ingestMessage(request);

      // Expiry and the 60s deadline start at the synchronous admission
      // boundary AFTER staging: downloads never consume processing budget.
      const [image] = imagesOf(f, request.message.id);
      expect(image.processing_deadline_at).toBe(T0 + 30_000 + IMAGE_PROCESSING_DEADLINE_MS);
      expect(image.expires_at).toBe(T0 + 30_000 + RETENTION_MS);
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate delivery
  // -------------------------------------------------------------------------

  describe('duplicate delivery', () => {
    it('joins the committed owner: no second message, Image set, or queue item', async () => {
      const first = f.makeRequest();
      await f.coordinator.ingestMessage(first);

      const redelivery = f.makeRequest(); // new message id, same idempotency key
      const result = await f.coordinator.ingestMessage(redelivery);
      expect(result._unsafeUnwrap()).toBe('duplicate');

      expect(count(f.db, 'messages')).toBe(1);
      expect(imagesOf(f, redelivery.message.id)).toHaveLength(0);
      expect(imagesOf(f, first.message.id)).toHaveLength(1);
      expect(queueRows(f)).toHaveLength(1);
      expect(f.normalizeCalls).toHaveLength(1);
      // Newly downloaded duplicate staging is removed, adopted or not.
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('never re-enqueues a completed duplicate even after the queue item was purged', async () => {
      const first = f.makeRequest();
      await f.coordinator.ingestMessage(first);
      f.db.prepare('DELETE FROM queue_items').run();

      const result = await f.coordinator.ingestMessage(f.makeRequest());
      expect(result._unsafeUnwrap()).toBe('duplicate');
      expect(queueRows(f)).toHaveLength(0);
    });

    it('keeps an unrouted duplicate as duplicate without a second admission record', async () => {
      const request = f.makeRequest({ personaId: null });
      await f.coordinator.ingestMessage(request);

      const result = await f.coordinator.ingestMessage(f.makeRequest({ personaId: null }));
      expect(result._unsafeUnwrap()).toBe('duplicate');
      expect(count(f.db, 'image_admission_records')).toBe(1);
      expect(queueRows(f)).toHaveLength(0);
    });

    it('joins an active in-process owner while its normalization is still running', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.normalize = async (source, options) => {
        f.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        await gate;
        fs.writeFileSync(options.tempFilePath, Buffer.from('JPEG-OUT'));
        return ok({
          filePath: options.tempFilePath,
          dimensions: { width: 10, height: 20 },
          sourceDimensions: { width: 10, height: 20 },
        });
      };

      const first = f.makeRequest();
      const running = f.coordinator.ingestMessage(first);
      for (let i = 0; i < 200 && f.normalizeCalls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(f.normalizeCalls).toHaveLength(1);

      // Redelivery while the first delivery still owns the Processing work.
      const overlapping = await f.coordinator.ingestMessage(f.makeRequest());
      expect(overlapping._unsafeUnwrap()).toBe('duplicate');
      expect(f.normalizeCalls).toHaveLength(1);

      release();
      expect((await running)._unsafeUnwrap()).toBe('enqueued');
      expect(queueRows(f)).toHaveLength(1);
    });

    it('serializes overlapping redeliveries of pending work: only the adopting owner processes', async () => {
      // A committed admission with pending Processing work (crash shape).
      const { messageId } = seedCrashedAdmission();
      // Requests carry the seeded message's channel-scoped idempotency key
      // so redelivery resolves to the authoritative committed row.
      const redelivery = (bytes: string) =>
        f.makeRequest({
          message: {
            id: uuidv4(),
            content: 'crashed',
            senderId: 'user-1',
            idempotencyKey: `crash-${messageId}`,
          },
          attachments: [payloadAttachment(Buffer.from(bytes))],
        });

      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.normalize = async (source, options) => {
        f.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        await gate;
        fs.writeFileSync(options.tempFilePath, Buffer.from('JPEG-OUT'));
        return ok({
          filePath: options.tempFilePath,
          dimensions: { width: 10, height: 20 },
          sourceDimensions: { width: 10, height: 20 },
        });
      };

      // First redelivery adopts the source and owns the Processing work.
      const first = f.coordinator.ingestMessage(redelivery('REDELIVERED-1'));
      for (let i = 0; i < 200 && f.normalizeCalls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(f.normalizeCalls).toHaveLength(1);

      // Second redelivery must JOIN the adopting owner, not process a copy.
      const second = await f.coordinator.ingestMessage(redelivery('REDELIVERED-2'));
      expect(second._unsafeUnwrap()).toBe('duplicate');
      expect(f.normalizeCalls).toHaveLength(1);

      release();
      expect((await first)._unsafeUnwrap()).toBe('duplicate');
      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('available');
      expect(ingestionOf(f, messageId)?.status).toBe('completed');
      expect(queueRows(f)).toHaveLength(1);
      expect(stagingDeliveries(f)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery precedence (via recoverPending on a crashed ledger)
  // -------------------------------------------------------------------------

  /**
   * Builds a crashed-admission fixture directly in the ledger: message +
   * Processing Image + pending Ingestion, optionally with retained staging
   * bytes under the committed Image id.
   */
  function seedCrashedAdmission(
    options: {
      attempts?: number;
      expiresAt?: number;
      deadlineAt?: number;
      retainSource?: boolean;
    } = {},
  ): { messageId: string; imageId: string } {
    const messageId = uuidv4();
    const imageId = uuidv4();
    f.messageRepo
      .insert({
        id: messageId,
        thread_id: f.threadId,
        direction: 'inbound',
        content: 'crashed',
        idempotency_key: `${f.channelId}:crash-${messageId}`,
        provider_id: 'user-1',
        run_id: null,
      })
      ._unsafeUnwrap();
    const source = f.ingestionRepo
      .resolveSourceMessage({
        channel: 'test-bot',
        externalMessageId: `ext-${messageId}`,
        externalChatId: 'ext-chat-1',
      })
      ._unsafeUnwrap();
    f.imageRepo
      .insert({
        id: imageId,
        messageId,
        ordinal: 0,
        threadId: f.threadId,
        sourceRef: source.id,
        state: 'processing',
        expiresAt: options.expiresAt ?? T0 + RETENTION_MS,
        processingDeadlineAt: options.deadlineAt ?? T0 + IMAGE_PROCESSING_DEADLINE_MS,
      })
      ._unsafeUnwrap();
    if (options.attempts !== undefined && options.attempts > 0) {
      for (let i = 0; i < options.attempts; i++) {
        f.imageRepo.incrementAttempts(imageId)._unsafeUnwrap();
      }
    }
    if (options.retainSource) {
      f.store.ensureStagingDir(imageId)._unsafeUnwrap();
      fs.writeFileSync(f.store.stagingSourcePath(imageId)._unsafeUnwrap(), 'RETAINED-BYTES');
    }
    f.ingestionRepo.createPending({ messageId, threadId: f.threadId, personaId: 'persona-1' })._unsafeUnwrap();
    return { messageId, imageId };
  }

  describe('recovery precedence', () => {
    it('expiry wins over exhausted attempts and a retained source', async () => {
      const { messageId } = seedCrashedAdmission({
        attempts: MAX_ATTEMPTS_PER_IMAGE,
        expiresAt: f.now - 1, // already expired
        retainSource: true,
      });

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('unavailable');
      expect(image.unavailability_reason).toBe('expired');
      expect(f.normalizeCalls).toHaveLength(0);
      // Remaining source copy removed.
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('a crash past the deadline rejects processing_failed without another normalization', async () => {
      const { messageId } = seedCrashedAdmission({
        deadlineAt: f.now - 1,
        retainSource: true,
      });

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      expect(f.normalizeCalls).toHaveLength(0);
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('resumes Processing from the retained source with the persisted attempt budget', async () => {
      // Crash consumed two of three attempts; recovery gets exactly one more.
      const { messageId, imageId } = seedCrashedAdmission({ attempts: 2 });
      f.store.ensureStagingDir(imageId)._unsafeUnwrap();
      fs.writeFileSync(f.store.stagingSourcePath(imageId)._unsafeUnwrap(), 'RETAINED-BYTES');

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap()).toMatchObject({ inspected: 1, enqueued: 1 });

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('available');
      expect(image.attempt_count).toBe(MAX_ATTEMPTS_PER_IMAGE);
      expect(f.normalizeCalls).toHaveLength(1);
      expect(queueRows(f)).toHaveLength(1);

      // A second pass must not enqueue or process again.
      const second = await f.coordinator.recoverPending({ messageId });
      expect(second._unsafeUnwrap()).toMatchObject({ inspected: 0, enqueued: 0 });
      expect(queueRows(f)).toHaveLength(1);
    });

    it('a third retryable failure exhausts the attempts and rejects processing_failed', async () => {
      f.normalize = async (source, options) => {
        f.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        return err({ code: 'io', retryable: true, message: 'disk on fire' });
      };

      const request = f.makeRequest();
      const result = await f.coordinator.ingestMessage(request);
      expect(result._unsafeUnwrap()).toBe('enqueued');

      const [image] = imagesOf(f, request.message.id);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      expect(image.attempt_count).toBe(MAX_ATTEMPTS_PER_IMAGE);
      expect(f.normalizeCalls).toHaveLength(MAX_ATTEMPTS_PER_IMAGE);
      // The message still completes: rejected outcome, queued once.
      expect(ingestionOf(f, request.message.id)?.status).toBe('completed');
      expect(queueRows(f)).toHaveLength(1);
    });

    it('no usable source before the deadline means processing_interrupted', async () => {
      const { messageId } = seedCrashedAdmission(); // no retained staging

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_interrupted');
      expect(f.normalizeCalls).toHaveLength(0);
    });

    it('reconciles a rename/commit remnant without re-normalizing', async () => {
      const { messageId, imageId } = seedCrashedAdmission();
      // The rename landed but the commit was lost.
      const target = f.store.normalizedPath(f.threadId, imageId)._unsafeUnwrap();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'PUBLISHED-JPEG');

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('available');
      expect(image.attempt_count).toBe(0); // no new attempt spent
      expect(f.normalizeCalls).toHaveLength(0);
      // A re-normalization would have overwritten the published file.
      expect(fs.readFileSync(target, 'utf8')).toBe('PUBLISHED-JPEG');
    });

    it('completes pending work under the route PERSISTED at admission, not a re-resolved binding', async () => {
      const { messageId } = seedCrashedAdmission();
      // The pending Ingestion carries its admitted route in the database.
      expect(ingestionOf(f, messageId)?.persona_id).toBe('persona-1');

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap()).toMatchObject({ inspected: 1, enqueued: 1 });

      const rows = queueRows(f);
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
      // Recovery enqueues under the committed route; current bindings are
      // never consulted, so a changed or removed binding cannot reroute or
      // strand the pending message.
      expect(payload.personaId).toBe('persona-1');
      expect(payload.messageId).toBe(messageId);
      expect(payload.content).toBe('crashed');
    });

    it('leaves a pending row without any persisted route pending, never guessing one', async () => {
      const { messageId } = seedCrashedAdmission();
      // Pre-migration shape: pending row without a route column value.
      f.db.prepare('UPDATE image_ingestions SET persona_id = NULL WHERE message_id = ?').run(messageId);

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap()).toMatchObject({ inspected: 1, enqueued: 0, skipped: 1 });
      expect(ingestionOf(f, messageId)?.status).toBe('pending');
      expect(queueRows(f)).toHaveLength(0);
    });

    it('discards a published remnant when the processing deadline has passed', async () => {
      const { messageId, imageId } = seedCrashedAdmission({ deadlineAt: f.now - 1 });
      const target = f.store.normalizedPath(f.threadId, imageId)._unsafeUnwrap();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'PUBLISHED-JPEG');

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      // Exhaustion outranks remnant acceptance: the inadmissible output is
      // deleted, never committed back to Available.
      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      expect(fs.existsSync(target)).toBe(false);
      expect(f.normalizeCalls).toHaveLength(0);
    });

    it('discards a published remnant when the attempt budget is exhausted', async () => {
      const { messageId, imageId } = seedCrashedAdmission({ attempts: MAX_ATTEMPTS_PER_IMAGE });
      const target = f.store.normalizedPath(f.threadId, imageId)._unsafeUnwrap();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'PUBLISHED-JPEG');

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      expect(fs.existsSync(target)).toBe(false);
      expect(f.normalizeCalls).toHaveLength(0);
    });

    it('resolves expired when the source read crosses expiry and lands not_found', async () => {
      const { messageId } = seedCrashedAdmission({ expiresAt: T0 + 500, retainSource: true });
      f.store.readBounded = async () => {
        // The read itself crosses the expiry line before failing.
        f.now = T0 + 1_000;
        return err({ code: 'not_found', retryable: false, message: 'gone' });
      };

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      // The guard re-applied after the awaited read wins: a late not_found
      // resolves expired, never processing_interrupted.
      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('unavailable');
      expect(image.unavailability_reason).toBe('expired');
      expect(image.rejection_reason).toBeNull();
      expect(f.normalizeCalls).toHaveLength(0);
    });

    it('resolves processing_failed when the source read crosses the deadline and lands not_found', async () => {
      const { messageId } = seedCrashedAdmission({ retainSource: true });
      f.store.readBounded = async () => {
        f.now = T0 + IMAGE_PROCESSING_DEADLINE_MS + 1;
        return err({ code: 'not_found', retryable: false, message: 'gone' });
      };

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      expect(f.normalizeCalls).toHaveLength(0);
    });

    it('does not start normalization from a successful read that crossed the deadline', async () => {
      const { messageId } = seedCrashedAdmission({ retainSource: true });
      f.store.readBounded = async () => {
        // A SUCCESSFUL read that crossed the deadline mid-flight.
        f.now = T0 + IMAGE_PROCESSING_DEADLINE_MS + 1;
        return ok(Buffer.from('LATE-BYTES'));
      };

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      // The post-read guard fires before the conversion: late bytes are
      // discarded as processing_failed, never normalized or published.
      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      expect(f.normalizeCalls).toHaveLength(0);
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('does not commit a remnant whose existence check crosses the processing deadline', async () => {
      const { messageId, imageId } = seedCrashedAdmission();
      const target = f.store.normalizedPath(f.threadId, imageId)._unsafeUnwrap();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'PUBLISHED-JPEG');
      const originalExists = f.store.normalizedExists.bind(f.store);
      f.store.normalizedExists = (threadId: string, imageId: string) => {
        const exists = originalExists(threadId, imageId);
        if (exists) {
          // The filesystem check itself straddled the deadline.
          f.now = T0 + IMAGE_PROCESSING_DEADLINE_MS + 1;
        }
        return exists;
      };

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      // Admissibility is rechecked after the filesystem read: the late
      // remnant is rejected and removed, never committed as Available.
      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      expect(fs.existsSync(target)).toBe(false);
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('does not commit a remnant whose existence check crosses expiry', async () => {
      const { messageId, imageId } = seedCrashedAdmission({ expiresAt: T0 + 500 });
      const target = f.store.normalizedPath(f.threadId, imageId)._unsafeUnwrap();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'PUBLISHED-JPEG');
      const originalExists = f.store.normalizedExists.bind(f.store);
      f.store.normalizedExists = (threadId: string, imageId: string) => {
        const exists = originalExists(threadId, imageId);
        if (exists) {
          f.now = T0 + 1_000;
        }
        return exists;
      };

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('unavailable');
      expect(image.unavailability_reason).toBe('expired');
      expect(fs.existsSync(target)).toBe(false);
    });

    it('recovers dimensions and EXIF for a rename/commit remnant from the persisted record', async () => {
      const { messageId, imageId } = seedCrashedAdmission({ attempts: 1 });
      // The crash landed after metadata + rename but before the commit.
      const target = f.store.normalizedPath(f.threadId, imageId)._unsafeUnwrap();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'PUBLISHED-JPEG');
      f.store.ensureStagingDir(imageId)._unsafeUnwrap();
      fs.writeFileSync(
        path.join(f.store.stagingDir(imageId)._unsafeUnwrap(), 'publish-meta.json'),
        JSON.stringify({
          mimeType: 'image/jpeg',
          width: 64,
          height: 32,
          exif: JSON.stringify({ orientation: 6 }),
        }),
      );

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('available');
      expect(image.width).toBe(64);
      expect(image.height).toBe(32);
      expect(image.exif).not.toBeNull();
      expect(JSON.parse(image.exif as string)).toEqual({ orientation: 6 });
      // Staging (and with it the metadata record) is cleaned after commit.
      expect(stagingDeliveries(f)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Redelivery source adoption
  // -------------------------------------------------------------------------

  describe('redelivery adoption', () => {
    it('adopts a usable redelivered source for Processing work that lost its staging', async () => {
      const messageId = uuidv4();
      const imageId = uuidv4();
      f.messageRepo
        .insert({
          id: messageId,
          thread_id: f.threadId,
          direction: 'inbound',
          content: 're-sent',
          idempotency_key: `${f.channelId}:ext-msg-1`,
          provider_id: 'user-1',
          run_id: null,
        })
        ._unsafeUnwrap();
      const source = f.ingestionRepo
        .resolveSourceMessage({
          channel: 'test-bot',
          externalMessageId: 'ext-msg-1',
          externalChatId: 'ext-chat-1',
        })
        ._unsafeUnwrap();
      f.imageRepo
        .insert({
          id: imageId,
          messageId,
          ordinal: 0,
          threadId: f.threadId,
          sourceRef: source.id,
          state: 'processing',
          expiresAt: T0 + RETENTION_MS,
          processingDeadlineAt: T0 + IMAGE_PROCESSING_DEADLINE_MS,
        })
        ._unsafeUnwrap();
      f.ingestionRepo.createPending({ messageId, threadId: f.threadId, personaId: 'persona-1' })._unsafeUnwrap();

      const result = await f.coordinator.ingestMessage(
        f.makeRequest({ attachments: [payloadAttachment(Buffer.from('REDELIVERED-BYTES'))] }),
      );
      expect(result._unsafeUnwrap()).toBe('duplicate');

      // The committed Image (not a new ID) was processed from adopted bytes.
      expect(f.normalizeCalls).toHaveLength(1);
      expect(f.normalizeCalls[0].source.toString()).toBe('REDELIVERED-BYTES');
      const [image] = imagesOf(f, messageId);
      expect(image.id).toBe(imageId);
      expect(image.state).toBe('available');
      expect(ingestionOf(f, messageId)?.status).toBe('completed');
      const rows = queueRows(f);
      expect(rows).toHaveLength(1);
      // The completion payload is rebuilt from COMMITTED rows: identity is
      // the stored message id and content is the stored content — never the
      // redelivery's request view.
      const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
      expect(payload.messageId).toBe(messageId);
      expect(payload.content).toBe('re-sent');
      expect(payload.personaId).toBe('persona-1');
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('never overwrites a retained source with redelivered bytes', async () => {
      const messageId = uuidv4();
      const imageId = uuidv4();
      f.messageRepo
        .insert({
          id: messageId,
          thread_id: f.threadId,
          direction: 'inbound',
          content: 're-sent',
          idempotency_key: `${f.channelId}:ext-msg-1`,
          provider_id: 'user-1',
          run_id: null,
        })
        ._unsafeUnwrap();
      const source = f.ingestionRepo
        .resolveSourceMessage({
          channel: 'test-bot',
          externalMessageId: 'ext-msg-1',
          externalChatId: 'ext-chat-1',
        })
        ._unsafeUnwrap();
      f.imageRepo
        .insert({
          id: imageId,
          messageId,
          ordinal: 0,
          threadId: f.threadId,
          sourceRef: source.id,
          state: 'processing',
          expiresAt: T0 + RETENTION_MS,
          processingDeadlineAt: T0 + IMAGE_PROCESSING_DEADLINE_MS,
        })
        ._unsafeUnwrap();
      f.ingestionRepo.createPending({ messageId, threadId: f.threadId, personaId: 'persona-1' })._unsafeUnwrap();
      f.store.ensureStagingDir(imageId)._unsafeUnwrap();
      fs.writeFileSync(f.store.stagingSourcePath(imageId)._unsafeUnwrap(), 'RETAINED');

      await f.coordinator.ingestMessage(
        f.makeRequest({ attachments: [payloadAttachment(Buffer.from('NEW-BYTES'))] }),
      );

      expect(f.normalizeCalls).toHaveLength(1);
      expect(f.normalizeCalls[0].source.toString()).toBe('RETAINED');

      // Same rule for the payload identity of a retained-source adoption.
      const rows = queueRows(f);
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
      expect(payload.messageId).toBe(messageId);
      expect(payload.content).toBe('re-sent');
    });
  });

  // -------------------------------------------------------------------------
  // Publication fencing
  // -------------------------------------------------------------------------

  describe('publication fencing', () => {
    it('discards a late result after expiry: no published file, Image unavailable', async () => {
      f.normalize = async (source, options) => {
        f.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        // Clock rolls past retention while the attempt was in flight.
        f.now = T0 + RETENTION_MS + 1_000;
        fs.writeFileSync(options.tempFilePath, 'LATE-JPEG');
        return ok({
          filePath: options.tempFilePath,
          dimensions: { width: 10, height: 20 },
          sourceDimensions: { width: 10, height: 20 },
        });
      };

      const request = f.makeRequest();
      await f.coordinator.ingestMessage(request);

      const image = f.imageRepo.findByMessage(request.message.id)._unsafeUnwrap()[0];
      expect(image.state).toBe('unavailable');
      expect(image.unavailability_reason).toBe('expired');
      const target = f.store.normalizedPath(f.threadId, image.id)._unsafeUnwrap();
      expect(fs.existsSync(target)).toBe(false);
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('discards a late result after the message deadline: Image rejected processing_failed', async () => {
      f.normalize = async (source, options) => {
        f.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        // Past the 60s message deadline, still inside retention.
        f.now = T0 + IMAGE_PROCESSING_DEADLINE_MS + 1;
        fs.writeFileSync(options.tempFilePath, 'LATE-JPEG');
        return ok({
          filePath: options.tempFilePath,
          dimensions: { width: 10, height: 20 },
          sourceDimensions: { width: 10, height: 20 },
        });
      };

      const request = f.makeRequest();
      await f.coordinator.ingestMessage(request);

      const image = f.imageRepo.findByMessage(request.message.id)._unsafeUnwrap()[0];
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      const target = f.store.normalizedPath(f.threadId, image.id)._unsafeUnwrap();
      expect(fs.existsSync(target)).toBe(false);
    });

    it('resolves expired (not processing_failed) when retention expires mid-retry', async () => {
      // Retention ends 500ms after admission, well before the 60s deadline.
      const { messageId } = seedCrashedAdmission({
        expiresAt: T0 + 500,
        retainSource: true,
      });
      f.normalize = async (source, options) => {
        f.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        // The first attempt crosses the expiry line and fails retryably.
        f.now = T0 + 1_000;
        return err({ code: 'io', retryable: true, message: 'transient' });
      };

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      // The guard reapplied after the awaited phase wins: expiry resolves
      // the image instead of burning further attempts into processing_failed.
      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('unavailable');
      expect(image.unavailability_reason).toBe('expired');
      expect(f.normalizeCalls).toHaveLength(1);
    });

    it('resolves expired (not the conversion-specific reason) when a non-retryable failure crosses expiry', async () => {
      const { messageId } = seedCrashedAdmission({
        expiresAt: T0 + 500,
        retainSource: true,
      });
      f.normalize = async (source, options) => {
        f.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        // The conversion crosses expiry and then fails non-retryably.
        f.now = T0 + 1_000;
        return err({ code: 'conversion_failed', retryable: false, message: 'corrupt' });
      };

      const report = await f.coordinator.recoverPending({ messageId });
      expect(report._unsafeUnwrap().enqueued).toBe(1);

      // The post-await ordered guard fires BEFORE the conversion-specific
      // rejection: the message is expired, not conversion_failed.
      const [image] = imagesOf(f, messageId);
      expect(image.state).toBe('unavailable');
      expect(image.unavailability_reason).toBe('expired');
      expect(image.rejection_reason).toBeNull();
    });

    it('reverts publication when the rename itself crosses the processing deadline', async () => {
      const originalRename = f.store.rename.bind(f.store);
      f.store.rename = (from: string, to: string) => {
        const result = originalRename(from, to);
        if (result.isOk()) {
          // The filesystem publish straddled the deadline: the file landed
          // after processing_deadline_at.
          f.now = T0 + IMAGE_PROCESSING_DEADLINE_MS + 1;
        }
        return result;
      };

      const request = f.makeRequest();
      const result = await f.coordinator.ingestMessage(request);
      expect(result._unsafeUnwrap()).toBe('enqueued');

      // The post-publish recheck reverted the late output and rejected the
      // image instead of recording it Available.
      const [image] = imagesOf(f, request.message.id);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('processing_failed');
      const target = f.store.normalizedPath(f.threadId, image.id)._unsafeUnwrap();
      expect(fs.existsSync(target)).toBe(false);
      expect(stagingDeliveries(f)).toEqual([]);
    });

    it('does not retry a non-retryable conversion failure and records its reason', async () => {
      f.normalize = async (source, options) => {
        f.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        return err({ code: 'conversion_failed', retryable: false, message: 'undecodable' });
      };

      const request = f.makeRequest();
      await f.coordinator.ingestMessage(request);

      const [image] = imagesOf(f, request.message.id);
      expect(image.state).toBe('rejected');
      expect(image.rejection_reason).toBe('conversion_failed');
      expect(image.attempt_count).toBe(1);
      expect(f.normalizeCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Delivery settlement hygiene
  // -------------------------------------------------------------------------

  describe('delivery settlement hygiene', () => {
    it('a rejecting normalizer does not leak an unhandled rejection (F5)', async () => {
      // Regression: the drain instrumentation used `work.finally(...)`,
      // which derives a SECOND promise that rejects alongside `work` with
      // no handler attached — the daemon's process-level
      // unhandledRejection handler (signal-handler.ts) exits on exactly
      // that shape. Both settlement branches must be consumed.
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        const local = setup(async () => {
          throw new Error('normalizer exploded');
        });
        try {
          const result = await local.coordinator.ingestMessage(local.makeRequest());
          // The delivery itself resolves as a typed error, never rejects.
          expect(result.isErr()).toBe(true);
          // Give any orphan derived rejection a chance to surface.
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(rejections).toEqual([]);
        } finally {
          local.db.close();
          fs.rmSync(local.tmpDir, { recursive: true, force: true });
        }
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Shutdown retirement (F3)
  // -------------------------------------------------------------------------

  describe('shutdown retirement', () => {
    it('a failed staging write with partial staging is cleaned on a terminal pre-admission exit (R3)', async () => {
      // The staging write MATERIALIZES its directory, then fails. The
      // delivery unwinds before admission (here: the admission lookup
      // fails — the same unwind path the shutdown fence uses). That
      // unwind must remove EVERY attempted staging id: the plan-level
      // view marks the failed attempt rejected and would leak its
      // partial directory.
      const local = setup();
      const originalWrite = local.store.writeStagingSource.bind(local.store);
      local.store.writeStagingSource = async (imageId: string, bytes: Buffer) => {
        await originalWrite(imageId, bytes); // partial directory on disk
        return err({ code: 'io', retryable: false, message: 'simulated partial staging write' });
      };
      const spy = vi
        .spyOn(local.ingestionRepo, 'resolveSourceMessage')
        .mockReturnValue(err(new DbError('forced ledger failure')));

      const result = await local.coordinator.ingestMessage(local.makeRequest());
      expect(result.isErr()).toBe(true);
      expect(spy).toHaveBeenCalledOnce();

      // The FAILED attempt's materialized directory must not survive.
      expect(stagingDeliveries(local)).toEqual([]);
      expect(count(local.db, 'messages')).toBe(0);
      expect(count(local.db, 'images')).toBe(0);

      local.db.close();
      fs.rmSync(local.tmpDir, { recursive: true, force: true });
    });

    it('a fenced delivery is rejected at the entry and never becomes drainable work (F2)', async () => {
      // The entry gate runs BEFORE trackDeliveryWork: a delivery that
      // arrives after the fence must never materialise as shutdown-drain
      // work, must never touch the ledger, and must never stage bytes.
      const local = setup();
      local.coordinator.fenceAdmissions();

      const inflight = local.coordinator.ingestMessage(local.makeRequest());
      // Polled SYNCHRONOUSLY after the call: an untracked (fixed) delivery
      // leaves the registry empty, while a delivery that entered tracking
      // before its fence rejection would show up here as drain work.
      expect(await local.coordinator.drainActiveIngestion(5)).toEqual({
        drained: 0,
        abandoned: 0,
      });

      const settled = await inflight;
      expect(settled.isErr()).toBe(true);
      expect(settled._unsafeUnwrapErr().message).toContain('source must resend');
      expect(count(local.db, 'messages')).toBe(0);
      expect(stagingDeliveries(local)).toEqual([]);
    });

    it('trackDeliveryWork keeps caller-visible rejections without orphaning a second one (F5)', async () => {
      // White-box contract for the drain instrumentation: even if a tracked
      // run unexpectedly REJECTS (public paths catch everything into typed
      // errors), the rejection stays observable to the caller while the
      // derived drain-settlement promise consumes BOTH branches. A derived
      // `work.finally(...)` would orphan a second rejection, and
      // signal-handler.ts exits the daemon on unclaimed rejections.
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        const local = setup();
        const helper = local.coordinator as unknown as {
          trackDeliveryWork(
            deliveryId: string,
            run: () => Promise<unknown>,
          ): Promise<unknown>;
        };
        await expect(
          helper.trackDeliveryWork('delivery-orphan', () =>
            Promise.reject(new Error('run rejected')),
          ),
        ).rejects.toThrow('run rejected');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(rejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('a retired continuation unwinds at its guard re-check — durable rows untouched', async () => {
      // The recovery table is authoritative: retirement must NOT resolve
      // viable work. With the database still OPEN (stronger than the
      // integration close-test), the retired continuation may not publish,
      // may not mark, and may not enqueue.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const local = setup();
      local.normalize = async (source, options) => {
        local.normalizeCalls.push({ source, tempFilePath: options.tempFilePath });
        await gate;
        fs.writeFileSync(options.tempFilePath, Buffer.from('JPEG-OUT'));
        return ok({
          filePath: options.tempFilePath,
          dimensions: { width: 10, height: 20 },
          sourceDimensions: { width: 10, height: 20 },
        });
      };

      const request = local.makeRequest();
      const inflight = local.coordinator.ingestMessage(request);
      await vi.waitFor(() => expect(local.normalizeCalls).toHaveLength(1));

      local.coordinator.fenceAdmissions();
      const drain = await local.coordinator.drainActiveIngestion(25);
      expect(drain).toEqual({ drained: 0, abandoned: 1 });
      // R2: this delivery was already admitted (suspended in Processing),
      // so retirement claims no pre-admission staging — its retained
      // source belongs to the recovery table.
      expect(await local.coordinator.abandonActiveIngestion()).toEqual({
        retired: 1,
        stagingCleaned: 0,
        stagingFailed: 0,
      });

      release();
      const settled = await inflight;
      expect(settled.isErr()).toBe(true);

      // Exactly the pre-retirement shape: Processing Image, pending
      // Ingestion, nothing enqueued, no published output.
      const [image] = imagesOf(local, request.message.id);
      expect(image.state).toBe('processing');
      expect(
        local.ingestionRepo.findByMessage(request.message.id)._unsafeUnwrap()?.status,
      ).toBe('pending');
      expect(queueRows(local)).toHaveLength(0);
      expect(local.store.normalizedExists(local.threadId, image.id)).toBe(false);
    });

    it('retirement reports failed staging removals separately from cleaned (P2-2)', async () => {
      // Honest retirement accounting (P2-2): a removeStagingDir failure
      // must NOT be counted as cleaned. The failure surfaces in the
      // return shape and in the sanitized retire log (ids/codes only,
      // no filesystem paths); the directory falls back to the next-boot
      // orphan sweep with its mtime grace window.
      const local = setup();
      let releaseWrite: () => void = () => undefined;
      const writeSuspended = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const originalWrite = local.store.writeStagingSource.bind(local.store);
      local.store.writeStagingSource = async (imageId: string, bytes: Buffer) => {
        const res = await originalWrite(imageId, bytes); // dir materialized
        await writeSuspended; // suspended AFTER its filesystem effect
        return res;
      };

      const inflight = local.coordinator.ingestMessage(local.makeRequest());
      await vi.waitFor(() => expect(stagingDeliveries(local)).toHaveLength(1));

      local.coordinator.fenceAdmissions();
      expect(await local.coordinator.drainActiveIngestion(5)).toEqual({
        drained: 0,
        abandoned: 1,
      });

      // Force the tracked removal to fail.
      local.store.removeStagingDir = () =>
        err({ code: 'io', retryable: false, message: 'device busy' });

      const retired = await local.coordinator.abandonActiveIngestion(10);
      expect(retired).toEqual({ retired: 1, stagingCleaned: 0, stagingFailed: 1 });

      const retireLog = local.logEvents.find(
        (e) => (e.payload as { op?: string }).op === 'shutdown_retire',
      );
      expect(retireLog).toBeDefined();
      expect(retireLog!.payload).toMatchObject({
        code: 'CONTINUATIONS_RETIRED',
        stagingCleaned: 0,
        stagingFailed: 1,
      });
      const details = retireLog!.payload.stagingFailureDetails as Array<{
        imageId: string;
        code: string;
      }>;
      expect(details).toHaveLength(1);
      expect(details[0]!.code).toBe('io');
      expect(typeof details[0]!.imageId).toBe('string');
      // Sanitized evidence: no filesystem paths in the retire log.
      expect(JSON.stringify(retireLog!.payload)).not.toContain(local.tmpDir);

      // Release the suspended write: the delivery unwinds at the
      // admission-boundary fence-exit; the uncleanable directory waits
      // for the next-boot orphan sweep rather than being misreported.
      releaseWrite();
      const settled = await inflight;
      expect(settled.isErr()).toBe(true);

      local.db.close();
      fs.rmSync(local.tmpDir, { recursive: true, force: true });
    });

    it('recovery stops resolving rows once continuations are retired', async () => {
      // A retired process must not run next-boot recovery semantics
      // halfway: pending rows keep their exact pre-recovery shape.
      const local = setup();
      const messageId = uuidv4();
      const imageId = uuidv4();
      local.messageRepo
        .insert({
          id: messageId,
          thread_id: local.threadId,
          direction: 'inbound',
          content: 'crashed',
          idempotency_key: `${local.channelId}:${messageId}`,
          provider_id: 'user-1',
          run_id: null,
        })
        ._unsafeUnwrap();
      const source = local.ingestionRepo
        .resolveSourceMessage({
          channel: 'test-bot',
          externalMessageId: `ext-${messageId}`,
          externalChatId: 'ext-chat-1',
        })
        ._unsafeUnwrap();
      local.imageRepo
        .insert({
          id: imageId,
          messageId,
          ordinal: 0,
          threadId: local.threadId,
          sourceRef: source.id,
          state: 'processing',
          expiresAt: local.now + RETENTION_MS,
          processingDeadlineAt: local.now + IMAGE_PROCESSING_DEADLINE_MS,
        })
        ._unsafeUnwrap();
      local.ingestionRepo
        .createPending({ messageId, threadId: local.threadId, personaId: 'persona-1' })
        ._unsafeUnwrap();

      local.coordinator.fenceAdmissions();
      expect(await local.coordinator.abandonActiveIngestion()).toEqual({
        retired: 0,
        stagingCleaned: 0,
        stagingFailed: 0,
      });

      const report = await local.coordinator.recoverPending({});
      expect(report.isOk()).toBe(true);
      expect(report._unsafeUnwrap()).toEqual({ inspected: 0, enqueued: 0, skipped: 0, failed: 0 });

      const [image] = imagesOf(local, messageId);
      expect(image.state).toBe('processing');
      expect(local.ingestionRepo.findByMessage(messageId)._unsafeUnwrap()?.status).toBe('pending');
      expect(queueRows(local)).toHaveLength(0);
    });
  });
});
