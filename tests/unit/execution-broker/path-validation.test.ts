import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionBrokerError } from '../../../src/execution-broker/errors.js';
import { resolveWorkspaceCwd } from '../../../src/execution-broker/path-validation.js';
import type { WorkspaceConfig } from '../../../src/execution-broker/types.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function workspace(hostPath: string): WorkspaceConfig {
  return { id: 'epic-wiki', hostPath, mountTarget: '/epic-wiki', mode: 'ro' };
}

function expectBrokerError(error: unknown, brokerCode: string, forbidden: string[] = []): void {
  expect(error).toBeInstanceOf(ExecutionBrokerError);
  const brokerError = error as ExecutionBrokerError;
  expect(brokerError.brokerCode).toBe(brokerCode);
  for (const value of forbidden) {
    expect(brokerError.message).not.toContain(value);
  }
}

describe('resolveWorkspaceCwd', () => {
  it.each([
    ['', '/epic-wiki'],
    ['.', '/epic-wiki'],
    ['pages', '/epic-wiki/pages'],
    ['pages/../pages/new', '/epic-wiki/pages/new'],
  ])('maps %j to container path %s', (cwd, expected) => {
    const root = tempDir('broker-cwd-');
    mkdirSync(join(root, 'pages'));
    const result = resolveWorkspaceCwd(cwd, workspace(root));
    expect(result._unsafeUnwrap()).toBe(expected);
  });

  it.each(['../x', 'a/../../x', '/etc', '/epic-wiki', '/epic-wiki/pages'])(
    'rejects %j with CWD_OUTSIDE_WORKSPACE',
    (cwd) => {
      const root = tempDir('broker-cwd-');
      const result = resolveWorkspaceCwd(cwd, workspace(root));
      expectBrokerError(result._unsafeUnwrapErr(), 'CWD_OUTSIDE_WORKSPACE', [root]);
    },
  );

  it('rejects a symlink inside the workspace that resolves outside it with SYMLINK_ESCAPE', () => {
    const root = tempDir('broker-cwd-');
    const outside = tempDir('broker-outside-');
    symlinkSync(outside, join(root, 'escape'));
    const result = resolveWorkspaceCwd('escape/sub', workspace(root));
    expectBrokerError(result._unsafeUnwrapErr(), 'SYMLINK_ESCAPE', [outside, root]);
  });

  it('accepts a symlink that stays inside the workspace and maps its resolved target', () => {
    const root = tempDir('broker-cwd-');
    mkdirSync(join(root, 'real', 'deep'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    const result = resolveWorkspaceCwd('alias/deep', workspace(root));
    expect(result._unsafeUnwrap()).toBe('/epic-wiki/real/deep');
  });

  it('works when the workspace host path itself is reached through a symlink', () => {
    const real = tempDir('broker-real-');
    const linkParent = tempDir('broker-link-');
    mkdirSync(join(real, 'pages'));
    symlinkSync(real, join(linkParent, 'ws'));
    const result = resolveWorkspaceCwd('pages', workspace(join(linkParent, 'ws')));
    expect(result._unsafeUnwrap()).toBe('/epic-wiki/pages');
  });
});
