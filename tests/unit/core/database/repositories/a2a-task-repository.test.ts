import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { A2ATaskRepository } from '../../../../../src/core/database/repositories/a2a-task-repository.js';
import { ThreadRepository } from '../../../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('A2ATaskRepository state guards and admission', () => {
  let db: Database.Database;
  let repo: A2ATaskRepository;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new A2ATaskRepository(db);
    const channelId = uuid();
    new ChannelRepository(db).insert({
      id: channelId,
      type: 'terminal',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    threadId = uuid();
    new ThreadRepository(db).insert({
      id: threadId,
      channel_id: channelId,
      external_id: `ext-${uuid()}`,
      metadata: '{}',
    });
  });

  afterEach(() => {
    db.close();
  });

  const insert = (target = 'worker', submittedAt = Date.now(), id = uuid()): string => {
    repo
      .insertSubmitted({
        id,
        source_persona: 'src',
        target_persona: target,
        thread_id: threadId,
        request_payload: '{}',
        hop_count: 0,
        parent_task_id: null,
        submitted_at: submittedAt,
      })
      ._unsafeUnwrap();
    return id;
  };
  const state = (id: string): string => repo.findById(id)._unsafeUnwrap()!.state;

  describe('state guards', () => {
    it('markWorking/markCompleted work from submitted and working', () => {
      const id = insert();
      expect(repo.markWorking(id, null as unknown as string)._unsafeUnwrap()).toBe(true);
      expect(state(id)).toBe('working');
      expect(repo.markWorking(id, null as unknown as string)._unsafeUnwrap()).toBe(true);
      expect(repo.markCompleted(id, 'done')._unsafeUnwrap()).toBe(true);
      expect(state(id)).toBe('completed');
    });

    it.each(['completed', 'failed', 'canceled'] as const)('terminal state %s is never overwritten', (terminal) => {
      const id = insert();
      if (terminal === 'completed') repo.markCompleted(id, 'r');
      if (terminal === 'failed') repo.markFailed(id, 'E', 'm');
      if (terminal === 'canceled') repo.markCanceled(id, 'why');
      const before = repo.findById(id)._unsafeUnwrap()!;

      expect(repo.markWorking(id, null as unknown as string)._unsafeUnwrap()).toBe(false);
      expect(repo.markCompleted(id, 'late')._unsafeUnwrap()).toBe(false);
      expect(repo.markFailed(id, 'LATE', 'late')._unsafeUnwrap()).toBe(false);
      expect(repo.markCanceled(id, 'late')._unsafeUnwrap()).toBe(false);

      const after = repo.findById(id)._unsafeUnwrap()!;
      expect(after.state).toBe(terminal);
      expect(after.result_payload).toBe(before.result_payload);
      expect(after.error_code).toBe(before.error_code);
      expect(after.error_message).toBe(before.error_message);
    });

    it('markFailed and markCanceled set completed_at and record error info', () => {
      const failed = insert();
      repo.markFailed(failed, 'BOOM', 'it broke');
      const f = repo.findById(failed)._unsafeUnwrap()!;
      expect(f.completed_at).not.toBeNull();
      expect(f.error_code).toBe('BOOM');

      const canceled = insert();
      repo.markCanceled(canceled, 'nope');
      const c = repo.findById(canceled)._unsafeUnwrap()!;
      expect(c.completed_at).not.toBeNull();
      expect(c.error_code).toBe('CANCELED');
      expect(c.error_message).toBe('nope');
    });

    it('markFailed/markCanceled work from input-required; markCompleted does not', () => {
      const id = insert();
      db.prepare("UPDATE a2a_tasks SET state = 'input-required' WHERE id = ?").run(id);
      expect(repo.markCompleted(id, 'x')._unsafeUnwrap()).toBe(false);
      expect(repo.markFailed(id, 'E', 'm')._unsafeUnwrap()).toBe(true);
    });

    it('returns Ok(false) for unknown ids', () => {
      expect(repo.markFailed('nope', 'E', 'm')._unsafeUnwrap()).toBe(false);
      expect(repo.markCanceled('nope', 'r')._unsafeUnwrap()).toBe(false);
    });
  });

  describe('tryAdmit', () => {
    it('reports missing and terminal tasks', () => {
      expect(repo.tryAdmit('nope', 1)._unsafeUnwrap()).toBe('missing');
      const id = insert();
      repo.markCanceled(id, 'x');
      expect(repo.tryAdmit(id, 1)._unsafeUnwrap()).toBe('terminal');
    });

    it('admits a submitted task under the limit and marks it working', () => {
      const id = insert();
      expect(repo.tryAdmit(id, 1)._unsafeUnwrap()).toBe('admitted');
      expect(state(id)).toBe('working');
    });

    it('re-admits a task that is already working (retry / crash recovery)', () => {
      const id = insert();
      repo.tryAdmit(id, 1);
      expect(repo.tryAdmit(id, 1)._unsafeUnwrap()).toBe('admitted');
    });

    it('waits when the target is at its concurrency limit', () => {
      const a = insert('worker', 1000);
      const b = insert('worker', 2000);
      expect(repo.tryAdmit(a, 1)._unsafeUnwrap()).toBe('admitted');
      expect(repo.tryAdmit(b, 1)._unsafeUnwrap()).toBe('wait');
      expect(state(b)).toBe('submitted');
      repo.markCompleted(a, 'done');
      expect(repo.tryAdmit(b, 1)._unsafeUnwrap()).toBe('admitted');
    });

    it('is FIFO: a newer task cannot jump ahead of an older submitted one', () => {
      const older = insert('worker', 1000, 'a-older');
      const newer = insert('worker', 2000, 'b-newer');
      expect(repo.tryAdmit(newer, 1)._unsafeUnwrap()).toBe('wait');
      expect(repo.tryAdmit(older, 1)._unsafeUnwrap()).toBe('admitted');
    });

    it('breaks submitted_at ties by id', () => {
      const first = insert('worker', 1000, 'a');
      const second = insert('worker', 1000, 'b');
      expect(repo.tryAdmit(second, 1)._unsafeUnwrap()).toBe('wait');
      expect(repo.tryAdmit(first, 1)._unsafeUnwrap()).toBe('admitted');
    });

    it('honors limits > 1 and ignores other targets', () => {
      const a = insert('worker', 1000);
      const b = insert('worker', 2000);
      const c = insert('worker', 3000);
      const other = insert('other', 4000);
      expect(repo.tryAdmit(a, 2)._unsafeUnwrap()).toBe('admitted');
      expect(repo.tryAdmit(b, 2)._unsafeUnwrap()).toBe('admitted');
      expect(repo.tryAdmit(c, 2)._unsafeUnwrap()).toBe('wait');
      expect(repo.tryAdmit(other, 1)._unsafeUnwrap()).toBe('admitted');
    });
  });

  describe('counts and reaper query', () => {
    it('countQueuedByTarget counts only submitted tasks', () => {
      const a = insert('worker', 1000);
      insert('worker', 2000);
      repo.tryAdmit(a, 1);
      expect(repo.countQueuedByTarget('worker')._unsafeUnwrap()).toBe(1);
      expect(repo.countActiveByTarget('worker')._unsafeUnwrap()).toBe(2);
    });

    it('findNonTerminalWithQueueStatus excludes terminal tasks and reports null queue status', () => {
      const live = insert();
      const done = insert();
      repo.markCompleted(done, 'x');
      const rows = repo.findNonTerminalWithQueueStatus()._unsafeUnwrap();
      expect(rows.map((r) => r.id)).toEqual([live]);
      expect(rows[0]!.queue_status).toBeNull();
    });
  });
});
