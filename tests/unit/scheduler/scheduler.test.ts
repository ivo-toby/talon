import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import { PersonaError, QueueError } from '../../../src/core/errors/index.js';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { Scheduler } from '../../../src/scheduler/scheduler.js';
import type { ScheduleConfig } from '../../../src/scheduler/schedule-types.js';
import type { PersonaLoader } from '../../../src/personas/persona-loader.js';
import type { QueueManager } from '../../../src/queue/queue-manager.js';
import type { QueueItem } from '../../../src/queue/queue-types.js';
import { QueueItemStatus } from '../../../src/queue/queue-types.js';
import { createTestDb, seedPersona, seedThread, seedDueSchedule, uuid } from './helpers.js';

// ---------------------------------------------------------------------------
// Minimal QueueManager stub
// ---------------------------------------------------------------------------

function makeQueueStub(
  enqueueImpl: (
    threadId: string,
    type: string,
    payload: Record<string, unknown>,
  ) => ReturnType<QueueManager['enqueue']> = () => ok(makeQueueItem()),
): QueueManager {
  return {
    enqueue: vi.fn(enqueueImpl),
    enqueueInLifecycleTransaction: vi.fn(() => ok(makeQueueItem())),
    startProcessing: vi.fn(),
    stopProcessing: vi.fn(),
    stats: vi.fn(),
  } as unknown as QueueManager;
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: uuid(),
    threadId: uuid(),
    type: 'schedule',
    status: QueueItemStatus.Pending,
    attempts: 0,
    maxAttempts: 3,
    payload: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAST_CONFIG: ScheduleConfig = { tickIntervalMs: 50 };

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('pino').Logger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scheduler', () => {
  let db: Database.Database;
  let scheduleRepo: ScheduleRepository;
  let personaId: string;
  let threadId: string;
  let scheduler: Scheduler;
  let queueStub: QueueManager;
  let personaLoader: PersonaLoader;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    db = createTestDb();
    scheduleRepo = new ScheduleRepository(db);
    personaId = seedPersona(db);
    threadId = seedThread(db);
    queueStub = makeQueueStub();
    logger = makeLogger();
    personaLoader = {
      resolveTaskPrompt: vi.fn(),
      getById: vi.fn(() => ok({ config: { name: 'assistant' } })),
    } as unknown as PersonaLoader;
    scheduler = new Scheduler(scheduleRepo, queueStub, personaLoader, FAST_CONFIG, logger);
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  // -------------------------------------------------------------------------
  // Basic lifecycle
  // -------------------------------------------------------------------------

  describe('start / stop', () => {
    it('starts without error when no schedules are due', async () => {
      scheduler.start();
      await wait(120);
      scheduler.stop();
      // No assertion needed — just must not throw
    });

    it('logs a warning and returns early if start() called twice', () => {
      scheduler.start();
      // Second call should not throw
      scheduler.start();
      scheduler.stop();
    });

    it('stop() is safe to call before start()', () => {
      // Should not throw
      scheduler.stop();
    });

    it('does not process new schedules after stop()', async () => {
      // Seed a schedule, start, let one tick run, then stop, then seed another
      // and confirm only the first was enqueued.
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      scheduler.start();
      await wait(120);
      scheduler.stop();

      const callsAfterStop = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls.length;

      // Seed another due schedule after stop
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      await wait(200);

      const callsLater = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsLater).toBe(callsAfterStop);
    });

    it('joins an in-flight prompt lookup and does not enqueue after draining starts', async () => {
      let resolvePrompt!: (value: ReturnType<typeof ok>) => void;
      const prompt = new Promise<ReturnType<typeof ok>>((resolve) => {
        resolvePrompt = resolve;
      });
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify({ promptFile: 'slow-prompt' }),
      });
      vi.mocked(personaLoader.resolveTaskPrompt).mockReturnValue(prompt as any);

      scheduler.start();
      await vi.waitFor(() => expect(personaLoader.resolveTaskPrompt).toHaveBeenCalledOnce());
      const stopping = scheduler.stop();
      expect(queueStub.enqueue).not.toHaveBeenCalled();

      resolvePrompt(ok('late prompt'));
      await stopping;
      expect(queueStub.enqueue).not.toHaveBeenCalled();
    });

    it('does not let a stale prompt lookup enqueue or mutate state after a direct restart', async () => {
      vi.useFakeTimers();
      let resolveOldPrompt!: (value: ReturnType<typeof ok>) => void;
      let resolveNewPrompt!: (value: ReturnType<typeof ok>) => void;
      const oldPrompt = new Promise<ReturnType<typeof ok>>((resolve) => {
        resolveOldPrompt = resolve;
      });
      const newPrompt = new Promise<ReturnType<typeof ok>>((resolve) => {
        resolveNewPrompt = resolve;
      });
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify({ promptFile: 'slow-prompt' }),
      });
      vi.mocked(personaLoader.resolveTaskPrompt)
        .mockReturnValueOnce(oldPrompt as any)
        .mockReturnValueOnce(newPrompt as any);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(personaLoader.resolveTaskPrompt).toHaveBeenCalledOnce());
      const firstStop = scheduler.stop(10);
      await vi.advanceTimersByTimeAsync(10);
      expect(await firstStop).toEqual({ status: 'timed_out' });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(personaLoader.resolveTaskPrompt).toHaveBeenCalledTimes(2));

      resolveOldPrompt(ok('stale prompt'));
      await vi.advanceTimersByTimeAsync(0);

      expect(queueStub.enqueue).not.toHaveBeenCalled();
      expect(scheduleRepo.findById(scheduleId)._unsafeUnwrap()?.enabled).toBe(1);

      const secondStop = scheduler.stop(10);
      resolveNewPrompt(ok('current prompt'));
      await vi.advanceTimersByTimeAsync(10);
      await secondStop;
      vi.useRealTimers();
    });

    it('returns a finite timeout for a non-settling prompt lookup without later enqueue', async () => {
      vi.useFakeTimers();
      let resolvePrompt!: (value: ReturnType<typeof ok>) => void;
      const prompt = new Promise<ReturnType<typeof ok>>((resolve) => {
        resolvePrompt = resolve;
      });
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify({ promptFile: 'never-settles' }),
      });
      vi.mocked(personaLoader.resolveTaskPrompt).mockReturnValue(prompt as any);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      const stopping = scheduler.stop(10);
      await vi.advanceTimersByTimeAsync(10);
      expect(await stopping).toEqual({ status: 'timed_out' });

      resolvePrompt(ok('late prompt'));
      await vi.runAllTimersAsync();
      expect(queueStub.enqueue).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // one_shot schedule
  // -------------------------------------------------------------------------

  describe('one_shot schedule', () => {
    it('enqueues a due one_shot schedule', async () => {
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('publishes schedule provenance atomically with the queue and schedule state', async () => {
      const lifecycleRuntime = {
        transaction: vi.fn((callback) => callback({})),
        publish: vi.fn(() => ok({})),
      };
      const lifecycleQueue = makeQueueStub();
      vi.mocked(lifecycleQueue.enqueueInLifecycleTransaction).mockReturnValue(
        ok(makeQueueItem({ id: 'queue-item-1', threadId })),
      );
      scheduler = new Scheduler(
        scheduleRepo,
        lifecycleQueue,
        personaLoader,
        FAST_CONFIG,
        logger,
        lifecycleRuntime as any,
      );
      const scheduleId = seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(lifecycleRuntime.transaction).toHaveBeenCalledOnce();
      expect(lifecycleQueue.enqueueInLifecycleTransaction).toHaveBeenCalledWith(
        threadId,
        'schedule',
        expect.objectContaining({ personaId }),
        { persona: 'assistant', itemType: 'schedule' },
        expect.anything(),
      );
      expect(lifecycleRuntime.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'schedule.fired.v1',
            context: expect.objectContaining({
              aggregate: { type: 'schedule', id: scheduleId },
              provenance: expect.objectContaining({ source: 'scheduler' }),
            }),
            payload: expect.objectContaining({
              references: expect.arrayContaining([
                { type: 'schedule', id: scheduleId },
                { type: 'queue_item', id: 'queue-item-1' },
              ]),
              metadata: { scheduleType: 'one_shot' },
            }),
          }),
          persona: 'assistant',
          itemOrigin: 'scheduler',
          scheduleSource: 'oneshot',
        }),
        expect.anything(),
      );
      expect(scheduleRepo.findById(scheduleId)._unsafeUnwrap()?.enabled).toBe(0);
    });

    it('does not enqueue or advance a lifecycle schedule when persona scope is unavailable', async () => {
      const lifecycleRuntime = {
        transaction: vi.fn(),
        publish: vi.fn(),
      };
      const lifecycleQueue = makeQueueStub();
      vi.mocked(personaLoader.getById).mockReturnValue(ok(undefined) as any);
      scheduler = new Scheduler(
        scheduleRepo,
        lifecycleQueue,
        personaLoader,
        FAST_CONFIG,
        logger,
        lifecycleRuntime as any,
      );
      const scheduleId = seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      await scheduler.stop();

      expect(lifecycleQueue.enqueue).not.toHaveBeenCalled();
      expect(lifecycleQueue.enqueueInLifecycleTransaction).not.toHaveBeenCalled();
      expect(lifecycleRuntime.transaction).not.toHaveBeenCalled();
      expect(scheduleRepo.findById(scheduleId)._unsafeUnwrap()?.enabled).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ scheduleId, personaId }),
        'scheduler: lifecycle persona unavailable; schedule will be retried without enqueue',
      );
    });

    it('disables the schedule after firing', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        enabled: number;
      };
      expect(row.enabled).toBe(0);
    });

    it('does not fire the same one_shot schedule twice', async () => {
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });

      scheduler.start();
      // Wait for several tick intervals
      await wait(300);
      scheduler.stop();

      // Should have fired exactly once
      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('passes the parsed payload to enqueue', async () => {
      const payload = { message: 'hello', num: 42 };
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify(payload),
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      // Scheduler injects personaId and content from schedule row.
      expect(queueStub.enqueue).toHaveBeenCalledWith(threadId, 'schedule', {
        ...payload,
        personaId,
        content: '',
      });
    });

    it('maps schedule prompt to content for AgentRunner compatibility', async () => {
      const payload = { label: 'Daily', prompt: 'Summarize open issues' };
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify(payload),
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledWith(threadId, 'schedule', {
        label: 'Daily',
        prompt: 'Summarize open issues',
        personaId,
        content: 'Summarize open issues',
      });
    });

    it('resolves promptFile to content when the schedule fires', async () => {
      vi.mocked(personaLoader.resolveTaskPrompt).mockResolvedValue(
        ok('Rendered prompt file contents'),
      );
      const payload = { label: 'Morning briefing', promptFile: 'morning-briefing' };
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify(payload),
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(personaLoader.resolveTaskPrompt).toHaveBeenCalledWith(personaId, 'morning-briefing');
      expect(queueStub.enqueue).toHaveBeenCalledWith(threadId, 'schedule', {
        label: 'Morning briefing',
        promptFile: 'morning-briefing',
        personaId,
        content: 'Rendered prompt file contents',
      });
    });

    it('promotes prompt:"file:NAME" to a promptFile alias and resolves it', async () => {
      // Regression guard: an agent/human that creates a schedule with
      // `prompt: "file:foo"` (a non-documented convention they invented)
      // would otherwise ship the literal string to the agent, which then
      // wastes turns greppingfor the file. The scheduler defensively
      // recognises the prefix and routes through resolveTaskPrompt.
      vi.mocked(personaLoader.resolveTaskPrompt).mockResolvedValue(ok('Resolved prompt body'));
      const payload = { label: 'Braintoss', prompt: 'file:braintoss' };
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify(payload),
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(personaLoader.resolveTaskPrompt).toHaveBeenCalledWith(personaId, 'braintoss');
      const enqueueCalls = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls;
      expect(enqueueCalls).toHaveLength(1);
      const enqueued = enqueueCalls[0][2] as Record<string, unknown>;
      expect(enqueued.content).toBe('Resolved prompt body');
      // The literal `file:braintoss` string must NOT survive into content
      // — otherwise the agent would still see it and discover the file.
      expect(enqueued.content).not.toContain('file:braintoss');
    });

    it('does NOT promote a prompt whose body legitimately starts with "file:"', async () => {
      // Regression guard: a prompt like `"file: summarize the latest backup log"`
      // is real prose, not a promptFile alias. A loose `startsWith("file:")`
      // check would discard the body and call resolveTaskPrompt() with a
      // nonexistent alias — leaving the schedule stuck (no enqueue, no
      // next-run advance). The strict `^file:<name>$` pattern guarantees
      // only the exact agent-invented shape is promoted.
      const prose = 'file: summarize the latest backup log';
      const payload = { label: 'Prose with colon', prompt: prose };
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify(payload),
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(personaLoader.resolveTaskPrompt).not.toHaveBeenCalled();
      const enqueueCalls = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls;
      expect(enqueueCalls).toHaveLength(1);
      const enqueued = enqueueCalls[0][2] as Record<string, unknown>;
      expect(enqueued.content).toBe(prose);
    });

    it('does NOT promote "file:" followed by content with spaces or special chars', async () => {
      // A few near-miss patterns that must NOT be treated as aliases:
      // file:name with space, file:name@host, file:/absolute/path, etc.
      const nearMisses = ['file:my name', 'file:user@host', 'file:/etc/passwd', 'file:name?query'];

      for (const prompt of nearMisses) {
        vi.mocked(personaLoader.resolveTaskPrompt).mockClear();
        (queueStub.enqueue as ReturnType<typeof vi.fn>).mockClear();
        const myThread = seedThread(db);
        seedDueSchedule(db, personaId, myThread, {
          type: 'one_shot',
          payload: JSON.stringify({ label: 'near-miss', prompt }),
        });

        scheduler.start();
        await wait(150);
        scheduler.stop();

        expect(personaLoader.resolveTaskPrompt).not.toHaveBeenCalled();
        const calls = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const last = calls[calls.length - 1][2] as Record<string, unknown>;
        expect(last.content).toBe(prompt);
      }
    });

    it('prefers explicit promptFile over a file:-prefixed prompt when both are set', async () => {
      // If a schedule somehow has BOTH `promptFile: "real"` and
      // `prompt: "file:other"`, the explicit promptFile wins — the
      // defensive promotion is fallback-only, not an override.
      vi.mocked(personaLoader.resolveTaskPrompt).mockResolvedValue(ok('Real body'));
      const payload = {
        label: 'Mixed',
        promptFile: 'real',
        prompt: 'file:other',
      };
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify(payload),
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(personaLoader.resolveTaskPrompt).toHaveBeenCalledWith(personaId, 'real');
    });

    it('uses the thread_id of the schedule when enqueuing', async () => {
      const anotherThread = seedThread(db);
      seedDueSchedule(db, personaId, anotherThread, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const calls = (queueStub.enqueue as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe(anotherThread);
    });
  });

  // -------------------------------------------------------------------------
  // event schedule
  // -------------------------------------------------------------------------

  describe('event schedule', () => {
    it('enqueues a due event schedule', async () => {
      seedDueSchedule(db, personaId, threadId, {
        type: 'event',
        expression: 'my-event',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('disables the event schedule after firing', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'event',
        expression: 'my-event',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        enabled: number;
      };
      expect(row.enabled).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // interval schedule
  // -------------------------------------------------------------------------

  describe('interval schedule', () => {
    it('enqueues a due interval schedule', async () => {
      // Expression is interval in ms; schedule is already due
      seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: '10000', // 10 second interval
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('updates next_run_at after firing an interval schedule', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: '60000', // 60s interval
      });

      const before = Date.now();
      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db
        .prepare('SELECT next_run_at, last_run_at, enabled FROM schedules WHERE id = ?')
        .get(scheduleId) as {
        next_run_at: number;
        last_run_at: number;
        enabled: number;
      };

      // Should be re-enabled with a future next_run_at
      expect(row.enabled).toBe(1);
      expect(row.next_run_at).toBeGreaterThanOrEqual(before + 60000);
      expect(row.last_run_at).toBeGreaterThanOrEqual(before);
    });

    it('does not fire an interval schedule again before its next_run_at', async () => {
      // Set next_run_at far in the future after first run
      seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: '300000', // 5 minute interval — will not come due again in test window
      });

      scheduler.start();
      // Allow several tick cycles
      await wait(300);
      scheduler.stop();

      // Should fire only once
      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('disables an interval schedule with an invalid expression', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: 'not-a-number',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        enabled: number;
      };
      // Invalid interval expression — should be disabled
      expect(row.enabled).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // cron schedule
  // -------------------------------------------------------------------------

  describe('cron schedule', () => {
    it('enqueues a due cron schedule', async () => {
      // Use "* * * * *" (every minute). The test seeds it as already due.
      seedDueSchedule(db, personaId, threadId, {
        type: 'cron',
        expression: '* * * * *',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });

    it('updates next_run_at after firing a cron schedule', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'cron',
        expression: '* * * * *',
      });

      const before = Date.now();
      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db
        .prepare('SELECT next_run_at, last_run_at, enabled FROM schedules WHERE id = ?')
        .get(scheduleId) as {
        next_run_at: number;
        last_run_at: number;
        enabled: number;
      };

      // Cron schedule should remain enabled and have a future next_run_at
      expect(row.enabled).toBe(1);
      expect(row.next_run_at).toBeGreaterThan(before);
      expect(row.last_run_at).toBeGreaterThanOrEqual(before);
    });

    it('disables a cron schedule with an invalid expression', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'cron',
        expression: 'not-a-cron',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(scheduleId) as {
        enabled: number;
      };
      // Invalid cron expression — should be disabled
      expect(row.enabled).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Null thread_id
  // -------------------------------------------------------------------------

  describe('null thread_id', () => {
    it('skips enqueue for schedules without a thread_id', async () => {
      // Seed a schedule with null thread_id — FK constraint allows it
      db.pragma('foreign_keys = OFF');
      seedDueSchedule(db, personaId, null, { type: 'one_shot' });
      db.pragma('foreign_keys = ON');

      scheduler.start();
      await wait(150);
      scheduler.stop();

      // enqueue should not have been called since there is no thread
      expect(queueStub.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple schedules
  // -------------------------------------------------------------------------

  describe('multiple due schedules', () => {
    it('enqueues all due schedules on a single tick', async () => {
      const thread2 = seedThread(db);
      const thread3 = seedThread(db);

      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      seedDueSchedule(db, personaId, thread2, { type: 'one_shot' });
      seedDueSchedule(db, personaId, thread3, { type: 'one_shot' });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).toHaveBeenCalledTimes(3);
    });

    it('does not enqueue a schedule that is not yet due', async () => {
      // Due schedule
      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      // Future schedule — next_run_at is 60 seconds from now
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        next_run_at: Date.now() + 60_000,
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      // Only the first (due) schedule should be enqueued
      expect(queueStub.enqueue).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('continues processing other schedules when enqueue fails for one', async () => {
      const thread2 = seedThread(db);

      seedDueSchedule(db, personaId, threadId, { type: 'one_shot' });
      seedDueSchedule(db, personaId, thread2, { type: 'one_shot' });

      const thread2Calls: string[] = [];
      const failingStub = makeQueueStub((tId) => {
        if (tId === threadId) {
          return err(new QueueError('enqueue failed'));
        }
        thread2Calls.push(tId);
        return ok(makeQueueItem({ threadId: tId }));
      });

      scheduler = new Scheduler(scheduleRepo, failingStub, personaLoader, FAST_CONFIG, logger);
      scheduler.start();
      await wait(150);
      scheduler.stop();

      // thread2 schedule should have been successfully enqueued once
      // (even though threadId schedule failed on each tick)
      expect(thread2Calls.length).toBe(1);
    });

    it('does not advance schedule state when enqueue fails', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'interval',
        expression: '10000',
      });

      const errorStub = makeQueueStub(() => err(new QueueError('enqueue failed')));
      scheduler = new Scheduler(scheduleRepo, errorStub, personaLoader, FAST_CONFIG, logger);
      scheduler.start();
      await wait(150);
      scheduler.stop();

      const row = db.prepare('SELECT next_run_at FROM schedules WHERE id = ?').get(scheduleId) as {
        next_run_at: number;
      };
      // next_run_at should not have been updated to the future
      expect(row.next_run_at).toBeLessThan(Date.now());
    });

    it('handles a findDue database error gracefully without crashing', async () => {
      // Replace scheduleRepo with a stub that returns an error
      const { DbError } = await import('../../../src/core/errors/index.js');
      const faultyRepo = {
        findDue: vi.fn(() => err(new DbError('db is broken'))),
        updateNextRun: vi.fn(() => ok(null)),
        disable: vi.fn(() => ok(undefined)),
      } as unknown as ScheduleRepository;

      scheduler = new Scheduler(faultyRepo, queueStub, personaLoader, FAST_CONFIG, logger);

      // Should not throw
      scheduler.start();
      await wait(150);
      scheduler.stop();
    });

    it('falls back to empty payload when schedule payload is invalid JSON', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: 'not-json',
      });

      scheduler.start();
      await wait(150);
      scheduler.stop();

      // enqueue should still be called — scheduler injects personaId and content.
      expect(queueStub.enqueue).toHaveBeenCalledWith(threadId, 'schedule', {
        personaId,
        content: '',
      });
      void scheduleId;
    });

    it('skips enqueue and does not advance the schedule when promptFile resolution fails', async () => {
      const scheduleId = seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify({ label: 'Morning briefing', promptFile: 'missing-prompt' }),
      });
      vi.mocked(personaLoader.resolveTaskPrompt).mockResolvedValue(
        err(new PersonaError('Task prompt "missing-prompt" not found')),
      );

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(queueStub.enqueue).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT next_run_at, last_run_at FROM schedules WHERE id = ?')
        .get(scheduleId) as {
        next_run_at: number;
        last_run_at: number | null;
      };
      expect(row.next_run_at).toBeLessThan(Date.now());
      expect(row.last_run_at).toBeNull();
    });

    it('catches unexpected rejected prompt resolution and logs per-schedule error', async () => {
      seedDueSchedule(db, personaId, threadId, {
        type: 'one_shot',
        payload: JSON.stringify({ label: 'Morning briefing', promptFile: 'broken-prompt' }),
      });
      vi.mocked(personaLoader.resolveTaskPrompt).mockRejectedValue(new Error('disk read exploded'));

      scheduler.start();
      await wait(150);
      scheduler.stop();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
        }),
        'scheduler: unexpected error processing schedule',
      );
      expect(queueStub.enqueue).not.toHaveBeenCalled();
    });
  });
});
