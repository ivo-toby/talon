/**
 * Unit tests for the `talonctl status` command.
 *
 * Tests IPC command writing and response polling using a temporary directory
 * to simulate daemon IPC files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { statusCommand } from '../../../src/cli/commands/status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-status-test-'));
}

/** Writes a fake daemon response file to the output directory. */
async function writeFakeResponse(
  outputDir: string,
  commandId: string,
  data: Record<string, unknown>,
  success = true,
): Promise<void> {
  mkdirSync(outputDir, { recursive: true });
  const response = {
    id: randomUUID(),
    commandId,
    success,
    data: success ? data : undefined,
    error: success ? undefined : (data['error'] as string),
  };
  const filename = `${Date.now()}-${randomUUID().replace(/-/g, '')}.json`;
  writeFileSync(join(outputDir, filename), JSON.stringify(response));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('statusCommand()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('exits with code 1 when daemon does not respond (timeout)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => undefined as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Use a very short timeout and an empty IPC dir (no daemon)
    await statusCommand({ ipcDir: tmpDir, timeoutMs: 50 });

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('writes a command file to the input directory', async () => {
    const inputDir = join(tmpDir, 'input');
    mkdirSync(inputDir, { recursive: true });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => undefined as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Short timeout — we just want to verify the file was written
    await statusCommand({ ipcDir: tmpDir, timeoutMs: 50 });

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(inputDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('displays status when daemon responds successfully', async () => {
    const outputDir = join(tmpDir, 'output');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => undefined as never);

    // We need to capture the command ID to write a matching response.
    // The command writes to input/ and we respond from output/.
    // Intercept the write by watching the input directory.

    let commandId: string | null = null;
    const inputDir = join(tmpDir, 'input');
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    // Watch input dir for new files and write a matching response.
    const { watch } = await import('node:fs');
    const watcher = watch(inputDir, async (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(join(inputDir, filename), 'utf8');
        const cmd = JSON.parse(content) as { id: string; command: string };
        if (cmd.command === 'status' && !commandId) {
          commandId = cmd.id;
          await writeFakeResponse(outputDir, cmd.id, {
            uptimeMs: 60000,
            activeContainers: 2,
            queueDepth: 5,
            personaCount: 3,
            channelCount: 2,
            deadLetterCount: 0,
          });
        }
      } catch {
        // Ignore parse errors from empty/incomplete files
      }
    });

    await statusCommand({ ipcDir: tmpDir, timeoutMs: 2000 });

    watcher.close();

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    // Status output should contain uptime and counts
    expect(output).toContain('talond status');
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when daemon responds with error', async () => {
    const outputDir = join(tmpDir, 'output');
    const inputDir = join(tmpDir, 'input');
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => undefined as never);

    // Write error response when a command comes in
    const { watch } = await import('node:fs');
    const watcher = watch(inputDir, async (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(join(inputDir, filename), 'utf8');
        const cmd = JSON.parse(content) as { id: string; command: string };
        if (cmd.command === 'status') {
          // Write an error response
          const response = {
            id: randomUUID(),
            commandId: cmd.id,
            success: false,
            error: 'Internal daemon error',
          };
          const fname = `${Date.now()}-${randomUUID().replace(/-/g, '')}.json`;
          writeFileSync(join(outputDir, fname), JSON.stringify(response));
        }
      } catch {
        // Ignore
      }
    });

    await statusCommand({ ipcDir: tmpDir, timeoutMs: 2000 });

    watcher.close();

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

import fs from 'node:fs/promises';
import pino from 'pino';
import { DaemonIpcServer } from '../../../src/ipc/daemon-ipc.js';

const signalStatus = {
  saved: { pending: 2, terminal: 1, reasons: [{ reason: 'UNKNOWN_ACCEPTANCE', count: 1 }] },
  channels: [{ channel: 'signal-main', state: 'ready', outboundSuspended: true,
    draining: false, replacementAllowed: false, persistenceBlocked: true,
    sender: { state: 'blocked', stopped: true, pendingWrites: 1 },
    verification: { state: 'stale', reason: 'VERIFICATION_STALE', checking: false },
    buffers: { proof: { held: 3, dropped: 2 }, alias: { held: 1, dropped: 0 }, receipt: { held: 2, dropped: 1 } },
  }],
};

describe('actual status IPC Signal rendering', () => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'signal-status-')); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
  async function render(signal: unknown): Promise<string> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const server = new DaemonIpcServer({
      inputDir: join(directory, 'input'), outputDir: join(directory, 'output'), errorsDir: join(directory, 'errors'),
      logger: pino({ enabled: false }), commandHandler: async (command) => ({
        id: randomUUID(), commandId: command.id, success: true,
        data: { uptimeMs: 1000, ...(signal === undefined ? {} : { signal }) },
      }),
    });
    const pending = statusCommand({ ipcDir: directory, timeoutMs: 2000 });
    for (let i = 0; i < 100; i++) {
      if ((await server.pollOnce()).length) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    await pending;
    return log.mock.calls.flat().join('\n');
  }
  it('shows receive-only Ready separately from blocked/stopped sender, buffers and saved terminal reasons', async () => {
    const output = await render(signalStatus);
    expect(output).toContain('Signal saved: pending=2 terminal=1');
    expect(output).toContain('UNKNOWN_ACCEPTANCE=1');
    expect(output).toContain('receive=ready');
    expect(output).toContain('outbound=suspended');
    expect(output).toContain('sender=blocked stopped=true');
    expect(output).toContain('proof: held=3 dropped=2');
    expect(output).toContain('alias: held=1 dropped=0');
    expect(output).toContain('receipt: held=2 dropped=1');
    expect(output).toContain('resend expired commands after recovery');
  });
  it.each([undefined, {}, { saved: { pending: -1, terminal: 0, reasons: [] } }, { ...signalStatus, PRIVATE_ACCOUNT: 'PRIVATE_TOKEN' }])('treats missing/invalid/private data as unavailable, never healthy zeros: %j', async (input) => {
    const output = await render(input);
    expect(output).toContain('Signal status: unavailable');
    expect(output).not.toMatch(/PRIVATE|receive=ready|pending=0|terminal=0/);
  });
  it.each([64, 65])('F2 renders the exact admitted %s-character name without invalidating Signal status', async (length) => {
    const channel = 's'.repeat(length);
    const filename = join(directory, 'talond.yaml');
    await fs.writeFile(filename, 'channels: []\n');
    const entry = await addChannel({ name: channel, type: 'signal', configPath: filename, signalConfig: {
      accountMode: 'dedicated', socketPath: '/run/signal/bridge.sock',
      account: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', accountUuid: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', deviceId: 1,
    } });
    const output = await render({ channels: signalStatus.channels.map((status) => ({ ...status, channel: entry.name })) });
    expect(output).toContain(`Signal ${channel}: receive=ready`);
    expect(output).not.toContain('Signal status: unavailable');
  });
});

import { addChannel } from '../../../src/cli/commands/add-channel.js';
import { parseSignalStatusData } from '../../../src/ipc/daemon-ipc.js';

describe('safe optional Signal status IPC contract', () => {
  it.each([
    { ...signalStatus, saved: { pending: 1.5, terminal: 0, reasons: [] } },
    { ...signalStatus, saved: { pending: Number.MAX_SAFE_INTEGER + 1, terminal: 0, reasons: [] } },
    { ...signalStatus, saved: { pending: 0, terminal: 1, reasons: [{ reason: 'PRIVATE_TOKEN', count: 1 }] } },
    { ...signalStatus, channels: Array.from({ length: 65 }, () => signalStatus.channels[0]) },
    { ...signalStatus, channels: [{ ...signalStatus.channels[0], accountUuid: 'PRIVATE_ACCOUNT' }] },
    { ...signalStatus, channels: [{ ...signalStatus.channels[0], sender: { state: 'healthy', stopped: false, pendingWrites: -1 } }] },
    { ...signalStatus, channels: [{ ...signalStatus.channels[0], verification: { state: 'verified', checking: false, nextCheckAt: 12345, PRIVATE_KEY: 'PRIVATE_TOKEN' } }] },
    { ...signalStatus, channels: [{ ...signalStatus.channels[0], buffers: { ...signalStatus.channels[0]!.buffers, proof: { held: 65, dropped: 0 } } }] },
  ])('rejects invalid/private fields without retaining raw causes: %j', (value) => {
    const result = parseSignalStatusData(value);
    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|accountUuid|nextCheckAt/);
  });
  it('keeps independently unavailable saved and connector components omitted', () => {
    expect(parseSignalStatusData({ saved: signalStatus.saved })._unsafeUnwrap()).toEqual({ saved: signalStatus.saved });
    expect(parseSignalStatusData({ channels: [] })._unsafeUnwrap()).toEqual({ channels: [] });
  });
});

import { createTestDb } from '../core/database/repositories/helpers.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { SignalAccountStateRepository, SignalStateError } from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDeliveryError } from '../../../src/core/errors/error-types.js';
import { SignalCheckpointError, SIGNAL_CHECKPOINT_LIFETIME_MS, type SignalDeliveryCheckpoint } from '../../../src/queue/signal-delivery-checkpoint.js';
import { err, ok } from '../../../src/core/types/result.js';
import type { SignalStatusData } from '../../../src/ipc/daemon-ipc.js';

describe('F1 accepted saved-summary producer to actual status DTO/IPC/CLI', () => {
  let db: ReturnType<typeof createTestDb>;
  let queue: QueueRepository;
  let directory: string;
  let now: number;
  let sequence: number;
  let lastSummary: ReturnType<QueueRepository['summarizeSavedSignalDeliveries']> | undefined;
  const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  beforeEach(async () => {
    db = createTestDb();
    queue = new QueueRepository(db);
    directory = await fs.mkdtemp(join(tmpdir(), 'signal-summary-status-'));
    now = Date.now();
    sequence = 0;
    lastSummary = undefined;
    new ChannelRepository(db).insert({ id: 'channel', type: 'signal', name: 'signal-main', config: '{}', credentials_ref: null, enabled: 1 })._unsafeUnwrap();
    for (const [index, id] of ['deferred', 'active', 'local', 'terminal'].entries()) {
      new ThreadRepository(db).insert({ id, channel_id: 'channel',
        external_id: `signal:v1:${accountUuid}:dm:cccccccc-1111-2222-3333-${String(index + 1).padStart(12, '0')}`, metadata: '{}' })._unsafeUnwrap();
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  function prepare(threadId = 'deferred', kind: 'reply' | 'background' = 'reply'): SignalDeliveryCheckpoint {
    const id = `item-${sequence++}`;
    queue.enqueue({ id, thread_id: threadId, message_id: null, type: 'message', payload: '{}', max_attempts: 3 })._unsafeUnwrap();
    const destination = new ThreadRepository(db).findById(threadId)._unsafeUnwrap()!.external_id;
    return queue.saveSignalCheckpoint({
      version: 1, queueItemId: id, deliveryId: `delivery-${id}`, kind, personaId: 'persona', threadId,
      channelName: 'signal-main', accountUuid, destination, body: 'PRIVATE_FIXTURE_BODY', chunks: ['PRIVATE_FIXTURE_BODY'],
      nextChunk: 0, phase: 'ready', currentChunkAcceptance: 'unwritten', acceptedChunks: 0, successCount: 0, failureCount: 0,
      createdAt: now, expiresAt: now + SIGNAL_CHECKPOINT_LIFETIME_MS,
    }, now)._unsafeUnwrap();
  }
  async function renderSummary(): Promise<string> {
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const server = new DaemonIpcServer({
      inputDir: join(directory, 'input'), outputDir: join(directory, 'output'), errorsDir: join(directory, 'errors'), logger: pino({ enabled: false }),
      commandHandler: async (command) => {
        expect(command.command).toBe('status');
        lastSummary = queue.summarizeSavedSignalDeliveries(now);
        // Fixture composition only; TASK-012 owns runtime population. No alternate producer,
        // private handle, partial counts or fabricated zero fallback on a typed Err.
        const signal: SignalStatusData | undefined = lastSummary.isOk() ? { saved: lastSummary.value } : undefined;
        if (signal !== undefined) expect(parseSignalStatusData(signal)._unsafeUnwrap().saved).toEqual(lastSummary._unsafeUnwrap());
        return { id: randomUUID(), commandId: command.id, success: true, data: { ...(signal === undefined ? {} : { signal }) } };
      },
    });
    const before = db.serialize();
    db.pragma('query_only = ON');
    try {
      const pending = statusCommand({ ipcDir: directory, timeoutMs: 2000 });
      for (let i = 0; i < 100; i++) {
        if ((await server.pollOnce()).length) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      await pending;
      expect(exit).not.toHaveBeenCalled();
      expect(db.serialize().equals(before)).toBe(true);
    } finally {
      db.pragma('query_only = OFF');
      log.mockRestore();
      exit.mockRestore();
    }
    expect(output.join('\n')).not.toMatch(/PRIVATE|aaaaaaaa|cccccccc|delivery-item|socket/);
    return output.join('\n');
  }
  it('counts future/HOL/claimed/local-finalization and retained terminal work, then observes completed/purge without eligibility guessing', async () => {
    const active = prepare('active', 'background');
    expect(queue.claimNext('active')._unsafeUnwrap()?.id).toBe(active.queueItemId);
    const head = prepare();
    queue.deferSignalDelivery(head, 60000, now)._unsafeUnwrap();
    prepare(); // saved ready work behind the future saved head
    queue.enqueue({ id: 'ordinary', thread_id: 'deferred', message_id: null, type: 'message', payload: '{"text":"PRIVATE_ORDINARY"}', max_attempts: 3 })._unsafeUnwrap();
    queue.fail('ordinary', 'PRIVATE_ORDINARY_ERROR', now + 60000)._unsafeUnwrap();
    const terminal = prepare('terminal');
    queue.terminateSignalDelivery(terminal, new SignalDeliveryError({ reason: 'TARGET_REFUSED', outcome: 'NOT_SENT',
      acceptedChunks: 0, currentChunkAcceptance: 'unwritten', successCount: 0, failureCount: 0, retryScope: 'none' }), now)._unsafeUnwrap();
    expect(queue.findPending(now)._unsafeUnwrap()).toEqual([]);
    expect(await renderSummary()).toContain('Signal saved: pending=3 terminal=1');
    expect(lastSummary?._unsafeUnwrap()).toEqual({ pending: 3, terminal: 1, reasons: [{ reason: 'TARGET_REFUSED', count: 1 }] });

    const saved = prepare('local');
    const accounts = new SignalAccountStateRepository(db);
    const account = accounts.getOrCreate(accountUuid, now)._unsafeUnwrap();
    const ownership = queue.beginSignalChunk(saved, account.revision, now)._unsafeUnwrap();
    const delivered = queue.settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, now)._unsafeUnwrap();
    const failure = new SignalStateError('DATABASE');
    expect(queue.finalizeSignalDelivery(delivered, () => err(failure), now)._unsafeUnwrapErr()).toBe(failure);
    now = delivered.expiresAt + 1;
    queue.deferSignalDelivery(delivered, 60000, now)._unsafeUnwrap();
    const unfinished = await renderSummary();
    expect(unfinished).toContain('Signal saved: pending=4 terminal=1');
    expect(unfinished).toContain('TARGET_REFUSED=1');
    expect(queue.inspectSignalDelivery(head.queueItemId, now)._unsafeUnwrap()).toMatchObject({ kind: 'checkpoint', checkpoint: { phase: 'ready' } });
    queue.finalizeSignalDelivery(delivered, () => ok(undefined), now)._unsafeUnwrap();
    expect(await renderSummary()).toContain('Signal saved: pending=3 terminal=1');
    expect(queue.purge(['completed'])._unsafeUnwrap()).toBe(1);
    expect(await renderSummary()).toContain('Signal saved: pending=3 terminal=1');
    expect(queue.purge(['dead_letter'])._unsafeUnwrap()).toBe(1);
    expect(await renderSummary()).toContain('Signal saved: pending=3 terminal=0');
    expect(queue.purge(['pending', 'failed', 'completed'])._unsafeUnwrap()).toBe(3);
    expect(await renderSummary()).toContain('Signal saved: pending=1 terminal=0'); // claimed saved work remains
    expect(queue.purge(['claimed'])._unsafeUnwrap()).toBe(1);
    expect(await renderSummary()).toContain('Signal saved: pending=0 terminal=0'); // genuine successful empty read
  }, 20000);
  it.each(['database', 'corruption'] as const)('preserves actual typed %s failure as unavailable, never partial/healthy zeros', async (fault) => {
    prepare();
    if (fault === 'database') db.exec('ALTER TABLE queue_items RENAME TO unavailable_queue'); // owned controlled read-failure fixture only
    else queue.enqueue({ id: 'corrupt', thread_id: 'deferred', message_id: null, type: 'message', max_attempts: 3,
      payload: '{"__talond_signal_delivery_v1":null,"PRIVATE_KEY":"PRIVATE_TOKEN"}' })._unsafeUnwrap();
    const output = await renderSummary();
    expect(lastSummary?.isErr()).toBe(true);
    const failure = lastSummary?._unsafeUnwrapErr();
    expect(failure).toBeInstanceOf(fault === 'database' ? SignalStateError : SignalCheckpointError);
    expect(failure).toMatchObject({ reason: fault === 'database' ? 'DATABASE' : 'INVALID', cause: undefined });
    expect(output).toContain('Signal status: unavailable');
    expect(output).not.toMatch(/Signal saved: pending=|terminal=|healthy|Ready/);
  });
});
