import { describe, it, expect } from 'vitest';
import { KeyedSerialQueue } from '../../../src/channels/keyed-serial-queue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('KeyedSerialQueue', () => {
  it('runs tasks for the same key in submission order, one at a time', async () => {
    const queue = new KeyedSerialQueue();
    const gate = deferred();
    const order: string[] = [];

    const first = queue.run('chat', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = queue.run('chat', async () => {
      order.push('second');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not hold back other keys', async () => {
    const queue = new KeyedSerialQueue();
    const gate = deferred();
    const order: string[] = [];

    const blocked = queue.run('a', async () => {
      await gate.promise;
      order.push('a');
    });
    await queue.run('b', async () => {
      order.push('b');
    });
    expect(order).toEqual(['b']);

    gate.resolve();
    await blocked;
    expect(order).toEqual(['b', 'a']);
  });

  it('keeps going after a failed task and returns each task its own result', async () => {
    const queue = new KeyedSerialQueue();
    const failed = queue.run('chat', async () => {
      throw new Error('boom');
    });
    const next = queue.run('chat', async () => 42);

    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe(42);
  });

  it('forgets a key once its work has drained', async () => {
    const queue = new KeyedSerialQueue();
    await queue.run('chat', async () => undefined);
    await Promise.resolve();
    expect(queue.activeKeys).toBe(0);
  });
});
