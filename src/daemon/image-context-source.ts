/**
 * Runtime Image/Finding context sources (TASK-019).
 *
 * Two narrow adapters make the shipped image subsystem usable by the consumers
 * that were deliberately left un-wired by their own tasks:
 *
 * - {@link DaemonImageContextSource} implements the ADR-0002
 *   `ImageContextSource` port (live descriptors, thread inventory, canonical
 *   Findings) for AgentRunner, ContextAssembler, and ContextRoller.
 * - {@link ImageLookupAccessAdapter} implements the `image_lookup`
 *   `ImageLookupAccess` port for the host-tools bridge.
 *
 * Both adapters delegate every state decision to the shipped
 * {@link ImageAccess} implementation: expiry, missing-file transitions, and
 * cross-thread hiding are applied there and are never re-implemented here. The
 * adapters add only thread-scoped reads and the Finding row → DTO mapping.
 * Nothing here projects, budgets, truncates, or renders text; that stays in
 * `src/images/image-context-projection.ts`. Pixel bytes never pass through
 * either adapter.
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';

import type {
  ImageRepository,
  ImageRow,
  ImageThreadPageAnchor,
} from '../core/database/repositories/image-repository.js';
import type {
  FindingRepository,
  FindingRecord,
} from '../core/database/repositories/finding-repository.js';
import type {
  ImageAccess,
  ImageAccessError,
  ImageAccessRequest,
  ImageAvailability,
  ImageDescriptor,
  ImageInspectionBytes,
} from '../images/image-types.js';
import type { Finding, FindingTokenUsage } from '../images/finding-types.js';
import type { ImageContextSource } from './context-assembler.js';
import type {
  FindImagePageOptions,
  ImageLookupAccess,
  ImagePage,
} from '../tools/host-tools/image-lookup.js';

/**
 * Bounded read window for both context inventories.
 *
 * The projection budgets (20 descriptors, 10 Findings) select what is
 * rendered; reading exactly those counts would make every omission notice a
 * lie. One window equal to the `image_lookup` page ceiling keeps the read
 * bounded while still letting the projection report honest omissions, and any
 * deeper history stays reachable through lookup paging.
 */
export const IMAGE_CONTEXT_READ_WINDOW = 100;

/** States a context consumer may see. `processing` is internal to Ingestion. */
const VISIBLE_IMAGE_STATES = ['available', 'rejected', 'unavailable'] as const;

/** Constructor dependencies shared by both adapters. */
export interface ImageContextAdapterDeps {
  imageRepo: ImageRepository;
  /** Shipped ImageAccess implementation — the only availability authority. */
  imageAccess: ImageAccess;
  logger: pino.Logger;
}

/** Outcome of refreshing a batch of rows, plus the first operational fault. */
interface RefreshedRows {
  descriptors: ImageDescriptor[];
  /** Rows hidden by the authority (unknown, cross-thread, or Processing). */
  skipped: number;
  /**
   * The first `storage_failed` refusal, or null when no row hit one. Only the
   * {@link ImageLookupAccessAdapter} acts on it; a projection read degrades
   * instead of failing.
   */
  storageFailure: ImageAccessError | null;
}

/**
 * Refreshes rows into current descriptors through {@link ImageAccess}.
 *
 * Each read applies the shipped expiry/missing-file transition order, so a
 * descriptor is never emitted as Available after its file is gone. A refused
 * row never contributes a descriptor, but the two refusal classes are told
 * apart here rather than conflated: `storage_failed` is an operational fault
 * reported through {@link RefreshedRows.storageFailure}, while every other
 * class is a deliberate hiding that only increments `skipped`. Callers decide
 * which of the two they can survive — see {@link refreshDescriptors} and
 * {@link ImageLookupAccessAdapter.findThreadPage}.
 */
async function refreshRows(
  rows: readonly ImageRow[],
  deps: ImageContextAdapterDeps,
  surface: string,
): Promise<RefreshedRows> {
  const descriptors: ImageDescriptor[] = [];
  let skipped = 0;
  let storageFailure: ImageAccessError | null = null;
  for (const row of rows) {
    const fresh = await deps.imageAccess.resolveImage({
      threadId: row.thread_id,
      imageId: row.id,
    });
    if (fresh.isErr()) {
      // Record the code only; an ImageAccess message must not reach a caller
      // through this layer. The first fault is enough to fail the whole read.
      if (fresh.error.code === 'storage_failed' && storageFailure === null) {
        storageFailure = fresh.error;
      }
      skipped += 1;
      continue;
    }
    descriptors.push(fresh.value);
  }
  if (skipped > 0) {
    deps.logger.debug(
      { requested: rows.length, delivered: descriptors.length, skipped },
      `image context: unreadable Images omitted from refreshed ${surface}`,
    );
  }
  return { descriptors, skipped, storageFailure };
}

/**
 * Projection-side refresh: skip-and-count, never fail.
 *
 * A context projection is additive detail on top of a real answer, so one
 * unreadable Image must not remove the rest of it. A storage fault degrades
 * the inventory exactly like a hidden row does and is only counted, which is
 * why {@link RefreshedRows.storageFailure} is deliberately discarded here.
 */
async function refreshDescriptors(
  rows: readonly ImageRow[],
  deps: ImageContextAdapterDeps,
): Promise<ImageDescriptor[]> {
  const refreshed = await refreshRows(rows, deps, 'inventory');
  return refreshed.descriptors;
}

/**
 * Maps one stored Finding record to the canonical Finding DTO verbatim.
 *
 * No clipping, rewording, or invented fields: absent optional columns stay
 * absent and reported usage counters are copied only when the model reported
 * them. The projection service owns every display decision.
 */
function toFinding(record: FindingRecord): Finding {
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

// ---------------------------------------------------------------------------
// ADR-0002 context source
// ---------------------------------------------------------------------------

/**
 * The daemon's {@link ImageContextSource}: the three reads ADR-0002 allows,
 * each rebuilt from durable records at call time.
 *
 * Reads never join `messages`, so a history cutoff, a purged transcript, or a
 * failed run cannot hide an Image or a Finding. A failing database read throws
 * — callers (AgentRunner, ContextRoller) catch and degrade to a projection-less
 * prompt, which is the shipped behavior.
 */
export class DaemonImageContextSource implements ImageContextSource {
  private readonly deps: ImageContextAdapterDeps & { findings: FindingRepository };

  constructor(deps: ImageContextAdapterDeps & { findings: FindingRepository }) {
    this.deps = deps;
  }

  /**
   * The current-message Images of one (thread, message) in source order.
   *
   * The owning Message is the trusted association ADR-0002 rebuilds on every
   * provider attempt. Rows of another thread are dropped without a trace, and
   * `processing` rows are returned untouched: the shipped descriptor renderer
   * is what excludes them.
   */
  async resolveMessageDescriptors(request: {
    threadId: string;
    messageId: string;
  }): Promise<ImageDescriptor[]> {
    const found = this.deps.imageRepo.findByMessage(request.messageId);
    if (found.isErr()) {
      throw found.error;
    }
    const rows = found.value.filter((row) => row.thread_id === request.threadId);
    return refreshDescriptors(rows, this.deps);
  }

  /**
   * The thread's non-Processing descriptor inventory, newest receipt first —
   * the same `(received_at DESC, id ASC)` order the projection and lookup use.
   */
  async listThreadDescriptors(threadId: string): Promise<ImageDescriptor[]> {
    const found = this.deps.imageRepo.findThreadPage({
      threadId,
      states: VISIBLE_IMAGE_STATES,
      limit: IMAGE_CONTEXT_READ_WINDOW,
    });
    if (found.isErr()) {
      throw found.error;
    }
    return refreshDescriptors(found.value.images, this.deps);
  }

  /**
   * The thread's canonical Findings, newest first, independent of any message
   * cutoff — including Findings recorded by runs that later failed.
   *
   * A synchronous ledger read wrapped in the port's Promise shape: Finding rows
   * carry no derived state, so there is nothing to refresh.
   */
  listThreadFindings(threadId: string): Promise<Finding[]> {
    const page = this.deps.findings.findPage({ threadId, limit: IMAGE_CONTEXT_READ_WINDOW });
    if (page.isErr()) {
      return Promise.reject(page.error);
    }
    return Promise.resolve(page.value.findings.map(toFinding));
  }
}

// ---------------------------------------------------------------------------
// image_lookup access
// ---------------------------------------------------------------------------

/**
 * The `image_lookup` Image port: {@link ImageAccess} reads are delegated to the
 * shipped implementation untouched, and the one page read is the repository's
 * keyset query in the order the tool documents.
 *
 * Processing Images are excluded by the query, and every row on the page is
 * still put through {@link ImageAccess.resolveImage} so the page reports
 * current state rather than the state stored at admission. `nextAnchor` is
 * derived from the raw page, so an Image that becomes unreadable mid-page
 * shifts nothing: the next page continues exactly where this one stopped.
 *
 * Unlike a context projection, a page read does NOT survive a storage fault.
 * A tool response is an authoritative answer about what the thread contains,
 * so a row that could not be read must never be silently dropped from it: that
 * would present a truncated — or empty — inventory as a complete one. The
 * first `storage_failed` refusal fails the whole page, which is exactly what
 * the shipped handler does when it re-refreshes the entry itself. Every other
 * refusal class stays a silent omission, because unknown, cross-thread, and
 * Processing Images are deliberately indistinguishable and must not be
 * upgraded into an operational error.
 */
export class ImageLookupAccessAdapter implements ImageLookupAccess {
  private readonly deps: ImageContextAdapterDeps;

  constructor(deps: ImageContextAdapterDeps) {
    this.deps = deps;
  }

  resolveImage(request: {
    threadId: string;
    imageId: string;
  }): Promise<Result<ImageDescriptor, ImageAccessError>> {
    return this.deps.imageAccess.resolveImage(request);
  }

  getAvailability(
    request: ImageAccessRequest,
  ): Promise<Result<ImageAvailability, ImageAccessError>> {
    return this.deps.imageAccess.getAvailability(request);
  }

  fetchInspectionBytes(
    request: ImageAccessRequest,
  ): Promise<Result<ImageInspectionBytes, ImageAccessError>> {
    return this.deps.imageAccess.fetchInspectionBytes(request);
  }

  async findThreadPage(
    options: FindImagePageOptions,
  ): Promise<Result<ImagePage, ImageAccessError>> {
    const anchor: ImageThreadPageAnchor | null = options.before ?? null;
    const page = this.deps.imageRepo.findThreadPage({
      threadId: options.threadId,
      states: VISIBLE_IMAGE_STATES,
      limit: options.limit,
      before: anchor,
    });
    if (page.isErr()) {
      return err({
        code: 'storage_failed',
        message: 'failed to read image page',
      });
    }

    const refreshed = await refreshRows(page.value.images, this.deps, 'lookup page');
    if (refreshed.storageFailure !== null) {
      // Closed code only, matching the repository-fault branch above: the
      // authority's own message never crosses this boundary.
      return err({
        code: 'storage_failed',
        message: 'failed to refresh image page entries',
      });
    }

    return ok({
      images: refreshed.descriptors,
      nextAnchor: page.value.nextAnchor
        ? {
            receivedAt: page.value.nextAnchor.receivedAt,
            imageId: page.value.nextAnchor.imageId,
          }
        : null,
    });
  }
}
