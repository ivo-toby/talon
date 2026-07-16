/** Transaction-aware publication of durable lifecycle events. */

import { types } from 'node:util';
import { err, ok, type Result } from 'neverthrow';

import {
  LifecycleEventRepository,
  type LifecycleDeliveryFanoutInput,
  type LifecycleEventFanoutResult,
} from '../core/database/repositories/index.js';
import {
  snapshotBoundedPlainDataRecord,
  snapshotLifecycleDeliveries,
  snapshotLifecycleEvent,
} from '../core/database/repositories/lifecycle-persistence-validation.js';
import { DbError, LifecycleError } from '../core/errors/index.js';
import {
  LifecycleEventEnvelopeSchema,
  LifecycleFilterOwnerNameSchema,
  LifecycleItemOriginSchema,
  LifecycleItemTypeSchema,
  LifecycleMessageSourceSchema,
  LifecycleScheduleSourceSchema,
  type LifecycleEventEnvelope,
  type LifecycleItemOrigin,
  type LifecycleItemType,
  type LifecycleMessageSource,
  type LifecycleScheduleSource,
} from './contracts/index.js';
import type {
  LifecycleEventResolutionQuery,
  ResolvedLifecycleHandler,
} from './handler-registry.js';
import { TransactionContext } from './transaction-context.js';

/** The stable, registry-owned subset needed to resolve event subscribers. */
export interface LifecycleEventHandlerResolver {
  resolveEventHandlers(query: LifecycleEventResolutionQuery): ResolvedLifecycleHandler[];
}

/** A bounded event envelope plus the scope used to resolve explicit subscriptions. */
export interface LifecycleEventPublishInput {
  event: LifecycleEventEnvelope;
  persona: string;
  itemOrigin?: LifecycleItemOrigin;
  itemType?: LifecycleItemType;
  channel?: string;
  messageSource?: LifecycleMessageSource;
  scheduleSource?: LifecycleScheduleSource;
}

/** Optional nudge for an independent durable dispatcher. */
export type LifecycleDispatcherWake = (eventId: string) => void | Promise<void>;

type LifecycleEventPublishError = DbError | LifecycleError;
type LifecycleTransactionError<E> = E | DbError | LifecycleError;
type DataRecord = Record<string, unknown>;
type SqliteConnection = { readonly inTransaction: boolean };
type TransactionState = 'open' | 'committed' | 'rolled_back';
type AfterCommitCallback = () => void | Promise<void>;

interface OwnedTransactionContext {
  owner: object;
  connection: SqliteConnection;
  state: TransactionState;
  afterCommitCallbacks: AfterCommitCallback[];
}

const PUBLISH_INPUT_KEYS = new Set([
  'event',
  'persona',
  'itemOrigin',
  'itemType',
  'channel',
  'messageSource',
  'scheduleSource',
]);
const MAX_RESOLVED_HANDLERS = 32;
const ownedTransactionContexts = new WeakMap<TransactionContext, OwnedTransactionContext>();

class TransactionRollback<E> extends Error {
  constructor(readonly error: E) {
    super('Lifecycle transaction callback returned Err');
  }
}

function createOwnedTransactionContext(
  owner: object,
  connection: SqliteConnection,
): TransactionContext {
  const context = new TransactionContext();
  ownedTransactionContexts.set(context, {
    owner,
    connection,
    state: 'open',
    afterCommitCallbacks: [],
  });
  return context;
}

function getOpenOwnedTransactionContext(
  context: TransactionContext,
  owner: object,
  connection: SqliteConnection,
): OwnedTransactionContext | null {
  const state = ownedTransactionContexts.get(context);
  return state?.owner === owner && state.connection === connection && state.state === 'open'
    ? state
    : null;
}

function registerAfterCommit(
  context: TransactionContext,
  owner: object,
  connection: SqliteConnection,
  callback: AfterCommitCallback,
): Result<void, LifecycleError> {
  const state = getOpenOwnedTransactionContext(context, owner, connection);
  if (!state) {
    return err(new LifecycleError('Cannot register an after-commit callback on this transaction'));
  }
  state.afterCommitCallbacks.push(callback);
  return ok(undefined);
}

function commitOwnedTransactionContext(
  context: TransactionContext,
  owner: object,
  connection: SqliteConnection,
): void {
  const state = getOpenOwnedTransactionContext(context, owner, connection);
  if (!state) return;

  state.state = 'committed';
  const callbacks = state.afterCommitCallbacks.splice(0);
  for (const callback of callbacks) {
    try {
      // A wake is an optimization over durable state. Consume async failures
      // as well as sync throws so they cannot become unhandled rejections.
      void Promise.resolve(callback()).catch(() => undefined);
    } catch {
      // Pending deliveries remain recoverable by dispatcher polling.
    }
  }
}

function rollbackOwnedTransactionContext(
  context: TransactionContext,
  owner: object,
  connection: SqliteConnection,
): void {
  const state = getOpenOwnedTransactionContext(context, owner, connection);
  if (!state) return;
  state.state = 'rolled_back';
  state.afterCommitCallbacks.splice(0);
}

function getRepositoryConnection(repository: LifecycleEventRepository): SqliteConnection {
  const connection = (repository as unknown as { db?: unknown }).db;
  if (!connection || typeof connection !== 'object' || types.isProxy(connection)) {
    throw new TypeError('Lifecycle event repository has no usable SQLite connection');
  }
  return connection as SqliteConnection;
}

function snapshotRecord(value: unknown, maxKeys: number): DataRecord | null {
  return snapshotBoundedPlainDataRecord(value, maxKeys);
}

function snapshotNativeArray(value: unknown, maxLength: number): unknown[] | null {
  if (types.isProxy(value) || !Array.isArray(value)) return null;
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) return null;
    if (length.value > maxLength) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== 'string')) {
      return null;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return null;
  }
}

function parseOptional<T>(
  value: unknown,
  parser: { safeParse(candidate: unknown): { success: boolean; data?: T } },
): T | undefined | null {
  if (value === undefined) return undefined;
  const parsed = parser.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Materializes all caller-owned publish data without evaluating accessors. */
function materializePublishInput(value: unknown): LifecycleEventPublishInput | null {
  try {
    const input = snapshotRecord(value, PUBLISH_INPUT_KEYS.size);
    if (!input || Object.keys(input).some((key) => !PUBLISH_INPUT_KEYS.has(key))) return null;
    const event = snapshotLifecycleEvent(input.event);
    const parsedEvent = event && LifecycleEventEnvelopeSchema.safeParse(event);
    const persona = LifecycleFilterOwnerNameSchema.safeParse(input.persona);
    const itemOrigin = parseOptional(input.itemOrigin, LifecycleItemOriginSchema);
    const itemType = parseOptional(input.itemType, LifecycleItemTypeSchema);
    const channel = parseOptional(input.channel, LifecycleFilterOwnerNameSchema);
    const messageSource = parseOptional(input.messageSource, LifecycleMessageSourceSchema);
    const scheduleSource = parseOptional(input.scheduleSource, LifecycleScheduleSourceSchema);
    if (
      !parsedEvent?.success ||
      !persona.success ||
      itemOrigin === null ||
      itemType === null ||
      channel === null ||
      messageSource === null ||
      scheduleSource === null
    ) {
      return null;
    }
    return {
      event: parsedEvent.data,
      persona: persona.data,
      ...(itemOrigin === undefined ? {} : { itemOrigin }),
      ...(itemType === undefined ? {} : { itemType }),
      ...(channel === undefined ? {} : { channel }),
      ...(messageSource === undefined ? {} : { messageSource }),
      ...(scheduleSource === undefined ? {} : { scheduleSource }),
    };
  } catch {
    return null;
  }
}

function materializeEvent(value: unknown): LifecycleEventEnvelope | null {
  try {
    const snapshot = snapshotLifecycleEvent(value);
    const parsed = snapshot && LifecycleEventEnvelopeSchema.safeParse(snapshot);
    return parsed?.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Materializes bounded resolver output before repository fan-out validation. */
function materializeResolvedDeliveries(value: unknown): LifecycleDeliveryFanoutInput[] | null {
  const handlers = snapshotNativeArray(value, MAX_RESOLVED_HANDLERS);
  if (!handlers) return null;
  try {
    const candidates: unknown[] = [];
    for (const candidate of handlers) {
      const resolved = snapshotRecord(candidate, 16);
      const handler = resolved && snapshotRecord(resolved.handler, 16);
      const identity = resolved && snapshotRecord(resolved.identity, 16);
      const failurePolicy = resolved && snapshotRecord(resolved.failurePolicy, 4);
      if (!resolved || !handler || !identity || !failurePolicy) return null;
      candidates.push({
        handlerId: handler.id,
        persona: resolved.persona,
        priority: resolved.priority,
        identity,
        failurePolicy,
      });
    }
    const deliveries = snapshotLifecycleDeliveries(candidates);
    return deliveries ? (deliveries as unknown as LifecycleDeliveryFanoutInput[]) : null;
  } catch {
    return null;
  }
}

/**
 * Persists a versioned lifecycle event and its stable subscriber snapshot.
 *
 * A publication with no subscribers remains a valid durable event. Dispatcher
 * wake-ups are deferred until a bus-owned SQLite transaction has committed.
 */
export class LifecycleEventBus {
  readonly #transactionOwner = {};
  readonly #connection: SqliteConnection;

  constructor(
    private readonly eventRepository: LifecycleEventRepository,
    private readonly handlerResolver: LifecycleEventHandlerResolver,
    private readonly wakeDispatcher?: LifecycleDispatcherWake,
  ) {
    this.#connection = getRepositoryConnection(eventRepository);
  }

  /**
   * Owns SQLite transaction lifecycle and its matching TransactionContext.
   * Returning Err rolls back SQLite while preserving the callback's typed error.
   */
  transaction<T, E>(
    callback: (transaction: TransactionContext) => Result<T, E>,
  ): Result<T, LifecycleTransactionError<E>> {
    try {
      if (this.#connection.inTransaction) {
        return err(
          new LifecycleError(
            'Cannot start a lifecycle transaction inside an active SQLite transaction',
          ),
        );
      }
    } catch {
      return err(new DbError('Failed to inspect lifecycle SQLite transaction state'));
    }

    const transaction = createOwnedTransactionContext(this.#transactionOwner, this.#connection);
    let value: T | undefined;
    try {
      this.eventRepository.transaction(() => {
        if (!this.#connection.inTransaction) {
          throw new DbError('Lifecycle transaction is not running on its bound SQLite connection');
        }
        let result: Result<T, E>;
        try {
          result = callback(transaction);
        } catch {
          throw new DbError('Failed to execute lifecycle transaction');
        }
        if (result.isErr()) throw new TransactionRollback(result.error);
        value = result.value;
      });
    } catch (cause) {
      rollbackOwnedTransactionContext(transaction, this.#transactionOwner, this.#connection);
      if (cause instanceof TransactionRollback) {
        return err(cause.error as LifecycleTransactionError<E>);
      }
      return err(
        cause instanceof LifecycleError || cause instanceof DbError
          ? cause
          : new DbError('Failed to execute lifecycle transaction'),
      );
    }

    commitOwnedTransactionContext(transaction, this.#transactionOwner, this.#connection);
    return ok(value as T);
  }

  /** Publishes in a standalone transaction or the active bus-owned transaction. */
  publish(
    input: LifecycleEventPublishInput,
    transaction?: TransactionContext,
  ): Result<LifecycleEventFanoutResult, LifecycleEventPublishError> {
    try {
      if (transaction) return this.publishInTransaction(input, transaction);
      return this.transaction((context) => this.publishInTransaction(input, context));
    } catch {
      return err(new LifecycleError('Failed to publish lifecycle event'));
    }
  }

  /** Validates a caller-held context before it performs an authoritative write. */
  assertTransaction(transaction: TransactionContext): Result<void, LifecycleError> {
    try {
      return this.#connection.inTransaction &&
        getOpenOwnedTransactionContext(transaction, this.#transactionOwner, this.#connection)
        ? ok(undefined)
        : err(new LifecycleError('Cannot use a transaction outside this lifecycle event bus'));
    } catch {
      return err(new LifecycleError('Cannot validate lifecycle transaction authority'));
    }
  }

  /**
   * Validates a supplied derived event against its parent before publication.
   * Derived events retain aggregate, correlation and max depth, use the parent
   * event ID as causation, and advance recursion depth exactly once.
   */
  publishDerived(
    parent: LifecycleEventEnvelope,
    input: LifecycleEventPublishInput,
    transaction?: TransactionContext,
  ): Result<LifecycleEventFanoutResult, LifecycleEventPublishError> {
    try {
      const parentEvent = materializeEvent(parent);
      const derived = materializePublishInput(input);
      if (!parentEvent || !derived) {
        return err(new LifecycleError('Cannot publish an invalid derived lifecycle event'));
      }
      const parentContext = parentEvent.context;
      const context = derived.event.context;
      if (
        parentContext.recursion.depth >= parentContext.recursion.maxDepth ||
        context.aggregate.type !== parentContext.aggregate.type ||
        context.aggregate.id !== parentContext.aggregate.id ||
        context.correlationId !== parentContext.correlationId ||
        context.recursion.maxDepth !== parentContext.recursion.maxDepth ||
        context.recursion.depth !== parentContext.recursion.depth + 1 ||
        context.causationId !== parentEvent.eventId
      ) {
        return err(new LifecycleError('Derived lifecycle event has invalid causal context'));
      }
      return this.publish(derived, transaction);
    } catch {
      return err(new LifecycleError('Failed to publish derived lifecycle event'));
    }
  }

  /** Publishes within the currently active transaction owned by this bus. */
  publishInTransaction(
    input: LifecycleEventPublishInput,
    transaction: TransactionContext,
  ): Result<LifecycleEventFanoutResult, LifecycleEventPublishError> {
    try {
      if (
        !this.#connection.inTransaction ||
        !getOpenOwnedTransactionContext(transaction, this.#transactionOwner, this.#connection)
      ) {
        return err(new LifecycleError('Cannot publish outside this lifecycle transaction'));
      }
      const materialized = materializePublishInput(input);
      if (!materialized) {
        return err(new LifecycleError('Cannot publish an invalid lifecycle event input'));
      }

      let handlers: ResolvedLifecycleHandler[];
      try {
        handlers = this.handlerResolver.resolveEventHandlers({
          persona: materialized.persona,
          eventType: materialized.event.type,
          itemOrigin: materialized.itemOrigin,
          itemType: materialized.itemType,
          channel: materialized.channel,
          messageSource: materialized.messageSource,
          scheduleSource: materialized.scheduleSource,
        });
      } catch {
        return err(new LifecycleError('Failed to resolve lifecycle event subscribers'));
      }
      const deliveries = materializeResolvedDeliveries(handlers);
      if (!deliveries) {
        return err(new LifecycleError('Failed to snapshot lifecycle event subscribers'));
      }

      const publication = this.eventRepository.insertWithDeliveries(materialized.event, deliveries);
      if (publication.isErr()) return publication;

      if (publication.value.deliveries.length > 0 && this.wakeDispatcher) {
        const registered = registerAfterCommit(
          transaction,
          this.#transactionOwner,
          this.#connection,
          () => this.wakeDispatcher?.(publication.value.event.event_id),
        );
        if (registered.isErr()) return err(registered.error);
      }
      return ok(publication.value);
    } catch {
      return err(new LifecycleError('Failed to publish lifecycle event'));
    }
  }
}
