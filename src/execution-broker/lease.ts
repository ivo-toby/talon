import { randomBytes } from 'node:crypto';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { ExecutionBrokerError } from './errors.js';
import type { LeaseBinding, LeaseRecord } from './types.js';

/**
 * In-memory lease store (no persistence in this phase).
 *
 * Constraint: revoked leases stay as tombstones so later lookups report
 * LEASE_REVOKED rather than LEASE_NOT_FOUND, and error details never
 * echo the lease ID.
 */
export class LeaseStore {
  private readonly leases = new Map<string, LeaseRecord>();

  /** Copies and freezes the binding so caller mutations have no effect. */
  create(binding: LeaseBinding): string {
    const frozen: LeaseBinding = Object.freeze({ ...binding });
    const leaseId = randomBytes(32).toString('base64url');
    this.leases.set(leaseId, { leaseId, binding: frozen, status: 'active' });
    return leaseId;
  }

  get(leaseId: string): Result<LeaseRecord, ExecutionBrokerError> {
    const record = this.leases.get(leaseId);
    if (record === undefined) {
      return err(new ExecutionBrokerError('LEASE_NOT_FOUND', 'no lease for this request'));
    }
    if (record.status === 'revoked') {
      return err(new ExecutionBrokerError('LEASE_REVOKED', 'the lease is revoked and terminal'));
    }
    return ok(record);
  }

  revoke(leaseId: string): Result<void, ExecutionBrokerError> {
    const record = this.leases.get(leaseId);
    if (record === undefined) {
      return err(new ExecutionBrokerError('LEASE_NOT_FOUND', 'no lease for this request'));
    }
    if (record.status === 'active') {
      record.status = 'revoked';
    }
    return ok(undefined);
  }

  activeCount(profile: string): number {
    let count = 0;
    for (const record of this.leases.values()) {
      if (record.status === 'active' && record.binding.profile === profile) {
        count += 1;
      }
    }
    return count;
  }
}
