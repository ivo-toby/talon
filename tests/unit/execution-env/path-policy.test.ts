import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAllowedHostPath } from '../../../src/execution-env/path-policy.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveAllowedHostPath', () => {
  it('resolves a relative path under the first allowed root', () => {
    const result = resolveAllowedHostPath('artifacts/output.txt', ['/tmp/task-control']);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/tmp/task-control/artifacts/output.txt');
  });

  it('resolves a relative path under a later allowed root when that file exists there', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'path-policy-workspace-'));
    const controlRoot = mkdtempSync(join(tmpdir(), 'path-policy-control-'));
    tempRoots.push(workspaceRoot, controlRoot);

    mkdirSync(join(controlRoot, 'artifacts'));
    writeFileSync(join(controlRoot, 'artifacts', 'output.txt'), 'done');

    const result = resolveAllowedHostPath('artifacts/output.txt', [workspaceRoot, controlRoot]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(join(controlRoot, 'artifacts', 'output.txt'));
  });

  it('falls back to the first allowed root for a missing relative path', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'path-policy-workspace-'));
    const controlRoot = mkdtempSync(join(tmpdir(), 'path-policy-control-'));
    tempRoots.push(workspaceRoot, controlRoot);

    const result = resolveAllowedHostPath('artifacts/new-file.txt', [workspaceRoot, controlRoot]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(join(workspaceRoot, 'artifacts', 'new-file.txt'));
  });

  it('accepts an absolute path inside an allowed root', () => {
    const result = resolveAllowedHostPath(
      '/tmp/task-control/artifacts/output.txt',
      ['/tmp/task-control'],
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/tmp/task-control/artifacts/output.txt');
  });

  it('rejects a path outside the allowed roots', () => {
    const result = resolveAllowedHostPath('/etc/passwd', ['/tmp/task-control']);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('HOST_PATH_NOT_ALLOWED');
  });

  it('rejects when no allowed roots are configured', () => {
    const result = resolveAllowedHostPath('artifact.txt', []);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('HOST_PATH_NOT_ALLOWED');
  });

  it('rejects symlink escapes outside the allowed root', () => {
    const root = mkdtempSync(join(tmpdir(), 'path-policy-'));
    tempRoots.push(root);

    mkdirSync(join(root, 'safe'));
    symlinkSync('/etc', join(root, 'safe', 'escape'));

    const result = resolveAllowedHostPath(join(root, 'safe', 'escape', 'passwd'), [root]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('HOST_PATH_NOT_ALLOWED');
  });

  it('rejects symlink escapes when the final leaf does not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'path-policy-'));
    tempRoots.push(root);

    mkdirSync(join(root, 'safe'));
    symlinkSync('/etc', join(root, 'safe', 'escape'));

    const result = resolveAllowedHostPath(join(root, 'safe', 'escape', 'new-file.txt'), [root]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('HOST_PATH_NOT_ALLOWED');
  });
});
