/**
 * Content-based MIME detection for outbound attachments.
 *
 * The type of a file is taken from its bytes, never from its extension or
 * from what the agent declares. Binary formats are recognised by magic
 * numbers; anything else that decodes as UTF-8 without NUL bytes is text, and
 * only then does the extension (or the declared type) choose a text subtype.
 * Unrecognised binary content is `application/octet-stream`.
 */

import { extname } from 'node:path';

const OCTET_STREAM = 'application/octet-stream';
const TEXT_PLAIN = 'text/plain';

/** Raster image types that channels display inline as photos. */
export const INLINE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Text subtypes the extension or declared type may select. */
const TEXT_SUBTYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': TEXT_PLAIN,
  '.log': TEXT_PLAIN,
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
};

const TEXT_SUBTYPES: ReadonlySet<string> = new Set(Object.values(TEXT_SUBTYPES_BY_EXTENSION));

function startsWith(data: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => data[offset + i] === byte);
}

function ascii(data: Buffer, offset: number, text: string): boolean {
  return startsWith(
    data,
    [...text].map((c) => c.charCodeAt(0)),
    offset,
  );
}

/** Recognises a binary format by its magic number, or returns null. */
function sniffBinary(data: Buffer): string | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(data, 0, 'GIF87a') || ascii(data, 0, 'GIF89a')) return 'image/gif';
  if (ascii(data, 0, 'RIFF') && ascii(data, 8, 'WEBP')) return 'image/webp';
  if (ascii(data, 0, '%PDF-')) return 'application/pdf';
  if (startsWith(data, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])) {
    return 'application/zip';
  }
  if (ascii(data, 4, 'ftyp')) {
    // ISO base media: HEIC/AVIF images and MP4/MOV video share the box layout.
    if (ascii(data, 8, 'heic') || ascii(data, 8, 'heix') || ascii(data, 8, 'mif1'))
      return 'image/heic';
    if (ascii(data, 8, 'avif')) return 'image/avif';
    if (ascii(data, 8, 'qt  ')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (startsWith(data, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(data, 0, 'OggS')) return 'audio/ogg';
  if (ascii(data, 0, 'ID3') || startsWith(data, [0xff, 0xfb])) return 'audio/mpeg';
  return null;
}

/** True when the bytes are UTF-8 text without NUL characters. */
function looksLikeText(data: Buffer): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

function normalizeDeclared(mimeType: string | undefined): string | undefined {
  if (typeof mimeType !== 'string') return undefined;
  const base = mimeType.split(';')[0]?.trim().toLowerCase();
  return base === '' ? undefined : base;
}

/**
 * Detects the MIME type of `data`.
 *
 * @param data         - Full file contents.
 * @param filename     - Name used only to pick a text subtype.
 * @param declaredMime - Agent-declared type, used only to pick a text subtype.
 */
export function sniffMimeType(data: Buffer, filename: string, declaredMime?: string): string {
  const binary = sniffBinary(data);
  if (binary !== null) return binary;
  if (!looksLikeText(data)) return OCTET_STREAM;

  const declared = normalizeDeclared(declaredMime);
  if (declared !== undefined && (TEXT_SUBTYPES.has(declared) || declared === TEXT_PLAIN)) {
    return declared;
  }
  return TEXT_SUBTYPES_BY_EXTENSION[extname(filename).toLowerCase()] ?? TEXT_PLAIN;
}

/** Conventional extension for a sniffed MIME type, used for generated filenames. */
export function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'application/pdf':
      return '.pdf';
    case 'text/csv':
      return '.csv';
    case 'text/markdown':
      return '.md';
    case 'application/json':
      return '.json';
    case TEXT_PLAIN:
      return '.txt';
    default:
      return '';
  }
}
