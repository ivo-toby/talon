import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { DaemonIpcServer } from '../../../src/ipc/daemon-ipc.js';
import { queuePurgeCommand } from '../../../src/cli/commands/queue-purge.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'signal-purge-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('queue purge local cancellation warning and selectors', () => {
  it.each([
    { options: {}, expected: ['pending', 'failed', 'completed'] },
    { options: { statuses: ['dead_letter'] }, expected: ['dead_letter'] },
    { options: { all: true, statuses: ['failed'] }, expected: ['pending', 'claimed', 'processing', 'completed', 'failed', 'dead_letter'] },
  ])('preserves exact selectors and explains submitted chunk limit: %j', async ({ options, expected }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const seen: unknown[] = [];
    const server = new DaemonIpcServer({
      inputDir: join(root, 'input'), outputDir: join(root, 'output'), errorsDir: join(root, 'errors'),
      logger: pino({ enabled: false }), commandHandler: async (command) => {
        seen.push(command.payload);
        return { id: randomUUID(), commandId: command.id, success: true, data: { purged: 3 } };
      },
    });
    const pending = queuePurgeCommand({ ...options, ipcDir: root, timeoutMs: 2000 });
    for (let i = 0; i < 100; i++) {
      if ((await server.pollOnce()).length) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    await pending;
    expect(seen).toEqual([{ statuses: expected }]);
    expect(exit).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Purged 3 queue items.');
    expect(output).toContain('Selected saved delivery work is cancelled');
    expect(output).toContain('already submitted chunk may still arrive');
  });
  it('rejects invalid selectors before writing a command', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await queuePurgeCommand({ ipcDir: root, statuses: ['invalid'] });
    expect(exit).toHaveBeenCalledWith(1);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

import { createTestDb } from '../core/database/repositories/helpers.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { SignalDestinationLeaseRepository } from '../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { SIGNAL_CHECKPOINT_LIFETIME_MS } from '../../../src/queue/signal-delivery-checkpoint.js';
import { DeliveryCancelled } from '../../../src/core/errors/error-types.js';

it.each([false, true])('uses actual migrated repository purge/lease cascade for selected saved work (all=%s)', async (all) => {
  const db = createTestDb();
  const queue = new QueueRepository(db);
  const leases = new SignalDestinationLeaseRepository(db);
  try {
    new ChannelRepository(db).insert({ id: 'channel', name: 'signal-main', type: 'signal', config: '{}', credentials_ref: null, enabled: 1 })._unsafeUnwrap();
    const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
    const destination = `signal:v1:${accountUuid}:self`;
    new ThreadRepository(db).insert({ id: 'thread', channel_id: 'channel', external_id: destination, metadata: '{}' })._unsafeUnwrap();
    const item = { thread_id: 'thread', message_id: null, type: 'message' as const, payload: '{}', max_attempts: 3 };
    queue.enqueue({ ...item, id: 'active-ordinary' })._unsafeUnwrap();
    expect(queue.claimNext('thread')._unsafeUnwrap()?.id).toBe('active-ordinary');
    queue.enqueue({ ...item, id: 'saved' })._unsafeUnwrap();
    const now = Date.now();
    const checkpoint = queue.saveSignalCheckpoint({
      version: 1, queueItemId: 'saved', deliveryId: 'delivery', kind: 'background', personaId: 'persona', threadId: 'thread',
      channelName: 'signal-main', accountUuid, destination, body: 'fixture', chunks: ['fixture'], nextChunk: 0,
      phase: 'ready', currentChunkAcceptance: 'unwritten', acceptedChunks: 0, successCount: 0, failureCount: 0,
      createdAt: now, expiresAt: now + SIGNAL_CHECKPOINT_LIFETIME_MS,
    }, now)._unsafeUnwrap();
    leases.acquire(accountUuid, destination, { queueItemId: 'saved', deliveryId: 'delivery', purpose: 'background' }, now)._unsafeUnwrap();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = new DaemonIpcServer({
      inputDir: join(root, 'input'), outputDir: join(root, 'output'), errorsDir: join(root, 'errors'), logger: pino({ enabled: false }),
      commandHandler: async (command) => {
        if (command.command !== 'queue-purge') throw new Error('Wrong fixture command');
        const requested = command.payload?.statuses;
        const statuses = (['pending', 'claimed', 'processing', 'completed', 'failed', 'dead_letter'] as const)
          .filter((status) => Array.isArray(requested) && requested.includes(status));
        const purged = queue.purge(statuses)._unsafeUnwrap();
        return { id: randomUUID(), commandId: command.id, success: true, data: { purged, statuses } };
      },
    });
    const pending = queuePurgeCommand({ ipcDir: root, all, timeoutMs: 2000 });
    for (let i = 0; i < 100; i++) {
      if ((await server.pollOnce()).length) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    await pending;
    expect(log.mock.calls.flat().join('\n')).toContain(`Purged ${all ? 2 : 1} queue items.`);
    expect(queue.findById('saved')._unsafeUnwrap()).toBeNull();
    expect(queue.findById('active-ordinary')._unsafeUnwrap() === null).toBe(all);
    expect(leases.find(accountUuid, destination)._unsafeUnwrap()).toBeNull();
    expect(queue.deferSignalDelivery(checkpoint, 1000, now + 1)._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
  } finally { db.close(); }
});
