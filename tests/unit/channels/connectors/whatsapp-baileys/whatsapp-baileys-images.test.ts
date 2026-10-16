/**
 * TASK-007 tests: Baileys photo/document image ingestion.
 *
 * Covers the pinned wrapper unwrapping, MIME-based document eligibility,
 * sticker exclusion BEFORE any download, selection-driven size/cap limits
 * (declared sizes never trigger a fetch), the single shared 60-second
 * message fetch budget across slots, closed-outcome Attachments
 * (payload / metadata-only rejection), denial-before-download, credential
 * hygiene, and the pinned E4 `downloadMediaMessage(message, 'stream', {},
 * ctx?)` invocation of the default opener (cancellation lives in the media
 * transfer adapter, not in Baileys' options, because rc.9 drops
 * `options.signal`). The REAL Baileys download path against a stubbed
 * transport is exercised in `whatsapp-baileys-media-transfer.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { PassThrough, Readable } from 'node:stream';
import { WhatsAppBaileysConnector } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.js';
import {
  unwrapMessageContent,
  extractTextAndMediaCandidates,
  fetchSelectedImageAttachments,
  resolveBaileysImageSettings,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_PER_MESSAGE,
  type BaileysImageIngestOptions,
  type ResolvedBaileysImageSettings,
} from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-images.js';
import { selectImages, type ImageMediaCandidate } from '../../../../../src/images/image-selection.js';
import { ImagesConfigSchema } from '../../../../../src/core/config/config-schema.js';
import type { WhatsAppBaileysConfig } from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-types.js';
import type {
  InboundEvent,
  InboundAttachment,
  InboundAttachmentRejection,
} from '../../../../../src/channels/channel-types.js';

// Pin the E4 stream invocation of the default opener (mocked module).
const { downloadMediaMessageMock } = vi.hoisted(() => ({
  downloadMediaMessageMock: vi.fn(),
}));
vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: downloadMediaMessageMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

function makeConnector(
  config: WhatsAppBaileysConfig = {},
  imageMedia?: BaileysImageIngestOptions,
): WhatsAppBaileysConnector {
  return new WhatsAppBaileysConnector(config, 'test-baileys', logger, imageMedia);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handle(connector: WhatsAppBaileysConnector, msg: unknown): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (connector as any).handleInboundMessage(msg);
}

function settings(
  overrides: Partial<ResolvedBaileysImageSettings> = {},
  openMedia = vi.fn(async (): Promise<Readable> => Readable.from([Buffer.from('image-bytes')])),
): ResolvedBaileysImageSettings {
  return resolveBaileysImageSettings(
    {
      maxInputBytes: overrides.maxInputBytes,
      maxPerMessage: overrides.maxPerMessage,
      openMedia,
    },
    openMedia,
  );
}

/** WAMessage with arbitrary content for the connector path. */
function mediaMsg(content: Record<string, unknown>, key: Record<string, unknown> = {}): unknown {
  return {
    key: {
      fromMe: false,
      remoteJid: '31612345678@s.whatsapp.net',
      id: 'media-msg-001',
      ...key,
    },
    message: content,
    messageTimestamp: 1700000000,
  };
}

function imageContent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageMessage: {
      url: 'https://mmg.example/encrypted-media',
      mediaKey: 'SUPER-SECRET-MEDIA-KEY',
      mimetype: 'image/jpeg',
      fileLength: 9,
      ...extra,
    },
  };
}

// Same discrimination as src/images/image-ingestion.ts: payload Attachments
// are identified by the ABSENCE of `kind`.
function isRejection(a: InboundAttachment): a is InboundAttachmentRejection {
  return 'kind' in a && a.kind === 'rejected';
}

// ---------------------------------------------------------------------------
// Container unwrapping (pinned to Baileys normalizeMessageContent)
// ---------------------------------------------------------------------------

describe('unwrapMessageContent', () => {
  it('returns unwrapped content unchanged', () => {
    const content = { conversation: 'hi' };
    expect(unwrapMessageContent(content)).toBe(content);
  });

  it('returns undefined for absent content', () => {
    expect(unwrapMessageContent(null)).toBeUndefined();
    expect(unwrapMessageContent(undefined)).toBeUndefined();
  });

  it.each([
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'editedMessage',
    'documentWithCaptionMessage',
  ])('unwraps %s containers down to the inner content', (wrapper) => {
    const inner = { imageMessage: { mimetype: 'image/jpeg' } };
    const wrapped = { [wrapper]: { message: inner } };
    expect(unwrapMessageContent(wrapped)).toBe(inner);
  });

  it('unwraps nested wrappers up to the pinned 5-iteration cap', () => {
    const inner = { imageMessage: { mimetype: 'image/jpeg' } };
    // 5 nested ephemeral wrappers: exactly at the cap → inner reached.
    let current: Record<string, unknown> = inner;
    for (let i = 0; i < 5; i += 1) {
      current = { ephemeralMessage: { message: current } };
    }
    expect(unwrapMessageContent(current)).toBe(inner);

    // 6 nested wrappers: one over the cap → stops at the last wrapper.
    let tooDeep: Record<string, unknown> = inner;
    for (let i = 0; i < 6; i += 1) {
      tooDeep = { ephemeralMessage: { message: tooDeep } };
    }
    const result = unwrapMessageContent(tooDeep);
    expect(result).toBeDefined();
    expect(result).not.toBe(inner);
    expect(result?.['ephemeralMessage']).toBeDefined();
  });

  it('stops when a wrapper carries no inner message record', () => {
    const wrapped = { ephemeralMessage: {} };
    expect(unwrapMessageContent(wrapped)).toBe(wrapped);
  });
});

// ---------------------------------------------------------------------------
// Text + candidate extraction (pinned proto fields)
// ---------------------------------------------------------------------------

describe('extractTextAndMediaCandidates', () => {
  it('builds a photo candidate with pinned ImageMessage fields', () => {
    const { text, candidates } = extractTextAndMediaCandidates({
      imageMessage: { mimetype: 'IMAGE/JPEG', caption: 'look at this', fileLength: 1234 },
    });
    expect(text).toBe('look at this');
    expect(candidates).toEqual([
      { origin: 'photo', mimeType: 'IMAGE/JPEG', declaredSize: 1234 },
    ]);
  });

  it('reads Long-like uint64 fileLength values', () => {
    const { candidates } = extractTextAndMediaCandidates({
      imageMessage: { fileLength: { low: 300000, high: 0, unsigned: true } },
    });
    expect(candidates[0]?.declaredSize).toBe(300000);
  });

  it('treats beyond-safe-integer fileLength as unknown size', () => {
    // high=2097152 → 2097152 * 2^32 = 2^53, beyond Number.MAX_SAFE_INTEGER
    const { candidates } = extractTextAndMediaCandidates({
      imageMessage: { fileLength: { low: 1, high: 2_097_152, unsigned: true } },
    });
    expect(candidates[0]?.declaredSize).toBeUndefined();
  });

  it('builds a document candidate; fileName wins over legacy title', () => {
    const { text, candidates } = extractTextAndMediaCandidates({
      documentMessage: {
        mimetype: 'image/png',
        fileName: 'screenshot.png',
        title: 'legacy-title',
        caption: 'the caption',
        fileLength: 10,
      },
    });
    expect(text).toBe('the caption');
    expect(candidates).toEqual([
      { origin: 'document', mimeType: 'image/png', filename: 'screenshot.png', declaredSize: 10 },
    ]);
  });

  it('falls back to the legacy title field', () => {
    const { candidates } = extractTextAndMediaCandidates({
      documentMessage: { mimetype: 'image/png', title: 'old-name.png' },
    });
    expect(candidates[0]?.filename).toBe('old-name.png');
  });

  it('flags sticker candidates for silent exclusion', () => {
    const { text, candidates } = extractTextAndMediaCandidates({
      stickerMessage: { mimetype: 'image/webp', fileLength: 5 },
    });
    expect(text).toBe(''); // sticker captions stay unsurfaced (existing behavior)
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sticker).toBe(true);
  });

  it('produces no candidate for video/audio/location content', () => {
    expect(extractTextAndMediaCandidates({ videoMessage: { url: 'x' } })).toEqual({
      text: '',
      candidates: [],
    });
    expect(extractTextAndMediaCandidates({ audioMessage: { url: 'x' } }).candidates).toEqual([]);
    expect(extractTextAndMediaCandidates({ locationMessage: {} }).candidates).toEqual([]);
  });

  it('keeps conversation/extendedText precedence over media captions', () => {
    const { text } = extractTextAndMediaCandidates({
      extendedTextMessage: { text: 'primary' },
      imageMessage: { caption: 'caption' },
    });
    expect(text).toBe('primary');
  });
});

// ---------------------------------------------------------------------------
// Selection-driven bounded fetch (shared transport)
// ---------------------------------------------------------------------------

describe('fetchSelectedImageAttachments — exclusions and rejections before download', () => {
  it('excludes stickers with NO media request', async () => {
    const openMedia = vi.fn(async (): Promise<Readable> => Readable.from([Buffer.from('x')]));
    const entries = selectImages(
      [{ origin: 'photo', sticker: true, mimeType: 'image/webp' }],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    ).images;
    const result = await fetchSelectedImageAttachments({}, entries, settings({}, openMedia));
    expect(result).toEqual([]);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('silently excludes non-image-MIME and absent-MIME documents with NO download', async () => {
    const openMedia = vi.fn(async (): Promise<Readable> => Readable.from([Buffer.from('x')]));
    const selection = selectImages(
      [
        { origin: 'document', mimeType: 'application/pdf', filename: 'report.pdf' },
        { origin: 'document', filename: 'no-mime' },
        { origin: 'document', mimeType: 'text/plain' },
      ],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    );
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({}, openMedia));
    expect(result).toEqual([]);
    expect(selection.excluded).toHaveLength(3);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('rejects unsupported image MIME (HEIC) with a slot consumed and NO download', async () => {
    const openMedia = vi.fn(async (): Promise<Readable> => Readable.from([Buffer.from('x')]));
    const selection = selectImages(
      [{ origin: 'document', mimeType: 'image/heic', filename: 'photo.heic' }],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    );
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({}, openMedia));
    expect(openMedia).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'rejected',
      rejectionReason: 'unsupported_mime',
      filename: 'photo.heic',
      mimeType: 'image/heic',
      sourcePosition: 0,
    });
  });

  it('rejects declared-size oversize with size_limit and NO download', async () => {
    const openMedia = vi.fn(async (): Promise<Readable> => Readable.from([Buffer.from('x')]));
    const selection = selectImages(
      [{ origin: 'photo', mimeType: 'image/jpeg', declaredSize: 1001 }],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    );
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({}, openMedia));
    expect(openMedia).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ kind: 'rejected', rejectionReason: 'size_limit', size: 1001 });
  });

  it('caps slots per message: overflow is count_limit without any download for the overflow slots', async () => {
    const openMedia = vi.fn(async (): Promise<Readable> => Readable.from([Buffer.from('x')]));
    const candidates: ImageMediaCandidate[] = Array.from({ length: 7 }, (_unused, i) => ({
      origin: 'document',
      mimeType: 'image/png',
      filename: `pic-${i}.png`,
    }));
    const selection = selectImages(candidates, { maxInputBytes: 1000, maxPerMessage: 5 });
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({ maxPerMessage: 5 }, openMedia));

    expect(openMedia).toHaveBeenCalledTimes(5);
    expect(result).toHaveLength(7);
    expect(result.slice(0, 5).every((a) => !isRejection(a))).toBe(true);
    expect(result[5]).toMatchObject({ kind: 'rejected', rejectionReason: 'count_limit', sourcePosition: 5 });
    expect(result[6]).toMatchObject({ kind: 'rejected', rejectionReason: 'count_limit', sourcePosition: 6 });
  });
});

describe('fetchSelectedImageAttachments — bounded transport behavior', () => {
  it('hands the accepted photo to the shared transport and returns a payload Attachment', async () => {
    const bytes = Buffer.from('image-bytes');
    const openMedia = vi.fn(async (): Promise<Readable> => Readable.from([bytes]));
    const selection = selectImages(
      [{ origin: 'photo', mimeType: 'image/jpeg', declaredSize: 9 }],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    );
    const result = await fetchSelectedImageAttachments({ key: { id: 'm1' } }, selection.images, settings({}, openMedia));

    expect(openMedia).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    const payload = result[0]!;
    expect(isRejection(payload)).toBe(false);
    if (isRejection(payload)) return;
    expect(Buffer.isBuffer(payload.data)).toBe(true);
    expect(payload.size).toBe(bytes.byteLength);
    expect(payload.mimeType).toBe('image/jpeg');
  });

  it('normalizes case and strips MIME parameters end to end', async () => {
    const openMedia = vi.fn(async (): Promise<Readable> => Readable.from([Buffer.from('x')]));
    const selection = selectImages(
      [{ origin: 'document', mimeType: 'IMAGE/PNG;charset=binary', filename: 'a.png' }],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    );
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({}, openMedia));
    expect(result[0]!.mimeType).toBe('image/png');
  });

  it('maps a throwing opener to the closed download_failed rejection with sanitized metadata', async () => {
    const openMedia = vi.fn(async (): Promise<Readable> => {
      throw new Error('signed URL https://mmg.example/x?authorization=Bearer%20abc expired');
    });
    const selection = selectImages(
      [{ origin: 'document', mimeType: 'image/jpeg', filename: 'photo.jpg', declaredSize: 42 }],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    );
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({}, openMedia));
    expect(result).toHaveLength(1);
    const rejection = result[0]!;
    expect(isRejection(rejection)).toBe(true);
    if (!isRejection(rejection)) return;
    expect(rejection.rejectionReason).toBe('download_failed');
    expect(rejection.filename).toBe('photo.jpg');
    expect(rejection.mimeType).toBe('image/jpeg');
    expect(rejection.size).toBe(42);
    // No extra keys: nothing can carry credentials, URLs, or pixels out.
    expect(Object.keys(rejection).sort()).toEqual([
      'filename',
      'kind',
      'mimeType',
      'rejectionReason',
      'size',
      'sourcePosition',
    ]);
  });

  it('enforces the byte cap DURING consumption and destroys the source stream', async () => {
    const source = new PassThrough();
    source.on('error', () => undefined); // post-destroy writes must not crash the test
    source.write(Buffer.alloc(60));
    source.write(Buffer.alloc(60));
    source.write(Buffer.alloc(30));
    const openMedia = vi.fn(async (): Promise<Readable> => source);
    const selection = selectImages([{ origin: 'photo' }], { maxInputBytes: 100, maxPerMessage: 5 });
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({ maxInputBytes: 100 }, openMedia));

    expect(result[0]).toMatchObject({ kind: 'rejected', rejectionReason: 'size_limit' });
    expect(source.destroyed).toBe(true);
  });

  it('drops filenames bearing credential pairs instead of retaining them', async () => {
    const openMedia = vi.fn(async (): Promise<Readable> => {
      throw new Error('nope');
    });
    const selection = selectImages(
      [{ origin: 'document', mimeType: 'image/png', filename: 'x.png&authorization=Bearer abc123' }],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    );
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({}, openMedia));
    const rejection = result[0]!;
    expect(isRejection(rejection)).toBe(true);
    if (!isRejection(rejection)) return;
    expect(rejection.filename).toBeUndefined();
    expect(rejection.rejectionReason).toBe('download_failed');
  });
});

describe('fetchSelectedImageAttachments — one shared 60-second message budget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('threads ONE shared AbortSignal through every slot open and leaves no timer behind', async () => {
    const signals: AbortSignal[] = [];
    const openMedia = vi.fn(async (_msg: unknown, signal: AbortSignal): Promise<Readable> => {
      signals.push(signal);
      return Readable.from([Buffer.from('x')]);
    });
    const selection = selectImages(
      [
        { origin: 'photo', mimeType: 'image/jpeg' },
        { origin: 'document', mimeType: 'image/png' },
      ],
      { maxInputBytes: 1000, maxPerMessage: 5 },
    );
    const result = await fetchSelectedImageAttachments({}, selection.images, settings({}, openMedia));
    await vi.advanceTimersByTimeAsync(0);

    expect(result).toHaveLength(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]); // SAME signal = same message deadline
    expect(vi.getTimerCount()).toBe(0); // budget disposed: no 60s timer outlives the message
  });

  it('lets a late slot settle as download_failed once the shared deadline elapsed', async () => {
    // The opener only resolves once the shared deadline aborts its signal:
    // the stream then arrives late and must not be admitted.
    const openMedia = vi.fn(
      (_msg: unknown, signal: AbortSignal): Promise<Readable> =>
        new Promise<Readable>((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve(Readable.from([Buffer.from('late')])),
            { once: true },
          );
        }),
    );
    const selection = selectImages([{ origin: 'photo' }], { maxInputBytes: 1000, maxPerMessage: 5 });
    const pending = fetchSelectedImageAttachments({}, selection.images, settings({}, openMedia));
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await pending;

    expect(result[0]).toMatchObject({ kind: 'rejected', rejectionReason: 'download_failed' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Defaults (cap fallback) — parity with the config schema
// ---------------------------------------------------------------------------

describe('default image caps', () => {
  it('match the images config schema defaults so the pre-injection fallback cannot drift', () => {
    const schemaDefaults = ImagesConfigSchema.parse({});
    expect(DEFAULT_MAX_INPUT_BYTES).toBe(schemaDefaults.maxInputBytes);
    expect(DEFAULT_MAX_PER_MESSAGE).toBe(schemaDefaults.maxPerMessage);
  });

  it('resolveBaileysImageSettings applies defaults and honours overrides', () => {
    const opener = vi.fn(async (): Promise<Readable> => Readable.from([]));
    const resolved = resolveBaileysImageSettings(undefined, opener);
    expect(resolved.maxInputBytes).toBe(DEFAULT_MAX_INPUT_BYTES);
    expect(resolved.maxPerMessage).toBe(DEFAULT_MAX_PER_MESSAGE);
    expect(resolved.openMedia).toBe(opener);

    const overridden = resolveBaileysImageSettings({ maxInputBytes: 10, maxPerMessage: 1 }, opener);
    expect(overridden.maxInputBytes).toBe(10);
    expect(overridden.maxPerMessage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Connector integration: authorization BEFORE any media request
// ---------------------------------------------------------------------------

function trackingOpener() {
  return vi.fn(async (): Promise<Readable> => Readable.from([Buffer.from('photo-bytes')]));
}

describe('connector media path — denial never downloads', () => {
  it('fromMe image in normal mode: no download, no event', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent(), { fromMe: true }));

    expect(received).toHaveLength(0);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('disallowed sender image: no download, no event', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({ allowedSenders: ['31612345678'] }, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent(), { remoteJid: '447700900000@s.whatsapp.net' }));

    expect(received).toHaveLength(0);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('group image without allowGroupChats: no download, no event', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent({ caption: 'hello' }), { remoteJid: '120363@g.us', participant: '111@s.whatsapp.net' }));

    expect(received).toHaveLength(0);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('group image whose caption misses the trigger: no download, no event', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({ allowGroupChats: true, triggerWords: ['@Talon'] }, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent({ caption: 'no trigger here' }), { remoteJid: '120363@g.us', participant: '111@s.whatsapp.net' }));

    expect(received).toHaveLength(0);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('own status-broadcast image (fromMe, status@broadcast): no download, no event', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent(), { fromMe: true, remoteJid: 'status@broadcast' }));

    expect(received).toHaveLength(0);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('self-chat mode, fromMe image in a NON-self thread: no download, no event', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({ selfChat: true }, { openMedia });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selfIds = (c as any).selfIds as Set<string>;
    selfIds.add('31612345678');
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent(), { fromMe: true, remoteJid: '447700900000@s.whatsapp.net' }));

    expect(received).toHaveLength(0);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('self-chat mode, NON-fromMe image in the self thread: no download, no event', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({ selfChat: true }, { openMedia });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selfIds = (c as any).selfIds as Set<string>;
    selfIds.add('31612345678');
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent(), { fromMe: false, remoteJid: '31612345678@s.whatsapp.net' }));

    expect(received).toHaveLength(0);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('authorized group image with trigger caption downloads and delivers', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({ allowGroupChats: true, triggerWords: ['@Talon'] }, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent({ caption: '@Talon what is in this photo?' }), { remoteJid: '120363@g.us', participant: '111@s.whatsapp.net' }));

    expect(openMedia).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.content).toBe('what is in this photo?');
    expect(received[0]!.attachments).toHaveLength(1);
    expect(isRejection(received[0]!.attachments![0]!)).toBe(false);
  });

  it('self-chat fromMe image in the self thread downloads and delivers', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({ selfChat: true }, { openMedia });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selfIds = (c as any).selfIds as Set<string>;
    selfIds.add('31612345678');
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent(), { fromMe: true }));

    expect(openMedia).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.content).toBe('');
    expect(received[0]!.attachments?.[0]).toMatchObject({ mimeType: 'image/jpeg', size: 11 });
  });
});

describe('connector media path — outcomes and preservation', () => {
  it('image-only message invokes the callback with an empty-text event and a payload Attachment', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent()));

    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(event.content).toBe('');
    expect(event.idempotencyKey).toBe('media-msg-001'); // stable key unchanged
    expect(event.attachments).toHaveLength(1);
    const attachment = event.attachments![0]!;
    expect(isRejection(attachment)).toBe(false); // payload arm
    if (isRejection(attachment)) return;
    expect(Buffer.isBuffer(attachment.data)).toBe(true);
    // The payload carries no mediaKey/url — credentials stay out of outcomes.
    expect(Object.keys(attachment).sort()).toEqual(['data', 'filename', 'mimeType', 'size']);
    expect(openMedia).toHaveBeenCalledTimes(1);
  });

  it('retains the caption alongside the downloaded image', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg({ imageMessage: { mimetype: 'image/webp', caption: 'my cat', fileLength: 11 } }));

    expect(received[0]!.content).toBe('my cat');
    expect(received[0]!.attachments?.[0]).toMatchObject({ mimeType: 'image/webp' });
  });

  it('trigger-only caption with an image still proceeds as image-only', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({ triggerWords: ['@Talon'] }, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent({ caption: '@Talon' })));

    expect(received).toHaveLength(1);
    expect(received[0]!.content).toBe('');
    expect(received[0]!.attachments).toHaveLength(1);
  });

  it('unwraps a documentWithCaptionMessage image document and preserves caption + filename', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(
      c,
      mediaMsg({
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              mimetype: 'image/png',
              fileName: 'diagram.png',
              caption: 'architecture',
              fileLength: 11,
            },
          },
        },
      }),
    );

    expect(openMedia).toHaveBeenCalledTimes(1);
    expect(received[0]!.content).toBe('architecture');
    expect(received[0]!.attachments?.[0]).toMatchObject({ filename: 'diagram.png', mimeType: 'image/png' });
  });

  it('sticker messages stay silently excluded: no event, no download', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg({ stickerMessage: { mimetype: 'image/webp', fileLength: 11 } }));

    expect(received).toHaveLength(0);
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('non-image document delivers caption text WITHOUT attachments or download', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg({ documentMessage: { mimetype: 'application/pdf', caption: 'invoice attached', fileName: 'inv.pdf' } }));

    expect(received).toHaveLength(1);
    expect(received[0]!.content).toBe('invoice attached');
    expect(received[0]!.attachments).toBeUndefined();
    expect(openMedia).not.toHaveBeenCalled();
  });

  it('HEIC document message delivers a closed unsupported_mime rejection without download', async () => {
    const openMedia = trackingOpener();
    const c = makeConnector({}, { openMedia });
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg({ documentMessage: { mimetype: 'image/heic', fileName: 'pic.heic' } }));

    expect(openMedia).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]!.content).toBe('');
    expect(received[0]!.attachments?.[0]).toMatchObject({
      kind: 'rejected',
      rejectionReason: 'unsupported_mime',
      mimeType: 'image/heic',
    });
  });
});

// ---------------------------------------------------------------------------
// E4 pin: default opener invokes Baileys downloadMediaMessage per contract
// ---------------------------------------------------------------------------

describe('default opener — pinned E4 stream invocation', () => {
  beforeEach(() => {
    downloadMediaMessageMock.mockReset();
  });

  it('calls downloadMediaMessage(message, "stream", {}) with no ctx when the socket cannot reupload', async () => {
    downloadMediaMessageMock.mockImplementation(async () => Readable.from([Buffer.from('ok-bytes')]));
    const c = makeConnector();
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    const msg = mediaMsg(imageContent());
    await handle(c, msg);

    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(1);
    const args = downloadMediaMessageMock.mock.calls[0]!;
    expect(args[0]).toBe(msg); // the WAMessage is the opaque handle
    expect(args[1]).toBe('stream'); // stream mode ONLY — buffer mode cannot bound bytes
    // No signal is threaded through Baileys options: rc.9's getHttpStream
    // DROPS options.signal (messages-media.js:296–300), so pretending
    // otherwise would be a lie. Cancellation is owned by the media-transfer
    // adapter wrapping this call (pinned for real in the media-transfer file).
    expect(args[2]).toEqual({});
    expect(args[3]).toBeUndefined(); // no reupload ctx without a socket
    expect(received[0]!.attachments?.[0]).toMatchObject({ size: 8 });
  });

  it('wires ctx.reuploadRequest to the socket updateMediaMessage member (never a fabricated socket reuploadRequest)', async () => {
    const updateMediaMessage = vi.fn(async () => ({ key: {}, message: {} }));
    downloadMediaMessageMock.mockImplementation(
      async (_msg: unknown, _type: string, _opts: unknown, ctx?: { reuploadRequest?: (m: unknown) => Promise<unknown> }) => {
        expect(typeof ctx?.reuploadRequest).toBe('function');
        await ctx!.reuploadRequest!({ key: { id: 'x' } });
        return Readable.from([Buffer.from('after-reupload')]);
      },
    );
    const c = makeConnector();
    // The REAL rc.9 socket member is `updateMediaMessage`
    // (lib/Socket/messages-send.js:840); `reuploadRequest` exists ONLY as
    // the ctx field name (lib/Utils/messages.d.ts:79).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).sock = { updateMediaMessage };
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent()));

    expect(updateMediaMessage).toHaveBeenCalledTimes(1);
    expect(updateMediaMessage).toHaveBeenCalledWith({ key: { id: 'x' } });
    expect(received[0]!.attachments?.[0]).toMatchObject({ size: 14 });
  });

  it('offers no ctx when the socket exposes only a legacy reuploadRequest member', async () => {
    downloadMediaMessageMock.mockImplementation(async (_m, _t, _o, ctx) => {
      expect(ctx).toBeUndefined();
      return Readable.from([Buffer.from('no-ctx')]);
    });
    const c = makeConnector();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).sock = { reuploadRequest: vi.fn() }; // not the real member
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent()));

    expect(received[0]!.attachments?.[0]).toMatchObject({ size: 6 });
  });

  it('maps a rejecting downloadMediaMessage to the closed download_failed outcome', async () => {
    downloadMediaMessageMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 410 }));
    const c = makeConnector();
    const received: InboundEvent[] = [];
    c.onMessage(async (e) => { received.push(e); });

    await handle(c, mediaMsg(imageContent()));

    expect(received[0]!.attachments?.[0]).toMatchObject({
      kind: 'rejected',
      rejectionReason: 'download_failed',
    });
  });
});
