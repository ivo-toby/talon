import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScriptRepository } from '../../../../../src/core/database/repositories/script-repository.js';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import type {
  ScriptRow,
  ScriptVersionRow,
} from '../../../../../src/core/database/repositories/script-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('ScriptRepository', () => {
  let db: Database.Database;
  let repo: ScriptRepository;
  let personaId: string;
  let script: ScriptRow;

  function makePersona(): string {
    const id = uuid();
    const r = new PersonaRepository(db).insert({
      id,
      name: `p-${id}`,
      model: 'm',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
    expect(r.isOk()).toBe(true);
    return id;
  }

  function makeVersion(s: ScriptRow = script): ScriptVersionRow {
    return repo
      .insertVersion({
        id: uuid(),
        scriptId: s.id,
        contentHash: 'h',
        manifest: '{}',
        threadId: null,
      })
      ._unsafeUnwrap();
  }

  /** A version in `awaiting-approval` with one open approval. */
  function makeAwaiting(s: ScriptRow = script): { version: ScriptVersionRow; approvalId: string } {
    const version = makeVersion(s);
    expect(repo.setVersionState(version.id, ['draft'], 'awaiting-approval')._unsafeUnwrap()).toBe(
      true,
    );
    const approvalId = uuid();
    repo
      .insertApproval({
        id: approvalId,
        versionId: version.id,
        codeHash: `code-${approvalId}`,
        channelName: 'tg',
        externalThreadId: 't1',
        expiresAt: 10_000,
      })
      ._unsafeUnwrap();
    return { version, approvalId };
  }

  beforeEach(() => {
    db = createTestDb();
    repo = new ScriptRepository(db);
    personaId = makePersona();
    script = repo.upsertScript(personaId, 'daily', uuid())._unsafeUnwrap();
  });

  describe('scripts', () => {
    it('upsertScript returns the existing row for the same persona and name', () => {
      const again = repo.upsertScript(personaId, 'daily', uuid())._unsafeUnwrap();
      expect(again.id).toBe(script.id);
      expect(repo.findScript(personaId, 'daily')._unsafeUnwrap()?.id).toBe(script.id);
    });

    it('keeps names separate per persona', () => {
      const other = repo.upsertScript(makePersona(), 'daily', uuid())._unsafeUnwrap();
      expect(other.id).not.toBe(script.id);
    });

    it('findScript returns null when missing', () => {
      expect(repo.findScript(personaId, 'nope')._unsafeUnwrap()).toBeNull();
    });
  });

  describe('versions', () => {
    it('starts as draft and counts up from 1 per script', () => {
      const v1 = makeVersion();
      const v2 = makeVersion();
      const otherScript = repo.upsertScript(personaId, 'other', uuid())._unsafeUnwrap();
      const o1 = makeVersion(otherScript);
      expect([v1.version, v2.version, o1.version]).toEqual([1, 2, 1]);
      expect(v1.state).toBe('draft');
      expect(v1.dry_run_report).toBeNull();
      expect(repo.latestVersion(script.id)._unsafeUnwrap()?.id).toBe(v2.id);
      expect(repo.getVersion(v1.id)._unsafeUnwrap()?.manifest).toBe('{}');
      expect(repo.getVersion('missing')._unsafeUnwrap()).toBeNull();
      expect(repo.latestVersion(otherScript.id)._unsafeUnwrap()?.id).toBe(o1.id);
    });

    it('latestVersion is null without versions', () => {
      expect(repo.latestVersion(script.id)._unsafeUnwrap()).toBeNull();
    });

    it('setVersionState only moves from a listed state', () => {
      const v = makeVersion();
      expect(repo.setVersionState(v.id, ['tested'], 'awaiting-approval')._unsafeUnwrap()).toBe(
        false,
      );
      expect(repo.getVersion(v.id)._unsafeUnwrap()?.state).toBe('draft');
      expect(repo.setVersionState(v.id, ['tested', 'draft'], 'tested')._unsafeUnwrap()).toBe(true);
      expect(repo.getVersion(v.id)._unsafeUnwrap()?.state).toBe('tested');
      expect(repo.setVersionState(v.id, [], 'draft')._unsafeUnwrap()).toBe(false);
    });

    it('setVersionState refreshes updated_at', () => {
      const v = makeVersion();
      repo.setVersionState(v.id, ['draft'], 'tested');
      expect(repo.getVersion(v.id)._unsafeUnwrap()!.updated_at).toBeGreaterThan(v.updated_at);
    });

    it('rejects a state outside the six', () => {
      const v = makeVersion();
      expect(() =>
        db.prepare(`UPDATE script_versions SET state = 'bogus' WHERE id = ?`).run(v.id),
      ).toThrow();
    });

    it('setDryRunReport stores the text', () => {
      const v = makeVersion();
      expect(repo.setDryRunReport(v.id, '{"calls":2}').isOk()).toBe(true);
      expect(repo.getVersion(v.id)._unsafeUnwrap()?.dry_run_report).toBe('{"calls":2}');
    });

    it('latestApproved returns the approved version with the highest number', () => {
      expect(repo.latestApproved(script.id)._unsafeUnwrap()).toBeNull();
      const v1 = makeVersion();
      const v2 = makeVersion();
      makeVersion();
      repo.setVersionState(v1.id, ['draft'], 'approved');
      repo.setVersionState(v2.id, ['draft'], 'approved');
      expect(repo.latestApproved(script.id)._unsafeUnwrap()?.id).toBe(v2.id);
    });
  });

  describe('approvals', () => {
    it('finds an open approval by code hash and not a decided one', () => {
      const { approvalId } = makeAwaiting();
      const found = repo.findOpenApproval(`code-${approvalId}`)._unsafeUnwrap();
      expect(found?.id).toBe(approvalId);
      expect(found?.expires_at).toBe(10_000);
      expect(repo.findOpenApproval('unknown')._unsafeUnwrap()).toBeNull();
      repo.decideApproval(approvalId, 'rejected', 500);
      expect(repo.findOpenApproval(`code-${approvalId}`)._unsafeUnwrap()).toBeNull();
    });

    it('enforces a unique code hash', () => {
      const { version, approvalId } = makeAwaiting();
      const dup = repo.insertApproval({
        id: uuid(),
        versionId: version.id,
        codeHash: `code-${approvalId}`,
        channelName: 'tg',
        externalThreadId: 't1',
        expiresAt: 1,
      });
      expect(dup.isErr()).toBe(true);
    });

    it('expireOpenApprovals expires only undecided approvals of that version', () => {
      const a = makeAwaiting();
      const b = makeAwaiting();
      repo.expireOpenApprovals(a.version.id, 42)._unsafeUnwrap();
      expect(repo.findOpenApproval(`code-${a.approvalId}`)._unsafeUnwrap()?.expires_at).toBe(42);
      expect(repo.findOpenApproval(`code-${b.approvalId}`)._unsafeUnwrap()?.expires_at).toBe(
        10_000,
      );
    });

    it('expireOpenApprovals leaves a decided approval alone', () => {
      const a = makeAwaiting();
      repo.decideApproval(a.approvalId, 'approved', 100);
      repo.expireOpenApprovals(a.version.id, 42)._unsafeUnwrap();
      const row = db
        .prepare(`SELECT expires_at FROM script_approvals WHERE id = ?`)
        .get(a.approvalId) as { expires_at: number };
      expect(row.expires_at).toBe(10_000);
    });
  });

  describe('decideApproval', () => {
    it('approves, moves the version and retires the older approved one', () => {
      const old = makeVersion();
      repo.setVersionState(old.id, ['draft'], 'approved');
      const { version, approvalId } = makeAwaiting();

      expect(repo.decideApproval(approvalId, 'approved', 777)._unsafeUnwrap()).toBe(true);

      expect(repo.getVersion(version.id)._unsafeUnwrap()?.state).toBe('approved');
      expect(repo.getVersion(old.id)._unsafeUnwrap()?.state).toBe('retired');
      const row = db
        .prepare(`SELECT decided_at, decision FROM script_approvals WHERE id = ?`)
        .get(approvalId) as { decided_at: number; decision: string };
      expect(row).toEqual({ decided_at: 777, decision: 'approved' });
      expect(repo.latestApproved(script.id)._unsafeUnwrap()?.id).toBe(version.id);
    });

    it('does not retire approved versions of another script', () => {
      const otherScript = repo.upsertScript(personaId, 'other', uuid())._unsafeUnwrap();
      const otherV = makeVersion(otherScript);
      repo.setVersionState(otherV.id, ['draft'], 'approved');
      const { approvalId } = makeAwaiting();
      repo.decideApproval(approvalId, 'approved', 1);
      expect(repo.getVersion(otherV.id)._unsafeUnwrap()?.state).toBe('approved');
    });

    it('rejects: version becomes rejected and approved versions stay', () => {
      const old = makeVersion();
      repo.setVersionState(old.id, ['draft'], 'approved');
      const { version, approvalId } = makeAwaiting();
      expect(repo.decideApproval(approvalId, 'rejected', 5)._unsafeUnwrap()).toBe(true);
      expect(repo.getVersion(version.id)._unsafeUnwrap()?.state).toBe('rejected');
      expect(repo.getVersion(old.id)._unsafeUnwrap()?.state).toBe('approved');
    });

    it('a second decision changes nothing', () => {
      const { version, approvalId } = makeAwaiting();
      expect(repo.decideApproval(approvalId, 'approved', 10)._unsafeUnwrap()).toBe(true);
      expect(repo.decideApproval(approvalId, 'rejected', 20)._unsafeUnwrap()).toBe(false);
      expect(repo.getVersion(version.id)._unsafeUnwrap()?.state).toBe('approved');
      const row = db
        .prepare(`SELECT decided_at, decision FROM script_approvals WHERE id = ?`)
        .get(approvalId) as { decided_at: number; decision: string };
      expect(row).toEqual({ decided_at: 10, decision: 'approved' });
    });

    it('changes nothing when the version is no longer awaiting approval', () => {
      const { version, approvalId } = makeAwaiting();
      repo.setVersionState(version.id, ['awaiting-approval'], 'retired');
      expect(repo.decideApproval(approvalId, 'approved', 10)._unsafeUnwrap()).toBe(false);
      expect(repo.getVersion(version.id)._unsafeUnwrap()?.state).toBe('retired');
      const row = db
        .prepare(`SELECT decided_at, decision FROM script_approvals WHERE id = ?`)
        .get(approvalId) as { decided_at: number | null; decision: string | null };
      expect(row).toEqual({ decided_at: null, decision: null });
    });

    it('returns false for an unknown approval', () => {
      expect(repo.decideApproval('missing', 'approved', 1)._unsafeUnwrap()).toBe(false);
    });
  });

  describe('runs', () => {
    function startRun(
      version: ScriptVersionRow,
      trigger: 'test' | 'dry-run' | 'schedule',
      at: number,
    ): string {
      const id = uuid();
      const row = repo
        .insertRun({
          id,
          versionId: version.id,
          mode: 'live',
          trigger,
          scheduleId: 'sched-1',
          startedAt: at,
        })
        ._unsafeUnwrap();
      expect(row.ended_at).toBeNull();
      expect(row.ok).toBeNull();
      expect(row.call_count).toBe(0);
      return id;
    }

    it('activeRun returns the newest unfinished run across versions', () => {
      const v1 = makeVersion();
      const v2 = makeVersion();
      expect(repo.activeRun(script.id)._unsafeUnwrap()).toBeNull();
      startRun(v1, 'test', 100);
      const newest = startRun(v2, 'schedule', 200);
      expect(repo.activeRun(script.id)._unsafeUnwrap()?.id).toBe(newest);
      repo.finishRun(newest, true, null, 3, 300);
      expect(repo.activeRun(script.id)._unsafeUnwrap()?.version_id).toBe(v1.id);
    });

    it('activeRun ignores other scripts', () => {
      const otherScript = repo.upsertScript(personaId, 'other', uuid())._unsafeUnwrap();
      startRun(makeVersion(otherScript), 'test', 1);
      expect(repo.activeRun(script.id)._unsafeUnwrap()).toBeNull();
    });

    it('finishRun records outcome and lastFinishedRun filters by trigger', () => {
      const v = makeVersion();
      const a = startRun(v, 'schedule', 100);
      const b = startRun(v, 'schedule', 200);
      const t = startRun(v, 'test', 250);
      expect(repo.lastFinishedRun(script.id, 'schedule')._unsafeUnwrap()).toBeNull();
      repo.finishRun(a, true, null, 2, 150);
      repo.finishRun(b, false, 'timeout', 5, 260);
      repo.finishRun(t, true, null, 1, 270);

      const last = repo.lastFinishedRun(script.id, 'schedule')._unsafeUnwrap()!;
      expect(last.id).toBe(b);
      expect(last).toMatchObject({
        ok: 0,
        error_code: 'timeout',
        call_count: 5,
        ended_at: 260,
        schedule_id: 'sched-1',
      });
      expect(repo.lastFinishedRun(script.id, 'test')._unsafeUnwrap()?.id).toBe(t);
      expect(repo.lastFinishedRun(script.id, 'dry-run')._unsafeUnwrap()).toBeNull();
    });

    it('rejects an unknown trigger', () => {
      const v = makeVersion();
      const r = repo.insertRun({
        id: uuid(),
        versionId: v.id,
        mode: 'live',
        trigger: 'bogus' as never,
        startedAt: 1,
      });
      expect(r.isErr()).toBe(true);
    });
  });

  describe('getScript and failOpenRuns', () => {
    it('getScript returns the row or null', () => {
      expect(repo.getScript(script.id)._unsafeUnwrap()?.persona_id).toBe(personaId);
      expect(repo.getScript('missing')._unsafeUnwrap()).toBeNull();
    });

    it('failOpenRuns finishes only unfinished runs', () => {
      const v = makeVersion();
      const open = uuid();
      const done = uuid();
      repo.insertRun({
        id: open,
        versionId: v.id,
        mode: 'live',
        trigger: 'schedule',
        startedAt: 1,
      });
      repo.insertRun({
        id: done,
        versionId: v.id,
        mode: 'live',
        trigger: 'schedule',
        startedAt: 1,
      });
      repo.finishRun(done, true, null, 2, 5);
      expect(repo.failOpenRuns(9)._unsafeUnwrap()).toBe(1);
      const row = db.prepare(`SELECT * FROM script_runs WHERE id = ?`).get(open) as {
        ok: number;
        error_code: string;
        ended_at: number;
      };
      expect(row).toMatchObject({ ok: 0, error_code: 'SANDBOX', ended_at: 9 });
      const kept = db.prepare(`SELECT ok, ended_at FROM script_runs WHERE id = ?`).get(done);
      expect(kept).toEqual({ ok: 1, ended_at: 5 });
      expect(repo.failOpenRuns(10)._unsafeUnwrap()).toBe(0);
    });
  });

  describe('cascade', () => {
    it('deleting the persona removes scripts, versions, approvals and runs', () => {
      const { version } = makeAwaiting();
      repo.insertRun({
        id: uuid(),
        versionId: version.id,
        mode: 'live',
        trigger: 'test',
        startedAt: 1,
      });

      db.prepare(`DELETE FROM personas WHERE id = ?`).run(personaId);

      for (const table of ['scripts', 'script_versions', 'script_approvals', 'script_runs']) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(row.n, table).toBe(0);
      }
    });
  });
});
