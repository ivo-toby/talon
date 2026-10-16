/**
 * TASK-007 tests: Baileys media-transfer adapter against the REAL
 * `downloadMediaMessage` path (no mocked Baileys module in this file).
 *
 * These tests inject a stubbed network fetch through the connector's
 * `imageMedia.fetch` seam so the REAL pinned chain runs end to end:
 * `downloadMediaMessage` → `downloadContentFromMessage` →
 * `downloadEncryptedContent` → `getHttpStream` → global fetch (intercepted
 * by the transfer adapter) → `Readable.fromWeb` → `fetched.pipe(output)`.
 *
 * Pinned failure modes this file proves (reviewer-verified, Baileys
 * 7.0.0-rc.9 + Node ≥ 24 stream semantics):
 * - rc.9's `getHttpStream` DROPS `options.signal` (messages-media.js:296) —
 *   the transfer must therefore make the deadline reach the ACTUAL upstream
 *   request; the stub observes the AbortSignal it receives.
 * - `fetched.pipe(output)` never consumes source `'error'` events (Node 24
 *   pipe attaches no error listener to the source) — a mid-body upstream
 *   failure must settle as the closed `download_failed` with ZERO unhandled
 *   process events, and the upstream request must be released.
 * - Happy path must be byte-correct through the real AES-256-CBC decipher
 *   (fixture encrypted with the real `getMediaKeys`).
 * - The `downloadMediaMessage` reupload retry branch (messages.js:793–803)
 *   matches on `error.status`, which `@hapi/boom` never sets (only
 *   `output.statusCode`) — unreachable in rc.9; pinned here so a future
 *   Baileys change cannot silently alter the outcome vocabulary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { createCipheriv, createHash } from 'node:crypto';
import { getMediaKeys } from '@whiskeysockets/baileys';
import {
  fetchImage,
  createMessageFetchBudget,
  type MessageFetchBudget,
} from '../../../../../src/images/image-transport.js';
import { WhatsAppBaileysConnector } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.js';
import type { BaileysMediaTransferFetch } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-images.js';
import type { WhatsAppBaileysConfig } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-types.js';

const logger = pino({ level: 'silent' });

/** The untouched global fetch, captured before any transfer may patch it. */
const originalGlobalFetch = globalThis.fetch;

const MEDIA_KEY = Buffer.alloc(32, 7);

/**
 * Build a realistic WhatsApp legacy media fixture: plaintext is
 * `data || SHA256(data)` (the on-server format — the trailing hash is part
 * of what the pinned decipher delivers and is NOT stripped by Baileys) and
 * the ciphertext is AES-256-CBC with the REAL pinned key derivation.
 */
async function makeFixture(data = Buffer.from('FAKE-JPEG-PAYLOAD-0123456789abcdef0123456789')): Promise<{
  plaintext: Buffer;
  ciphertext: Buffer;
}> {
  const hash = createHash('sha256').update(data).digest();
  const plaintext = Buffer.concat([data, hash]);
  const keys = await getMediaKeys(MEDIA_KEY, 'image');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { plaintext, ciphertext };
}

/** WAMessage shape the real `downloadMediaMessage` consumes. */
function realMediaMsg(): unknown {
  return {
    key: { fromMe: false, remoteJid: '31612345678@s.whatsapp.net', id: 'real-media-001' },
    message: {
      imageMessage: {
        // `downloadContentFromMessage` only honours mmg.whatsapp.net urls
        // (otherwise it rebuilds one from directPath) — keep the pinned shape.
        url: 'https://mmg.whatsapp.net/fake/encrypted-path',
        mediaKey: MEDIA_KEY,
        mimetype: 'image/jpeg',
        fileLength: 123,
      },
    },
  };
}

function makeConnector(
  fetchImpl: BaileysMediaTransferFetch,
  config: WhatsAppBaileysConfig = {},
): WhatsAppBaileysConnector {
  return new WhatsAppBaileysConnector(config, 'test-baileys', logger, { fetch: fetchImpl });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openMediaOf(c: WhatsAppBaileysConnector, msg: unknown): (signal: AbortSignal) => Promise<import('node:stream').Readable> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (signal: AbortSignal) => (c as any).openMediaWithBaileys(msg, signal);
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function settleAfterDeadline(budget: MessageFetchBudget): Promise<void> {
  // The 60-second budget timer is a plain setTimeout — flush it with the
  // fake timer clock, draining microtasks between timer expirations.
  await vi.advanceTimersByTimeAsync(60_001);
}

// ---------------------------------------------------------------------------
// Process-level hygiene: any unhandled rejection / uncaught exception is a
// review-verified failure class this adapter must eliminate.
// ---------------------------------------------------------------------------

const unhandledEvents: Array<[string, string]> = [];
const onUnhandledRejection = (reason: unknown): void => {
  unhandledEvents.push(['unhandledRejection', String(reason)]);
};
const onUncaughtException = (error: unknown): void => {
  unhandledEvents.push(['uncaughtException', String(error)]);
};

beforeEach(() => {
  unhandledEvents.length = 0;
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
});

afterEach(() => {
  process.removeListener('unhandledRejection', onUnhandledRejection);
  process.removeListener('uncaughtException', onUncaughtException);
  expect(unhandledEvents, `unhandled process events: ${JSON.stringify(unhandledEvents)}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// Happy path + signal reachability
// ---------------------------------------------------------------------------

describe('real downloadMediaMessage — happy path and cancellation surface', () => {
  it('decrypts byte-correct through the real AES path and hands the deadline signal to fetch', async () => {
    const { plaintext, ciphertext } = await makeFixture();
    const signals: AbortSignal[] = [];
    let stubCalls = 0;
    const stubFetch: BaileysMediaTransferFetch = async (_input, init) => {
      stubCalls += 1;
      signals.push(init?.signal as AbortSignal);
      // Two 16-byte-unaligned splits force Baileys' chunk-buffering path.
      return new Response(streamOf([ciphertext.subarray(0, 48), ciphertext.subarray(48)]), {
        status: 200,
      });
    };
    const c = makeConnector(stubFetch);
    const budget = createMessageFetchBudget();
    try {
      const result = await fetchImage(budget, {
        candidateIndex: 0,
        maxBytes: 1_000_000,
        open: openMediaOf(c, realMediaMsg()),
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.bytes.equals(plaintext)).toBe(true);
        expect(result.value.size).toBe(plaintext.length);
      }
      expect(stubCalls).toBe(1);
      // The signal rc.9 would silently drop is now delivered to the ACTUAL
      // fetch by the transfer adapter (and un-aborted while the download
      // was live — deadline propagation itself is pinned by the dedicated
      // deadline suite below).
      expect(signals[0]).toBeInstanceOf(AbortSignal);
    } finally {
      budget.dispose();
    }
    // The transfer patch must leave the global fetch exactly as it was.
    expect(globalThis.fetch).toBe(originalGlobalFetch);
  });

  it('a byte-cap destroy destroys the shared output AND releases the upstream request', async () => {
    const { ciphertext } = await makeFixture();
    let requestCancelled = false;
    let stubCalls = 0;
    const stubFetch: BaileysMediaTransferFetch = async (_input, init) => {
      stubCalls += 1;
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => {
        requestCancelled = true;
      }, { once: true });
      // The ciphertext is 96 bytes: a 48-byte cap must trip MID-stream.
      return new Response(streamOf([ciphertext.subarray(0, 48), ciphertext.subarray(48)]), {
        status: 200,
      });
    };
    const c = makeConnector(stubFetch);
    const budget = createMessageFetchBudget();
    try {
      const result = await fetchImage(budget, {
        candidateIndex: 0,
        maxBytes: 48,
        open: openMediaOf(c, realMediaMsg()),
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('size_limit');
      }
      expect(stubCalls).toBe(1);
      // The transport destroys the output on cap overflow; the transfer's
      // 'close' handler must reach the live upstream request.
      await new Promise((resolve) => setImmediate(resolve));
      expect(requestCancelled).toBe(true);
    } finally {
      budget.dispose();
    }
    expect(globalThis.fetch).toBe(originalGlobalFetch);
  });
});

// ---------------------------------------------------------------------------
// Deadline cancellation reaches the ACTUAL upstream request
// ---------------------------------------------------------------------------

describe('real downloadMediaMessage — deadline aborts the upstream request', () => {
  it('budget expiry aborts the live request and settles download_failed', async () => {
    vi.useFakeTimers();
    let requestCancelled = false;
    let resolveReachedFetch!: () => void;
    const reachedFetch = new Promise<void>((resolve) => {
      resolveReachedFetch = resolve;
    });
    const stubFetch: BaileysMediaTransferFetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          // The body never ends on its own — only the deadline may end it.
        },
      });
      signal?.addEventListener(
        'abort',
        () => {
          requestCancelled = true;
          // Emulate undici: an aborted in-flight body rejects the read.
          bodyController?.error(new Error('AbortError'));
        },
        { once: true },
      );
      resolveReachedFetch();
      return new Response(body, { status: 200 });
    };
    const c = makeConnector(stubFetch);
    const budget = createMessageFetchBudget();
    const pending = fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 1_000_000,
      open: openMediaOf(c, realMediaMsg()),
    });
    // Gate on the request actually being live before expiring the clock —
    // otherwise the test could pass without ever cancelling a request.
    await reachedFetch;
    await settleAfterDeadline(budget);
    const result = await pending;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
    }
    // The ACTUAL fetch-level signal aborted — no orphaned active request.
    expect(requestCancelled).toBe(true);
    budget.dispose();
    vi.useRealTimers();
  });

  it('an already-expired budget issues NO request at all', async () => {
    vi.useFakeTimers();
    let stubCalls = 0;
    const stubFetch: BaileysMediaTransferFetch = async () => {
      stubCalls += 1;
      return new Response(streamOf([new Uint8Array(16)]), { status: 200 });
    };
    const c = makeConnector(stubFetch);
    const budget = createMessageFetchBudget();
    await settleAfterDeadline(budget);
    const result = await fetchImage(budget, {
      candidateIndex: 0,
      maxBytes: 1_000_000,
      open: openMediaOf(c, realMediaMsg()),
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('download_failed');
    }
    expect(stubCalls).toBe(0);
    budget.dispose();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Mid-body upstream failure containment
// ---------------------------------------------------------------------------

describe('real downloadMediaMessage — mid-body failure containment', () => {
  it('body failure after headers settles download_failed with zero unhandled errors and releases upstream', async () => {
    const { ciphertext } = await makeFixture();
    let requestCancelled = false;
    const stubFetch: BaileysMediaTransferFetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => {
        requestCancelled = true;
      }, { once: true });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(ciphertext.subarray(0, 48));
          // Mid-body reset carrying a signed-URL-shaped message that must
          // NEVER reach any durable outcome.
          setTimeout(() => {
            controller.error(
              new Error('ECONNRESET simulated https://mmg.whatsapp.net/fake?sig=TOP-SECRET'),
            );
          }, 20);
        },
      });
      return new Response(body, { status: 200 });
    };
    const c = makeConnector(stubFetch);
    const budget = createMessageFetchBudget();
    try {
      const result = await fetchImage(budget, {
        candidateIndex: 0,
        maxBytes: 1_000_000,
        open: openMediaOf(c, realMediaMsg()),
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('download_failed');
        // Fixed-text outcome: no upstream message echo, no signed URL.
        expect(result.error.message).toBe('media stream failed');
        expect(result.error.message).not.toContain('TOP-SECRET');
        expect(result.error.message).not.toContain('ECONNRESET');
      }
      // The destroy chain must reach the live upstream request.
      await new Promise((resolve) => setImmediate(resolve));
      expect(requestCancelled).toBe(true);
    } finally {
      budget.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Reupload branch pin (rc.9: unreachable — Boom has no .status)
// ---------------------------------------------------------------------------

describe('real downloadMediaMessage — reupload ctx wiring', () => {
  it('404 settles download_failed with ONE fetch: the rc.9 retry branch is unreachable (Boom has no .status)', async () => {
    const reuploadSpy = vi.fn(async () => realMediaMsg());
    let stubCalls = 0;
    const stubFetch: BaileysMediaTransferFetch = async () => {
      stubCalls += 1;
      return new Response(null, { status: 404, statusText: 'Gone' });
    };
    const c = makeConnector(stubFetch);
    // The real rc.9 socket member is `updateMediaMessage`; the guarded ctx
    // wiring offers it — yet the retry must NOT fire in this pinned version
    // because `downloadMediaMessage` matches `error.status` (never set by
    // @hapi/boom; only `output.statusCode`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).sock = { updateMediaMessage: reuploadSpy };
    const budget = createMessageFetchBudget();
    try {
      const result = await fetchImage(budget, {
        candidateIndex: 0,
        maxBytes: 1_000_000,
        open: openMediaOf(c, realMediaMsg()),
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('download_failed');
      }
      expect(stubCalls).toBe(1);
      expect(reuploadSpy).not.toHaveBeenCalled();
    } finally {
      budget.dispose();
    }
    expect(globalThis.fetch).toBe(originalGlobalFetch);
  });
});


// ---------------------------------------------------------------------------
// Patch lifecycle: any reference handed out as globalThis.fetch must stay
// invocable forever, inside or outside a transfer scope.
// ---------------------------------------------------------------------------

type HangStubCall = (signal: AbortSignal | undefined, retained: BaileysMediaTransferFetch) => void;

/** A 200 response whose body never ends — only an abort may end it. */
function hangBodyResponse(signal: AbortSignal | undefined): Response {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
    },
  });
  signal?.addEventListener(
    'abort',
    () => {
      // Emulate undici: an aborted in-flight body rejects the read.
      bodyController?.error(new Error('AbortError'));
    },
    { once: true },
  );
  return new Response(body, { status: 200 });
}

/** A stub fetch whose body never ends — only an abort may end it. */
function makeHangStub(onCall: HangStubCall): BaileysMediaTransferFetch {
  return async (_input, init) => {
    const signal = init?.signal as AbortSignal | undefined;
    // While this runs the patch is installed, so globalThis.fetch IS the
    // current generation's wrapper — capture it for the retained-reference
    // assertions.
    onCall(signal, globalThis.fetch as BaileysMediaTransferFetch);
    return hangBodyResponse(signal);
  };
}

/** One full transfer generation against `wire`: open, capture the wrapper,
 *  let the shared deadline settle the hanging body, expect download_failed. */
async function runGeneration(
  wire: BaileysMediaTransferFetch,
  onRetained: (retained: BaileysMediaTransferFetch) => void,
): Promise<void> {
  globalThis.fetch = wire;
  let resolveEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const stubFetch = makeHangStub((_signal, retained) => {
    onRetained(retained);
    resolveEntered();
  });
  vi.useFakeTimers();
  const c = makeConnector(stubFetch);
  const budget = createMessageFetchBudget();
  const pending = fetchImage(budget, {
    candidateIndex: 0,
    maxBytes: 1_000_000,
    open: openMediaOf(c, realMediaMsg()),
  });
  await entered;
  await settleAfterDeadline(budget);
  const result = await pending;
  vi.useRealTimers();
  budget.dispose();
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.code).toBe('download_failed');
  }
}

describe('patch lifecycle — retained references and overlap', () => {
  it('a fetch reference retained during a transfer stays invocable after all transfers exit', async () => {
    const wireCalls: string[] = [];
    const wireFetch: BaileysMediaTransferFetch = async (input) => {
      wireCalls.push(String(input));
      return new Response(streamOf([new Uint8Array(16)]), { status: 200 });
    };
    const realGlobal = globalThis.fetch;
    // Install-time original: the patch must capture THIS, so any retained
    // wrapper reference forwards here forever.
    globalThis.fetch = wireFetch;
    try {
      let retained: BaileysMediaTransferFetch | undefined;
      await runGeneration(wireFetch, (retainedRef) => {
        retained = retainedRef;
      });
      expect(retained).toBeTypeOf('function');
      // The patch is fully torn down: global restored...
      expect(globalThis.fetch).toBe(wireFetch);
      // ...but the retained reference (the wrapper) must still perform the
      // unrelated request via the install-time original — never throw.
      const resp = await (retained as BaileysMediaTransferFetch)('https://wire.example/unrelated');
      expect(wireCalls).toEqual(['https://wire.example/unrelated']);
      expect(resp.status).toBe(200);
    } finally {
      globalThis.fetch = realGlobal;
    }
  });

  it('overlapping patch windows: A held open while B enters, per-transfer signals, staggered cancellation, restoration only after the LAST exit', async () => {
    const wireACalls: string[] = [];
    const wireA: BaileysMediaTransferFetch = async (input) => {
      wireACalls.push(String(input));
      return new Response(streamOf([new Uint8Array(16)]), { status: 200 });
    };
    const realGlobal = globalThis.fetch;
    globalThis.fetch = wireA;
    try {
      vi.useFakeTimers();
      // A's OPENING stays pending until the test releases it — that is what
      // keeps A's patch window installed while B enters its own (genuine
      // depth 2; an immediately-resolving opening would let A's window
      // close before B starts).
      let resolveEnteredA!: () => void;
      const enteredA = new Promise<void>((resolve) => {
        resolveEnteredA = resolve;
      });
      let releaseHoldA!: () => void;
      const holdA = new Promise<void>((resolve) => {
        releaseHoldA = resolve;
      });
      let aSignal: AbortSignal | undefined;
      const stubA: BaileysMediaTransferFetch = async (_input, init) => {
        aSignal = init?.signal as AbortSignal | undefined;
        resolveEnteredA();
        await holdA; // opening pending: the patch window stays installed
        return hangBodyResponse(aSignal);
      };
      let resolveEnteredB!: () => void;
      const enteredB = new Promise<void>((resolve) => {
        resolveEnteredB = resolve;
      });
      let bSignal: AbortSignal | undefined;
      const stubB = makeHangStub((signal) => {
        bSignal = signal;
        resolveEnteredB();
      });

      const connectorA = makeConnector(stubA);
      const connectorB = makeConnector(stubB);

      const budgetA = createMessageFetchBudget(); // deadline at t=60000
      const pendingA = fetchImage(budgetA, {
        candidateIndex: 0,
        maxBytes: 1_000_000,
        open: openMediaOf(connectorA, realMediaMsg()),
      });
      await enteredA;
      const wrapperWhileAOpen = globalThis.fetch; // the installed wrapper
      expect(wrapperWhileAOpen).not.toBe(wireA);

      await vi.advanceTimersByTimeAsync(1_000);
      const budgetB = createMessageFetchBudget(); // deadline at t=61000
      const pendingB = fetchImage(budgetB, {
        candidateIndex: 0,
        maxBytes: 1_000_000,
        open: openMediaOf(connectorB, realMediaMsg()),
      });
      await enteredB;

      // GENUINE overlap: A's opening is still pending, so B's request ran
      // through the SAME install generation's wrapper (depth 2).
      expect(globalThis.fetch).toBe(wrapperWhileAOpen);
      const retainedOverlap = globalThis.fetch as BaileysMediaTransferFetch;

      // Both in flight: each request got its OWN transfer signal.
      expect(aSignal).toBeInstanceOf(AbortSignal);
      expect(bSignal).toBeInstanceOf(AbortSignal);
      expect(aSignal).not.toBe(bSignal);
      expect(aSignal!.aborted).toBe(false);
      expect(bSignal!.aborted).toBe(false);

      releaseHoldA(); // A's opening completes — the window depth falls to 1
      // A's deadline (t=60000) fires; B's (t=61000) must NOT.
      await vi.advanceTimersByTimeAsync(59_001);
      const resultA = await pendingA;
      expect(resultA.isErr()).toBe(true);
      if (resultA.isErr()) {
        expect(resultA.error.code).toBe('download_failed');
      }
      expect(aSignal!.aborted).toBe(true);
      expect(bSignal!.aborted).toBe(false); // no cross-signal mixing

      // B cancels after A — still correctly, even though A's run window
      // exited long before B's deadline.
      await vi.advanceTimersByTimeAsync(1_000);
      const resultB = await pendingB;
      vi.useRealTimers();
      expect(resultB.isErr()).toBe(true);
      if (resultB.isErr()) {
        expect(resultB.error.code).toBe('download_failed');
      }
      expect(bSignal!.aborted).toBe(true);

      // Restoration is verified ONLY after the LAST exit...
      expect(globalThis.fetch).toBe(wireA);
      // ...and the reference captured during the genuine overlap window
      // still performs unrelated requests via the window's original.
      const resp = await retainedOverlap('https://wireA.example/late-overlap');
      expect(wireACalls).toEqual(['https://wireA.example/late-overlap']);
      expect(resp.status).toBe(200);
    } finally {
      globalThis.fetch = realGlobal;
    }
  });

  it('a reference retained from an earlier install forwards to THAT install\'s original after a later install with a different original', async () => {
    const wireACalls: string[] = [];
    const wireBCalls: string[] = [];
    const wireA: BaileysMediaTransferFetch = async (input) => {
      wireACalls.push(String(input));
      return new Response(streamOf([new Uint8Array(16)]), { status: 200 });
    };
    const wireB: BaileysMediaTransferFetch = async (input) => {
      wireBCalls.push(String(input));
      return new Response(streamOf([new Uint8Array(16)]), { status: 200 });
    };
    const realGlobal = globalThis.fetch;
    try {
      // Install generation A.
      let retainedA: BaileysMediaTransferFetch | undefined;
      await runGeneration(wireA, (retained) => {
        retainedA = retained;
      });
      expect(globalThis.fetch).toBe(wireA);
      // Install generation B with a DIFFERENT original.
      await runGeneration(wireB, () => undefined);
      expect(globalThis.fetch).toBe(wireB);
      // The reference retained from generation A must still forward to
      // A's original — not B's (no shared capture), and without recursion.
      const resp = await (retainedA as BaileysMediaTransferFetch)('https://wireA.example/gen-a');
      expect(wireACalls).toEqual(['https://wireA.example/gen-a']);
      expect(wireBCalls).toEqual([]);
      expect(resp.status).toBe(200);
    } finally {
      globalThis.fetch = realGlobal;
    }
  });
});
