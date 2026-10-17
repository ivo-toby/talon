/**
 * Unit tests for the daemon's Image/Finding context adapters (TASK-019).
 *
 * Real migrated SQLite, real repositories, real ImageStore, real ImageService —
 * only the clock is injected. The adapters are thin delegation layers, so the
 * contract under test is that they add no authority of their own:
 *
 * - Every state decision (expiry, missing file, cross-thread hiding) comes from
 *   the shipped ImageAccess, never from a re-derived value.
 * - Reads are thread-scoped and bounded; `processing` stays internal to the
 *   inventory/lookup reads.
 * - Findings are mapped verbatim: absent optional columns stay absent, reported
 *   usage is copied rather than estimated, and a Finding from a run that later
 *   failed is still delivered.
 * - The lookup page read uses the repository keyset query and returns an anchor
 *   the next call can pass back unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { ok, err } from 'neverthrow';
import { v4 as uuidv4 } from 'uuid';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { ImageRepository } from '../../../src/core/database/repositories/image-repository.js';
import { ImageIngestionRepository } from '../../../src/core/database/repositories/image-ingestion-repository.js';
import { FindingRepository } from '../../../src/core/database/repositories/finding-repository.js';
import { BaseRepository } from '../../../src/core/database/repositories/base-repository.js';
import type { ImagesConfig } from '../../../src/core/config/config-types.js';
import type { AuditStore } from '../../../src/core/logging/audit-logger.js';
import { ImageStore } from '../../../src/images/image-store.js';
import { ImageService } from '../../../src/images/image-service.js';
import type { ImageAccess, ImageAccessError, ImageState } from '../../../src/images/image-types.js';
import {
  DaemonImageContextSource,
  ImageLookupAccessAdapter,
  IMAGE_CONTEXT_READ_WINDOW,
} from '../../../src/daemon/image-context-source.js';
import { ImageLookupHandler } from '../../../src/tools/host-tools/image-lookup.js';
import type { PersonaLoader } from '../../../src/personas/persona-loader.js';
import type { ResolvedCapabilities } from '../../../src/personas/persona-types.js';
import type { ToolExecutionContext } from '../../../src/tools/host-tools/channel-send.js';

const T0 = 1_700_000_000_000;
const DAY_MS = 24 * 3_600_000;

const IMAGES_CONFIG: ImagesConfig = {
  maxInputBytes: 1_000,
  maxPerMessage: 4,
  maxPerInspection: 5,
  maxEdge: 512,
  jpegQuality: 85,
  retentionHours: 24,
};

interface Fixture {
  db: Database.Database;
  dataDir: string;
  threadId: string;
  otherThreadId: string;
  runId: string;
  personaId: string;
  now: number;
  store: ImageStore;
  imageRepo: ImageRepository;
  findings: FindingRepository;
  imageAccess: ImageService;
  source: DaemonImageContextSource;
  lookup: ImageLookupAccessAdapter;
  /**
   * A lookup adapter whose delegate {@link ImageAccess} refuses the rows
   * `select` names (every row when it returns true for a null ID) with the
   * given code. Models an operational fault without touching the ledger.
   */
  lookupWithFault(
    select: (imageId: string | null) => boolean,
    message: string,
    code?: ImageAccessError['code'],
  ): ImageLookupAccessAdapter;
  /** Seed one Image with an explicit receipt, state, and optional file. */
  seedImage(opts: {
    threadId?: string;
    messageId?: string;
    ordinal?: number;
    state?: ImageState;
    receivedAt?: number;
    expiresAt?: number;
    withFile?: boolean;
    filename?: string;
  }): string;
  /** Seed an inbound Message in a thread. */
  seedMessage(threadId?: string): string;
  /** Seed one canonical Finding owned by the fixture run. */
  seedFinding(opts?: {
    threadId?: string;
    runId?: string;
    imageIds?: string[];
    usage?: { inputTokens?: number; outputTokens?: number };
    extractedText?: string | null;
    uncertainty?: string | null;
    createdAt?: number;
  }): string;
  markRunFailed(runId: string): void;
}

function setup(): Fixture {
  BaseRepository.__resetMonotonicClockForTests();
  const db = createTestDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-image-context-'));

  const channelRepo = new ChannelRepository(db);
  const threadRepo = new ThreadRepository(db);
  const messageRepo = new MessageRepository(db);
  const personaRepo = new PersonaRepository(db);
  const runRepo = new RunRepository(db);
  const imageRepo = new ImageRepository(db);
  const ingestionRepo = new ImageIngestionRepository(db);
  const findings = new FindingRepository(db);
  const store = new ImageStore(dataDir);

  const channelId = uuid();
  channelRepo
    .insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    })
    ._unsafeUnwrap();

  const threadId = uuid();
  threadRepo
    .insert({ id: threadId, channel_id: channelId, external_id: `ext-${uuid()}`, metadata: '{}' })
    ._unsafeUnwrap();
  const otherThreadId = uuid();
  threadRepo
    .insert({
      id: otherThreadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    })
    ._unsafeUnwrap();

  const personaId = uuid();
  personaRepo
    .insert({
      id: personaId,
      name: `persona-${uuid()}`,
      model: 'gpt-5.3-vision',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    })
    ._unsafeUnwrap();

  function insertRun(thread: string): string {
    const id = uuid();
    runRepo
      .insert({
        id,
        thread_id: thread,
        persona_id: personaId,
        provider_name: 'openai-compatible',
        model_name: 'gpt-5.3-vision',
        reasoning_effort: null,
        sandbox_id: null,
        session_id: null,
        status: 'running',
        parent_run_id: null,
        queue_item_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        error: null,
        started_at: null,
        ended_at: null,
      })
      ._unsafeUnwrap();
    return id;
  }

  const runId = insertRun(threadId);

  const logger = pino({ level: 'silent' });
  const auditStore: AuditStore = { append: () => undefined };
  const imageAccess = new ImageService({
    imageRepo,
    store,
    logger,
    auditStore,
    now: () => fixture.now,
  });
  // Declared before the fixture so `Fixture` can keep this a required member.
  // It only closes over the shared ImageService, which it delegates to lazily,
  // so building it here needs nothing that setup() creates later.
  const lookupWithFault: Fixture['lookupWithFault'] = (
    select,
    message,
    code = 'storage_failed',
  ) => {
    const failing: ImageAccess = {
      resolveImage: (request) =>
        select(request.imageId)
          ? Promise.resolve(err({ code, message } as ImageAccessError))
          : imageAccess.resolveImage(request),
      getAvailability: (request) => imageAccess.getAvailability(request),
      fetchInspectionBytes: (request) => imageAccess.fetchInspectionBytes(request),
    };
    return new ImageLookupAccessAdapter({ imageRepo, imageAccess: failing, logger });
  };
  const fixture: Fixture = {
    db,
    dataDir,
    threadId,
    otherThreadId,
    runId,
    personaId,
    now: T0,
    store,
    imageRepo,
    findings,
    imageAccess,
    lookupWithFault,
    source: null as unknown as DaemonImageContextSource,
    lookup: null as unknown as ImageLookupAccessAdapter,
    seedMessage(thread = threadId) {
      const id = uuid();
      messageRepo
        .insert({
          id,
          thread_id: thread,
          direction: 'inbound',
          content: '🖼 look at this',
          idempotency_key: `idem-${uuid()}`,
          provider_id: null,
          run_id: null,
        })
        ._unsafeUnwrap();
      return id;
    },
    seedImage(opts) {
      const ownerThread = opts.threadId ?? threadId;
      const messageId = opts.messageId ?? fixture.seedMessage(ownerThread);
      const id = uuid();
      const receivedAt = opts.receivedAt ?? T0;
      const sourceRef = ingestionRepo
        .resolveSourceMessage({
          channel: 'image-service-test',
          externalMessageId: `ext-${uuid()}`,
          externalChatId: 'chat-1',
        })
        ._unsafeUnwrap();
      imageRepo
        .insert({
          id,
          messageId,
          ordinal: opts.ordinal ?? 0,
          threadId: ownerThread,
          sourceRef: sourceRef.id,
          state: opts.state === 'rejected' ? 'rejected' : 'processing',
          rejectionReason: opts.state === 'rejected' ? 'size_limit' : undefined,
          filename: opts.filename,
          mimeType: opts.state === 'rejected' ? undefined : 'image/jpeg',
          expiresAt: opts.expiresAt ?? receivedAt + DAY_MS,
          processingDeadlineAt: receivedAt + 60_000,
        })
        ._unsafeUnwrap();
      if (opts.state === 'available' || opts.state === 'unavailable') {
        imageRepo
          .markAvailable(id, { mimeType: 'image/jpeg', width: 16, height: 9 })
          ._unsafeUnwrap();
      }
      if (opts.state === 'unavailable') {
        imageRepo.markUnavailable(id, 'expired')._unsafeUnwrap();
      }
      // An Available Image whose normalized file is missing is durably
      // refreshed to unavailable(file_missing) on the next read, so seeds that
      // mean "really available" need a real file on disk.
      if (opts.withFile ?? opts.state === 'available') {
        const target = store.normalizedPath(ownerThread, id)._unsafeUnwrap();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from('JPEG'));
      }
      // Keep the deterministic receipt: the ledger stamps its own monotonic
      // clock, and ordering assertions need the caller's value.
      db.prepare('UPDATE images SET received_at = ?, updated_at = ? WHERE id = ?').run(
        receivedAt,
        receivedAt,
        id,
      );
      return id;
    },
    seedFinding(opts = {}) {
      const id = uuid();
      const ownerThread = opts.threadId ?? threadId;
      const imageIds = opts.imageIds ?? [
        fixture.seedImage({ threadId: ownerThread, state: 'available', withFile: true }),
      ];
      findings
        .create({
          id,
          runId: opts.runId ?? (ownerThread === threadId ? runId : insertRun(ownerThread)),
          threadId: ownerThread,
          imageIds,
          question: 'What does the sign say?',
          answer: 'The sign says CAFE.',
          extractedText: opts.extractedText === undefined ? 'CAFE OPEN 9-17' : opts.extractedText,
          uncertainty: opts.uncertainty === undefined ? null : opts.uncertainty,
          modelName: 'gpt-5.3-vision',
          usage: opts.usage ?? null,
        })
        ._unsafeUnwrap();
      if (opts.createdAt !== undefined) {
        db.prepare('UPDATE findings SET created_at = ? WHERE id = ?').run(opts.createdAt, id);
      }
      return id;
    },
    markRunFailed(failedRunId) {
      db.prepare("UPDATE runs SET status = 'failed', error = 'provider blew up' WHERE id = ?").run(
        failedRunId,
      );
    },
  };

  const deps = {
    imageRepo,
    imageAccess: fixture.imageAccess,
    logger,
  };
  fixture.source = new DaemonImageContextSource({ ...deps, findings });
  fixture.lookup = new ImageLookupAccessAdapter(deps);

  return fixture;
}

describe('DaemonImageContextSource', () => {
  let f: Fixture;

  beforeEach(() => {
    f = setup();
  });

  afterEach(() => {
    f.db.close();
    fs.rmSync(f.dataDir, { recursive: true, force: true });
  });

  describe('resolveMessageDescriptors', () => {
    it('returns the message Images in source order', async () => {
      const messageId = f.seedMessage();
      const second = f.seedImage({ messageId, ordinal: 1, state: 'available', filename: 'b.jpg' });
      const first = f.seedImage({ messageId, ordinal: 0, state: 'available', filename: 'a.jpg' });

      const descriptors = await f.source.resolveMessageDescriptors({
        threadId: f.threadId,
        messageId,
      });

      expect(descriptors.map((d) => d.imageId)).toEqual([first, second]);
      expect(descriptors.map((d) => d.ordinal)).toEqual([0, 1]);
      expect(descriptors.map((d) => d.filename)).toEqual(['a.jpg', 'b.jpg']);
    });

    it("never returns another thread's Images", async () => {
      const myMessage = f.seedMessage();
      const mine = f.seedImage({ messageId: myMessage, state: 'available' });
      const theirsMessage = f.seedMessage(f.otherThreadId);
      const theirs = f.seedImage({
        threadId: f.otherThreadId,
        messageId: theirsMessage,
        state: 'available',
      });

      const descriptors = await f.source.resolveMessageDescriptors({
        threadId: f.threadId,
        messageId: myMessage,
      });
      expect(descriptors.map((d) => d.imageId)).toEqual([mine]);

      // And the reverse: reading this thread's message with the other thread's
      // id yields nothing rather than an error that leaks existence.
      const crossThread = await f.source.resolveMessageDescriptors({
        threadId: f.otherThreadId,
        messageId: myMessage,
      });
      expect(crossThread).toEqual([]);

      // Theirs stays reachable only through its own thread.
      const reversed = await f.source.resolveMessageDescriptors({
        threadId: f.otherThreadId,
        messageId: theirsMessage,
      });
      expect(reversed.map((d) => d.imageId)).toEqual([theirs]);
    });

    it('refreshes expiry through ImageAccess instead of trusting the stored state', async () => {
      const id = f.seedImage({ state: 'available', withFile: true });
      const messageId = f.imageRepo.findById(id)._unsafeUnwrap()!.message_id;
      expect(f.imageRepo.findById(id)._unsafeUnwrap()?.state).toBe('available');

      // Time travels past the durable budget.
      f.now += DAY_MS * 2;

      const descriptors = await f.source.resolveMessageDescriptors({
        threadId: f.threadId,
        messageId,
      });
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]?.state).toBe('unavailable');
      expect(descriptors[0]?.unavailabilityReason).toBe('expired');
      // The transition is durable, not a read-time fiction.
      expect(f.imageRepo.findById(id)._unsafeUnwrap()?.state).toBe('unavailable');
    });

    it('passes a Processing Image through untouched for the renderer to exclude', async () => {
      const messageId = f.seedMessage();
      const pending = f.seedImage({ messageId, state: 'processing' });

      const descriptors = await f.source.resolveMessageDescriptors({
        threadId: f.threadId,
        messageId,
      });

      expect(descriptors.map((d) => d.imageId)).toEqual([pending]);
      expect(descriptors[0]?.state).toBe('processing');
    });

    it('returns nothing for a message with no Images', async () => {
      const descriptors = await f.source.resolveMessageDescriptors({
        threadId: f.threadId,
        messageId: f.seedMessage(),
      });
      expect(descriptors).toEqual([]);
    });
  });

  describe('listThreadDescriptors', () => {
    it('lists the thread inventory newest-first, excluding Processing', async () => {
      f.seedImage({ state: 'available', receivedAt: T0, filename: 'oldest.jpg' });
      f.seedImage({ state: 'rejected', receivedAt: T0 + 500, filename: 'mid.jpg' });
      f.seedImage({ state: 'available', receivedAt: T0 + 1000, filename: 'new.jpg' });
      f.seedImage({ state: 'processing', receivedAt: T0 + 1500 });
      f.seedImage({ threadId: f.otherThreadId, state: 'available', receivedAt: T0 + 2000 });

      const descriptors = await f.source.listThreadDescriptors(f.threadId);

      expect(descriptors.map((d) => d.filename)).toEqual(['new.jpg', 'mid.jpg', 'oldest.jpg']);
      expect(descriptors.map((d) => d.state)).toEqual(['available', 'rejected', 'available']);
      expect(descriptors.every((d) => d.threadId === f.threadId)).toBe(true);
    });

    it('never reports an Image as Available once its content is gone', async () => {
      const id = f.seedImage({ state: 'available', withFile: true });

      const before = await f.source.listThreadDescriptors(f.threadId);
      expect(before.map((d) => d.state)).toEqual(['available']);

      f.now += DAY_MS * 2;

      const after = await f.source.listThreadDescriptors(f.threadId);
      expect(after.map((d) => d.state)).toEqual(['unavailable']);
      expect(after[0]?.unavailabilityReason).toBe('expired');
      expect(f.imageRepo.findById(id)._unsafeUnwrap()?.state).toBe('unavailable');
    });

    it('bounds the read to one window instead of the whole history', async () => {
      const spy = vi.spyOn(f.imageRepo, 'findThreadPage');
      for (let i = 0; i < 5; i += 1) {
        f.seedImage({ state: 'available', receivedAt: T0 + i });
      }

      await f.source.listThreadDescriptors(f.threadId);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({
        threadId: f.threadId,
        limit: IMAGE_CONTEXT_READ_WINDOW,
      });
      expect(spy.mock.calls[0]![0].states).not.toContain('processing');
      spy.mockRestore();
    });

    it('omits a row the availability authority refuses without dropping the rest', async () => {
      f.seedImage({ state: 'available', receivedAt: T0 + 10 });
      const broken = f.seedImage({ state: 'available', receivedAt: T0 + 20, withFile: true });

      // A storage fault inside the authority must not erase the inventory.
      const failing = {
        resolveImage: async (request: { threadId: string; imageId: string }) =>
          request.imageId === broken
            ? (await import('neverthrow')).err({
                code: 'storage_failed' as const,
                message: 'simulated fault',
              })
            : f.imageAccess.resolveImage(request),
        getAvailability: f.imageAccess.getAvailability.bind(f.imageAccess),
        fetchInspectionBytes: f.imageAccess.fetchInspectionBytes.bind(f.imageAccess),
      };
      const degraded = new DaemonImageContextSource({
        imageRepo: f.imageRepo,
        imageAccess: failing,
        logger: pino({ level: 'silent' }),
        findings: f.findings,
      });

      const descriptors = await degraded.listThreadDescriptors(f.threadId);

      expect(descriptors.map((d) => d.state)).toEqual(['available']);
      expect(descriptors.some((d) => d.imageId === broken)).toBe(false);
    });
  });

  describe('listThreadFindings', () => {
    it('maps the canonical Finding verbatim, newest first', async () => {
      const olderMessage = f.seedMessage();
      const olderImage = f.seedImage({
        messageId: olderMessage,
        state: 'available',
        withFile: true,
        filename: 'menu.jpg',
      });
      const olderId = f.seedFinding({ imageIds: [olderImage], createdAt: T0 + 100 });
      const newerId = f.seedFinding({ createdAt: T0 + 200 });

      const findings = await f.source.listThreadFindings(f.threadId);

      expect(findings.map((item) => item.findingId)).toEqual([newerId, olderId]);
      const mapped = findings.find((item) => item.findingId === olderId)!;
      expect(mapped.threadId).toBe(f.threadId);
      expect(mapped.runId).toBe(f.runId);
      expect(mapped.imageIds).toEqual([olderImage]);
      expect(mapped.question).toBe('What does the sign say?');
      expect(mapped.answer).toBe('The sign says CAFE.');
      expect(mapped.extractedText).toBe('CAFE OPEN 9-17');
      expect(mapped.modelName).toBe('gpt-5.3-vision');
      expect(mapped.createdAt).toBe(T0 + 100);
    });

    it('leaves unreported optionals absent instead of inventing them', async () => {
      const id = f.seedFinding({ extractedText: null, uncertainty: null });

      const [mapped] = await f.source.listThreadFindings(f.threadId);

      expect(mapped?.findingId).toBe(id);
      expect(Object.hasOwn(mapped ?? {}, 'extractedText')).toBe(false);
      expect(Object.hasOwn(mapped ?? {}, 'uncertainty')).toBe(false);
      // Absent usage stays absent: no zero-filled estimate is presented as fact.
      expect(Object.hasOwn(mapped ?? {}, 'usage')).toBe(false);
    });

    it('copies reported usage without adding fields', async () => {
      f.seedFinding({ usage: { inputTokens: 1200 } });

      const [mapped] = await f.source.listThreadFindings(f.threadId);

      expect(mapped?.usage).toEqual({ inputTokens: 1200 });
    });

    it('keeps Findings from a run that later failed', async () => {
      const id = f.seedFinding();
      f.markRunFailed(f.runId);

      const findings = await f.source.listThreadFindings(f.threadId);

      expect(findings.map((item) => item.findingId)).toEqual([id]);
      expect(findings[0]?.answer).toBe('The sign says CAFE.');
    });

    it('never crosses threads', async () => {
      f.seedFinding();
      f.seedFinding({ threadId: f.otherThreadId });

      const mine = await f.source.listThreadFindings(f.threadId);
      const theirs = await f.source.listThreadFindings(f.otherThreadId);

      expect(mine.every((item) => item.threadId === f.threadId)).toBe(true);
      expect(theirs.every((item) => item.threadId === f.otherThreadId)).toBe(true);
      expect(mine.map((i) => i.findingId)).not.toEqual(theirs.map((i) => i.findingId));
    });
  });
});

describe('ImageLookupAccessAdapter', () => {
  let f: Fixture;

  beforeEach(() => {
    f = setup();
  });

  afterEach(() => {
    f.db.close();
    fs.rmSync(f.dataDir, { recursive: true, force: true });
  });

  it('delegates the single-Image reads to the shipped ImageAccess', async () => {
    const id = f.seedImage({ state: 'available', withFile: true });
    const resolveSpy = vi.spyOn(f.imageAccess, 'resolveImage');

    const viaAdapter = await f.lookup.resolveImage({ threadId: f.threadId, imageId: id });
    const direct = await f.imageAccess.resolveImage({ threadId: f.threadId, imageId: id });

    expect(resolveSpy).toHaveBeenCalledWith({ threadId: f.threadId, imageId: id });
    expect(viaAdapter._unsafeUnwrap()).toEqual(direct._unsafeUnwrap());

    const bytes = await f.lookup.fetchInspectionBytes({ threadId: f.threadId, imageId: id });
    expect(bytes.isOk()).toBe(true);
    expect(bytes._unsafeUnwrap().mimeType).toBe('image/jpeg');

    const availability = await f.lookup.getAvailability({ threadId: f.threadId, imageId: id });
    expect(availability._unsafeUnwrap().available).toBe(true);
  });

  it("reports another thread's Image exactly like an unknown one", async () => {
    const theirs = f.seedImage({ threadId: f.otherThreadId, state: 'available', withFile: true });

    const viaAdapter = await f.lookup.resolveImage({ threadId: f.threadId, imageId: theirs });

    expect(viaAdapter.isErr()).toBe(true);
    expect(viaAdapter._unsafeUnwrapErr().code).toBe('not_found');
  });

  describe('findThreadPage', () => {
    it('pages the thread newest-first without repeating or skipping an Image', async () => {
      const ids = [
        f.seedImage({ state: 'available', receivedAt: T0 }),
        f.seedImage({ state: 'available', receivedAt: T0 + 100 }),
        f.seedImage({ state: 'available', receivedAt: T0 + 100 }),
        f.seedImage({ state: 'available', receivedAt: T0 + 200 }),
      ];
      f.seedImage({ threadId: f.otherThreadId, state: 'available', receivedAt: T0 + 300 });

      const expectedOrder = [ids[3], ...[ids[1]!, ids[2]!].sort(), ids[0]];

      const first = await f.lookup.findThreadPage({ threadId: f.threadId, limit: 2 });
      expect(first.isOk()).toBe(true);
      const firstValue = first._unsafeUnwrap();
      // Newest receipt first; the T0+100 tie resolves by Image ID ascending.
      expect(firstValue.images.map((image) => image.imageId)).toEqual(expectedOrder.slice(0, 2));
      expect(firstValue.nextAnchor).not.toBeNull();

      const second = await f.lookup.findThreadPage({
        threadId: f.threadId,
        limit: 2,
        before: firstValue.nextAnchor,
      });
      const secondValue = second._unsafeUnwrap();
      const walked = [
        ...firstValue.images.map((i) => i.imageId),
        ...secondValue.images.map((i) => i.imageId),
      ];
      expect([...walked].sort()).toEqual([...ids].sort());
      expect(new Set(walked).size).toBe(ids.length);
    });

    it('excludes Processing from the page', async () => {
      f.seedImage({ state: 'available', receivedAt: T0 + 10 });
      f.seedImage({ state: 'processing', receivedAt: T0 + 20 });

      const page = await f.lookup.findThreadPage({ threadId: f.threadId, limit: 10 });

      const images = page._unsafeUnwrap().images;
      expect(images).toHaveLength(1);
      expect(images[0]?.state).toBe('available');
    });

    it('reports current state, not the state stored at admission', async () => {
      const id = f.seedImage({ state: 'available', withFile: true, receivedAt: T0 });

      f.now += DAY_MS * 2;

      const page = await f.lookup.findThreadPage({ threadId: f.threadId, limit: 10 });
      const [descriptor] = page._unsafeUnwrap().images;
      expect(descriptor?.imageId).toBe(id);
      expect(descriptor?.state).toBe('unavailable');
      expect(descriptor?.unavailabilityReason).toBe('expired');
    });

    it('maps a failed page read to the closed storage_failed code', async () => {
      const page = await f.lookup.findThreadPage({ threadId: f.threadId, limit: 0 });

      expect(page.isErr()).toBe(true);
      expect(page._unsafeUnwrapErr().code).toBe('storage_failed');
    });

    it('fails the page when the authority reports a storage fault on a row', async () => {
      f.seedImage({ state: 'available', receivedAt: T0 });

      const page = await f
        .lookupWithFault(() => true, 'simulated page-entry fault')
        .findThreadPage({ threadId: f.threadId, limit: 10 });

      expect(page.isErr()).toBe(true);
      expect(page._unsafeUnwrapErr().code).toBe('storage_failed');
    });

    it('keeps a non-storage refusal an omission, not a page failure', async () => {
      // An unknown/cross-thread-class refusal must stay indistinguishable from
      // a hidden Image: upgrading it to a page error would turn a deliberate
      // omission into an operational signal a caller could probe.
      const hidden = f.seedImage({ state: 'available', receivedAt: T0 });

      const page = await f
        .lookupWithFault((imageId) => imageId === hidden, 'simulated not_found', 'not_found')
        .findThreadPage({ threadId: f.threadId, limit: 10 });

      const images = page._unsafeUnwrap().images;
      expect(images).toHaveLength(0);
    });

    it('reports a row storage fault to the shipped handler instead of an empty list', async () => {
      // The real defect this pins: the adapter used to drop the failing row and
      // answer Ok, so the shipped handler never learned a read had failed and
      // returned a successful EMPTY inventory for a thread that has an Image.
      f.seedImage({ state: 'available', receivedAt: T0 });

      const failing = f.lookupWithFault(() => true, 'simulated page-entry fault');

      const result = await makeLookupHandler(f, failing).execute(
        { operation: 'list_images', limit: 5 },
        lookupContext(f),
      );

      expect(result.status).toBe('error');
      const errorText = (result as { error?: string }).error ?? '';
      expect(errorText).toContain('the image store could not be read');
      // Explicitly not the success-empty shape the bug produced.
      expect((result as { result?: unknown }).result).toBeUndefined();
    });

    it('still answers the shipped handler normally when no fault occurs', async () => {
      const id = f.seedImage({ state: 'available', receivedAt: T0, withFile: true });

      const result = await makeLookupHandler(f).execute(
        { operation: 'list_images', limit: 5 },
        lookupContext(f),
      );

      expect(result.status).toBe('success');
      const payload = (result as { result?: { images?: Array<{ imageId: string }> } }).result;
      expect(payload?.images?.map((image) => image.imageId)).toEqual([id]);
    });
  });
});

// ---------------------------------------------------------------------------
// Shipped-handler wiring for the page-fault regression
// ---------------------------------------------------------------------------

/**
 * Builds the REAL shipped {@link ImageLookupHandler} over the REAL
 * {@link ImageLookupAccessAdapter}, so a fault has to travel the exact path a
 * model-issued `list_images` travels: adapter page read → handler refresh →
 * response. Only the capability grant is stubbed, and it grants the full
 * `image.read:thread` label so the gate opens exactly as it does in production.
 */
function makeLookupHandler(
  f: Fixture,
  images: ImageLookupAccessAdapter = f.lookup,
): ImageLookupHandler {
  const personaName = 'image-context-test-persona';
  const capabilities: ResolvedCapabilities = { allow: ['image.read:thread'], requireApproval: [] };
  return new ImageLookupHandler({
    images,
    findings: f.findings,
    personaRepository: {
      findById: () => ok({ id: f.personaId, name: personaName }),
    } as unknown as Pick<PersonaRepository, 'findById'>,
    personaLoader: {
      getByName: () => ok({ name: personaName, resolvedCapabilities: capabilities }),
    } as unknown as Pick<PersonaLoader, 'getByName'>,
    logger: pino({ level: 'silent' }),
  });
}

/** A trusted context on the fixture thread, as the bridge would supply one. */
function lookupContext(f: Fixture): ToolExecutionContext {
  return { runId: f.runId, threadId: f.threadId, personaId: f.personaId, requestId: 'req-page' };
}
