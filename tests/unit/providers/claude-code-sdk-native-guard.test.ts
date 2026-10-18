import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = nodeModule.createRequire(import.meta.url);
const sdkMetadata = realpathSync(require.resolve('@anthropic-ai/claude-agent-sdk'));
const sdkMetadataRoot = dirname(sdkMetadata);
const vitestDist = join(dirname(require.resolve('vitest/package.json')), 'dist');
const helperPath = fileURLToPath(
  new URL('../../fixtures/claude-agent-sdk-native-guard.ts', import.meta.url),
);
const inertBody = "throw new Error('INERT_SDK_SENTINEL_EVALUATED');\n";
const controlBody = "module.exports = 'INERT_UNRELATED_CONTROL_OK';\n";

interface NativeGuard {
  installSdkNativeGuard: () => void;
}

function isNativeGuard(value: unknown): value is NativeGuard {
  return (
    typeof value === 'object' &&
    value !== null &&
    'installSdkNativeGuard' in value &&
    typeof value.installSdkNativeGuard === 'function'
  );
}

async function loadGuardIfPresent(): Promise<NativeGuard | undefined> {
  // Absence skips only the helper import, never the behavioral refusal assertions.
  if (!existsSync(helperPath)) return undefined;
  const guard: unknown = await import(helperPath);
  if (!isNativeGuard(guard)) throw new Error('Native guard installer export is missing');
  return guard;
}

describe('claude-agent-sdk-native-guard', () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'talon-sdk-native-worker-')));
  const registration = vi.spyOn(nodeModule, 'registerHooks');
  let guard: NativeGuard | undefined;

  function checkTarget(request: string, body = inertBody): string {
    const target = realpathSync(fileURLToPath(request));
    expect(target.startsWith(sandbox + sep)).toBe(true);
    expect(target === sdkMetadata || target.startsWith(sdkMetadataRoot + sep)).toBe(false);
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(body);
    return target;
  }

  function fixture(leaf: string, body = inertBody): string {
    const target = join(sandbox, 'node_modules', leaf);
    expect(target.startsWith(sandbox + sep)).toBe(true);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { flag: 'wx' });
    return checkTarget(pathToFileURL(target).href, body);
  }

  beforeAll(async () => {
    guard = await loadGuardIfPresent();
    console.info('INERT native-guard fixtures retained:', sandbox);
  });

  afterAll(() => {
    // Restore instrumentation only. The actual Node hook must outlive this file.
    registration.mockRestore();
  });

  it('refuses native require before a canonical SDK-shaped inert body evaluates', () => {
    const target = fixture('@anthropic-ai/claude-agent-sdk/native.cjs');
    expect(() => {
      require(target);
    }).toThrow('Claude Agent SDK is disabled in unit tests; provide an explicit mock.');
  });

  it('refuses native require with repeated separators and dot segments', () => {
    const target = fixture('@anthropic-ai/claude-agent-sdk/dots.cjs');
    const request = target.replace(
      `${sep}claude-agent-sdk${sep}`,
      `${sep}${sep}.${sep}claude-agent-sdk${sep}`,
    );
    expect(checkTarget(pathToFileURL(request).href)).toBe(target);
    expect(() => {
      require(request);
    }).toThrow('Claude Agent SDK is disabled in unit tests; provide an explicit mock.');
  });

  it.each([
    ['encoded scope', '/@anthropic-ai/', '/%40anthropic-ai/'],
    ['encoded leaf', '/claude-agent-sdk/', '/cl%61ude-agent-sdk/'],
  ])(
    'refuses an ordinary governed import with %s targeting only inert code',
    async (_label, plain, encoded) => {
      const target = fixture(
        `@anthropic-ai/claude-agent-sdk/encoded-${_label.replaceAll(' ', '-')}.mjs`,
      );
      const encodedPath = target.replace(plain, encoded);
      expect(checkTarget('file://' + encodedPath)).toBe(target);
      const request = '/@fs/' + encodedPath;
      await expect(import(request)).rejects.toThrow(
        'Claude Agent SDK is disabled in unit tests; provide an explicit mock.',
      );
    },
  );

  it('refuses the actual Vitest worker dist-traversal native shortcut to an inert target', async () => {
    const target = fixture('@anthropic-ai/claude-agent-sdk/worker.mjs');
    const rawPath = vitestDist + '/' + relative(vitestDist, target);
    expect(rawPath.includes(vitestDist)).toBe(true);
    expect(checkTarget(pathToFileURL(rawPath).href)).toBe(target);
    const request = '/@fs/' + rawPath;
    // This is ordinary governed dynamic import, not a cloned/private worker call.
    await expect(import(request)).rejects.toThrow(
      'Claude Agent SDK is disabled in unit tests; provide an explicit mock.',
    );
  });

  it('keeps one eager worker-lifetime hook through explicit installs and module-cache reload', async () => {
    const initialRegistrations = registration.mock.calls.length;
    // setupFiles may have installed the hook before this file's spy existed.
    expect([0, 1]).toContain(initialRegistrations);
    console.info('NATIVE_GUARD_INITIAL_REGISTRATIONS', initialRegistrations);
    guard?.installSdkNativeGuard();
    guard?.installSdkNativeGuard();
    vi.resetModules();
    guard = await loadGuardIfPresent();
    guard?.installSdkNativeGuard();
    expect(registration).toHaveBeenCalledTimes(initialRegistrations);
    const target = fixture('@anthropic-ai/claude-agent-sdk/after-reload.mjs');
    const request = '/@fs/' + vitestDist + '/' + relative(vitestDist, target);
    checkTarget(pathToFileURL(vitestDist + '/' + relative(vitestDist, target)).href);
    await expect(import(request)).rejects.toThrow(
      'Claude Agent SDK is disabled in unit tests; provide an explicit mock.',
    );
  });

  it('preserves SDK metadata resolution without evaluating the real SDK', () => {
    expect(realpathSync(require.resolve('@anthropic-ai/claude-agent-sdk'))).toBe(sdkMetadata);
  });

  it.each([
    '@anthropic-ai/sdk/control.cjs',
    '@other-scope/claude-agent-sdk/control.cjs',
    '@anthropic-ai/claude-agent-sdk-extra/control.cjs',
  ])('preserves unrelated native module %s', (leaf) => {
    const target = fixture(leaf, controlBody);
    const value: unknown = require(target);
    expect(value).toBe('INERT_UNRELATED_CONTROL_OK');
  });

  it('preserves native Node builtins', () => {
    const builtin: unknown = require('node:path');
    expect(builtin).toHaveProperty('sep', sep);
  });
});
