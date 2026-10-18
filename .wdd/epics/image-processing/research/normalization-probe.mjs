import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { crc32 } from 'node:zlib';

const require = createRequire(path.join(
  process.env.TALON_IMAGE_PROBE_MODULE_ROOT ?? process.cwd(), 'package.json',
));
const sharp = require('sharp');
const exifr = require('exifr');
const source = await sharp({
  create: { width: 24, height: 12, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } },
})
  .withMetadata({ orientation: 6 })
  .withExifMerge({
    IFD0: { Make: 'Fixture', Model: 'Camera' },
    IFD2: { DateTimeOriginal: '2026:10:14 12:34:56', OffsetTimeOriginal: '+02:00' },
    IFD3: {
      GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1',
      GPSLongitudeRef: 'W', GPSLongitude: '0/1 7/1 0/1',
      GPSAltitudeRef: '0', GPSAltitude: '10/1',
    },
  })
  .jpeg().toBuffer();
const report = { node: process.version, sharp: sharp.versions.sharp, formats: [] };
for (const format of ['jpeg', 'png', 'webp']) {
  const bytes = format === 'jpeg'
    ? source : await sharp(source).withMetadata().toFormat(format).toBuffer();
  const before = await sharp(bytes).metadata();
  const raw = before.exif;
  const prefix = Buffer.from([69, 120, 105, 102, 0, 0]);
  const tiff = raw.subarray(0, 6).equals(prefix) ? raw.subarray(6) : raw;
  const meta = await exifr.parse(tiff, { translateValues: false, reviveValues: false });
  assert.equal(meta.DateTimeOriginal, '2026:10:14 12:34:56');
  assert.equal(meta.OffsetTimeOriginal, '+02:00');
  assert.equal(meta.latitude, 51.5);
  assert.equal(meta.Orientation, 6);
  const normalized = await sharp(bytes).autoOrient()
    .resize(16, 16, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 85 })
    .timeout({ seconds: 5 }).toBuffer();
  const after = await sharp(normalized).metadata();
  assert.equal(after.format, 'jpeg');
  assert.equal(after.width, 8);
  assert.equal(after.height, 16);
  assert.equal(after.exif, undefined);
  report.formats.push({
    format, exifHeader: raw.subarray(0, 6).toString('hex'),
    orientation: meta.Orientation, captureTime: meta.DateTimeOriginal,
    captureOffset: meta.OffsetTimeOriginal, latitude: meta.latitude, longitude: meta.longitude,
    normalized: { width: after.width, height: after.height, exifPresent: !!after.exif },
  });
}
const png = await sharp({
  create: { width: 2, height: 2, channels: 4, background: '#ffffff' },
}).png().toBuffer();
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const ac = Buffer.alloc(8);
ac.writeUInt32BE(1);
const fc = Buffer.alloc(26);
fc.writeUInt32BE(2, 4);
fc.writeUInt32BE(2, 8);
fc.writeUInt16BE(1, 20);
fc.writeUInt16BE(10, 22);
const apng = Buffer.concat([
  png.subarray(0, 33), chunk('acTL', ac), chunk('fcTL', fc), png.subarray(33),
]);
const apngMeta = await sharp(apng).metadata();
await sharp(apng).jpeg().toBuffer();
report.singleFrameApng = {
  pages: apngMeta.pages ?? null, acTL: true, firstFrameConvertible: true,
};
console.log(JSON.stringify(report, null, 2));
