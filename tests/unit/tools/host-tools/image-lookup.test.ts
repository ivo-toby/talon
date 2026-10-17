/**
 * Unit tests for the thread-scoped, model-free `image.lookup` handler (TASK-016).
 *
 * Deterministic fakes drive the port-level contract:
 *   - operations/fields/limits/IDs are validated before any port is touched;
 *   - the thread comes ONLY from the trusted ToolExecutionContext (a caller
 *     offering `threadId` — or any other field — is rejected, never honored);
 *   - `image.read:thread` is enforced fail-closed;
 *   - availability is refreshed BEFORE any Image output; Processing, unknown,
 *     and cross-thread IDs collapse into ONE indistinguishable not-found;
 *     Rejected and Unavailable keep full text access;
 *   - cursors are opaque and bound to operation + filter + thread;
 *   - `get_finding` returns the exact canonical Finding; nothing is clipped;
 *   - no pixels, paths, source references, or credentials ever appear;
 *   - `fetchInspectionBytes` is never called and no Finding is created.
 *
 * A real migrated SQLite database then pins the pagination contract:
 *   - `(timestamp DESC, ID ASC)` ordering with ACTUAL same-timestamp ties,
 *     walked across page boundaries without duplicates or gaps;
 *   - the real FindingRepository keyset under handler-issued cursors;
 *   - zero writes to the ledger across all four operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ok, err, type Result } from 'neverthrow';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

import { ImageLookupHandler } from '../../../../src/tools/host-tools/image-lookup.js';
import type {
  FindImagePageOptions,
  ImageLookupAccess,
  ImageLookupFindings,
  ImageLookupHandlerDeps,
  ImagePage,
} from '../../../../src/tools/host-tools/image-lookup.js';
import type {
  ImageAccessError,
  ImageAccessRequest,
  ImageAvailability,
  ImageDescriptor,
  ImageInspectionBytes,
} from '../../../../src/images/image-types.js';
import { toImageDescriptorDto } from '../../../../src/images/image-context-projection.js';
import type {
  FindingPage,
  FindingRecord,
  FindingRow,
} from '../../../../src/core/database/repositories/finding-repository.js';
import { DbError } from '../../../../src/core/errors/error-types.js';
import type { ResolvedCapabilities } from '../../../../src/personas/persona-types.js';
import type { PersonaRepository } from '../../../../src/core/database/repositories/persona-repository.js';
import type { PersonaLoader } from '../../../../src/personas/persona-loader.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';

import { ImageRepository } from '../../../../src/core/database/repositories/image-repository.js';
import type { ImageRow } from '../../../../src/core/database/repositories/image-repository.js';
import { FindingRepository } from '../../../../src/core/database/repositories/finding-repository.js';
import { ThreadRepository } from '../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../src/core/database/repositories/channel-repository.js';
import { MessageRepository } from '../../../../src/core/database/repositories/message-repository.js';
import { PersonaRepository as RealPersonaRepository } from '../../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../../src/core/database/repositories/run-repository.js';
import { BaseRepository } from '../../../../src/core/database/repositories/base-repository.js';
import { createTestDb, uuid } from '../../core/database/repositories/helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREAD = 'thread-owned-0001';
const OTHER_THREAD = 'thread-other-0002';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: THREAD,
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

/** Full available descriptor with metadata; overrides produce other states. */
function makeDescriptor(overrides: Partial<ImageDescriptor> = {}): ImageDescriptor {
  return {
    imageId: 'img-0001',
    threadId: THREAD,
    messageId: 'msg-0001',
    ordinal: 0,
    receivedAt: 1_700_000_100_000,
    expiresAt: 1_700_003_700_000,
    state: 'available',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    dimensions: { width: 1600, height: 1200 },
    ...overrides,
  } as ImageDescriptor;
}

function availabilityOf(descriptor: ImageDescriptor): Result<ImageAvailability, ImageAccessError> {
  switch (descriptor.state) {
    case 'available':
      return ok({ state: 'available', available: true, expiresAt: descriptor.expiresAt });
    case 'processing':
      return ok({ state: 'processing', available: false });
    case 'rejected':
      return ok({ state: 'rejected', available: false, rejectionReason: descriptor.rejectionReason });
    case 'unavailable':
      return ok({
        state: 'unavailable',
        available: false,
        unavailabilityReason: descriptor.unavailabilityReason,
      });
    default:
      return err({ code: 'storage_failed', message: 'unknown state' });
  }
}

interface FakeImageEntry {
  descriptor: ImageDescriptor;
  /** Overrides the derived availability (models a state change at refresh). */
  availability?: Result<ImageAvailability, ImageAccessError>;
}

/**
 * Deterministic ImageAccess + page-read fake. Records every port call in
 * order so the refresh-before-output contract is directly assertable. The
 * default `findThreadPage` implements the documented keyset contract
 * (receivedAt DESC, imageId ASC, Processing excluded) over the fixture map.
 */
class FakeImageAccess implements ImageLookupAccess {
  entries = new Map<string, FakeImageEntry>();
  calls: Array<'resolveImage' | 'getAvailability' | 'fetchInspectionBytes' | 'findThreadPage'> = [];
  callArgs: Array<{ method: string; args: unknown }> = [];
  /** When set, findThreadPage returns this verbatim (page-snapshot control). */
  pageResult: Result<ImagePage, ImageAccessError> | null = null;
  fetchBytesCalls = 0;

  add(descriptor: ImageDescriptor, availability?: Result<ImageAvailability, ImageAccessError>): void {
    this.entries.set(descriptor.imageId, { descriptor, availability });
  }

  private record(method: string, args: unknown): void {
    this.calls.push(method as (typeof this.calls)[number]);
    this.callArgs.push({ method, args });
  }

  async resolveImage(req: ImageAccessRequest): Promise<Result<ImageDescriptor, ImageAccessError>> {
    this.record('resolveImage', req);
    const entry = this.entries.get(req.imageId);
    if (!entry || entry.descriptor.threadId !== req.threadId) {
      return err({ code: 'not_found' });
    }
    return ok(entry.descriptor);
  }

  async getAvailability(
    req: ImageAccessRequest,
  ): Promise<Result<ImageAvailability, ImageAccessError>> {
    this.record('getAvailability', req);
    const entry = this.entries.get(req.imageId);
    if (!entry || entry.descriptor.threadId !== req.threadId) {
      return err({ code: 'not_found' });
    }
    return entry.availability ?? availabilityOf(entry.descriptor);
  }

  async fetchInspectionBytes(
    req: ImageAccessRequest,
  ): Promise<Result<ImageInspectionBytes, ImageAccessError>> {
    this.record('fetchInspectionBytes', req);
    this.fetchBytesCalls += 1;
    // A lookup must NEVER open an image file; reaching here also breaks the
    // enclosing assertion because the response turns into a storage error.
    return err({ code: 'storage_failed', message: 'image.lookup must never load pixels' });
  }

  async findThreadPage(
    options: FindImagePageOptions,
  ): Promise<Result<ImagePage, ImageAccessError>> {
    this.record('findThreadPage', options);
    if (this.pageResult) {
      return this.pageResult;
    }
    let list = [...this.entries.values()]
      .map((entry) => entry.descriptor)
      .filter((d) => d.threadId === options.threadId && d.state !== 'processing')
      .sort(
        (a, b) =>
          b.receivedAt - a.receivedAt ||
          (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0),
      );
    if (options.before) {
      const { receivedAt, imageId } = options.before;
      list = list.filter(
        (d) => d.receivedAt < receivedAt || (d.receivedAt === receivedAt && d.imageId > imageId),
      );
    }
    const images = list.slice(0, options.limit);
    const last = images[images.length - 1];
    const hasMore = list.length > options.limit;
    return ok({
      images,
      nextAnchor: hasMore && last ? { receivedAt: last.receivedAt, imageId: last.imageId } : null,
    });
  }

  methodsCalled(): string[] {
    return [...new Set(this.calls)];
  }
}

/**
 * Deterministic Finding ledger fake over the narrow lookup port. `create`
 * exists OUTSIDE the port and blows up if ever invoked — runtime proof that
 * lookup cannot create a Finding.
 */
class FakeFindings implements ImageLookupFindings {
  rows: Array<{ row: FindingRow; imageIds: string[] }> = [];
  calls: Array<'findPage' | 'findByIdInThread'> = [];
  callArgs: Array<{ method: string; args: unknown }> = [];
  findPageFailure = false;
  createCalls = 0;

  add(row: FindingRow, imageIds: string[]): void {
    this.rows.push({ row, imageIds });
  }

  findPage(options: Parameters<ImageLookupFindings['findPage']>[0]): Result<FindingPage, DbError> {
    this.calls.push('findPage');
    this.callArgs.push({ method: 'findPage', args: options });
    if (this.findPageFailure) {
      return err(new DbError('finding ledger temporarily unavailable (internal detail)'));
    }
    const limit = options.limit ?? 20;
    let list = this.rows.filter((r) => r.row.thread_id === options.threadId);
    if (options.imageId !== undefined) {
      list = list.filter((r) => r.imageIds.includes(options.imageId as string));
    }
    list.sort(
      (a, b) =>
        b.row.created_at - a.row.created_at ||
        (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
    );
    if (options.before) {
      const { createdAt, id } = options.before;
      list = list.filter(
        (r) =>
          r.row.created_at < createdAt ||
          (r.row.created_at === createdAt && r.row.id > id),
      );
    }
    const findings = list.slice(0, limit);
    const last = findings[findings.length - 1];
    const hasMore = list.length > limit;
    return ok({
      findings: findings.map((r) => ({ finding: r.row, imageIds: [...r.imageIds] })),
      nextAnchor:
        hasMore && last ? { createdAt: last.row.created_at, id: last.row.id } : null,
    });
  }

  findByIdInThread(
    findingId: string,
    threadId: string,
  ): Result<FindingRecord | null, DbError> {
    this.calls.push('findByIdInThread');
    this.callArgs.push({ method: 'findByIdInThread', args: { findingId, threadId } });
    const match = this.rows.find((r) => r.row.id === findingId && r.row.thread_id === threadId);
    if (!match) {
      return ok(null);
    }
    return ok({ finding: match.row, imageIds: [...match.imageIds] });
  }

  /** Not part of the port. Lookup cannot reference it; if it ever did, fail loudly. */
  create(): never {
    this.createCalls += 1;
    throw new Error('image.lookup must never create a Finding');
  }
}

function makeFindingRow(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    id: 'finding-0001',
    run_id: 'run-vision-0001',
    thread_id: THREAD,
    question: 'What text is on the sign?',
    answer: 'The sign reads: CAFE 24H.',
    extracted_text: 'CAFE 24H',
    uncertainty: null,
    model_name: 'gpt-5.3-vision',
    usage_input_tokens: 1200,
    usage_output_tokens: 45,
    usage_cache_read_tokens: null,
    usage_cache_write_tokens: null,
    created_at: 1_700_000_500_000,
    ...overrides,
  };
}

function personaDeps(caps: ResolvedCapabilities | 'unresolvable'): Pick<
  ImageLookupHandlerDeps,
  'personaRepository' | 'personaLoader'
> {
  if (caps === 'unresolvable') {
    return {
      personaRepository: {
        findById: vi.fn().mockReturnValue(err(new DbError('persona store down'))),
      } as unknown as Pick<PersonaRepository, 'findById'>,
      personaLoader: {
        getByName: vi.fn(),
      } as unknown as Pick<PersonaLoader, 'getByName'>,
    };
  }
  return {
    personaRepository: {
      findById: vi.fn().mockReturnValue(ok({ id: 'persona-001', name: 'assistant' })),
    } as unknown as Pick<PersonaRepository, 'findById'>,
    personaLoader: {
      getByName: vi.fn().mockReturnValue(
        ok({ name: 'assistant', resolvedCapabilities: caps }),
      ),
    } as unknown as Pick<PersonaLoader, 'getByName'>,
  };
}

interface Harness {
  handler: ImageLookupHandler;
  images: FakeImageAccess;
  findings: FakeFindings;
}

function makeHarness(
  caps: ResolvedCapabilities | 'unresolvable' = { allow: ['image.read:thread'], requireApproval: [] },
): Harness {
  const images = new FakeImageAccess();
  const findings = new FakeFindings();
  const handler = new ImageLookupHandler({
    images,
    findings,
    ...personaDeps(caps),
    logger: makeLogger(),
  });
  return { handler, images, findings };
}

/** Unwraps a success result payload; fails the test on error. */
function payloadOf(result: Awaited<ReturnType<ImageLookupHandler['execute']>>): any {
  expect(result.status, `expected success, got error: ${String(result.error)}`).toBe('success');
  return result.result;
}

function errorOf(result: Awaited<ReturnType<ImageLookupHandler['execute']>>): string {
  expect(result.status).toBe('error');
  return result.error as string;
}

// ---------------------------------------------------------------------------
// Real-SQLite adapter: the documented page contract over actual rows
// ---------------------------------------------------------------------------

/** Test-side adapter implementing ImageLookupAccess with real keyset SQL. */
class SqliteImageAccess implements ImageLookupAccess {
  constructor(private readonly db: Database.Database) {}

  async findThreadPage(
    options: FindImagePageOptions,
  ): Promise<Result<ImagePage, ImageAccessError>> {
    try {
      const rows = (
        options.before
          ? this.db.prepare(
              `SELECT * FROM images
               WHERE thread_id = ? AND state != 'processing'
                 AND (received_at < ? OR (received_at = ? AND id > ?))
               ORDER BY received_at DESC, id ASC
               LIMIT ?`,
            ).all(
              options.threadId,
              options.before.receivedAt,
              options.before.receivedAt,
              options.before.imageId,
              options.limit + 1,
            )
          : this.db.prepare(
              `SELECT * FROM images
               WHERE thread_id = ? AND state != 'processing'
               ORDER BY received_at DESC, id ASC
               LIMIT ?`,
            ).all(options.threadId, options.limit + 1)
      ) as ImageRow[];
      const hasMore = rows.length > options.limit;
      const page = hasMore ? rows.slice(0, options.limit) : rows;
      const last = page[page.length - 1];
      return ok({
        images: page.map(rowToDescriptor),
        nextAnchor:
          hasMore && last ? { receivedAt: last.received_at, imageId: last.id } : null,
      });
    } catch (cause) {
      return err({ code: 'storage_failed', message: String(cause) });
    }
  }

  async resolveImage(req: ImageAccessRequest): Promise<Result<ImageDescriptor, ImageAccessError>> {
    const row = this.db
      .prepare('SELECT * FROM images WHERE id = ? AND thread_id = ?')
      .get(req.imageId, req.threadId) as ImageRow | undefined;
    if (!row) {
      return err({ code: 'not_found' });
    }
    return ok(rowToDescriptor(row));
  }

  async getAvailability(
    req: ImageAccessRequest,
  ): Promise<Result<ImageAvailability, ImageAccessError>> {
    const row = this.db
      .prepare('SELECT * FROM images WHERE id = ? AND thread_id = ?')
      .get(req.imageId, req.threadId) as ImageRow | undefined;
    if (!row) {
      return err({ code: 'not_found' });
    }
    // State is read from the row; expiry policy itself belongs to the real
    // adapter, so tests drive state changes through the ledger instead.
    return availabilityOf(rowToDescriptor(row));
  }

  async fetchInspectionBytes(
    _req: ImageAccessRequest,
  ): Promise<Result<ImageInspectionBytes, ImageAccessError>> {
    return err({ code: 'storage_failed', message: 'image.lookup must never load pixels' });
  }
}

function rowToDescriptor(row: ImageRow): ImageDescriptor {
  return {
    imageId: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    ordinal: row.ordinal,
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    state: row.state,
    ...(row.filename !== null ? { filename: row.filename } : {}),
    ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}),
    ...(row.width !== null && row.height !== null
      ? { dimensions: { width: row.width, height: row.height } }
      : {}),
    ...(row.exif !== null ? { exif: JSON.parse(row.exif) } : {}),
    ...(row.state === 'rejected' && row.rejection_reason !== null
      ? { rejectionReason: row.rejection_reason }
      : {}),
    ...(row.state === 'unavailable' && row.unavailability_reason !== null
      ? { unavailabilityReason: row.unavailability_reason }
      : {}),
  } as ImageDescriptor;
}

// ===========================================================================
// 1. Argument surface: operation, fields, IDs, limits — validated pre-port
// ===========================================================================

describe('image.lookup: operation and field validation', () => {
  it('rejects an unknown or missing operation without touching a port', async () => {
    for (const operation of [undefined, '', 'list-images', 'LIST_IMAGES', 'list', 42]) {
      const { handler, images, findings } = makeHarness();
      const error = errorOf(await handler.execute({ operation } as never, makeContext()));
      expect(error).toContain('invalid operation');
      expect(images.calls).toEqual([]);
      expect(findings.calls).toEqual([]);
    }
  });

  it('rejects any field outside the operation allowlist without touching a port', async () => {
    const cases: Array<Record<string, unknown>> = [
      // Caller thread override attempts — the core prohibition.
      { operation: 'list_images', threadId: OTHER_THREAD },
      { operation: 'get_image', imageId: 'img-0001', thread_id: OTHER_THREAD },
      { operation: 'list_findings', personaId: 'persona-999' },
      { operation: 'get_finding', findingId: 'f-1', runId: 'run-999' },
      // Location/provenance smuggling.
      { operation: 'get_image', imageId: 'img-0001', path: '/var/lib/talon/x.jpg' },
      { operation: 'get_image', imageId: 'img-0001', url: 'https://cdn.example/x.jpg' },
      { operation: 'list_images', sourceRef: 'src-1' },
      // Cross-operation field bleed.
      { operation: 'get_image', imageId: 'img-1', limit: 5 },
      { operation: 'list_images', imageId: 'img-1' },
      { operation: 'get_finding', findingId: 'f-1', cursor: 'abc' },
      // Unknown junk.
      { operation: 'list_images', debug: true },
    ];
    for (const args of cases) {
      const { handler, images, findings } = makeHarness();
      const error = errorOf(await handler.execute(args as never, makeContext()));
      expect(error).toMatch(/not (an )?accepted/);
      expect(images.calls).toEqual([]);
      expect(findings.calls).toEqual([]);
    }
  });

  it('names the trusted-context fields specifically when a caller offers them', async () => {
    const { handler } = makeHarness();
    const error = errorOf(
      await handler.execute({ operation: 'list_images', threadId: OTHER_THREAD } as never, makeContext()),
    );
    expect(error).toContain('trusted execution context');
  });

  it('requires an exact plain-opaque ID and rejects paths, URLs, and blobs', async () => {
    for (const badId of ['', 'img/0001', '../etc/passwd', 'https://x.example/i.jpg', 'data:image/png;base64,AAAA', 42, null]) {
      const { handler, images } = makeHarness();
      const error = errorOf(
        await handler.execute({ operation: 'get_image', imageId: badId } as never, makeContext()),
      );
      expect(error).toContain('plain opaque ID');
      expect(images.calls).toEqual([]);
    }
  });

  it('enforces the 1–100 integer limit bound and defaults to 20', async () => {
    for (const badLimit of [0, -1, 101, 1.5, '20', true, null]) {
      const { handler, images } = makeHarness();
      const error = errorOf(
        await handler.execute({ operation: 'list_images', limit: badLimit } as never, makeContext()),
      );
      expect(error).toContain('limit must be an integer between 1 and 100');
      expect(images.calls).toEqual([]);
    }

    // Default limit: 25 seeded images → first page of exactly 20 with a cursor.
    const { handler, images } = makeHarness();
    for (let i = 0; i < 25; i += 1) {
      images.add(makeDescriptor({ imageId: `img-${String(i).padStart(4, '0')}`, receivedAt: 1_700_000_000_000 + i }));
    }
    const first = payloadOf(await handler.execute({ operation: 'list_images' }, makeContext()));
    expect(first.images).toHaveLength(20);
    expect(typeof first.nextCursor).toBe('string');
  });

  it('accepts limit 1 and 100 at the bounds', async () => {
    const { handler, images } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-0001' }));
    for (const limit of [1, 100]) {
      const result = await handler.execute({ operation: 'list_images', limit }, makeContext());
      expect(result.status).toBe('success');
    }
  });
});

// ===========================================================================
// 2. Capability: image.read:thread, fail-closed
// ===========================================================================

describe('image.lookup: capability enforcement', () => {
  it('denies a persona without image.read:thread and touches no port', async () => {
    const { handler, images, findings } = makeHarness({
      allow: ['memory.read:thread', 'subagent.invoke', 'channel.send'],
      requireApproval: [],
    });
    images.add(makeDescriptor());
    const error = errorOf(await handler.execute({ operation: 'list_images' }, makeContext()));
    expect(error).toContain('image.read:thread');
    expect(images.calls).toEqual([]);
    expect(findings.calls).toEqual([]);
  });

  it('grants the bare image.read prefix label', async () => {
    const { handler, images } = makeHarness({ allow: ['image.read'], requireApproval: [] });
    images.add(makeDescriptor());
    expect(payloadOf(await handler.execute({ operation: 'list_images' }, makeContext())).images).toHaveLength(1);
  });

  it('treats an approval-gated image.read:thread as permitted for this read-only exposure', async () => {
    const { handler, images } = makeHarness({ allow: [], requireApproval: ['image.read:thread'] });
    images.add(makeDescriptor());
    expect(payloadOf(await handler.execute({ operation: 'get_image', imageId: 'img-0001' }, makeContext())).image).toBeDefined();
  });

  it('fails closed when the persona cannot be resolved', async () => {
    const cases: Array<{ find: Result<unknown, DbError>; load: Result<unknown, unknown> }> = [
      { find: err(new DbError('store down')), load: ok({}) },
      { find: ok(null), load: ok({}) },
      { find: ok({ id: 'p', name: 'ghost' }), load: ok(undefined) },
      { find: ok({ id: 'p', name: 'ghost' }), load: err(new Error('loader failure')) },
    ];
    for (const c of cases) {
      const images = new FakeImageAccess();
      images.add(makeDescriptor());
      const handler = new ImageLookupHandler({
        images,
        findings: new FakeFindings(),
        personaRepository: { findById: vi.fn().mockReturnValue(c.find) } as unknown as Pick<PersonaRepository, 'findById'>,
        personaLoader: { getByName: vi.fn().mockReturnValue(c.load) } as unknown as Pick<PersonaLoader, 'getByName'>,
        logger: makeLogger(),
      });
      const error = errorOf(await handler.execute({ operation: 'list_images' }, makeContext()));
      expect(error).toContain('not granted');
      expect(images.calls).toEqual([]);
    }
  });
});

// ===========================================================================
// 3. Thread scoping: trusted context only
// ===========================================================================

describe('image.lookup: thread scoping', () => {
  it('reads with the trusted context thread and never returns foreign-thread rows', async () => {
    const { handler, images, findings } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-own' }));
    images.add(makeDescriptor({ imageId: 'img-foreign', threadId: OTHER_THREAD }));
    findings.add(makeFindingRow({ id: 'f-own' }), ['img-own']);
    findings.add(makeFindingRow({ id: 'f-foreign', thread_id: OTHER_THREAD }), ['img-own']);

    const listed = payloadOf(await handler.execute({ operation: 'list_images' }, makeContext()));
    expect(listed.images.map((d: { imageId: string }) => d.imageId)).toEqual(['img-own']);
    expect(images.callArgs[0]?.args).toEqual({ threadId: THREAD, limit: 20, before: null });

    const findingsList = payloadOf(await handler.execute({ operation: 'list_findings' }, makeContext()));
    expect(findingsList.findings.map((f: { findingId: string }) => f.findingId)).toEqual(['f-own']);
    expect(findings.callArgs[0]?.args).toMatchObject({ threadId: THREAD });
  });

  it('collapses unknown, cross-thread, and Processing IDs into ONE not-found error', async () => {
    const { handler, images } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-proc', state: 'processing' }));
    images.add(makeDescriptor({ imageId: 'img-foreign', threadId: OTHER_THREAD }));

    const unknown = errorOf(await handler.execute({ operation: 'get_image', imageId: 'img-nope' }, makeContext()));
    const crossThread = errorOf(await handler.execute({ operation: 'get_image', imageId: 'img-foreign' }, makeContext()));
    const processing = errorOf(await handler.execute({ operation: 'get_image', imageId: 'img-proc' }, makeContext()));
    // Byte-identical, so no response difference can distinguish the three.
    expect(unknown).toBe(crossThread);
    expect(unknown).toBe(processing);
    // The hidden-state path must not even read the descriptor after refresh.
    expect(images.calls).toEqual(['getAvailability', 'getAvailability', 'getAvailability']);
  });

  it('hides Processing entries from list_images', async () => {
    const { handler, images } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-1', receivedAt: 300 }));
    images.add(makeDescriptor({ imageId: 'img-2', receivedAt: 200, state: 'processing' }));
    const listed = payloadOf(await handler.execute({ operation: 'list_images' }, makeContext()));
    expect(listed.images.map((d: { imageId: string }) => d.imageId)).toEqual(['img-1']);
  });

  it('never distinguishes a cross-thread finding from an unknown one', async () => {
    const { handler, findings } = makeHarness();
    findings.add(makeFindingRow({ id: 'f-foreign', thread_id: OTHER_THREAD }), ['img-1']);
    const foreign = errorOf(await handler.execute({ operation: 'get_finding', findingId: 'f-foreign' }, makeContext()));
    const unknown = errorOf(await handler.execute({ operation: 'get_finding', findingId: 'f-nope' }, makeContext()));
    expect(foreign).toBe(unknown);
    expect(foreign).toContain('no finding');
  });
});

// ===========================================================================
// 4. Availability refresh before Image output
// ===========================================================================

describe('image.lookup: availability refresh', () => {
  it('refreshes availability before resolving the emitted descriptor', async () => {
    const { handler, images } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-0001' }));
    payloadOf(await handler.execute({ operation: 'get_image', imageId: 'img-0001' }, makeContext()));
    expect(images.calls).toEqual(['getAvailability', 'resolveImage']);
  });

  it('refreshes every list entry after the page read, before output', async () => {
    const { handler, images } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-1', receivedAt: 300 }));
    images.add(makeDescriptor({ imageId: 'img-2', receivedAt: 200 }));
    payloadOf(await handler.execute({ operation: 'list_images' }, makeContext()));
    expect(images.calls).toEqual([
      'findThreadPage',
      'getAvailability',
      'resolveImage',
      'getAvailability',
      'resolveImage',
    ]);
  });

  it('drops an entry the refresh reports gone (not_found at refresh time)', async () => {
    const { handler, images } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-1', receivedAt: 300 }));
    images.add(makeDescriptor({ imageId: 'img-2', receivedAt: 200 }));
    // The page snapshot contains img-2, but by output time its row is gone.
    images.entries.get('img-2')!.descriptor = { ...makeDescriptor({ imageId: 'img-2', receivedAt: 200, threadId: OTHER_THREAD }) };
    const listed = payloadOf(await handler.execute({ operation: 'list_images' }, makeContext()));
    expect(listed.images.map((d: { imageId: string }) => d.imageId)).toEqual(['img-1']);
  });

  it('hides an entry that entered Processing between page read and refresh', async () => {
    const { handler, images } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-1', receivedAt: 300 }));
    images.add(
      makeDescriptor({ imageId: 'img-2', receivedAt: 200 }),
      ok({ state: 'processing', available: false }),
    );
    const listed = payloadOf(await handler.execute({ operation: 'list_images' }, makeContext()));
    expect(listed.images.map((d: { imageId: string }) => d.imageId)).toEqual(['img-1']);
  });

  it('hides a descriptor that leaked Processing past the adapter', async () => {
    const { handler, images } = makeHarness();
    // Availability says Processing is invisible… but even if the port answered
    // Ok(processing) for availability=available + descriptor=processing, the
    // handler still must not emit it.
    images.add(
      makeDescriptor({ imageId: 'img-leak', state: 'processing' }),
      ok({ state: 'available', available: true, expiresAt: 999 }),
    );
    const error = errorOf(await handler.execute({ operation: 'get_image', imageId: 'img-leak' }, makeContext()));
    expect(error).toContain('no image');
  });

  it('keeps full text access for Rejected and Unavailable Images', async () => {
    const { handler, images } = makeHarness();
    images.add(
      makeDescriptor({ imageId: 'img-rej', state: 'rejected', rejectionReason: 'size_limit' as never }),
    );
    images.add(
      makeDescriptor({ imageId: 'img-exp', state: 'unavailable', unavailabilityReason: 'expired' as never }),
    );

    const rejected = payloadOf(await handler.execute({ operation: 'get_image', imageId: 'img-rej' }, makeContext()));
    expect(rejected.image.state).toBe('rejected');
    expect(rejected.image.rejectionReason).toBe('size_limit');

    const expired = payloadOf(await handler.execute({ operation: 'get_image', imageId: 'img-exp' }, makeContext()));
    expect(expired.image.state).toBe('unavailable');
    expect(expired.image.unavailabilityReason).toBe('expired');

    const listed = payloadOf(await handler.execute({ operation: 'list_images' }, makeContext()));
    expect(listed.images.map((d: { imageId: string }) => d.imageId).sort()).toEqual(['img-exp', 'img-rej']);
  });

  it('permits text access even when the port reports terminal states as errors', async () => {
    const { handler, images } = makeHarness();
    images.add(
      makeDescriptor({ imageId: 'img-rej', state: 'rejected', rejectionReason: 'download_failed' as never }),
      err({ code: 'rejected', rejectionReason: 'download_failed' as never }),
    );
    const rejected = payloadOf(await handler.execute({ operation: 'get_image', imageId: 'img-rej' }, makeContext()));
    expect(rejected.image.state).toBe('rejected');
  });

  it('reports a generic storage error without echoing internal failure text', async () => {
    const internalMessage = 'SQLITE_CORRUPT: /var/lib/talon/private.db page 42 damaged';

    const a = makeHarness();
    a.images.add(makeDescriptor(), err({ code: 'storage_failed', message: internalMessage }));
    const e1 = errorOf(await a.handler.execute({ operation: 'get_image', imageId: 'img-0001' }, makeContext()));
    expect(e1).toContain('could not be read');
    expect(e1).not.toContain('SQLITE');
    expect(e1).not.toContain('/var/lib');

    const b = makeHarness();
    b.images.pageResult = err({ code: 'storage_failed', message: internalMessage });
    const e2 = errorOf(await b.handler.execute({ operation: 'list_images' }, makeContext()));
    expect(e2).toContain('could not be read');
    expect(e2).not.toContain('SQLITE');

    const c = makeHarness();
    c.findings.findPageFailure = true;
    const e3 = errorOf(await c.handler.execute({ operation: 'list_findings' }, makeContext()));
    expect(e3).toContain('could not be read');
    expect(e3).not.toContain('internal detail');
  });
});

// ===========================================================================
// 5. Cursors: opaque, bound to operation + filter + thread
// ===========================================================================

describe('image.lookup: cursor binding', () => {
  /** Seed 5 images and return the cursor after the first page of 2. */
  async function firstImagesCursor(): Promise<{ cursor: string; harness: Harness }> {
    const harness = makeHarness();
    for (let i = 1; i <= 5; i += 1) {
      harness.images.add(makeDescriptor({ imageId: `img-${i}`, receivedAt: 1000 - i }));
    }
    const page = payloadOf(await harness.handler.execute({ operation: 'list_images', limit: 2 }, makeContext()));
    expect(page.nextCursor).toBeTypeOf('string');
    expect(page.images.map((d: { imageId: string }) => d.imageId)).toEqual(['img-1', 'img-2']);
    return { cursor: page.nextCursor, harness };
  }

  async function firstFindingsCursor(imageId?: string): Promise<string> {
    const harness = makeHarness();
    harness.images.add(makeDescriptor({ imageId: imageId ?? 'img-src' }));
    for (let i = 1; i <= 5; i += 1) {
      harness.findings.add(
        makeFindingRow({ id: `finding-${i}`, created_at: 2000 - i }),
        imageId !== undefined ? [imageId] : ['img-src'],
      );
    }
    const page = payloadOf(
      await harness.handler.execute(
        { operation: 'list_findings', limit: 2, ...(imageId !== undefined ? { imageId } : {}) } as never,
        makeContext(),
      ),
    );
    return page.nextCursor;
  }

  it('continues pagination without duplicates or gaps', async () => {
    const { cursor, harness } = await firstImagesCursor();
    const seen: string[] = [];
    let next: string | null = cursor;
    while (next !== null) {
      const page = payloadOf(
        await harness.handler.execute({ operation: 'list_images', limit: 2, cursor: next }, makeContext()),
      );
      seen.push(...page.images.map((d: { imageId: string }) => d.imageId));
      next = page.nextCursor;
    }
    // Pages 2..3 continue strictly after the cursor position.
    expect(seen).toEqual(['img-3', 'img-4', 'img-5']);
  });

  it('rejects a list_images cursor used for list_findings (cross-operation)', async () => {
    const { cursor } = await firstImagesCursor();
    const { handler } = makeHarness();
    const error = errorOf(await handler.execute({ operation: 'list_findings', cursor }, makeContext()));
    expect(error).toContain('different operation');
  });

  it('rejects a list_findings cursor used for list_images (cross-operation)', async () => {
    const cursor = await firstFindingsCursor();
    const { handler } = makeHarness();
    const error = errorOf(await handler.execute({ operation: 'list_images', cursor }, makeContext()));
    expect(error).toContain('different operation');
  });

  it('rejects an unfiltered cursor replayed with an imageId filter (cross-filter)', async () => {
    const cursor = await firstFindingsCursor();
    const { handler, images } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-filter' }));
    const error = errorOf(
      await handler.execute({ operation: 'list_findings', imageId: 'img-filter', cursor }, makeContext()),
    );
    expect(error).toContain('different filter');
  });

  it('rejects a filtered cursor replayed without the filter (cross-filter)', async () => {
    const cursor = await firstFindingsCursor('img-filter');
    const { handler } = makeHarness();
    const error = errorOf(await handler.execute({ operation: 'list_findings', cursor }, makeContext()));
    expect(error).toContain('different filter');
  });

  it('rejects a cursor issued for another thread (cross-thread)', async () => {
    const harness = makeHarness();
    for (let i = 1; i <= 5; i += 1) {
      harness.images.add(makeDescriptor({ imageId: `img-${i}`, receivedAt: 1000 - i }));
    }
    const foreignPage = payloadOf(
      await harness.handler.execute({ operation: 'list_images', limit: 2 }, makeContext({ threadId: OTHER_THREAD })),
    );
    // The foreign thread has no images: no cursor. Seed it there instead.
    expect(foreignPage.nextCursor).toBeNull();

    const other = makeHarness();
    for (let i = 1; i <= 5; i += 1) {
      other.images.add(makeDescriptor({ imageId: `oth-${i}`, threadId: OTHER_THREAD, receivedAt: 1000 - i }));
    }
    const issued = payloadOf(
      await other.handler.execute({ operation: 'list_images', limit: 2 }, makeContext({ threadId: OTHER_THREAD })),
    );
    const error = errorOf(
      await other.handler.execute({ operation: 'list_images', limit: 2, cursor: issued.nextCursor }, makeContext()),
    );
    expect(error).toContain('different thread');
  });

  it('rejects malformed cursors without touching a port', async () => {
    const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const valid = { v: 1, op: 'list_images', filter: null, thread: THREAD, at: 999, id: 'img-1' };
    const malformed: unknown[] = [
      'not-a-real-cursor!!',
      '####',
      b64('a string'),
      b64([1, 2, 3]),
      b64({ ...valid, v: 2 }),
      b64({ ...valid, op: 'get_image' }),
      b64({ ...valid, extra: 'x' }),
      b64({ op: 'list_images', filter: null, thread: THREAD, at: 999, id: 'img-1' }),
      b64({ ...valid, at: 1.5 }),
      b64({ ...valid, at: '999' }),
      b64({ ...valid, id: 'bad/id' }),
      b64({ ...valid, filter: 42 }),
      '',
    ];
    for (const cursor of malformed) {
      const { handler, images } = makeHarness();
      const error = errorOf(
        await handler.execute({ operation: 'list_images', cursor } as never, makeContext()),
      );
      expect(error).toContain('invalid cursor');
      expect(images.calls).toEqual([]);
    }
  });

  // Node's base64url decoder silently drops `!`, whitespace, and padding and
  // ignores redundant trailing bits, so these byte-level corruptions of a
  // STILL-VALID issued cursor used to decode to the same envelope and be
  // honored. Canonical-encoding validation must reject them before any port.
  it('rejects byte-level corruptions of an issued cursor without touching a port', async () => {
    const { cursor } = await firstImagesCursor();
    const corruptions: Array<{ label: string; corrupt: (c: string) => string }> = [
      { label: "'!' suffix", corrupt: (c) => `${c}!` },
      { label: "'~' suffix", corrupt: (c) => `${c}~` },
      { label: 'inserted whitespace', corrupt: (c) => `${c.slice(0, 4)} ${c.slice(4)}` },
      { label: "trailing '=' padding", corrupt: (c) => `${c}=` },
      { label: 'leading newline', corrupt: (c) => `\n${c}` },
      { label: 'trailing space', corrupt: (c) => `${c} ` },
    ];
    for (const t of corruptions) {
      const fresh = makeHarness();
      for (let i = 1; i <= 5; i += 1) {
        fresh.images.add(makeDescriptor({ imageId: `img-${i}`, receivedAt: 1000 - i }));
      }
      const error = errorOf(
        await fresh.handler.execute(
          { operation: 'list_images', limit: 2, cursor: t.corrupt(cursor) } as never,
          makeContext(),
        ),
      );
      expect(error, t.label).toContain('invalid cursor');
      // Empty call log covers resolveImage, getAvailability, and
      // findThreadPage alike — no port is touched at all.
      expect(fresh.images.calls, t.label).toEqual([]);
    }
  });

  it('rejects a byte-corrupted list_findings cursor without touching a port', async () => {
    const cursor = await firstFindingsCursor();
    const fresh = makeHarness();
    const error = errorOf(
      await fresh.handler.execute(
        { operation: 'list_findings', limit: 2, cursor: `${cursor}!` } as never,
        makeContext(),
      ),
    );
    expect(error).toContain('invalid cursor');
    expect(fresh.findings.calls).toEqual([]);
  });

  it('still accepts the pristine issued cursor after rejecting its corruptions', async () => {
    const { cursor, harness } = await firstImagesCursor();
    const page = payloadOf(
      await harness.handler.execute({ operation: 'list_images', limit: 2, cursor }, makeContext()),
    );
    expect(page.images.map((d: { imageId: string }) => d.imageId)).toEqual(['img-3', 'img-4']);
  });
});

// ===========================================================================
// 6. list_images / get_image result shape (full public DTO)
// ===========================================================================

describe('image.lookup: image results', () => {
  it('returns the complete public DTO with explicit nulls, never a clipped excerpt', async () => {
    const { handler, images } = makeHarness();
    const longName = 'x'.repeat(300) + '.jpg';
    const descriptor = makeDescriptor({
      imageId: 'img-full',
      filename: longName,
      exif: {
        gps: { latitude: 48.8584, longitude: 2.2945, altitude: 35.4, altitudeRef: 'aboveSeaLevel' },
        capturedAt: '2026-03-01 09:15:23',
        capturedAtOffset: '+02:00',
        cameraMake: 'ACME',
        cameraModel: 'ShotMaster 9000',
        orientation: 6,
      },
    });
    images.add(descriptor);
    const result = payloadOf(await handler.execute({ operation: 'get_image', imageId: 'img-full' }, makeContext()));
    // Byte-for-byte the TASK-015 full descriptor DTO — not the budgeted line.
    expect(result.image).toStrictEqual(toImageDescriptorDto(descriptor));
    expect(result.image.filename).toBe(longName);
    expect(result.image.exif.gps.latitude).toBe(48.8584);
    expect(result.image.receivedAt).toBe(new Date(1_700_000_100_000).toISOString());
  });

  it('renders unknown optional fields as explicit nulls', async () => {
    const { handler, images } = makeHarness();
    images.add(
      {
        imageId: 'img-bare',
        threadId: THREAD,
        messageId: 'msg-0001',
        ordinal: 0,
        receivedAt: 1000,
        expiresAt: 2000,
        state: 'available',
      } as ImageDescriptor,
    );
    const result = payloadOf(await handler.execute({ operation: 'get_image', imageId: 'img-bare' }, makeContext()));
    expect(result.image).toStrictEqual({
      imageId: 'img-bare',
      threadId: THREAD,
      messageId: 'msg-0001',
      ordinal: 0,
      receivedAt: new Date(1000).toISOString(),
      expiresAt: new Date(2000).toISOString(),
      state: 'available',
      rejectionReason: null,
      unavailabilityReason: null,
      filename: null,
      mimeType: null,
      width: null,
      height: null,
      exif: null,
    });
  });

  it('never emits source references, paths, bytes, or credentials in any response', async () => {
    const { handler, images, findings } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-1', receivedAt: 300 }));
    findings.add(makeFindingRow({ id: 'f-1' }), ['img-1']);

    const responses = [
      await handler.execute({ operation: 'list_images' }, makeContext()),
      await handler.execute({ operation: 'get_image', imageId: 'img-1' }, makeContext()),
      await handler.execute({ operation: 'list_findings' }, makeContext()),
      await handler.execute({ operation: 'list_findings', imageId: 'img-1' }, makeContext()),
      await handler.execute({ operation: 'get_finding', findingId: 'f-1' }, makeContext()),
    ];
    const forbidden = ['source', 'path', 'staging', 'credential', 'secret', 'bytes', '/var', 'digest', 'base64'];
    for (const response of responses) {
      const serialized = JSON.stringify(response).toLowerCase();
      for (const needle of forbidden) {
        expect(serialized, `response leaked "${needle}": ${serialized}`).not.toContain(needle);
      }
      // No key literally named token/secret/key may ever appear.
      expect(serialized).not.toMatch(/"(token|secret|apikey|accesstoken)"/);
    }
  });

  it('never loads image file bytes for any operation', async () => {
    const { handler, images, findings } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-1', receivedAt: 300 }));
    findings.add(makeFindingRow({ id: 'f-1' }), ['img-1']);
    await handler.execute({ operation: 'list_images' }, makeContext());
    await handler.execute({ operation: 'get_image', imageId: 'img-1' }, makeContext());
    await handler.execute({ operation: 'list_findings' }, makeContext());
    await handler.execute({ operation: 'get_finding', findingId: 'f-1' }, makeContext());
    expect(images.fetchBytesCalls).toBe(0);
    expect(images.methodsCalled()).not.toContain('fetchInspectionBytes');
  });
});

// ===========================================================================
// 7. Findings: summaries, exact canonical retrieval, imageId filter
// ===========================================================================

describe('image.lookup: findings', () => {
  it('lists summary entries without answer or extracted text', async () => {
    const { handler, findings } = makeHarness();
    findings.add(makeFindingRow({ id: 'f-1', created_at: 500 }), ['img-1']);
    const listed = payloadOf(await handler.execute({ operation: 'list_findings' }, makeContext()));
    expect(listed.findings).toStrictEqual([
      {
        findingId: 'f-1',
        imageIds: ['img-1'],
        question: 'What text is on the sign?',
        createdAt: new Date(500).toISOString(),
        modelName: 'gpt-5.3-vision',
      },
    ]);
    expect(listed.nextCursor).toBeNull();
  });

  it('filters by imageId and scopes the page to the trusted thread', async () => {
    const { handler, images, findings } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-a' }));
    findings.add(makeFindingRow({ id: 'f-a' }), ['img-a', 'img-b']);
    findings.add(makeFindingRow({ id: 'f-b' }), ['img-other']);
    const listed = payloadOf(
      await handler.execute({ operation: 'list_findings', imageId: 'img-a' }, makeContext()),
    );
    expect(listed.findings.map((f: { findingId: string }) => f.findingId)).toEqual(['f-a']);
    expect(findings.callArgs[0]?.args).toMatchObject({ threadId: THREAD, imageId: 'img-a' });
    // The filter Image itself was verified against the trusted thread.
    expect(images.calls).toEqual(['getAvailability']);
  });

  it('rejects an imageId filter the thread cannot see, without reading findings', async () => {
    const errors: string[] = [];
    for (const hidden of [
      { imageId: 'img-unknown' },
      { imageId: 'img-foreign', descriptor: makeDescriptor({ imageId: 'img-foreign', threadId: OTHER_THREAD }) },
      { imageId: 'img-proc', descriptor: makeDescriptor({ imageId: 'img-proc', state: 'processing' }) },
    ]) {
      const { handler, images, findings } = makeHarness();
      if (hidden.descriptor) {
        images.add(hidden.descriptor);
      }
      const error = errorOf(
        await handler.execute({ operation: 'list_findings', imageId: hidden.imageId } as never, makeContext()),
      );
      expect(error).toContain('no image');
      expect(findings.calls).toEqual([]);
      errors.push(error);
    }
    // Unknown, cross-thread, and Processing filters are one identical answer.
    expect(errors[0]).toBe(errors[1]);
    expect(errors[1]).toBe(errors[2]);
  });

  it('allows an imageId filter on Rejected/Unavailable Images (text access)', async () => {
    const { handler, images, findings } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-exp', state: 'unavailable', unavailabilityReason: 'expired' as never }));
    findings.add(makeFindingRow({ id: 'f-1' }), ['img-exp']);
    const listed = payloadOf(
      await handler.execute({ operation: 'list_findings', imageId: 'img-exp' }, makeContext()),
    );
    expect(listed.findings).toHaveLength(1);
  });

  it('returns the exact canonical Finding, verbatim and unclipped', async () => {
    const { handler, findings } = makeHarness();
    const longAnswer = 'Line1: café ✓\n' + 'x'.repeat(5000) + '\nEnd.';
    findings.add(
      makeFindingRow({
        id: 'f-full',
        answer: longAnswer,
        extracted_text: 'NAME=Ivo\nID=1234',
        uncertainty: 'the second line could read 1234 or 1239',
        usage_input_tokens: 4000,
        usage_output_tokens: 900,
        usage_cache_read_tokens: 0,
        usage_cache_write_tokens: null,
      }),
      ['img-b', 'img-a'],
    );
    const result = payloadOf(await handler.execute({ operation: 'get_finding', findingId: 'f-full' }, makeContext()));
    expect(result.finding).toStrictEqual({
      findingId: 'f-full',
      threadId: THREAD,
      runId: 'run-vision-0001',
      imageIds: ['img-b', 'img-a'],
      question: 'What text is on the sign?',
      answer: longAnswer,
      extractedText: 'NAME=Ivo\nID=1234',
      uncertainty: 'the second line could read 1234 or 1239',
      createdAt: 1_700_000_500_000,
      modelName: 'gpt-5.3-vision',
      usage: { inputTokens: 4000, outputTokens: 900, cacheReadTokens: 0 },
    });
  });

  it('omits absent optional Finding fields instead of inventing them', async () => {
    const { handler, findings } = makeHarness();
    findings.add(
      makeFindingRow({
        id: 'f-min',
        extracted_text: null,
        uncertainty: null,
        usage_input_tokens: null,
        usage_output_tokens: null,
        usage_cache_read_tokens: null,
        usage_cache_write_tokens: null,
      }),
      ['img-1'],
    );
    const result = payloadOf(await handler.execute({ operation: 'get_finding', findingId: 'f-min' }, makeContext()));
    expect(Object.keys(result.finding).sort()).toStrictEqual(
      ['answer', 'createdAt', 'findingId', 'imageIds', 'modelName', 'question', 'runId', 'threadId'].sort(),
    );
  });

  it('never creates a Finding through any operation', async () => {
    const { handler, images, findings } = makeHarness();
    images.add(makeDescriptor({ imageId: 'img-1', receivedAt: 300 }));
    findings.add(makeFindingRow({ id: 'f-1' }), ['img-1']);
    await handler.execute({ operation: 'list_images' }, makeContext());
    await handler.execute({ operation: 'get_image', imageId: 'img-1' }, makeContext());
    await handler.execute({ operation: 'list_findings' }, makeContext());
    await handler.execute({ operation: 'get_finding', findingId: 'f-1' }, makeContext());
    expect(findings.createCalls).toBe(0);
  });
});

// ===========================================================================
// 8. Real SQLite: same-timestamp ties, keyset walks, zero writes
// ===========================================================================

describe('image.lookup: real SQLite pagination and ledger safety', () => {
  let db: Database.Database;
  let imageRepo: ImageRepository;
  let findingRepo: FindingRepository;
  let threadId: string;
  let otherThreadId: string;
  let messageId: string;
  let sourceRef: string;
  let runId: string;
  let handler: ImageLookupHandler;

  const FUTURE = 4_100_000_000_000;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    imageRepo = new ImageRepository(db);
    findingRepo = new FindingRepository(db);

    const channels = new ChannelRepository(db);
    const channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const threads = new ThreadRepository(db);
    threadId = uuid();
    threads.insert({ id: threadId, channel_id: channelId, external_id: `ext-${uuid()}`, metadata: '{}' });
    otherThreadId = uuid();
    threads.insert({
      id: otherThreadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });

    const personas = new RealPersonaRepository(db);
    personas.insert({
      id: uuid(),
      name: `persona-${uuid()}`,
      model: 'gpt-5.3-vision',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    const runs = new RunRepository(db);
    runId = uuid();
    const personaRow = db.prepare('SELECT id FROM personas LIMIT 1').get() as { id: string };
    const run = runs.insert({
      id: runId,
      thread_id: threadId,
      persona_id: personaRow.id,
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
    });
    expect(run.isOk()).toBe(true);

    const messages = new MessageRepository(db);
    messageId = uuid();
    messages.insert({
      id: messageId,
      thread_id: threadId,
      direction: 'inbound',
      content: '{"text":"two photos"}',
      idempotency_key: `idem-${uuid()}`,
      provider_id: null,
      run_id: null,
    });

    sourceRef = uuid();
    db.prepare(
      'INSERT INTO image_source_messages (id, channel, external_message_id, external_chat_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(sourceRef, 'telegram', `ext-${uuid()}`, 'chat-1', 1_700_000_000_000);

    ordinalSeq = 0;
    messageForThread = new Map([[threadId, messageId]]);

    handler = new ImageLookupHandler({
      images: new SqliteImageAccess(db),
      findings: findingRepo,
      ...personaDeps({ allow: ['image.read:thread'], requireApproval: [] }),
      logger: makeLogger(),
    });
  });

  afterEach(() => {
    db.close();
  });

  function trustedContext(): ToolExecutionContext {
    return { runId, threadId, personaId: 'persona-001', requestId: 'req-sqlite' };
  }

  let ordinalSeq = 0;
  let messageForThread: Map<string, string>;

  function messageInThread(thread: string): string {
    let id = messageForThread.get(thread);
    if (id === undefined) {
      id = uuid();
      new MessageRepository(db).insert({
        id,
        thread_id: thread,
        direction: 'inbound',
        content: '{"text":"foreign"}',
        idempotency_key: `idem-${uuid()}`,
        provider_id: null,
        run_id: null,
      });
      messageForThread.set(thread, id);
    }
    return id;
  }

  function addImage(id: string, overrides: { thread?: string; state?: 'processing' | 'rejected'; rejectionReason?: 'size_limit' } = {}): string {
    const result = imageRepo.insert({
      id,
      messageId: messageInThread(overrides.thread ?? threadId),
      ordinal: (ordinalSeq += 1),
      threadId: overrides.thread ?? threadId,
      sourceRef,
      state: overrides.state ?? 'processing',
      ...(overrides.rejectionReason ? { rejectionReason: overrides.rejectionReason } : {}),
      expiresAt: FUTURE,
      processingDeadlineAt: 1_700_000_060_000,
    });
    expect(result.isOk()).toBe(true);
    if (!overrides.state) {
      expect(imageRepo.markAvailable(id, { mimeType: 'image/jpeg', width: 10, height: 20 }).isOk()).toBe(true);
    }
    return id;
  }

  function pinReceivedAt(ids: readonly string[], receivedAt: number): void {
    const stmt = db.prepare('UPDATE images SET received_at = ? WHERE id = ?');
    for (const id of ids) {
      stmt.run(receivedAt, id);
    }
  }

  function addFinding(id: string, imageIds: string[]): string {
    const result = findingRepo.create({
      id,
      runId,
      threadId,
      imageIds,
      question: `question of ${id}`,
      answer: `answer of ${id}`,
      modelName: 'gpt-5.3-vision',
    });
    expect(result.isOk()).toBe(true);
    return id;
  }

  function pinCreatedAt(ids: readonly string[], createdAt: number): void {
    const stmt = db.prepare('UPDATE findings SET created_at = ? WHERE id = ?');
    for (const id of ids) {
      stmt.run(createdAt, id);
    }
  }

  it('orders same-timestamp images by ID ASC through real SQL', async () => {
    // Insertion order deliberately differs from the expected tie order.
    addImage('img-charlie');
    addImage('img-alpha');
    addImage('img-bravo');
    pinReceivedAt(['img-charlie', 'img-alpha', 'img-bravo'], 1_700_000_555_000);

    const listed = payloadOf(await handler.execute({ operation: 'list_images' }, trustedContext()));
    expect(listed.images.map((d: { imageId: string }) => d.imageId)).toEqual([
      'img-alpha',
      'img-bravo',
      'img-charlie',
    ]);
    expect(listed.nextCursor).toBeNull();
  });

  it('walks tied rows across page boundaries without duplicates or gaps', async () => {
    addImage('img-zulu', { state: 'rejected', rejectionReason: 'size_limit' });
    addImage('img-mike');
    addImage('img-alpha');
    addImage('img-bravo');
    addImage('img-newest');
    // Newest single row first; four rows share one receipt timestamp.
    pinReceivedAt(['img-zulu', 'img-mike', 'img-alpha', 'img-bravo'], 1_700_000_500_000);
    pinReceivedAt(['img-newest'], 1_700_000_900_000);

    const expected = ['img-newest', 'img-alpha', 'img-bravo', 'img-mike', 'img-zulu'];
    for (const limit of [1, 2, 3, 4]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      for (;;) {
        guard += 1;
        expect(guard, 'pagination must terminate').toBeLessThan(10);
        const page = payloadOf(
          await handler.execute(
            { operation: 'list_images', limit, ...(cursor !== null ? { cursor } : {}) } as never,
            trustedContext(),
          ),
        );
        seen.push(...page.images.map((d: { imageId: string }) => d.imageId));
        cursor = page.nextCursor;
        if (cursor === null) {
          break;
        }
      }
      expect(seen, `limit=${limit}`).toEqual(expected);
    }
  });

  it('keeps Processing rows out of real pages and returns the indistinguishable not-found', async () => {
    addImage('img-ready');
    addImage('img-inflight', { state: 'processing' });
    const listed = payloadOf(await handler.execute({ operation: 'list_images' }, trustedContext()));
    expect(listed.images.map((d: { imageId: string }) => d.imageId)).toEqual(['img-ready']);

    const processing = errorOf(await handler.execute({ operation: 'get_image', imageId: 'img-inflight' }, trustedContext()));
    const unknown = errorOf(await handler.execute({ operation: 'get_image', imageId: 'img-does-not-exist' }, trustedContext()));
    const foreignId = addImage('img-foreign', { thread: otherThreadId });
    const foreign = errorOf(await handler.execute({ operation: 'get_image', imageId: foreignId }, trustedContext()));
    expect(processing).toBe(unknown);
    expect(processing).toBe(foreign);
  });

  it('serves terminal-state text access from real rows', async () => {
    addImage('img-rejected', { state: 'rejected', rejectionReason: 'size_limit' });
    const ready = addImage('img-ready');
    expect(imageRepo.markUnavailable(ready, 'expired').isOk()).toBe(true);

    const rejected = payloadOf(await handler.execute({ operation: 'get_image', imageId: 'img-rejected' }, trustedContext()));
    expect(rejected.image.state).toBe('rejected');
    expect(rejected.image.rejectionReason).toBe('size_limit');

    const expired = payloadOf(await handler.execute({ operation: 'get_image', imageId: ready }, trustedContext()));
    expect(expired.image.state).toBe('unavailable');
    expect(expired.image.unavailabilityReason).toBe('expired');

    // Findings survive file loss: filter + retrieval still work on the expired Image.
    const findingId = addFinding('finding-survivor', [ready]);
    const filtered = payloadOf(
      await handler.execute({ operation: 'list_findings', imageId: ready }, trustedContext()),
    );
    expect(filtered.findings.map((f: { findingId: string }) => f.findingId)).toEqual([findingId]);
    const fetched = payloadOf(
      await handler.execute({ operation: 'get_finding', findingId }, trustedContext()),
    );
    expect(fetched.finding.answer).toBe('answer of finding-survivor');
  });

  it('walks real same-timestamp Findings by ID ASC across pages', async () => {
    const img = addImage('img-for-findings');
    addFinding('finding-charlie', [img]);
    addFinding('finding-alpha', [img]);
    addFinding('finding-bravo', [img]);
    pinCreatedAt(['finding-charlie', 'finding-alpha', 'finding-bravo'], 1_700_000_777_000);

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    for (;;) {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const page = payloadOf(
        await handler.execute(
          { operation: 'list_findings', limit: 2, ...(cursor !== null ? { cursor } : {}) } as never,
          trustedContext(),
        ),
      );
      seen.push(...page.findings.map((f: { findingId: string }) => f.findingId));
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(seen).toEqual(['finding-alpha', 'finding-bravo', 'finding-charlie']);
  });

  it('rejects cross-operation and cross-filter cursors against real repositories', async () => {
    const img = addImage('img-cursor-anchor');
    addFinding('finding-1', [img]);
    addFinding('finding-2', [img]);
    pinCreatedAt(['finding-1', 'finding-2'], 1_700_000_800_000);
    const findingsPage = payloadOf(
      await handler.execute({ operation: 'list_findings', limit: 1, imageId: img }, trustedContext()),
    );
    expect(findingsPage.nextCursor).toBeTypeOf('string');

    const crossOp = errorOf(
      await handler.execute({ operation: 'list_images', cursor: findingsPage.nextCursor }, trustedContext()),
    );
    expect(crossOp).toContain('different operation');

    const crossFilter = errorOf(
      await handler.execute({ operation: 'list_findings', cursor: findingsPage.nextCursor }, trustedContext()),
    );
    expect(crossFilter).toContain('different filter');
  });

  it('writes nothing to the ledger across all four operations', async () => {
    const img = addImage('img-stable');
    addFinding('finding-stable', [img]);

    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = {
      images: count('images'),
      findings: count('findings'),
      finding_images: count('finding_images'),
      messages: count('messages'),
      runs: count('runs'),
      threads: count('threads'),
    };

    payloadOf(await handler.execute({ operation: 'list_images' }, trustedContext()));
    payloadOf(await handler.execute({ operation: 'get_image', imageId: img }, trustedContext()));
    payloadOf(await handler.execute({ operation: 'list_findings' }, trustedContext()));
    payloadOf(await handler.execute({ operation: 'list_findings', imageId: img }, trustedContext()));
    payloadOf(await handler.execute({ operation: 'get_finding', findingId: 'finding-stable' }, trustedContext()));
    // Failed attempts must not write either.
    await handler.execute({ operation: 'get_image', imageId: 'img-absent' }, trustedContext());
    await handler.execute({ operation: 'list_images', limit: 999 }, trustedContext());

    expect({
      images: count('images'),
      findings: count('findings'),
      finding_images: count('finding_images'),
      messages: count('messages'),
      runs: count('runs'),
      threads: count('threads'),
    }).toEqual(before);
  });
});

// ===========================================================================
// 9. Rejected request material never enters application logs
// ===========================================================================

describe('image.lookup: log hygiene on rejected requests', () => {
  // A rejected request is exactly where a field may hold a base64 blob or a
  // credential-bearing URL, and pino applies no redaction (see
  // core/logging/logger.ts). Validation failures must therefore log only a
  // recognized-operation label or a fixed sentinel — never a raw field.

  interface LogMock {
    mock: { calls: unknown[][] };
  }
  interface CapturedLogger {
    handler: ImageLookupHandler;
    logger: Record<'debug' | 'info' | 'warn' | 'error', LogMock>;
    loggedText: () => string;
  }

  function makeCapturedHarness(): CapturedLogger {
    const raw = makeLogger();
    const logger = raw as unknown as Record<'debug' | 'info' | 'warn' | 'error', LogMock>;
    const handler = new ImageLookupHandler({
      images: new FakeImageAccess(),
      findings: new FakeFindings(),
      ...personaDeps({ allow: ['image.read:thread'], requireApproval: [] }),
      logger: raw,
    });
    const loggedText = (): string => {
      const parts: string[] = [];
      for (const method of ['debug', 'info', 'warn', 'error'] as const) {
        for (const call of logger[method].mock.calls) {
          try {
            parts.push(JSON.stringify(call) ?? String(call));
          } catch {
            parts.push(String(call));
          }
        }
      }
      return parts.join('\n');
    };
    return { handler, logger, loggedText };
  }

  const SENSITIVE_MARKERS = ['SECRETTOK', 'SECRETPX', 'internal.example.com', 'https://', 'data:image'];

  const sensitiveRejections: Array<{ label: string; args: Record<string, unknown> }> = [
    {
      label: 'operation is a credential-bearing URL',
      args: { operation: 'https://bot:SECRETTOK123@internal.example.com/v1/get_image' },
    },
    {
      label: 'operation is a base64 blob',
      args: { operation: 'SECRETPXZGF0YTppbWFnZS9wbmc7YmFzZTY0LFFRRTI='.repeat(4) },
    },
    {
      label: 'operation is a staging path',
      args: { operation: '/var/lib/talon/staging/SECRETTOK99/img.png' },
    },
    {
      label: 'a forbidden field carries a credential URL alongside a known operation',
      args: { operation: 'list_images', sourceRef: 'https://cdn:SECRETTOKAB@internal.example.com/x' },
    },
    {
      label: 'an ID field carries a data URI',
      args: { operation: 'get_image', imageId: 'data:image/png;base64,SECRETPXVZZHp4' },
    },
    {
      label: 'a malformed cursor carries embedded credentials',
      args: { operation: 'list_images', cursor: 'https://user:SECRETTOKCD@internal.example.com/#SECRETPX' },
    },
    {
      label: 'the trusted-context threadId override attempt carries a secret',
      args: { operation: 'list_images', threadId: 'other-thread?token=SECRETTOKEE' },
    },
  ];

  for (const t of sensitiveRejections) {
    it(`logs no sensitive marker when rejecting: ${t.label}`, async () => {
      const h = makeCapturedHarness();
      const result = await h.handler.execute(t.args as never, makeContext());
      expect(result.status).toBe('error');
      // The sanitization warning must still fire (operational visibility)...
      expect(h.logger.warn.mock.calls.length).toBeGreaterThan(0);
      // ...while nothing logged anywhere contains the sensitive material.
      const text = h.loggedText();
      for (const marker of SENSITIVE_MARKERS) {
        expect(text, t.label).not.toContain(marker);
      }
      // The returned error is likewise sanitized (guards the response side).
      expect(String(result.error)).not.toContain('SECRETTOK');
      expect(String(result.error)).not.toContain('SECRETPX');
    });
  }

  // Plain-ID-shaped secrets: a shape filter cannot distinguish 'SECRETTOK'
  // from a legitimate ID, so the only safe rule is FIXED wording with zero
  // interpolation of rejected material. These regressions pin that for both
  // the invalid-operation path and the unknown-key path: the marker must be
  // absent from the error text, the response body, and every structured
  // logger field.
  const plainTokenRejections: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: 'the operation itself is a plain secret-shaped token', args: { operation: 'SECRETTOK' } },
    { label: 'the operation embeds a marker in a plain token', args: { operation: 'list_imagesSECRETTOK' } },
    { label: 'the unknown key is a plain secret-shaped token', args: { operation: 'list_images', SECRETTOK: true } },
    { label: 'the unknown key embeds a marker', args: { operation: 'get_image', imageId: 'img-1', fxSECRETTOKx: 1 } },
  ];

  for (const t of plainTokenRejections) {
    it(`never echoes a plain-token marker: ${t.label}`, async () => {
      const h = makeCapturedHarness();
      const result = await h.handler.execute(t.args as never, makeContext());
      expect(result.status).toBe('error');
      // Response side.
      expect(String(result.error), t.label).not.toContain('SECRETTOK');
      // Whole-log side (messages + fields).
      const text = h.loggedText();
      expect(text, t.label).not.toContain('SECRETTOK');
      // Structured-fields side, asserted per call.
      for (const method of ['debug', 'info', 'warn', 'error'] as const) {
        for (const call of h.logger[method].mock.calls) {
          expect(JSON.stringify(call[0] ?? {}), t.label).not.toContain('SECRETTOK');
        }
      }
    });
  }

  it('logs the fixed sentinel for unrecognized operations', async () => {
    const h = makeCapturedHarness();
    await h.handler.execute({ operation: 'list_images SECRETPX https://x' } as never, makeContext());
    const text = h.loggedText();
    expect(text).toContain('<unrecognized>');
    expect(text).not.toContain('SECRETPX');
    expect(text).not.toContain('https://');
  });

  it('logs recognized operation names for validated requests', async () => {
    const h = makeCapturedHarness();
    await h.handler.execute({ operation: 'list_images' }, makeContext());
    expect(h.loggedText()).toContain('list_images');
  });
});
