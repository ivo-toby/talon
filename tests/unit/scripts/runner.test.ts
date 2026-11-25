import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'neverthrow';
import { ExecutionBroker, InMemoryContainerBackend } from '../../../src/execution-broker/index.js';
import type {
  InMemoryExecStreamCall,
  OperatorAllowlist,
} from '../../../src/execution-broker/index.js';
import { runScript, type ScriptRunRequest } from '../../../src/scripts/runner.js';
import { ScriptError, type ToolProvider } from '../../../src/scripts/types.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setup(maxTimeoutMs = 60_000) {
  const root = mkdtempSync(join(tmpdir(), 'runner-'));
  roots.push(root);
  const allowlist: OperatorAllowlist = {
    profiles: [
      {
        id: 'scripts',
        maxTimeoutMs,
        outputCapChars: 1000,
        maxArgvCount: 8,
        maxArgvChars: 200,
        maxConcurrentExecsPerLease: 1,
        maxActiveLeases: 4,
      },
    ],
    workspaces: [{ id: 'scripts-ws', hostPath: root, mountTarget: '/scripts', mode: 'ro' }],
    grants: [
      { parentPersona: 'p1', workerPersona: 'p1', profile: 'scripts', workspace: 'scripts-ws' },
    ],
  };
  const backend = new InMemoryContainerBackend({ diskQuotaEnforced: true });
  const broker = new ExecutionBroker({ allowlist, backend });
  return { backend, broker };
}

interface Provider extends ToolProvider {
  signals: AbortSignal[];
}

function provider(hang = false): Provider {
  const p: Provider = {
    signals: [],
    describe: (name) => (name === 'mail.read' ? { toolClass: 'read' } : undefined),
    call: (_name, input, signal) => {
      p.signals.push(signal);
      if (hang) {
        return new Promise(() => {});
      }
      return Promise.resolve(ok({ echo: input }));
    },
  };
  return p;
}

function request(overrides: Partial<ScriptRunRequest> = {}): ScriptRunRequest {
  return {
    manifest: { name: 'm', personaId: 'p1', tools: ['mail.read'] },
    mode: 'live',
    provider: provider(),
    scriptPath: 'mail/script.ts',
    input: { a: 1 },
    timeoutMs: 5_000,
    profile: 'scripts',
    workspace: 'scripts-ws',
    ...overrides,
  };
}

const line = (m: unknown): string => JSON.stringify(m) + '\n';
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

async function expectLeaseGone(backend: InMemoryContainerBackend, broker: ExecutionBroker) {
  expect(backend.liveContainers()).toEqual([]);
  expect(backend.removeCalls).toHaveLength(1);
  const again = await broker.executeStream(
    {
      leaseId: 'x',
      taskId: 'x',
      personaId: 'p1',
      argv: ['a'],
      cwd: '',
      timeoutMs: 1000,
    },
    { onStdout: () => undefined },
  );
  expect(again.isErr()).toBe(true);
}

describe('runScript', () => {
  it('sends start first, routes a call, and reports done ok', async () => {
    const { backend, broker } = setup();
    const received: string[] = [];
    backend.setExecStreamHandler((call) => {
      call.onStdin((t) => {
        received.push(t);
        if (received.length === 1) {
          call.emitStdout(line({ t: 'call', id: 1, name: 'mail.read', input: { q: 1 } }));
        } else {
          call.emitStdout(line({ t: 'done', ok: true, result: 42 }));
        }
      });
      return new Promise(() => {});
    });

    const report = (await runScript(broker, request()))._unsafeUnwrap();

    expect(JSON.parse(received[0])).toEqual({ t: 'start', mode: 'live', input: { a: 1 } });
    expect(JSON.parse(received[1])).toEqual({
      t: 'result',
      id: 1,
      ok: true,
      value: { echo: { q: 1 } },
    });
    expect(report.ok).toBe(true);
    expect(report.result).toBe(42);
    expect(report.errorCode).toBeUndefined();
    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]).toMatchObject({ name: 'mail.read', outcome: 'executed' });
    expect(backend.execCalls[0]).toMatchObject({
      argv: ['node', '/scripts/node_modules/talon/run.js', 'mail/script.ts'],
      cwd: '/scripts',
    });
    await expectLeaseGone(backend, broker);
  });

  it('reports PROTOCOL for a line that is not a protocol message', async () => {
    const { backend, broker } = setup();
    backend.setExecStreamHandler((call) => {
      call.onStdin(() => call.emitStdout('garbage\n'));
      return new Promise(() => {});
    });
    const report = (await runScript(broker, request()))._unsafeUnwrap();
    expect(report).toMatchObject({ ok: false, errorCode: 'PROTOCOL' });
    expect(report.result).toBeUndefined();
    await expectLeaseGone(backend, broker);
  });

  it('reports TIMEOUT', async () => {
    const { backend, broker } = setup();
    backend.setExecStreamHandler(() => new Promise(() => {}));
    const report = (await runScript(broker, request({ timeoutMs: 30 })))._unsafeUnwrap();
    expect(report).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    await expectLeaseGone(backend, broker);
  });

  it('reports SCRIPT_FAILED on exit without done and aborts the open call', async () => {
    const { backend, broker } = setup();
    const p = provider(true);
    backend.setExecStreamHandler((call: InMemoryExecStreamCall) => {
      call.onStdin(() => {
        call.emitStdout(line({ t: 'call', id: 1, name: 'mail.read', input: {} }));
      });
      return tick()
        .then(tick)
        .then(() => ({ exitCode: 1, stderr: '' }));
    });
    const report = (await runScript(broker, request({ provider: p })))._unsafeUnwrap();
    expect(report).toMatchObject({ ok: false, errorCode: 'SCRIPT_FAILED' });
    expect(p.signals).toHaveLength(1);
    expect(p.signals[0].aborted).toBe(true);
    await expectLeaseGone(backend, broker);
  });

  it('reports SCRIPT_FAILED for done with ok false', async () => {
    const { backend, broker } = setup();
    backend.setExecStreamHandler((call) => {
      call.onStdin(() => call.emitStdout(line({ t: 'done', ok: false, message: 'boom' })));
      return new Promise(() => {});
    });
    const report = (await runScript(broker, request()))._unsafeUnwrap();
    expect(report).toMatchObject({ ok: false, errorCode: 'SCRIPT_FAILED' });
    expect(report.result).toBeUndefined();
    await expectLeaseGone(backend, broker);
  });

  it('ignores messages after done and keeps the done outcome with open calls', async () => {
    const { backend, broker } = setup();
    const p = provider(true);
    backend.setExecStreamHandler((call) => {
      call.onStdin(() => {
        call.emitStdout(
          line({ t: 'call', id: 1, name: 'mail.read', input: {} }) +
            line({ t: 'done', ok: true, result: 'fine' }) +
            line({ t: 'call', id: 2, name: 'mail.read', input: {} }),
        );
        call.emitStdout('garbage\n');
      });
      return new Promise(() => {});
    });
    const report = (await runScript(broker, request({ provider: p })))._unsafeUnwrap();
    expect(report).toMatchObject({ ok: true, result: 'fine' });
    expect(p.signals).toHaveLength(1);
    expect(p.signals[0].aborted).toBe(true);
    expect(report.calls).toHaveLength(1);
    await expectLeaseGone(backend, broker);
  });

  it.each([
    '/abs/script.ts',
    '../x.ts',
    'a/../x.ts',
    'a//x.ts',
    './x.ts',
    'a\\x.ts',
    '-x.ts',
    'x.js',
    '',
    'a b.ts',
  ])('rejects scriptPath %j before any lease', async (scriptPath) => {
    const { backend, broker } = setup();
    const result = await runScript(broker, request({ scriptPath }));
    expect(result._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(backend.createdCount).toBe(0);
  });

  it('rejects a bad timeout and a non-serializable input', async () => {
    const { backend, broker } = setup();
    expect((await runScript(broker, request({ timeoutMs: 0 })))._unsafeUnwrapErr().scriptCode).toBe(
      'INVALID_ARGUMENT',
    );
    expect(
      (await runScript(broker, request({ timeoutMs: 1.5 })))._unsafeUnwrapErr().scriptCode,
    ).toBe('INVALID_ARGUMENT');
    expect((await runScript(broker, request({ input: 10n })))._unsafeUnwrapErr().scriptCode).toBe(
      'INVALID_ARGUMENT',
    );
    expect(backend.createdCount).toBe(0);
  });

  it('returns a gateway creation error before any lease', async () => {
    const { backend, broker } = setup();
    const result = await runScript(broker, request({ mode: 'bogus' as never }));
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ScriptError);
    expect(result._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(backend.createdCount).toBe(0);
  });

  it('returns SANDBOX for a refused lease', async () => {
    const { backend, broker } = setup();
    const result = await runScript(
      broker,
      request({ manifest: { name: 'm', personaId: 'other', tools: [] } }),
    );
    const error = result._unsafeUnwrapErr();
    expect(error.scriptCode).toBe('SANDBOX');
    expect(error.cause).toBeDefined();
    expect(backend.createdCount).toBe(0);
  });

  it('returns SANDBOX for a refused exec and revokes the lease', async () => {
    const { backend, broker } = setup(1_000);
    const result = await runScript(broker, request({ timeoutMs: 5_000 }));
    expect(result._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    expect(backend.liveContainers()).toEqual([]);
    expect(backend.execCalls).toHaveLength(0);
  });

  it('never rejects when the broker throws', async () => {
    const broker = {
      createLease: () => {
        throw new Error('x');
      },
      executeStream: vi.fn(),
      revoke: vi.fn(),
    };
    const result = await runScript(broker as never, request());
    expect(result.isErr()).toBe(true);
  });
});
