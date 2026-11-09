import type { Result } from 'neverthrow';
import type { ExecutionBrokerError } from './errors.js';
import type { ExecutionResult } from './types.js';

/** The slice of `ExecutionBroker` that the HTTP layer may call. */
export interface BrokerApi {
  createLease(input: unknown): Promise<Result<{ leaseId: string }, ExecutionBrokerError>>;
  execute(input: unknown): Promise<Result<ExecutionResult, ExecutionBrokerError>>;
  revoke(leaseId: string): Promise<Result<void, ExecutionBrokerError>>;
}

export interface BrokerHttpServerOptions {
  /** Bearer token. Must be at least 32 characters, otherwise INVALID_ARGUMENT. */
  token: string;
  broker: BrokerApi;
  /** Backs `GET /readyz`. Default: always ready. A throw or `false` is a 503. */
  isReady?: (signal: AbortSignal) => Promise<boolean>;
  /** Request body cap in bytes. Default 1_000_000. */
  maxBodyBytes?: number;
}
