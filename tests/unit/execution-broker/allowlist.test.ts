import { describe, expect, it } from 'vitest';
import {
  checkArgvBounds,
  findGrant,
  parseCreateLeaseInput,
  parseExecuteInput,
} from '../../../src/execution-broker/allowlist.js';
import { ExecutionBrokerError } from '../../../src/execution-broker/errors.js';
import type { OperatorAllowlist, ProfileConfig } from '../../../src/execution-broker/types.js';

const SENTINEL = 'SENTINEL_ARGV_7f3a';

function expectCode(error: unknown, brokerCode: string): void {
  expect(error).toBeInstanceOf(ExecutionBrokerError);
  expect((error as ExecutionBrokerError).brokerCode).toBe(brokerCode);
  expect((error as ExecutionBrokerError).message).not.toContain(SENTINEL);
}

const profile: ProfileConfig = {
  id: 'wiki-maintenance',
  maxTimeoutMs: 60_000,
  outputCapChars: 1_000,
  maxArgvCount: 3,
  maxArgvChars: 10,
  maxConcurrentExecsPerLease: 1,
  maxActiveLeases: 2,
};

const allowlist: OperatorAllowlist = {
  profiles: [profile, { ...profile, id: 'other-profile' }],
  workspaces: [
    { id: 'epic-wiki', hostPath: '/srv/wiki', mountTarget: '/epic-wiki', mode: 'rw' },
    { id: 'other-ws', hostPath: '/srv/other', mountTarget: '/other', mode: 'ro' },
  ],
  grants: [
    { parentPersona: 'wcm', workerPersona: 'worker', profile: 'wiki-maintenance', workspace: 'epic-wiki' },
  ],
};

const lease = {
  taskId: 'task-1',
  parentPersonaId: 'wcm',
  personaId: 'worker',
  profile: 'wiki-maintenance',
  workspace: 'epic-wiki',
};

const exec = {
  leaseId: 'L'.repeat(43),
  taskId: 'task-1',
  personaId: 'worker',
  argv: ['ls', SENTINEL],
  cwd: 'pages',
  timeoutMs: 1_000,
};

describe('parseCreateLeaseInput', () => {
  it('returns a copy of a valid input', () => {
    const parsed = parseCreateLeaseInput(lease)._unsafeUnwrap();
    expect(parsed).toEqual(lease);
    expect(parsed).not.toBe(lease);
  });

  it.each([
    ['null', null],
    ['an array', [lease]],
    ['a string', 'lease'],
    ['an extra key', { ...lease, image: 'alpine' }],
    ['a missing key', { ...lease, taskId: undefined }],
    ['an empty taskId', { ...lease, taskId: '' }],
    ['an overlong personaId', { ...lease, personaId: 'p'.repeat(257) }],
    ['a non-string parentPersonaId', { ...lease, parentPersonaId: 7 }],
    ['an uppercase profile ID', { ...lease, profile: 'Wiki' }],
    ['a profile ID with a space', { ...lease, profile: 'wiki maintenance' }],
    ['a traversal workspace ID', { ...lease, workspace: '../epic-wiki' }],
    ['a workspace ID starting with a dash', { ...lease, workspace: '-wiki' }],
    ['a 64-char profile ID', { ...lease, profile: 'a'.repeat(64) }],
  ])('rejects %s with INVALID_ARGUMENT', (_label, input) => {
    expectCode(parseCreateLeaseInput(input)._unsafeUnwrapErr(), 'INVALID_ARGUMENT');
  });

  it('accepts a 63-char ID and a 256-char persona ID', () => {
    const input = { ...lease, profile: 'a'.repeat(63), personaId: 'p'.repeat(256) };
    expect(parseCreateLeaseInput(input).isOk()).toBe(true);
  });
});

describe('parseExecuteInput', () => {
  it('returns a copy with a copied argv', () => {
    const parsed = parseExecuteInput(exec)._unsafeUnwrap();
    expect(parsed).toEqual(exec);
    expect(parsed.argv).not.toBe(exec.argv);
  });

  it('accepts an empty argv and an empty cwd at the shape stage', () => {
    expect(parseExecuteInput({ ...exec, argv: [], cwd: '' }).isOk()).toBe(true);
  });

  it.each([
    ['null', null],
    ['an extra key', { ...exec, env: { A: '1' } }],
    ['a missing cwd', { ...exec, cwd: undefined }],
    ['a non-string cwd', { ...exec, cwd: 1 }],
    ['argv as a string', { ...exec, argv: 'ls -la' }],
    ['a non-string argv element', { ...exec, argv: ['ls', 3] }],
    ['an empty leaseId', { ...exec, leaseId: '' }],
    ['a non-integer timeout', { ...exec, timeoutMs: 1.5 }],
    ['a zero timeout', { ...exec, timeoutMs: 0 }],
    ['a negative timeout', { ...exec, timeoutMs: -1 }],
    ['a string timeout', { ...exec, timeoutMs: '1000' }],
  ])('rejects %s with INVALID_ARGUMENT', (_label, input) => {
    expectCode(parseExecuteInput(input)._unsafeUnwrapErr(), 'INVALID_ARGUMENT');
  });
});

describe('checkArgvBounds', () => {
  it('accepts argv within count and char budget', () => {
    expect(checkArgvBounds(['ab', 'cd', 'efghij'], profile).isOk()).toBe(true);
  });

  it.each([
    ['an empty argv', []],
    ['too many elements', ['a', 'b', 'c', 'd']],
    ['too many total chars', ['abcdef', 'ghijk']],
  ])('rejects %s with INVALID_ARGUMENT', (_label, argv) => {
    expectCode(checkArgvBounds(argv, profile)._unsafeUnwrapErr(), 'INVALID_ARGUMENT');
  });
});

describe('findGrant', () => {
  it('returns the profile and workspace configs for a granted tuple', () => {
    const grant = findGrant(allowlist, lease)._unsafeUnwrap();
    expect(grant.profile).toBe(allowlist.profiles[0]);
    expect(grant.workspace).toBe(allowlist.workspaces[0]);
  });

  it('reports an unknown profile before an unknown workspace', () => {
    const error = findGrant(allowlist, { ...lease, profile: 'nope', workspace: 'nope' })._unsafeUnwrapErr();
    expectCode(error, 'UNKNOWN_PROFILE');
  });

  it('reports an unknown workspace', () => {
    expectCode(findGrant(allowlist, { ...lease, workspace: 'nope' })._unsafeUnwrapErr(), 'UNKNOWN_WORKSPACE');
  });

  it.each([
    ['parent persona', { parentPersonaId: 'intruder' }],
    ['worker persona', { personaId: 'intruder' }],
    ['profile', { profile: 'other-profile' }],
    ['workspace', { workspace: 'other-ws' }],
  ])('rejects a tuple whose %s is not granted with GRANT_DENIED', (_label, patch) => {
    expectCode(findGrant(allowlist, { ...lease, ...patch })._unsafeUnwrapErr(), 'GRANT_DENIED');
  });
});
