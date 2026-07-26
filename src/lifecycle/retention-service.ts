/** Lifecycle event retention and privacy tombstoning orchestration. */

import { err, ok, type Result } from 'neverthrow';
import type { AuditLogger } from '../core/logging/audit-logger.js';
import { DbError, LifecycleError } from '../core/errors/index.js';
import type {
  LifecycleDeliveryRepository,
  LifecycleEventRepository,
} from '../core/database/repositories/index.js';
import { LifecycleFilterOwnerNameSchema, LifecycleRuntimeIdSchema } from './contracts/index.js';

export interface LifecycleRetentionServiceOptions {
  readonly events: Pick<
    LifecycleEventRepository,
    'compactCompletedBefore' | 'tombstoneThread' | 'tombstonePersona' | 'transaction'
  >;
  readonly deliveries: Pick<LifecycleDeliveryRepository, 'tombstoneThread' | 'tombstonePersona'>;
  readonly auditLogger?: Pick<AuditLogger, 'logLifecycleDecision'>;
  readonly clock?: () => number;
}

export interface LifecycleRetentionResult {
  readonly compactedEvents: number;
  readonly disabledDeliveries: number;
}

type LifecycleRetentionError = DbError | LifecycleError;

export class LifecycleRetentionService {
  private readonly clock: () => number;

  constructor(private readonly options: LifecycleRetentionServiceOptions) {
    this.clock = options.clock ?? Date.now;
  }

  compactCompleted(
    auditWindowMs: number,
  ): Result<LifecycleRetentionResult, LifecycleRetentionError> {
    if (
      !Number.isSafeInteger(auditWindowMs) ||
      auditWindowMs < 0 ||
      !Number.isSafeInteger(this.clock())
    ) {
      return err(new LifecycleError('invalid lifecycle retention audit window'));
    }
    const cutoff = this.clock() - auditWindowMs;
    if (!Number.isSafeInteger(cutoff)) {
      return err(new LifecycleError('invalid lifecycle retention cutoff'));
    }
    const compacted = this.options.events.compactCompletedBefore(cutoff);
    if (compacted.isErr()) return err(compacted.error);
    const result = {
      compactedEvents: compacted.value.compactedEvents,
      disabledDeliveries: 0,
    };
    this.audit('retention_compact', result);
    return ok(result);
  }

  tombstoneThread(threadId: string): Result<LifecycleRetentionResult, LifecycleRetentionError> {
    if (!LifecycleRuntimeIdSchema.safeParse(threadId).success) {
      return err(new LifecycleError('invalid lifecycle privacy thread id'));
    }
    return this.atomicPrivacyMutation('privacy_thread', () => {
      const deliveries = this.options.deliveries.tombstoneThread(threadId);
      if (deliveries.isErr()) return err(deliveries.error);
      const events = this.options.events.tombstoneThread(threadId);
      if (events.isErr()) return err(events.error);
      return ok({
        compactedEvents: events.value.compactedEvents,
        disabledDeliveries: deliveries.value.disabledDeliveries,
      });
    });
  }

  tombstonePersona(persona: string): Result<LifecycleRetentionResult, LifecycleRetentionError> {
    if (!LifecycleFilterOwnerNameSchema.safeParse(persona).success) {
      return err(new LifecycleError('invalid lifecycle privacy persona'));
    }
    return this.atomicPrivacyMutation('privacy_persona', () => {
      const deliveries = this.options.deliveries.tombstonePersona(persona);
      if (deliveries.isErr()) return err(deliveries.error);
      const events = this.options.events.tombstonePersona(persona);
      if (events.isErr()) return err(events.error);
      return ok({
        compactedEvents: events.value.compactedEvents,
        disabledDeliveries: deliveries.value.disabledDeliveries,
      });
    });
  }

  private atomicPrivacyMutation(
    operation: 'privacy_thread' | 'privacy_persona',
    mutate: () => Result<LifecycleRetentionResult, DbError>,
  ): Result<LifecycleRetentionResult, LifecycleRetentionError> {
    let domainError: DbError | undefined;
    try {
      const result = this.options.events.transaction(() => {
        const mutation = mutate();
        if (mutation.isErr()) {
          domainError = mutation.error;
          throw mutation.error;
        }
        return mutation.value;
      });
      this.audit(operation, result);
      return ok(result);
    } catch {
      return err(domainError ?? new DbError('Failed to apply lifecycle privacy tombstone'));
    }
  }

  private audit(operation: string, result: LifecycleRetentionResult): void {
    try {
      this.options.auditLogger?.logLifecycleDecision({
        action: 'lifecycle.retention',
        details: {
          operation,
          outcome: 'success',
          compactedEvents: result.compactedEvents,
          disabledDeliveries: result.disabledDeliveries,
        },
      });
    } catch {
      // Retention durability is decided by SQLite; audit logging is advisory.
    }
  }
}
