import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { createDockerBackend } from '../../../src/execution-broker/docker-backend.js';
import { ExecutionBrokerError } from '../../../src/execution-broker/errors.js';
import type {
  DockerBackendConfig,
  DockerEngineClient,
  DockerRequest,
  DockerResponse,
} from '../../../src/execution-broker/docker-types.js';
import type { ContainerSpec } from '../../../src/execution-broker/types.js';

const DIGEST = `registry.local/talon-worker@sha256:${'a'.repeat(64)}`;

const config: DockerBackendConfig = {
  image: DIGEST,
  user: '10001:10001',
  memoryBytes: 512 * 1024 * 1024,
  pidsLimit: 128,
  nanoCpus: 1_000_000_000,
  tmpfsSizeBytes: 64 * 1024 * 1024,
  diskQuotaEnforced: false,
};

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

function json(status: number, value: unknown): Result<DockerResponse, ExecutionBrokerError> {
  return ok({ status, body: Buffer.from(JSON.stringify(value), 'utf8') });
}

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

type Script = (request: DockerRequest) => Result<DockerResponse, ExecutionBrokerError>;

function fakeClient(script: Script): { client: DockerEngineClient; calls: DockerRequest[] } {
  const calls: DockerRequest[] = [];
  return {
    calls,
    client: {
      request: (request) => {
        calls.push(request);
        return Promise.resolve(script(request));
      },
      openStream: () => Promise.resolve(err(new ExecutionBrokerError('BACKEND_FAILURE', 'openStream not scripted'))),
    },
  };
}

const happyScript: Script = (request) => {
  if (request.method === 'POST' && request.path.startsWith('/containers/create')) return json(201, { Id: 'c1' });
  if (request.method === 'POST' && request.path === '/containers/c1/start') return ok({ status: 204, body: Buffer.alloc(0) });
  if (request.method === 'POST' && request.path === '/containers/c1/exec') return json(201, { Id: 'e1' });
  if (request.method === 'POST' && request.path === '/exec/e1/start') {
    return ok({ status: 200, body: Buffer.concat([frame(1, 'out'), frame(2, 'err')]) });
  }
  if (request.method === 'GET' && request.path === '/exec/e1/json') return json(200, { ExitCode: 3, Running: false });
  if (request.method === 'DELETE') return ok({ status: 204, body: Buffer.alloc(0) });
  return ok({ status: 500, body: Buffer.alloc(0) });
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('createDockerBackend', () => {
  it('rejects a tag-only image', () => {
    const { client } = fakeClient(happyScript);
    const result = createDockerBackend(client, { ...config, image: 'talon-worker:latest' });
    expect(result._unsafeUnwrapErr().brokerCode).toBe('INVALID_ARGUMENT');
  });

  it('rejects a root user and non-positive limits', () => {
    const { client } = fakeClient(happyScript);
    expect(createDockerBackend(client, { ...config, user: '0:0' })._unsafeUnwrapErr().brokerCode).toBe('INVALID_ARGUMENT');
    expect(createDockerBackend(client, { ...config, user: 'root' })._unsafeUnwrapErr().brokerCode).toBe('INVALID_ARGUMENT');
    expect(createDockerBackend(client, { ...config, memoryBytes: 0 })._unsafeUnwrapErr().brokerCode).toBe('INVALID_ARGUMENT');
    expect(createDockerBackend(client, { ...config, pidsLimit: -1 })._unsafeUnwrapErr().brokerCode).toBe('INVALID_ARGUMENT');
  });

  it('reports the configured disk quota capability', () => {
    const { client } = fakeClient(happyScript);
    expect(createDockerBackend(client, config)._unsafeUnwrap().capabilities()).toEqual({ diskQuotaEnforced: false });
    expect(
      createDockerBackend(client, { ...config, diskQuotaEnforced: true })._unsafeUnwrap().capabilities(),
    ).toEqual({ diskQuotaEnforced: true });
  });
});

describe('DockerContainerBackend.createContainer', () => {
  it('creates a hardened container, starts it and returns the container ID', async () => {
    const { client, calls } = fakeClient(happyScript);
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    const created = (await backend.createContainer(spec))._unsafeUnwrap();
    expect(created.containerId).toBe('c1');

    const create = calls[0];
    expect(create.method).toBe('POST');
    expect(create.path.startsWith('/containers/create')).toBe(true);
    const body = create.body as Record<string, any>;
    expect(body.Image).toBe(DIGEST);
    expect(body.User).toBe('10001:10001');
    expect(body.Cmd).toEqual(['sleep', 'infinity']);
    expect(body.NetworkDisabled).toBe(true);
    expect(body.Env ?? []).toEqual([]);
    expect(body.HostConfig.NetworkMode).toBe('none');
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.CapDrop).toEqual(['ALL']);
    expect(body.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(body.HostConfig.Privileged).not.toBe(true);
    expect(body.HostConfig.Binds).toEqual(['/srv/wiki:/epic-wiki:ro']);
    expect(body.HostConfig.Memory).toBe(config.memoryBytes);
    expect(body.HostConfig.PidsLimit).toBe(config.pidsLimit);
    expect(body.HostConfig.NanoCpus).toBe(config.nanoCpus);
    expect(body.HostConfig.Tmpfs['/tmp']).toContain(`size=${config.tmpfsSizeBytes}`);
    expect(body.HostConfig.Tmpfs['/tmp']).toContain('noexec');
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/containers/c1/start' });
  });

  it('mounts read-write workspaces with :rw', async () => {
    const { client, calls } = fakeClient(happyScript);
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    await backend.createContainer({ ...spec, workspace: { ...spec.workspace, mode: 'rw' } });
    const body = calls[0].body as Record<string, any>;
    expect(body.HostConfig.Binds).toEqual(['/srv/wiki:/epic-wiki:rw']);
  });

  it('rejects workspace paths that could inject bind options, before any request', async () => {
    const { client, calls } = fakeClient(happyScript);
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    for (const workspace of [
      { ...spec.workspace, hostPath: '/srv/wiki:/etc:rw' },
      { ...spec.workspace, mountTarget: '/epic-wiki:rw' },
      { ...spec.workspace, hostPath: 'relative/path' },
    ]) {
      const error = (await backend.createContainer({ ...spec, workspace }))._unsafeUnwrapErr();
      expect(error.brokerCode).toBe('INVALID_ARGUMENT');
    }
    expect(calls).toHaveLength(0);
  });

  it('returns BACKEND_FAILURE when create is rejected and does not start anything', async () => {
    const { client, calls } = fakeClient((request) =>
      request.path.startsWith('/containers/create') ? json(500, { message: 'boom' }) : happyScript(request),
    );
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    const error = (await backend.createContainer(spec))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    expect(error.message).not.toContain('boom');
    expect(calls.some((c) => c.path.endsWith('/start'))).toBe(false);
  });

  it('force-removes the created container when start fails', async () => {
    const { client, calls } = fakeClient((request) =>
      request.path === '/containers/c1/start' ? json(500, { message: 'cannot start' }) : happyScript(request),
    );
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    const error = (await backend.createContainer(spec))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
    const removal = calls.find((c) => c.method === 'DELETE');
    expect(removal?.path).toContain('/containers/c1');
    expect(removal?.path).toContain('force=true');
  });

  it('returns BACKEND_FAILURE when the transport fails', async () => {
    const { client } = fakeClient(() => err(new ExecutionBrokerError('BACKEND_FAILURE', 'transport')));
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    expect((await backend.createContainer(spec))._unsafeUnwrapErr().brokerCode).toBe('BACKEND_FAILURE');
  });
});

describe('DockerContainerBackend.exec', () => {
  it('creates an exec with argv, workdir and no environment, then returns demuxed output and exit code', async () => {
    const { client, calls } = fakeClient(happyScript);
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    const output = (
      await backend.exec('c1', { argv: ['ls', '-la'], cwd: '/epic-wiki/docs', signal: signal() })
    )._unsafeUnwrap();
    expect(output).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });

    const execCreate = calls.find((c) => c.path === '/containers/c1/exec');
    const body = execCreate?.body as Record<string, any>;
    expect(body.Cmd).toEqual(['ls', '-la']);
    expect(body.WorkingDir).toBe('/epic-wiki/docs');
    expect(body.AttachStdout).toBe(true);
    expect(body.AttachStderr).toBe(true);
    expect(body.AttachStdin ?? false).toBe(false);
    expect(body.Tty).toBe(false);
    expect(body.Privileged ?? false).toBe(false);
    expect(body.Env ?? []).toEqual([]);

    const start = calls.find((c) => c.path === '/exec/e1/start');
    expect(start?.body).toMatchObject({ Detach: false, Tty: false });
  });

  it('passes the abort signal to every call', async () => {
    const { client, calls } = fakeClient(happyScript);
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    const abort = signal();
    await backend.exec('c1', { argv: ['true'], cwd: '/epic-wiki', signal: abort });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call.signal).toBe(abort);
  });

  it('fails when the exec is still running after the stream ended', async () => {
    const { client } = fakeClient((request) =>
      request.path === '/exec/e1/json' ? json(200, { ExitCode: 0, Running: true }) : happyScript(request),
    );
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    const error = (await backend.exec('c1', { argv: ['true'], cwd: '/epic-wiki', signal: signal() }))._unsafeUnwrapErr();
    expect(error.brokerCode).toBe('BACKEND_FAILURE');
  });

  it('fails on a non-201 exec create, a non-200 exec start, and a malformed inspect, without echoing argv', async () => {
    for (const failing of ['/containers/c1/exec', '/exec/e1/start', '/exec/e1/json']) {
      const { client } = fakeClient((request) =>
        request.path === failing ? ok({ status: 500, body: Buffer.from('argv-secret') }) : happyScript(request),
      );
      const backend = createDockerBackend(client, config)._unsafeUnwrap();
      const error = (
        await backend.exec('c1', { argv: ['argv-secret'], cwd: '/epic-wiki', signal: signal() })
      )._unsafeUnwrapErr();
      expect(error.brokerCode).toBe('BACKEND_FAILURE');
      expect(error.message).not.toContain('argv-secret');
    }
    const { client } = fakeClient((request) =>
      request.path === '/exec/e1/json' ? ok({ status: 200, body: Buffer.from('not json') }) : happyScript(request),
    );
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    expect(
      (await backend.exec('c1', { argv: ['true'], cwd: '/epic-wiki', signal: signal() }))._unsafeUnwrapErr().brokerCode,
    ).toBe('BACKEND_FAILURE');
  });

  it('returns BACKEND_FAILURE when the transport fails', async () => {
    const { client } = fakeClient(() => err(new ExecutionBrokerError('BACKEND_FAILURE', 'transport')));
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    expect(
      (await backend.exec('c1', { argv: ['true'], cwd: '/epic-wiki', signal: signal() }))._unsafeUnwrapErr().brokerCode,
    ).toBe('BACKEND_FAILURE');
  });
});

describe('DockerContainerBackend.removeContainer', () => {
  it('force-removes with volumes and treats 204 as success', async () => {
    const { client, calls } = fakeClient(happyScript);
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    expect((await backend.removeContainer('c1')).isOk()).toBe(true);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].path).toContain('/containers/c1');
    expect(calls[0].path).toContain('force=true');
    expect(calls[0].path).toContain('v=true');
  });

  it('treats 404 as success so cleanup stays idempotent', async () => {
    const { client } = fakeClient(() => ok({ status: 404, body: Buffer.alloc(0) }));
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    expect((await backend.removeContainer('c1')).isOk()).toBe(true);
  });

  it('returns BACKEND_FAILURE for other statuses and transport errors', async () => {
    const failing = fakeClient(() => ok({ status: 500, body: Buffer.alloc(0) }));
    const backend = createDockerBackend(failing.client, config)._unsafeUnwrap();
    expect((await backend.removeContainer('c1'))._unsafeUnwrapErr().brokerCode).toBe('BACKEND_FAILURE');

    const broken = fakeClient(() => err(new ExecutionBrokerError('BACKEND_FAILURE', 'transport')));
    const other = createDockerBackend(broken.client, config)._unsafeUnwrap();
    expect((await other.removeContainer('c1'))._unsafeUnwrapErr().brokerCode).toBe('BACKEND_FAILURE');
  });

  it('rejects a container ID that is not safe to place in a URL path', async () => {
    const { client, calls } = fakeClient(happyScript);
    const backend = createDockerBackend(client, config)._unsafeUnwrap();
    expect((await backend.removeContainer('../images/x'))._unsafeUnwrapErr().brokerCode).toBe('INVALID_ARGUMENT');
    expect(calls).toHaveLength(0);
  });
});
