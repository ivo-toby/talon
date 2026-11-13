/**
 * Baileys image extraction and bounded ingestion (TASK-007).
 *
 * Unwraps the supported Baileys message containers, builds shared image
 * candidates (TASK-004 `selectImages`) from photo messages and image-MIME
 * documents, and fetches the accepted slots through the shared bounded
 * transport (`fetchImage`) with ONE message-scoped fetch budget.
 *
 * Contract pins (Baileys 7.0.0-rc.9, inventory E4 —
 * lib/Utils/messages.js:790–834, lib/Utils/messages.d.ts:78–85,
 * lib/Utils/messages-media.js:296–300 and 412–495):
 * - `downloadMediaMessage(message, 'stream', options, ctx?)` returns
 *   `Promise<Transform>`. Buffer mode concatenates everything and cannot
 *   enforce a bound during consumption, so stream mode is mandatory; the
 *   shared transport destroys the stream on byte/deadline overflow.
 * - Baileys' internal `getHttpStream` calls
 *   `fetch(url, { dispatcher, method, headers })` — `options.signal` is
 *   SILENTLY DROPPED (messages-media.js:296–300) — and pipes the body with
 *   `fetched.pipe(output, { end: true })` (messages-media.js:494). Node ≥ 24
 *   `pipe` attaches no `'error'` listener to the source at all, so a mid-body
 *   upstream failure emits an unconsumed `'error'` event on the internal
 *   `fetched` readable (process-level crash), and destroying the returned
 *   `output` never propagates back to the live HTTP request. Cancellation
 *   and upstream error containment therefore live in
 *   {@link createBaileysMediaTransfer}, which the connector's default
 *   opener runs every download through.
 * - The socket's media-reupload member in rc.9 is `updateMediaMessage`
 *   (lib/Socket/messages-send.js:840); `reuploadRequest` is only the ctx
 *   FIELD name (`messages.d.ts:79`), never a socket member.
 * - Container unwrapping mirrors `normalizeMessageContent`
 *   (lib/Utils/messages.js:597–621): the same six wrapper keys, the same
 *   `container.message` hop, and the same 5-iteration cap. No invented
 *   wrapper shapes.
 * - Media fields are pinned to the WAProto schema: `ImageMessage`
 *   (mimetype=2, caption=3, fileLength=5) and `DocumentMessage`
 *   (mimetype=2, title=3, fileLength=5, fileName=8, caption=20).
 *   `fileLength` is a proto uint64 — it arrives as a number or a
 *   Long-like `{ low, high, unsigned }`; anything unusable degrades to
 *   "unknown declared size", which the bounded byte check still enforces.
 *
 * Policies live in the shared selection module: stickers (including static
 * WebP stickers) and non-image/absent-MIME documents are silently EXCLUDED
 * before slots and never downloaded; overflow is `count_limit` without a
 * download; declared-size oversize is `size_limit` before any fetch.
 * Outcomes are the connector's inbound Attachments: payload `Attachment`s
 * for fetched bytes and metadata-only `InboundAttachmentRejection`s carrying
 * closed Image rejection reasons. No pixels, media keys, media URLs, or
 * credentials ever enter the outcomes — the opaque `mediaRef` concept of the
 * transport is deliberately unused here because the Baileys message object
 * itself is the (never-echoed) handle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable } from 'node:stream';
import type { InboundAttachment, Attachment } from '../../channel-types.js';
import type {
  ImageMediaCandidate,
  ImageSelectionEntry,
} from '../../../images/image-selection.js';
import {
  createMessageFetchBudget,
  fetchImage,
  type MediaStream,
  type MessageFetchBudget,
} from '../../../images/image-transport.js';
import type { ImageRejectionReason } from '../../../images/image-types.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Default per-image input cap. Mirrors the `images.maxInputBytes` default in
 * `src/core/config/config-schema.ts`; the focused test suite asserts parity
 * so the two cannot drift silently until the factory injects the real
 * config block.
 */
export const DEFAULT_MAX_INPUT_BYTES = 10_485_760;

/**
 * Default upload slots per message. Mirrors the `images.maxPerMessage`
 * default in `src/core/config/config-schema.ts` (same parity test).
 */
export const DEFAULT_MAX_PER_MESSAGE = 5;

/**
 * Opens the media stream of one Baileys message within the shared budget.
 * Implementations MUST honour `signal` — the default opener does so through
 * {@link createBaileysMediaTransfer}, because Baileys' own option plumbing
 * drops it — and MUST NOT buffer the whole media before returning.
 */
export type BaileysMediaOpener = (message: unknown, signal: AbortSignal) => Promise<MediaStream>;

/** Fetch signature the media transfer uses for the actual network request. */
export type BaileysMediaTransferFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Injectable knobs for bounded image ingestion. */
export interface BaileysImageIngestOptions {
  /** `images.maxInputBytes` cap; defaults to {@link DEFAULT_MAX_INPUT_BYTES}. */
  maxInputBytes?: number;
  /** `images.maxPerMessage` slots; defaults to {@link DEFAULT_MAX_PER_MESSAGE}. */
  maxPerMessage?: number;
  /** Media opener; production defaults to Baileys stream-mode download. */
  openMedia?: BaileysMediaOpener;
  /**
   * Network fetch used by the default opener's media transfer. Production
   * leaves this unset (the real global fetch, captured per transfer window);
   * tests inject a stubbed transport to exercise the REAL Baileys download
   * path without sockets.
   */
  fetch?: BaileysMediaTransferFetch;
}

/** Resolved settings with defaults applied. */
export interface ResolvedBaileysImageSettings {
  maxInputBytes: number;
  maxPerMessage: number;
  openMedia: BaileysMediaOpener;
  fetch?: BaileysMediaTransferFetch;
}

/** Apply the documented defaults to the optional injection. */
export function resolveBaileysImageSettings(
  options: BaileysImageIngestOptions | undefined,
  defaultOpener: BaileysMediaOpener,
): ResolvedBaileysImageSettings {
  return {
    maxInputBytes: options?.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    maxPerMessage: options?.maxPerMessage ?? DEFAULT_MAX_PER_MESSAGE,
    openMedia: options?.openMedia ?? defaultOpener,
    ...(options?.fetch !== undefined ? { fetch: options.fetch } : {}),
  };
}

// ---------------------------------------------------------------------------
// Media transfer adapter (deadline cancellation + upstream-error containment)
// ---------------------------------------------------------------------------
//
// One transfer owns the ACTUAL network fetch of one `downloadMediaMessage`
// call (including any reupload retry it starts) for a single media slot:
//
// 1. Cancellation: the shared message-budget signal is wired to an internal
//    AbortController handed to the real fetch. When the deadline elapses,
//    the in-flight upstream request is cancelled — the guarantee Baileys'
//    dropped `options.signal` cannot provide. A fetch attempted after the
//    budget expired issues no request at all.
// 2. Error containment: the response body is re-exposed through a pump that
//    CONSUMES every upstream failure (the only handle that can see it) and
//    surfaces it by destroying the bound output Transform — the stream the
//    shared transport actually listens on. The delivered stream is never
//    error()ed and never closed on failure: any signal reaching Baileys'
//    internal `fetched` readable after `fetched.pipe(output)` becomes an
//    unconsumed `'error'` event on Node ≥ 24 (crash), and an early `close`
//    would make Baileys' AES finalizer throw into the same unlistened path.
//
// The global fetch is patched ONLY around the `run()` window (ref-counted)
// and only calls made inside the transfer's AsyncLocalStorage scope are
// intercepted; every other fetch in the process passes through untouched.

/** Minimal structured logger surface for transfer diagnostics. */
export interface BaileysMediaTransferLogger {
  debug(message: string): void;
}

export interface BaileysMediaTransferOptions {
  /** Shared per-message fetch-budget signal. */
  signal: AbortSignal;
  /**
   * Underlying network fetch. Defaults to the real global fetch as
   * captured while the transfer patch is installed.
   */
  fetchImpl?: BaileysMediaTransferFetch;
  logger?: BaileysMediaTransferLogger;
}

export interface BaileysMediaTransfer {
  /**
   * Runs `work` (a `downloadMediaMessage` invocation) with the global fetch
   * intercepted for its async scope. Rejects exactly when `work` rejects and
   * releases all transfer handles in that case. On success the caller MUST
   * hand the returned output stream to {@link bindDownstream} immediately.
   */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Binds the AES-output Transform so failures can destroy it. */
  bindDownstream(stream: Readable): void;
}

type TransferPhase = 'active' | 'failed' | 'closed';

interface TransferState {
  readonly signal: AbortSignal;
  readonly fetch: BaileysMediaTransferFetch | undefined;
  readonly controller: AbortController;
  readonly onBudgetAbort: () => void;
  logger: BaileysMediaTransferLogger | undefined;
  phase: TransferPhase;
  failure: Error | undefined;
  downstream: Readable | undefined;
}

const transferScope = new AsyncLocalStorage<TransferState>();

/** Ref count of active `run()` windows while the global fetch is patched. */
let patchDepth = 0;
/**
 * The fetch that was global when the CURRENT install window opened — used
 * only to restore `globalThis.fetch` on the final exit. The installed
 * wrapper keeps its OWN immutable capture in a closure (see
 * enterFetchPatch), so clearing this variable can never affect a wrapper
 * reference that was handed out earlier.
 */
let windowOriginal: BaileysMediaTransferFetch | undefined;

function fixedTransferFailure(): Error {
  // Fixed text: upstream cause text can carry signed media URLs and is
  // never propagated through this path.
  return new Error('baileys media transfer failed');
}

function enterFetchPatch(): void {
  if (patchDepth === 0) {
    // A DISTINCT wrapper closure per install generation: every retained
    // reference to THIS generation's wrapper must forward to THIS
    // generation's original, forever — even after later generations
    // install over it. A shared module-scope capture would let a retained
    // reference follow a newer generation's original (or recurse into it
    // when that original wraps the retained reference).
    const capturedForThisInstall = globalThis.fetch as BaileysMediaTransferFetch;
    windowOriginal = capturedForThisInstall;
    const wrapperForThisInstall: BaileysMediaTransferFetch = (input, init) => {
      const state = transferScope.getStore();
      if (state === undefined) {
        // Fetches outside any media-transfer scope are unaffected: forward
        // verbatim to the original captured by THIS install generation.
        return capturedForThisInstall(input, init);
      }
      return fetchWithinTransfer(state, input, init, capturedForThisInstall);
    };
    (globalThis as { fetch: unknown }).fetch = wrapperForThisInstall;
  }
  patchDepth += 1;
}

function exitFetchPatch(): void {
  patchDepth -= 1;
  if (patchDepth === 0 && windowOriginal !== undefined) {
    (globalThis as { fetch: unknown }).fetch = windowOriginal;
    windowOriginal = undefined;
  }
}

function cleanupTransfer(state: TransferState): void {
  if (state.phase === 'closed') {
    return;
  }
  state.phase = 'closed';
  state.signal.removeEventListener('abort', state.onBudgetAbort);
  // Releases the in-flight upstream request (no-op once it has completed).
  if (!state.controller.signal.aborted) {
    state.controller.abort();
  }
}

function failTransfer(state: TransferState): void {
  if (state.phase !== 'active') {
    return;
  }
  state.phase = 'failed';
  state.failure = fixedTransferFailure();
  state.logger?.debug('baileys media transfer: upstream body failed; destroying output');
  if (state.downstream !== undefined) {
    state.downstream.destroy(state.failure);
  }
}

/**
 * Re-exposes the real response body as a stream that consumes upstream
 * failures instead of letting them reach Baileys' unlistened `fetched`
 * readable. See the section header for why neither `error()` nor `close()`
 * may be delivered downstream on failure.
 */
function pumpTransferBody(
  state: TransferState,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    pull(pushController): Promise<void> {
      return reader.read().then(
        (read) => {
          if (read.done) {
            pushController.close();
            return;
          }
          pushController.enqueue(read.value);
        },
        () => {
          // The upstream failure is consumed HERE — nowhere else can see it.
          // The delivered stream is left parked: the bound Transform is
          // destroyed instead, which the shared transport maps to the
          // closed `download_failed` outcome.
          failTransfer(state);
        },
      );
    },
    cancel(reason): void {
      // Downstream went away: release the upstream read and the request.
      void reader.cancel(reason).catch(() => undefined);
      cleanupTransfer(state);
    },
  });
}

async function fetchWithinTransfer(
  state: TransferState,
  input: string | URL | Request,
  init: RequestInit | undefined,
  networkFallback: BaileysMediaTransferFetch,
): Promise<Response> {
  if (state.signal.aborted || state.controller.signal.aborted) {
    // Budget elapsed (or the transfer already died): issue NO request —
    // this also keeps Baileys' optional reupload retry from starting a
    // fresh download after the deadline.
    throw new Error('media fetch budget exhausted');
  }
  // The fallback is the calling generation's immutable capture — always a
  // real function.
  const networkFetch = state.fetch ?? networkFallback;
  const callerSignal = init?.signal;
  if (callerSignal !== null && callerSignal !== undefined) {
    if (callerSignal.aborted) {
      throw new Error('media fetch aborted');
    }
    callerSignal.addEventListener(
      'abort',
      () => {
        if (!state.controller.signal.aborted) {
          state.controller.abort();
        }
      },
      { once: true },
    );
  }
  const response = await networkFetch(input, { ...init, signal: state.controller.signal });
  if (!response.ok) {
    // Baileys throws on a non-ok status before consuming the body; release
    // the socket now instead of parking it. Promise consumption is explicit.
    if (response.body !== null) {
      response.body.cancel().catch(() => undefined);
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  if (response.body === null) {
    return response;
  }
  return new Response(pumpTransferBody(state, response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Create the per-slot media transfer for one Baileys download. See the
 * section header for the cancellation and error-containment contract.
 */
export function createBaileysMediaTransfer(
  options: BaileysMediaTransferOptions,
): BaileysMediaTransfer {
  const controller = new AbortController();
  const state: TransferState = {
    signal: options.signal,
    fetch: options.fetchImpl,
    controller,
    onBudgetAbort: () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    },
    logger: options.logger,
    phase: 'active',
    failure: undefined,
    downstream: undefined,
  };
  if (state.signal.aborted) {
    state.onBudgetAbort();
  }
  state.signal.addEventListener('abort', state.onBudgetAbort, { once: true });

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      enterFetchPatch();
      try {
        return await transferScope.run(state, work);
      } catch (error) {
        // Nothing reached the transport: drop the budget listener and the
        // upstream request (no-op when nothing was issued).
        cleanupTransfer(state);
        throw error;
      } finally {
        exitFetchPatch();
      }
    },
    bindDownstream(stream: Readable): void {
      // Permanent no-op 'error' listener: afterwards NO destroy() on this
      // Transform can become an unhandled 'error' event — including after
      // the shared transport settled and detached its own listener.
      stream.on('error', () => undefined);
      // Downstream teardown (byte-cap destroy, late-stream destroyQuietly,
      // normal end) must reach upstream: release the live request.
      stream.once('close', () => cleanupTransfer(state));
      state.downstream = stream;
      if (state.phase === 'failed' && state.failure !== undefined) {
        stream.destroy(state.failure);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Container unwrapping (pinned to Baileys normalizeMessageContent)
// ---------------------------------------------------------------------------

/**
 * The six future-proof wrapper keys handled by Baileys'
 * `normalizeMessageContent` (messages.js:613–619), in the same order.
 * Each wrapper value carries the real content under `.message`.
 */
const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'documentWithCaptionMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'editedMessage',
] as const;

/** Same infinite-loop cap as the pinned normalize implementation. */
const MAX_UNWRAP_ITERATIONS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unwrap ephemeral/view-once/document-with-caption/edited containers to the
 * innermost supported content, mirroring the pinned Baileys normalize
 * contract (same keys, same `.message` hop, same 5-iteration cap). Returns
 * the input unchanged when it is not wrapped; returns `undefined` for
 * absent content.
 */
export function unwrapMessageContent(
  content: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  let current = content ?? undefined;
  if (current === undefined) {
    return undefined;
  }
  for (let i = 0; i < MAX_UNWRAP_ITERATIONS; i += 1) {
    let inner: Record<string, unknown> | undefined;
    for (const key of WRAPPER_KEYS) {
      const wrapper = current[key];
      if (isRecord(wrapper)) {
        inner = wrapper;
        break;
      }
    }
    if (inner === undefined) {
      break;
    }
    const next = inner['message'];
    if (!isRecord(next)) {
      break;
    }
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Text + candidate extraction
// ---------------------------------------------------------------------------

/** Caption/text plus media candidates extracted from one unwrapped content. */
export interface BaileysExtractedContent {
  /** Conversation text, extendedText text, or a media caption. `''` when none. */
  text: string;
  /**
   * Media candidates in source order (at most one per message: Baileys
   * messages carry a single content type). Stickers are included with the
   * exclusion flag so the shared selection drops them uniformly.
   */
  candidates: ImageMediaCandidate[];
}

/**
 * `fileLength` is a proto uint64: Baileys delivers a number or a Long-like
 * `{ low, high, unsigned }` (same handling as `messageTimestamp`). Anything
 * unusable — including magnitudes beyond `Number.MAX_SAFE_INTEGER` — is
 * treated as unknown declared size; the bounded download still enforces the
 * real byte cap.
 */
function declaredSize(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (isRecord(value)) {
    const low = value['low'];
    const high = value['high'];
    if (typeof low === 'number' && typeof high === 'number') {
      const magnitude = (high >>> 0) * 0x1_0000_0000 + (low >>> 0);
      return Number.isSafeInteger(magnitude) ? magnitude : undefined;
    }
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extract the caption/text and the image media candidates from one
 * UNWRAPPED Baileys content record.
 *
 * - `imageMessage` → photo candidate (image content by channel
 *   declaration; its declared mimetype is carried when present).
 * - `documentMessage` → document candidate. Eligibility is MIME-based
 *   (shared selection): absent or non-image MIME is silently excluded,
 *   unsupported image MIME (HEIC…) is a slot-consuming rejection.
 *   `fileName` (proto field 8) wins over the legacy `title` (field 3);
 *   filenames never establish MIME.
 * - `stickerMessage` → candidate flagged `sticker: true` so the shared
 *   selection excludes it silently (platform sticker, including static
 *   WebP) — no download, no Image, no notice.
 * - Anything else (video, audio, location, text-only…) contributes no
 *   candidate. Video/audio captions are NOT newly surfaced: text stays
 *   pinned to the pre-existing extraction plus media captions.
 */
export function extractTextAndMediaCandidates(
  content: Record<string, unknown> | undefined,
): BaileysExtractedContent {
  if (content === undefined) {
    return { text: '', candidates: [] };
  }

  const conversation = stringField(content, 'conversation');
  const extended = content['extendedTextMessage'];
  const extendedText = isRecord(extended) ? stringField(extended, 'text') : undefined;

  const image = content['imageMessage'];
  const document = content['documentMessage'];
  const sticker = content['stickerMessage'];

  let text = conversation ?? extendedText ?? '';
  const candidates: ImageMediaCandidate[] = [];

  if (isRecord(image)) {
    const caption = stringField(image, 'caption');
    if (text === '') {
      text = caption ?? '';
    }
    candidates.push({
      origin: 'photo',
      ...(stringField(image, 'mimetype') !== undefined ? { mimeType: stringField(image, 'mimetype') } : {}),
      ...(declaredSize(image['fileLength']) !== undefined ? { declaredSize: declaredSize(image['fileLength']) } : {}),
    });
  } else if (isRecord(document)) {
    const caption = stringField(document, 'caption');
    if (text === '') {
      text = caption ?? '';
    }
    const filename = stringField(document, 'fileName') ?? stringField(document, 'title');
    const mime = stringField(document, 'mimetype');
    candidates.push({
      origin: 'document',
      ...(mime !== undefined ? { mimeType: mime } : {}),
      ...(filename !== undefined ? { filename } : {}),
      ...(declaredSize(document['fileLength']) !== undefined ? { declaredSize: declaredSize(document['fileLength']) } : {}),
    });
  } else if (isRecord(sticker)) {
    // Sticker captions stay unsurfaced (pre-existing behavior): the
    // candidate exists only so the shared selection excludes it.
    candidates.push({
      origin: 'photo',
      sticker: true,
      ...(stringField(sticker, 'mimetype') !== undefined ? { mimeType: stringField(sticker, 'mimetype') } : {}),
      ...(declaredSize(sticker['fileLength']) !== undefined ? { declaredSize: declaredSize(sticker['fileLength']) } : {}),
    });
  }

  return { text, candidates };
}

// ---------------------------------------------------------------------------
// Bounded fetch → inbound Attachments
// ---------------------------------------------------------------------------

/** Metadata-only rejection carrying no bytes, paths, media refs, or creds. */
function rejectionAttachment(
  entry: ImageSelectionEntry,
  reason: ImageRejectionReason,
): InboundAttachment {
  return {
    kind: 'rejected',
    rejectionReason: reason,
    sourcePosition: entry.sourcePosition,
    ...(entry.filename !== undefined ? { filename: entry.filename } : {}),
    ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
    ...(entry.declaredSize !== undefined ? { size: entry.declaredSize } : {}),
  };
}

/**
 * Fetch the slotted selection entries of one message through the shared
 * bounded transport, in selection (source) order.
 *
 * ONE {@link createMessageFetchBudget} spans every accepted slot's lookup,
 * retry and reupload for this message (fixed 60-second deadline, shared
 * AbortSignal); it is created only when at least one slot must be fetched
 * and is disposed before returning. Selection-rejected entries
 * (`unsupported_mime`, declared-size `size_limit`, `count_limit` overflow)
 * produce metadata-only rejections with NO media request. Fetch failures
 * map to the closed transport vocabulary (`download_failed` / byte-overflow
 * `size_limit`). Results keep source order regardless of the completion
 * order of the concurrent downloads.
 *
 * The caller MUST invoke this only after the connector's
 * authorization/self/group/trigger checks passed — nothing here fetches on
 * its own, but it must never run for an unauthorized message.
 */
export async function fetchSelectedImageAttachments(
  message: unknown,
  entries: readonly ImageSelectionEntry[],
  settings: ResolvedBaileysImageSettings,
): Promise<InboundAttachment[]> {
  const attachments: InboundAttachment[] = new Array<InboundAttachment>(entries.length);
  let budget: MessageFetchBudget | undefined;
  try {
    await Promise.all(
      entries.map(async (entry, index): Promise<void> => {
        if (entry.disposition === 'rejected') {
          // Selection-time rejection: slot consumed, NEVER fetched.
          attachments[index] = rejectionAttachment(entry, entry.rejectionReason);
          return;
        }
        if (budget === undefined) {
          budget = createMessageFetchBudget();
        }
        const fetched = await fetchImage(budget, {
          candidateIndex: entry.slot,
          ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
          ...(entry.filename !== undefined ? { filename: entry.filename } : {}),
          maxBytes: settings.maxInputBytes,
          // The Baileys message object is the opaque media handle; the
          // shared budget signal is threaded into the stream opener.
          open: (signal) => settings.openMedia(message, signal),
        });
        if (fetched.isOk()) {
          const image = fetched.value;
          // Declared metadata stays absent when the channel declared none (an
          // ordinary `imageMessage` has no filename). The ingestion
          // coordinator coerces absence to SQL NULL; an empty string would
          // violate the Image ledger's nonempty filename/mime_type CHECKs and
          // roll back the whole admission transaction.
          const attachment: Attachment = {
            ...(image.filename !== undefined ? { filename: image.filename } : {}),
            ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
            data: image.bytes,
            size: image.size,
          };
          attachments[index] = attachment;
          return;
        }
        // Closed transport vocabulary: download_failed | size_limit. The
        // transport message is fixed text; never echo it into the outcome.
        attachments[index] = rejectionAttachment(entry, fetched.error.code);
      }),
    );
  } finally {
    budget?.dispose();
  }
  return attachments;
}
