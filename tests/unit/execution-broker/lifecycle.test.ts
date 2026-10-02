import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionBroker,
  ExecutionBrokerError,
  InMemoryContainerBackend,
} from '../../../src/execution-broker/index.js';
import type {
  OperatorAllowlist,
  ProfileConfig,
  RawExecOutput,
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
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(profileOverrides: Partial<ProfileConfig> = {}, failCreate = false) {
  const root = mkdtempSync(join(tmpdir(), 'broker-life-'));
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
  const backend = new InMemoryContainerBackend({ diskQuotaEnforced: true, failCreate });
  const broker = new ExecutionBroker({ allowlist, backend });
  return { backend, broker };
}

async function leased(profileOverrides: Partial<ProfileConfig> = {}, failCreate = false) {
  const ctx = setup(profileOverrides, failCreate);
  const created = await ctx.broker.createLease({
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
    argv: ['git', 'status'],
    cwd: 'pages',
    timeoutMs: 5_000,
  };
  return { ...ctx, leaseId, input };
}

describe('execute', () => {
  it('lazily creates one container, reuses it, and passes the container-side cwd', async () => {
    const { backend, broker, input } = await leased();
    backend.setExecHandler(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));

    const first = await broker.execute(input);
    const second = await broker.execute({ ...input, argv: ['ls'], cwd: '' });

    expect(first._unsafeUnwrap()).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
    });
    expect(second.isOk()).toBe(true);
    expect(backend.createdCount).toBe(1);
    expect(backend.liveContainers()).toHaveLength(1);
    expect(backend.execCalls.map((c) => [c.argv, c.cwd])).toEqual([
      [['git', 'status'], '/epic-wiki/pages'],
      [['ls'], '/epic-wiki'],
    ]);
  });

  it('caps stdout and stderr independently at the profile output cap', async () => {
    const { backend, broker, input } = await leased();
    backend.setExecHandler(async () => ({
      exitCode: 0,
      stdout: 'abcdefghijKLMNOP',
      stderr: 'short',
    }));
    const result = (await broker.execute(input))._unsafeUnwrap();
    expect(result.stdout).toBe('abcdefghij');
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderr).toBe('short');
    expect(result.stderrTruncated).toBe(false);
  });

  it('returns a non-zero exit as a result and keeps the lease usable', async () => {
    const { backend, broker, input } = await leased();
    backend.setExecHandler(async () => ({ exitCode: 2, stdout: '', stderr: 'boom' }));
    const result = (await broker.execute(input))._unsafeUnwrap();
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
    expect((await broker.execute(input)).isOk()).toBe(true);
    expect(backend.liveContainers()).toHaveLength(1);
  });

  it('revoke removes the container once and is idempotent', async () => {
    const { backend, broker, input, leaseId } = await leased();
    await broker.execute(input);
    const [containerId] = backend.liveContainers();

    expect((await broker.revoke(leaseId)).isOk()).toBe(true);
    expect((await broker.revoke(leaseId)).isOk()).toBe(true);

    expect(backend.liveContainers()).toEqual([]);
    expect(backend.removeCalls).toEqual([containerId]);
  });

  it('revoke of a lease that never executed makes no backend call', async () => {
    const { backend, broker, leaseId } = await leased();
    expect((await broker.revoke(leaseId)).isOk()).toBe(true);
    expect(backend.removeCalls).toEqual([]);
  });

  it('revoke of an unknown lease is LEASE_NOT_FOUND', async () => {
    const { broker } = await leased();
    const error = (await broker.revoke('B'.repeat(43)))._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ExecutionBrokerError);
    expect(error.brokerCode).toBe('LEASE_NOT_FOUND');
  });
});

describe('timeout', () => {
  it('marks the result timed out, aborts the exec, removes the container, and revokes the lease', async () => {
    vi.useFakeTimers();
    const { backend, broker, input, leaseId } = await leased();
    const started = deferred<AbortSignal>();
    backend.setExecHandler(({ signal }) => {
      started.resolve(signal);
      return new Promise<RawExecOutput>(() => {});
    });

    const pending = broker.execute(input);
    const signal = await started.promise;
    const [containerId] = backend.liveContainers();
    await vi.advanceTimersByTimeAsync(5_001);
    const result = (await pending)._unsafeUnwrap();

    expect(result).toMatchObject({ timedOut: true, cancelled: false, exitCode: null });
    expect(signal.aborted).toBe(true);
    expect(backend.liveContainers()).toEqual([]);
    expect(backend.removeCalls).toEqual([containerId]);

    const after = (await broker.execute(input))._unsafeUnwrapErr();
    expect(after.brokerCode).toBe('LEASE_REVOKED');
    expect(after.message).not.toContain(leaseId);
    expect(backend.execCalls).toHaveLength(1);
  });

  it('does not time out a command that finishes before its deadline', async () => {
    vi.useFakeTimers();
    const { backend, broker, input } = await leased();
    backend.setExecHandler(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const result = (await broker.execute(input))._unsafeUnwrap();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result.timedOut).toBe(false);
    expect(backend.liveContainers()).toHaveLength(1);
    expect((await broker.execute(input)).isOk()).toBe(true);
  });
});

describe('cancellation via revoke', () => {
  it('resolves a running execute as cancelled, aborts it, and removes the container', async () => {
    const { backend, broker, input, leaseId } = await leased();
    const started = deferred<AbortSignal>();
    backend.setExecHandler(({ signal }) => {
      started.resolve(signal);
      return new Promise<RawExecOutput>(() => {});
    });

    const pending = broker.execute(input);
    const signal = await started.promise;
    expect((await broker.revoke(leaseId)).isOk()).toBe(true);
    const result = (await pending)._unsafeUnwrap();

    expect(result).toMatchObject({ cancelled: true, timedOut: false, exitCode: null });
    expect(signal.aborted).toBe(true);
    expect(backend.liveContainers()).toEqual([]);
    expect((await broker.execute(input))._unsafeUnwrapErr().brokerCode).toBe('LEASE_REVOKED');
  });
});

describe('terminal paths with sibling execs', () => {
  it('a timeout cancels every other in-flight exec on the lease before removing the container', async () => {
    vi.useFakeTimers();
    const { backend, broker, input } = await leased({ maxConcurrentExecsPerLease: 2 });
    const signals: AbortSignal[] = [];
    const bothStarted = deferred<void>();
    backend.setExecHandler(({ signal }) => {
      signals.push(signal);
      if (signals.length === 2) bothStarted.resolve();
      return new Promise<RawExecOutput>(() => {});
    });

    const short = broker.execute({ ...input, timeoutMs: 1_000 });
    const long = broker.execute({ ...input, timeoutMs: 5_000 });
    await bothStarted.promise;
    await vi.advanceTimersByTimeAsync(1_001);

    expect((await short)._unsafeUnwrap()).toMatchObject({ timedOut: true, cancelled: false });
    expect((await long)._unsafeUnwrap()).toMatchObject({ timedOut: false, cancelled: true, exitCode: null });
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(backend.createdCount).toBe(1);
    expect(backend.liveContainers()).toEqual([]);
    expect(backend.removeCalls).toHaveLength(1);
  });

  it('an exec backend failure cancels every other in-flight exec on the lease', async () => {
    const { backend, broker, input } = await leased({ maxConcurrentExecsPerLease: 2 });
    const failFirst = deferred<RawExecOutput>();
    const signals: AbortSignal[] = [];
    const bothStarted = deferred<void>();
    backend.setExecHandler(({ signal }) => {
      signals.push(signal);
      if (signals.length === 2) bothStarted.resolve();
      return signals.length === 1 ? failFirst.promise : new Promise<RawExecOutput>(() => {});
    });

    const first = broker.execute(input);
    const second = broker.execute({ ...input, timeoutMs: 30_000 });
    await bothStarted.promise;
    // Reject the first exec so the in-memory backend maps it to BACKEND_FAILURE.
    failFirst.reject(new Error('boom'));

    expect((await first)._unsafeUnwrapErr().brokerCode).toBe('BACKEND_FAILURE');
    expect((await second)._unsafeUnwrap()).toMatchObject({ cancelled: true, timedOut: false });
    expect(signals[1]?.aborted).toBe(true);
    expect(backend.createdCount).toBe(1);
    expect(backend.liveContainers()).toEqual([]);
    expect(backend.removeCalls).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('rejects an execute beyond the per-lease limit without a second exec', async () => {
    const { backend, broker, input } = await leased({ maxConcurrentExecsPerLease: 1 });
    const started = deferred<void>();
    const release = deferred<RawExecOutput>();
    backend.setExecHandler(() => {
      started.resolve();
      return release.promise;
    });

    const first = broker.execute(input);
    await started.promise;
    const second = await broker.execute(input);
    expect(second._unsafeUnwrapErr().brokerCode).toBe('CONCURRENCY_LIMIT');
    expect(backend.execCalls).toHaveLength(1);

    release.resolve({ exitCode: 0, stdout: '', stderr: '' });
    expect((await first).isOk()).toBe(true);
    backend.setExecHandler(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    expect((await broker.execute(input)).isOk()).toBe(true);
  });
});

describe('backend failures', () => {
  it('maps a container-create failure to BACKEND_FAILURE and revokes the lease', async () => {
    const { backend, broker, input } = await leased({}, true);
    const result = await broker.execute(input);
    expect(result._unsafeUnwrapErr().brokerCode).toBe('BACKEND_FAILURE');
    expect(backend.liveContainers()).toEqual([]);
    expect(backend.execCalls).toEqual([]);
    expect((await broker.execute(input))._unsafeUnwrapErr().brokerCode).toBe('LEASE_REVOKED');
  });

  it('maps a thrown exec to BACKEND_FAILURE, removes the container, and revokes the lease', async () => {
    const { backend, broker, input, leaseId } = await leased();
    backend.setExecHandler(async () => {
      throw new Error(`docker exploded for ${leaseId}`);
    });
    const error = (await broker.execute(input))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(error.message).not.toContain(leaseId);
    expect(error.message).not.toContain('git');
    expect(backend.liveContainers()).toEqual([]);
    expect(backend.removeCalls).toHaveLength(1);
    expect((await broker.execute(input))._unsafeUnwrapErr().brokerCode).toBe('LEASE_REVOKED');
  });
});
