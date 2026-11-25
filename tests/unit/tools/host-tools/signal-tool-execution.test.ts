import { describe, expect, it } from 'vitest';
import { ok } from 'neverthrow';
import { SignalToolExecutionRegistry } from '../../../../src/tools/host-tools/signal-tool-execution.js';

function registryFor(payload: unknown): SignalToolExecutionRegistry {
  const queue = {
    findById: () =>
      ok({ id: 'q', thread_id: 't', status: 'processing', payload: JSON.stringify(payload) }),
  };
  const runs = {
    findById: () =>
      ok({ id: 'r', queue_item_id: 'q', thread_id: 't', persona_id: 'p', status: 'running' }),
  };
  return new SignalToolExecutionRegistry({
    queue: queue as never,
    runs: runs as never,
    personas: { getById: () => ok(undefined) } as never,
  });
}

function register(payload: unknown) {
  const guard = {
    context: () => ok({ queueItemId: 'q', runId: 'r' }),
    close: () => undefined,
  };
  return registryFor(payload).register({
    runId: 'r',
    threadId: 't',
    personaId: 'p',
    queueItemId: 'q',
    guard: guard as never,
  });
}

describe('SignalToolExecutionRegistry persona check', () => {
  it('accepts a top-level persona id', () => {
    expect(register({ personaId: 'p' }).isOk()).toBe(true);
  });

  it('rejects a mismatching top-level persona id', () => {
    expect(register({ personaId: 'other' }).isErr()).toBe(true);
  });

  it('accepts a voice backend payload that nests the persona id in request', () => {
    expect(register({ kind: 'voice_backend', request: { personaId: 'p' } }).isOk()).toBe(true);
  });

  it('rejects a voice payload with a mismatching or missing nested persona id', () => {
    expect(register({ kind: 'voice_backend', request: { personaId: 'other' } }).isErr()).toBe(true);
    expect(register({ kind: 'voice_backend', request: {} }).isErr()).toBe(true);
    expect(register({ kind: 'voice_backend' }).isErr()).toBe(true);
  });

  it('does not read a nested persona id for non-voice payloads', () => {
    expect(register({ request: { personaId: 'p' } }).isErr()).toBe(true);
    expect(register({}).isErr()).toBe(true);
  });
});
