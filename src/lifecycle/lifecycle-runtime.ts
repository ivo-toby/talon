/**
 * Daemon-owned lifecycle runtime facade.
 *
 * It deliberately exposes the event bus transaction boundary instead of the
 * underlying repositories, so domain publishers cannot accidentally wake a
 * dispatcher before the authoritative SQLite commit.
 */

import { type Result } from 'neverthrow';

import type { DbError, LifecycleError } from '../core/errors/index.js';
import type { LifecycleEventFanoutResult } from '../core/database/repositories/index.js';
import type { LifecycleInterceptorEnvelope } from './contracts/index.js';
import type { LifecycleDispatcher } from './lifecycle-dispatcher.js';
import { LifecycleEventBus, type LifecycleEventPublishInput } from './lifecycle-event-bus.js';
import {
  LifecycleInterceptorEngine,
  type LifecycleInterceptorExecution,
  type LifecycleInterceptorInvocation,
} from './interceptors/interceptor-engine.js';
import type { TransactionContext } from './transaction-context.js';

export class LifecycleRuntime {
  constructor(
    private readonly eventBus: LifecycleEventBus,
    private readonly interceptorEngine: LifecycleInterceptorEngine,
    readonly dispatcher: LifecycleDispatcher,
  ) {}

  transaction<T, E>(
    callback: (transaction: TransactionContext) => Result<T, E>,
  ): Result<T, E | DbError | LifecycleError> {
    return this.eventBus.transaction(callback);
  }

  publish(
    input: LifecycleEventPublishInput,
    transaction?: TransactionContext,
  ): Result<LifecycleEventFanoutResult, DbError | LifecycleError> {
    return this.eventBus.publish(input, transaction);
  }

  assertTransaction(transaction: TransactionContext): Result<void, LifecycleError> {
    return this.eventBus.assertTransaction(transaction);
  }

  intercept(
    invocation: LifecycleInterceptorInvocation,
    input: LifecycleInterceptorEnvelope,
  ): Result<LifecycleInterceptorExecution, LifecycleError> {
    return this.interceptorEngine.intercept(invocation, input);
  }

  start(): void {
    this.dispatcher.start();
  }

  async stop(): Promise<boolean> {
    await this.dispatcher.stop();
    return this.dispatcher.snapshot().inFlight === 0;
  }

  async waitForDrain(): Promise<void> {
    while (this.dispatcher.snapshot().inFlight > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}
