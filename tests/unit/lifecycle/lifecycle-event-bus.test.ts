import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import {
  BaseRepository,
  LifecycleDeliveryRepository,
  LifecycleEventRepository,
} from '../../../src/core/database/repositories/index.js';
import type { LifecycleEventEnvelope } from '../../../src/lifecycle/contracts/index.js';
import type {
  LifecycleEventResolutionQuery,
  ResolvedLifecycleHandler,
} from '../../../src/lifecycle/handler-registry.js';
import {
  LifecycleEventBus,
  type LifecycleDispatcherWake,
  type LifecycleEventHandlerResolver,
  type LifecycleEventPublishInput,
} from '../../../src/lifecycle/lifecycle-event-bus.js';
import { TransactionContext } from '../../../src/lifecycle/transaction-context.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('LifecycleEventBus', () => {
  let db: Database.Database;
  let events: LifecycleEventRepository;
  let deliveries: LifecycleDeliveryRepository;
  let handlers: ResolvedLifecycleHandler[];
  let resolver: LifecycleEventHandlerResolver;
  let wakeDispatcher: ReturnType<typeof vi.fn<LifecycleDispatcherWake>>;

  beforeEach(() => {
    BaseRepository.__resetMonotonicClockForTests();
    db = createTestDb();
    events = new LifecycleEventRepository(db);
    deliveries = new LifecycleDeliveryRepository(db);
    handlers = [];
    resolver = {
      resolveEventHandlers: (query: LifecycleEventResolutionQuery): ResolvedLifecycleHandler[] => {
        expect(query).toMatchObject({ persona: 'support', eventType: 'run.completed.v1' });
        return handlers;
      },
    };
    wakeDispatcher = vi.fn<LifecycleDispatcherWake>();
  });

  afterEach(() => {
    db?.close();
  });

  function event(overrides: Partial<LifecycleEventEnvelope> = {}): LifecycleEventEnvelope {
    return {
      version: 'v1',
      eventId: uuid(),
      type: 'run.completed.v1',
      occurredAt: '2026-07-16T10:00:00.000Z',
      context: {
        aggregate: { type: 'thread', id: `thread-${uuid()}` },
        correlationId: uuid(),
        causationId: uuid(),
        recursion: { depth: 1, maxDepth: 4 },
        provenance: { source: 'daemon', sourceEventIds: [uuid()] },
      },
      payload: {
        references: [{ type: 'run', id: uuid() }],
        metadata: { outcome: 'completed' },
      },
      ...overrides,
    };
  }

  function handler(handlerId: string, priority: number): ResolvedLifecycleHandler {
    return {
      persona: 'support',
      priority,
      handler: {
        id: handlerId,
        version: 'v1',
        displayName: handlerId,
        runtimeKind: 'native',
        implementationRef: handlerId,
        implementationVersion: '1.0.0',
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
      identity: {
        version: 'v1',
        handlerId,
        runtimeKind: 'native',
        implementationRef: handlerId,
        implementationVersion: '1.0.0',
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
      subscription: {
        kind: 'event',
        events: [{ version: 'v1', type: 'run.completed.v1' }],
      },
      failurePolicy: { version: 'v1', mode: 'dead_letter' },
    };
  }

  function writeDomainRow(name: string): void {
    db.prepare(
      `INSERT INTO channels (id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(uuid(), 'terminal', name, Date.now(), Date.now());
  }

  function domainRowCount(name: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS count FROM channels WHERE name = ?`).get(name) as {
        count: number;
      }
    ).count;
  }

  function input(eventValue: LifecycleEventEnvelope): LifecycleEventPublishInput {
    return { event: eventValue, persona: 'support' };
  }

  it('atomically commits a domain write, event, and stable handler snapshot before waking', () => {
    handlers = [handler('first-handler', 1), handler('second-handler', 10)];
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const eventValue = event();
    const domainName = `domain-${uuid()}`;

    const published = bus.transaction((transaction) => {
      writeDomainRow(domainName);
      const result = bus.publish(input(eventValue), transaction);
      expect(wakeDispatcher).not.toHaveBeenCalled();
      expect((transaction as unknown as { commit?: unknown }).commit).toBeUndefined();
      return result;
    });

    expect(published.isOk()).toBe(true);
    expect(domainRowCount(domainName)).toBe(1);
    expect(published._unsafeUnwrap().deliveries.map((delivery) => delivery.handler_id)).toEqual([
      'second-handler',
      'first-handler',
    ]);
    expect(deliveries.findByEventId(eventValue.eventId)._unsafeUnwrap()).toHaveLength(2);
    expect(wakeDispatcher).toHaveBeenCalledOnce();
    expect(wakeDispatcher).toHaveBeenCalledWith(eventValue.eventId);
  });

  it('rolls back a domain write when publication returns Err and preserves the typed Err', () => {
    handlers = [handler('run-handler', 0)];
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const invalid = event({ payload: { references: [], metadata: { detail: 'x'.repeat(1_025) } } });
    const domainName = `rollback-${uuid()}`;

    const published = bus.transaction((transaction) => {
      writeDomainRow(domainName);
      return bus.publish(input(invalid), transaction);
    });

    expect(published.isErr()).toBe(true);
    expect(published._unsafeUnwrapErr().code).toBe('LIFECYCLE_ERROR');
    expect(domainRowCount(domainName)).toBe(0);
    expect(events.findById(invalid.eventId)._unsafeUnwrap()).toBeNull();
    expect(wakeDispatcher).not.toHaveBeenCalled();
  });

  it('rolls back the owned transaction when its callback throws', () => {
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const domainName = `throw-${uuid()}`;

    const outcome = bus.transaction(() => {
      writeDomainRow(domainName);
      throw new Error('transaction callback failure');
    });

    expect(outcome.isErr()).toBe(true);
    expect(outcome._unsafeUnwrapErr().code).toBe('DB_ERROR');
    expect(domainRowCount(domainName)).toBe(0);
    expect(wakeDispatcher).not.toHaveBeenCalled();
  });

  it('rejects a transaction context owned by a different event bus', () => {
    const owner = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const foreignBus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const inputEvent = event();

    const published = owner.transaction((transaction) =>
      foreignBus.publish(input(inputEvent), transaction),
    );

    expect(published.isErr()).toBe(true);
    expect(published._unsafeUnwrapErr().code).toBe('LIFECYCLE_ERROR');
    expect(events.findById(inputEvent.eventId)._unsafeUnwrap()).toBeNull();
  });

  it('does not trust shadowed transaction methods when a foreign bus publishes', () => {
    const owner = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const foreignBus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const inputEvent = event();
    const shadowedAfterCommit = vi.fn();

    const published = owner.transaction((transaction) => {
      Object.assign(transaction, {
        isOpenFor: () => true,
        afterCommit: shadowedAfterCommit,
      });
      return foreignBus.publish(input(inputEvent), transaction);
    });

    expect(published.isErr()).toBe(true);
    expect(shadowedAfterCommit).not.toHaveBeenCalled();
    expect(events.findById(inputEvent.eventId)._unsafeUnwrap()).toBeNull();
    expect(wakeDispatcher).not.toHaveBeenCalled();
  });

  it('rejects proxied and forged transaction contexts without invoking proxy traps', () => {
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const inputEvent = event();
    const proxyTrap = vi.fn(() => {
      throw new Error('transaction context proxy trap must not run');
    });
    const forged = new TransactionContext();

    expect(bus.publish(input(inputEvent), forged).isErr()).toBe(true);
    const proxied = bus.transaction((transaction) =>
      bus.publish(
        input(inputEvent),
        new Proxy(transaction, {
          get: proxyTrap,
          getOwnPropertyDescriptor: proxyTrap,
          getPrototypeOf: proxyTrap,
          ownKeys: proxyTrap,
        }),
      ),
    );

    expect(proxied.isErr()).toBe(true);
    expect(proxyTrap).not.toHaveBeenCalled();
    expect(events.findById(inputEvent.eventId)._unsafeUnwrap()).toBeNull();
  });

  it('rolls back the owner transaction and never writes through a different SQLite connection', () => {
    const foreignDb = createTestDb();
    try {
      handlers = [handler('run-handler', 0)];
      const owner = new LifecycleEventBus(events, resolver, wakeDispatcher);
      const foreignEvents = new LifecycleEventRepository(foreignDb);
      const foreignBus = new LifecycleEventBus(foreignEvents, resolver, wakeDispatcher);
      const foreignEvent = event();
      const domainName = `cross-connection-${uuid()}`;

      const published = owner.transaction((transaction) => {
        writeDomainRow(domainName);
        return foreignBus.publish(input(foreignEvent), transaction);
      });

      expect(published.isErr()).toBe(true);
      expect(domainRowCount(domainName)).toBe(0);
      expect(foreignEvents.findById(foreignEvent.eventId)._unsafeUnwrap()).toBeNull();
      expect(wakeDispatcher).not.toHaveBeenCalled();
    } finally {
      foreignDb.close();
    }
  });

  it('rejects nested lifecycle transactions even if the surrounding SQLite transaction commits', () => {
    handlers = [handler('run-handler', 0)];
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const inputEvent = event();

    const nested = events.transaction(() =>
      bus.transaction((transaction) => bus.publish(input(inputEvent), transaction)),
    );

    expect(nested.isErr()).toBe(true);
    expect(events.findById(inputEvent.eventId)._unsafeUnwrap()).toBeNull();
    expect(wakeDispatcher).not.toHaveBeenCalled();
  });

  it('rejects nested lifecycle transactions when the surrounding SQLite transaction rolls back', () => {
    handlers = [handler('run-handler', 0)];
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const inputEvent = event();

    expect(() =>
      events.transaction(() => {
        const nested = bus.transaction((transaction) =>
          bus.publish(input(inputEvent), transaction),
        );
        expect(nested.isErr()).toBe(true);
        throw new Error('outer transaction rollback');
      }),
    ).toThrow('outer transaction rollback');

    expect(events.findById(inputEvent.eventId)._unsafeUnwrap()).toBeNull();
    expect(wakeDispatcher).not.toHaveBeenCalled();
  });

  it('rejects standalone publication inside an existing SQLite transaction', () => {
    handlers = [handler('run-handler', 0)];
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const inputEvent = event();

    const published = events.transaction(() => bus.publish(input(inputEvent)));

    expect(published.isErr()).toBe(true);
    expect(events.findById(inputEvent.eventId)._unsafeUnwrap()).toBeNull();
    expect(wakeDispatcher).not.toHaveBeenCalled();
  });

  it('preserves causation and recursion metadata through standalone publication', () => {
    const bus = new LifecycleEventBus(events, resolver);
    const inputEvent = event();

    expect(bus.publish(input(inputEvent)).isOk()).toBe(true);

    const stored = events.findById(inputEvent.eventId)._unsafeUnwrap();
    expect(stored?.correlation_id).toBe(inputEvent.context.correlationId);
    expect(stored?.causation_id).toBe(inputEvent.context.causationId);
    expect(stored?.recursion_depth).toBe(1);
    expect(stored?.recursion_max_depth).toBe(4);
  });

  it('persists a valid event without waking when no subscriber matches', () => {
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const inputEvent = event();

    const published = bus.publish(input(inputEvent));

    expect(published.isOk()).toBe(true);
    expect(published._unsafeUnwrap().deliveries).toEqual([]);
    expect(events.findById(inputEvent.eventId)._unsafeUnwrap()).not.toBeNull();
    expect(wakeDispatcher).not.toHaveBeenCalled();
  });

  it('contains synchronous and asynchronous wake failures after a successful commit', async () => {
    handlers = [handler('run-handler', 0)];
    const syncWake = vi.fn<LifecycleDispatcherWake>(() => {
      throw new Error('sync wake failure');
    });
    const syncBus = new LifecycleEventBus(events, resolver, syncWake);
    expect(syncBus.publish(input(event())).isOk()).toBe(true);
    expect(syncWake).toHaveBeenCalledOnce();

    const asyncWake = vi.fn<LifecycleDispatcherWake>(async () => {
      throw new Error('async wake failure');
    });
    const asyncBus = new LifecycleEventBus(events, resolver, asyncWake);
    expect(asyncBus.publish(input(event())).isOk()).toBe(true);
    expect(asyncWake).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('returns typed errors without invoking hostile input accessors or proxy traps', () => {
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const accessorInput = {};
    Object.defineProperty(accessorInput, 'event', {
      enumerable: true,
      get: () => {
        throw new Error('input accessor must not run');
      },
    });
    Object.defineProperty(accessorInput, 'persona', { enumerable: true, value: 'support' });
    const proxyTrap = vi.fn(() => {
      throw new Error('proxy trap must not run');
    });
    const hostileInput = new Proxy(
      {},
      {
        get: proxyTrap,
        getOwnPropertyDescriptor: proxyTrap,
        getPrototypeOf: proxyTrap,
        ownKeys: proxyTrap,
      },
    );

    expect(bus.publish(accessorInput as LifecycleEventPublishInput).isErr()).toBe(true);
    expect(bus.publish(hostileInput as LifecycleEventPublishInput).isErr()).toBe(true);
    expect(proxyTrap).not.toHaveBeenCalled();
    expect(wakeDispatcher).not.toHaveBeenCalled();
  });

  it('rejects hostile resolver snapshots without executing proxy traps', () => {
    const proxyTrap = vi.fn(() => {
      throw new Error('resolver proxy trap must not run');
    });
    resolver = {
      resolveEventHandlers: () =>
        new Proxy([], {
          get: proxyTrap,
          getOwnPropertyDescriptor: proxyTrap,
          getPrototypeOf: proxyTrap,
          ownKeys: proxyTrap,
        }) as unknown as ResolvedLifecycleHandler[],
    };
    const bus = new LifecycleEventBus(events, resolver, wakeDispatcher);
    const inputEvent = event();

    expect(bus.publish(input(inputEvent)).isErr()).toBe(true);
    expect(proxyTrap).not.toHaveBeenCalled();
    expect(events.findById(inputEvent.eventId)._unsafeUnwrap()).toBeNull();
  });

  it('publishes a derived event only with the parent causal context and exact depth increment', () => {
    const bus = new LifecycleEventBus(events, resolver);
    const parent = event();
    const derived = event({
      context: {
        ...parent.context,
        causationId: parent.eventId,
        recursion: {
          depth: parent.context.recursion.depth + 1,
          maxDepth: parent.context.recursion.maxDepth,
        },
      },
    });

    expect(bus.publishDerived(parent, input(derived)).isOk()).toBe(true);
    const stored = events.findById(derived.eventId)._unsafeUnwrap();
    expect(stored).toMatchObject({
      aggregate_type: parent.context.aggregate.type,
      aggregate_id: parent.context.aggregate.id,
      correlation_id: parent.context.correlationId,
      causation_id: parent.eventId,
      recursion_depth: parent.context.recursion.depth + 1,
      recursion_max_depth: parent.context.recursion.maxDepth,
    });
  });

  it('rejects reset depth, altered causal fields, and exhausted derived-event depth', () => {
    const bus = new LifecycleEventBus(events, resolver);
    const parent = event();
    const derivedContext = {
      ...parent.context,
      causationId: parent.eventId,
      recursion: {
        depth: parent.context.recursion.depth + 1,
        maxDepth: parent.context.recursion.maxDepth,
      },
    };
    const resetDepth = event({
      context: { ...derivedContext, recursion: { ...derivedContext.recursion, depth: 0 } },
    });
    const changedAggregate = event({
      context: { ...derivedContext, aggregate: { ...derivedContext.aggregate, id: uuid() } },
    });
    const changedCorrelation = event({
      context: { ...derivedContext, correlationId: uuid() },
    });
    const changedCausation = event({
      context: { ...derivedContext, causationId: uuid() },
    });
    const exhaustedParent = event({
      context: { ...parent.context, recursion: { depth: 4, maxDepth: 4 } },
    });
    const exhaustedChild = event({
      context: {
        ...exhaustedParent.context,
        causationId: exhaustedParent.eventId,
        recursion: { depth: 4, maxDepth: 4 },
      },
    });

    expect(bus.publishDerived(parent, input(resetDepth)).isErr()).toBe(true);
    expect(bus.publishDerived(parent, input(changedAggregate)).isErr()).toBe(true);
    expect(bus.publishDerived(parent, input(changedCorrelation)).isErr()).toBe(true);
    expect(bus.publishDerived(parent, input(changedCausation)).isErr()).toBe(true);
    expect(bus.publishDerived(exhaustedParent, input(exhaustedChild)).isErr()).toBe(true);
  });
});
