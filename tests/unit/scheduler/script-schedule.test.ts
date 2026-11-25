import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { err, ok } from 'neverthrow';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { Scheduler } from '../../../src/scheduler/scheduler.js';
import type { ScriptScheduleRunner } from '../../../src/scheduler/schedule-types.js';
import type { PersonaLoader } from '../../../src/personas/persona-loader.js';
import type { QueueManager } from '../../../src/queue/queue-manager.js';
import { ScriptError } from '../../../src/scripts/types.js';
import { ScriptNotRunError } from '../../../src/scripts/service.js';
import { createTestDb, seedDueSchedule, seedPersona, seedThread } from './helpers.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('pino').Logger & { error: ReturnType<typeof vi.fn> };
}

describe('Scheduler script schedules', () => {
  let db: Database.Database;
  let repo: ScheduleRepository;
  let personaId: string;
  let threadId: string;
  let enqueue: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof logger>;
  let scheduler: Scheduler;
  let runner: {
    runScheduled: ReturnType<typeof vi.fn>;
    notifyFailure: ReturnType<typeof vi.fn>;
    lastScheduledRunFailed: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    db = createTestDb();
    repo = new ScheduleRepository(db);
    personaId = seedPersona(db);
    threadId = seedThread(db);
    enqueue = vi.fn(() => ok({}));
    log = logger();
    scheduler = new Scheduler(
      repo,
      { enqueue } as unknown as QueueManager,
      { resolveTaskPrompt: vi.fn() } as unknown as PersonaLoader,
      { tickIntervalMs: 50 },
      log,
    );
    runner = {
      runScheduled: vi.fn(() => Promise.resolve(ok({ ok: true, calls: [] }))),
      notifyFailure: vi.fn(() => Promise.resolve()),
      lastScheduledRunFailed: vi.fn(() => false),
    };
    scheduler.setScriptRunner(runner as unknown as ScriptScheduleRunner);
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  async function fire(
    payload: Record<string, unknown>,
    type: 'interval' | 'one_shot' = 'interval',
  ) {
    const id = seedDueSchedule(db, personaId, threadId, {
      type,
      expression: type === 'interval' ? '60000' : String(Date.now() + 5000),
      payload: JSON.stringify(payload),
    });
    scheduler.start();
    await wait(120);
    scheduler.stop();
    return id;
  }

  const row = (id: string) => repo.findById(id)._unsafeUnwrap()!;

  it('runs the script, does not enqueue and computes the next run at once', async () => {
    const before = Date.now();
    const id = await fire({ label: 'l', script: 'mail-intake' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(runner.runScheduled).toHaveBeenCalledTimes(1);
    expect(runner.runScheduled).toHaveBeenCalledWith({
      personaId,
      threadId,
      scriptName: 'mail-intake',
      scheduleId: id,
    });
    expect(row(id).next_run_at).toBeGreaterThan(before + 50_000);
    expect(runner.notifyFailure).not.toHaveBeenCalled();
  });

  it('computes the next run before the run settles', async () => {
    runner.runScheduled.mockReturnValue(new Promise(() => {}));
    const id = await fire({ label: 'l', script: 'mail-intake' });
    expect(row(id).next_run_at).toBeGreaterThan(Date.now());
  });

  it('with no runner it logs an error, does not enqueue and still advances', async () => {
    scheduler.setScriptRunner(undefined);
    const id = await fire({ label: 'l', script: 'mail-intake' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
    expect(row(id).next_run_at).toBeGreaterThan(Date.now());
  });

  it('refuses an invalid script name', async () => {
    await fire({ label: 'l', script: '../etc' });
    expect(runner.runScheduled).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('refuses script together with prompt or promptFile', async () => {
    await fire({ label: 'l', script: 'mail-intake', prompt: 'hi' });
    await fire({ label: 'l', script: 'mail-intake', promptFile: 'x' });
    expect(runner.runScheduled).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('with a runner, script together with prompt stays an error with no enqueue', async () => {
    await fire({ label: 'l', script: 'mail-intake', prompt: 'hi' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('with no runner, script plus a usable prompt behaves as before and warns', async () => {
    scheduler.setScriptRunner(undefined);
    const id = await fire({ label: 'l', script: 'mail-intake', prompt: 'do it' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][2]).toMatchObject({ content: 'do it', personaId });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: id }),
      expect.stringContaining('"script" field'),
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(row(id).next_run_at).toBeGreaterThan(Date.now());
  });

  it('with no runner, script plus a promptFile enqueues the resolved prompt', async () => {
    scheduler.setScriptRunner(undefined);
    const loader = { resolveTaskPrompt: vi.fn(() => Promise.resolve(ok('from file'))) };
    scheduler = new Scheduler(
      repo,
      { enqueue } as unknown as QueueManager,
      loader as unknown as PersonaLoader,
      { tickIntervalMs: 50 },
      log,
    );
    await fire({ label: 'l', script: 'mail-intake', promptFile: 'daily' });
    expect(enqueue.mock.calls[0][2]).toMatchObject({ content: 'from file' });
  });

  it('skips a schedule without a thread', async () => {
    const id = seedDueSchedule(db, personaId, null, {
      type: 'interval',
      expression: '60000',
      payload: JSON.stringify({ label: 'l', script: 'mail-intake' }),
    });
    scheduler.start();
    await wait(120);
    scheduler.stop();
    expect(runner.runScheduled).not.toHaveBeenCalled();
    expect(row(id).next_run_at).toBeGreaterThan(Date.now());
  });

  it('notifies one time for a failure that follows a success', async () => {
    runner.runScheduled.mockResolvedValue(err(new ScriptError('TIMEOUT', 'x')));
    await fire({ label: 'l', script: 'mail-intake' });
    expect(runner.notifyFailure).toHaveBeenCalledTimes(1);
    expect(runner.notifyFailure).toHaveBeenCalledWith({
      threadId,
      scriptName: 'mail-intake',
      errorCode: 'TIMEOUT',
    });
  });

  it('passes the reason of a run that did not start', async () => {
    runner.runScheduled.mockResolvedValue(err(new ScriptNotRunError('not-approved')));
    await fire({ label: 'l', script: 'mail-intake' });
    expect(runner.notifyFailure).toHaveBeenCalledWith({
      threadId,
      scriptName: 'mail-intake',
      errorCode: 'SCRIPT_FAILED',
      reason: 'not-approved',
    });
    runner.notifyFailure.mockClear();
    runner.runScheduled.mockResolvedValue(err(new ScriptNotRunError('changed')));
    await fire({ label: 'l', script: 'mail-intake' }, 'one_shot');
    expect(runner.notifyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'SCRIPT_FAILED', reason: 'changed' }),
    );
  });

  it('notifies for a report with ok false, using its error code', async () => {
    runner.runScheduled.mockResolvedValue(ok({ ok: false, errorCode: 'CALL_LIMIT', calls: [] }));
    await fire({ label: 'l', script: 'mail-intake' });
    expect(runner.notifyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'CALL_LIMIT' }),
    );
    runner.notifyFailure.mockClear();
    runner.runScheduled.mockResolvedValue(ok({ ok: false, calls: [] }));
    await fire({ label: 'l', script: 'mail-intake' }, 'one_shot');
    expect(runner.notifyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'SCRIPT_FAILED' }),
    );
  });

  it('does not notify when the run before also failed', async () => {
    runner.lastScheduledRunFailed.mockReturnValue(true);
    runner.runScheduled.mockResolvedValue(err(new ScriptError('TIMEOUT', 'x')));
    await fire({ label: 'l', script: 'mail-intake' });
    expect(runner.notifyFailure).not.toHaveBeenCalled();
  });

  it('reads the failure state before it starts the run', async () => {
    const order: string[] = [];
    runner.lastScheduledRunFailed.mockImplementation(() => {
      order.push('state');
      return false;
    });
    runner.runScheduled.mockImplementation(() => {
      order.push('run');
      return Promise.resolve(ok({ ok: true, calls: [] }));
    });
    await fire({ label: 'l', script: 'mail-intake' });
    expect(order).toEqual(['state', 'run']);
  });

  it('does not notify for a skipped run', async () => {
    runner.runScheduled.mockResolvedValue(ok('skipped'));
    await fire({ label: 'l', script: 'mail-intake' });
    expect(runner.notifyFailure).not.toHaveBeenCalled();
  });

  it('survives a rejecting runner, a throwing runner and a rejecting notice', async () => {
    runner.runScheduled.mockRejectedValue(new Error('boom'));
    const first = await fire({ label: 'l', script: 'mail-intake' });
    runner.runScheduled.mockImplementation(() => {
      throw new Error('sync boom');
    });
    await fire({ label: 'l', script: 'mail-intake' }, 'one_shot');
    runner.runScheduled.mockResolvedValue(err(new ScriptError('TIMEOUT', 'x')));
    runner.notifyFailure.mockRejectedValue(new Error('send failed'));
    await fire({ label: 'l', script: 'mail-intake' }, 'one_shot');
    expect(row(first).next_run_at).toBeGreaterThan(Date.now());
    expect(log.error).toHaveBeenCalled();
  });
});
