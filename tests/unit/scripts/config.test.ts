import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptsConfigSchema } from '../../../src/core/config/config-schema.js';
import type { ScriptsConfig } from '../../../src/core/config/config-schema.js';
import { buildScriptBroker, SCRIPT_PROFILE, SCRIPT_WORKSPACE } from '../../../src/scripts/index.js';

const IMAGE = `node@sha256:${'a'.repeat(64)}`;

describe('buildScriptBroker', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'script-config-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function config(extra: Partial<ScriptsConfig> = {}): ScriptsConfig {
    return ScriptsConfigSchema.parse({ enabled: true, root, image: IMAGE, ...extra });
  }

  it('builds a broker with one profile, one workspace and one grant per persona', async () => {
    const broker = buildScriptBroker(config({ runTimeoutMs: 45_000 }), ['a', 'b', 'a']);
    expect(broker.isOk()).toBe(true);
    const allowlist = (broker._unsafeUnwrap() as unknown as { opts: { allowlist: unknown } }).opts
      .allowlist;
    expect(allowlist).toEqual({
      profiles: [
        {
          id: SCRIPT_PROFILE,
          maxTimeoutMs: 45_000,
          outputCapChars: 10_000,
          maxArgvCount: 8,
          maxArgvChars: 1_000,
          maxConcurrentExecsPerLease: 1,
          maxActiveLeases: 4,
        },
      ],
      workspaces: [{ id: SCRIPT_WORKSPACE, hostPath: root, mountTarget: '/scripts', mode: 'ro' }],
      grants: [
        { parentPersona: 'a', workerPersona: 'a', profile: 'script', workspace: 'scripts' },
        { parentPersona: 'b', workerPersona: 'b', profile: 'script', workspace: 'scripts' },
      ],
    });
  });

  it('resolves a relative root against the working directory', () => {
    const relative = mkdtempSync(join(process.cwd(), '.script-config-rel-'));
    try {
      const name = relative.slice(process.cwd().length + 1);
      const broker = buildScriptBroker(config({ root: name }), ['a'])._unsafeUnwrap();
      const allowlist = (
        broker as unknown as { opts: { allowlist: { workspaces: Array<{ hostPath: string }> } } }
      ).opts.allowlist;
      expect(allowlist.workspaces[0]?.hostPath).toBe(resolve(name));
    } finally {
      rmSync(relative, { recursive: true, force: true });
    }
  });

  it('rejects a missing root, a file as root, and no path in the message', () => {
    const missing = join(root, 'missing');
    const result = buildScriptBroker(config({ root: missing }), ['a']);
    expect(result._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(result._unsafeUnwrapErr().message).not.toContain(missing);
    const file = join(root, 'file');
    writeFileSync(file, 'x');
    expect(buildScriptBroker(config({ root: file }), ['a'])._unsafeUnwrapErr().scriptCode).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('rejects disabled, unpinned image, empty persona list and empty persona id', () => {
    const code = (r: ReturnType<typeof buildScriptBroker>): string | undefined =>
      r.isErr() ? r.error.scriptCode : undefined;
    expect(code(buildScriptBroker(config({ enabled: false }), ['a']))).toBe('INVALID_ARGUMENT');
    expect(code(buildScriptBroker(config({ image: 'node:22' }), ['a']))).toBe('INVALID_ARGUMENT');
    expect(code(buildScriptBroker(config(), []))).toBe('INVALID_ARGUMENT');
    expect(code(buildScriptBroker(config(), ['a', '']))).toBe('INVALID_ARGUMENT');
  });
});

describe('ScriptsConfigSchema', () => {
  it('parses defaults from an empty object', () => {
    expect(ScriptsConfigSchema.parse({})).toEqual({
      enabled: false,
      root: 'data/scripts',
      image: '',
      dockerSocket: '/var/run/docker.sock',
      runTimeoutMs: 120_000,
      maxCallsPerRun: 200,
      judgeTimeoutMs: 60_000,
      approvalTtlMinutes: 1440,
      toolClasses: {},
    });
  });
});
