import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDockerBackend,
  createDockerEngineClient,
  ExecutionBroker,
} from '../../src/execution-broker/index.js';
import type { OperatorAllowlist } from '../../src/execution-broker/index.js';

/**
 * Real-Docker run of the broker. Skipped unless TALON_DOCKER_IT_IMAGE names a
 * digest-pinned image that already exists locally and provides `sh` and `sleep`
 * (nothing is pulled), and the Docker socket is readable.
 *
 *   TALON_DOCKER_IT_IMAGE='repo/name@sha256:<64 hex>' npx vitest run tests/integration/execution-broker-docker.test.ts
 */
const IMAGE = process.env.TALON_DOCKER_IT_IMAGE ?? '';
const SOCKET = process.env.TALON_DOCKER_SOCKET ?? '/var/run/docker.sock';
const enabled = IMAGE !== '' && existsSync(SOCKET);

function containerIds(): string[] {
  return execFileSync('docker', ['ps', '-aq', '--no-trunc'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
}

describe.skipIf(!enabled)('execution broker against a real Docker daemon', () => {
  let dir: string;
  let before: string[];
  let broker: ExecutionBroker;

  const allowlist = (hostPath: string): OperatorAllowlist => ({
    profiles: [
      {
        id: 'it',
        maxTimeoutMs: 20_000,
        outputCapChars: 10_000,
        maxArgvCount: 8,
        maxArgvChars: 500,
        maxConcurrentExecsPerLease: 2,
        maxActiveLeases: 4,
      },
    ],
    workspaces: [{ id: 'wiki', hostPath, mountTarget: '/epic-wiki', mode: 'ro' }],
    grants: [{ parentPersona: 'parent', workerPersona: 'worker', profile: 'it', workspace: 'wiki' }],
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'broker-it-'));
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, 'note.txt'), 'wiki content\n');
    chmodSync(join(dir, 'note.txt'), 0o644);
    before = containerIds();
    const backend = createDockerBackend(createDockerEngineClient({ socketPath: SOCKET }), {
      image: IMAGE,
      user: '10001:10001',
      memoryBytes: 256 * 1024 * 1024,
      pidsLimit: 64,
      nanoCpus: 1_000_000_000,
      tmpfsSizeBytes: 16 * 1024 * 1024,
      diskQuotaEnforced: false,
    })._unsafeUnwrap();
    broker = new ExecutionBroker({ allowlist: allowlist(dir), backend });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function exec(leaseId: string, taskId: string, argv: string[], timeoutMs = 15_000) {
    return broker.execute({ leaseId, taskId, personaId: 'worker', argv, cwd: '', timeoutMs });
  }

  it('runs a command: stdout, stderr and exit code come back, workspace is readable', async () => {
    const taskId = 'task-basic';
    const created = await broker.createLease({
      taskId,
      parentPersonaId: 'parent',
      personaId: 'worker',
      profile: 'it',
      workspace: 'wiki',
    });
    const leaseId = created._unsafeUnwrap().leaseId;
    const result = (
      await exec(leaseId, taskId, ['sh', '-c', 'cat /epic-wiki/note.txt; echo oops >&2; exit 3'])
    )._unsafeUnwrap();
    expect(result.stdout).toBe('wiki content\n');
    expect(result.stderr).toBe('oops\n');
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    (await broker.revoke(leaseId))._unsafeUnwrap();
  }, 60_000);

  it('applies the hardened posture: non-root, read-only workspace and rootfs, no network, no capabilities', async () => {
    const taskId = 'task-posture';
    const leaseId = (
      await broker.createLease({
        taskId,
        parentPersonaId: 'parent',
        personaId: 'worker',
        profile: 'it',
        workspace: 'wiki',
      })
    )._unsafeUnwrap().leaseId;
    const script = [
      'echo uid=$(id -u)',
      'touch /epic-wiki/x 2>/dev/null && echo wiki=writable || echo wiki=readonly',
      'touch /etc/x 2>/dev/null && echo rootfs=writable || echo rootfs=readonly',
      'touch /tmp/x 2>/dev/null && echo tmp=writable || echo tmp=readonly',
      'grep -E "^CapEff" /proc/self/status',
      'ls /sys/class/net | tr "\\n" " "',
    ].join('; ');
    const out = (await exec(leaseId, taskId, ['sh', '-c', script]))._unsafeUnwrap().stdout;
    expect(out).toContain('uid=10001');
    expect(out).toContain('wiki=readonly');
    expect(out).toContain('rootfs=readonly');
    expect(out).toContain('tmp=writable');
    expect(out).toMatch(/CapEff:\s+0000000000000000/);
    expect(out).toMatch(/lo\s*$/);
    (await broker.revoke(leaseId))._unsafeUnwrap();
  }, 60_000);

  it('makes a timed-out lease terminal and removes its container', async () => {
    const taskId = 'task-timeout';
    const leaseId = (
      await broker.createLease({
        taskId,
        parentPersonaId: 'parent',
        personaId: 'worker',
        profile: 'it',
        workspace: 'wiki',
      })
    )._unsafeUnwrap().leaseId;
    const result = (await exec(leaseId, taskId, ['sleep', '30'], 1_500))._unsafeUnwrap();
    expect(result.timedOut).toBe(true);
    const next = await exec(leaseId, taskId, ['true']);
    expect(next._unsafeUnwrapErr().brokerCode).toBe('LEASE_REVOKED');
  }, 60_000);

  it('removes every container it created', () => {
    expect(containerIds()).toEqual(before);
  });
});
