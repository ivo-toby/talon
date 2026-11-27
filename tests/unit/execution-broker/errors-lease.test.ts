import { describe, expect, it } from 'vitest';
import { ExecutionBrokerError } from '../../../src/execution-broker/errors.js';
import { LeaseStore } from '../../../src/execution-broker/lease.js';

function expectBrokerError(error: unknown, brokerCode: string, forbidden: string[] = []): void {
  expect(error).toBeInstanceOf(ExecutionBrokerError);
  const brokerError = error as ExecutionBrokerError;
  expect(brokerError.code).toBe('EXECUTION_BROKER_ERROR');
  expect(brokerError.brokerCode).toBe(brokerCode);
  expect(brokerError.message).toContain(`[${brokerCode}]`);
  for (const value of forbidden) {
    expect(brokerError.message).not.toContain(value);
  }
}

describe('ExecutionBrokerError', () => {
  it('carries a broker code and bracket-code message', () => {
    const error = new ExecutionBrokerError('GRANT_DENIED', 'tuple not granted');
    expect(error.code).toBe('EXECUTION_BROKER_ERROR');
    expect(error.brokerCode).toBe('GRANT_DENIED');
    expect(error.message).toBe('execution_broker: [GRANT_DENIED] tuple not granted');
    expect(error.name).toBe('ExecutionBrokerError');
    expect(error).toBeInstanceOf(Error);
  });

  it('keeps the cause out of the message', () => {
    const cause = new Error('secret-ish backend detail');
    const error = new ExecutionBrokerError('BACKEND_FAILURE', 'container exec failed', cause);
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('secret-ish');
  });
});

describe('LeaseStore', () => {
  const binding = { taskId: 't', personaId: 'p', profile: 'wiki-maintenance', workspace: 'epic-wiki' };

  it('stores a frozen binding under a random opaque base64url ID', () => {
    const store = new LeaseStore();
    const leaseId = store.create(binding);
    expect(leaseId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const record = store.get(leaseId)._unsafeUnwrap();
    expect(record.leaseId).toBe(leaseId);
    expect(record.status).toBe('active');
    expect(record.binding).toEqual(binding);
    expect(Object.isFrozen(record.binding)).toBe(true);
    expect(store.create(binding)).not.toBe(leaseId);
  });

  it('does not share the caller binding object', () => {
    const store = new LeaseStore();
    const mutable = { ...binding };
    const leaseId = store.create(mutable);
    mutable.workspace = 'elsewhere';
    expect(store.get(leaseId)._unsafeUnwrap().binding.workspace).toBe('epic-wiki');
  });

  it('reports unknown and revoked leases distinctly and revokes idempotently', () => {
    const store = new LeaseStore();
    const leaseId = store.create(binding);
    expectBrokerError(store.get('nope')._unsafeUnwrapErr(), 'LEASE_NOT_FOUND', ['nope']);
    expect(store.revoke(leaseId).isOk()).toBe(true);
    expect(store.revoke(leaseId).isOk()).toBe(true);
    expectBrokerError(store.get(leaseId)._unsafeUnwrapErr(), 'LEASE_REVOKED', [leaseId]);
    expectBrokerError(store.revoke('nope')._unsafeUnwrapErr(), 'LEASE_NOT_FOUND', ['nope']);
  });

  it('counts only active leases per profile', () => {
    const store = new LeaseStore();
    const a = store.create(binding);
    store.create(binding);
    store.create({ ...binding, profile: 'other' });
    expect(store.activeCount('wiki-maintenance')).toBe(2);
    store.revoke(a);
    expect(store.activeCount('wiki-maintenance')).toBe(1);
    expect(store.activeCount('other')).toBe(1);
    expect(store.activeCount('missing')).toBe(0);
  });
});
