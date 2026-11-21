/**
 * Host-side tool: image.lookup (MCP name `image_lookup`)
 *
 * Model-free, thread-scoped discovery of the current conversation's Images and
 * exact retrieval of its canonical Findings. Four operations only:
 *
 * | operation       | fields beyond `operation` | result                        |
 * | --------------- | ------------------------- | ----------------------------- |
 * | `list_images`   | `limit`, `cursor`         | `{ images, nextCursor }`      |
 * | `get_image`     | `imageId`                 | `{ image }`                   |
 * | `list_findings` | `imageId`, `limit`, `cursor` | `{ findings, nextCursor }` |
 * | `get_finding`   | `findingId`               | `{ finding }`                 |
 *
 * Trust boundaries (spec part (c), inventory I11):
 *
 * - **Thread.** Every read is scoped to the thread of the trusted
 *   {@link ToolExecutionContext}. There is no `threadId` argument: a caller
 *   (i.e. the model) that supplies one — or any other identity, path, URL, or
 *   provenance field — is rejected as an unknown field, never honored.
 * - **Capability.** `image.read:thread` is re-checked in-handler through the
 *   same resolved-persona evaluation the bridge uses, fail-closed. No vision
 *   assignment, `subagent.invoke` permission, model credential, or approval is
 *   consulted: this tool never calls a model.
 * - **Availability.** Availability is refreshed through the access port's
 *   refresh capability BEFORE any Image is emitted, so a descriptor never
 *   reports state that has already lapsed. Unknown, cross-thread, and
 *   Processing Image IDs all resolve to ONE indistinguishable not-found error;
 *   Rejected and Unavailable Images keep full text access (metadata and
 *   Findings survive their Normalized file).
 * - **Payload.** Responses carry the complete public descriptor DTO (TASK-015
 *   `toImageDescriptorDto`, never an automatically clipped context excerpt) and
 *   the exact canonical Finding. No pixel bytes, local paths, staging or
 *   source references, download credentials, or tokens appear in any response,
 *   error, or log line, and no image file is ever opened merely to answer a
 *   text lookup.
 * - **No writes.** This handler creates nothing: it never persists a Finding,
 *   never triggers a channel download, and never mutates an Image.
 *
 * Pagination: lists default to 20 entries, accept an integer 1–100, sort by
 * timestamp descending then ID ascending, and return an opaque `nextCursor`
 * that is bound to the issuing operation, filter, and thread. A cursor from a
 * different operation, filter, or thread — or one that is malformed — is
 * rejected rather than reinterpreted. `nextCursor` is null when exhausted.
 *
 * Registration, MCP schema, and bridge dispatch are a separate concern
 * (TASK-017); runtime services are injected by the final wiring (TASK-019).
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import { extractCapabilityPrefix } from '../tool-filter.js';
import type { ResolvedCapabilities } from '../../personas/persona-types.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import type { DbError } from '../../core/errors/error-types.js';
import type {
  FindFindingsOptions,
  FindingPage,
  FindingRecord,
} from '../../core/database/repositories/finding-repository.js';
import type { PersonaLoader } from '../../personas/persona-loader.js';
import type {
  ImageAccess,
  ImageAccessError,
  ImageDescriptor,
} from '../../images/image-types.js';
import type { Finding, FindingTokenUsage } from '../../images/finding-types.js';
import {
  toImageDescriptorDto,
  type ImageDescriptorDto,
} from '../../images/image-context-projection.js';

// ---------------------------------------------------------------------------
// Names, ceilings, and the public operation vocabulary
// ---------------------------------------------------------------------------

/** Internal (dot-notation) tool name; the MCP name is `image_lookup`. */
export const IMAGE_LOOKUP_TOOL_NAME = 'image.lookup';

/** Capability label gating every operation. */
export const IMAGE_LOOKUP_CAPABILITY = 'image.read:thread';

/** `domain.action` part of {@link IMAGE_LOOKUP_CAPABILITY}. */
const IMAGE_LOOKUP_CAPABILITY_PREFIX = 'image.read';

/** The complete operation vocabulary. Any other value is rejected. */
export const IMAGE_LOOKUP_OPERATIONS = Object.freeze([
  'list_images',
  'get_image',
  'list_findings',
  'get_finding',
] as const);

export type ImageLookupOperation = (typeof IMAGE_LOOKUP_OPERATIONS)[number];

/** Listing operations only. Single-entry operations never take a cursor. */
type ImageLookupListOperation = Extract<ImageLookupOperation, 'list_images' | 'list_findings'>;

/** Default page size when `limit` is omitted. */
export const IMAGE_LOOKUP_DEFAULT_LIMIT = 20;

/** Inclusive `limit` bounds. */
export const IMAGE_LOOKUP_MIN_LIMIT = 1;
export const IMAGE_LOOKUP_MAX_LIMIT = 100;

/**
 * Cursor envelope version. Bumping it invalidates every previously issued
 * cursor instead of silently reinterpreting a changed payload shape.
 */
const CURSOR_VERSION = 1;

/**
 * Plain opaque-ID shape — the same positive check the vision Inspection
 * boundary applies. Paths, scheme URLs, `data:` URIs, base64 payloads, and
 * oversize tokens never reach a port, a response, or a log line.
 */
const PLAIN_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * Canonical base64url alphabet with no padding — the ONLY encoding accepted
 * for a cursor. Pairs with the re-encode round-trip check in
 * {@link decodeCursor} so byte-level corruptions that Node's forgiving
 * decoder would silently normalize cannot ride a still-valid envelope.
 */
const BASE64URL_CANONICAL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Fields accepted per operation. `operation` itself is always required. Any
 * key outside this set — including `threadId`, `personaId`, `runId`, a path,
 * a URL, or a source reference — is rejected before a port is touched, so a
 * model cannot override the trusted thread or aim a read at a location.
 */
const ALLOWED_FIELDS: Readonly<Record<ImageLookupOperation, readonly string[]>> = Object.freeze({
  list_images: ['operation', 'limit', 'cursor'],
  get_image: ['operation', 'imageId'],
  list_findings: ['operation', 'imageId', 'limit', 'cursor'],
  get_finding: ['operation', 'findingId'],
});

/**
 * Fields that are never model-supplied identity material. They get a distinct
 * rejection because a caller offering one is attempting to override the
 * trusted execution context.
 */
const FORBIDDEN_IDENTITY_FIELDS = Object.freeze([
  'threadId',
  'thread_id',
  'personaId',
  'persona_id',
  'runId',
  'run_id',
  'context',
] as const);

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/** Keyset position of the last entry of a returned Image page. */
export interface ImagePageAnchor {
  /** Receipt timestamp (epoch ms) of the page's last Image. */
  receivedAt: number;
  /** Image ID of the page's last Image. */
  imageId: string;
}

/** Options for one thread-scoped Image page read. */
export interface FindImagePageOptions {
  /** Trusted owning thread; the page never crosses it. */
  threadId: string;
  /** Maximum descriptors. Already bounded to 1–100 by the handler. */
  limit: number;
  /**
   * Keyset position: read strictly after this entry in
   * `(receivedAt DESC, imageId ASC)` order. Absent = first page.
   */
  before?: ImagePageAnchor | null;
}

/** One page of current-thread Image descriptors. */
export interface ImagePage {
  /** Up to `limit` descriptors in (receivedAt DESC, imageId ASC) order. */
  images: readonly ImageDescriptor[];
  /** Anchor for the next page, or null when the result is exhausted. */
  nextAnchor: ImagePageAnchor | null;
}

/**
 * The Image reads `image.lookup` needs: the TASK-001 {@link ImageAccess} port
 * (availability refresh + single-Image resolve) plus one thread-scoped page
 * read in lookup order.
 *
 * Kept as an explicit interface so lookup can be built and tested with
 * deterministic fixtures. The concrete adapter (SQLite records, owned
 * Normalized-file subtree, expiry rules) is supplied by runtime integration;
 * nothing here imports it. `fetchInspectionBytes` exists on the port for other
 * consumers and is NEVER called by this handler: a text lookup opens no file.
 *
 * The page read excludes Processing Images (internal to Ingestion); the handler
 * still hides any Processing entry that arrives anyway, so a leaky adapter
 * cannot expose internal state.
 */
export interface ImageLookupAccess extends ImageAccess {
  /**
   * Returns one keyset page of the thread's current Image descriptors,
   * newest receipt first with Image IDs ascending on ties.
   */
  findThreadPage(
    options: FindImagePageOptions,
  ): Promise<Result<ImagePage, ImageAccessError>>;
}

/**
 * The Finding reads `image.lookup` needs. Structurally satisfied by
 * `FindingRepository` (TASK-011); deliberately narrow so fixtures need no
 * database, and deliberately free of `create`: lookup can never write a
 * Finding.
 */
export interface ImageLookupFindings {
  /** One chronological keyset page (creation DESC, id ASC) of the thread's Findings. */
  findPage(options: FindFindingsOptions): Result<FindingPage, DbError>;
  /** The exact canonical Finding, or null when unknown OR owned by another thread. */
  findByIdInThread(findingId: string, threadId: string): Result<FindingRecord | null, DbError>;
}

/** Constructor dependencies of {@link ImageLookupHandler}. */
export interface ImageLookupHandlerDeps {
  /** Current-thread Image reads and availability refresh. */
  images: ImageLookupAccess;
  /** Canonical Finding ledger reads. */
  findings: ImageLookupFindings;
  /** Persona row lookup for capability resolution — by trusted context ID only. */
  personaRepository: Pick<PersonaRepository, 'findById'>;
  /** Loaded-persona cache carrying resolved capabilities. */
  personaLoader: Pick<PersonaLoader, 'getByName'>;
  logger: pino.Logger;
}

// ---------------------------------------------------------------------------
// Argument surface
// ---------------------------------------------------------------------------

/**
 * Model-authored tool arguments. Every key is validated against the
 * operation's allowed set and every value is re-typed here, because the
 * bridge forwards this object verbatim.
 */
export interface ImageLookupArgs {
  operation?: unknown;
  imageId?: unknown;
  findingId?: unknown;
  limit?: unknown;
  cursor?: unknown;
  [key: string]: unknown;
}

/** A request that passed validation, with typed fields per operation. */
type ValidatedRequest =
  | { operation: 'list_images'; limit: number; cursor: CursorBinding | null }
  | { operation: 'get_image'; imageId: string }
  | {
      operation: 'list_findings';
      imageId: string | null;
      limit: number;
      cursor: CursorBinding | null;
    }
  | { operation: 'get_finding'; findingId: string };

/** Public summary entry of `list_findings`; exact text stays on `get_finding`. */
export interface ImageLookupFindingSummary {
  findingId: string;
  /** Source Image IDs in the Inspection's own order. */
  imageIds: string[];
  /** The Inspection question, verbatim. */
  question: string;
  /** Creation time as ISO-8601 UTC (full millisecond precision). */
  createdAt: string;
  /** The winning vision model. */
  modelName: string;
}

/** Successful result payloads, one per operation. */
export type ImageLookupResult =
  | { images: ImageDescriptorDto[]; nextCursor: string | null }
  | { image: ImageDescriptorDto }
  | { findings: ImageLookupFindingSummary[]; nextCursor: string | null }
  | { finding: Finding };

// ---------------------------------------------------------------------------
// Opaque cursor
// ---------------------------------------------------------------------------

/**
 * Decoded cursor: the keyset position plus the context it was issued for.
 *
 * The envelope binds operation, filter, and thread so a page cannot be
 * replayed against another operation (`list_images` cursor into
 * `list_findings`), another filter (a cursor issued for `imageId=A` used with
 * `imageId=B` or with no filter), or another thread. The binding is what makes
 * the cursor opaque-but-safe: the caller never has to interpret it, and a
 * guessed or edited payload fails closed.
 */
interface CursorBinding {
  at: number;
  id: string;
  operation: ImageLookupListOperation;
  filter: string | null;
  threadId: string;
}

function encodeCursor(binding: {
  operation: ImageLookupListOperation;
  filter: string | null;
  threadId: string;
  at: number;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      op: binding.operation,
      filter: binding.filter,
      thread: binding.threadId,
      at: binding.at,
      id: binding.id,
    }),
    'utf8',
  ).toString('base64url');
}

/** Strict decode + binding check; every failure is the same rejection. */
function decodeCursor(
  raw: string,
  expected: { operation: ImageLookupListOperation; filter: string | null; threadId: string },
): Result<CursorBinding, string> {
  const invalid = (reason: string): Result<CursorBinding, string> =>
    err(`image.lookup: invalid cursor (${reason}). Cursors are opaque and bound to one operation, filter, and thread.`);

  // Canonical base64url ONLY. Node's decoder silently drops `!`, whitespace,
  // `+`, `/`, and padding, and ignores redundant trailing bits, so an issued
  // cursor corrupted in exactly those ways would decode to the SAME valid
  // envelope and be honored. Requiring re-encode round-trip equality refuses
  // every byte-level variant instead of forgiving it, so a corrupted cursor
  // is rejected before any port is touched.
  if (
    !BASE64URL_CANONICAL_PATTERN.test(raw) ||
    Buffer.from(raw, 'base64url').toString('base64url') !== raw
  ) {
    return invalid('malformed payload');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return invalid('malformed payload');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('malformed payload');
  }
  const fields = payload as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  const expectedKeys = ['at', 'filter', 'id', 'op', 'thread', 'v'];
  if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) {
    return invalid('malformed payload');
  }
  if (
    fields.v !== CURSOR_VERSION ||
    typeof fields.op !== 'string' ||
    typeof fields.thread !== 'string' ||
    typeof fields.id !== 'string' ||
    !PLAIN_ID_PATTERN.test(fields.id) ||
    (fields.filter !== null && typeof fields.filter !== 'string') ||
    typeof fields.at !== 'number' ||
    !Number.isInteger(fields.at)
  ) {
    return invalid('malformed payload');
  }
  const operation = fields.op;
  if (operation !== 'list_images' && operation !== 'list_findings') {
    return invalid('issued for an unknown operation');
  }
  if (operation !== expected.operation) {
    return invalid('issued for a different operation');
  }
  if (fields.filter !== expected.filter) {
    return invalid('issued for a different filter');
  }
  if (fields.thread !== expected.threadId) {
    return invalid('issued for a different thread');
  }
  return ok({
    at: fields.at,
    id: fields.id,
    operation: expected.operation,
    filter: expected.filter,
    threadId: expected.threadId,
  });
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

/**
 * Log-safe operation label: an exact match against the recognized operation
 * vocabulary, or a fixed sentinel. Rejected requests are logged through this
 * label ONLY — raw request fields never enter the application log, because
 * validation failures are precisely the cases where a field may hold
 * base64 payloads or credential-bearing URLs and the logger does not redact.
 */
function safeOperationLabel(args: ImageLookupArgs | undefined): string {
  const operation = args?.operation;
  return typeof operation === 'string' &&
    IMAGE_LOOKUP_OPERATIONS.includes(operation as ImageLookupOperation)
    ? operation
    : '<unrecognized>';
}

function validateRequest(args: ImageLookupArgs, context: ToolExecutionContext): Result<
  ValidatedRequest,
  string
> {
  const raw = (args ?? {}) as Record<string, unknown>;
  const operation = raw.operation;
  if (
    typeof operation !== 'string' ||
    !IMAGE_LOOKUP_OPERATIONS.includes(operation as ImageLookupOperation)
  ) {
    // No interpolation of the rejected value: a plain-ID-shaped string is
    // indistinguishable from a credential or identifier fragment by shape
    // alone, and this text reaches the response AND the application log.
    // Only allowlisted vocabulary may appear.
    return err(
      `image.lookup: invalid operation. Must be one of: ${IMAGE_LOOKUP_OPERATIONS.join(', ')}`,
    );
  }
  const op = operation as ImageLookupOperation;

  // Unknown-field rejection comes before any per-field work so a caller
  // offering a thread, persona, run, path, URL, or source reference is refused
  // outright rather than having that field quietly ignored.
  const allowed = ALLOWED_FIELDS[op];
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) {
      continue;
    }
    if ((FORBIDDEN_IDENTITY_FIELDS as readonly string[]).includes(key)) {
      return err(
        `image.lookup: "${key}" is not an accepted field. The thread, persona, and run come ` +
          'from the trusted execution context and can never be supplied by the caller.',
      );
    }
    // Unknown key NAMES are arbitrary model-authored material — never
    // echoed. `op` is allowlisted vocabulary, so naming it is safe.
    return err(
      `image.lookup: an unknown field is not accepted for operation ${op}.`,
    );
  }

  const parsedLimit = parseLimit(raw.limit);
  if (parsedLimit.isErr()) {
    return err(parsedLimit.error);
  }

  switch (op) {
    case 'get_image': {
      const imageId = parseId(raw.imageId, 'imageId');
      if (imageId.isErr()) {
        return err(imageId.error);
      }
      return ok({ operation: 'get_image', imageId: imageId.value });
    }
    case 'get_finding': {
      const findingId = parseId(raw.findingId, 'findingId');
      if (findingId.isErr()) {
        return err(findingId.error);
      }
      return ok({ operation: 'get_finding', findingId: findingId.value });
    }
    case 'list_images': {
      const cursor = parseCursor(raw.cursor, {
        operation: 'list_images',
        filter: null,
        threadId: context.threadId,
      });
      if (cursor.isErr()) {
        return err(cursor.error);
      }
      return ok({ operation: 'list_images', limit: parsedLimit.value, cursor: cursor.value });
    }
    case 'list_findings': {
      let imageId: string | null = null;
      if (raw.imageId !== undefined) {
        const filter = parseId(raw.imageId, 'imageId');
        if (filter.isErr()) {
          return err(filter.error);
        }
        imageId = filter.value;
      }
      const cursor = parseCursor(raw.cursor, {
        operation: 'list_findings',
        filter: imageId,
        threadId: context.threadId,
      });
      if (cursor.isErr()) {
        return err(cursor.error);
      }
      return ok({ operation: 'list_findings', imageId, limit: parsedLimit.value, cursor: cursor.value });
    }
    default: {
      // Exhaustiveness guard: a new operation must be added to the tables above.
      const unhandled: never = op;
      return err(`image.lookup: unsupported operation ${String(unhandled)}`);
    }
  }
}

function parseLimit(value: unknown): Result<number, string> {
  const bounds = `limit must be an integer between ${IMAGE_LOOKUP_MIN_LIMIT} and ${IMAGE_LOOKUP_MAX_LIMIT}`;
  if (value === undefined) {
    return ok(IMAGE_LOOKUP_DEFAULT_LIMIT);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return err(`image.lookup: ${bounds}`);
  }
  if (value < IMAGE_LOOKUP_MIN_LIMIT || value > IMAGE_LOOKUP_MAX_LIMIT) {
    return err(`image.lookup: ${bounds}, got ${String(value)}`);
  }
  return ok(value);
}

function parseId(value: unknown, field: string): Result<string, string> {
  if (typeof value === 'string' && PLAIN_ID_PATTERN.test(value)) {
    return ok(value);
  }
  // The offending value is never echoed: a rejected token is exactly the
  // shape (path, URL, data: URI, blob) that must not reach a response.
  return err(
    `image.lookup: ${field} must be a plain opaque ID (1–128 characters of ` +
      '[A-Za-z0-9._-]). Paths and URLs are never accepted.',
  );
}

function parseCursor(
  value: unknown,
  expected: { operation: ImageLookupListOperation; filter: string | null; threadId: string },
): Result<CursorBinding | null, string> {
  if (value === undefined) {
    return ok(null);
  }
  if (typeof value !== 'string' || value === '') {
    return err(
      'image.lookup: invalid cursor (not an opaque string) — pass the exact nextCursor from an earlier page.',
    );
  }
  return decodeCursor(value, expected);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * `image.lookup` handler.
 *
 * Read-only, model-free, and thread-scoped. Every operation enforces the
 * `image.read:thread` capability and the trusted thread before touching a
 * port, and every Image it emits was refreshed first.
 */
export class ImageLookupHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: IMAGE_LOOKUP_TOOL_NAME,
    description:
      'Discovers the current thread\'s Images and retrieves exact saved Findings. ' +
      'Operations: list_images, get_image, list_findings (optional imageId filter), get_finding. ' +
      'Text only: no pixels, paths, model calls, or downloads.',
    capabilities: [IMAGE_LOOKUP_CAPABILITY],
    executionLocation: 'host',
  };

  constructor(private readonly deps: ImageLookupHandlerDeps) {}

  /**
   * Execute the image.lookup tool.
   *
   * @param args    - Raw tool arguments; every field is validated here.
   * @param context - Trusted execution context (runId, threadId, personaId).
   */
  async execute(args: ImageLookupArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    // 1. Capability gate, before any port read and before argument feedback so
    //    an unpermitted persona learns nothing beyond the denial.
    const denied = this.rejectWithoutCapability(context, requestId);
    if (denied !== null) {
      return denied;
    }

    // 2. Validation: operation, per-operation fields, limit bounds, cursor
    //    binding. Nothing reaches a port on failure.
    const validated = validateRequest(args, context);
    if (validated.isErr()) {
      // Log ONLY the label — a recognized operation name or a fixed sentinel.
      // The raw request is model-authored and may carry base64 blobs or
      // credential-bearing URLs in any field; the logger applies no redaction,
      // so no request field is ever echoed into an application log.
      this.deps.logger.warn(
        { requestId, threadId: context.threadId, operation: safeOperationLabel(args) },
        validated.error,
      );
      return this.error(requestId, validated.error);
    }
    const request = validated.value;

    this.deps.logger.info(
      {
        requestId,
        runId: context.runId,
        threadId: context.threadId,
        personaId: context.personaId,
        operation: request.operation,
      },
      'image.lookup: executing',
    );

    switch (request.operation) {
      case 'list_images':
        return this.listImages(request, context, requestId);
      case 'get_image':
        return this.getImage(request, context, requestId);
      case 'list_findings':
        return this.listFindings(request, context, requestId);
      case 'get_finding':
        return this.getFinding(request, context, requestId);
      default: {
        // Exhaustiveness guard on the validated union.
        const unhandled: never = request;
        return this.error(requestId, `image.lookup: unsupported request ${String(unhandled)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /** `{ images, nextCursor }` — current descriptors, Processing excluded. */
  private async listImages(
    request: Extract<ValidatedRequest, { operation: 'list_images' }>,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    const page = await this.deps.images.findThreadPage({
      threadId: context.threadId,
      limit: request.limit,
      before: request.cursor
        ? { receivedAt: request.cursor.at, imageId: request.cursor.id }
        : null,
    });
    if (page.isErr()) {
      return this.portFailure(requestId, page.error, 'list images');
    }

    // Refresh BEFORE emitting: a page read is a snapshot, and an Image whose
    // file expired in the meantime must never be reported as Available.
    const images: ImageDescriptorDto[] = [];
    for (const entry of page.value.images) {
      const fresh = await this.readRefreshedImage(context.threadId, entry.imageId);
      if (fresh.isErr()) {
        if (fresh.error === 'storage_failed') {
          return this.storageFailure(requestId, 'list images');
        }
        // Hidden (unknown, cross-thread, or Processing) simply leaves the list
        // without a distinguishing trace.
        continue;
      }
      images.push(toImageDescriptorDto(fresh.value));
    }

    const nextAnchor = page.value.nextAnchor;
    const result: ImageLookupResult = {
      images,
      nextCursor: nextAnchor
        ? encodeCursor({
            operation: 'list_images',
            filter: null,
            threadId: context.threadId,
            at: nextAnchor.receivedAt,
            id: nextAnchor.imageId,
          })
        : null,
    };
    this.deps.logger.debug(
      { requestId, threadId: context.threadId, count: images.length, paged: nextAnchor !== null },
      'image.lookup: list_images complete',
    );
    return this.success(requestId, result);
  }

  /** `{ image }` — the current descriptor of one Image in this thread. */
  private async getImage(
    request: Extract<ValidatedRequest, { operation: 'get_image' }>,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    const fresh = await this.readRefreshedImage(context.threadId, request.imageId);
    if (fresh.isErr()) {
      if (fresh.error === 'storage_failed') {
        return this.storageFailure(requestId, 'get image');
      }
      return this.error(requestId, imageNotFound());
    }
    const result: ImageLookupResult = { image: toImageDescriptorDto(fresh.value) };
    this.deps.logger.debug(
      { requestId, threadId: context.threadId, imageId: request.imageId, state: fresh.value.state },
      'image.lookup: get_image complete',
    );
    return this.success(requestId, result);
  }

  /** `{ findings, nextCursor }` — optional current-thread Image filter. */
  private async listFindings(
    request: Extract<ValidatedRequest, { operation: 'list_findings' }>,
    context: ToolExecutionContext,
    requestId: string,
  ): Promise<ToolCallResult> {
    // An Image filter is verified against the SAME thread before any Finding
    // read, so a caller cannot use Finding existence to probe an Image it
    // does not own. Unknown, cross-thread, and Processing IDs all answer with
    // the one indistinguishable not-found error.
    if (request.imageId !== null) {
      const visible = await this.imageVisibleInThread(context.threadId, request.imageId);
      if (visible.isErr()) {
        if (visible.error === 'storage_failed') {
          return this.storageFailure(requestId, 'list findings');
        }
        return this.error(requestId, imageNotFound());
      }
    }

    const page = this.deps.findings.findPage({
      threadId: context.threadId,
      imageId: request.imageId ?? undefined,
      limit: request.limit,
      before: request.cursor ? { createdAt: request.cursor.at, id: request.cursor.id } : undefined,
    });
    if (page.isErr()) {
      this.deps.logger.error(
        { requestId, threadId: context.threadId, err: page.error },
        'image.lookup: finding page read failed',
      );
      return this.storageFailure(requestId, 'list findings');
    }

    const findings = page.value.findings.map(toFindingSummary);
    const nextAnchor = page.value.nextAnchor;
    const result: ImageLookupResult = {
      findings,
      nextCursor: nextAnchor
        ? encodeCursor({
            operation: 'list_findings',
            filter: request.imageId,
            threadId: context.threadId,
            at: nextAnchor.createdAt,
            id: nextAnchor.id,
          })
        : null,
    };
    this.deps.logger.debug(
      {
        requestId,
        threadId: context.threadId,
        imageId: request.imageId,
        count: findings.length,
        paged: nextAnchor !== null,
      },
      'image.lookup: list_findings complete',
    );
    return this.success(requestId, result);
  }

  /** `{ finding }` — the exact canonical Finding owned by this thread. */
  private getFinding(
    request: Extract<ValidatedRequest, { operation: 'get_finding' }>,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const record = this.deps.findings.findByIdInThread(request.findingId, context.threadId);
    if (record.isErr()) {
      this.deps.logger.error(
        { requestId, threadId: context.threadId, err: record.error },
        'image.lookup: finding read failed',
      );
      return this.storageFailure(requestId, 'get finding');
    }
    if (record.value === null) {
      // Unknown and other-thread Findings share this exact answer — no ID
      // echo, so ownership of another thread's Finding cannot be probed.
      return this.error(requestId, 'image.lookup: no finding exists in this thread for that ID.');
    }
    const result: ImageLookupResult = { finding: toCanonicalFinding(record.value) };
    this.deps.logger.debug(
      { requestId, threadId: context.threadId, findingId: request.findingId },
      'image.lookup: get_finding complete',
    );
    return this.success(requestId, result);
  }

  // -------------------------------------------------------------------------
  // Shared Image reads
  // -------------------------------------------------------------------------

  /**
   * Refreshes availability through the access port, then reads the descriptor.
   *
   * `hidden` means "indistinguishable from absent": unknown, cross-thread, and
   * Processing all collapse into it, so no caller can probe for Images it does
   * not own or for Ingestion that has not resolved. Rejected and Unavailable
   * Images are readable text — their state, reason, and metadata are the
   * answer — and stay visible here.
   */
  private async readRefreshedImage(
    threadId: string,
    imageId: string,
  ): Promise<Result<ImageDescriptor, 'hidden' | 'storage_failed'>> {
    const refresh = await this.refreshAvailability(threadId, imageId);
    if (refresh.isErr()) {
      return refresh.error === 'visible' ? err('hidden') : err(refresh.error);
    }

    const resolved = await this.deps.images.resolveImage({ threadId, imageId });
    if (resolved.isErr()) {
      return resolved.error.code === 'storage_failed' ? err('storage_failed') : err('hidden');
    }
    // A page or adapter that leaked internal state cannot make it into a response.
    if (resolved.value.state === 'processing') {
      return err('hidden');
    }
    return ok(resolved.value);
  }

  /**
   * Availability refresh only — the ownership check an Image-filtered Finding
   * query needs, without reading a descriptor.
   */
  private async imageVisibleInThread(
    threadId: string,
    imageId: string,
  ): Promise<Result<true, 'hidden' | 'storage_failed'>> {
    const refresh = await this.refreshAvailability(threadId, imageId);
    if (refresh.isErr()) {
      return refresh.error === 'visible' ? err('hidden') : err(refresh.error);
    }
    return ok(true);
  }

  /**
   * Refreshes one Image's state and expiry, classifying the outcome:
   * `ok(true)` readable, `err('visible')` hidden-but-not-an-error
   * (Processing), `err('storage_failed')` operational.
   *
   * Terminal `rejected` / `unavailable` outcomes are readable: a port that
   * reports them as errors still permits text access, because expiry and
   * rejection never remove metadata or Findings.
   */
  private async refreshAvailability(
    threadId: string,
    imageId: string,
  ): Promise<Result<true, 'visible' | 'storage_failed'>> {
    const availability = await this.deps.images.getAvailability({ threadId, imageId });
    if (availability.isErr()) {
      const code = availability.error.code;
      if (code === 'storage_failed') {
        return err('storage_failed');
      }
      if (code === 'rejected' || code === 'unavailable') {
        return ok(true);
      }
      return err('visible');
    }
    if (availability.value.state === 'processing') {
      return err('visible');
    }
    return ok(true);
  }

  // -------------------------------------------------------------------------
  // Capability gate and result shaping
  // -------------------------------------------------------------------------

  /**
   * Re-checks `image.read:thread` against the persona's resolved capabilities
   * (the same evaluation the bridge applies), fail-closed: an unresolvable
   * persona is granted nothing. Approval-gated labels count as permitted for
   * exposure, matching {@link isToolAllowed}'s semantics; the approval gate
   * itself lives in the bridge, not in a read-only handler.
   */
  private rejectWithoutCapability(
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult | null {
    const capabilities = this.resolveCapabilities(context.personaId);
    const granted = [...capabilities.allow, ...capabilities.requireApproval].some(
      (label) => extractCapabilityPrefix(label) === IMAGE_LOOKUP_CAPABILITY_PREFIX,
    );
    if (granted) {
      return null;
    }
    this.deps.logger.warn(
      { requestId, personaId: context.personaId, threadId: context.threadId },
      'image.lookup: rejected — persona lacks the image.read:thread capability',
    );
    return this.error(
      requestId,
      `image.lookup: persona "${context.personaId}" is not granted ${IMAGE_LOOKUP_CAPABILITY}.`,
    );
  }

  /** Fail-closed capability resolution, mirroring the bridge's behavior. */
  private resolveCapabilities(personaId: string): ResolvedCapabilities {
    const none: ResolvedCapabilities = { allow: [], requireApproval: [] };
    const personaRow = this.deps.personaRepository.findById(personaId);
    if (personaRow.isErr() || personaRow.value === null) {
      this.deps.logger.warn(
        { personaId, err: personaRow.isErr() ? personaRow.error : undefined },
        'image.lookup: persona not found, failing closed',
      );
      return none;
    }
    const loaded = this.deps.personaLoader.getByName(personaRow.value.name);
    if (loaded.isErr() || loaded.value === undefined) {
      this.deps.logger.warn(
        { personaId, personaName: personaRow.value.name },
        'image.lookup: loaded persona not found, failing closed',
      );
      return none;
    }
    return loaded.value.resolvedCapabilities ?? none;
  }

  private success(requestId: string, result: ImageLookupResult): ToolCallResult {
    return { requestId, tool: IMAGE_LOOKUP_TOOL_NAME, status: 'success', result };
  }

  private error(requestId: string, message: string): ToolCallResult {
    return { requestId, tool: IMAGE_LOOKUP_TOOL_NAME, status: 'error', error: message };
  }

  /**
   * Maps an access-port page failure to a response.
   *
   * Operational failures get a generic message: the underlying port text stays
   * in the log because it can name storage internals, which a model-facing
   * response never may. A thread page is never itself 'not found' — an empty
   * thread is an empty list — so anything other than storage failure is
   * reported as one rather than leaking a distinguishing cause.
   */
  private portFailure(
    requestId: string,
    error: ImageAccessError,
    operation: string,
  ): ToolCallResult {
    this.deps.logger.error(
      { requestId, operation, code: error.code },
      'image.lookup: image page read failed',
    );
    return this.storageFailure(requestId, operation);
  }

  private storageFailure(requestId: string, operation: string): ToolCallResult {
    this.deps.logger.error({ requestId, operation }, 'image.lookup: storage read failed');
    return this.error(
      requestId,
      `image.lookup: ${operation} failed — the image store could not be read. Try again.`,
    );
  }
}

/**
 * The single not-found answer for Image reads. Unknown, cross-thread, and
 * Processing IDs produce this EXACT text — no ID echo, no cause wording — so
 * the three cannot be told apart by any response difference.
 */
function imageNotFound(): string {
  return (
    'image.lookup: no image is available in this thread for that ID — ' +
    'the ID is unknown, belongs to another thread, or the image is still processing. ' +
    'Ask the user to re-upload if the image is recent.'
  );
}

// ---------------------------------------------------------------------------
// Finding mapping
// ---------------------------------------------------------------------------

function toFindingSummary(record: FindingRecord): ImageLookupFindingSummary {
  return {
    findingId: record.finding.id,
    imageIds: [...record.imageIds],
    question: record.finding.question,
    createdAt: new Date(record.finding.created_at).toISOString(),
    modelName: record.finding.model_name,
  };
}

/**
 * Maps a stored record to the canonical Finding DTO verbatim.
 *
 * No clipping, no rewording, no invented fields: absent optional columns stay
 * absent, and reported usage counters are copied only when the model actually
 * reported them.
 */
function toCanonicalFinding(record: FindingRecord): Finding {
  const row = record.finding;
  const usage: FindingTokenUsage = {};
  if (row.usage_input_tokens !== null) {
    usage.inputTokens = row.usage_input_tokens;
  }
  if (row.usage_output_tokens !== null) {
    usage.outputTokens = row.usage_output_tokens;
  }
  if (row.usage_cache_read_tokens !== null) {
    usage.cacheReadTokens = row.usage_cache_read_tokens;
  }
  if (row.usage_cache_write_tokens !== null) {
    usage.cacheWriteTokens = row.usage_cache_write_tokens;
  }
  return {
    findingId: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    imageIds: [...record.imageIds],
    question: row.question,
    answer: row.answer,
    ...(row.extracted_text !== null ? { extractedText: row.extracted_text } : {}),
    ...(row.uncertainty !== null ? { uncertainty: row.uncertainty } : {}),
    createdAt: row.created_at,
    modelName: row.model_name,
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}
