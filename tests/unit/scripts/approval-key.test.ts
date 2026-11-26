import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApprovalKey } from '../../../src/scripts/approval-key.js';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-key-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadApprovalKey', () => {
  it('creates a 32 byte key file with mode 0600 and reuses it', () => {
    const dir = tmp();
    const first = loadApprovalKey(join(dir, 'talond.db'))._unsafeUnwrap();
    expect(first).toHaveLength(32);
    expect(statSync(join(dir, 'script-approval.key')).mode & 0o777).toBe(0o600);
    const second = loadApprovalKey(join(dir, 'talond.db'))._unsafeUnwrap();
    expect(second.equals(first)).toBe(true);
  });

  it('fails for a key file of the wrong size, without leaking it', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'script-approval.key'), 'short-secret');
    const error = loadApprovalKey(join(dir, 'talond.db'))._unsafeUnwrapErr();
    expect(error.message).toContain('the approval key could not be read');
    expect(error.message).not.toContain('short-secret');
  });

  it('fails when the key file is not a regular file', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'script-approval.key'));
    expect(loadApprovalKey(join(dir, 'talond.db')).isErr()).toBe(true);
  });

  it('fails when the directory cannot be written', () => {
    expect(loadApprovalKey(join(tmp(), 'missing', 'talond.db')).isErr()).toBe(true);
  });

  it('uses a random in-process key and no file for an in-memory database', () => {
    const a = loadApprovalKey(':memory:')._unsafeUnwrap();
    const b = loadApprovalKey('')._unsafeUnwrap();
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});
