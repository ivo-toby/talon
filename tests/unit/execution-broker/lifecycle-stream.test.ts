import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionBroker,
  ExecutionBrokerError,
  InMemoryContainerBackend,
} from '../../../src/execution-broker/index.js';
import type {
  BackendExecSession,
  OperatorAllowlist,
  ProfileConfig,
} from '../../../src/execution-broker/index.js';

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

  it('does not call onStdout once a revoke has ended the exec, even if the backend still emits', async () => {
    const { backend, broker, input, leaseId } = await leased();
    let emit!: (text: string) => void;
    backend.setExecStreamHandler((call) => {
      emit = call.emitStdout;
      return new Promise(() => {});
    });
    const chunks: string[] = [];
    const stream = (
      await broker.executeStream(input, { onStdout: (t) => chunks.push(t) })
    )._unsafeUnwrap();
    emit('early');
    (await broker.revoke(leaseId))._unsafeUnwrap();
    await stream.result;

    emit('late');

    expect(chunks).toEqual(['early']);
  });

  it('does not call onStdout after a time-out, even if the backend still emits', async () => {
    vi.useFakeTimers();
    const { backend, broker, input } = await leased();
    let emit!: (text: string) => void;
    backend.setExecStreamHandler((call) => {
      emit = call.emitStdout;
      return new Promise(() => {});
    });
    const chunks: string[] = [];
    const stream = (
      await broker.executeStream(input, { onStdout: (t) => chunks.push(t) })
    )._unsafeUnwrap();
    await vi.advanceTimersByTimeAsync(5_001);
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

  it('lets the handler-failure outcome win over an ok exit that arrives during cleanup', async () => {
    const { backend, broker, input } = await leased();
    const original = backend.removeContainer.bind(backend);
    backend.removeContainer = async (id: string) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      return original(id);
    };
    backend.setExecStreamHandler((call) => {
      return new Promise((resolve) => {
        call.onStdin((t) => {
          call.emitStdout(t);
          resolve({ exitCode: 0, stderr: '' });
        });
      });
    });
    const stream = (
      await broker.executeStream(input, {
        onStdout: () => {
          throw new Error('boom');
        },
      })
    )._unsafeUnwrap();

    stream.writeStdin('x');

    expect((await stream.result)._unsafeUnwrapErr().brokerCode).toBe('BACKEND_FAILURE');
  });
});

describe('abort in the admit window', () => {
  it('a revoke right after a stream call on a warm lease resolves cancelled, not timed out', async () => {
    const { backend, broker, input, leaseId } = await leased();
    backend.setExecHandler(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    (await broker.execute(input))._unsafeUnwrap();
    backend.setExecStreamHandler(() => new Promise(() => {}));

    const started = broker.executeStream(input, noop);
    const revoked = broker.revoke(leaseId);
    const stream = (await started)._unsafeUnwrap();
    await revoked;

    expect((await stream.result)._unsafeUnwrap()).toMatchObject({
      cancelled: true,
      timedOut: false,
    });
  });

  it('a revoke right after a buffered execute on a warm lease resolves cancelled, not timed out', async () => {
    const { backend, broker, input, leaseId } = await leased();
    backend.setExecHandler(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    (await broker.execute(input))._unsafeUnwrap();
    backend.setExecHandler(() => new Promise(() => {}));

    const started = broker.execute(input);
    const revoked = broker.revoke(leaseId);

    expect((await started)._unsafeUnwrap()).toMatchObject({ cancelled: true, timedOut: false });
    await revoked;
  });
});

describe('abort while the backend is starting the stream', () => {
  function gateStart(backend: InMemoryContainerBackend) {
    const entered = deferred<void>();
    const gate = deferred<Result<BackendExecSession, ExecutionBrokerError>>();
    backend.execStream = () => {
      entered.resolve();
      return gate.promise;
    };
    return { entered, gate };
  }

  function recordingSession() {
    const calls: string[] = [];
    const session: BackendExecSession = {
      writeStdin: (t) => calls.push(`write:${t}`),
      endStdin: () => calls.push('end'),
      done: new Promise(() => {}),
    };
    return { calls, session };
  }

  async function freshLeaseCanExecute(backend: InMemoryContainerBackend, broker: ExecutionBroker) {
    const created = await broker.createLease({
      taskId: 'task-2',
      parentPersonaId: 'wcm',
      personaId: 'wcm',
      profile: 'wiki-maintenance',
      workspace: 'epic-wiki',
    });
    backend.setExecHandler(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const executed = await broker.execute({
      leaseId: created._unsafeUnwrap().leaseId,
      taskId: 'task-2',
      personaId: 'wcm',
      argv: ['true'],
      cwd: 'pages',
      timeoutMs: 5_000,
    });
    expect(executed.isOk()).toBe(true);
  }

  it('revoke while pending, then the session arrives ok: cancelled, no stdin reaches it, slot released', async () => {
    const { backend, broker, input, leaseId } = await leased();
    const { entered, gate } = gateStart(backend);
    const { calls, session } = recordingSession();

    const started = broker.executeStream(input, noop);
    await entered.promise;
    (await broker.revoke(leaseId))._unsafeUnwrap();
    gate.resolve(ok(session));
    const stream = (await started)._unsafeUnwrap();
    stream.writeStdin('late');
    stream.endStdin();

    expect((await stream.result)._unsafeUnwrap()).toMatchObject({
      cancelled: true,
      timedOut: false,
    });
    expect(calls).toEqual([]);
    await freshLeaseCanExecute(backend, broker);
  });

  it('time-out while pending, then the start fails: timedOut result, slot released', async () => {
    vi.useFakeTimers();
    const { backend, broker, input } = await leased();
    const { entered, gate } = gateStart(backend);

    const started = broker.executeStream(input, noop);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5_001);
    gate.resolve(err(new ExecutionBrokerError('BACKEND_FAILURE', 'aborted')));
    const stream = (await started)._unsafeUnwrap();
    stream.writeStdin('late');

    expect((await stream.result)._unsafeUnwrap()).toMatchObject({
      timedOut: true,
      cancelled: false,
    });
    await freshLeaseCanExecute(backend, broker);
  });
});
