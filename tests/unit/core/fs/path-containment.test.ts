import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isContained,
  isPathWithinBase,
  ContainmentError,
} from '../../../../src/core/fs/path-containment.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('isPathWithinBase', () => {
  it('returns true when base is the filesystem root', () => {
    expect(isPathWithinBase('/etc', '/')).toBe(true);
    expect(isPathWithinBase('/home/user/file', '/')).toBe(true);
  });

  it('returns true when candidate equals base', () => {
    expect(isPathWithinBase('/home/user', '/home/user')).toBe(true);
  });

  it('returns false when candidate is a sibling with a shared prefix', () => {
    expect(isPathWithinBase('/home/username', '/home/user')).toBe(false);
  });
});

describe('isContained', () => {
  it('returns Ok for a child path inside the base', async () => {
    const base = await makeTempDir('contain-base-');
    const child = join(base, 'sub');
    await mkdir(child);

    const result = await isContained(child, base);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(child);
  });

  it('returns Ok when candidate equals the base path', async () => {
    const base = await makeTempDir('contain-eq-');

    const result = await isContained(base, base);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(base);
  });

  it('returns Err when candidate escapes via ..', async () => {
    const base = await makeTempDir('contain-escape-');
    const child = join(base, 'sub');
    await mkdir(child);
    // candidate resolves to base's parent
    const escapee = join(child, '..', '..');

    const result = await isContained(escapee, base);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ContainmentError);
    expect(error.candidatePath).toBe(escapee);
  });

  it('returns Ok for a symlink whose target is inside the base', async () => {
    const base = await makeTempDir('contain-sym-ok-');
    const target = join(base, 'real');
    await mkdir(target);
    const link = join(base, 'link');
    await symlink(target, link);

    const result = await isContained(link, base);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(target);
  });

  it('returns Err for a symlink whose target escapes the base', async () => {
    const base = await makeTempDir('contain-sym-esc-');
    const outside = await makeTempDir('contain-sym-outside-');
    const link = join(base, 'escape-link');
    await symlink(outside, link);

    const result = await isContained(link, base);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ContainmentError);
    expect(error.resolvedCandidate).toBe(outside);
  });

  it('returns Err for a non-existent candidate path', async () => {
    const base = await makeTempDir('contain-noexist-');
    const missing = join(base, 'does-not-exist');

    const result = await isContained(missing, base);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ContainmentError);
    expect(error.message).toContain('does not exist');
  });

  it('returns Err for a deeply nested file inside the base', async () => {
    const base = await makeTempDir('contain-deep-');
    const deep = join(base, 'a', 'b', 'c');
    await mkdir(deep, { recursive: true });
    const file = join(deep, 'file.txt');
    await writeFile(file, 'content');

    const result = await isContained(file, base);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(file);
  });
});
