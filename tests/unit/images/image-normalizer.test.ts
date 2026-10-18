/**
 * Tests for JPEG normalization (`src/images/image-normalizer.ts`).
 *
 * Real committed fixtures prove the approved conversion behavior:
 * - oriented 24x12 sources (EXIF orientation 6) become 12x24 JPEGs with no
 *   EXIF and the requested quality, while their EXIF is still reported from
 *   the source (mirrors the independent normalization probe's 8x16
 *   no-EXIF expectation at fixture scale);
 * - animated fixtures are rejected via real animation information: the
 *   single-frame APNG has no sharp `pages` at all, so only the bounds-checked
 *   acTL chunk walk catches it, and the single-frame animated WebP is caught
 *   by frame information reporting exactly one frame;
 * - corrupt input fails as an immediate conversion failure.
 *
 * Synthetic in-test images (created with sharp at test time, not committed)
 * cover the hemispheres the fixtures do not: mirroring orientation 2,
 * transposing orientation 5, alpha flatten, and unsupported formats.
 *
 * Red/green mutation evidence was captured per behavior (dropping the acTL
 * walk, the pages===1 WebP rule, auto-orientation, or the no-enlargement
 * option each fails a test here; sources restored byte-identical).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { normalizeImage, webpHasAnimation, hasPngAcTL } from '../../../src/images/image-normalizer.js';
import type { Result } from '../../../src/core/types/result.js';

// -- Encoder instrumentation -------------------------------------------------
// A pass-through mock of `sharp` counts terminal `toBuffer()` invocations so
// cancellation tests can assert on REAL pipeline state (encode started /
// encode still pending / encode settled) instead of wall-clock guesses.
const encodeSpy = vi.hoisted(() => {
  class EncodeSpy {
    active = 0;
    private startWaiters: Array<() => void> = [];
    private settleWaiters: Array<() => void> = [];
    private startPromise: Promise<void> | undefined;

    reset(): void {
      this.active = 0;
      this.startWaiters = [];
      this.settleWaiters = [];
      this.startPromise = undefined;
    }

    noteStart(): void {
      this.active += 1;
      const waiters = this.startWaiters;
      this.startWaiters = [];
      for (const resolve of waiters) resolve();
    }

    noteSettle(): void {
      this.active -= 1;
      const waiters = this.settleWaiters;
      this.settleWaiters = [];
      for (const resolve of waiters) resolve();
    }

    /** Resolves once a `toBuffer()` call has started. */
    started(): Promise<void> {
      if (this.active > 0) return Promise.resolve();
      if (this.startPromise === undefined) {
        this.startPromise = new Promise<void>((resolve): void => {
          this.startWaiters.push(resolve);
        });
      }
      return this.startPromise;
    }

    /** Resolves on the NEXT `toBuffer()` settlement (observed completion). */
    settled(): Promise<void> {
      return new Promise<void>((resolve): void => {
        this.settleWaiters.push(resolve);
      });
    }
  }
  return { spy: new EncodeSpy() };
});

vi.mock('sharp', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    default: (...args: unknown[]) => unknown;
  };
  const real = actual.default;
  const wrapped = function (...args: unknown[]): unknown {
    const instance = real(...args) as Record<string, unknown>;
    const originalToBuffer = instance['toBuffer'];
    if (typeof originalToBuffer === 'function') {
      instance['toBuffer'] = async function (this: unknown, ...callArgs: unknown[]): Promise<unknown> {
        encodeSpy.spy.noteStart();
        try {
          return await (originalToBuffer as (...a: unknown[]) => Promise<unknown>).apply(this, callArgs);
        } finally {
          encodeSpy.spy.noteSettle();
        }
      };
    }
    return instance;
  };
  for (const key of Object.getOwnPropertyNames(actual)) {
    if (key !== 'default') {
      (wrapped as unknown as Record<string, unknown>)[key] = actual[key];
    }
  }
  (wrapped as unknown as Record<string, unknown>)['default'] = wrapped;
  return { ...actual, default: wrapped };
});

/** Narrow an Err result for strict-tsc-clean assertions. */
function expectErr<E>(result: Result<unknown, E>): E {
  if (result.isOk()) {
    throw new Error('expected an Err result');
  }
  return result.error;
}


const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../../fixtures/images');

async function fixtureBytes(name: string): Promise<Buffer> {
  return fs.promises.readFile(path.join(FIXTURES, name));
}

let workDir: string;
let tempPath: string;

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-normalize-'));
  tempPath = path.join(workDir, 'out.jpg');
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('orientation and fit (real oriented fixtures, 24x12 sources)', () => {
  it('auto-rotates orientation 6 (24x12 source becomes 12x24) and reports both dimension sets', async () => {
    const source = await fixtureBytes('oriented-24x12.jpg');
    const result = await normalizeImage(source, { tempFilePath: tempPath, maxEdge: 4096, jpegQuality: 85 });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const value = result._unsafeUnwrap();
    expect(value.dimensions).toEqual({ width: 12, height: 24 });
    expect(value.sourceDimensions).toEqual({ width: 24, height: 12 });
    expect(value.filePath).toBe(tempPath);
    expect(fs.statSync(tempPath).size).toBeGreaterThan(0);
  });

  it('keeps EXIF extraction in the result even though the output file has none', async () => {
    const source = await fixtureBytes('oriented-24x12.png');
    const result = await normalizeImage(source, { tempFilePath: tempPath, maxEdge: 4096, jpegQuality: 85 });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const value = result._unsafeUnwrap();
    expect(value.exif?.gps).toEqual({
      latitude: 51.5,
      longitude: -7 / 60,
      altitude: 10,
      altitudeRef: 'aboveSeaLevel',
    });
    expect(value.exif?.capturedAt).toBe('2026:10:14 12:34:56');
    expect(value.exif?.capturedAtOffset).toBe('+02:00');
    expect(value.exif?.orientation).toBe(6);

    // The written JPEG itself must be metadata-free.
    const out = await sharp(tempPath).metadata();
    expect(out.exif).toBeUndefined();
    expect(out.orientation).toBeUndefined();
    expect(out.format).toBe('jpeg');
  });

  it('fits inside the requested max edge without crop', async () => {
    const source = await fixtureBytes('oriented-24x12.jpg');
    const result = await normalizeImage(source, { tempFilePath: tempPath, maxEdge: 8, jpegQuality: 85 });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    // 12x24 portrait scaled to long edge 8 -> 4x8, ratio preserved.
    expect(result._unsafeUnwrap().dimensions).toEqual({ width: 4, height: 8 });
  });

  it('never enlarges small sources', async () => {
    const source = await fixtureBytes('small-4x2.png');
    const result = await normalizeImage(source, { tempFilePath: tempPath, maxEdge: 4096, jpegQuality: 85 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().dimensions).toEqual({ width: 4, height: 2 });
  });

  it('encodes at the requested JPEG quality', async () => {
    // Detail-rich synthetic source so quality actually moves the file size.
    const size = 64;
    const noise = Buffer.alloc(size * size * 3);
    for (let i = 0; i < noise.length; i++) {
      noise[i] = (i * 37 + (i >> 3)) % 256;
    }
    const source = await sharp(noise, { raw: { width: size, height: size, channels: 3 } })
      .png()
      .toBuffer();

    const lowPath = path.join(workDir, 'q10.jpg');
    const highPath = path.join(workDir, 'q95.jpg');
    const low = await normalizeImage(source, { tempFilePath: lowPath, maxEdge: 4096, jpegQuality: 10 });
    const high = await normalizeImage(source, { tempFilePath: highPath, maxEdge: 4096, jpegQuality: 95 });
    expect(low.isOk()).toBe(true);
    expect(high.isOk()).toBe(true);
    const lowSize = fs.statSync(lowPath).size;
    const highSize = fs.statSync(highPath).size;
    expect(highSize).toBeGreaterThan(lowSize * 2);
  });

  it('flattens alpha over white', async () => {
    // 4x2 with fully transparent pixels must come out white, 3-channel JPEG.
    const source = await sharp({
      create: { width: 4, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const result = await normalizeImage(source, { tempFilePath: tempPath, maxEdge: 4096, jpegQuality: 95 });
    expect(result.isOk()).toBe(true);
    const out = await sharp(tempPath).raw().toBuffer();
    expect(out.length).toBe(4 * 2 * 3);
    for (const byte of out) {
      expect(byte).toBeGreaterThanOrEqual(250);
    }
  });
});

describe('mirroring and transposing orientations (synthetic asymmetric sources)', () => {
  /**
   * 8x4 image, coded (unoriented) pixels: left half red, right half blue,
   * plus a black 2x2 marker at the coded top-left corner. The split breaks
   * flop/rotation colour expectations; the marker breaks the remaining
   * positional symmetries, so each EXIF orientation has a unique result.
   */
  async function asymmetricSource(orientation: number): Promise<Buffer> {
    const width = 8;
    const height = 4;
    const pixels: number[][] = [];
    for (let y = 0; y < height; y++) {
      const row: number[] = [];
      for (let x = 0; x < width; x++) {
        const black = x < 2 && y < 2;
        if (black) {
          row.push(0, 0, 0);
        } else if (x < width / 2) {
          row.push(255, 0, 0);
        } else {
          row.push(0, 0, 255);
        }
      }
      pixels.push(row);
    }
    const raw = Buffer.from(pixels.flat());
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .withMetadata({ orientation })
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  async function outRaw(): Promise<{ raw: Buffer; width: number }> {
    const img = sharp(tempPath);
    const meta = await img.metadata();
    return { raw: await img.raw().toBuffer(), width: meta.width ?? 0 };
  }

  function at(raw: Buffer, width: number, x: number, y: number): [number, number, number] {
    const i = (y * width + x) * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  }

  function closeTo(rgb: [number, number, number], target: [number, number, number]): boolean {
    return rgb.every((c, k) => Math.abs(c - target[k]) <= 60);
  }

  const RED: [number, number, number] = [255, 0, 0];
  const BLUE: [number, number, number] = [0, 0, 255];
  const BLACK: [number, number, number] = [0, 0, 0];

  it('applies mirroring for orientation 2 (flop): colours swap, marker moves to the coded top-right', async () => {
    const oriented = await asymmetricSource(2);
    const result = await normalizeImage(oriented, { tempFilePath: tempPath, maxEdge: 4096, jpegQuality: 95 });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result._unsafeUnwrap().dimensions).toEqual({ width: 8, height: 4 });

    const { raw, width } = await outRaw();
    // Flopped display: the coded right half (blue) is now on the left, and
    // the coded top-left marker block lands at the display top-right.
    expect(closeTo(at(raw, width, 0, 2), BLUE)).toBe(true);
    expect(closeTo(at(raw, width, 6, 2), RED)).toBe(true);
    expect(closeTo(at(raw, width, 7, 0), BLACK)).toBe(true);
    expect(closeTo(at(raw, width, 0, 0), BLACK)).toBe(false);
  });

  it('applies transposition for orientation 5 (mirror along the top-left diagonal), not a plain rotation', async () => {
    const oriented = await asymmetricSource(5);
    const result = await normalizeImage(oriented, { tempFilePath: tempPath, maxEdge: 4096, jpegQuality: 95 });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result._unsafeUnwrap().dimensions).toEqual({ width: 4, height: 8 });

    const { raw, width } = await outRaw();
    // EXIF orientation 5 display rule: V(x, y) = S(y, x).
    // V(0,0) = S(0,0) = marker black; V(3,0) = S(0,3) = red; V(0,7) = S(7,0) = blue.
    expect(closeTo(at(raw, width, 0, 0), BLACK)).toBe(true);
    expect(closeTo(at(raw, width, 3, 0), RED)).toBe(true);
    expect(closeTo(at(raw, width, 0, 7), BLUE)).toBe(true);
    // A plain 90-degree rotation (orientation 6 handling) would place the
    // marker at display x=2..3 in the top row instead; prove it is not that.
    expect(closeTo(at(raw, width, 3, 0), BLACK)).toBe(false);
  });
});

describe('animation rejection via real animation information', () => {
  async function expectAnimated(name: string): Promise<void> {
    const source = await fixtureBytes(name);
    const result = await normalizeImage(source, {
      tempFilePath: tempPath,
      maxEdge: 4096,
      jpegQuality: 85,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('animated');
    expect(result.error.retryable).toBe(false);
    expect(fs.existsSync(tempPath)).toBe(false);
  }

  it('rejects the two-frame APNG', () => expectAnimated('animated-apng.png'));
  it('rejects the single-frame APNG (no sharp pages; acTL chunk walk is the detection)', () =>
    expectAnimated('single-frame-apng.png'));
  it('rejects the two-frame animated WebP', () => expectAnimated('animated-webp.webp'));
  it('rejects the single-frame animated WebP (one frame is still animation)', () =>
    expectAnimated('single-frame-animated-webp.webp'));

  it('accepts the static WebP and static PNG counterparts', async () => {
    for (const name of ['oriented-24x12.webp', 'oriented-24x12.png', 'plain-24x12.jpg']) {
      const target = path.join(workDir, `ok-${name}.jpg`);
      const result = await normalizeImage(await fixtureBytes(name), {
        tempFilePath: target,
        maxEdge: 4096,
        jpegQuality: 85,
      });
      expect(result.isOk(), name).toBe(true);
    }
  });
});

describe('hasPngAcTL / webpHasAnimation — detection primitives', () => {
  it('finds acTL only via a bounds-checked walk', async () => {
    expect(hasPngAcTL(await fixtureBytes('single-frame-apng.png'))).toBe(true);
    expect(hasPngAcTL(await fixtureBytes('animated-apng.png'))).toBe(true);
    expect(hasPngAcTL(await fixtureBytes('small-4x2.png'))).toBe(false);
    expect(hasPngAcTL(await fixtureBytes('plain-24x12.jpg'))).toBe(false);
    expect(hasPngAcTL(Buffer.alloc(0))).toBe(false);
    // A bogus huge chunk length must stop the walk, not read out of bounds.
    const png = await fixtureBytes('small-4x2.png');
    const corrupted = Buffer.from(png);
    corrupted.writeUInt32BE(0xfffffff0, 8);
    expect(hasPngAcTL(corrupted)).toBe(false);
  });

  it('treats any sharp frame information on WebP as animation', () => {
    expect(webpHasAnimation({ pages: 1 } as never)).toBe(true);
    expect(webpHasAnimation({ pages: 2, delay: [200, 200] } as never)).toBe(true);
    expect(webpHasAnimation({ delay: [200] } as never)).toBe(true);
    expect(webpHasAnimation({ pages: undefined, delay: undefined } as never)).toBe(false);
    expect(webpHasAnimation({ width: 4 } as never)).toBe(false);
  });
});

describe('decode failures and format confirmation (decoder metadata only)', () => {
  it('corrupt input is an immediate conversion_failed', async () => {
    const result = await normalizeImage(await fixtureBytes('corrupt.jpg'), {
      tempFilePath: tempPath,
      maxEdge: 4096,
      jpegQuality: 85,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('conversion_failed');
    expect(result.error.retryable).toBe(false);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('a decodable TIFF is unsupported_mime (no signature scanner; decoder format)', async () => {
    const tiff = await sharp(await fixtureBytes('plain-24x12.jpg')).tiff().toBuffer();
    const result = await normalizeImage(tiff, {
      tempFilePath: tempPath,
      maxEdge: 4096,
      jpegQuality: 85,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.code).toBe('unsupported_mime');
    expect(result.error.retryable).toBe(false);
  });

  it('non-image bytes fail as conversion_failed through the decoder', async () => {
    const result = await normalizeImage(Buffer.from('just some text, not an image'), {
      tempFilePath: tempPath,
      maxEdge: 4096,
      jpegQuality: 85,
    });
    expect(result.isErr()).toBe(true);
    expect(expectErr(result).code).toBe('conversion_failed');
  });
});

describe('option validation and deadline fencing', () => {
  function base(): { tempFilePath: string; maxEdge: number; jpegQuality: number } {
    return { tempFilePath: tempPath, maxEdge: 4096, jpegQuality: 85 };
  }

  it('rejects invalid options immediately without touching sharp', async () => {
    const source = await fixtureBytes('plain-24x12.jpg');
    const cases: Array<[string, Partial<typeof base>]> = [
      ['maxEdge 0', { maxEdge: 0 }],
      ['maxEdge 1.5', { maxEdge: 1.5 }],
      ['quality 0', { jpegQuality: 0 }],
      ['quality 101', { jpegQuality: 101 }],
      ['timeout 0', { timeoutSeconds: 0 }],
      ['timeout 1.5', { timeoutSeconds: 1.5 }],
      ['empty tempFilePath', { tempFilePath: '' }],
    ];
    for (const [label, patch] of cases) {
      const result = await normalizeImage(source, { ...base(), ...patch });
      expect(result.isErr(), label).toBe(true);
      expect(expectErr(result).code, label).toBe('invalid_options');
      expect(expectErr(result).retryable, label).toBe(false);
    }
  });

  it('an already-aborted signal cancels before any output is written', async () => {
    const source = await fixtureBytes('plain-24x12.jpg');
    const controller = new AbortController();
    controller.abort();
    const result = await normalizeImage(source, { ...base(), signal: controller.signal });
    expect(result.isErr()).toBe(true);
    expect(expectErr(result).code).toBe('cancelled');
    expect(expectErr(result).retryable).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('a signal aborted before the encoder is reached never starts it and writes nothing', async () => {
    const source = await fixtureBytes('plain-24x12.jpg');
    const controller = new AbortController();
    const pending = normalizeImage(source, { ...base(), signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.isErr()).toBe(true);
    expect(expectErr(result).code).toBe('cancelled');
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it(
    'aborts mid-encode: cancellation settles while the native encode is still pending, and nothing survives the observed encode completion',
    { timeout: 30_000 },
    async () => {
      // A 3000x3000 detail-heavy source keeps the JPEG encoder busy for
      // hundreds of milliseconds. The spy proves the encode started and is
      // STILL ACTIVE when the abort lands and when cancellation settles —
      // no wall-clock guesswork — and the late output check runs only after
      // the spy observes the native job actually settling.
      const size = 3000;
      const noise = Buffer.alloc(size * size * 3);
      for (let i = 0; i < noise.length; i++) {
        noise[i] = ((Math.imul(i, 1103515245) + 12345) >>> 16) & 0xff;
      }
      const source = await sharp(noise, { raw: { width: size, height: size, channels: 3 } })
        .png()
        .toBuffer();
      encodeSpy.spy.reset();

      const controller = new AbortController();
      const pending = normalizeImage(source, {
        tempFilePath: tempPath,
        maxEdge: size,
        jpegQuality: 100,
        signal: controller.signal,
      });
      // Deterministic mid-encode abort: wait for the pipeline invocation.
      await encodeSpy.spy.started();
      expect(encodeSpy.spy.active).toBeGreaterThan(0);
      controller.abort();

      const result = await pending;
      // Cancellation settled WHILE the native encode is still pending.
      expect(encodeSpy.spy.active).toBeGreaterThan(0);
      expect(result.isErr()).toBe(true);
      expect(expectErr(result).code).toBe('cancelled');
      expect(expectErr(result).retryable).toBe(true);
      expect(fs.existsSync(tempPath)).toBe(false);

      // Wait for OBSERVED completion of the native job; the late result is
      // never written (and nothing written-then-aborted survives either).
      await encodeSpy.spy.settled();
      expect(encodeSpy.spy.active).toBe(0);
      expect(fs.existsSync(tempPath)).toBe(false);
    },
  );
});

describe('destination I/O failures are operational (retryable io)', () => {
  const sourcePromise = () => fixtureBytes('plain-24x12.jpg');

  it('missing destination directory yields retryable io, not conversion_failed', async () => {
    const result = await normalizeImage(await sourcePromise(), {
      tempFilePath: path.join(workDir, 'no-such-dir', 'out.jpg'),
      maxEdge: 4096,
      jpegQuality: 85,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toMatchObject({ code: 'io', retryable: true });
  });

  it('destination whose parent path is a regular file yields retryable io', async () => {
    const blocker = path.join(workDir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const result = await normalizeImage(await sourcePromise(), {
      tempFilePath: path.join(blocker, 'out.jpg'),
      maxEdge: 4096,
      jpegQuality: 85,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toMatchObject({ code: 'io', retryable: true });
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'read-only destination directory yields retryable io',
    async () => {
      const roDir = path.join(workDir, 'ro');
      fs.mkdirSync(roDir);
      fs.chmodSync(roDir, 0o500);
      try {
        const result = await normalizeImage(await sourcePromise(), {
          tempFilePath: path.join(roDir, 'out.jpg'),
          maxEdge: 4096,
          jpegQuality: 85,
        });
        expect(result.isErr()).toBe(true);
        if (result.isOk()) return;
        expect(result.error).toMatchObject({ code: 'io', retryable: true });
      } finally {
        fs.chmodSync(roDir, 0o700);
      }
    },
  );

  it('destination that fails during write (/dev/full ENOSPC) yields retryable io', async () => {
    // Regression: sharp's toFile() hid post-open write failures behind a
    // plain Error (no code/errno) that looked like a permanent content
    // failure. The write now goes through fs with real errno classification.
    // Symlinking tempFilePath is safe BECAUSE it is an attempt-owned opaque
    // identifier, never a user filename.
    const devFull = '/dev/full';
    if (!fs.existsSync(devFull)) return; // platform guard (non-Linux)
    fs.symlinkSync(devFull, tempPath);
    try {
      const result = await normalizeImage(await sourcePromise(), {
        tempFilePath: tempPath,
        maxEdge: 4096,
        jpegQuality: 85,
      });
      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error).toMatchObject({ code: 'io', retryable: true });
      expect(expectErr(result).message).toContain('ENOSPC');
    } finally {
      // Remove the symlink itself — never follow it into /dev/full.
      fs.rmSync(tempPath, { force: true });
    }
  });

  it(
    'abort during a gated write settles promptly with cancelled, and the released write leaves nothing behind',
    { timeout: 15_000 },
    async () => {
      // The write phase must honor cancellation like every other await:
      // hold fs.promises.writeFile on a gate, abort while it is in flight,
      // and require normalizeImage to settle PROMPTLY (before the write
      // does). Then release the gate and assert that the cleanup attached
      // to the write's observed settlement removed whatever it wrote.
      const source = await fixtureBytes('plain-24x12.jpg');
      const originalWriteFile = fs.promises.writeFile;
      const passthrough = originalWriteFile as unknown as (...a: unknown[]) => Promise<void>;

      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let resolveEntered!: () => void;
      const writeEntered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      let resolveWriteSettled!: () => void;
      const writeSettled = new Promise<void>((resolve) => {
        resolveWriteSettled = resolve;
      });

      const gated = async (
        ...args: Parameters<typeof fs.promises.writeFile>
      ): Promise<void> => {
        resolveEntered();
        await gate;
        try {
          await passthrough(...args);
        } finally {
          resolveWriteSettled();
        }
      };
      (
        fs.promises as { writeFile: typeof fs.promises.writeFile }
      ).writeFile = gated as unknown as typeof fs.promises.writeFile;

      try {
        const controller = new AbortController();
        const pending = normalizeImage(source, {
          tempFilePath: tempPath,
          maxEdge: 4096,
          jpegQuality: 85,
          signal: controller.signal,
        });

        await writeEntered; // the write is in flight, held by the gate
        controller.abort();

        // Prompt settlement: normalizeImage must resolve with cancelled
        // well before the gated write could ever finish (100 ms budget).
        const winner = await Promise.race([
          pending.then(() => 'settled' as const, () => 'settled' as const),
          new Promise<'slow'>((resolve) => {
            setTimeout(() => resolve('slow'), 100);
          }),
        ]);
        expect(winner).toBe('settled');
        const result = await pending;
        expect(expectErr(result).code).toBe('cancelled');
        expect(expectErr(result).retryable).toBe(true);
        expect(fs.existsSync(tempPath)).toBe(false);

        // Release the gate; after the OBSERVED write settlement (plus one
        // macrotask flush for the cleanup handler attached at abort time),
        // nothing may survive.
        releaseGate();
        await writeSettled;
        await new Promise((resolve) => setImmediate(resolve));
        expect(fs.existsSync(tempPath)).toBe(false);
      } finally {
        releaseGate(); // never leak the held write, even on assertion failure
        (
          fs.promises as { writeFile: typeof fs.promises.writeFile }
        ).writeFile = originalWriteFile;
      }
    },
  );

  it('corrupt content still fails immediately as conversion_failed (not io)', async () => {
    const result = await normalizeImage(await fixtureBytes('corrupt.jpg'), {
      tempFilePath: tempPath,
      maxEdge: 4096,
      jpegQuality: 85,
    });
    expect(result.isErr()).toBe(true);
    expect(expectErr(result).code).toBe('conversion_failed');
    expect(expectErr(result).retryable).toBe(false);
  });
});

describe('timeout upper bound matches sharp (1..3600)', () => {
  it('rejects timeoutSeconds above 3600 as invalid_options instead of throwing', async () => {
    const source = await fixtureBytes('plain-24x12.jpg');
    for (const bad of [3601, 86_400]) {
      const result = await normalizeImage(source, {
        tempFilePath: tempPath,
        maxEdge: 4096,
        jpegQuality: 85,
        timeoutSeconds: bad,
      });
      expect(result.isErr(), String(bad)).toBe(true);
      expect(expectErr(result).code, String(bad)).toBe('invalid_options');
      expect(expectErr(result).retryable, String(bad)).toBe(false);
    }
  });

  it('accepts the sharp maximum of 3600 seconds', async () => {
    const source = await fixtureBytes('plain-24x12.jpg');
    const result = await normalizeImage(source, {
      tempFilePath: tempPath,
      maxEdge: 4096,
      jpegQuality: 85,
      timeoutSeconds: 3600,
    });
    expect(result.isOk()).toBe(true);
  });
});

describe('truncated acTL is broken framing, not an animation declaration', () => {
  it('hasPngAcTL refuses acTL without its complete payload+CRC', async () => {
    const apng = await fixtureBytes('single-frame-apng.png');
    // acTL sits at offset 33 with an 8-byte payload; a full chunk needs
    // 4 len + 4 type + 8 payload + 4 CRC = 20 bytes.
    expect(apng.readUInt32BE(33)).toBe(8);
    expect(apng.toString('latin1', 37, 41)).toBe('acTL');
    expect(hasPngAcTL(apng)).toBe(true);
    expect(hasPngAcTL(apng.subarray(0, 33 + 8))).toBe(false); // header only
    expect(hasPngAcTL(apng.subarray(0, 33 + 9))).toBe(false); // 1 payload byte
    expect(hasPngAcTL(apng.subarray(0, 33 + 19))).toBe(false); // missing CRC
  });

  it('normalizing a truncated-acTL PNG does not report animated', async () => {
    const apng = await fixtureBytes('single-frame-apng.png');
    const truncated = apng.subarray(0, 33 + 8);
    const result = await normalizeImage(truncated, {
      tempFilePath: tempPath,
      maxEdge: 4096,
      jpegQuality: 85,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(expectErr(result).code).not.toBe('animated');
    expect(expectErr(result).code).toBe('conversion_failed');
  });
});
