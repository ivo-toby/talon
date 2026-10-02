import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutionBroker,
  ExecutionBrokerError,
  InMemoryContainerBackend,
} from '../../../src/execution-broker/index.js';
import type {
  OperatorAllowlist,
  ProfileConfig,
  WorkspaceConfig,
} from '../../../src/execution-broker/index.js';

const SENTINEL_ARG = 'SENTINEL_ARGV_7f3a';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function profile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    id: 'wiki-maintenance',
    maxTimeoutMs: 60_000,
    outputCapChars: 1_000,
    maxArgvCount: 8,
    maxArgvChars: 200,
    maxConcurrentExecsPerLease: 1,
    maxActiveLeases: 2,
    ...overrides,
  };
}

function workspace(hostPath: string, overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return { id: 'epic-wiki', hostPath, mountTarget: '/epic-wiki', mode: 'ro', ...overrides };
}

function allowlist(hostPath: string, overrides: Partial<OperatorAllowlist> = {}): OperatorAllowlist {
  return {
    profiles: [profile()],
    workspaces: [workspace(hostPath)],
    grants: [
      {
        parentPersona: 'work-context-manager',
        workerPersona: 'work-context-manager',
        profile: 'wiki-maintenance',
        workspace: 'epic-wiki',
      },
    ],
    ...overrides,
  };
}

const validLease = {
  taskId: 'task-1',
  parentPersonaId: 'work-context-manager',
  personaId: 'work-context-manager',
  profile: 'wiki-maintenance',
  workspace: 'epic-wiki',
};

function setup(overrides: Partial<OperatorAllowlist> = {}, diskQuotaEnforced = true) {
  const root = tempDir('broker-ws-');
  const backend = new InMemoryContainerBackend({ diskQuotaEnforced });
  const broker = new ExecutionBroker({ allowlist: allowlist(root, overrides), backend });
  return { root, backend, broker };
}

function expectBrokerError(
  error: unknown,
  brokerCode: string,
  forbidden: string[] = [],
): void {
  expect(error).toBeInstanceOf(ExecutionBrokerError);
  const brokerError = error as ExecutionBrokerError;
  expect(brokerError.code).toBe('EXECUTION_BROKER_ERROR');
  expect(brokerError.brokerCode).toBe(brokerCode);
  expect(brokerError.message).toContain(`[${brokerCode}]`);
  for (const value of forbidden) {
    expect(brokerError.message).not.toContain(value);
  }
}

describe('createLease validation', () => {
  it('creates an opaque lease for a granted tuple without creating a container', async () => {
    const { backend, broker } = setup();
    const result = await broker.createLease(validLease);
    expect(result.isOk()).toBe(true);
    const { leaseId } = result._unsafeUnwrap();
    expect(leaseId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(leaseId).not.toContain('task-1');
    expect(backend.liveContainers()).toEqual([]);
  });

  it('issues distinct lease IDs for identical bindings on different stores', async () => {
    const a = setup();
    const b = setup();
    const first = (await a.broker.createLease(validLease))._unsafeUnwrap().leaseId;
    const second = (await b.broker.createLease(validLease))._unsafeUnwrap().leaseId;
    expect(first).not.toBe(second);
  });

  it('rejects an unknown extra field with INVALID_ARGUMENT', async () => {
    const { backend, broker } = setup();
    const result = await broker.createLease({ ...validLease, image: 'alpine:latest' });
    expectBrokerError(result._unsafeUnwrapErr(), 'INVALID_ARGUMENT');
    expect(backend.liveContainers()).toEqual([]);
  });

  it.each([
    ['non-object input', null],
    ['missing taskId', { ...validLease, taskId: undefined }],
    ['empty personaId', { ...validLease, personaId: '' }],
    ['non-string profile', { ...validLease, profile: 3 }],
    ['malformed profile ID', { ...validLease, profile: 'Wiki Maintenance' }],
    ['malformed workspace ID', { ...validLease, workspace: '../epic-wiki' }],
  ])('rejects %s with INVALID_ARGUMENT', async (_label, input) => {
    const { backend, broker } = setup();
    const result = await broker.createLease(input);
    expectBrokerError(result._unsafeUnwrapErr(), 'INVALID_ARGUMENT');
    expect(backend.liveContainers()).toEqual([]);
  });

  it('rejects an unknown profile with UNKNOWN_PROFILE', async () => {
    const { broker } = setup();
    const result = await broker.createLease({ ...validLease, profile: 'other-profile' });
    expectBrokerError(result._unsafeUnwrapErr(), 'UNKNOWN_PROFILE');
  });

  it('rejects an unknown workspace with UNKNOWN_WORKSPACE', async () => {
    const { broker } = setup();
    const result = await broker.createLease({ ...validLease, workspace: 'other-ws' });
    expectBrokerError(result._unsafeUnwrapErr(), 'UNKNOWN_WORKSPACE');
  });

  it.each([
    ['parent persona', { parentPersonaId: 'intruder' }],
    ['worker persona', { personaId: 'intruder' }],
  ])('rejects an ungranted %s with GRANT_DENIED', async (_label, patch) => {
    const { backend, broker } = setup();
    const result = await broker.createLease({ ...validLease, ...patch });
    expectBrokerError(result._unsafeUnwrapErr(), 'GRANT_DENIED');
    expect(backend.liveContainers()).toEqual([]);
  });

  it('rejects a known profile/workspace pair that no grant binds together', async () => {
    const root = tempDir('broker-ws-');
    const backend = new InMemoryContainerBackend({ diskQuotaEnforced: true });
    const broker = new ExecutionBroker({
      allowlist: {
        profiles: [profile(), profile({ id: 'other-profile' })],
        workspaces: [workspace(root)],
        grants: allowlist(root).grants,
      },
      backend,
    });
    const result = await broker.createLease({ ...validLease, profile: 'other-profile' });
    expectBrokerError(result._unsafeUnwrapErr(), 'GRANT_DENIED');
  });

  it('rejects a read-write workspace when the backend cannot enforce a disk quota', async () => {
    const root = tempDir('broker-ws-');
    const { broker, backend } = setup({ workspaces: [workspace(root, { mode: 'rw' })] }, false);
    const result = await broker.createLease(validLease);
    expectBrokerError(result._unsafeUnwrapErr(), 'QUOTA_UNENFORCEABLE');
    expect(backend.liveContainers()).toEqual([]);
  });

  it('allows a read-only workspace when the backend cannot enforce a disk quota', async () => {
    const { broker } = setup({}, false);
    expect((await broker.createLease(validLease)).isOk()).toBe(true);
  });

  it('rejects leases beyond the profile active-lease limit and frees a slot on revoke', async () => {
    const { broker } = setup();
    const first = (await broker.createLease({ ...validLease, taskId: 't1' }))._unsafeUnwrap();
    expect((await broker.createLease({ ...validLease, taskId: 't2' })).isOk()).toBe(true);
    const third = await broker.createLease({ ...validLease, taskId: 't3' });
    expectBrokerError(third._unsafeUnwrapErr(), 'CONCURRENCY_LIMIT');
    expect((await broker.revoke(first.leaseId)).isOk()).toBe(true);
    expect((await broker.createLease({ ...validLease, taskId: 't3' })).isOk()).toBe(true);
  });
});

describe('execute input validation', () => {
  async function leased() {
    const ctx = setup();
    const { leaseId } = (await ctx.broker.createLease(validLease))._unsafeUnwrap();
    const input = {
      leaseId,
      taskId: validLease.taskId,
      personaId: validLease.personaId,
      argv: ['ls', SENTINEL_ARG],
      cwd: '',
      timeoutMs: 1_000,
    };
    return { ...ctx, leaseId, input };
  }

  it.each(['image', 'env', 'network', 'shell', 'privileged'])(
    'rejects extra field %s with INVALID_ARGUMENT and keeps the lease usable',
    async (field) => {
      const { backend, broker, input, leaseId } = await leased();
      const result = await broker.execute({ ...input, [field]: 'x' });
      expectBrokerError(result._unsafeUnwrapErr(), 'INVALID_ARGUMENT', [leaseId, SENTINEL_ARG]);
      expect(backend.execCalls).toEqual([]);
      expect(backend.liveContainers()).toEqual([]);
      expect((await broker.execute(input)).isOk()).toBe(true);
    },
  );

  it.each([
    ['empty argv', { argv: [] }],
    ['non-string argv element', { argv: ['ls', 3] }],
    ['argv as shell string', { argv: 'ls -la' }],
    ['too many argv elements', { argv: Array.from({ length: 9 }, () => 'a') }],
    ['argv over char budget', { argv: ['x'.repeat(201)] }],
    ['non-integer timeout', { timeoutMs: 1.5 }],
    ['zero timeout', { timeoutMs: 0 }],
    ['missing cwd', { cwd: undefined }],
  ])('rejects %s with INVALID_ARGUMENT', async (_label, patch) => {
    const { backend, broker, input, leaseId } = await leased();
    const result = await broker.execute({ ...input, ...patch });
    expectBrokerError(result._unsafeUnwrapErr(), 'INVALID_ARGUMENT', [leaseId, SENTINEL_ARG]);
    expect(backend.execCalls).toEqual([]);
    expect(backend.liveContainers()).toEqual([]);
  });

  it('rejects a timeout above the profile maximum', async () => {
    const { backend, broker, input } = await leased();
    const result = await broker.execute({ ...input, timeoutMs: 60_001 });
    expectBrokerError(result._unsafeUnwrapErr(), 'TIMEOUT_EXCEEDS_PROFILE');
    expect(backend.execCalls).toEqual([]);
  });

  it('rejects an escaping cwd before any container is created', async () => {
    const { backend, broker, input, leaseId } = await leased();
    const result = await broker.execute({ ...input, cwd: '../etc' });
    expectBrokerError(result._unsafeUnwrapErr(), 'CWD_OUTSIDE_WORKSPACE', [leaseId, SENTINEL_ARG]);
    expect(backend.liveContainers()).toEqual([]);
    expect(backend.execCalls).toEqual([]);
  });

  it('rejects an unknown lease with LEASE_NOT_FOUND without echoing it', async () => {
    const { backend, broker, input } = await leased();
    const bogus = 'A'.repeat(43);
    const result = await broker.execute({ ...input, leaseId: bogus });
    expectBrokerError(result._unsafeUnwrapErr(), 'LEASE_NOT_FOUND', [bogus]);
    expect(backend.execCalls).toEqual([]);
  });

  it.each([
    ['taskId', { taskId: 'task-2' }],
    ['personaId', { personaId: 'someone-else' }],
  ])('rejects a caller whose %s differs from the binding with LEASE_MISMATCH', async (_label, patch) => {
    const { backend, broker, input, leaseId } = await leased();
    const result = await broker.execute({ ...input, ...patch });
    expectBrokerError(result._unsafeUnwrapErr(), 'LEASE_MISMATCH', [leaseId]);
    expect(backend.execCalls).toEqual([]);
    expect(backend.liveContainers()).toEqual([]);
  });

  it('rejects execute on a revoked lease with LEASE_REVOKED', async () => {
    const { backend, broker, input, leaseId } = await leased();
    expect((await broker.revoke(leaseId)).isOk()).toBe(true);
    const result = await broker.execute(input);
    expectBrokerError(result._unsafeUnwrapErr(), 'LEASE_REVOKED', [leaseId]);
    expect(backend.execCalls).toEqual([]);
  });
});
