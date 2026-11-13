/**
 * Size limits on normalization: the decoded-pixel ceiling
 * (decompression-bomb guard) and the Normalized-file byte limit with its
 * quality-then-edge ladder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { normalizeImage } from '../../../src/images/image-normalizer.js';

let workDir: string;
let tempPath: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-normalize-limits-'));
  tempPath = path.join(workDir, 'out.jpg');
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Random noise barely compresses, so its JPEG is reliably large. */
function noisePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
}

describe('decoded-pixel limit', () => {
  it('rejects a source over maxInputPixels as too_large before writing anything', async () => {
    const source = await solidPng(2000, 1000); // 2 MP, tiny file
    const result = await normalizeImage(source, {
      maxEdge: 4096,
      jpegQuality: 85,
      maxInputPixels: 1_000_000,
      tempFilePath: tempPath,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('too_large');
      expect(result.error.retryable).toBe(false);
    }
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('accepts a source exactly at the limit', async () => {
    const source = await solidPng(1000, 1000);
    const result = await normalizeImage(source, {
      maxEdge: 4096,
      jpegQuality: 85,
      maxInputPixels: 1_000_000,
      tempFilePath: tempPath,
    });
    expect(result.isOk()).toBe(true);
  });

  it('rejects an invalid maxInputPixels as invalid_options', async () => {
    const source = await solidPng(10, 10);
    const result = await normalizeImage(source, {
      maxEdge: 4096,
      jpegQuality: 85,
      maxInputPixels: 0,
      tempFilePath: tempPath,
    });
    expect(result.isErr() && result.error.code).toBe('invalid_options');
  });
});

describe('Normalized-file byte limit', () => {
  it('leaves output untouched when it already fits', async () => {
    const source = await solidPng(800, 600);
    const result = await normalizeImage(source, {
      maxEdge: 4096,
      jpegQuality: 85,
      maxOutputBytes: 3_750_000,
      tempFilePath: tempPath,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.dimensions).toEqual({ width: 800, height: 600 });
    }
  });

  it('steps quality and then the edge down until the JPEG fits', async () => {
    const source = await noisePng(1600, 1200);
    const unbounded = await normalizeImage(source, {
      maxEdge: 4096,
      jpegQuality: 85,
      tempFilePath: path.join(workDir, 'unbounded.jpg'),
    });
    expect(unbounded.isOk()).toBe(true);
    const unboundedBytes = fs.statSync(path.join(workDir, 'unbounded.jpg')).size;

    // Far below what quality steps alone can reach, so the edge must shrink.
    const limit = Math.floor(unboundedBytes / 6);
    const result = await normalizeImage(source, {
      maxEdge: 4096,
      jpegQuality: 85,
      maxOutputBytes: limit,
      tempFilePath: tempPath,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(fs.statSync(tempPath).size).toBeLessThanOrEqual(limit);
      expect(result.value.dimensions.width).toBeLessThan(1600);
      // Aspect ratio survives the ladder.
      expect(result.value.dimensions.width / result.value.dimensions.height).toBeCloseTo(4 / 3, 1);
      expect(result.value.sourceDimensions).toEqual({ width: 1600, height: 1200 });
    }
  });

  it('rejects as too_large when no ladder step fits', async () => {
    const source = await noisePng(1200, 900);
    const result = await normalizeImage(source, {
      maxEdge: 4096,
      jpegQuality: 85,
      maxOutputBytes: 1_000,
      tempFilePath: tempPath,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('too_large');
      expect(result.error.retryable).toBe(false);
    }
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});
