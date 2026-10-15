// Regenerates the binary Image fixtures in this directory:
//
//   node tests/fixtures/images/generate-fixtures.mjs
//
// Provenance rules for this directory:
// - Every fixture is generated here; nothing was copied from a third party and
//   no fixture carries recognisable real-world content (flat colours only).
// - The animated WebP fixtures are seeded by ImageMagick (`magick` on the PATH)
//   because a hand-written ANMF container is rejected as corrupt by libwebp.
//   The single-frame animated WebP is derived from the committed two-frame file
//   by pure Node chunk surgery, so it regenerates without ImageMagick.
// - Tests read these files and never synthesise them at run time, so a
//   regenerated fixture that changes behaviour surfaces as a test failure.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, '../../../package.json'));
const sharp = require('sharp');

/** 24x12: landscape in coded pixels, portrait once orientation 6 is applied. */
const WIDTH = 24;
const HEIGHT = 12;

function write(name, bytes) {
  fs.writeFileSync(path.join(here, name), bytes);
}

/** Runs ImageMagick, skipping the fixture loudly when it is unavailable. */
function withImageMagick(name, args) {
  try {
    execFileSync('magick', args, { stdio: 'ignore' });
    return true;
  } catch (failure) {
    console.warn(`skipped ${name}: ImageMagick unavailable (${String(failure).slice(0, 80)})`);
    return false;
  }
}

function flat(color, width, height, channels = 3) {
  return sharp({ create: { width, height, channels, background: color } });
}

// ---------------------------------------------------------------------------
// Static sources carrying the approved EXIF subset
// ---------------------------------------------------------------------------

const orientedJpeg = await flat({ r: 255, g: 255, b: 255, alpha: 0.5 }, WIDTH, HEIGHT, 4)
  .withMetadata({ orientation: 6 })
  .withExifMerge({
    IFD0: { Make: 'Fixture', Model: 'Camera' },
    IFD2: { DateTimeOriginal: '2026:10:14 12:34:56', OffsetTimeOriginal: '+02:00' },
    IFD3: {
      GPSLatitudeRef: 'N',
      GPSLatitude: '51/1 30/1 0/1',
      GPSLongitudeRef: 'W',
      GPSLongitude: '0/1 7/1 0/1',
      GPSAltitudeRef: '0',
      GPSAltitude: '10/1',
    },
  })
  .jpeg()
  .toBuffer();

write('oriented-24x12.jpg', orientedJpeg);
write('oriented-24x12.png', await sharp(orientedJpeg).withMetadata().png().toBuffer());
write('oriented-24x12.webp', await sharp(orientedJpeg).withMetadata().webp().toBuffer());

// Same geometry, no metadata at all: absent EXIF must stay unknown.
write('plain-24x12.jpg', await flat('#7f3f9f', WIDTH, HEIGHT).jpeg().toBuffer());
// Small image: fit-inside normalisation must never enlarge it.
write('small-4x2.png', await flat('#204060', 4, 2).png().toBuffer());

// ---------------------------------------------------------------------------
// PNG / APNG
// ---------------------------------------------------------------------------

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const staticPng = await flat('#ffffff', 2, 2, 4).png().toBuffer();

// A structurally valid single-frame APNG: acTL with num_frames = 1 inserted
// directly after IHDR (which ends at byte 33 of a Sharp-written PNG).
const acTL = Buffer.alloc(8);
acTL.writeUInt32BE(1, 0); // num_frames
acTL.writeUInt32BE(0, 4); // num_plays
const fcTL = Buffer.alloc(26);
fcTL.writeUInt32BE(0, 0); // sequence number
fcTL.writeUInt32BE(2, 4); // frame width
fcTL.writeUInt32BE(2, 8); // frame height
fcTL.writeUInt16BE(1, 20); // delay numerator
fcTL.writeUInt16BE(10, 22); // delay denominator
write(
  'single-frame-apng.png',
  Buffer.concat([
    staticPng.subarray(0, 33),
    pngChunk('acTL', acTL),
    pngChunk('fcTL', fcTL),
    staticPng.subarray(33),
  ]),
);

// Multi-frame APNG written by ImageMagick as an independent second case.
{
  const red = path.join(here, '.frame-red.png');
  const blue = path.join(here, '.frame-blue.png');
  write('.frame-red.png', await flat('#ff0000', 2, 2, 4).png().toBuffer());
  write('.frame-blue.png', await flat('#0000ff', 2, 2, 4).png().toBuffer());
  if (
    // The explicit APNG: prefix keeps ImageMagick from writing one file per frame.
    withImageMagick('animated-apng.png', [
      red,
      blue,
      '-loop',
      '0',
      `APNG:${path.join(here, 'animated-apng.png')}`,
    ])
  ) {
    fs.rmSync(red);
    fs.rmSync(blue);
  }
}

// ---------------------------------------------------------------------------
// Animated WebP
// ---------------------------------------------------------------------------

const animatedWebpPath = path.join(here, 'animated-webp.webp');
{
  const red = path.join(here, '.frame-red.png');
  const blue = path.join(here, '.frame-blue.png');
  write('.frame-red.png', await flat('#ff0000', 4, 4).png().toBuffer());
  write('.frame-blue.png', await flat('#0000ff', 4, 4).png().toBuffer());
  if (
    withImageMagick('animated-webp.webp', [
      red,
      blue,
      '-set',
      'delay',
      '20',
      '-loop',
      '0',
      animatedWebpPath,
    ])
  ) {
    fs.rmSync(red);
    fs.rmSync(blue);
  }
}

/** Copies an animated WebP container keeping only its first ANMF frame. */
function firstFrameOnlyAnimatedWebp(bytes) {
  const containers = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length) break;
    containers.push({ type, bytes: bytes.subarray(offset, end) });
    offset = end;
  }
  const frames = containers.filter((entry) => entry.type === 'ANMF');
  if (frames.length === 0) throw new Error('no ANMF chunk in animated WebP fixture');
  const body = [
    Buffer.from('WEBP'),
    ...containers.filter((entry) => entry.type !== 'ANMF').map((entry) => entry.bytes),
    frames[0].bytes,
  ];
  const total = body.reduce((sum, part) => sum + part.length, 0);
  const out = Buffer.alloc(8 + total);
  out.write('RIFF', 0);
  out.writeUInt32LE(total, 4);
  let at = 8;
  for (const part of body) {
    part.copy(out, at);
    at += part.length;
  }
  return out;
}

if (fs.existsSync(animatedWebpPath)) {
  write('single-frame-animated-webp.webp', firstFrameOnlyAnimatedWebp(fs.readFileSync(animatedWebpPath)));
}

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

write('corrupt.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]));

console.log('fixtures regenerated in', here);
