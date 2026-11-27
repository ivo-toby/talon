import { TalonError } from '../core/errors/error-types.js';
import type { ExecutionBrokerErrorCode } from './types.js';

/**
 * Execution-broker contract error.
 *
 * Constraint: `detail` must never carry lease IDs, argv elements, command
 * output, host paths, or a cause's message; the cause travels only in `cause`.
 */
export class ExecutionBrokerError extends TalonError {
  readonly code = 'EXECUTION_BROKER_ERROR' as const;
  readonly brokerCode: ExecutionBrokerErrorCode;

  constructor(brokerCode: ExecutionBrokerErrorCode, detail: string, cause?: Error) {
    super(`execution_broker: [${brokerCode}] ${detail}`, cause);
    this.brokerCode = brokerCode;
  }
}
