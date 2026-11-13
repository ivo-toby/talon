/**
 * Unit tests for ImageService — the TASK-010 runtime implementation of the
 * TASK-001 `ImageAccess` port.
 *
 * Real migrated in-memory SQLite, a real ImageRepository, and a real
 * ImageStore over a temp directory; only the clock is injected. Pins the
 * port contract: cross-thread IDs indistinguishable from unknown ones, the
 * ordered durable availability refresh (expiry establishes BEFORE
 * file_missing, a recorded reason is preserved forever, a late read never
 * restores availability), inspection bytes served ONLY from the durable
 * normalized JPEG through `store.readBounded`, the closed
 * `Result<T, ImageAccessError>` vocabulary, and Processing being externally
 * inaccessible for byte reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { err, type Result } from 'neverthrow';
import { v4 as uuidv4 } from 'uuid';
import { createTestDb } from '../queue/helpers.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { ImageRepository, type ImageRow } from '../../../src/core/database/repositories/image-repository.js';
import { ImageIngestionRepository } from '../../../src/core/database/repositories/image-ingestion-repository.js';
import type { ImagesConfig } from '../../../src/core/config/config-types.js';
import type { AuditEntry, AuditStore } from '../../../src/core/logging/audit-logger.js';
import { ImageStore, type ImageStoreError } from '../../../src/images/image-store.js';
import {
  ImageService,
  IMAGE_INSPECTION_READ_CEILING_BYTES,
} from '../../../src/images/image-service.js';
import type {
  ImageAccess,
  ImageAccessError,
  ImageRejectionReason,
} from '../../../src/images/image-types.js';

// ---------------------------------------------------------------------------
// Fixture scaffolding
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

interface ServiceFixture {
  db: Database.Database;
  tmpDir: string;
  threadId: string;
  otherThreadId: string;
  channelId: string;
  store: ImageStore;
  imageRepo: ImageRepository;
  config: ImagesConfig;
  now: number;
  auditEntries: AuditEntry[];
  logged: unknown[][];
  service: ImageService;
  seedImage(opts?: {
    state?: 'processing' | 'available' | 'rejected' | 'unavailable';
    expiresAt?: number;
    rejectionReason?: ImageRejectionReason;
    unavailableReason?: 'expired' | 'file_missing';
    filename?: string;
    width?: number;
    height?: number;
    exif?: string | null;
    threadId?: string;
  }): ImageRow;
  writeNormalized(imageId: string, bytes?: Buffer): string;
}

function setup(): ServiceFixture {
  const db = createTestDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-image-service-'));
  const store = new ImageStore(tmpDir);

  const channelRepo = new ChannelRepository(db);
  const threadRepo = new ThreadRepository(db);
  const messageRepo = new MessageRepository(db);
  const imageRepo = new ImageRepository(db);
  const ingestionRepo = new ImageIngestionRepository(db);

  const channelId = uuidv4();
  channelRepo
    .insert({
      id: channelId,
      type: 'telegram',
      name: 'test-bot',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    })
    ._unsafeUnwrap();
  const threadId = uuidv4();
  threadRepo
    .insert({ id: threadId, channel_id: channelId, external_id: 'ext-chat-1', metadata: '{}' })
    ._unsafeUnwrap();
  // A second thread to exercise cross-thread resolution.
  const otherThreadId = uuidv4();
  threadRepo
    .insert({
      id: otherThreadId,
      channel_id: channelId,
      external_id: 'ext-chat-2',
      metadata: '{}',
    })
    ._unsafeUnwrap();

  const config: ImagesConfig = {
    maxInputBytes: 1_000,
    maxPerMessage: 2,
    maxPerInspection: 5,
    maxEdge: 512,
    jpegQuality: 85,
    retentionHours: 24,
  };

  const auditEntries: AuditEntry[] = [];
  const auditStore: AuditStore = { append: (entry: AuditEntry) => auditEntries.push(entry) };
  const logged: unknown[][] = [];
  const logger = {
    debug: () => undefined,
    level: 'silent',
    info: (...args: unknown[]) => logged.push(args),
    warn: (...args: unknown[]) => logged.push(args),
    error: (...args: unknown[]) => logged.push(args),
    fatal: (...args: unknown[]) => logged.push(args),
    child: () => logger,
  } as unknown as pino.Logger;

  const fixture: ServiceFixture = {
    db,
    tmpDir,
    threadId,
    otherThreadId,
    channelId,
    store,
    imageRepo,
    config,
    now: T0,
    auditEntries,
    logged,
    service: new ImageService({
      imageRepo,
      store,
      logger,
      auditStore,
      now: () => fixture.now,
    }),
    seedImage(opts = {}) {
      const ownerThreadId = opts.threadId ?? threadId;
      const messageId = uuidv4();
      const imageId = uuidv4();
      // The owning message must live in the same thread as the Image.
      messageRepo
        .insert({
          id: messageId,
          thread_id: ownerThreadId,
          direction: 'inbound',
          content: 'with image',
          idempotency_key: `${channelId}:${messageId}`,
          provider_id: 'user-1',
          run_id: null,
        })
        ._unsafeUnwrap();
      const source = ingestionRepo
        .resolveSourceMessage({
          channel: 'test-bot',
          externalMessageId: `ext-${messageId}`,
          externalChatId: 'ext-chat-1',
        })
        ._unsafeUnwrap();
      let row = imageRepo
        .insert({
          id: imageId,
          messageId,
          ordinal: 0,
          threadId: ownerThreadId,
          sourceRef: source.id,
          state: opts.state === 'rejected' ? 'rejected' : 'processing',
          rejectionReason: opts.rejectionReason,
          filename: opts.filename,
          mimeType: 'image/png',
          width: opts.width,
          height: opts.height,
          exif: opts.exif,
          expiresAt: opts.expiresAt ?? fixture.now + 24 * 3_600_000,
          processingDeadlineAt: fixture.now + 60_000,
        })
        ._unsafeUnwrap();
      if (opts.state === 'available' || opts.state === 'unavailable') {
        row = imageRepo.markAvailable(imageId)._unsafeUnwrap();
      }
      if (opts.state === 'unavailable') {
        row = imageRepo
          .markUnavailable(imageId, opts.unavailableReason ?? 'expired')
          ._unsafeUnwrap();
      }
      return row;
    },
    writeNormalized(imageId: string, bytes: Buffer = Buffer.from('NORMALIZED-JPEG-BYTES')): string {
      const row = imageRepo.findById(imageId)._unsafeUnwrap();
      if (row === null) throw new Error(`seed an image before writing its normalized file: ${imageId}`);
      const target = store.normalizedPath(row.thread_id, imageId)._unsafeUnwrap();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      return target;
    },
  };
  return fixture;
}

/** Narrow an Err result for strict-tsc-clean assertions. */
function errOf<E>(result: { isErr(): boolean; _unsafeUnwrapErr(): E }): E {
  if (!result.isErr()) {
    throw new Error('expected an Err result');
  }
  return result._unsafeUnwrapErr();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImageService — ImageAccess port conformance', () => {
  let f: ServiceFixture;

  beforeEach(() => {
    f = setup();
  });

  afterEach(() => {
    f.db.close();
    fs.rmSync(f.tmpDir, { recursive: true, force: true });
  });

  it('implements the ImageAccess port shape', () => {
    const port: ImageAccess = f.service;
    expect(typeof port.resolveImage).toBe('function');
    expect(typeof port.getAvailability).toBe('function');
    expect(typeof port.fetchInspectionBytes).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Thread scoping
  // -------------------------------------------------------------------------

  describe('thread scoping', () => {
    it('resolves a cross-thread ID indistinguishably from an unknown ID on every operation', async () => {
      const img = f.seedImage({ state: 'available' });
      f.writeNormalized(img.id);

      const cases = [
        'resolveImage',
        'getAvailability',
        'fetchInspectionBytes',
      ] as const;
      for (const op of cases) {
        const crossThread = await f.service[op]({ threadId: f.otherThreadId, imageId: img.id });
        const unknownId = await f.service[op]({ threadId: f.threadId, imageId: uuidv4() });
        expect(crossThread.isErr()).toBe(true);
        expect(unknownId.isErr()).toBe(true);
        // Indistinguishable: identical code AND identical message.
        expect(errOf<ImageAccessError>(crossThread)).toEqual(errOf<ImageAccessError>(unknownId));
        expect(errOf<ImageAccessError>(crossThread).code).toBe('not_found');
      }
    });

    it('a cross-thread read neither reveals nor mutates the owning row', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 10 });
      f.now += 1000; // past the original admission expiry

      // The wrong-thread read is rejected BEFORE any refresh runs.
      const probe = await f.service.getAvailability({
        threadId: f.otherThreadId,
        imageId: img.id,
      });
      expect(errOf<ImageAccessError>(probe).code).toBe('not_found');
      expect(f.imageRepo.findById(img.id)._unsafeUnwrap()!.state).toBe('available');

      // Only the owning thread's read records the durable transition.
      const own = await f.service.getAvailability({ threadId: f.threadId, imageId: img.id });
      expect(own._unsafeUnwrap().state).toBe('unavailable');
      expect(f.imageRepo.findById(img.id)._unsafeUnwrap()!.unavailability_reason).toBe('expired');
    });
  });

  // -------------------------------------------------------------------------
  // Durable availability refresh (expiry ordering)
  // -------------------------------------------------------------------------

  describe('refreshAvailability ordering', () => {
    it('transitions an expired Available image to Unavailable(expired) and removes the file', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 1000 });
      const target = f.writeNormalized(img.id);

      const before = await f.service.getAvailability({ threadId: f.threadId, imageId: img.id });
      expect(before._unsafeUnwrap()).toEqual({
        state: 'available',
        available: true,
        expiresAt: T0 + 1000,
      });

      f.now += 1000;
      const after = await f.service.getAvailability({ threadId: f.threadId, imageId: img.id });
      expect(after._unsafeUnwrap()).toEqual({
        state: 'unavailable',
        available: false,
        unavailabilityReason: 'expired',
      });
      const row = f.imageRepo.findById(img.id)._unsafeUnwrap()!;
      expect(row.state).toBe('unavailable');
      expect(row.unavailability_reason).toBe('expired');
      expect(fs.existsSync(target)).toBe(false);
    });

    it('establishes expired BEFORE file_missing when both hold at once', async () => {
      // Expiry is counted from the ORIGINAL admission's expires_at; the
      // normalized file is already gone as well. Expiry must win, once and
      // forever.
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 1000 });
      f.now += 1000;

      const result = await f.service.getAvailability({ threadId: f.threadId, imageId: img.id });
      expect(result._unsafeUnwrap()).toEqual({
        state: 'unavailable',
        available: false,
        unavailabilityReason: 'expired',
      });
      expect(f.imageRepo.findById(img.id)._unsafeUnwrap()!.unavailability_reason).toBe('expired');
    });

    it('records file_missing only for a missing file while still inside the expiry window', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 3_600_000 });
      // No normalized file written.

      const result = await f.service.getAvailability({ threadId: f.threadId, imageId: img.id });
      expect(result._unsafeUnwrap()).toEqual({
        state: 'unavailable',
        available: false,
        unavailabilityReason: 'file_missing',
      });
    });

    it('preserves a recorded reason once recorded; a late read never restores availability', async () => {
      const img = f.seedImage({
        state: 'unavailable',
        unavailableReason: 'file_missing',
        expiresAt: f.now + 1000,
      });
      // Even after the original expiry elapses, the FIRST recorded reason wins.
      f.now += 5_000;

      const availability = await f.service.getAvailability({
        threadId: f.threadId,
        imageId: img.id,
      });
      expect(availability._unsafeUnwrap()).toEqual({
        state: 'unavailable',
        available: false,
        unavailabilityReason: 'file_missing',
      });

      // Re-writing the file cannot resurrect the Image either.
      f.writeNormalized(img.id);
      const late = await f.service.getAvailability({ threadId: f.threadId, imageId: img.id });
      expect(late._unsafeUnwrap().state).toBe('unavailable');
      const descriptor = await f.service.resolveImage({ threadId: f.threadId, imageId: img.id });
      expect(descriptor._unsafeUnwrap().state).toBe('unavailable');
    });

    it('returns terminal states untouched without any write', async () => {
      const rejected = f.seedImage({ state: 'rejected', rejectionReason: 'conversion_failed' });
      const updatedBefore = f.imageRepo
        .findById(rejected.id)
        ._unsafeUnwrap()!.updated_at;

      const availability = await f.service.getAvailability({
        threadId: f.threadId,
        imageId: rejected.id,
      });
      expect(availability._unsafeUnwrap()).toEqual({
        state: 'rejected',
        available: false,
        rejectionReason: 'conversion_failed',
      });
      const row = f.imageRepo.findById(rejected.id)._unsafeUnwrap()!;
      expect(row.updated_at).toBe(updatedBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Inspection bytes
  // -------------------------------------------------------------------------

  describe('fetchInspectionBytes', () => {
    it('serves bytes only from the durable normalized JPEG via store.readBounded', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 3_600_000 });
      const bytes = Buffer.from('NORMALIZED-JPEG-BYTES');
      const target = f.writeNormalized(img.id, bytes);
      const readBounded = vi.spyOn(f.store, 'readBounded');

      const result = await f.service.fetchInspectionBytes({
        threadId: f.threadId,
        imageId: img.id,
      });

      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();
      expect(value.imageId).toBe(img.id);
      expect(value.bytes.equals(bytes)).toBe(true);
      expect(value.mimeType).toBe('image/jpeg');
      expect(value.expiresAt).toBe(img.expires_at);
      expect(readBounded).toHaveBeenCalledTimes(1);
      // P2-6: the read is sized to the actual normalized file, NOT to the
      // transport-level maxInputBytes admission cap.
      expect(readBounded).toHaveBeenCalledWith(target, bytes.length);
    });

    it('serves a normalized output LARGER than maxInputBytes in full (P2-6)', async () => {
      // An input-compressed source can decode (and re-encode) past the
      // input admission cap; inspection must not fail because of that.
      expect(f.config.maxInputBytes).toBe(1_000);
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 3_600_000 });
      const big = Buffer.alloc(5_000, 0x7f); // > maxInputBytes, < ceiling
      f.writeNormalized(img.id, big);

      const result = await f.service.fetchInspectionBytes({
        threadId: f.threadId,
        imageId: img.id,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().bytes.length).toBe(5_000);
      expect(IMAGE_INSPECTION_READ_CEILING_BYTES).toBeGreaterThan(5_000);
    });

    it('the ceiling boundary is inclusive: size === ceiling served, ceiling + 1 refused (P2-6)', async () => {
      // Boundary regression guard for the oversized-decoded-output read:
      // the ceiling is a MAXIMUM-ACCEPTED size, not an exclusive one.
      const atCeiling = f.seedImage({ state: 'available', expiresAt: f.now + 3_600_000 });
      f.writeNormalized(atCeiling.id, Buffer.alloc(IMAGE_INSPECTION_READ_CEILING_BYTES, 0x5a));
      const overCeiling = f.seedImage({ state: 'available', expiresAt: f.now + 3_600_000 });
      f.writeNormalized(overCeiling.id, Buffer.alloc(IMAGE_INSPECTION_READ_CEILING_BYTES + 1, 0x5a));

      const served = await f.service.fetchInspectionBytes({
        threadId: f.threadId,
        imageId: atCeiling.id,
      });
      expect(served.isOk()).toBe(true);
      expect(served._unsafeUnwrap().bytes.length).toBe(IMAGE_INSPECTION_READ_CEILING_BYTES);

      const refused = await f.service.fetchInspectionBytes({
        threadId: f.threadId,
        imageId: overCeiling.id,
      });
      expect(errOf<ImageAccessError>(refused).code).toBe('storage_failed');
    });

    it('read-triggered expiry and deletion are audited through the shared audit store (P2-7)', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 1000 });
      f.writeNormalized(img.id);
      f.now += 1000;

      await f.service.getAvailability({ threadId: f.threadId, imageId: img.id });

      expect(f.auditEntries).toContainEqual({
        action: 'image.availability.expired',
        details: { imageId: img.id },
      });
      expect(f.auditEntries).toContainEqual({
        action: 'image.cleanup',
        details: { imageId: img.id, kind: 'expired_output', deleted: true },
      });
    });

    it('a read-triggered file_missing transition is audited', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 3_600_000 });

      await f.service.resolveImage({ threadId: f.threadId, imageId: img.id });

      expect(f.auditEntries).toEqual([
        {
          action: 'image.availability.file_missing',
          details: { imageId: img.id },
        },
      ]);
    });

    it('a failed read-triggered deletion audits the structured code only (P2-5)', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 1000 });
      f.writeNormalized(img.id);
      f.store.removeFile = () =>
        err({
          code: 'io',
          retryable: true,
          message: `EACCES ${f.tmpDir}/SECRETTOK remove token=CREDCANARY`,
        });
      f.now += 1000;

      await f.service.getAvailability({ threadId: f.threadId, imageId: img.id });

      expect(f.auditEntries).toContainEqual({
        action: 'image.cleanup.failed',
        details: { imageId: img.id, kind: 'expired_output', code: 'io' },
      });
      const durable = JSON.stringify(f.auditEntries);
      expect(durable).not.toContain('SECRETTOK');
      expect(durable).not.toContain('CREDCANARY');
      expect(durable).not.toContain(f.tmpDir);
      expect(JSON.stringify(f.logged)).not.toContain('SECRETTOK');
    });

    it('Processing is externally inaccessible: no bytes, no file read', async () => {
      const processing = f.seedImage({ state: 'processing' });
      f.writeNormalized(processing.id);
      const readBounded = vi.spyOn(f.store, 'readBounded');

      const bytes = await f.service.fetchInspectionBytes({
        threadId: f.threadId,
        imageId: processing.id,
      });
      expect(errOf<ImageAccessError>(bytes)).toEqual({
        code: 'processing',
        message: 'image is still being processed',
      });
      expect(readBounded).not.toHaveBeenCalled();

      // The descriptor and availability views describe it, but never serve it.
      const availability = await f.service.getAvailability({
        threadId: f.threadId,
        imageId: processing.id,
      });
      expect(availability._unsafeUnwrap()).toEqual({ state: 'processing', available: false });
    });

    it('rejected and unavailable images fail with their recorded reason', async () => {
      const rejected = f.seedImage({ state: 'rejected', rejectionReason: 'animated' });
      const unavailable = f.seedImage({
        state: 'unavailable',
        unavailableReason: 'file_missing',
      });

      expect(errOf<ImageAccessError>(
        await f.service.fetchInspectionBytes({ threadId: f.threadId, imageId: rejected.id }),
      )).toEqual({ code: 'rejected', rejectionReason: 'animated' });
      expect(errOf<ImageAccessError>(
        await f.service.fetchInspectionBytes({ threadId: f.threadId, imageId: unavailable.id }),
      )).toEqual({ code: 'unavailable', unavailabilityReason: 'file_missing' });
    });

    it('expired content cannot start a new inspection read', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 1000 });
      f.writeNormalized(img.id);
      f.now += 1001;

      const result = await f.service.fetchInspectionBytes({
        threadId: f.threadId,
        imageId: img.id,
      });
      expect(errOf<ImageAccessError>(result)).toEqual({
        code: 'unavailable',
        unavailabilityReason: 'expired',
      });
      expect(f.store.normalizedExists(f.threadId, img.id)).toBe(false);
    });

    it('maps a storage fault to a sanitized storage_failed error (no path, no cause text)', async () => {
      const img = f.seedImage({ state: 'available', expiresAt: f.now + 3_600_000 });
      const target = f.writeNormalized(img.id, Buffer.from('SECRET-PX'));
      // Operational storage fault as an Err Result (the port contract).
      f.store.readBounded = async (): Promise<Result<Buffer, ImageStoreError>> =>
        err({
          code: 'io',
          retryable: true,
          message: `EACCES ${target} token=READCANARY`,
        });

      const result = await f.service.fetchInspectionBytes({
        threadId: f.threadId,
        imageId: img.id,
      });
      const error = errOf<ImageAccessError>(result);
      expect(error.code).toBe('storage_failed');
      if (error.code === 'storage_failed') {
        expect(error.message).toBe('failed to read normalized image bytes');
      }
      expect(JSON.stringify(result)).not.toContain('READCANARY');
      expect(JSON.stringify(result)).not.toContain(f.tmpDir);
      // P2-5: even the log line is structured — op + store error code only.
      const durable = JSON.stringify(f.logged);
      expect(durable).toContain('"code":"io"');
      expect(durable).toContain('inspection_read');
      expect(durable).not.toContain('READCANARY');
      expect(durable).not.toContain(f.tmpDir);
    });
  });

  // -------------------------------------------------------------------------
  // Result shapes and descriptor hygiene
  // -------------------------------------------------------------------------

  describe('Result<T, ImageAccessError> shapes', () => {
    it('every port method returns a settled Result, never a throw', async () => {
      const img = f.seedImage({ state: 'available' });
      f.writeNormalized(img.id);

      const okShape = await f.service.resolveImage({ threadId: f.threadId, imageId: img.id });
      expect(okShape.isOk()).toBe(true);
      if (okShape.isOk()) {
        expect(okShape.value.state).toBe('available');
      }

      const closedCodes = new Set(['not_found', 'processing', 'rejected', 'unavailable', 'storage_failed']);
      const errShape = await f.service.resolveImage({ threadId: f.threadId, imageId: uuidv4() });
      expect(errShape.isErr()).toBe(true);
      if (errShape.isErr()) {
        expect(closedCodes.has(errShape.error.code)).toBe(true);
      }
    });

    it('descriptors project identity and metadata only — never pixels, paths, or source refs', async () => {
      const img = f.seedImage({
        state: 'available',
        filename: 'holiday photo.jpg',
        width: 100,
        height: 50,
        exif: JSON.stringify({ orientation: 6 }),
      });
      f.writeNormalized(img.id, Buffer.from('PIXEL-PAYLOAD-CANARY'));

      const descriptor = (
        await f.service.resolveImage({ threadId: f.threadId, imageId: img.id })
      )._unsafeUnwrap();

      expect(descriptor.imageId).toBe(img.id);
      expect(descriptor.threadId).toBe(f.threadId);
      expect(descriptor.messageId).toBe(img.message_id);
      expect(descriptor.ordinal).toBe(0);
      expect(descriptor.receivedAt).toBe(img.received_at);
      expect(descriptor.expiresAt).toBe(img.expires_at);
      expect(descriptor.filename).toBe('holiday photo.jpg'); // declared metadata
      expect(descriptor.dimensions).toEqual({ width: 100, height: 50 });
      expect(descriptor.exif).toEqual({ orientation: 6 });
      expect(descriptor.state).toBe('available');

      const serialized = JSON.stringify(descriptor);
      expect(serialized).not.toContain('PIXEL-PAYLOAD-CANARY');
      expect(serialized).not.toContain(f.tmpDir);
      expect(serialized).not.toContain('attachments');
      expect(serialized).not.toContain('source.bin');
      expect(descriptor).not.toHaveProperty('source_ref');
      expect(descriptor).not.toHaveProperty('bytes');
    });
  });
});
