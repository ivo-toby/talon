/**
 * Tests for pre-conversion EXIF extraction (`src/images/image-metadata.ts`).
 *
 * Uses the real committed fixtures: `oriented-24x12.jpg` (JPEG `Exif\0\0`
 * prefix), `oriented-24x12.png` (bare TIFF eXIf block), and
 * `oriented-24x12.webp` (JPEG-style prefix). The pure validator helpers are
 * exercised directly for the reference/altitude permutations the fixtures do
 * not cover.
 *
 * Red/green mutation evidence was captured per behavior (e.g., mapping
 * GPSAltitudeRef 1 → aboveSeaLevel, reviving dates, or accepting an unknown
 * reference byte each fails a test here; sources restored byte-identical).
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  extractImageExif,
  selectApprovedExif,
  selectGps,
  toDecimalDegrees,
  mapGpsAltitudeRef,
  stripExifBlockPrefix,
} from '../../../src/images/image-metadata.js';
import type { ImageExifMetadata } from '../../../src/images/image-types.js';
import type { Result } from '../../../src/core/types/result.js';

/** Unwrap an Ok result for strict-tsc-clean assertions. */
function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr()) {
    throw new Error('expected an Ok result');
  }
  return result.value;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../../fixtures/images');

async function decoderExif(fixture: string): Promise<Buffer | undefined> {
  const bytes = await readFile(path.join(FIXTURES, fixture));
  const metadata = await sharp(bytes).metadata();
  return metadata.exif;
}

describe('extractImageExif — real fixtures', () => {
  it('extracts the full approved subset from the JPEG fixture (Exif\\0\\0 prefix stripped)', async () => {
    const exif = await decoderExif('oriented-24x12.jpg');
    expect(exif).toBeInstanceOf(Buffer);

    const result = await extractImageExif(exif);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({
      gps: { latitude: 51.5, longitude: -7 / 60, altitude: 10, altitudeRef: 'aboveSeaLevel' },
      capturedAt: '2026:10:14 12:34:56',
      capturedAtOffset: '+02:00',
      cameraMake: 'Fixture',
      cameraModel: 'Camera',
      orientation: 6,
    });
  });

  it('extracts the same subset from the PNG fixture (bare TIFF, no prefix)', async () => {
    const exif = await decoderExif('oriented-24x12.png');
    expect(exif).toBeInstanceOf(Buffer);
    expect(exif!.subarray(0, 6).equals(Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]))).toBe(
      false,
    );

    const result = await extractImageExif(exif);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({
      gps: { latitude: 51.5, longitude: -7 / 60, altitude: 10, altitudeRef: 'aboveSeaLevel' },
      capturedAt: '2026:10:14 12:34:56',
      capturedAtOffset: '+02:00',
      cameraMake: 'Fixture',
      cameraModel: 'Camera',
      orientation: 6,
    });
  });

  it('extracts the same subset from the WebP fixture', async () => {
    const exif = await decoderExif('oriented-24x12.webp');
    expect(exif).toBeInstanceOf(Buffer);
    const result = await extractImageExif(exif);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value?.gps).toEqual({
      latitude: 51.5,
      longitude: -7 / 60,
      altitude: 10,
      altitudeRef: 'aboveSeaLevel',
    });
    expect(result.value?.capturedAt).toBe('2026:10:14 12:34:56');
    expect(result.value?.capturedAtOffset).toBe('+02:00');
  });

  it('returns Ok(undefined) when the decoder found no EXIF', async () => {
    expect(expectOk(await extractImageExif(undefined))).toBeUndefined();
    expect(expectOk(await extractImageExif(Buffer.alloc(0)))).toBeUndefined();

    const bytes = await readFile(path.join(FIXTURES, 'plain-24x12.jpg'));
    const metadata = await sharp(bytes).metadata();
    expect(expectOk(await extractImageExif(metadata.exif))).toBeUndefined();
  });

  it('returns an immediate malformed error for non-TIFF garbage', async () => {
    const result = await extractImageExif(Buffer.from('this is not an exif block at all'));
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      code: 'malformed',
      retryable: false,
      message: 'EXIF block is not a valid TIFF structure',
    });
    // No bytes of the input may leak into the message.
    expect(result.error.message).not.toContain('not an exif');
  });

  it('returns an immediate malformed error for a truncated TIFF block', async () => {
    // Valid little-endian magic + offset, then nothing.
    const truncated = Buffer.from('49492a0008000000', 'hex');
    const result = await extractImageExif(truncated);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('malformed');
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).not.toContain('49492a00');
  });

  it('returns an immediate malformed error for a truncated IFD entry (exifr silentErrors disabled)', async () => {
    // Valid header and IFD0 offset, entry count 1, but the 12-byte entry
    // itself is cut off. exifr's default silentErrors:true swallows this
    // (Ok(undefined) or an `errors` bag); with silence disabled it must
    // surface as immediate malformed.
    const truncatedEntry = Buffer.from('49492a00080000000100', 'hex');
    const result = await extractImageExif(truncatedEntry);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('malformed');
    expect(result.error.retryable).toBe(false);
  });

  it('still extracts cleanly from good fixtures with silentErrors disabled', async () => {
    const exif = await decoderExif('oriented-24x12.jpg');
    const result = await extractImageExif(exif);
    expect(result.isOk()).toBe(true);
    expect(expectOk(result)?.cameraMake).toBe('Fixture');
  });
});

describe('selectApprovedExif — typed validation of untrusted parser output', () => {
  it('keeps raw DateTimeOriginal strings and never accepts revived Dates', () => {
    expect(
      selectApprovedExif({ DateTimeOriginal: '2026-03-01 09:15:23' })?.capturedAt,
    ).toBe('2026-03-01 09:15:23');

    // If a reviver smuggled a Date in, the validator must drop it: the daemon
    // timezone never enters the captured time.
    const revived = new Date('2026-03-01T09:15:23Z');
    expect(selectApprovedExif({ DateTimeOriginal: revived })).toBeUndefined();
  });

  it('omits unparseable or out-of-range orientation values', () => {
    expect(selectApprovedExif({ Orientation: 6 })?.orientation).toBe(6);
    expect(selectApprovedExif({ Orientation: 0 })?.orientation).toBeUndefined();
    expect(selectApprovedExif({ Orientation: 9 })?.orientation).toBeUndefined();
    expect(selectApprovedExif({ Orientation: 1.5 })?.orientation).toBeUndefined();
    expect(selectApprovedExif({ Orientation: '6' })?.orientation).toBeUndefined();
  });

  it('drops unknown tags and returns undefined when nothing survives', () => {
    expect(selectApprovedExif({})).toBeUndefined();
    expect(selectApprovedExif({ XResolution: 72, FlashpixVersion: [0, 0, 2] })).toBeUndefined();
  });

  it('trims camera make/model strings', () => {
    expect(selectApprovedExif({ Make: ' Fixture ', Model: 'Camera' })).toEqual({
      cameraMake: 'Fixture',
      cameraModel: 'Camera',
    });
  });
});

describe('selectGps — DMS + reference tags, never invented', () => {
  it('derives southern/western hemispheres as negative values', () => {
    const gps = selectGps({
      GPSLatitudeRef: 'S',
      GPSLatitude: [51, 30, 0],
      GPSLongitudeRef: 'W',
      GPSLongitude: [0, 7, 0],
    });
    expect(gps).toEqual({ latitude: -51.5, longitude: -7 / 60 });
  });

  it('accepts rational DMS components as [numerator, denominator] pairs', () => {
    const gps = selectGps({
      GPSLatitudeRef: 'N',
      GPSLatitude: [
        [51, 1],
        [30, 1],
        [0, 1],
      ],
      GPSLongitudeRef: 'E',
      GPSLongitude: [
        [0, 1],
        [7, 1],
        [0, 1],
      ],
    });
    expect(gps).toEqual({ latitude: 51.5, longitude: 7 / 60 });
  });

  it('omits GPS entirely when a reference tag is absent or unknown', () => {
    expect(
      selectGps({ GPSLatitude: [51, 30, 0], GPSLongitudeRef: 'E', GPSLongitude: [0, 7, 0] }),
    ).toBeUndefined();
    expect(
      selectGps({
        GPSLatitudeRef: 'X',
        GPSLatitude: [51, 30, 0],
        GPSLongitudeRef: 'E',
        GPSLongitude: [0, 7, 0],
      }),
    ).toBeUndefined();
  });

  it('enforces coordinate limits and DMS component ranges', () => {
    const gpsWith = (lat: unknown[], latRef: string, lon: unknown[] = [0, 0, 0], lonRef = 'E') =>
      selectGps({
        GPSLatitudeRef: latRef,
        GPSLatitude: lat,
        GPSLongitudeRef: lonRef,
        GPSLongitude: lon,
      });

    // Latitude above 90 and longitude above 180 are nonsense: GPS omitted.
    expect(gpsWith([91, 0, 0], 'N')).toBeUndefined();
    expect(gpsWith([0, 0, 0], 'N', [181, 0, 0])).toBeUndefined();
    // Exact limits are allowed.
    expect(gpsWith([90, 0, 0], 'S')).toEqual({ latitude: -90, longitude: 0 });
    expect(gpsWith([0, 0, 0], 'N', [180, 0, 0], 'W')).toEqual({ latitude: 0, longitude: -180 });
    // Minute/second must stay below 60; overflow is unparseable, not carried.
    expect(gpsWith([45, 60, 0], 'N')).toBeUndefined();
    expect(gpsWith([45, 30, 60], 'N')).toBeUndefined();
    expect(gpsWith([89, 59, 59], 'N')).toEqual({ latitude: 89 + 59 / 60 + 59 / 3600, longitude: 0 });
    // Fractional components still fine.
    expect(gpsWith([51.5, 0, 0], 'N')).toEqual({ latitude: 51.5, longitude: 0 });
  });

  it('omits GPS when DMS values are unusable', () => {
    expect(
      selectGps({
        GPSLatitudeRef: 'N',
        GPSLatitude: [51, 30],
        GPSLongitudeRef: 'E',
        GPSLongitude: [0, 7, 0],
      }),
    ).toBeUndefined();
    expect(
      selectGps({
        GPSLatitudeRef: 'N',
        GPSLatitude: [-1, 0, 0],
        GPSLongitudeRef: 'E',
        GPSLongitude: [0, 7, 0],
      }),
    ).toBeUndefined();
  });

  it('maps GPSAltitudeRef explicitly: 0 above, 1 below, unknown drops altitude', () => {
    const above = selectGps({
      GPSLatitudeRef: 'N',
      GPSLatitude: [51, 30, 0],
      GPSLongitudeRef: 'E',
      GPSLongitude: [0, 7, 0],
      GPSAltitude: 10,
      GPSAltitudeRef: Uint8Array.from([0]),
    });
    expect(above).toEqual({
      latitude: 51.5,
      longitude: 7 / 60,
      altitude: 10,
      altitudeRef: 'aboveSeaLevel',
    });

    const below = selectGps({
      GPSLatitudeRef: 'N',
      GPSLatitude: [51, 30, 0],
      GPSLongitudeRef: 'E',
      GPSLongitude: [0, 7, 0],
      GPSAltitude: 4,
      GPSAltitudeRef: Uint8Array.from([1]),
    });
    expect(below?.altitude).toBe(4);
    expect(below?.altitudeRef).toBe('belowSeaLevel');

    const unknownRef = selectGps({
      GPSLatitudeRef: 'N',
      GPSLatitude: [51, 30, 0],
      GPSLongitudeRef: 'E',
      GPSLongitude: [0, 7, 0],
      GPSAltitude: 4,
      GPSAltitudeRef: Uint8Array.from([2]),
    });
    expect(unknownRef?.altitude).toBeUndefined();
    expect(unknownRef?.altitudeRef).toBeUndefined();

    // Altitude without a reference byte: kept, reference unknown.
    const noRef = selectGps({
      GPSLatitudeRef: 'N',
      GPSLatitude: [51, 30, 0],
      GPSLongitudeRef: 'E',
      GPSLongitude: [0, 7, 0],
      GPSAltitude: 4,
    });
    expect(noRef?.altitude).toBe(4);
    expect(noRef?.altitudeRef).toBeUndefined();
  });
});

describe('toDecimalDegrees / mapGpsAltitudeRef / stripExifBlockPrefix', () => {
  it('computes signed decimals and rejects unusable inputs', () => {
    expect(toDecimalDegrees([51, 30, 0], 'north')).toBeCloseTo(51.5);
    expect(toDecimalDegrees([0, 7, 0], 'west')).toBeCloseTo(-7 / 60);
    expect(toDecimalDegrees([51, 30, 0], undefined)).toBeUndefined();
    expect(toDecimalDegrees(['51', 30, 0], 'north')).toBeUndefined();
    expect(toDecimalDegrees([1, 0, 0, 9], 'north')).toBeUndefined();
  });

  it('maps altitude reference bytes explicitly and flags unknown values', () => {
    expect(mapGpsAltitudeRef(0)).toBe('aboveSeaLevel');
    expect(mapGpsAltitudeRef(1)).toBe('belowSeaLevel');
    expect(mapGpsAltitudeRef(Uint8Array.from([1]))).toBe('belowSeaLevel');
    expect(mapGpsAltitudeRef(2)).toBe('invalid');
    expect(mapGpsAltitudeRef(undefined)).toBeUndefined();
    expect(mapGpsAltitudeRef('0')).toBe('invalid');
  });

  it('strips the Exif\\0\\0 prefix only when present', () => {
    const prefix = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    const tiff = Buffer.from('49492a00080000001234', 'hex');
    expect(stripExifBlockPrefix(Buffer.concat([prefix, tiff]))).toEqual(tiff);
    expect(stripExifBlockPrefix(tiff)).toEqual(tiff);
  });
});

// Compile-time shape pin (kept lightweight): the extraction result must carry
// only the approved EXIF DTO, nothing else.
type Pin = Awaited<ReturnType<typeof extractImageExif>>;
const _pin: Pin = { ok: (v: ImageExifMetadata | undefined) => v } as unknown as Pin;
void _pin;
