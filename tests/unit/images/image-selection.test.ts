/**
 * Tests for the shared image selection policy (TASK-004).
 *
 * Covers: exclusions before slots (sticker, inline/related email, duplicate
 * photo renditions, non-image/absent-MIME documents), MIME parameter
 * stripping and case-insensitivity, source-order slot consumption, failure
 * consumes the slot (no backfill), post-slot size/MIME checks, overflow
 * without download, legacy Buffer/path payloads, and oversized in-hand
 * buffers rejected before anything could be written.
 */

import { describe, it, expect } from 'vitest';
import {
  selectImages,
  normalizeMimeType,
  isSupportedImageMime,
  sanitizeFilename,
  SUPPORTED_IMAGE_MIME_TYPES,
  type ImageMediaCandidate,
  type ImageSelectionEntry,
  type ImageSelectionResult,
  type MediaOrigin,
  type SelectedImage,
} from '@talon/images/image-selection.js';

const DEFAULT_SETTINGS = { maxInputBytes: 10_485_760, maxPerMessage: 5 };

function photo(
  mime: string | undefined,
  extra: Partial<ImageMediaCandidate> = {},
): ImageMediaCandidate {
  return { origin: 'photo', ...(mime !== undefined ? { mimeType: mime } : {}), ...extra };
}

function document(
  mime: string | undefined,
  extra: Partial<ImageMediaCandidate> = {},
): ImageMediaCandidate {
  return { origin: 'document', ...(mime !== undefined ? { mimeType: mime } : {}), ...extra };
}

/** Narrow a selection entry to the selected arm (fails the test otherwise). */
function selected(entry: ImageSelectionEntry): SelectedImage {
  if (entry.disposition !== 'selected') {
    throw new Error(`Expected selected entry, got ${JSON.stringify(entry)}`);
  }
  return entry;
}

/** Simulate the connector's post-selection download loop and record fetch calls. */
function simulateDownloads(result: ImageSelectionResult): number[] {
  const fetches: number[] = [];
  for (const entry of result.images) {
    if (entry.disposition === 'selected' && entry.requiresFetch) {
      fetches.push(entry.sourcePosition);
    }
  }
  return fetches;
}

describe('normalizeMimeType', () => {
  it('lowercases and strips MIME parameters', () => {
    expect(normalizeMimeType('IMAGE/PNG')).toBe('image/png');
    expect(normalizeMimeType('image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(normalizeMimeType('  image/webp  ')).toBe('image/webp');
  });

  it('treats parameter-only or empty values as absent', () => {
    expect(normalizeMimeType('')).toBeUndefined();
    expect(normalizeMimeType(undefined)).toBeUndefined();
    expect(normalizeMimeType('   ')).toBeUndefined();
    expect(normalizeMimeType(';')).toBeUndefined();
    expect(normalizeMimeType(';charset=binary')).toBeUndefined();
  });

  it('rejects malformed MIME shapes as absent instead of retaining them', () => {
    // URL-bearing, whitespace-bearing, and non-token shapes never survive
    // into matching or durable output metadata.
    expect(normalizeMimeType('image/jpeg https://x.test/p?token=MIMEHOST')).toBeUndefined();
    expect(normalizeMimeType('image/pn\tg')).toBeUndefined();
    expect(normalizeMimeType('image/jp eg')).toBeUndefined();
    expect(normalizeMimeType('image')).toBeUndefined();
    expect(normalizeMimeType('image/')).toBeUndefined();
    expect(normalizeMimeType('/jpeg')).toBeUndefined();
    expect(normalizeMimeType('not/a MIME at all')).toBeUndefined();
  });

  it('keeps well-formed structured suffixes', () => {
    expect(normalizeMimeType('IMAGE/SVG+XML')).toBe('image/svg+xml');
  });

  it('retains RFC-2045 token chars (curly braces) and rejects the backslash tspecial', () => {
    expect(normalizeMimeType('image/x{vendor}')).toBe('image/x{vendor}');
    expect(normalizeMimeType('image/x{a}b{c}')).toBe('image/x{a}b{c}');
    // Backslash is an RFC-2045 tspecial: it must NOT be a token character.
    expect(normalizeMimeType('image/x\\y')).toBeUndefined();
    // Other tspecials and whitespace are still rejected.
    expect(normalizeMimeType('image/{a,b}')).toBeUndefined();
    expect(normalizeMimeType('image/a{b} c')).toBeUndefined();
  });
});

describe('isSupportedImageMime', () => {
  it('accepts exactly the supported set', () => {
    for (const mime of SUPPORTED_IMAGE_MIME_TYPES) {
      expect(isSupportedImageMime(mime)).toBe(true);
    }
    expect(isSupportedImageMime('image/gif')).toBe(false);
    expect(isSupportedImageMime('image/svg+xml')).toBe(false);
    expect(isSupportedImageMime('application/pdf')).toBe(false);
    expect(isSupportedImageMime(undefined)).toBe(false);
  });
});

describe('sanitizeFilename', () => {
  it('replaces separators and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('a\\b.png')).toBe('a_b.png');
    expect(sanitizeFilename('weird\x00name\x07.png')).toBe('weird_name_.png');
  });

  it('caps length and returns undefined when nothing usable remains', () => {
    expect(sanitizeFilename('a'.repeat(500))?.length).toBe(200);
    expect(sanitizeFilename('///')).toBe('___'); // separators neutralized, never path segments
    expect(sanitizeFilename('   ')).toBeUndefined();
    expect(sanitizeFilename('\u0000\u0001')).toBe('__');
    expect(sanitizeFilename(undefined)).toBeUndefined();
  });

  it('omits credential- and URL-bearing filenames fail-closed', () => {
    // Round-4 counterexample: scheme preceded by underscore/digit must still
    // be detected — no word-boundary reliance.
    expect(
      sanitizeFilename('photo_https://api.telegram.org/file/bot123:BOTTOKENCANARY/image.jpg'),
    ).toBeUndefined();
    // Reviewer counterexample (a): trailing quoted value after URL removal.
    expect(sanitizeFilename('doc https://x.test/f token="TRAILING_URLCANARY"')).toBeUndefined();
    // Reviewer counterexample (b): escaped quote stops a quoted-value regex.
    expect(sanitizeFilename('x access_token="prefix\\"ESCAPEDCANARY')).toBeUndefined();
    // Key-pair shapes of every quote style are omitted, not partial-redacted.
    expect(
      sanitizeFilename('report https://cdn.example.com/f?access_token=FILECANARY.pdf'),
    ).toBeUndefined();
    expect(sanitizeFilename("img access_token='SINGLECANARY'.jpg")).toBeUndefined();
    expect(sanitizeFilename('img access_token="SPACED CANARY".jpg')).toBeUndefined();
    expect(sanitizeFilename('doc Authorization: Basic BASICCANARY')).toBeUndefined();
    expect(sanitizeFilename('pic bearer eyJHEADER.SIGNATURE.jpg')).toBeUndefined();
    // Benign filenames are retained.
    expect(sanitizeFilename('holiday photo.jpg')).toBe('holiday photo.jpg');
    expect(sanitizeFilename('basic architecture notes.pdf')).toBe('basic architecture notes.pdf');
  });
});

describe('selectImages — exclusions happen before slots', () => {
  it('excludes stickers, inline/related email content, duplicate photos, and non-image documents', () => {
    const result = selectImages(
      [
        photo('image/webp', { sticker: true, filename: 'sticker.webp' }),
        photo('image/png', { inlineRelated: true, filename: 'inline.png' }),
        photo('image/png', { inlineRelated: true, filename: 'related.png' }),
        photo('image/jpeg', { duplicatePhotoRepresentation: true, filename: 'dup.jpg' }),
        document('application/pdf', { filename: 'contract.pdf' }),
        document(undefined, { filename: 'mystery.bin' }),
        photo('image/jpeg', { filename: 'real.jpg' }),
      ],
      DEFAULT_SETTINGS,
    );

    expect(result.excluded.map((e) => e.exclusionReason)).toEqual([
      'sticker',
      'inline_related',
      'inline_related',
      'duplicate_photo',
      'non_image_mime',
      'non_image_mime',
    ]);
    // Exclusions consume no slot: the surviving photo sits in slot 0.
    expect(result.images).toHaveLength(1);
    const only = selected(result.images[0]);
    expect(only.sourcePosition).toBe(6);
    expect(only.slot).toBe(0);
    expect(only.requiresFetch).toBe(true);
  });

  it('never downloads excluded, overflow, or downstream-unreachable candidates', () => {
    const result = selectImages(
      [
        photo('image/webp', { sticker: true }),
        document('application/pdf'),
        photo('image/jpeg', { duplicatePhotoRepresentation: true }),
        photo('image/heic'), // selected slot, but downstream-unreachable MIME
        document(undefined),
        photo('image/png', { declaredSize: DEFAULT_SETTINGS.maxInputBytes + 1 }), // downstream-unreachable size
        photo('image/jpeg', { filename: 'ok-0.jpg' }),
        photo('image/png', { filename: 'ok-1.png' }),
        photo('image/webp', { filename: 'ok-2.webp' }),
        photo('image/jpeg', { filename: 'overflow-1.jpg' }),
        photo('image/png', { filename: 'overflow-2.png' }),
      ],
      DEFAULT_SETTINGS,
    );

    const fetches = simulateDownloads(result);
    expect(fetches).toEqual([6, 7, 8]);
  });
});

describe('selectImages — MIME normalization is applied to the stored value', () => {
  it('selects case-insensitively and strips parameters from the recorded MIME', () => {
    const result = selectImages(
      [photo('IMAGE/JPEG ; charset=binary', { filename: 'a.jpg' })],
      DEFAULT_SETTINGS,
    );
    expect(result.images[0].disposition).toBe('selected');
    expect(result.images[0].mimeType).toBe('image/jpeg');
  });

  it('rejects unsupported image MIME only after the slot is assigned', () => {
    const result = selectImages(
      [
        photo('image/heic'), // slot 0, unsupported_mime
        photo('image/jpeg', { filename: 'next.jpg' }),
      ],
      DEFAULT_SETTINGS,
    );
    const [first, second] = result.images;
    expect(first).toMatchObject({
      disposition: 'rejected',
      slot: 0,
      rejectionReason: 'unsupported_mime',
    });
    // No backfill: the supported image takes the NEXT slot, not slot 0.
    expect(second).toMatchObject({ disposition: 'selected', slot: 1, sourcePosition: 1 });
  });
});

describe('selectImages — source-order slots, overflow, and no backfill', () => {
  it('assigns slots in source order and rejects overflow with count_limit', () => {
    const result = selectImages(
      [0, 1, 2, 3, 4, 5, 6].map((i) => photo('image/jpeg', { filename: `img-${i}.jpg` })),
      { maxInputBytes: DEFAULT_SETTINGS.maxInputBytes, maxPerMessage: 3 },
    );

    expect(result.images.map((e) => e.slot)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      result.images.map((e) => (e.disposition === 'selected' ? 'selected' : e.rejectionReason)),
    ).toEqual([
      'selected',
      'selected',
      'selected',
      'count_limit',
      'count_limit',
      'count_limit',
      'count_limit',
    ]);
    // Every overflow item keeps a unique ordinal, and none is fetched.
    expect(simulateDownloads(result)).toEqual([0, 1, 2]);
  });

  it('a size-rejected candidate keeps its slot — no backfill', () => {
    const result = selectImages(
      [
        photo('image/jpeg', { declaredSize: DEFAULT_SETTINGS.maxInputBytes + 1 }), // slot 0, size_limit
        photo('image/png', { filename: 'small.png' }),
      ],
      DEFAULT_SETTINGS,
    );
    expect(result.images[0]).toMatchObject({
      disposition: 'rejected',
      slot: 0,
      rejectionReason: 'size_limit',
    });
    expect(result.images[1]).toMatchObject({ disposition: 'selected', slot: 1 });
  });
});

describe('selectImages — size checks run after slot assignment', () => {
  it('uses the declared size for fetch-bound items', () => {
    const limit = 100_000;
    const result = selectImages(
      [
        photo('image/png', { declaredSize: limit + 1 }),
        document('image/png', { declaredSize: 10, filename: 'doc.png' }),
      ],
      { maxInputBytes: limit, maxPerMessage: 5 },
    );
    expect(result.images[0]).toMatchObject({
      disposition: 'rejected',
      rejectionReason: 'size_limit',
    });
    expect(result.images[1]).toMatchObject({
      disposition: 'selected',
      slot: 1,
      requiresFetch: true,
    });
  });

  it('keeps photos with no declared size (actual bytes are checked by the transport)', () => {
    const result = selectImages([photo('image/jpeg')], DEFAULT_SETTINGS);
    expect(result.images[0].disposition).toBe('selected');
  });

  it('treats NaN or negative declared sizes as absent (never a size_limit source)', () => {
    const result = selectImages(
      [photo('image/jpeg', { declaredSize: NaN }), photo('image/png', { declaredSize: -1 })],
      DEFAULT_SETTINGS,
    );
    for (const entry of result.images) {
      expect(entry.disposition).toBe('selected');
      expect('declaredSize' in entry ? entry.declaredSize : undefined).toBeUndefined();
    }
  });

  it('honors a large but finite declared size as size_limit (post-slot)', () => {
    const result = selectImages(
      [photo('image/jpeg', { declaredSize: Number.MAX_SAFE_INTEGER })],
      DEFAULT_SETTINGS,
    );
    expect(result.images[0]).toMatchObject({
      disposition: 'rejected',
      rejectionReason: 'size_limit',
    });
  });
});

describe('selectImages — legacy payloads', () => {
  it('selects in-hand Buffer payloads without a fetch', () => {
    const bytes = Buffer.from('legacy-png-bytes');
    const result = selectImages(
      [document('image/png', { payload: bytes, filename: 'mail-att.png' })],
      DEFAULT_SETTINGS,
    );
    const entry = selected(result.images[0]);
    expect(entry.requiresFetch).toBe(false);
    expect(entry.measuredSize).toBe(bytes.length);
    expect(entry.payload).toBe(bytes);
  });

  it('selects in-hand path payloads without a fetch', () => {
    const result = selectImages(
      [
        document('image/jpeg', {
          payload: '/tmp/mail/attachment-1.jpg',
          filename: 'attachment-1.jpg',
        }),
      ],
      DEFAULT_SETTINGS,
    );
    const entry = selected(result.images[0]);
    expect(entry.requiresFetch).toBe(false);
  });

  it('rejects an oversized email buffer before it can be staged, even when the declared size lies', () => {
    const limit = 16;
    const oversize = Buffer.alloc(limit + 8, 1);
    const result = selectImages(
      [
        document('image/png', { payload: oversize, declaredSize: 4, filename: 'lying.png' }),
        photo('image/jpeg', { filename: 'after.jpg' }),
      ],
      { maxInputBytes: limit, maxPerMessage: 5 },
    );

    const rejected = result.images[0];
    expect(rejected).toMatchObject({
      disposition: 'rejected',
      slot: 0,
      rejectionReason: 'size_limit',
    });
    // Nothing is carried out of the rejection: no bytes, no payload, no path.
    const serialized = JSON.stringify(result.images[0]);
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('bytes');
    expect(rejected).not.toHaveProperty('payload');
    // The slot stays consumed.
    expect(result.images[1]).toMatchObject({ disposition: 'selected', slot: 1 });
  });

  it('selects an in-hand buffer exactly at the limit', () => {
    const limit = 16;
    const result = selectImages([document('image/png', { payload: Buffer.alloc(limit, 1) })], {
      maxInputBytes: limit,
      maxPerMessage: 5,
    });
    expect(result.images[0]).toMatchObject({ disposition: 'selected', measuredSize: limit });
  });
});

describe('selectImages — origin semantics', () => {
  it('treats document MIME as authoritative for the supported-MIME check', () => {
    const result = selectImages(
      [document('image/heic', { filename: 'photo.heic' })],
      DEFAULT_SETTINGS,
    );
    expect(result.images[0]).toMatchObject({
      disposition: 'rejected',
      rejectionReason: 'unsupported_mime',
    });
  });

  it('never invents a MIME for an absent photo MIME', () => {
    const result = selectImages(
      [photo(undefined, { filename: 'photo-no-mime.jpg' })],
      DEFAULT_SETTINGS,
    );
    const entry = result.images[0];
    expect(entry.disposition).toBe('selected');
    expect('mimeType' in entry ? entry.mimeType : undefined).toBeUndefined();
  });
});

describe('selectImages — metadata hygiene', () => {
  it('sanitizes filenames into the durable metadata', () => {
    const result = selectImages(
      [photo('image/jpeg', { filename: '../../evil\x00/x.png' })],
      DEFAULT_SETTINGS,
    );
    expect(result.images[0].filename).toBe('.._.._evil__x.png');
  });

  it('never carries malformed URL-bearing MIME into eligibility or output', () => {
    const result = selectImages(
      [
        // Malformed MIME is treated as ABSENT: the photo stays eligible but
        // carries no MIME in the durable entry.
        photo('image/jpeg https://x.test/p?token=MIMECANARY', { filename: 'a.jpg' }),
        // A non-image document with a malformed MIME is excluded pre-slot.
        document('image/png\tAuthorization: Basic DOCBASIC', { filename: 'b.png' }),
      ],
      DEFAULT_SETTINGS,
    );
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]).toMatchObject({
      sourcePosition: 1,
      exclusionReason: 'non_image_mime',
    });
    const entry = result.images[0];
    expect(entry.disposition).toBe('selected');
    expect('mimeType' in entry ? entry.mimeType : undefined).toBeUndefined();
    const durable = JSON.stringify(result);
    expect(durable).not.toContain('MIMECANARY');
    expect(durable).not.toContain('DOCBASIC');
    expect(durable).not.toContain('x.test');
  });

  it('emits entries in source order with stable sourcePosition values', () => {
    const result = selectImages(
      [
        photo('image/webp', { sticker: true }),
        photo('image/png'),
        document('application/pdf'),
        photo('image/jpeg'),
      ],
      DEFAULT_SETTINGS,
    );
    expect(result.excluded.map((e) => e.sourcePosition)).toEqual([0, 2]);
    expect(result.images.map((e) => e.sourcePosition)).toEqual([1, 3]);
    expect(result.images.map((e) => e.slot)).toEqual([0, 1]);
  });

  it('supports per-persona override settings', () => {
    const result = selectImages([photo('image/jpeg'), photo('image/png')], {
      maxInputBytes: 1024,
      maxPerMessage: 1,
    });
    expect(result.images[0].disposition).toBe('selected');
    expect(result.images[1]).toMatchObject({
      disposition: 'rejected',
      rejectionReason: 'count_limit',
    });
  });

  it('vendor MIME with curly braces is a real image MIME: it consumes its slot as unsupported_mime', () => {
    const result = selectImages([photo('image/x{vendor}'), photo('image/jpeg')], {
      maxInputBytes: 1024,
      maxPerMessage: 1,
    });
    // NOT silently excluded pre-slot: the vendor MIME occupies slot 0 and is
    // rejected post-slot, so with one slot the valid photo is count_limit.
    expect(result.excluded).toHaveLength(0);
    expect(result.images[0]).toMatchObject({
      sourcePosition: 0,
      disposition: 'rejected',
      slot: 0,
      rejectionReason: 'unsupported_mime',
    });
    expect(result.images[1]).toMatchObject({
      sourcePosition: 1,
      disposition: 'rejected',
      slot: 1,
      rejectionReason: 'count_limit',
    });
    expect(result.images[0].mimeType).toBe('image/x{vendor}');
  });
});

describe('selectImages — result typing', () => {
  it('selected entries expose origin and rejection entries never carry payload', () => {
    const result: ImageSelectionResult = selectImages(
      [document('image/png', { payload: Buffer.from('x') }), photo('image/heic')],
      DEFAULT_SETTINGS,
    );
    const entries: ImageSelectionEntry[] = result.images;
    expect(entries[0].disposition).toBe('selected');
    if (entries[0].disposition === 'selected') {
      const origins: MediaOrigin[] = [entries[0].origin];
      expect(origins[0]).toBe('document');
    }
    expect(entries[1]).not.toHaveProperty('payload');
  });
});
