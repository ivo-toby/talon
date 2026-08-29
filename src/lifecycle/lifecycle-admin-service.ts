/** Operator-facing lifecycle administration primitives. */

import { err, ok, type Result } from 'neverthrow';
import type { AuditLogger } from '../core/logging/audit-logger.js';
import { DbError, LifecycleError } from '../core/errors/index.js';
import type {
  LifecycleDeliveryRepository,
  LifecycleDeliveryRow,
} from '../core/database/repositories/index.js';
import { LifecycleIdentifierSchema, LifecycleRuntimeIdSchema } from './contracts/index.js';

export interface LifecycleAdminServiceOptions {
  readonly deliveries: Pick<LifecycleDeliveryRepository, 'reopen' | 'disableHandler'>;
  readonly auditLogger?: Pick<AuditLogger, 'logLifecycleDisablement'>;
}

export interface LifecycleDisableHandlerResult {
  readonly handlerId: string;
  readonly disabledDeliveries: number;
}

type LifecycleAdminError = DbError | LifecycleError;

export class LifecycleAdminService {
  constructor(private readonly options: LifecycleAdminServiceOptions) {}

  replayDelivery(
    eventId: string,
    handlerId: string,
  ): Result<LifecycleDeliveryRow, LifecycleAdminError> {
    if (
      !LifecycleRuntimeIdSchema.safeParse(eventId).success ||
      !LifecycleIdentifierSchema.safeParse(handlerId).success
    ) {
      return err(new LifecycleError('invalid lifecycle replay delivery identity'));
    }
    return this.options.deliveries.reopen(eventId, handlerId);
  }

  disableHandler(handlerId: string): Result<LifecycleDisableHandlerResult, LifecycleAdminError> {
    if (!LifecycleIdentifierSchema.safeParse(handlerId).success) {
      return err(new LifecycleError('invalid lifecycle handler id'));
    }
    const disabled = this.options.deliveries.disableHandler(handlerId);
    if (disabled.isErr()) return err(disabled.error);
    const result = {
      handlerId,
      disabledDeliveries: disabled.value.disabledDeliveries,
    };
    try {
      this.options.auditLogger?.logLifecycleDisablement({
        action: 'lifecycle.disablement',
        details: {
          operation: 'handler_disable',
          outcome: 'success',
          handlerId,
          disabledDeliveries: result.disabledDeliveries,
        },
      });
    } catch {
      // Disablement has already committed. Audit outages are advisory.
    }
    return ok(result);
  }
}
