/**
 * Unit tests for content-based MIME detection of outbound attachments.
 */

import { describe, it, expect } from 'vitest';
import { sniffMimeType } from '../../../src/attachments/mime-sniff.js';

describe('sniffMimeType', () => {
  it('types binary formats by magic number, ignoring the extension and declared type', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    expect(sniffMimeType(png, 'report.pdf', 'application/pdf')).toBe('image/png');
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'x.png')).toBe('image/jpeg');
    expect(sniffMimeType(Buffer.from('GIF89a....'), 'x')).toBe('image/gif');
    expect(sniffMimeType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'x')).toBe('image/webp');
    expect(sniffMimeType(Buffer.from('%PDF-1.7\n'), 'x.txt')).toBe('application/pdf');
    expect(sniffMimeType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), 'x.docx')).toBe(
      'application/zip',
    );
  });

  it('treats unrecognised binary as octet-stream, never as what the name claims', () => {
    expect(sniffMimeType(Buffer.from([0x00, 0x13, 0x37]), 'photo.png', 'image/png')).toBe(
      'application/octet-stream',
    );
    expect(sniffMimeType(Buffer.from([0xc3, 0x28]), 'notes.txt')).toBe('application/octet-stream');
  });

  it('picks a text subtype from the extension or a declared text type only for text content', () => {
    expect(sniffMimeType(Buffer.from('a,b\n1,2\n'), 'data.csv')).toBe('text/csv');
    expect(sniffMimeType(Buffer.from('# Title'), 'README.md')).toBe('text/markdown');
    expect(sniffMimeType(Buffer.from('{"a":1}'), 'out.json')).toBe('application/json');
    expect(sniffMimeType(Buffer.from('line\n'), 'build.log')).toBe('text/plain');
    expect(sniffMimeType(Buffer.from('a,b'), 'data', 'text/csv; charset=utf-8')).toBe('text/csv');
    expect(sniffMimeType(Buffer.from('plain'), 'x', 'image/png')).toBe('text/plain');
  });
});
