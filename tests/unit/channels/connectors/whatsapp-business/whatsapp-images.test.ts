/**
 * Unit tests for WhatsApp Business (Cloud API) media ingestion (TASK-008).
 *
 * The wire shapes pinned below are the VERIFIED current contract from
 * `.wdd/epics/image-processing/research/whatsapp-business-verified-contract.md`:
 *
 * - Metadata lookup: `GET https://graph.facebook.com/{apiVersion}/{media-id}?phone_number_id=…`
 *   with `Authorization: Bearer <existing token>`, DIRECT envelope
 *   `{ messaging_product, url, mime_type, sha256, file_size, id }`.
 * - Byte download: `GET <media url>` with the SAME bearer token re-attached,
 *   returning raw bytes plus a `content-type` header.
 *
 * No real HTTP requests are made: the global fetch is stubbed per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import pino from 'pino';
import { WhatsAppConnector } from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-connector.js';
import type {
  WhatsAppConfig,
  WhatsAppMessage,
  WhatsAppWebhookPayload,
} from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';
import {
  fetchWhatsAppMedia,
  planHasImageSlots,
  planWhatsAppMedia,
  whatsappMediaCaption,
} from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-media.js';
import type { ImageSelectionSettings } from '../../../../../src/images/image-selection.js';
import type { MessageFetchBudget } from '../../../../../src/images/image-transport.js';

// ---------------------------------------------------------------------------
// Constants / fixtures (verified contract shapes)
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = 'test-access-token';
const PHONE_NUMBER_ID = '123456789';
const API_VERSION = 'v18.0';
const GRAPH_BASE = 'https://graph.facebook.com';
const MEDIA_ID = 'media-id-123';
const MEDIA_URL = 'https://lookaside.fbsbx.com/tr/12345';
const IMAGE_BYTES = Buffer.from('f8fakejpegbytes', 'utf8');

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<WhatsAppConfig>): WhatsAppConfig {
  return {
    phoneNumberId: PHONE_NUMBER_ID,
    accessToken: ACCESS_TOKEN,
    verifyToken: 'test-verify-token',
    apiVersion: API_VERSION,
    ...overrides,
  };
}

/** The verified DIRECT metadata envelope (no `data` wrapper). */
function metadataEnvelope(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    url: MEDIA_URL,
    mime_type: 'image/jpeg',
    sha256: 'abc123',
    file_size: '9517907',
    id: MEDIA_ID,
    ...overrides,
  };
}

/** A webhook payload wrapping one message (object/field gates configurable). */
function makePayload(
  message: WhatsAppMessage,
  overrides?: { object?: string; field?: string },
): WhatsAppWebhookPayload {
  return {
    object: overrides?.object ?? 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-id-1',
        changes: [
          {
            field: overrides?.field ?? 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+10000000000',
                phone_number_id: PHONE_NUMBER_ID,
              },
              contacts: [{ profile: { name: 'Test User' }, wa_id: '447700900000' }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

function makeMessage(
  type: string,
  media?: { id?: string; mime_type?: string; caption?: string; filename?: string },
): WhatsAppMessage {
  return {
    id: 'wamid.MSG1',
    from: '447700900000',
    timestamp: '1700000000',
    type,
    ...(media !== undefined ? { [type]: media } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stubbed fetch
// ---------------------------------------------------------------------------

interface WireCall {
  url: string;
  init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> };
}

interface FetchStub {
  calls: WireCall[];
  fetchMock: ReturnType<typeof vi.fn>;
  metadata: { ok: boolean; json: () => Promise<unknown> };
  download: { ok: boolean; body: Readable; contentType: string | null };
  lookupCalls: () => WireCall[];
  downloadCalls: () => WireCall[];
}

function installFetch(): FetchStub {
  const stub: FetchStub = {
    calls: [],
    fetchMock: undefined as unknown as ReturnType<typeof vi.fn>,
    metadata: { ok: true, json: async () => metadataEnvelope() },
    download: {
      ok: true,
      body: Readable.from([IMAGE_BYTES]),
      contentType: 'image/jpeg',
    },
    lookupCalls: () => stub.calls.filter((c) => c.url.startsWith(GRAPH_BASE)),
    downloadCalls: () => stub.calls.filter((c) => c.url.startsWith(MEDIA_URL)),
  };
  stub.fetchMock = vi.fn(async (url: string, init?: WireCall['init']) => {
    stub.calls.push({ url, init });
    if (url.startsWith(GRAPH_BASE)) {
      return {
        ok: stub.metadata.ok,
        status: stub.metadata.ok ? 200 : 404,
        json: stub.metadata.json,
      };
    }
    return {
      ok: stub.download.ok,
      status: stub.download.ok ? 200 : 404,
      body: stub.download.body,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? stub.download.contentType : null),
      },
    };
  });
  vi.stubGlobal('fetch', stub.fetchMock);
  return stub;
}

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

describe('planWhatsAppMedia (pure, no requests)', () => {
  const settings: ImageSelectionSettings = { maxInputBytes: 10_485_760, maxPerMessage: 5 };

  it('plans an image message as one selected photo candidate', () => {
    const plan = planWhatsAppMedia(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' }), settings);
    expect(plan.selection.images).toHaveLength(1);
    const entry = plan.selection.images[0];
    expect(entry.disposition).toBe('selected');
    expect(entry.slot).toBe(0);
    expect(entry.sourcePosition).toBe(0);
    expect(entry.mimeType).toBe('image/jpeg');
    expect(planHasImageSlots(plan)).toBe(true);
  });

  it('keeps an image with no declared MIME eligible (photo origin)', () => {
    const plan = planWhatsAppMedia(makeMessage('image', { id: MEDIA_ID }), settings);
    expect(plan.selection.images[0].disposition).toBe('selected');
  });

  it('rejects an unsupported declared image MIME post-slot, before any download', () => {
    const plan = planWhatsAppMedia(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/heic' }), settings);
    expect(plan.selection.images[0].disposition).toBe('rejected');
    if (plan.selection.images[0].disposition === 'rejected') {
      expect(plan.selection.images[0].rejectionReason).toBe('unsupported_mime');
    }
  });

  it('plans an image-MIME document as eligible and keeps its filename', () => {
    const plan = planWhatsAppMedia(
      makeMessage('document', { id: MEDIA_ID, mime_type: 'image/png', filename: 'chart.png' }),
      settings,
    );
    expect(plan.selection.images[0].disposition).toBe('selected');
    if (plan.selection.images[0].disposition === 'selected') {
      expect(plan.selection.images[0].filename).toBe('chart.png');
    }
  });

  it('excludes a non-image document before slots (absent or non-image MIME)', () => {
    const noMime = planWhatsAppMedia(makeMessage('document', { id: MEDIA_ID }), settings);
    expect(noMime.selection.excluded[0].exclusionReason).toBe('non_image_mime');
    expect(noMime.selection.images).toHaveLength(0);
    expect(planHasImageSlots(noMime)).toBe(false);

    const textDoc = planWhatsAppMedia(
      makeMessage('document', { id: MEDIA_ID, mime_type: 'text/plain', filename: 'note.txt' }),
      settings,
    );
    expect(textDoc.selection.excluded[0].exclusionReason).toBe('non_image_mime');
    expect(planHasImageSlots(textDoc)).toBe(false);
  });

  it('excludes a sticker before slots (no slot, no request)', () => {
    const plan = planWhatsAppMedia(makeMessage('sticker', { id: MEDIA_ID, mime_type: 'image/webp' }), settings);
    expect(plan.selection.excluded[0].exclusionReason).toBe('sticker');
    expect(plan.selection.images).toHaveLength(0);
    expect(planHasImageSlots(plan)).toBe(false);
  });

  it('plans no candidate for audio or video', () => {
    const audio = planWhatsAppMedia(makeMessage('audio', { id: MEDIA_ID }), settings);
    expect(audio.items).toHaveLength(0);
    const video = planWhatsAppMedia(makeMessage('video', { id: MEDIA_ID }), settings);
    expect(video.items).toHaveLength(0);
  });

  it('plans no candidate when the media object has no id', () => {
    const plan = planWhatsAppMedia(makeMessage('image', {}), settings);
    expect(plan.items).toHaveLength(0);
    expect(planHasImageSlots(plan)).toBe(false);
  });
});

describe('whatsappMediaCaption', () => {
  it('reads the caption from the media object (image/document/sticker/video)', () => {
    expect(whatsappMediaCaption(makeMessage('image', { id: 'm', caption: 'photo cap' }))).toBe('photo cap');
    expect(whatsappMediaCaption(makeMessage('document', { id: 'm', caption: 'doc cap' }))).toBe('doc cap');
    expect(whatsappMediaCaption(makeMessage('sticker', { id: 'm', caption: 'sticker cap' }))).toBe('sticker cap');
    expect(whatsappMediaCaption(makeMessage('video', { id: 'm', caption: 'video cap' }))).toBe('video cap');
  });

  it('is absent when the media object carries none', () => {
    expect(whatsappMediaCaption(makeMessage('image', { id: 'm' }))).toBeUndefined();
    expect(whatsappMediaCaption(makeMessage('text'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Connector media ingestion (stubbed fetch)
// ---------------------------------------------------------------------------

describe('WhatsAppConnector media ingestion', () => {
  let connector: WhatsAppConnector;
  let fetchStub: FetchStub;
  const received: InboundEvent[] = [];

  beforeEach(() => {
    connector = new WhatsAppConnector(defaultConfig(), 'test-whatsapp', silentLogger());
    connector.onMessage(async (event) => {
      received.push(event);
    });
    fetchStub = installFetch();
  });

  afterEach(async () => {
    await connector.stop();
    received.length = 0;
    vi.restoreAllMocks();
  });

  it('downloads an image via the verified contract: exact lookup URL, auth header, and envelope', async () => {
    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('');

    // Exact metadata lookup wire shape (verified contract §2.1).
    expect(fetchStub.lookupCalls()).toHaveLength(1);
    const lookup = fetchStub.lookupCalls()[0];
    expect(lookup.url).toBe(`${GRAPH_BASE}/${API_VERSION}/${MEDIA_ID}?phone_number_id=${PHONE_NUMBER_ID}`);
    expect(lookup.init?.method).toBe('GET');
    expect(lookup.init?.headers).toEqual({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    expect(lookup.init?.signal).toBeInstanceOf(AbortSignal);

    // Byte download re-attaches the SAME bearer token to the verified URL.
    expect(fetchStub.downloadCalls()).toHaveLength(1);
    const download = fetchStub.downloadCalls()[0];
    expect(download.url).toBe(MEDIA_URL);
    expect(download.init?.headers).toEqual({ Authorization: `Bearer ${ACCESS_TOKEN}` });

    // ONE shared budget: the lookup and the download receive the same signal.
    expect(lookup.init?.signal).toBe(download.init?.signal);

    // Payload attachment from the verified bytes.
    const event = received[0];
    expect(event.attachments).toHaveLength(1);
    const attachment = event.attachments?.[0];
    expect(attachment?.kind).toBeUndefined();
    if (attachment?.kind !== 'rejected') {
      expect(attachment.mimeType).toBe('image/jpeg');
      expect(attachment.filename).toBe('photo.jpg');
      expect(attachment.data).toBeInstanceOf(Buffer);
      expect((attachment.data as Buffer).equals(IMAGE_BYTES)).toBe(true);
      expect(attachment.size).toBe(IMAGE_BYTES.length);
    }
    // The pre-signed media URL never leaks into the durable event.
    expect(JSON.stringify(event.attachments)).not.toContain(MEDIA_URL);
    expect(JSON.stringify(event.attachments)).not.toContain(ACCESS_TOKEN);
  });

  it('uses the connector-configured apiVersion in the lookup URL', async () => {
    connector = new WhatsAppConnector(
      defaultConfig({ apiVersion: 'v20.0' }),
      'test-whatsapp',
      silentLogger(),
    );
    connector.onMessage(async (event) => {
      received.push(event);
    });

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(fetchStub.lookupCalls()[0].url).toBe(
      `${GRAPH_BASE}/v20.0/${MEDIA_ID}?phone_number_id=${PHONE_NUMBER_ID}`,
    );
  });

  it('preserves the caption as the message content alongside the attachment', async () => {
    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg', caption: 'a photo caption' })),
    );

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('a photo caption');
    expect(received[0].attachments).toHaveLength(1);
  });

  it('keeps a document filename and takes the MIME from the verified envelope', async () => {
    fetchStub.metadata.json = async () =>
      metadataEnvelope({ mime_type: 'image/png', file_size: '1234' });

    await connector.feedWebhook(
      makePayload(
        makeMessage('document', { id: MEDIA_ID, mime_type: 'image/png', filename: 'chart.png' }),
      ),
    );

    expect(received[0].attachments).toHaveLength(1);
    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBeUndefined();
    if (attachment?.kind !== 'rejected') {
      expect(attachment.mimeType).toBe('image/png');
      expect(attachment.filename).toBe('chart.png');
    }
  });

  it('rejects size_limit from the verified file_size WITHOUT downloading', async () => {
    fetchStub.metadata.json = async () => metadataEnvelope({ file_size: '20000000' });

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(fetchStub.lookupCalls()).toHaveLength(1);
    expect(fetchStub.downloadCalls()).toHaveLength(0);

    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBe('rejected');
    if (attachment?.kind === 'rejected') {
      expect(attachment.rejectionReason).toBe('size_limit');
      expect(attachment.size).toBe(20_000_000);
      expect(attachment.sourcePosition).toBe(0);
    }
    expect(JSON.stringify(received[0].attachments)).not.toContain(ACCESS_TOKEN);
  });

  it('rejects unsupported_mime when the verified envelope MIME is not a supported image', async () => {
    fetchStub.metadata.json = async () => metadataEnvelope({ mime_type: 'image/heic' });

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(fetchStub.lookupCalls()).toHaveLength(1);
    expect(fetchStub.downloadCalls()).toHaveLength(0);

    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBe('rejected');
    if (attachment?.kind === 'rejected') {
      expect(attachment.rejectionReason).toBe('unsupported_mime');
    }
  });

  it('fails closed when the envelope messaging_product is not whatsapp (no download selected)', async () => {
    fetchStub.metadata.json = async () => metadataEnvelope({ messaging_product: 'messenger' });

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(fetchStub.lookupCalls()).toHaveLength(1);
    expect(fetchStub.downloadCalls()).toHaveLength(0);

    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBe('rejected');
    if (attachment?.kind === 'rejected') {
      expect(attachment.rejectionReason).toBe('download_failed');
    }
  });

  it('fails closed when the envelope URL is not https (no token sent to an unverified host)', async () => {
    fetchStub.metadata.json = async () => metadataEnvelope({ url: 'http://lookaside.fbsbx.com/tr/1' });

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(fetchStub.downloadCalls()).toHaveLength(0);
    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBe('rejected');
    if (attachment?.kind === 'rejected') {
      expect(attachment.rejectionReason).toBe('download_failed');
      // The webhook-declared MIME is carried as metadata, but the unverified
      // URL never leaks into the durable rejection.
      expect(attachment.mimeType).toBe('image/jpeg');
      expect(JSON.stringify(received[0].attachments)).not.toContain('http://lookaside');
    }
  });

  it('maps a rejected metadata lookup (HTTP 404) to download_failed', async () => {
    fetchStub.metadata.ok = false;

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(fetchStub.lookupCalls()).toHaveLength(1);
    expect(fetchStub.downloadCalls()).toHaveLength(0);
    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBe('rejected');
    if (attachment?.kind === 'rejected') {
      expect(attachment.rejectionReason).toBe('download_failed');
    }
  });

  it('maps an unparseable metadata envelope to download_failed', async () => {
    fetchStub.metadata.json = async () => {
      throw new Error('nope');
    };

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBe('rejected');
    if (attachment?.kind === 'rejected') {
      expect(attachment.rejectionReason).toBe('download_failed');
    }
  });

  it('maps a 404 byte download to download_failed (verified failure mode)', async () => {
    fetchStub.download.ok = false;

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(fetchStub.downloadCalls()).toHaveLength(1);
    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBe('rejected');
    if (attachment?.kind === 'rejected') {
      expect(attachment.rejectionReason).toBe('download_failed');
    }
  });

  it('enforces ACTUAL bytes during streaming: overflow is size_limit with no payload', async () => {
    connector = new WhatsAppConnector(
      defaultConfig(),
      'test-whatsapp',
      silentLogger(),
      { imageSettings: { maxInputBytes: 16, maxPerMessage: 5 } },
    );
    connector.onMessage(async (event) => {
      received.push(event);
    });
    // Declared size WITHIN the cap (16) so the metadata gate passes and the
    // download actually opens; the REAL stream is 17+17 bytes, so actual-byte
    // enforcement must fire during consumption.
    fetchStub.metadata.json = async () => metadataEnvelope({ file_size: '16' });
    // INFINITE 17-byte source: a consumer that did not cut off at the cap
    // would read (and buffer) forever and the test would never settle. The
    // bounded read count below is the cutoff proof — the transport takes at
    // most one Node read-ahead chunk past the cap, then destroys the source
    // without ever draining it.
    let reads = 0;
    fetchStub.download.body = new Readable({
      read() {
        reads += 1;
        this.push(Buffer.alloc(17, 1));
      },
    });

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    // Exactly one lookup and exactly one download were made, and consumption
    // was cut off at the cap: at most 2 source chunks (cap 16, 17-byte chunks,
    // one Node read-ahead) were ever requested from the infinite source.
    expect(fetchStub.lookupCalls()).toHaveLength(1);
    expect(fetchStub.downloadCalls()).toHaveLength(1);
    expect(reads).toBeLessThanOrEqual(2);

    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBe('rejected');
    if (attachment?.kind === 'rejected') {
      expect(attachment.rejectionReason).toBe('size_limit');
    }
  });

  it('falls back to the download response content-type when webhook and envelope declare no MIME', async () => {
    // The photo origin stays eligible with no declared MIME; the verified
    // envelope declares none either, so the payload MIME comes from the
    // download response's `content-type` (and drives the generated filename).
    fetchStub.metadata.json = async () => ({
      messaging_product: 'whatsapp',
      url: MEDIA_URL,
      sha256: 'abc123',
      file_size: '1234',
      id: MEDIA_ID,
    });
    fetchStub.download.contentType = 'image/png';

    await connector.feedWebhook(makePayload(makeMessage('image', { id: MEDIA_ID })));

    expect(received[0].attachments).toHaveLength(1);
    const attachment = received[0].attachments?.[0];
    expect(attachment?.kind).toBeUndefined();
    if (attachment?.kind !== 'rejected') {
      expect(attachment.mimeType).toBe('image/png');
      expect(attachment.filename).toBe('photo.png');
    }
  });

  it('makes ZERO requests for denied payloads (object/field gates before media)', async () => {
    const message = makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' });

    await connector.feedWebhook(makePayload(message, { object: 'page' }));
    await connector.feedWebhook(makePayload(message, { field: 'metadata' }));

    expect(received).toHaveLength(0);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('makes ZERO requests when no handler is registered', async () => {
    connector = new WhatsAppConnector(defaultConfig(), 'test-whatsapp', silentLogger());

    await connector.feedWebhook(
      makePayload(makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' })),
    );

    expect(received).toHaveLength(0);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('drops an image message with no id and no text (no request)', async () => {
    await connector.feedWebhook(makePayload(makeMessage('image', {})));

    expect(received).toHaveLength(0);
    expect(fetchStub.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shared budget semantics (direct fetchWhatsAppMedia)
// ---------------------------------------------------------------------------

function fakeBudget(options: { expired?: boolean; abortMs?: number }): MessageFetchBudget {
  const controller = new AbortController();
  if (options.expired) {
    controller.abort(new Error('already expired'));
  }
  const deadlineAt = Date.now() + (options.abortMs ?? 60_000);
  let timer: NodeJS.Timeout | undefined;
  if (options.abortMs !== undefined) {
    timer = setTimeout(() => controller.abort(new Error('message media fetch budget exhausted')), options.abortMs);
    timer.unref?.();
  }
  return {
    deadlineAt,
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    expired: () => controller.signal.aborted || Date.now() >= deadlineAt,
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

describe('fetchWhatsAppMedia shared budget', () => {
  it('performs NO lookup on an already-expired budget (no per-call reset)', async () => {
    const plan = planWhatsAppMedia(
      makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' }),
      { maxInputBytes: 10_485_760, maxPerMessage: 5 },
    );
    let lookups = 0;

    const attachments = await fetchWhatsAppMedia(plan, {
      lookupMedia: async () => {
        lookups += 1;
        return { url: MEDIA_URL, mimeType: 'image/jpeg' };
      },
      openMedia: async () => ({ stream: Readable.from([IMAGE_BYTES]) }),
      createFetchBudget: () => fakeBudget({ expired: true }),
    });

    expect(lookups).toBe(0);
    expect(attachments[0]?.kind).toBe('rejected');
    if (attachments[0]?.kind === 'rejected') {
      expect(attachments[0].rejectionReason).toBe('download_failed');
    }
  });

  it('fences a lookup that ignores the shared signal: late results are discarded', async () => {
    const plan = planWhatsAppMedia(
      makeMessage('image', { id: MEDIA_ID, mime_type: 'image/jpeg' }),
      { maxInputBytes: 10_485_760, maxPerMessage: 5 },
    );
    let lookups = 0;
    let opens = 0;

    const attachments = await fetchWhatsAppMedia(plan, {
      lookupMedia: async () => {
        lookups += 1;
        // Ignores the signal entirely; resolves well after the budget fires.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { url: MEDIA_URL, mimeType: 'image/jpeg' };
      },
      openMedia: async () => {
        opens += 1;
        return { stream: Readable.from([IMAGE_BYTES]) };
      },
      createFetchBudget: () => fakeBudget({ abortMs: 20 }),
    });

    expect(lookups).toBe(1);
    expect(opens).toBe(0);
    expect(attachments[0]?.kind).toBe('rejected');
    if (attachments[0]?.kind === 'rejected') {
      expect(attachments[0].rejectionReason).toBe('download_failed');
    }
  });
});
