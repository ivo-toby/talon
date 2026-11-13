/**
 * Unit tests for Telegram photo/document ingestion (TASK-006).
 *
 * All Telegram Bot API calls are intercepted via vi.stubGlobal('fetch', ...).
 * Wire shapes are frozen to inventory E1/E2:
 *
 * - getFile request: GET https://api.telegram.org/bot<token>/getFile?file_id=<id>
 * - getFile response: { ok: true, result: { file_id, file_unique_id,
 *   file_size?, file_path } } (general Bot API ok/result envelope)
 * - bytes: GET https://api.telegram.org/file/bot<token>/<file_path>
 *   returning RAW BYTES (not JSON).
 *
 * Covers: caption/caption_entities feeding the existing mention and trigger
 * rules; authorization BEFORE any separate media request (denials make zero
 * requests); largest-pixel-area rendition selection within BOTH the
 * configured byte limit and the 20 MB getFile cap; unknown-size renditions
 * with bounded actual-byte checks and smaller-rendition fallback inside the
 * same message deadline; one photo message = one candidate (albums stay
 * separate); sticker exclusion; document eligibility by declared MIME only
 * (static WebP eligible, HEIC consumes its slot as unsupported_mime, missing
 * MIME excluded); all-oversized → size_limit; fetch failure/deadline →
 * download_failed; token/URL/pixel sanitization of results and logs; stable
 * idempotency keys.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { TelegramConnector } from '../../../../../src/channels/connectors/telegram/telegram-connector.js';
import {
  DEFAULT_TELEGRAM_IMAGE_SETTINGS,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  fetchTelegramMedia,
  photoPayloadMimeType,
  planHasImageSlots,
  planTelegramMedia,
  type OpenedTelegramFile,
} from '../../../../../src/channels/connectors/telegram/telegram-media.js';
import type {
  TelegramConfig,
  TelegramMessage,
  TelegramPhotoSize,
} from '../../../../../src/channels/connectors/telegram/telegram-types.js';
import type {
  Attachment,
  InboundAttachment,
  InboundAttachmentRejection,
  InboundEvent,
} from '../../../../../src/channels/channel-types.js';
import type { MessageFetchBudget } from '../../../../../src/images/image-transport.js';

// ---------------------------------------------------------------------------
// Fixture constants (frozen E2 shapes)
// ---------------------------------------------------------------------------

const BOT_TOKEN = '12345:TESTBOT-super-secret-token';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FILE_BASE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function captureLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _encoding: string, callback: () => void): void {
      lines.push(String(chunk));
      callback();
    },
  });
  return { logger: pino({ level: 'debug' }, stream), lines };
}

function defaultConfig(overrides?: Partial<TelegramConfig>): TelegramConfig {
  return { botToken: BOT_TOKEN, pollingTimeoutSec: 1, ...overrides };
}

/** Deterministic byte payload with an embedded ASCII marker. */
function bytesOf(size: number, marker = 'PIXELMARKER'): Uint8Array {
  const bytes = new Uint8Array(size);
  const label = new TextEncoder().encode(marker);
  bytes.set(label.subarray(0, Math.min(label.length, size)), 0);
  for (let i = label.length; i < size; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  const chunkSize = 64 * 1024;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

interface FakeFile {
  /** Actual served bytes (default: 1 KiB). */
  bytes?: Uint8Array;
  /** Server-assigned file_path in the getFile envelope. */
  filePath?: string;
  /** When false the getFile envelope returns ok=false (token-bearing description). */
  lookupOk?: boolean;
  /** HTTP status of the byte download (default 200). */
  downloadStatus?: number;
}

interface MediaFetchOptions {
  files?: Record<string, FakeFile>;
  /** getMe result for connectors that start(); username drives @mention matching. */
  botUsername?: string;
  /** Queued getUpdates batches (poll-loop tests). */
  updateBatches?: object[][];
}

interface InstalledFetch {
  calls: string[];
  initFor: (urlFragment: string) => RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Install the fake Bot API. Unexpected URLs reject loudly. getFile failures
 * return a description embedding the FULL token URL so leak assertions have
 * something to catch.
 */
function installMediaFetch(options: MediaFetchOptions = {}): InstalledFetch {
  const calls: string[] = [];
  const inits = new Map<string, RequestInit | undefined>();
  const batches = [...(options.updateBatches ?? [])];

  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    inits.set(url, init);

    if (url.startsWith(`${API_BASE}/getMe`)) {
      return jsonResponse({
        ok: true,
        result: {
          id: 555,
          is_bot: true,
          first_name: 'TestBot',
          username: options.botUsername ?? 'test_bot',
        },
      });
    }

    if (url.startsWith(`${API_BASE}/getUpdates`)) {
      const batch = batches.shift();
      if (batch !== undefined) {
        return jsonResponse({ ok: true, result: batch });
      }
      // No more batches: hang until the poll loop aborts on stop().
      return await new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
        if (init?.signal?.aborted === true) {
          abort();
          return;
        }
        init?.signal?.addEventListener('abort', abort);
      });
    }

    if (url.startsWith(`${API_BASE}/getFile`)) {
      const fileId = new URL(url).searchParams.get('file_id') ?? '';
      const file = options.files?.[fileId];
      if (file === undefined || file.lookupOk === false) {
        return jsonResponse({
          ok: false,
          error_code: 400,
          // Token-bearing server description: must never leak downstream.
          description: `Bad Request: file id ${fileId} invalid. Retry ${API_BASE}/getFile?file_id=${fileId} then ${FILE_BASE}/photos/x.jpg`,
        });
      }
      return jsonResponse({
        ok: true,
        result: {
          file_id: fileId,
          file_unique_id: `uniq_${fileId}`,
          file_path: file.filePath ?? `photos/${fileId}.jpg`,
        },
      });
    }

    if (url.startsWith(`${FILE_BASE}/`)) {
      const path = url.slice(FILE_BASE.length + 1);
      const entry = Object.entries(options.files ?? {}).find(
        ([id, candidate]) => (candidate.filePath ?? `photos/${id}.jpg`) === path,
      );
      const file = entry?.[1];
      if (file === undefined) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      const status = file.downloadStatus ?? 200;
      if (status !== 200) {
        return jsonResponse({ error: 'forbidden' }, status);
      }
      return {
        ok: true,
        status: 200,
        body: byteStream(file.bytes ?? bytesOf(1024)),
      } as unknown as Response;
    }

    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    initFor: (urlFragment: string) => {
      const call = calls.find((url) => url.includes(urlFragment));
      return call !== undefined ? inits.get(call) : undefined;
    },
  };
}

function photoSize(
  fileId: string,
  width: number,
  height: number,
  fileSize?: number,
): TelegramPhotoSize {
  return {
    file_id: fileId,
    file_unique_id: `uniq_${fileId}`,
    width,
    height,
    ...(fileSize !== undefined ? { file_size: fileSize } : {}),
  };
}

function makeMessage(overrides: Record<string, unknown>): TelegramMessage {
  return {
    message_id: 1000,
    from: { id: 999, first_name: 'Test', username: 'testuser' },
    chat: { id: 555, type: 'private' },
    date: 1_700_000_000,
    ...overrides,
  };
}

function makeUpdate(updateId: number, message: object): object {
  return { update_id: updateId, message };
}

function makeConnector(
  config?: Partial<TelegramConfig>,
  options?: ConstructorParameters<typeof TelegramConnector>[3],
  logger?: pino.Logger,
): TelegramConnector {
  return new TelegramConnector(defaultConfig(config), 'img-bot', logger ?? silentLogger(), options);
}

async function collect(connector: TelegramConnector): Promise<InboundEvent[]> {
  const received: InboundEvent[] = [];
  connector.onMessage(async (event) => {
    received.push(event);
  });
  return received;
}

function expectPayload(attachment: InboundAttachment | undefined): Attachment {
  if (attachment === undefined || 'kind' in attachment) {
    throw new Error(`expected payload Attachment, got ${JSON.stringify(attachment)}`);
  }
  return attachment;
}

function expectRejection(attachment: InboundAttachment | undefined): InboundAttachmentRejection {
  if (attachment === undefined || !('kind' in attachment)) {
    throw new Error(`expected rejection Attachment, got ${JSON.stringify(attachment)}`);
  }
  return attachment;
}

// ---------------------------------------------------------------------------

describe('telegram image ingestion', () => {
  let connector: TelegramConnector | undefined;

  afterEach(async () => {
    await connector?.stop();
    connector = undefined;
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Photo happy path — E2 wire contract
  // -------------------------------------------------------------------------

  describe('photo messages (E1/E2 contract)', () => {
    it('delivers ONE photo candidate with the caption through the pinned getFile/download flow', async () => {
      const fetchCalls = installMediaFetch({
        files: {
          f_small: { filePath: 'photos/file_9.jpg', bytes: bytesOf(512) },
          f_large: { filePath: 'photos/file_10.jpg', bytes: bytesOf(4096, 'LARGEPIXELMARKER') },
        },
      });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          42,
          makeMessage({
            caption: 'what is this?',
            photo: [photoSize('f_small', 100, 100, 512), photoSize('f_large', 800, 600, 4096)],
          }),
        ),
      );

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.content).toBe('what is this?'); // retained textual caption
      expect(event.idempotencyKey).toBe('42');
      expect(event.attachments).toHaveLength(1);

      const payload = expectPayload(event.attachments?.[0]);
      expect(payload.size).toBe(4096);
      expect(payload.data).toBeInstanceOf(Buffer);
      expect((payload.data as Buffer).subarray(0, 'LARGEPIXELMARKER'.length).toString()).toBe(
        'LARGEPIXELMARKER',
      );
      expect(payload.mimeType).toBe('image/jpeg');
      expect(payload.filename).toBe('file_10.jpg');

      // Frozen E2 request shapes: GET getFile?file_id=..., then raw-bytes GET.
      expect(fetchCalls.calls).toEqual([
        `${API_BASE}/getFile?file_id=f_large`,
        `${FILE_BASE}/photos/file_10.jpg`,
      ]);
      // GET: no method override, no JSON body on either request.
      expect(fetchCalls.initFor('/getFile')?.body).toBeUndefined();
      expect(fetchCalls.initFor('/getFile')?.method).toBeUndefined();
      expect(fetchCalls.initFor('/photos/file_10.jpg')?.body).toBeUndefined();
    });

    it('delivers media-only photo messages (no caption) with empty content', async () => {
      installMediaFetch({ files: { f_a: { bytes: bytesOf(2048) } } });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(43, makeMessage({ photo: [photoSize('f_a', 640, 480)] })),
      );

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('');
      expect(expectPayload(received[0].attachments?.[0]).size).toBe(2048);
    });

    it('maps the server file_path extension to the payload MIME', async () => {
      installMediaFetch({
        files: { f_png: { filePath: 'photos/file_3.png', bytes: bytesOf(900) } },
      });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(44, makeMessage({ photo: [photoSize('f_png', 300, 200, 900)] })),
      );

      expect(expectPayload(received[0].attachments?.[0]).mimeType).toBe('image/png');
    });

    it('produces exactly ONE candidate for a three-rendition photo (renditions are not separate Images)', async () => {
      installMediaFetch({
        files: {
          r1: { bytes: bytesOf(300) },
          r2: { bytes: bytesOf(900) },
          r3: { bytes: bytesOf(2000) },
        },
      });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          45,
          makeMessage({
            photo: [
              photoSize('r1', 90, 90, 300),
              photoSize('r2', 450, 450, 900),
              photoSize('r3', 900, 900, 2000),
            ],
          }),
        ),
      );

      expect(received[0].attachments).toHaveLength(1);
      // Only the chosen rendition is looked up and downloaded — once.
      expect(received[0].attachments).toHaveLength(1);
    });

    it('keeps album members as separate events with stable idempotency keys (no aggregation)', async () => {
      installMediaFetch({
        files: {
          album_1: { filePath: 'photos/a1.jpg', bytes: bytesOf(1200) },
          album_2: { filePath: 'photos/a2.jpg', bytes: bytesOf(1300) },
        },
      });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(700, makeMessage({ photo: [photoSize('album_1', 400, 400, 1200)] })),
      );
      await connector.handleUpdatePublic(
        makeUpdate(701, makeMessage({ photo: [photoSize('album_2', 400, 400, 1300)] })),
      );

      expect(received).toHaveLength(2);
      expect(received.map((e) => e.idempotencyKey)).toEqual(['700', '701']);
      expect(received.map((e) => expectPayload(e.attachments?.[0]).size)).toEqual([1200, 1300]);
      // Re-processing the same update id yields the same key (dedup contract).
      await connector.handleUpdatePublic(
        makeUpdate(700, makeMessage({ photo: [photoSize('album_1', 400, 400, 1200)] })),
      );
      expect(received[2]?.idempotencyKey).toBe('700');
    });
  });

  // -------------------------------------------------------------------------
  // Rendition selection: configured bytes AND the 20 MB getFile cap
  // -------------------------------------------------------------------------

  describe('rendition selection and size limits', () => {
    it('chooses the largest pixel area that fits the configured bytes (selection precedes download)', async () => {
      const fetchCalls = installMediaFetch({
        files: {
          big_area_over: { bytes: bytesOf(5 * MIB) },
          mid: { bytes: bytesOf(500_000) },
          small: { bytes: bytesOf(10_000) },
        },
      });
      connector = makeConnector(undefined, { imageSettings: { maxInputBytes: 1_000_000 } });
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          50,
          makeMessage({
            photo: [
              photoSize('big_area_over', 2000, 2000, 5 * MIB), // declared over 1 MB cap
              photoSize('mid', 800, 600, 500_000), // largest that fits
              photoSize('small', 100, 100, 10_000),
            ],
          }),
        ),
      );

      // Only the chosen rendition is requested — the oversized rendition was
      // never downloaded and the smaller one was not needed.
      expect(fetchCalls.calls).toEqual([
        `${API_BASE}/getFile?file_id=mid`,
        `${FILE_BASE}/photos/mid.jpg`,
      ]);
      expect(expectPayload(received[0].attachments?.[0]).size).toBe(500_000);
    });

    it('applies the 20 MB getFile cap even when the configured limit is higher', async () => {
      const fetchCalls = installMediaFetch({
        files: {
          over_bot_cap: { bytes: bytesOf(1000) },
          under_bot_cap: { bytes: bytesOf(3000) },
        },
      });
      connector = makeConnector(undefined, { imageSettings: { maxInputBytes: 50 * MIB } });
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          51,
          makeMessage({
            photo: [
              photoSize('over_bot_cap', 4000, 4000, 25 * MIB), // fits config, exceeds Telegram cap
              photoSize('under_bot_cap', 800, 600, 10 * MIB),
            ],
          }),
        ),
      );

      expect(TELEGRAM_MAX_DOWNLOAD_BYTES).toBe(20 * MIB);
      expect(fetchCalls.calls).toEqual([
        `${API_BASE}/getFile?file_id=under_bot_cap`,
        `${FILE_BASE}/photos/under_bot_cap.jpg`,
      ]);
      expect(expectPayload(received[0].attachments?.[0]).size).toBe(3000);
    });

    it('falls back to the next smaller rendition on ACTUAL-byte overflow of an unknown-size rendition', async () => {
      const fetchCalls = installMediaFetch({
        files: {
          unknown_big: { bytes: bytesOf(200_000) }, // no declared size; actually 200 KB
          smaller: { bytes: bytesOf(9000) },
        },
      });
      connector = makeConnector(undefined, { imageSettings: { maxInputBytes: 100_000 } });
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          52,
          makeMessage({
            photo: [
              photoSize('unknown_big', 1000, 1000), // unknown size, tried first (largest area)
              photoSize('smaller', 300, 300, 9000), // fits; fallback within the same deadline
            ],
          }),
        ),
      );

      // Bounded actual-byte check cut the first download off, then fallback.
      expect(fetchCalls.calls).toEqual([
        `${API_BASE}/getFile?file_id=unknown_big`,
        `${FILE_BASE}/photos/unknown_big.jpg`,
        `${API_BASE}/getFile?file_id=smaller`,
        `${FILE_BASE}/photos/smaller.jpg`,
      ]);
      expect(expectPayload(received[0].attachments?.[0]).size).toBe(9000);
    });

    it('returns size_limit when ALL renditions are confirmed oversized — with zero requests', async () => {
      const fetchCalls = installMediaFetch({ files: {} });
      connector = makeConnector(undefined, { imageSettings: { maxInputBytes: 50 * MIB } });
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          53,
          makeMessage({
            photo: [
              photoSize('o1', 3000, 3000, 30 * MIB), // declared over the 20 MB Bot API cap
              photoSize('o2', 1000, 1000, 25 * MIB),
            ],
          }),
        ),
      );

      expect(received).toHaveLength(1);
      const rejection = expectRejection(received[0].attachments?.[0]);
      expect(rejection.rejectionReason).toBe('size_limit');
      expect(rejection.sourcePosition).toBe(0);
      expect(fetchCalls.calls).toEqual([]); // confirmed oversized: no request at all
    });

    it('returns size_limit when declared sizes exceed the configured input limit — zero requests', async () => {
      const fetchCalls = installMediaFetch({ files: {} });
      connector = makeConnector(); // default 10 MiB input limit
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          54,
          makeMessage({
            photo: [photoSize('o1', 2000, 2000, 11 * MIB), photoSize('o2', 900, 900, 12 * MIB)],
          }),
        ),
      );

      expect(expectRejection(received[0].attachments?.[0]).rejectionReason).toBe('size_limit');
      expect(fetchCalls.calls).toEqual([]);
    });

    it('returns size_limit when every actual-byte attempt overflows (fallback exhausted)', async () => {
      const fetchCalls = installMediaFetch({
        files: {
          a1: { bytes: bytesOf(100_000) }, // declared 45 KB, actually 100 KB
          a2: { bytes: bytesOf(80_000) }, // declared 40 KB, actually 80 KB
        },
      });
      connector = makeConnector(undefined, { imageSettings: { maxInputBytes: 50_000 } });
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          55,
          makeMessage({
            photo: [photoSize('a1', 900, 900, 45_000), photoSize('a2', 500, 500, 40_000)],
          }),
        ),
      );

      expect(fetchCalls.calls).toHaveLength(4); // both renditions tried (getFile+bytes)
      expect(expectRejection(received[0].attachments?.[0]).rejectionReason).toBe('size_limit');
    });

    it('returns download_failed on getFile ok=false with NO retry, and never leaks the token-bearing description', async () => {
      const fetchCalls = installMediaFetch({ files: { broken: { lookupOk: false } } });
      const { logger, lines } = captureLogger();
      connector = makeConnector(undefined, undefined, logger);
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(56, makeMessage({ photo: [photoSize('broken', 500, 500, 5000)] })),
      );

      expect(received).toHaveLength(1);
      const rejection = expectRejection(received[0].attachments?.[0]);
      expect(rejection.rejectionReason).toBe('download_failed');
      // Exactly one getFile, no download, no retry across attempts.
      expect(fetchCalls.calls).toEqual([`${API_BASE}/getFile?file_id=broken`]);
      const serialized = JSON.stringify(rejection);
      expect(serialized).not.toContain(BOT_TOKEN);
      expect(serialized).not.toContain('api.telegram.org');
      expect(Object.keys(rejection).sort()).toEqual([
        'kind',
        'rejectionReason',
        'size',
        'sourcePosition',
      ]);
      expect(lines.join('')).not.toContain(BOT_TOKEN);
    });

    it('returns download_failed when the byte download responds with an HTTP error', async () => {
      installMediaFetch({ files: { denied: { downloadStatus: 403, bytes: bytesOf(10) } } });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(57, makeMessage({ photo: [photoSize('denied', 400, 400, 10)] })),
      );

      expect(expectRejection(received[0].attachments?.[0]).rejectionReason).toBe('download_failed');
    });

    it('NEVER opens the smaller rendition after an operational failure of the largest one', async () => {
      // E1: the rendition fallback is OVERFLOW-ONLY. With a two-rendition
      // media group where the largest rendition fails operationally (getFile
      // cannot resolve the file), the smaller rendition must NOT be tried as
      // a retry — zero requests for it, outcome is download_failed.
      const fetchCalls = installMediaFetch({
        files: {
          big_fail: { lookupOk: false },
          small_ok: { bytes: bytesOf(700) },
        },
      });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          101,
          makeMessage({
            photo: [photoSize('big_fail', 1200, 1200, 5000), photoSize('small_ok', 200, 200, 700)],
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(expectRejection(received[0].attachments?.[0]).rejectionReason).toBe('download_failed');
      // Only the largest rendition touched the wire; the smaller one is not a retry.
      expect(fetchCalls.calls).toEqual([`${API_BASE}/getFile?file_id=big_fail`]);
      expect(fetchCalls.calls.some((url) => url.includes('small_ok'))).toBe(false);
    });

    it('maps an exhausted message fetch budget to download_failed without opening new files', async () => {
      // Direct port-level check of the deadline arm: an expired budget must
      // short-circuit to download_failed with zero opens.
      const message = makeMessage({ photo: [photoSize('p1', 500, 500, 1000)] });
      const plan = planTelegramMedia(message, DEFAULT_TELEGRAM_IMAGE_SETTINGS);
      const openFile = vi.fn();
      const expiredBudget = (): MessageFetchBudget => {
        const controller = new AbortController();
        controller.abort();
        return {
          deadlineAt: Date.now(),
          signal: controller.signal,
          remainingMs: () => 0,
          expired: () => true,
          dispose: (): void => undefined,
        };
      };

      const attachments = await fetchTelegramMedia(plan, {
        openFile,
        createFetchBudget: expiredBudget,
      });

      expect(expectRejection(attachments[0]).rejectionReason).toBe('download_failed');
      expect(openFile).not.toHaveBeenCalled();
    });

    it('gives the fallback rendition only the REMAINING original deadline — never a fresh budget', async () => {
      // Controlled (short) fake clock modelling createMessageFetchBudget:
      // ONE budget object with a FIXED deadline shared by all attempts.
      // The largest rendition overflows the byte cap quickly (t0..t1, still
      // inside the window), so the fallback IS attempted — but it must be
      // aborted at the ORIGINAL deadline, not allowed to run on a reset
      // per-fetch budget.
      const DEADLINE_MS = 250;
      const LATE_MS = 2_000;
      const message = makeMessage({
        photo: [photoSize('slow_big', 1000, 1000), photoSize('slow_small', 300, 300)],
      });
      const plan = planTelegramMedia(message, { maxInputBytes: 100_000, maxPerMessage: 5 });

      const startedAt = Date.now();
      const deadlineAt = startedAt + DEADLINE_MS;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('message media fetch budget exhausted')),
        DEADLINE_MS,
      );
      timer.unref();
      const sharedBudget: MessageFetchBudget = {
        deadlineAt,
        signal: controller.signal,
        remainingMs: (): number => Math.max(0, deadlineAt - Date.now()),
        expired: (): boolean => Date.now() >= deadlineAt || controller.signal.aborted,
        dispose: (): void => clearTimeout(timer),
      };

      const openedIds: string[] = [];
      let fallbackSignal: AbortSignal | undefined;
      let lateProduced = false;
      const openFile = vi.fn(
        async (fileId: string, signal: AbortSignal): Promise<OpenedTelegramFile> => {
          openedIds.push(fileId);
          if (fileId === 'slow_big') {
            // Actual bytes (200 KB) overflow the 100 KB cap: size_limit at t1.
            // (Cast: global ReadableStream vs node:stream/web declaration — the
            // same identical-runtime boundary cast as in the connector.)
            return {
              stream: byteStream(bytesOf(200_000)) as unknown as OpenedTelegramFile['stream'],
              filePath: 'photos/slow_big.jpg',
            };
          }
          fallbackSignal = signal;
          // Fallback source produces data only LONG after the original deadline.
          return {
            stream: new ReadableStream<Uint8Array>({
              start(streamController): void {
                const late = setTimeout(() => {
                  lateProduced = true;
                  try {
                    streamController.enqueue(bytesOf(10));
                    streamController.close();
                  } catch {
                    // Stream already aborted/cancelled — expected on the
                    // correct path; nothing may leak.
                  }
                }, LATE_MS);
                late.unref();
              },
            }) as unknown as OpenedTelegramFile['stream'],
            filePath: 'photos/slow_small.jpg',
          };
        },
      );

      const attachments = await fetchTelegramMedia(plan, {
        openFile,
        createFetchBudget: () => sharedBudget,
      });

      // The fallback WAS attempted (overflow fallback is allowed)…
      expect(openedIds).toEqual(['slow_big', 'slow_small']);
      // …but it ran on the SAME budget signal — zero per-fetch reset — and
      // was cut off at the original deadline: rejection, never a payload.
      expect(fallbackSignal).toBe(sharedBudget.signal);
      expect(expectRejection(attachments[0]).rejectionReason).toBe('download_failed');
      expect(lateProduced).toBe(false);
      expect(controller.signal.aborted).toBe(true);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 25);
      expect(elapsed).toBeLessThan(LATE_MS);
    });
  });

  // -------------------------------------------------------------------------
  // Stickers and documents — declared-MIME eligibility
  // -------------------------------------------------------------------------

  describe('stickers and documents', () => {
    it('excludes stickers silently — sticker-only messages never produce events or requests', async () => {
      const fetchCalls = installMediaFetch({ files: { sticker_file: { bytes: bytesOf(10) } } });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          60,
          makeMessage({
            sticker: {
              file_id: 'sticker_file',
              file_unique_id: 'u',
              width: 512,
              height: 512,
              is_animated: false,
              thumb: { file_id: 'sticker_file', file_unique_id: 'u', width: 100, height: 100 },
            },
          }),
        ),
      );

      expect(received).toHaveLength(0);
      expect(fetchCalls.calls).toEqual([]);

      // Plan-level contract: a sticker produces NO item and NO slot — the
      // exclusion is not merely an artifact of downstream MIME filtering.
      const plan = planTelegramMedia(
        makeMessage({
          sticker: {
            file_id: 'sticker_file',
            file_unique_id: 'u',
            width: 512,
            height: 512,
            is_animated: false,
            thumb: { file_id: 'sticker_file', file_unique_id: 'u', width: 100, height: 100 },
          },
        }),
        DEFAULT_TELEGRAM_IMAGE_SETTINGS,
      );
      expect(plan.items).toHaveLength(0);
      expect(planHasImageSlots(plan)).toBe(false);
    });

    it('excludes static-WebP stickers with captions but keeps the caption as a text message', async () => {
      const fetchCalls = installMediaFetch({ files: { webp_sticker: { bytes: bytesOf(10) } } });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          61,
          makeMessage({
            caption: 'lol',
            sticker: {
              file_id: 'webp_sticker',
              file_unique_id: 'u',
              width: 256,
              height: 256,
              is_animated: false,
            },
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('lol');
      expect(received[0].attachments).toBeUndefined();
      expect(fetchCalls.calls).toEqual([]);
    });

    it('treats static image/webP DOCUMENTS as eligible images (declared MIME, not origin)', async () => {
      const fetchCalls = installMediaFetch({
        files: { webp_doc: { filePath: 'documents/shot.webp', bytes: bytesOf(7000) } },
      });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          62,
          makeMessage({
            caption: 'screenshot',
            document: {
              file_id: 'webp_doc',
              file_unique_id: 'u',
              file_name: 'shot.webp',
              mime_type: 'image/webp',
              file_size: 7000,
            },
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('screenshot');
      const payload = expectPayload(received[0].attachments?.[0]);
      expect(payload.mimeType).toBe('image/webp');
      expect(payload.filename).toBe('shot.webp');
      expect(payload.size).toBe(7000);
      expect(fetchCalls.calls).toEqual([
        `${API_BASE}/getFile?file_id=webp_doc`,
        `${FILE_BASE}/documents/shot.webp`,
      ]);
    });

    it('normalizes MIME parameters and case for document eligibility', async () => {
      installMediaFetch({ files: { jpeg_doc: { bytes: bytesOf(1500) } } });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          63,
          makeMessage({
            document: {
              file_id: 'jpeg_doc',
              file_unique_id: 'u',
              file_name: 'IMG.JPG',
              mime_type: 'IMAGE/JPEG;charset=binary',
              file_size: 1500,
            },
          }),
        ),
      );

      const payload = expectPayload(received[0].attachments?.[0]);
      expect(payload.mimeType).toBe('image/jpeg');
      expect(payload.filename).toBe('IMG.JPG');
    });

    it('rejects unsupported image MIME (HEIC, SVG) as unsupported_mime consuming its slot — no download', async () => {
      for (const [fileId, mimeType] of [
        ['heic_doc', 'image/heic'],
        ['svg_doc', 'image/svg+xml'],
      ] as const) {
        const fetchCalls = installMediaFetch({ files: { [fileId]: { bytes: bytesOf(10) } } });
        connector = makeConnector();
        const received = await collect(connector);

        await connector.handleUpdatePublic(
          makeUpdate(
            64,
            makeMessage({
              caption: 'photo from my phone',
              document: {
                file_id: fileId,
                file_unique_id: 'u',
                mime_type: mimeType,
                file_size: 10,
              },
            }),
          ),
        );

        expect(received).toHaveLength(1);
        const rejection = expectRejection(received[0].attachments?.[0]);
        expect(rejection.rejectionReason).toBe('unsupported_mime');
        expect(rejection.sourcePosition).toBe(0); // consumes its slot
        expect(rejection.mimeType).toBe(
          mimeType === 'image/svg+xml' ? 'image/svg+xml' : 'image/heic',
        );
        expect(fetchCalls.calls).toEqual([]); // slot consumed without a request
        vi.unstubAllGlobals();
      }
    });

    it('excludes documents with absent or non-image MIME without attachments (caption still delivered)', async () => {
      const fetchCalls = installMediaFetch({ files: { pdf_doc: { bytes: bytesOf(10) } } });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          65,
          makeMessage({
            caption: 'quarterly report',
            document: {
              file_id: 'pdf_doc',
              file_unique_id: 'u',
              file_name: 'report.pdf',
              mime_type: 'application/pdf',
            },
          }),
        ),
      );
      await connector.handleUpdatePublic(
        makeUpdate(
          66,
          makeMessage({
            caption: 'looks like a photo name',
            // Filename says .jpg but the DECLARED MIME is octet-stream:
            // a filename never establishes MIME.
            document: {
              file_id: 'no_mime_doc',
              file_unique_id: 'u',
              file_name: 'photo.jpg',
              mime_type: 'application/octet-stream',
            },
          }),
        ),
      );

      expect(received).toHaveLength(2);
      expect(received[0].content).toBe('quarterly report');
      expect(received[0].attachments).toBeUndefined();
      expect(received[1].content).toBe('looks like a photo name');
      expect(received[1].attachments).toBeUndefined();
      expect(fetchCalls.calls).toEqual([]);
    });

    it('drops UNCAPTIONED excluded-document messages — zero events, zero requests', async () => {
      // P1 regression: excluded documents (absent or non-image declared MIME)
      // consume no slot and must NOT admit an otherwise-empty message into a
      // run with content '' and no attachments.
      const fetchCalls = installMediaFetch({
        files: { nolist_doc: { bytes: bytesOf(10) }, bin_doc: { bytes: bytesOf(10) } },
      });
      connector = makeConnector();
      const received = await collect(connector);

      // Document with no declared MIME at all.
      await connector.handleUpdatePublic(
        makeUpdate(
          98,
          makeMessage({
            document: { file_id: 'nolist_doc', file_unique_id: 'u', file_name: 'data.bin' },
          }),
        ),
      );
      // Document with a declared NON-IMAGE MIME.
      await connector.handleUpdatePublic(
        makeUpdate(
          99,
          makeMessage({
            document: {
              file_id: 'bin_doc',
              file_unique_id: 'u',
              file_name: 'notes.txt',
              mime_type: 'text/plain',
            },
          }),
        ),
      );

      expect(received).toHaveLength(0);
      expect(fetchCalls.calls).toEqual([]);
    });

    it('drops a PRIVATE UNCAPTIONED PDF-only message (pre-media behavior: no empty run)', async () => {
      const fetchCalls = installMediaFetch({ files: { priv_pdf: { bytes: bytesOf(10) } } });
      connector = makeConnector();
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          100,
          makeMessage({
            chat: { id: 555, type: 'private' },
            document: {
              file_id: 'priv_pdf',
              file_unique_id: 'u',
              file_name: 'report.pdf',
              mime_type: 'application/pdf',
              file_size: 10,
            },
          }),
        ),
      );

      expect(received).toHaveLength(0);
      expect(fetchCalls.calls).toEqual([]);
    });

    it('returns size_limit without a request when a document declares more than the 20 MB cap', async () => {
      const fetchCalls = installMediaFetch({ files: {} });
      connector = makeConnector(undefined, { imageSettings: { maxInputBytes: 50 * MIB } });
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          67,
          makeMessage({
            document: {
              file_id: 'huge_doc',
              file_unique_id: 'u',
              file_name: 'huge.png',
              mime_type: 'image/png',
              file_size: 21 * MIB,
            },
          }),
        ),
      );

      expect(expectRejection(received[0].attachments?.[0]).rejectionReason).toBe('size_limit');
      expect(fetchCalls.calls).toEqual([]);
    });

    it('enforces ACTUAL bytes for documents whose declared size is unknown', async () => {
      installMediaFetch({ files: { sneaky_doc: { bytes: bytesOf(150_000) } } });
      connector = makeConnector(undefined, { imageSettings: { maxInputBytes: 100_000 } });
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          68,
          makeMessage({
            document: { file_id: 'sneaky_doc', file_unique_id: 'u', mime_type: 'image/png' },
          }),
        ),
      );

      expect(expectRejection(received[0].attachments?.[0]).rejectionReason).toBe('size_limit');
    });
  });

  // -------------------------------------------------------------------------
  // Authorization BEFORE any separate media request
  // -------------------------------------------------------------------------

  describe('authorization precedes media downloads', () => {
    interface DenialCase {
      name: string;
      config: Partial<TelegramConfig>;
      message: object;
      prepare?: (c: TelegramConnector) => void;
    }

    const photoMedia = { photo: [photoSize('denied_photo', 800, 600, 4096)] };

    const cases: DenialCase[] = [
      {
        name: 'chat not in allowedChatIds',
        config: { allowedChatIds: ['100'] },
        message: makeMessage({ chat: { id: 200, type: 'private' }, caption: 'hi', ...photoMedia }),
      },
      {
        name: 'group message with allowGroupChats disabled',
        config: {},
        message: makeMessage({
          chat: { id: -100, type: 'group' },
          caption: '@test_bot hi',
          ...photoMedia,
        }),
      },
      {
        name: 'group message without mention or trigger',
        config: { allowGroupChats: true },
        message: makeMessage({
          chat: { id: -100, type: 'supergroup' },
          caption: 'hey everyone',
          ...photoMedia,
        }),
      },
      {
        name: 'group photo without any caption (cannot mention)',
        config: { allowGroupChats: true },
        message: makeMessage({ chat: { id: -100, type: 'group' }, ...photoMedia }),
      },
      {
        name: 'sender is a bot',
        config: {},
        message: makeMessage({
          from: { id: 7, is_bot: true, first_name: 'Evil' },
          caption: 'hi',
          ...photoMedia,
        }),
      },
      {
        name: 'DM with triggerWords but no caption',
        config: { triggerWords: ['pics'] },
        message: makeMessage(photoMedia),
      },
      {
        name: 'DM with triggerWords and a non-matching caption',
        config: { triggerWords: ['pics'] },
        message: makeMessage({ caption: 'what is this', ...photoMedia }),
      },
    ];

    for (const testCase of cases) {
      it(`denies (${testCase.name}) with no event and ZERO media requests`, async () => {
        const fetchCalls = installMediaFetch({ files: { denied_photo: { bytes: bytesOf(4096) } } });
        connector = makeConnector(testCase.config);
        testCase.prepare?.(connector);
        const received = await collect(connector);

        await connector.handleUpdatePublic(makeUpdate(80, testCase.message));

        expect(received).toHaveLength(0);
        expect(fetchCalls.calls).toEqual([]);
      });
    }

    it('drops sibling-bot photo messages with zero media requests', async () => {
      const fetchCalls = installMediaFetch({ files: { denied_photo: { bytes: bytesOf(4096) } } });
      connector = makeConnector();
      connector.setSiblingBotIds(new Set(['999']));
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(81, makeMessage({ caption: 'hi', ...photoMedia })),
      );

      expect(received).toHaveLength(0);
      expect(fetchCalls.calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Caption entities feed the existing mention rules (poll loop, real getMe)
  // -------------------------------------------------------------------------

  describe('caption/caption_entities mention and trigger rules', () => {
    it('group photo captioned with an @mention entity: strips the mention, keeps the caption, downloads', async () => {
      const fetchCalls = installMediaFetch({
        botUsername: 'test_bot',
        updateBatches: [
          [
            makeUpdate(
              90,
              makeMessage({
                chat: { id: -100, type: 'supergroup' },
                caption: '@test_bot what is in this picture?',
                caption_entities: [{ type: 'mention', offset: 0, length: '@test_bot'.length }],
                photo: [photoSize('grp_photo', 800, 600, 4096)],
              }),
            ),
          ],
        ],
        files: { grp_photo: { filePath: 'photos/grp.jpg', bytes: bytesOf(4096) } },
      });
      connector = makeConnector({ allowGroupChats: true });
      const received = await collect(connector);

      await connector.start();
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 3000 });
      await connector.stop();

      expect(received[0].content).toBe('what is in this picture?');
      expect(expectPayload(received[0].attachments?.[0]).size).toBe(4096);
      expect(fetchCalls.calls.some((url) => url === `${API_BASE}/getFile?file_id=grp_photo`)).toBe(
        true,
      );
    });

    it('group photo whose caption is ONLY the mention proceeds with empty content (image is the message)', async () => {
      installMediaFetch({
        botUsername: 'test_bot',
        updateBatches: [
          [
            makeUpdate(
              91,
              makeMessage({
                chat: { id: -100, type: 'supergroup' },
                caption: '@test_bot',
                caption_entities: [{ type: 'mention', offset: 0, length: '@test_bot'.length }],
                photo: [photoSize('only_mention', 600, 600, 2048)],
              }),
            ),
          ],
        ],
        files: { only_mention: { bytes: bytesOf(2048) } },
      });
      connector = makeConnector({ allowGroupChats: true });
      const received = await collect(connector);

      await connector.start();
      await vi.waitFor(() => expect(received.length).toBe(1), { timeout: 3000 });
      await connector.stop();

      expect(received[0].content).toBe('');
      expect(received[0].attachments).toHaveLength(1);
    });

    it('group mention-like caption that does not match the bot username is dropped with zero requests', async () => {
      const fetchCalls = installMediaFetch({
        botUsername: 'test_bot',
        updateBatches: [
          [
            makeUpdate(
              92,
              makeMessage({
                chat: { id: -100, type: 'supergroup' },
                caption: '@test_bot2 look',
                caption_entities: [{ type: 'mention', offset: 0, length: '@test_bot2'.length }],
                photo: [photoSize('no_match', 600, 600, 2048)],
              }),
            ),
          ],
        ],
        files: { no_match: { bytes: bytesOf(10) } },
      });
      connector = makeConnector({ allowGroupChats: true });
      const received = await collect(connector);

      await connector.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await connector.stop();

      expect(received).toHaveLength(0);
      expect(
        fetchCalls.calls.filter((url) => url.includes('/getFile') || url.includes('/file/bot')),
      ).toEqual([]);
    });

    it('DM trigger word on a photo caption strips the trigger and downloads', async () => {
      installMediaFetch({ files: { trig_photo: { bytes: bytesOf(2048) } } });
      connector = makeConnector({ triggerWords: ['pics'] });
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          93,
          makeMessage({
            caption: 'pics what is this',
            photo: [photoSize('trig_photo', 500, 500, 2048)],
          }),
        ),
      );

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('what is this');
      expect(received[0].attachments).toHaveLength(1);
    });

    it('text-only group mention-empty messages still drop (unchanged text semantics)', async () => {
      const fetchCalls = installMediaFetch({
        botUsername: 'test_bot',
        updateBatches: [
          [
            makeUpdate(
              94,
              makeMessage({
                chat: { id: -100, type: 'group' },
                text: '@test_bot',
                entities: [{ type: 'mention', offset: 0, length: '@test_bot'.length }],
              }),
            ),
          ],
        ],
      });
      connector = makeConnector({ allowGroupChats: true });
      const received = await collect(connector);

      await connector.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await connector.stop();

      expect(received).toHaveLength(0);
      // Control-plane getMe/getUpdates are fine; no MEDIA request may occur.
      expect(
        fetchCalls.calls.filter((url) => url.includes('/getFile') || url.includes('/file/bot')),
      ).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Hygiene: no tokens, URLs, or pixels in durable text/logs
  // -------------------------------------------------------------------------

  describe('credential and pixel hygiene', () => {
    it('keeps bot tokens out of events, attachments, raw payloads, and logs even when the API leaks them', async () => {
      // getFile returns ok=false with a token-bearing description AND the
      // download rejects with a token-bearing error message.
      installMediaFetch({
        files: {
          leaky: { lookupOk: false },
          // getFile succeeds but the byte download fails with a server error:
          // the rejection arm must stay closed (fixed text, no URL/token).
          leaky_download: { lookupOk: true, downloadStatus: 500, bytes: bytesOf(10) },
        },
      });
      const { logger, lines } = captureLogger();
      connector = makeConnector(undefined, undefined, logger);
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(
          95,
          makeMessage({ caption: 'anything', photo: [photoSize('leaky', 400, 400, 400)] }),
        ),
      );

      // Trigger a second failure path: download-stage rejection.
      await connector.handleUpdatePublic(
        makeUpdate(96, makeMessage({ photo: [photoSize('leaky_download', 400, 400, 400)] })),
      );

      expect(received).toHaveLength(2);
      for (const event of received) {
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain(BOT_TOKEN);
        expect(serialized).not.toContain('api.telegram.org');
        expect(serialized).not.toContain('/file/bot');
      }
      const allLogs = lines.join('');
      expect(allLogs).not.toContain(BOT_TOKEN);
      expect(allLogs).not.toContain('api.telegram.org');
    });

    it('keeps pixel bytes out of log output while the payload stays in the attachment', async () => {
      installMediaFetch({ files: { pix: { bytes: bytesOf(4096, 'SECRETPIXELBYTES') } } });
      const { logger, lines } = captureLogger();
      connector = makeConnector(undefined, undefined, logger);
      const received = await collect(connector);

      await connector.handleUpdatePublic(
        makeUpdate(97, makeMessage({ photo: [photoSize('pix', 400, 400, 4096)] })),
      );

      expect(expectPayload(received[0].attachments?.[0]).size).toBe(4096);
      const allLogs = lines.join('');
      expect(allLogs).not.toContain('SECRETPIXELBYTES');
      expect(allLogs).not.toContain(BOT_TOKEN);
    });

    it('reports photoPayloadMimeType defaults without inventing exotic types', () => {
      expect(photoPayloadMimeType('photos/file_1.jpg')).toBe('image/jpeg');
      expect(photoPayloadMimeType('photos/file_1.JPEG')).toBe('image/jpeg');
      expect(photoPayloadMimeType('photos/file_1.png')).toBe('image/png');
      expect(photoPayloadMimeType('photos/file_1.webp')).toBe('image/webp');
      expect(photoPayloadMimeType('photos/no_extension')).toBe('image/jpeg');
      expect(photoPayloadMimeType('')).toBe('image/jpeg');
    });
  });
});
