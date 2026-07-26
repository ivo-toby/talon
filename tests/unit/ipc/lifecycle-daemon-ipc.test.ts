import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DaemonCommandSchema } from '../../../src/ipc/daemon-ipc.js';
import type { DaemonCommandType } from '../../../src/ipc/daemon-ipc.js';

describe('daemon lifecycle IPC command schema', () => {
  it('accepts every lifecycle operator command type', () => {
    const commands: Array<{ command: DaemonCommandType; payload: Record<string, unknown> }> = [
      { command: 'lifecycle-handlers', payload: { limit: 10 } },
      { command: 'lifecycle-inspect', payload: { eventId: 'event-1', handlerId: 'handler-1' } },
      { command: 'lifecycle-replay', payload: { eventId: 'event-1', handlerId: 'handler-1' } },
      { command: 'lifecycle-disable', payload: { handlerId: 'handler-1' } },
      { command: 'lifecycle-candidates', payload: { persona: 'assistant', limit: 10 } },
    ];

    for (const { command, payload } of commands) {
      const parsed = DaemonCommandSchema.safeParse({
        id: randomUUID(),
        command,
        payload,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects unregistered lifecycle-like command names', () => {
    const parsed = DaemonCommandSchema.safeParse({
      id: randomUUID(),
      command: 'lifecycle-delete',
      payload: { handlerId: 'handler-1' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects malformed lifecycle list payloads', () => {
    for (const payload of [
      { limit: 0 },
      { limit: 101 },
      { limit: '10' },
      { limit: 10, unexpected: true },
    ]) {
      expect(
        DaemonCommandSchema.safeParse({
          id: randomUUID(),
          command: 'lifecycle-handlers',
          payload,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects malformed lifecycle mutation payloads', () => {
    for (const command of ['lifecycle-replay', 'lifecycle-disable'] as const) {
      expect(
        DaemonCommandSchema.safeParse({
          id: randomUUID(),
          command,
          payload: command === 'lifecycle-replay' ? { eventId: 'event-1' } : {},
        }).success,
      ).toBe(false);
    }

    expect(
      DaemonCommandSchema.safeParse({
        id: randomUUID(),
        command: 'lifecycle-replay',
        payload: { eventId: 'event-1', handlerId: 'handler-1', dryRun: true },
      }).success,
    ).toBe(false);
  });

  it('rejects malformed lifecycle candidate payloads', () => {
    for (const payload of [{ limit: 10 }, { persona: 'assistant', limit: 250 }]) {
      expect(
        DaemonCommandSchema.safeParse({
          id: randomUUID(),
          command: 'lifecycle-candidates',
          payload,
        }).success,
      ).toBe(false);
    }
  });
});
