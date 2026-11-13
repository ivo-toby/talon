/**
 * Tests for bounded media transport (TASK-004).
 *
 * Covers: one fixed 60-second message-scoped budget shared by all lookups
 * (never reset by retries or alternate downloads), the shared AbortSignal,
 * byte capping DURING consumption (source destroyed at overflow), deadline
 * interruption of in-flight streams, late-result cleanup (no staging),
 * partial-staging removal on failure, closed-error mapping, and sanitized
 * filename/MIME/source-order outputs that retain no credentials or download
 * URLs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  createMessageFetchBudget,
  fetchImage,
  MESSAGE_FETCH_BUDGET_MS,
  type ImageFetchRequest,
  type ImageTransportError,
  type MediaStream,
} from '@talon/images/image-transport.js';
import {
  ImageStore,
  type ImageStoreError,
  type StagedSourceFile,
} from '@talon/images/image-store.js';
import { selectImages } from '@talon/images/image-selection.js';
import { err, ok, type Result } from '@talon/core/types/result.js';

function _unsafeUnwrapOk<T>(r: Result<T, unknown>): T {
  if (r.isOk()) {
    return r.value;
  }
  throw new Error(`Expected ok, got err: ${JSON.stringify(r.error)}`);
}

function _unsafeUnwrapErr<T>(r: Result<T, unknown>): unknown {
  if (r.isErr()) {
    return r.error;
  }
  throw new Error(`Expected err, got ok: ${JSON.stringify(r.value)}`);
}

async function flush(): Promise<void> {
  // Let pending microtasks and stream events settle without advancing time.
  await vi.advanceTimersByTimeAsync(0);
}

async function collect<T>(p: Promise<T>): Promise<T> {
  return await p;
}

describe('createMessageFetchBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the fixed 60-second message budget', () => {
    expect(MESSAGE_FETCH_BUDGET_MS).toBe(60_000);
    const budget = createMessageFetchBudget();
    expect(budget.deadlineAt).toBe(Date.now() + 60_000);
    expect(budget.expired()).toBe(false);
    expect(budget.remainingMs()).toBe(60_000);
  });

  it('owns exactly one timer, cleared by dispose', () => {
    const budget = createMessageFetchBudget();
    expect(vi.getTimerCount()).toBe(1);
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts the shared signal when the deadline elapses', () => {
    const budget = createMessageFetchBudget();
    expect(budget.signal.aborted).toBe(false);
    vi.advanceTimersByTime(59_999);
    expect(budget.signal.aborted).toBe(false);
    expect(budget.expired()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.expired()).toBe(true);
    expect(budget.remainingMs()).toBe(0);
  });
});

describe('fetchImage — one shared budget across lookups', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never resets the deadline: a retry sees the first lookup consumed time', async () => {
    const budget = createMessageFetchBudget();

    // First lookup: an open that resolves after 40s, then a stream that ends.
    const first = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 1000,
      open: async (signal) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 40_000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        return Readable.from([Buffer.from('first')]);
      },
    });
    await vi.advanceTimersByTimeAsync(40_000);
    const firstResult = await first;
    expect(_unsafeUnwrapOk(firstResult).size).toBe(5);
    expect(budget.remainingMs()).toBe(20_000);

    // Retry / alternate download: only the REMAINING 20s exist.
    const second = fetchImage(budget, {
      candidateIndex: 1,
      maxBytes: 1000,
      open: async () => new PassThrough(),
    });
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    await flush();
    expect(secondDone).toBe(false); // still in flight — no fresh 60s window
    expect(budget.remainingMs()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const secondResult = await second;
    expect(secondResult.isErr()).toBe(true);
    if (secondResult.isErr()) {
      expect(secondResult.error.code).toBe('download_failed');
    }
    budget.dispose();
  });

  it('shares one AbortSignal across all lookups and does not attempt work after the deadline', async () => {
    const budget = createMessageFetchBudget();
    let seenSignal: AbortSignal | undefined;
    const requests: Array<ImageFetchRequest & { calls: number }> = [];
    const make = (index: number) =>
      ({
        candidateIndex: index,
        maxBytes: 100,
        open: async (signal: AbortSignal) => {
          seenSignal = signal;
          requests[index].calls += 1;
          return Readable.from([Buffer.from('x')]);
        },
        calls: 0,
      }) as ImageFetchRequest & { calls: number };
    requests.push(make(0), make(1));

    const first = await fetchImage(budget, requests[0]);
    expect(first.isOk()).toBe(true);
    expect(seenSignal).toBe(budget.signal);

    await vi.advanceTimersByTimeAsync(60_001);
    const second = await fetchImage(budget, requests[1]);
    expect(second.isErr()).toBe(true);
    if (second.isErr()) {
      expect(second.error.code).toBe('download_failed');
    }
    expect(requests[1].calls).toBe(0); // no fetch attempted after the deadline
    budget.dispose();
  });
});

describe('fetchImage — bounded consumption', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps bytes DURING consumption: overflow destroys the source before full buffering', async () => {
    const budget = createMessageFetchBudget();
    const source = new PassThrough();
    const resultPromise = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => source,
    });
    await flush();
    expect(source.readable).toBe(true);

    // Push 10-byte chunks until the stream is destroyed by the cap.
    let chunksPushed = 0;
    while (!source.destroyed && chunksPushed < 100) {
      source.write(Buffer.alloc(10, 1));
      chunksPushed += 1;
      await flush();
    }
    expect(source.destroyed).toBe(true);
    expect(chunksPushed).toBeLessThan(100); // the cap fired before the source drained

    const result = await collect(resultPromise);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('size_limit');
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain('100 byte limit');
    }
    budget.dispose();
  });

  it('aborts an in-flight stream when the message deadline fires', async () => {
    const budget = createMessageFetchBudget();
    const source = new PassThrough();
    const resultPromise = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 10_000,
      open: async () => source,
    });
    await flush();
    source.write(Buffer.alloc(10, 1)); // some progress, then silence
    await flush();

    vi.advanceTimersByTimeAsync(60_000);
    const result = await collect(resultPromise);
    expect(source.destroyed).toBe(true);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
      expect(result.error.retryable).toBe(true);
    }
    budget.dispose();
  });

  it('settles promptly at the deadline even while open is still gated, then destroys the late stream', async () => {
    const budget = createMessageFetchBudget();
    let releaseOpen: ((stream: MediaStream) => void) | undefined;
    const gate = new Promise<MediaStream>((resolve) => {
      releaseOpen = resolve;
    });
    const resultPromise = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: () => gate,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(60_001);

    // PROMPT settlement: the outcome arrives while the gate is still held.
    const result = await collect(resultPromise);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
    }

    // Release the late stream: settlement-attached cleanup must destroy it.
    const late = new PassThrough();
    releaseOpen?.(late);
    await flush();
    expect(late.destroyed).toBe(true);
    budget.dispose();
  });

  it('consumes a Web ReadableStream (fetch-body shaped source)', async () => {
    const budget = createMessageFetchBudget();
    const bytes = Buffer.from('web-stream-bytes');
    const web = new WebReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
    const result = await fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => web,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.bytes.equals(bytes)).toBe(true);
      expect(result.value.size).toBe(bytes.length);
    }
    budget.dispose();
  });

  it('maps stream errors to download_failed with a FIXED message (no cause text)', async () => {
    const budget = createMessageFetchBudget();
    const source = new PassThrough();
    const resultPromise = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => source,
    });
    await flush();
    source.emit(
      'error',
      new Error(
        'fetch failed GET https://cdn.example.com/media?access_token="STREAMCANARY" Authorization: Basic STREAMBASIC',
      ),
    );
    const result = await collect(resultPromise);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
      expect(result.error.message).toBe('media stream failed');
    }
    expect(JSON.stringify(result)).not.toContain('STREAMCANARY');
    expect(JSON.stringify(result)).not.toContain('STREAMBASIC');
    budget.dispose();
  });

  it('cancels the underlying Web stream when the byte cap overflows', async () => {
    const budget = createMessageFetchBudget();
    let cancelled = false;
    let enqueued = 0;
    const web = new WebReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += 1;
        controller.enqueue(new Uint8Array(50));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => web,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('size_limit');
    }
    await flush();
    expect(cancelled).toBe(true);
    expect(enqueued).toBeLessThan(20); // stopped pulling at the cap, not at the source
    budget.dispose();
  });

  it('cancels the underlying Web stream when the deadline aborts', async () => {
    const budget = createMessageFetchBudget();
    let cancelled = false;
    const web = new WebReadableStream<Uint8Array>({
      start() {
        // Never enqueue, never close: only the deadline can end this.
      },
      cancel() {
        cancelled = true;
      },
    });
    const resultPromise = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => web,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await collect(resultPromise);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
    }
    await flush();
    expect(cancelled).toBe(true);
    budget.dispose();
  });

  it('discards zero-length chunks instead of accumulating them', async () => {
    const budget = createMessageFetchBudget();
    function* flood(): Generator<Buffer> {
      for (let i = 0; i < 50_000; i++) {
        yield Buffer.alloc(0);
      }
      yield Buffer.from('real');
      for (let i = 0; i < 50_000; i++) {
        yield Buffer.alloc(0);
      }
    }
    const result = await fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 10,
      open: async () => Readable.from(flood(), { objectMode: true }),
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.size).toBe(4);
      expect(result.value.bytes.toString()).toBe('real');
    }
    budget.dispose();
  });

  it('never lets empty chunks count toward the byte cap', async () => {
    const budget = createMessageFetchBudget();
    function* empties(): Generator<Buffer> {
      for (let i = 0; i < 50_000; i++) {
        yield Buffer.alloc(0);
      }
    }
    const result = await fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 1,
      open: async () => Readable.from(empties(), { objectMode: true }),
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.size).toBe(0);
    }
    budget.dispose();
  });

  it('contains a locked Web stream as a closed Result instead of rejecting', async () => {
    const budget = createMessageFetchBudget();
    const web = new WebReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1));
      },
    });
    web.getReader(); // lock it: Readable.fromWeb would throw synchronously
    const result = await fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => web,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
    }
    budget.dispose();
  });
});

describe('fetchImage — staging', () => {
  let dataDir: string;
  let store: ImageStore;

  beforeEach(async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    dataDir = await mkdtemp(join(tmpdir(), 'talon-transport-data-'));
    store = new ImageStore(dataDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stages accepted bytes and reports the staged path', async () => {
    const deliveryUuid = 'delivery-1';
    const bytes = Buffer.from('staged-bytes');
    const result = await fetchImage(createMessageFetchBudget(), {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => Readable.from([bytes]),
      staging: { store, deliveryUuid },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const stagedPath = _unsafeUnwrapOk(store.stagingSourcePath(deliveryUuid));
      expect(result.value.stagedPath).toBe(stagedPath);
      expect((await readFile(stagedPath)).equals(bytes)).toBe(true);
      expect(result.value.size).toBe(bytes.length);
    }
  });

  it('removes partial staging when the stream overflows the cap', async () => {
    const deliveryUuid = 'delivery-2';
    // Simulate a partial staging left by an earlier failed attempt.
    const stagingDir = _unsafeUnwrapOk(store.ensureStagingDir(deliveryUuid));
    await writeFile(join(stagingDir, 'stale-part'), 'partial');
    expect(existsSync(stagingDir)).toBe(true);

    const source = new PassThrough();
    const resultPromise = fetchImage(createMessageFetchBudget(), {
      candidateIndex: 0,
      maxBytes: 20,
      open: async () => source,
      staging: { store, deliveryUuid },
    });
    await flush();
    let chunksPushed = 0;
    while (!source.destroyed && chunksPushed < 50) {
      source.write(Buffer.alloc(10, 1));
      chunksPushed += 1;
      await flush();
    }
    const result = await collect(resultPromise);
    expect(result.isErr()).toBe(true);
    expect(existsSync(stagingDir)).toBe(false); // partial staging cleaned
  });

  it('settles promptly when the staging write ignores the deadline and cleans the late write', async () => {
    const deliveryUuid = 'delivery-3';
    const calls: string[] = [];
    // A fake staging store whose write is held open by a gate: it never
    // observes the abort signal.
    let releaseWrite: ((r: Result<StagedSourceFile, ImageStoreError>) => void) | undefined;
    const gate = new Promise<Result<StagedSourceFile, ImageStoreError>>((resolve) => {
      releaseWrite = resolve;
    });
    const slowStore = {
      writeStagingSource: async (uuid: string) => {
        calls.push(`write:${uuid}`);
        return gate;
      },
      removeStagingDir: (uuid: string) => {
        calls.push(`remove:${uuid}`);
      },
    } as unknown as ImageStore;

    const budget = createMessageFetchBudget();
    const resultPromise = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => Readable.from([Buffer.from('late')]),
      staging: { store: slowStore, deliveryUuid },
    });
    await vi.advanceTimersByTimeAsync(60_001);

    // PROMPT settlement: the outcome arrives while the write is still gated.
    const result = await collect(resultPromise);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
    }
    expect(calls).toContain(`write:${deliveryUuid}`);
    expect(calls).not.toContain(`remove:${deliveryUuid}`);

    // Release the late write: settlement-attached cleanup must remove it.
    releaseWrite?.(ok({ path: `/staged/${deliveryUuid}/source.bin`, size: 4 }));
    await flush();
    expect(calls).toContain(`remove:${deliveryUuid}`);
    budget.dispose();
  });

  it('cleans staging when a late staging write settles as an Err Result', async () => {
    const deliveryUuid = 'delivery-3b';
    const calls: string[] = [];
    // An fs failure can settle as an Err Result with partial files already
    // on disk — cleanup must run on EVERY eventual settlement shape.
    let releaseWrite: ((r: Result<StagedSourceFile, ImageStoreError>) => void) | undefined;
    const gate = new Promise<Result<StagedSourceFile, ImageStoreError>>((resolve) => {
      releaseWrite = resolve;
    });
    const slowStore = {
      writeStagingSource: async (uuid: string) => {
        calls.push(`write:${uuid}`);
        return gate;
      },
      removeStagingDir: (uuid: string) => {
        calls.push(`remove:${uuid}`);
      },
    } as unknown as ImageStore;

    const budget = createMessageFetchBudget();
    const resultPromise = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => Readable.from([Buffer.from('late')]),
      staging: { store: slowStore, deliveryUuid },
    });
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await collect(resultPromise);
    expect(result.isErr()).toBe(true);
    expect(calls).not.toContain(`remove:${deliveryUuid}`);

    // Late Err Result (partial fs write then failure): still cleaned.
    releaseWrite?.(err({ code: 'io', retryable: true, message: 'disk full mid-write' }));
    await flush();
    expect(calls).toContain(`remove:${deliveryUuid}`);
    budget.dispose();
  });

  it('consumes a late REJECTING write with no unhandledRejection and cleans staging', async () => {
    const deliveryUuid = 'delivery-3c';
    const calls: string[] = [];
    let rejectWrite: ((reason: unknown) => void) | undefined;
    const gate = new Promise<Result<StagedSourceFile, ImageStoreError>>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const slowStore = {
      writeStagingSource: async (uuid: string) => {
        calls.push(`write:${uuid}`);
        return gate;
      },
      removeStagingDir: (uuid: string) => {
        calls.push(`remove:${uuid}`);
      },
    } as unknown as ImageStore;

    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const budget = createMessageFetchBudget();
    try {
      const resultPromise = fetchImage(budget, {
        candidateIndex: 0,
        maxBytes: 100,
        open: async () => Readable.from([Buffer.from('late')]),
        staging: { store: slowStore, deliveryUuid },
      });
      await vi.advanceTimersByTimeAsync(60_001);
      const result = await collect(resultPromise);
      expect(result.isErr()).toBe(true);
      expect(calls).not.toContain(`remove:${deliveryUuid}`);

      // The late write REJECTS (not an Err Result): cleanup must still run
      // and the rejection must be CONSUMED by the cleanup chain.
      rejectWrite?.(new Error('late write exploded'));
      await flush();
      await flush();
      await new Promise((resolve) => process.nextTick(resolve));
      expect(calls).toContain(`remove:${deliveryUuid}`);
      expect(seen).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      budget.dispose();
    }
  });

  it('contains a synchronously throwing opener as a closed Result and cleans staging', async () => {
    const deliveryUuid = 'delivery-sync-throw';
    const stagingDir = _unsafeUnwrapOk(store.ensureStagingDir(deliveryUuid));
    await writeFile(join(stagingDir, 'stale-part'), 'partial');
    expect(existsSync(stagingDir)).toBe(true);

    const result = await fetchImage(createMessageFetchBudget(), {
      candidateIndex: 0,
      maxBytes: 100,
      // NOT async: the throw happens during the INVOCATION, before any
      // promise exists to race.
      open: () => {
        throw new Error("sync boom access_token='SYNCCANARY'");
      },
      staging: { store, deliveryUuid },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
      expect(result.error.message).toBe('media open failed');
    }
    expect(JSON.stringify(result)).not.toContain('SYNCCANARY');
    expect(existsSync(stagingDir)).toBe(false); // cleanup ran on the sync-throw path
  });

  it('cleans pre-existing staging when a retry is skipped by an already-expired budget', async () => {
    const deliveryUuid = 'delivery-4';
    const stagingDir = _unsafeUnwrapOk(store.ensureStagingDir(deliveryUuid));
    await writeFile(join(stagingDir, 'stale-part'), 'partial');
    expect(existsSync(stagingDir)).toBe(true);

    const budget = createMessageFetchBudget();
    await vi.advanceTimersByTimeAsync(60_001);
    let opened = 0;
    const result = await fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 10,
      open: async () => {
        opened += 1;
        return Readable.from([Buffer.alloc(1)]);
      },
      staging: { store, deliveryUuid },
    });
    expect(result.isErr()).toBe(true);
    expect(opened).toBe(0); // still no fetch attempted after the deadline
    expect(existsSync(stagingDir)).toBe(false); // expired skip cleans staging
    budget.dispose();
  });
});

describe('fetchImage — metadata and secret hygiene', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('outputs sanitized filename/MIME, the source-order index, and nothing sensitive', async () => {
    const budget = createMessageFetchBudget();
    const result = await fetchImage(budget, {
      candidateIndex: 3,
      mediaRef: 'https://api.telegram.org/file/bot123:TOKEN/BQACAgUAAx0?token=secret&sig=deadbeef',
      mimeType: 'IMAGE/WebP; charset=binary',
      filename: '../../etc/passwd',
      maxBytes: 1000,
      open: async () => Readable.from([Buffer.from('payload')]),
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.candidateIndex).toBe(3);
      expect(result.value.mimeType).toBe('image/webp');
      expect(result.value.filename).toBe('.._.._etc_passwd');
      const durable = JSON.stringify(result);
      expect(durable).not.toContain('TOKEN');
      expect(durable).not.toContain('api.telegram');
      expect(durable).not.toContain('secret');
      expect(durable).not.toContain('deadbeef');
      expect(durable).not.toContain('mediaRef');
    }
    budget.dispose();
  });

  it('returns FIXED error messages that cannot carry quoted or basic-auth canaries', async () => {
    const budget = createMessageFetchBudget();
    const result = await fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 100,
      open: async () => {
        throw new Error(
          'GET https://graph.facebook.com/v19/media?access_token="QUOTECANARY" failed with Authorization: Basic BASICCANARY',
        );
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Fixed text: no cause interpolation at all, so no scrub can fail.
      expect(result.error.message).toBe('media open failed');
    }
    const durable = JSON.stringify(result);
    expect(durable).not.toContain('QUOTECANARY');
    expect(durable).not.toContain('BASICCANARY');
    expect(durable).not.toContain('graph.facebook.com');
    budget.dispose();
  });

  it('never echoes the opaque mediaRef into any output', async () => {
    const budget = createMessageFetchBudget();
    const ok = await fetchImage(budget, {
      candidateIndex: 0,
      mediaRef: 'telegram-file-id-9f8e7',
      maxBytes: 100,
      open: async () => Readable.from([Buffer.from('x')]),
    });
    expect(JSON.stringify(ok)).not.toContain('telegram-file-id-9f8e7');
    budget.dispose();
  });
});

describe('fetchImage — closed error vocabulary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only ever produces download_failed or size_limit', async () => {
    const budget = createMessageFetchBudget();
    const outcomes: Array<Promise<Result<{ size: number }, ImageTransportError>>> = [
      fetchImage(budget, {
        candidateIndex: 0,
        maxBytes: 100,
        open: async () => {
          throw new Error('boom');
        },
      }),
      fetchImage(budget, {
        candidateIndex: 1,
        maxBytes: 1,
        open: async () => Readable.from([Buffer.alloc(5, 1)]),
      }),
      fetchImage(budget, {
        candidateIndex: 2,
        maxBytes: 100,
        open: async () => new PassThrough(),
      }),
    ];
    vi.advanceTimersByTimeAsync(60_001);
    for (const outcome of outcomes) {
      const settled = await collect(outcome);
      expect(settled.isErr()).toBe(true);
      if (settled.isErr()) {
        expect(['download_failed', 'size_limit']).toContain(settled.error.code);
      }
    }
    budget.dispose();
  });
});

describe('selection → transport seam', () => {
  let dataDir: string;
  let store: ImageStore;

  beforeEach(async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    dataDir = await mkdtemp(join(tmpdir(), 'talon-seam-data-'));
    store = new ImageStore(dataDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('fetches and stages exactly the selected fetchable candidates, in source order', async () => {
    const selection = selectImages(
      [
        // 0: excluded pre-slot (sticker)
        { origin: 'photo', mimeType: 'image/webp', filename: 's.webp', sticker: true },
        // 1: slotted, rejected post-slot (unsupported MIME), never fetched
        { origin: 'photo', mimeType: 'image/heic', filename: 'h.heic' },
        // 2: excluded pre-slot (non-image document)
        { origin: 'document', mimeType: 'application/pdf', filename: 'd.pdf' },
        // 3 + 4: selected, fetched and staged (slots 1 and 2; slot 0 was
        // consumed by the unsupported HEIC item and never backfilled)
        { origin: 'photo', mimeType: 'IMAGE/JPEG; charset=binary', filename: 'a.jpg' },
        { origin: 'photo', mimeType: 'image/png', filename: 'b.png' },
        // 5: over the slot cap, rejected count_limit, never fetched
        { origin: 'photo', mimeType: 'image/webp', filename: 'c.webp' },
      ],
      { maxInputBytes: 1_000_000, maxPerMessage: 3 },
    );

    const opened: number[] = [];
    const stagedPaths: string[] = [];
    const budget = createMessageFetchBudget();
    for (const entry of selection.images) {
      if (entry.disposition !== 'selected' || !entry.requiresFetch) {
        continue;
      }
      const sourcePosition = entry.sourcePosition;
      const deliveryUuid = `delivery-${sourcePosition}`;
      const result = await fetchImage(budget, {
        candidateIndex: sourcePosition,
        mimeType: entry.mimeType,
        filename: entry.filename,
        maxBytes: 1_000_000,
        mediaRef: `opaque-ref-${sourcePosition}`,
        staging: { store, deliveryUuid },
        open: async () => {
          opened.push(sourcePosition);
          return Readable.from([Buffer.from(`image-${sourcePosition}`)]);
        },
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.candidateIndex).toBe(sourcePosition);
        const expected = _unsafeUnwrapOk(store.stagingSourcePath(deliveryUuid));
        expect(result.value.stagedPath).toBe(expected);
        stagedPaths.push(result.value.stagedPath as string);
      }
    }
    // The seam actually invokes open() once per selected fetchable Image,
    // in source order, and stages under the real ImageStore path.
    expect(opened).toEqual([3, 4]);
    expect(stagedPaths).toHaveLength(2);
    const first = stagedPaths[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(await readFile(first)).toEqual(Buffer.from('image-3'));
    }
    expect(JSON.stringify(stagedPaths)).not.toContain('opaque-ref');
    budget.dispose();
  });

  it('omits credential/URL-bearing filenames from the serialized selection → transport output', async () => {
    // Fail-closed: the filename field is ABSENT everywhere — selection
    // entry, transport outcome, and even when a connector hands the raw
    // declared name straight to fetchImage.
    const hostile = [
      ["img access_token='SEAM_SINGLE_CANARY'.png", 'SEAM_SINGLE_CANARY'],
      ['doc https://x.test/f token="SEAM_URL_CANARY"', 'SEAM_URL_CANARY'],
      ['img access_token="pre\\"SEAM_ESCAPED_CANARY"', 'SEAM_ESCAPED_CANARY'],
      // Round-4 counterexample: scheme glued to a prefix (no word boundary).
      ['photo_https://api.telegram.org/file/bot123:BOTTOKENCANARY/image.jpg', 'BOTTOKENCANARY'],
    ] as const;

    const budget = createMessageFetchBudget();
    for (const [declared, canary] of hostile) {
      const selection = selectImages(
        [{ origin: 'photo', mimeType: 'image/png', filename: declared }],
        { maxInputBytes: 1_000_000, maxPerMessage: 2 },
      );
      const entry = selection.images[0];
      expect(entry?.disposition).toBe('selected');
      expect(JSON.stringify(selection)).not.toContain(canary);
      expect(
        entry !== undefined && 'filename' in entry ? entry.filename : undefined,
      ).toBeUndefined();

      // Selected entry carries no filename into the transport.
      const viaSelection = await fetchImage(budget, {
        candidateIndex: entry?.sourcePosition ?? 0,
        mimeType: entry?.mimeType,
        filename: entry?.filename,
        maxBytes: 100,
        open: async () => Readable.from([Buffer.from('seam')]),
      });
      expect(viaSelection.isOk()).toBe(true);
      expect(JSON.stringify(viaSelection)).not.toContain(canary);

      // Raw declared name straight into the transport is also omitted.
      const viaRaw = await fetchImage(budget, {
        candidateIndex: 0,
        mimeType: 'image/png',
        filename: declared,
        maxBytes: 100,
        open: async () => Readable.from([Buffer.from('seam')]),
      });
      expect(viaRaw.isOk()).toBe(true);
      if (viaRaw.isOk()) {
        expect('filename' in viaRaw.value ? viaRaw.value.filename : undefined).toBeUndefined();
      }
      expect(JSON.stringify(viaRaw)).not.toContain(canary);
    }

    // Benign filename still flows through the seam untouched.
    const benign = await fetchImage(budget, {
      candidateIndex: 9,
      mimeType: 'image/png',
      filename: 'holiday photo.png',
      maxBytes: 100,
      open: async () => Readable.from([Buffer.from('seam')]),
    });
    expect(benign.isOk()).toBe(true);
    if (benign.isOk()) {
      expect(benign.value.filename).toBe('holiday photo.png');
    }
    budget.dispose();
  });
});
