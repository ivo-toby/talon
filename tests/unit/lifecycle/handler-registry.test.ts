import { describe, expect, it } from 'vitest';

import {
  createLifecycleHandlerRegistry,
  type LifecycleRegistryInput,
} from '../../../src/lifecycle/handler-registry.js';

function makeRegistryInput(): LifecycleRegistryInput {
  return {
    lifecycle: {
      enabled: true,
      handlers: [
        {
          version: 'v1',
          id: 'context-projector',
          mode: 'event',
          runtime: {
            kind: 'native',
            ref: 'context-projector',
            implementationVersion: '1.0.0',
          },
          failurePolicy: {
            version: 'v1',
            mode: 'preserve_session',
          },
        },
        {
          version: 'v1',
          id: 'audit-log',
          mode: 'event',
          runtime: {
            kind: 'native',
            ref: 'audit-log',
            implementationVersion: '1.0.0',
          },
          budget: {
            version: 'v1',
            timeoutMs: 2_000,
          },
          failurePolicy: {
            version: 'v1',
            mode: 'dead_letter',
          },
        },
      ],
    },
    channels: [{ name: 'terminal' }, { name: 'slack' }],
    personas: [
      {
        name: 'assistant',
        lifecycle: {
          subscriptions: [
            {
              version: 'v1',
              handler: 'audit-log',
              priority: 10,
              subscription: {
                version: 'v1',
                kind: 'event',
                events: [{ version: 'v1', type: 'message.persisted.v1' }],
                filter: {
                  version: 'v1',
                  channels: ['terminal'],
                  messageSources: ['inbound'],
                },
              },
              budget: {
                version: 'v1',
                timeoutMs: 3_500,
              },
            },
            {
              version: 'v1',
              handler: 'context-projector',
              priority: 100,
              subscription: {
                version: 'v1',
                kind: 'event',
                events: [{ version: 'v1', type: 'message.persisted.v1' }],
              },
            },
          ],
        },
      },
      { name: 'observer' },
    ],
  };
}

describe('LifecycleHandlerRegistry', () => {
  it('resolves explicitly attached event handlers in deterministic priority order', () => {
    const result = createLifecycleHandlerRegistry(makeRegistryInput());

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    const handlers = registry.resolveEventHandlers({
      persona: 'assistant',
      eventType: 'message.persisted.v1',
      channel: 'terminal',
      messageSource: 'inbound',
    });

    expect(handlers.map((handler) => handler.handler.id)).toEqual([
      'context-projector',
      'audit-log',
    ]);
    expect(handlers[0]?.identity).toEqual({
      version: 'v1',
      handlerId: 'context-projector',
      runtimeKind: 'native',
      implementationRef: 'context-projector',
      implementationVersion: '1.0.0',
    });
    expect(handlers[1]?.budget).toEqual({
      version: 'v1',
      timeoutMs: 3_500,
    });
  });

  it('does not resolve handlers when filters do not match', () => {
    const result = createLifecycleHandlerRegistry(makeRegistryInput());

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    const handlers = registry.resolveEventHandlers({
      persona: 'assistant',
      eventType: 'message.persisted.v1',
      channel: 'slack',
      messageSource: 'inbound',
    });

    expect(handlers.map((handler) => handler.handler.id)).toEqual(['context-projector']);
  });

  it('returns an empty registry when lifecycle is omitted entirely', () => {
    const result = createLifecycleHandlerRegistry({
      personas: [{ name: 'assistant' }],
    });

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    expect(registry.isEnabled()).toBe(false);
    expect(
      registry.resolveEventHandlers({
        persona: 'assistant',
        eventType: 'message.persisted.v1',
      }),
    ).toEqual([]);
  });

  it('does not resolve attached handlers when lifecycle is explicitly disabled', () => {
    const input = makeRegistryInput();
    if (input.lifecycle) {
      input.lifecycle.enabled = false;
    }

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isOk()).toBe(true);
    const registry = result._unsafeUnwrap();
    expect(
      registry.resolveEventHandlers({
        persona: 'assistant',
        eventType: 'message.persisted.v1',
        channel: 'terminal',
        messageSource: 'inbound',
      }),
    ).toEqual([]);
  });

  it('rejects duplicate handler ids', () => {
    const input = makeRegistryInput();
    input.lifecycle?.handlers.push({
      version: 'v1',
      id: 'audit-log',
      mode: 'signal',
      runtime: {
        kind: 'native',
        ref: 'signal-audit',
        implementationVersion: '1.0.0',
      },
    });

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/duplicate lifecycle handler id "audit-log"/i);
  });

  it('rejects persona subscriptions that reference missing handlers', () => {
    const input = makeRegistryInput();
    input.personas[0].lifecycle?.subscriptions.push({
      version: 'v1',
      handler: 'missing-handler',
      subscription: {
        version: 'v1',
        kind: 'event',
        events: [{ version: 'v1', type: 'message.persisted.v1' }],
      },
    });

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/references unknown lifecycle handler "missing-handler"/i);
  });

  it('rejects incompatible subscription kinds for a handler mode', () => {
    const input = makeRegistryInput();
    input.personas[0].lifecycle = {
      subscriptions: [
        {
          version: 'v1',
          handler: 'audit-log',
          subscription: {
            version: 'v1',
            kind: 'signal',
            signals: [{ version: 'v1', type: 'context.rotate.requested.v1' }],
          },
        },
      ],
    };

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(
      /handler "audit-log" has mode "event" but subscription kind is "signal"/i,
    );
  });

  it('rejects unsafe fail-open policies', () => {
    const input = makeRegistryInput();
    input.lifecycle?.handlers.push({
      version: 'v1',
      id: 'native-interceptor',
      mode: 'interceptor',
      runtime: {
        kind: 'native',
        ref: 'native-interceptor',
        implementationVersion: '1.0.0',
      },
      failurePolicy: {
        version: 'v1',
        mode: 'fail_open',
      },
    });
    input.personas[0].lifecycle = {
      subscriptions: [
        {
          version: 'v1',
          handler: 'native-interceptor',
          subscription: {
            version: 'v1',
            kind: 'interceptor',
            interceptors: [{ version: 'v1', hook: 'message.before_persist' }],
          },
        },
      ],
    };

    const result = createLifecycleHandlerRegistry(input);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/fail_open is not allowed/i);
  });
});
