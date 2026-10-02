import { describe, expect, it } from 'vitest';
import { InMemoryContainerBackend } from '../../../src/execution-broker/container-backend.js';
import { ExecutionBrokerError } from '../../../src/execution-broker/errors.js';
import type { ContainerSpec } from '../../../src/execution-broker/types.js';

const spec: ContainerSpec = {
  taskId: 'task-1',
  profile: {
    id: 'wiki-maintenance',
    maxTimeoutMs: 1_000,
    outputCapChars: 100,
    maxArgvCount: 4,
    maxArgvChars: 100,
    maxConcurrentExecsPerLease: 1,
    maxActiveLeases: 1,
  },
  workspace: { id: 'epic-wiki', hostPath: '/srv/wiki', mountTarget: '/epic-wiki', mode: 'ro' },
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('InMemoryContainerBackend', () => {
  it('defaults to no disk quota and honors the option', () => {
    expect(new InMemoryContainerBackend().capabilities()).toEqual({ diskQuotaEnforced: false });
    expect(new InMemoryContainerBackend({ diskQuotaEnforced: true }).capabilities()).toEqual({
      diskQuotaEnforced: true,
    });
  });

  it('creates sequential containers and tracks them as live', async () => {
    const backend = new InMemoryContainerBackend();
    const first = (await backend.createContainer(spec))._unsafeUnwrap();
    const second = (await backend.createContainer(spec))._unsafeUnwrap();
    expect(first.containerId).toBe('mem-1');
    expect(second.containerId).toBe('mem-2');
    expect(backend.createdCount).toBe(2);
    expect(backend.liveContainers()).toEqual(['mem-1', 'mem-2']);
  });

  it('fails creation with BACKEND_FAILURE when failCreate is set', async () => {
    const backend = new InMemoryContainerBackend({ failCreate: true });
    const error = (await backend.createContainer(spec))._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ExecutionBrokerError);
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(backend.createdCount).toBe(0);
    expect(backend.liveContainers()).toEqual([]);
  });

  it('runs the default exec handler and records the call', async () => {
    const backend = new InMemoryContainerBackend();
    const { containerId } = (await backend.createContainer(spec))._unsafeUnwrap();
    const output = await backend.exec(containerId, { argv: ['ls'], cwd: '/epic-wiki', signal: signal() });
    expect(output._unsafeUnwrap()).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(backend.execCalls).toEqual([{ containerId, argv: ['ls'], cwd: '/epic-wiki' }]);
  });

  it('passes the call, including the signal, to a custom handler', async () => {
    const backend = new InMemoryContainerBackend();
    const { containerId } = (await backend.createContainer(spec))._unsafeUnwrap();
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    backend.setExecHandler(async (call) => {
      seen = call.signal;
      return { exitCode: 3, stdout: call.argv.join(' '), stderr: call.cwd };
    });
    const output = await backend.exec(containerId, {
      argv: ['echo', 'hi'],
      cwd: '/epic-wiki/pages',
      signal: controller.signal,
    });
    expect(output._unsafeUnwrap()).toEqual({ exitCode: 3, stdout: 'echo hi', stderr: '/epic-wiki/pages' });
    expect(seen).toBe(controller.signal);
  });

  it('maps a throwing handler to BACKEND_FAILURE without leaking its message', async () => {
    const backend = new InMemoryContainerBackend();
    const { containerId } = (await backend.createContainer(spec))._unsafeUnwrap();
    backend.setExecHandler(async () => {
      throw new Error('LEAKY_DETAIL');
    });
    const error = (await backend.exec(containerId, { argv: ['ls'], cwd: '/', signal: signal() }))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(error.message).not.toContain('LEAKY_DETAIL');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('rejects exec on an unknown container without recording it', async () => {
    const backend = new InMemoryContainerBackend();
    const error = (await backend.exec('mem-9', { argv: ['ls'], cwd: '/', signal: signal() }))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(backend.execCalls).toEqual([]);
  });

  it('removes containers, records each removal, and tolerates repeats', async () => {
    const backend = new InMemoryContainerBackend();
    const { containerId } = (await backend.createContainer(spec))._unsafeUnwrap();
    expect((await backend.removeContainer(containerId)).isOk()).toBe(true);
    expect((await backend.removeContainer(containerId)).isOk()).toBe(true);
    expect(backend.liveContainers()).toEqual([]);
    expect(backend.removeCalls).toEqual([containerId, containerId]);
  });
});
