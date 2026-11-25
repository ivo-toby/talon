import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'neverthrow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDockerBackend,
  createDockerEngineClient,
  ExecutionBroker,
} from '../../src/execution-broker/index.js';
import { installScriptSdk, runScript } from '../../src/scripts/index.js';
import type { ScriptMode, ScriptRunReport, ToolProvider } from '../../src/scripts/index.js';

/**
 * Real-Docker run of the script runtime. Skipped unless TALON_SCRIPT_IT_IMAGE
 * names a digest-pinned Node.js (22.18 or later) image that already exists
 * locally (nothing is pulled), and the Docker socket is readable.
 *
 *   TALON_SCRIPT_IT_IMAGE='node@sha256:<64 hex>' npx vitest run tests/integration/script-runtime-docker.test.ts
 */
const IMAGE = process.env.TALON_SCRIPT_IT_IMAGE ?? '';
const SOCKET = process.env.TALON_DOCKER_SOCKET ?? '/var/run/docker.sock';
const enabled = IMAGE !== '' && existsSync(SOCKET);

const PERSONA = 'assistant';

/** Containers that mount this file's own temporary directory, so parallel files do not collide. */
function containerIds(hostPath: string): string[] {
  return execFileSync('docker', ['ps', '-aq', '--no-trunc', '--filter', `volume=${hostPath}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .sort();
}

const SCRIPTS: Record<string, string> = {
  roundtrip: `
    import { tools } from 'talon';
    interface Note { id: number; text: string }
    export default async function (input: { n: number }): Promise<unknown> {
      const notes = (await tools.notes.read({ limit: input.n })) as Note[];
      const written = await tools.notes.write({ text: notes.map((n) => n.text).join('+') });
      console.log('this goes to stderr, not the protocol');
      return { count: notes.length, written };
    }
  `,
  spin: `
    export default async function (): Promise<void> {
      while (true) {}
    }
  `,
  network: `
    export default async function (): Promise<string> {
      await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(3000) });
      return 'reached the network';
    }
  `,
  fswrite: `
    import { writeFileSync } from 'node:fs';
    export default async function (): Promise<string> {
      writeFileSync('/scripts/fswrite/planted.txt', 'x');
      return 'wrote to the scripts mount';
    }
  `,
  forbidden: `
    import { tools, TalonToolError } from 'talon';
    export default async function (): Promise<unknown> {
      try {
        await tools.notes.delete({ id: 1 });
        return 'deleted';
      } catch (error) {
        return { refused: error instanceof TalonToolError ? error.code : 'other' };
      }
    }
  `,
};

describe.skipIf(!enabled)('script runtime against a real Docker daemon', () => {
  let root: string;
  let broker: ExecutionBroker;
  let readCalls: unknown[];
  let writeCalls: unknown[];

  const provider: ToolProvider = {
    describe(name) {
      if (name === 'notes.read') return { toolClass: 'read' };
      if (name === 'notes.write' || name === 'notes.delete') return { toolClass: 'write' };
      return undefined;
    },
    call(name, input) {
      if (name === 'notes.read') {
        readCalls.push(input);
        return Promise.resolve(
          ok([
            { id: 1, text: 'a' },
            { id: 2, text: 'b' },
          ]),
        );
      }
      writeCalls.push(input);
      return Promise.resolve(ok({ stored: true }));
    },
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'script-it-'));
    chmodSync(root, 0o755);
    installScriptSdk(root)._unsafeUnwrap();
    for (const [name, source] of Object.entries(SCRIPTS)) {
      mkdirSync(join(root, name), { mode: 0o755 });
      chmodSync(join(root, name), 0o755);
      writeFileSync(join(root, name, 'script.ts'), source, { mode: 0o644 });
    }
    const backend = createDockerBackend(createDockerEngineClient({ socketPath: SOCKET }), {
      image: IMAGE,
      user: '10001:10001',
      memoryBytes: 256 * 1024 * 1024,
      pidsLimit: 64,
      nanoCpus: 1_000_000_000,
      tmpfsSizeBytes: 16 * 1024 * 1024,
      diskQuotaEnforced: false,
    })._unsafeUnwrap();
    broker = new ExecutionBroker({
      allowlist: {
        profiles: [
          {
            id: 'script',
            maxTimeoutMs: 30_000,
            outputCapChars: 10_000,
            maxArgvCount: 8,
            maxArgvChars: 1_000,
            maxConcurrentExecsPerLease: 1,
            maxActiveLeases: 4,
          },
        ],
        workspaces: [{ id: 'scripts', hostPath: root, mountTarget: '/scripts', mode: 'ro' }],
        grants: [
          {
            parentPersona: PERSONA,
            workerPersona: PERSONA,
            profile: 'script',
            workspace: 'scripts',
          },
        ],
      },
      backend,
    });
  });

  beforeEach(() => {
    readCalls = [];
    writeCalls = [];
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function run(
    name: string,
    mode: ScriptMode,
    extra: { timeoutMs?: number; stubs?: Record<string, unknown[]>; tools?: string[] } = {},
  ): Promise<ScriptRunReport> {
    const result = await runScript(broker, {
      manifest: {
        name,
        personaId: PERSONA,
        tools: extra.tools ?? ['notes.read', 'notes.write'],
      },
      mode,
      provider,
      scriptPath: `${name}/script.ts`,
      input: { n: 2 },
      timeoutMs: extra.timeoutMs ?? 20_000,
      stubs: extra.stubs,
      profile: 'script',
      workspace: 'scripts',
    });
    return result._unsafeUnwrap();
  }

  it('live: both tools run and the script result returns', async () => {
    const report = await run('roundtrip', 'live');
    expect(report).toMatchObject({ ok: true, result: { count: 2, written: { stored: true } } });
    expect(readCalls).toEqual([{ limit: 2 }]);
    expect(writeCalls).toEqual([{ text: 'a+b' }]);
    expect(report.calls.map((c) => [c.name, c.outcome])).toEqual([
      ['notes.read', 'executed'],
      ['notes.write', 'executed'],
    ]);
  }, 60_000);

  it('dry-run: the read tool runs, the write tool does not, and the report lists the skipped write', async () => {
    const report = await run('roundtrip', 'dry-run');
    expect(report.ok).toBe(true);
    expect(report.result).toEqual({ count: 2, written: { dryRun: true } });
    expect(readCalls).toHaveLength(1);
    expect(writeCalls).toHaveLength(0);
    expect(report.calls[1]).toMatchObject({
      name: 'notes.write',
      toolClass: 'write',
      outcome: 'skipped-dry-run',
      input: { text: 'a+b' },
    });
  }, 60_000);

  it('unit: no tool runs and the script gets the stubs', async () => {
    const report = await run('roundtrip', 'unit', {
      stubs: { 'notes.read': [[{ id: 9, text: 'z' }]], 'notes.write': [{ stubbed: true }] },
    });
    expect(report).toMatchObject({ ok: true, result: { count: 1, written: { stubbed: true } } });
    expect(readCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
  }, 60_000);

  it('refuses a tool that is not in the manifest, also in live mode', async () => {
    const report = await run('forbidden', 'live');
    expect(report).toMatchObject({ ok: true, result: { refused: 'NOT_IN_MANIFEST' } });
    expect(writeCalls).toHaveLength(0);
  }, 60_000);

  it('ends a script that never returns with TIMEOUT', async () => {
    const started = Date.now();
    const report = await run('spin', 'live', { timeoutMs: 3_000 });
    expect(report).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 60_000);

  it('gives the script no network', async () => {
    const report = await run('network', 'live');
    expect(report).toMatchObject({ ok: false, errorCode: 'SCRIPT_FAILED' });
  }, 60_000);

  it('gives the script a read-only scripts mount', async () => {
    const report = await run('fswrite', 'live');
    expect(report).toMatchObject({ ok: false, errorCode: 'SCRIPT_FAILED' });
    expect(existsSync(join(root, 'fswrite', 'planted.txt'))).toBe(false);
  }, 60_000);

  it('removes every container it created', () => {
    expect(containerIds(root)).toEqual([]);
  });
});
