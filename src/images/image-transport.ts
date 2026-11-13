/**
 * Bounded media transport for one message (TASK-004).
 *
 * Connectors select slots with `image-selection.ts` and then download the
 * accepted items through this module. Two guarantees matter here:
 *
 * **One fixed 60-second budget per message.** {@link createMessageFetchBudget}
 * owns a single `AbortController` and a single wall-clock deadline that spans
 * EVERY media lookup, retry, and alternate download for the message. All
 * `fetchImage` calls share the budget's `AbortSignal`; no per-fetch timer
 * resets or extends the deadline. EVERY pending operation (open, consumption,
 * staging write) is raced against that signal with the house `raceWithAbort`
 * pattern from `image-normalizer.ts` (TASK-003): an operation that ignores
 * the abort can never delay the outcome, and settlement-attached cleanup
 * destroys late streams / removes late writes after the fact. Once the
 * deadline passes, results that settle late are discarded, not staged.
 *
 * **Bounded consumption, not bounded concatenation.** `fetchImage` caps the
 * stream bytes *while consuming*: the moment the running byte count exceeds
 * `maxBytes`, the source stream is destroyed and the attempt resolves as
 * `Rejected/size_limit`. Bytes are never concatenated unbounded and checked
 * afterwards.
 *
 * **Closed errors only.** Every transport failure maps to one of the Image
 * rejection reasons — `download_failed` (open failure, stream error, deadline
 * or abort, late result) or `size_limit` (actual bytes exceeded the limit).
 * Error messages are FIXED text: arbitrary cause text (which could carry
 * signed URLs, quoted credentials, or basic-auth material) is never embedded
 * in a returned error. Outputs carry the sanitized filename/MIME and the
 * source-order index only; a `mediaRef` is an opaque connector-owned handle
 * that is never echoed, logged, or persisted.
 *
 * Staging is optional and explicit: when a request carries a `staging`
 * target (a TASK-003 `ImageStore` plus delivery UUID), accepted bytes are
 * written under `image-staging/{deliveryUuid}/` and any partial staging is
 * removed on overflow, deadline, or failure.
 */

import { ok, err, type Result } from '../core/types/result.js';
import type { Readable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { ImageStore } from './image-store.js';
import { normalizeMimeType, sanitizeFilename } from './image-selection.js';

// ---------------------------------------------------------------------------
// Abort-racing (house pattern from image-normalizer.ts, TASK-003)
// ---------------------------------------------------------------------------

type Settled<T> =
  | { type: 'ok'; value: T }
  | { type: 'error'; error: unknown }
  | { type: 'aborted' };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { type: 'ok', value: await promise };
  } catch (error) {
    return { type: 'error', error };
  }
}

/**
 * Await `work` unless the signal is (or becomes) aborted. An already-aborted
 * signal short-circuits before the work is given any more of the attempt.
 */
async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<Settled<T>> {
  if (signal.aborted) {
    // Abort landed before registration (e.g. during a preceding await);
    // registering a listener now would never fire.
    return { type: 'aborted' };
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      settle(promise),
      new Promise<Settled<T>>((resolve): void => {
        onAbort = (): void => resolve({ type: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Message-scoped fetch budget
// ---------------------------------------------------------------------------

/**
 * The fixed per-message fetch deadline. One budget per message; it is never
 * extended by retries or alternate downloads.
 */
export const MESSAGE_FETCH_BUDGET_MS = 60_000;

/**
 * A single message-scoped fetch budget. Every media lookup, retry, and
 * alternate download in the message consumes this one deadline.
 */
export interface MessageFetchBudget {
  /** Absolute deadline (epoch milliseconds) for the whole message. */
  readonly deadlineAt: number;
  /** Shared abort signal; aborts when the deadline elapses. */
  readonly signal: AbortSignal;
  /** Milliseconds of budget left (0 once the deadline has elapsed). */
  remainingMs(): number;
  /** True once the deadline has elapsed (or the signal aborted early). */
  expired(): boolean;
  /**
   * Clear the deadline timer. Callers MUST dispose once the message's media
   * handling is done so no 60-second timer outlives the message.
   */
  dispose(): void;
}

/**
 * Create the one fixed 60-second budget for a message. All `fetchImage` calls
 * for that message must use this single budget; creating a second budget does
 * NOT extend the first one.
 */
export function createMessageFetchBudget(): MessageFetchBudget {
  const deadlineAt = Date.now() + MESSAGE_FETCH_BUDGET_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('message media fetch budget exhausted'));
  }, MESSAGE_FETCH_BUDGET_MS);
  // The deadline must not keep the daemon alive on its own.
  timer.unref();
  return {
    deadlineAt,
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    expired: () => Date.now() >= deadlineAt || controller.signal.aborted,
    dispose: () => clearTimeout(timer),
  };
}

// ---------------------------------------------------------------------------
// Request / outcome
// ---------------------------------------------------------------------------

/**
 * A byte source for one download attempt: either a Node stream or a Web
 * `ReadableStream` (as produced by `fetch` bodies).
 */
export type MediaStream = Readable | ReadableStream<Uint8Array>;

/**
 * One bounded download within the message budget.
 *
 * `open` receives the SHARED budget signal and must stop producing bytes once
 * it aborts (a misbehaving source is still fenced by the byte cap and the
 * deadline checks around it).
 */
export interface ImageFetchRequest {
  /** Index into the message's selected candidates; echoed back, never interpreted. */
  candidateIndex: number;
  /**
   * Opaque connector-owned media handle (file id, media id, …). Never echoed,
   * logged, or persisted in any output.
   */
  mediaRef?: string;
  /** Declared MIME (metadata only). */
  mimeType?: string;
  /** Declared filename (metadata only). Sanitized in the outcome. */
  filename?: string;
  /** Hard byte bound. Consumption is cut off the moment it is exceeded. */
  maxBytes: number;
  /** Opens the byte stream for one download attempt, bound to `signal`. */
  open: (signal: AbortSignal) => Promise<MediaStream>;
  /**
   * Optional staging target: accepted bytes are written to the delivery's
   * staging source file and partial staging is removed on overflow, deadline,
   * or failure.
   */
  staging?: { store: ImageStore; deliveryUuid: string };
}

/** One successfully downloaded (and optionally staged) image. */
export interface FetchedImage {
  /** Echoed candidate index (source-order metadata). */
  candidateIndex: number;
  /** Actual bytes received (measured, never the declared size). */
  size: number;
  /** The bounded bytes. */
  bytes: Buffer;
  /** Normalized declared MIME, when declared. */
  mimeType?: string;
  /** Sanitized declared filename, when the channel supplied a usable one. */
  filename?: string;
  /** Staged source file path, when `staging` was provided. */
  stagedPath?: string;
}

/**
 * Transport failures, restricted to the closed Image rejection vocabulary:
 *
 * - `download_failed` (operational): the fetch could not be opened, the
 *   stream errored, the message deadline or abort fired, or a result settled
 *   too late to be admissible.
 * - `size_limit` (immediate): actual bytes exceeded `maxBytes` during
 *   consumption.
 *
 * `message` is FIXED text describing the failure stage — arbitrary cause
 * text (signed URLs, quoted credentials, basic-auth material) is never
 * embedded, so nothing sensitive can ride into durable output.
 */
export type ImageTransportError =
  | { code: 'download_failed'; retryable: true; message: string }
  | { code: 'size_limit'; retryable: false; message: string };

// ---------------------------------------------------------------------------
// Bounded download
// ---------------------------------------------------------------------------

/**
 * Download one selected image within the message budget, capping bytes during
 * consumption and (optionally) staging the result.
 *
 * The budget is never reset by this call: a second `fetchImage` on the same
 * budget sees whatever time the first one consumed.
 */
export async function fetchImage(
  budget: MessageFetchBudget,
  request: ImageFetchRequest,
): Promise<Result<FetchedImage, ImageTransportError>> {
  if (budget.expired()) {
    // A skipped retry must not leave a previous attempt's partial staging.
    removeStaging(request);
    return err(downloadFailed('message media fetch deadline already elapsed; no fetch attempted'));
  }

  // The open INVOCATION is contained first: a synchronously throwing opener
  // must still map to a closed error with staging cleanup, not escape the
  // Result contract. Then the returned Promise is raced against the shared
  // deadline: an open() that ignores the abort signal can never delay the
  // outcome. A stream that still arrives late is destroyed on settlement,
  // unread.
  let openPromise: Promise<MediaStream>;
  try {
    openPromise = request.open(budget.signal);
  } catch {
    removeStaging(request);
    return err(downloadFailed('media open failed'));
  }
  const openOutcome = await raceWithAbort(openPromise, budget.signal);
  if (openOutcome.type === 'aborted') {
    removeStaging(request);
    openPromise.then(destroyQuietly, (): void => undefined);
    return err(downloadFailed('media open aborted by the message fetch deadline'));
  }
  if (openOutcome.type === 'error') {
    removeStaging(request);
    return err(downloadFailed('media open failed'));
  }

  const stream = openOutcome.value;
  if (budget.expired()) {
    // A stream that only becomes available after the deadline is late:
    // destroy it unread and stage nothing.
    destroyQuietly(stream);
    removeStaging(request);
    return err(downloadFailed('media stream arrived after the message fetch deadline'));
  }

  const consumed = await consumeBounded(stream, request.maxBytes, budget.signal);
  if (consumed.isErr()) {
    removeStaging(request);
    return err(consumed.error);
  }

  if (budget.expired()) {
    // Consumption finished only after the deadline: a late result. The bytes
    // are discarded and nothing is staged.
    removeStaging(request);
    return err(downloadFailed('media bytes completed after the message fetch deadline'));
  }

  const fetched: FetchedImage = {
    candidateIndex: request.candidateIndex,
    size: consumed.value.length,
    bytes: consumed.value,
    ...metadata(request),
  };

  if (request.staging === undefined) {
    return ok(fetched);
  }

  const store = request.staging.store;
  const deliveryUuid = request.staging.deliveryUuid;
  // Race the staging write too: a write that ignores the abort cannot delay
  // the outcome, and whatever it settles into late is not admissible.
  const writePromise = store.writeStagingSource(deliveryUuid, consumed.value);
  const writeOutcome = await raceWithAbort(writePromise, budget.signal);
  if (writeOutcome.type === 'aborted') {
    // Whatever shape the late write eventually settles into is not
    // admissible: an Ok write, an Err Result (an fs failure can still leave
    // partial files on disk), or a rejection all get the staging directory
    // removed on settlement. The handlers are attached via then(onOk, onErr)
    // — NOT a detached .finally() — so the rejection is CONSUMED by the
    // cleanup chain and never becomes an unhandled process-level rejection.
    void writePromise.then(
      () => {
        store.removeStagingDir(deliveryUuid);
      },
      () => {
        store.removeStagingDir(deliveryUuid);
      },
    );
    return err(downloadFailed('staging write aborted by the message fetch deadline'));
  }
  if (writeOutcome.type === 'error' || writeOutcome.value.isErr()) {
    removeStaging(request);
    return err(downloadFailed('staging write failed'));
  }
  const staged = writeOutcome.value;
  if (budget.expired()) {
    // The deadline elapsed between the last byte and the staging write: the
    // result is late, so the just-written staging is cleaned, not kept.
    removeStaging(request);
    return err(downloadFailed('staging completed after the message fetch deadline'));
  }
  fetched.stagedPath = staged.value.path;
  return ok(fetched);
}

// ---------------------------------------------------------------------------
// Bounded consumption
// ---------------------------------------------------------------------------

/**
 * Read a byte stream into a single Buffer, enforcing `maxBytes` WHILE
 * consuming. Overflow destroys the source and resolves `size_limit` without
 * buffering past the bound; an abort resolves `download_failed`.
 */
async function consumeBounded(
  stream: MediaStream,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Result<Buffer, ImageTransportError>> {
  let nodeStream: Readable;
  try {
    nodeStream = toNodeReadable(stream);
  } catch {
    // A locked or malformed Web stream throws synchronously in fromWeb.
    // Contain it as a closed failure and still fence the source.
    destroyQuietly(stream);
    return err(downloadFailed('media stream could not be adapted'));
  }
  return await new Promise<Result<Buffer, ImageTransportError>>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const onAbort = (): void => {
      finishErr(downloadFailed('media fetch aborted by the message fetch deadline'));
    };

    const onData = (chunk: unknown): void => {
      if (settled) {
        return;
      }
      const bytes = chunkToBuffer(chunk);
      if (bytes === undefined) {
        finishErr(downloadFailed('media stream emitted non-byte data'));
        return;
      }
      if (bytes.length === 0) {
        // Zero-length chunks are discarded, never accumulated: an object-mode
        // readable cannot grow the chunk list without growing counted bytes.
        return;
      }
      total += bytes.length;
      if (total > maxBytes) {
        // Cap enforced during consumption: stop reading and destroy the
        // source now — never concatenate unbounded and check afterwards.
        finishErr(sizeLimitFailure(total, maxBytes));
        return;
      }
      chunks.push(bytes);
    };

    const onEnd = (): void => {
      if (!settled) {
        finishOk(Buffer.concat(chunks));
      }
    };

    const onError = (_cause: unknown): void => {
      // Fixed message: stream cause text is arbitrary and never embedded.
      finishErr(downloadFailed('media stream failed'));
    };

    function finishOk(bytes: Buffer): void {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      nodeStream.destroy();
      resolve(ok(bytes));
    }

    function finishErr(failure: ImageTransportError): void {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      nodeStream.destroy();
      resolve(err(failure));
    }

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    nodeStream.on('data', onData);
    nodeStream.on('end', onEnd);
    nodeStream.on('error', onError);
  });
}

// ---------------------------------------------------------------------------
// Output hygiene
// ---------------------------------------------------------------------------

/** Sanitized outcome metadata for a fetch request (undefined keys omitted). */
function metadata(request: ImageFetchRequest): { mimeType?: string; filename?: string } {
  const mimeType = normalizeMimeType(request.mimeType);
  const filename = sanitizeFilename(request.filename);
  return {
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(filename !== undefined ? { filename } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `Readable.fromWeb` parameter as @types/node declares it. The global
 * `ReadableStream` and the `node:stream/web` one are two structurally
 * identical declarations of the same runtime class, so a cast at this single
 * boundary is needed and safe.
 */
type WebReadableInput = Parameters<typeof NodeReadable.fromWeb>[0];

/** Node readables expose `read`; Web `ReadableStream`s do not. */
function isNodeReadable(stream: MediaStream): stream is Readable {
  return typeof (stream as Readable).read === 'function';
}

/** Accepts either stream family; Web streams are adapted to Node readables. */
function toNodeReadable(stream: MediaStream): Readable {
  if (isNodeReadable(stream)) {
    return stream;
  }
  return NodeReadable.fromWeb(stream as unknown as WebReadableInput);
}

/** Destroy/cancel any stream family without throwing. */
function destroyStream(stream: MediaStream): void {
  if (isNodeReadable(stream)) {
    stream.destroy();
    return;
  }
  const cancel = (stream as { cancel?: () => Promise<unknown> }).cancel;
  if (typeof cancel === 'function') {
    void Promise.resolve(cancel.call(stream)).catch(() => undefined);
  }
}

/** destroyStream for settlement handlers, where throwing is pointless. */
function destroyQuietly(stream: MediaStream): void {
  try {
    destroyStream(stream);
  } catch {
    // Already dead or uncancellable; nothing further to fence.
  }
}

/** Convert an emitted chunk to a Buffer, or `undefined` for non-byte data. */
function chunkToBuffer(chunk: unknown): Buffer | undefined {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, 'utf8');
  }
  return undefined;
}

/** A size_limit failure reporting how far past the bound the stream ran. */
function sizeLimitFailure(actual: number, maxBytes: number): ImageTransportError {
  return {
    code: 'size_limit',
    retryable: false,
    message: `download exceeded the ${maxBytes} byte limit (${actual} bytes received before cutoff)`,
  };
}

/** A download_failed failure. `message` MUST be fixed text, never cause text. */
function downloadFailed(message: string): ImageTransportError {
  return { code: 'download_failed', retryable: true, message };
}

/** Remove the request's staging directory best-effort (idempotent, safe no-op). */
function removeStaging(request: ImageFetchRequest): void {
  if (request.staging !== undefined) {
    request.staging.store.removeStagingDir(request.staging.deliveryUuid);
  }
}
