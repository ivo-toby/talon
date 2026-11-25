import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'neverthrow';
import { ExecutionBroker, InMemoryContainerBackend } from '../../../src/execution-broker/index.js';
import type { OperatorAllowlist } from '../../../src/execution-broker/index.js';
import { runDryRun, runUnitCases, type RunDeps } from '../../../src/scripts/test-runner.js';
import type { StoredVersion } from '../../../src/scripts/store.js';
import type { ToolClass, ToolProvider, UnitCase } from '../../../src/scripts/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'trunner-'));
  roots.push(root);
  const allowlist: OperatorAllowlist = {
    profiles: [
      {
        id: 'script',
        maxTimeoutMs: 60_000,
        outputCapChars: 1000,
        maxArgvCount: 8,
        maxArgvChars: 200,
        maxConcurrentExecsPerLease: 1,
        maxActiveLeases: 4,
      },
    ],
    workspaces: [{ id: 'scripts', hostPath: root, mountTarget: '/scripts', mode: 'ro' }],
    grants: [{ parentPersona: 'p1', workerPersona: 'p1', profile: 'script', workspace: 'scripts' }],
  };
  const backend = new InMemoryContainerBackend({ diskQuotaEnforced: true });
  const broker = new ExecutionBroker({ allowlist, backend });
  const deps: RunDeps = {
    broker,
    profile: 'script',
    workspace: 'scripts',
    timeoutMs: 5000,
    maxCalls: 50,
  };
  return { backend, deps };
}

const version = (): StoredVersion => ({
  versionId: 'v',
  scriptId: 's',
  version: 1,
  contentHash: 'h',
  manifest: {
    name: 'demo',
    description: 'd',
    tools: ['mail.read', 'mail.send'],
    channels: [],
    dryRunInput: { d: 1 },
  },
  state: 'draft',
  dir: '/x',
  scriptPath: 's/v1/script.ts',
  threadId: 't',
});

const classes: Record<string, ToolClass> = { 'mail.read': 'read', 'mail.send': 'write' };
const describe_ = (name: string) => (classes[name] ? { toolClass: classes[name] } : undefined);

const line = (m: unknown): string => JSON.stringify(m) + '\n';

/** Plays: on `start`, makes each call in turn (waiting for each result), then done. */
function play(
  backend: InMemoryContainerBackend,
  calls: Array<{ name: string; input: unknown }>,
  done: { ok: boolean; result?: unknown; message?: string },
): void {
  backend.setExecStreamHandler((c) => {
    let next = 0;
    const step = (): void => {
      if (next < calls.length) {
        const { name, input } = calls[next];
        c.emitStdout(line({ t: 'call', id: ++next, name, input }));
      } else {
        c.emitStdout(line({ t: 'done', ...done }));
      }
    };
    c.onStdin(() => step());
    return new Promise(() => {});
  });
}

const baseCase = (over: Partial<UnitCase>): UnitCase => ({
  name: 'c',
  input: null,
  stubs: { 'mail.read': [{ n: 1 }] },
  expect: {},
  ...over,
});

const script = [
  { name: 'mail.read', input: { q: 1 } },
  { name: 'mail.send', input: { to: 'a' } },
];

describe('runUnitCases', () => {
  it('passes a case that matches result and writes', async () => {
    const { backend, deps } = setup();
    play(backend, script, { ok: true, result: { sent: 1 } });
    const out = await runUnitCases(
      deps,
      version(),
      'p1',
      [
        baseCase({
          stubs: { 'mail.read': [{ n: 1 }], 'mail.send': [{ id: 1 }] },
          expect: { result: { sent: 1 }, writes: [{ name: 'mail.send', input: { to: 'a' } }] },
        }),
      ],
      describe_,
    );
    expect(out._unsafeUnwrap()).toEqual([{ name: 'c', passed: true }]);
  });

  it('fails on a wrong result', async () => {
    const { backend, deps } = setup();
    play(backend, [], { ok: true, result: { sent: 2 } });
    const out = await runUnitCases(
      deps,
      version(),
      'p1',
      [baseCase({ expect: { result: { sent: 1 } } })],
      describe_,
    );
    expect(out._unsafeUnwrap()).toEqual([{ name: 'c', passed: false, reason: 'result differs' }]);
  });

  it('fails on wrong writes, with the real class of the tool', async () => {
    const { backend, deps } = setup();
    play(backend, script, { ok: true, result: null });
    const out = await runUnitCases(
      deps,
      version(),
      'p1',
      [
        baseCase({
          stubs: { 'mail.read': [1], 'mail.send': [1] },
          expect: { writes: [{ name: 'mail.send', input: { to: 'b' } }] },
        }),
        baseCase({
          name: 'none',
          stubs: { 'mail.read': [1], 'mail.send': [1] },
          expect: { writes: [] },
        }),
      ],
      describe_,
    );
    expect(out._unsafeUnwrap()).toEqual([
      { name: 'c', passed: false, reason: 'writes differ' },
      { name: 'none', passed: false, reason: 'writes differ' },
    ]);
  });

  it('handles expected failure and unexpected failure', async () => {
    const { backend, deps } = setup();
    play(backend, [], { ok: false, message: 'boom' });
    const out = await runUnitCases(
      deps,
      version(),
      'p1',
      [
        baseCase({ name: 'expected', expect: { ok: false } }),
        baseCase({ name: 'unexpected', expect: {} }),
      ],
      describe_,
    );
    expect(out._unsafeUnwrap()).toEqual([
      { name: 'expected', passed: true },
      { name: 'unexpected', passed: false, reason: 'run failed: SCRIPT_FAILED' },
    ]);
    play(backend, [], { ok: true, result: 1 });
    const again = await runUnitCases(
      deps,
      version(),
      'p1',
      [baseCase({ expect: { ok: false } })],
      describe_,
    );
    expect(again._unsafeUnwrap()[0]).toEqual({
      name: 'c',
      passed: false,
      reason: 'expected a failure',
    });
  });

  it('returns err when the sandbox cannot run', async () => {
    const { deps } = setup();
    const out = await runUnitCases(deps, version(), 'nobody', [baseCase({})], describe_);
    expect(out.isErr()).toBe(true);
  });
});

describe('runDryRun', () => {
  const real = (): ToolProvider => ({
    describe: describe_,
    call: () => Promise.resolve(ok({ rows: 1 })),
  });

  it('reports a skipped write as work', async () => {
    const { backend, deps } = setup();
    play(backend, script, { ok: true, result: 'r' });
    const out = (await runDryRun(deps, version(), 'p1', real()))._unsafeUnwrap();
    expect(out.didWork).toBe(true);
    expect(out.report.calls.map((c) => c.outcome)).toEqual(['executed', 'skipped-dry-run']);
  });

  it('reports no work when only reads ran', async () => {
    const { backend, deps } = setup();
    play(backend, [script[0]], { ok: true, result: 'r' });
    const out = (await runDryRun(deps, version(), 'p1', real()))._unsafeUnwrap();
    expect(out.didWork).toBe(false);
  });

  it('reports no work when the run failed', async () => {
    const { backend, deps } = setup();
    play(backend, script, { ok: false, message: 'boom' });
    const out = (await runDryRun(deps, version(), 'p1', real()))._unsafeUnwrap();
    expect(out.report.ok).toBe(false);
    expect(out.didWork).toBe(false);
  });
});
