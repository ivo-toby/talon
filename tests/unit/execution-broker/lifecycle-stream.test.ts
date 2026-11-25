import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionBroker, InMemoryContainerBackend } from '../../../src/execution-broker/index.js';
import type { OperatorAllowlist, ProfileConfig } from '../../../src/execution-broker/index.js';

const tempRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function leased(profileOverrides: Partial<ProfileConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'broker-stream-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'pages'));
  const allowlist: OperatorAllowlist = {
    profiles: [
      {
        id: 'wiki-maintenance',
        maxTimeoutMs: 60_000,
        outputCapChars: 10,
        maxArgvCount: 8,
        maxArgvChars: 200,
        maxConcurrentExecsPerLease: 1,
        maxActiveLeases: 4,
        ...profileOverrides,
      },
    ],
    workspaces: [{ id: 'epic-wiki', hostPath: root, mountTarget: '/epic-wiki', mode: 'rw' }],
    grants: [
      {
        parentPersona: 'wcm',
        workerPersona: 'wcm',
        profile: 'wiki-maintenance',
        workspace: 'epic-wiki',
      },
    ],
  };
  const backend = new InMemoryContainerBackend({ diskQuotaEnforced: true });
  const broker = new ExecutionBroker({ allowlist, backend });
  const created = await broker.createLease({
    taskId: 'task-1',
    parentPersonaId: 'wcm',
    personaId: 'wcm',
    profile: 'wiki-maintenance',
    workspace: 'epic-wiki',
  });
  const { leaseId } = created._unsafeUnwrap();
  const input = {
    leaseId,
    taskId: 'task-1',
    personaId: 'wcm',
    argv: ['node', 'runner.js'],
    cwd: 'pages',
    timeoutMs: 5_000,
  };
  return { backend, broker, leaseId, input };
}

const noop = { onStdout: (): void => undefined };

describe('executeStream', () => {
  it('round-trips stdin and stdout and reports the exit', async () => {
    const { backend, broker, input } = await leased();
    const exit = deferred<void>();
    backend.setExecStreamHandler(async (call) => {
      call.onStdin((text) => call.emitStdout(`echo:${text}`));
      await exit.promise;
      return { exitCode: 3, stderr: 'warn' };
    });
    const chunks: string[] = [];

    const stream = (
      await broker.executeStream(input, { onStdout: (t) => chunks.push(t) })
    )._unsafeUnwrap();
    stream.writeStdin('hi');
    expect(chunks).toEqual(['echo:hi']);
    exit.resolve();

    expect((await stream.result)._unsafeUnwrap()).toEqual({
      exitCode: 3,
      stdout: '',
      stderr: 'warn',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
    });
    expect(backend.execCalls[0]).toMatchObject({
      argv: ['node', 'runner.js'],
      cwd: '/epic-wiki/pages',
    });
  });

  it('delivers endStdin to the process', async () => {
    const { backend, broker, input } = await leased();
    backend.setExecStreamHandler(
      (call) =>
        new Promise((resolve) => {
          call.onStdinEnd(() => resolve({ exitCode: 0, stderr: '' }));
        }),
    );
    const stream = (await broker.executeStream(input, noop))._unsafeUnwrap();
    stream.endStdin();
    expect((await stream.result)._unsafeUnwrap()).toMatchObject({ exitCode: 0 });
  });

  it('applies the validation errors of execute before any backend call', async () => {
    const { backend, broker, input } = await leased();
    const cases: [unknown, string][] = [
      [{ ...input, extra: 1 }, 'INVALID_INPUT'],
      [{ ...input, leaseId: 'nope' }, 'LEASE_NOT_FOUND'],
      [{ ...input, taskId: 'other' }, 'LEASE_MISMATCH'],
      [{ ...input, personaId: 'other' }, 'LEASE_MISMATCH'],
      [{ ...input, timeoutMs: 60_001 }, 'TIMEOUT_EXCEEDS_PROFILE'],
      [{ ...input, cwd: '../escape' }, 'PATH_OUTSIDE_WORKSPACE'],
      [{ ...input, argv: Array.from({ length: 9 }, () => 'a') }, 'ARGV_TOO_LARGE'],
    ];
    for (const [bad] of cases) {
      const executed = await broker.execute(bad);
      const streamed = await broker.executeStream(bad, noop);
      expect(streamed._unsafeUnwrapErr().brokerCode).toBe(executed._unsafeUnwrapErr().brokerCode);
    }
    expect(backend.execCalls).toHaveLength(0);
    expect(backend.createdCount).toBe(0);
  });

  it('times out: result is timedOut and the lease becomes terminal', async () => {
    vi.useFakeTimers();
    const { backend, broker, input } = await leased();
    backend.setExecStreamHandler(() => new Promise(() => {}));
    const stream = (await broker.executeStream(input, noop))._unsafeUnwrap();

    await vi.advanceTimersByTimeAsync(5_001);

    expect((await stream.result)._unsafeUnwrap()).toMatchObject({
      timedOut: true,
      cancelled: false,
      exitCode: null,
    });
    expect(backend.liveContainers()).toEqual([]);
    expect((await broker.executeStream(input, noop))._unsafeUnwrapErr().brokerCode).toBe(
      'LEASE_REVOKED',
    );
    expect((await broker.execute(input))._unsafeUnwrapErr().brokerCode).toBe('LEASE_REVOKED');
  });

  it('does not let a backend failing after the abort replace the timeout result', async () => {
    vi.useFakeTimers();
    const { backend, broker, input } = await leased();
    backend.setExecStreamHandler(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const original = backend.removeContainer.bind(backend);
    backend.removeContainer = async (id: string) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return original(id);
    };
    const stream = (await broker.executeStream(input, noop))._unsafeUnwrap();

    await vi.advanceTimersByTimeAsync(5_001);
    await vi.advanceTimersByTimeAsync(100);

    expect((await stream.result)._unsafeUnwrap()).toMatchObject({
      timedOut: true,
      cancelled: false,
    });
  });

  it('resolves result as cancelled on revoke', async () => {
    const { backend, broker, input, leaseId } = await leased();
    let signal!: AbortSignal;
    backend.setExecStreamHandler((call) => {
      signal = call.signal;
      return new Promise(() => {});
    });
    const stream = (await broker.executeStream(input, noop))._unsafeUnwrap();

    (await broker.revoke(leaseId))._unsafeUnwrap();

    expect((await stream.result)._unsafeUnwrap()).toMatchObject({
      cancelled: true,
      timedOut: false,
      exitCode: null,
    });
    expect(signal.aborted).toBe(true);
    expect(backend.liveContainers()).toEqual([]);
  });

  it('counts a stream against the concurrent-exec limit together with execute', async () => {
    const { backend, broker, input } = await leased();
    const exit = deferred<void>();
    backend.setExecStreamHandler(async () => {
      await exit.promise;
      return { exitCode: 0, stderr: '' };
    });
    const stream = (await broker.executeStream(input, noop))._unsafeUnwrap();

    expect((await broker.execute(input))._unsafeUnwrapErr().brokerCode).toBe('CONCURRENCY_LIMIT');
    expect((await broker.executeStream(input, noop))._unsafeUnwrapErr().brokerCode).toBe(
      'CONCURRENCY_LIMIT',
    );
    exit.resolve();
    await stream.result;
    backend.setExecStreamHandler(async () => ({ exitCode: 0, stderr: '' }));
    expect((await broker.executeStream(input, noop)).isOk()).toBe(true);
  });

  it('cuts stderr at the profile output cap', async () => {
    const { backend, broker, input } = await leased();
    backend.setExecStreamHandler(async () => ({ exitCode: 0, stderr: 'x'.repeat(25) }));
    const stream = (await broker.executeStream(input, noop))._unsafeUnwrap();
    expect((await stream.result)._unsafeUnwrap()).toMatchObject({
      stderr: 'x'.repeat(10),
      stderrTruncated: true,
      stdout: '',
      stdoutTruncated: false,
    });
  });

  it('makes writeStdin and endStdin no-ops after a time-out', async () => {
    vi.useFakeTimers();
    const { backend, broker, input } = await leased();
    const received: string[] = [];
    backend.setExecStreamHandler((call) => {
      call.onStdin((t) => received.push(t));
      return new Promise(() => {});
    });
    const stream = (await broker.executeStream(input, noop))._unsafeUnwrap();
    await vi.advanceTimersByTimeAsync(5_001);
    await stream.result;

    expect(() => stream.writeStdin('late')).not.toThrow();
    expect(() => stream.endStdin()).not.toThrow();
    expect(received).toEqual([]);
  });

  it('does not call onStdout after result has resolved', async () => {
    const { backend, broker, input } = await leased();
    let emit!: (text: string) => void;
    backend.setExecStreamHandler(async (call) => {
      emit = call.emitStdout;
      return { exitCode: 0, stderr: '' };
    });
    const chunks: string[] = [];
    const stream = (
      await broker.executeStream(input, { onStdout: (t) => chunks.push(t) })
    )._unsafeUnwrap();
    await stream.result;
    emit('late');
    expect(chunks).toEqual([]);
  });

  it('treats a throwing onStdout as a failed exec without crashing', async () => {
    const { backend, broker, input } = await leased();
    backend.setExecStreamHandler((call) => {
      call.onStdin((t) => call.emitStdout(t));
      return new Promise(() => {});
    });
    const stream = (
      await broker.executeStream(input, {
        onStdout: () => {
          throw new Error('secret handler detail');
        },
      })
    )._unsafeUnwrap();

    stream.writeStdin('x');
    const failure = (await stream.result)._unsafeUnwrapErr();

    expect(failure.brokerCode).toBe('BACKEND_FAILURE');
    expect(failure.message).not.toContain('secret');
    expect(backend.liveContainers()).toEqual([]);
  });

  it('returns BACKEND_FAILURE when the backend refuses to start the stream', async () => {
    const { backend, broker, input } = await leased();
    backend.setExecStreamHandler(() => {
      throw new Error('no start');
    });

    const started = await broker.executeStream(input, noop);

    expect(started._unsafeUnwrapErr().brokerCode).toBe('BACKEND_FAILURE');
    expect(backend.liveContainers()).toEqual([]);
    expect((await broker.executeStream(input, noop))._unsafeUnwrapErr().brokerCode).toBe(
      'LEASE_REVOKED',
    );
  });
});
