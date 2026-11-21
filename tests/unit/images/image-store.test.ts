/**
 * Tests for owned image file storage (`src/images/image-store.ts`).
 *
 * Covers the two owned locations (durable staging under
 * `image-staging/{deliveryUuid}/` and final Normalized files under
 * `threads/{threadId}/attachments/images/{imageId}.jpg`), the rule that user
 * filenames are metadata and never path segments, bounded byte loading, and
 * the synchronous rename/delete primitives that TASK-005 wraps in its
 * publishing transaction guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImageStore } from '../../../src/images/image-store.js';
import type { Result } from '../../../src/core/types/result.js';

/** Narrow an Err result for strict-tsc-clean assertions. */
function expectErr<E>(result: Result<unknown, E>): E {
  if (result.isOk()) {
    throw new Error('expected an Err result');
  }
  return result.error;
}


let dataDir: string;
let store: ImageStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talon-image-store-'));
  store = new ImageStore(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('path layout', () => {
  it('builds the staging directory and fixed source path under image-staging/{deliveryUuid}', () => {
    const dir = store.stagingDir('deliv-1');
    expect(dir.isOk()).toBe(true);
    expect(dir._unsafeUnwrap()).toBe(path.join(dataDir, 'image-staging', 'deliv-1'));
    expect(store.stagingSourcePath('deliv-1')._unsafeUnwrap()).toBe(
      path.join(dataDir, 'image-staging', 'deliv-1', 'source.bin'),
    );
  });

  it('builds the final Normalized path under threads/{threadId}/attachments/images/{imageId}.jpg', () => {
    expect(store.normalizedPath('thread-9', 'img-42')._unsafeUnwrap()).toBe(
      path.join(dataDir, 'threads', 'thread-9', 'attachments', 'images', 'img-42.jpg'),
    );
    expect(store.threadImagesDir('thread-9')._unsafeUnwrap()).toBe(
      path.join(dataDir, 'threads', 'thread-9', 'attachments', 'images'),
    );
  });
});

describe('identifier validation - user filenames are metadata, never path segments', () => {
  const unsafe = ['', '.', '..', '../evil', 'a/b', 'a\\b', 'evil\0name', 'photos/../../etc'];

  for (const id of unsafe) {
    it(`rejects deliveryUuid ${JSON.stringify(id)} as invalid_id (immediate)`, () => {
      const result = store.stagingDir(id);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('invalid_id');
        expect(result.error.retryable).toBe(false);
      }
    });
  }

  for (const id of ['../evil', 'a/b', '', '.']) {
    it(`rejects image/thread id ${JSON.stringify(id)} in normalizedPath`, () => {
      expect(store.normalizedPath(id, 'img-1').isErr()).toBe(true);
      expect(store.normalizedPath('thread-1', id).isErr()).toBe(true);
    });
  }

  it('names the staging file with a fixed segment regardless of any channel filename', () => {
    // The API takes no filename at all; whatever the channel called the file
    // cannot influence the staging path.
    const filePath = store.stagingSourcePath('deliv-2')._unsafeUnwrap();
    expect(path.basename(filePath)).toBe('source.bin');
    expect(filePath).not.toContain('vacation');
  });
});

describe('byte writing and bounded loading', () => {
  it('writes staging source bytes and reads them back measured', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const written = await store.writeStagingSource('deliv-3', bytes);
    expect(written.isOk()).toBe(true);
    expect(written._unsafeUnwrap()).toEqual({
      path: path.join(dataDir, 'image-staging', 'deliv-3', 'source.bin'),
      size: 5,
    });

    const read = await store.readBounded(written._unsafeUnwrap().path, 10);
    expect(read._unsafeUnwrap().equals(bytes)).toBe(true);
  });

  it('reports not_found (immediate) for a missing file', async () => {
    const read = await store.readBounded(path.join(dataDir, 'nope.bin'), 10);
    expect(read.isErr()).toBe(true);
    expect(expectErr(read).code).toBe('not_found');
    expect(expectErr(read).retryable).toBe(false);
  });

  it('reports too_large before reading an oversized file', async () => {
    const written = await store.writeStagingSource('deliv-4', Buffer.alloc(64, 7));
    const read = await store.readBounded(written._unsafeUnwrap().path, 32);
    expect(read.isErr()).toBe(true);
    expect(expectErr(read).code).toBe('too_large');
    expect(expectErr(read).retryable).toBe(false);
  });

  it('rejects a non-positive byte bound', async () => {
    const read = await store.readBounded(path.join(dataDir, 'x'), 0);
    expect(read.isErr()).toBe(true);
    expect(expectErr(read).code).toBe('invalid_id');
  });

  it('reports not_found when the path is a directory', async () => {
    store.ensureStagingDir('deliv-5');
    const dir = store.stagingDir('deliv-5')._unsafeUnwrap();
    const read = await store.readBounded(dir, 10);
    expect(expectErr(read).code).toBe('not_found');
  });
});

describe('directory helpers', () => {
  it('ensureStagingDir and ensureThreadImagesDir are idempotent', () => {
    expect(store.ensureStagingDir('deliv-6').isOk()).toBe(true);
    expect(store.ensureStagingDir('deliv-6').isOk()).toBe(true);
    expect(fs.statSync(store.stagingDir('deliv-6')._unsafeUnwrap()).isDirectory()).toBe(true);

    expect(store.ensureThreadImagesDir('thread-1').isOk()).toBe(true);
    expect(store.ensureThreadImagesDir('thread-1').isOk()).toBe(true);
    expect(fs.statSync(store.threadImagesDir('thread-1')._unsafeUnwrap()).isDirectory()).toBe(true);
  });

  it('ensures propagate invalid ids instead of creating escape paths', () => {
    expect(store.ensureStagingDir('../escape').isErr()).toBe(true);
    expect(store.ensureThreadImagesDir('..').isErr()).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'escape'))).toBe(false);
  });
});

describe('publish / cleanup primitives', () => {
  it('rename publishes a file synchronously', () => {
    const from = path.join(dataDir, 'attempt.tmp');
    const to = store.normalizedPath('thread-2', 'img-7')._unsafeUnwrap();
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(from, 'pixels');

    expect(store.rename(from, to).isOk()).toBe(true);
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(to, 'utf8')).toBe('pixels');
    expect(store.normalizedExists('thread-2', 'img-7')).toBe(true);
  });

  it('rename of a missing source is not_found (immediate)', () => {
    const result = store.rename(path.join(dataDir, 'missing'), path.join(dataDir, 'target'));
    expect(result.isErr()).toBe(true);
    expect(expectErr(result).code).toBe('not_found');
    expect(expectErr(result).retryable).toBe(false);
  });

  it('removeFile is idempotent', () => {
    const file = path.join(dataDir, 'gone.bin');
    fs.writeFileSync(file, 'x');
    expect(store.removeFile(file).isOk()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.removeFile(file).isOk()).toBe(true);
  });

  it('removeStagingDir deletes the whole delivery tree and tolerates absence', async () => {
    const written = await store.writeStagingSource('deliv-9', Buffer.from('bytes'));
    const dir = store.stagingDir('deliv-9')._unsafeUnwrap();
    expect(fs.existsSync(written._unsafeUnwrap().path)).toBe(true);

    expect(store.removeStagingDir('deliv-9').isOk()).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(store.removeStagingDir('deliv-9').isOk()).toBe(true);
  });

  it('removeStagingDir rejects unsafe delivery ids', () => {
    expect(store.removeStagingDir('a/b').isErr()).toBe(true);
  });

  it('listStagingDeliveries lists only staging directories', () => {
    expect(store.listStagingDeliveries()).toEqual([]);
    store.ensureStagingDir('deliv-a');
    store.ensureStagingDir('deliv-b');
    fs.writeFileSync(path.join(dataDir, 'image-staging', 'loose-file'), 'x');
    expect(store.listStagingDeliveries().sort()).toEqual(['deliv-a', 'deliv-b']);
  });

  it('normalizedExists is false for unknown images and unsafe ids', () => {
    expect(store.normalizedExists('thread-3', 'nope')).toBe(false);
    expect(store.normalizedExists('../thread', 'nope')).toBe(false);
  });
});
