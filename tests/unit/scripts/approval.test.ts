import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import pino from 'pino';
import { ScriptRepository } from '../../../src/core/database/repositories/script-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { createApprovalService, type ApprovalService } from '../../../src/scripts/approval.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

const MIN = 60_000;

describe('approval service', () => {
  let db: Database.Database;
  let repo: ScriptRepository;
  let clock: number;
  let svc: ApprovalService;
  let seed: number;
  let versionId: string;

  function makeVersion(state: 'tested' | 'draft' = 'tested'): string {
    const personaId = uuid();
    new PersonaRepository(db)
      .insert({
        id: personaId,
        name: `p-${personaId}`,
        model: 'm',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
    const script = repo.upsertScript(personaId, 'daily', uuid())._unsafeUnwrap();
    const v = repo
      .insertVersion({
        id: uuid(),
        scriptId: script.id,
        contentHash: 'h',
        manifest: JSON.stringify({ name: 'daily', personaId, tools: [] }),
        threadId: null,
      })
      ._unsafeUnwrap();
    if (state === 'tested') {
      repo.setVersionState(v.id, ['draft'], 'tested')._unsafeUnwrap();
    }
    return v.id;
  }

  const ask = (id = versionId): string =>
    svc.request({ versionId: id, channelName: 'tg', externalThreadId: 't1' })._unsafeUnwrap().code;
  const decide = (code: string, over: Record<string, string> = {}) =>
    svc.decide({
      code,
      decision: 'approved',
      channelName: 'tg',
      externalThreadId: 't1',
      ...over,
    });

  beforeEach(() => {
    db = createTestDb();
    repo = new ScriptRepository(db);
    clock = 1_000_000;
    seed = 0;
    svc = createApprovalService({
      repo,
      ttlMinutes: 30,
      logger: pino({ level: 'silent' }),
      now: () => clock,
      randomBytes: (n) => Buffer.from(Array.from({ length: n }, (_, i) => seed + i)),
    });
    versionId = makeVersion();
  });

  describe('request', () => {
    it('makes an 8 character code from the alphabet and stores only its hash', () => {
      const code = ask();
      expect(code).toBe('ABCDEFGH');
      const hash = createHash('sha256').update(code).digest('hex');
      const row = repo.findOpenApproval(hash)._unsafeUnwrap();
      expect(row?.code_hash).toBe(hash);
      expect(row?.expires_at).toBe(clock + 30 * MIN);
      expect(JSON.stringify(db.prepare('SELECT * FROM script_approvals').all())).not.toContain(
        code,
      );
      expect(repo.getVersion(versionId)._unsafeUnwrap()?.state).toBe('awaiting-approval');
    });

    it('maps random bytes with byte & 31', () => {
      seed = 30; // bytes 30..37 -> indexes 30,31,0,1,2,3,4,5
      expect(ask()).toBe('89ABCDEF');
    });

    it('rejects a missing or non-tested version without changing it', () => {
      const draft = makeVersion('draft');
      const r = svc.request({ versionId: draft, channelName: 'tg', externalThreadId: 't1' });
      expect(r._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
      expect(repo.getVersion(draft)._unsafeUnwrap()?.state).toBe('draft');
      const none = svc.request({ versionId: uuid(), channelName: 'tg', externalThreadId: 't1' });
      expect(none._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    });

    it('a new request expires the old code and keeps the state', () => {
      const first = ask();
      seed = 8;
      const second = ask();
      expect(second).not.toBe(first);
      expect(decide(first)._unsafeUnwrap().outcome).toBe('refused');
      expect(decide(second)._unsafeUnwrap().outcome).toBe('approved');
    });

    it('sets the state back to tested when the insert fails', () => {
      const other = makeVersion();
      ask(other);
      // same code again: the hash is UNIQUE, so the insert fails
      const r = svc.request({ versionId, channelName: 'tg', externalThreadId: 't1' });
      expect(r._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
      expect(repo.getVersion(versionId)._unsafeUnwrap()?.state).toBe('tested');
    });
  });

  describe('decide', () => {
    it('approves, returns name and version, and accepts lowercase', () => {
      const code = ask();
      const r = decide(code.toLowerCase())._unsafeUnwrap();
      expect(r).toEqual({ outcome: 'approved', scriptName: 'daily', version: 1 });
      expect(repo.getVersion(versionId)._unsafeUnwrap()?.state).toBe('approved');
    });

    it('rejects', () => {
      const code = ask();
      expect(decide(code, { decision: 'rejected' })._unsafeUnwrap().outcome).toBe('rejected');
      expect(repo.getVersion(versionId)._unsafeUnwrap()?.state).toBe('rejected');
    });

    it('refuses unknown, used, expired, other channel and other thread alike', () => {
      const code = ask();
      const same = { outcome: 'refused' };
      expect(decide('ZZZZZZZZ')._unsafeUnwrap()).toEqual(same);
      expect(decide(code, { channelName: 'other' })._unsafeUnwrap()).toEqual(same);
      expect(decide(code, { externalThreadId: 't2' })._unsafeUnwrap()).toEqual(same);
      clock += 31 * MIN;
      expect(decide(code)._unsafeUnwrap()).toEqual(same);
      clock = 1_000_000;
      expect(decide(code)._unsafeUnwrap().outcome).toBe('approved');
      expect(decide(code)._unsafeUnwrap()).toEqual(same);
    });

    it('refuses when the version is no longer awaiting approval', () => {
      const code = ask();
      repo.setVersionState(versionId, ['awaiting-approval'], 'retired')._unsafeUnwrap();
      expect(decide(code)._unsafeUnwrap()).toEqual({ outcome: 'refused' });
    });

    it('returns SANDBOX on a database error', () => {
      const code = ask();
      db.exec('DROP TABLE script_approvals');
      expect(decide(code)._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    });
  });

  describe('attempt limit', () => {
    it('blocks after 5 refusals, even for a valid code, and clears after 10 minutes', () => {
      const code = ask();
      for (let i = 0; i < 5; i++) {
        clock += 1000;
        expect(decide('ZZZZZZZZ')._unsafeUnwrap().outcome).toBe('refused');
      }
      clock += 1000;
      expect(decide(code)._unsafeUnwrap()).toEqual({ outcome: 'refused' });
      clock += 10 * MIN - 2000;
      expect(decide(code)._unsafeUnwrap()).toEqual({ outcome: 'refused' });
      clock += 2000;
      expect(decide(code)._unsafeUnwrap().outcome).toBe('approved');
    });

    it('does not read the database while blocked', () => {
      for (let i = 0; i < 5; i++) {
        decide('ZZZZZZZZ');
      }
      db.exec('DROP TABLE script_approvals');
      expect(decide('ZZZZZZZZ')._unsafeUnwrap().outcome).toBe('refused');
    });

    it('counts per channel and thread', () => {
      for (let i = 0; i < 5; i++) {
        decide('ZZZZZZZZ');
      }
      const other = svc.decide({
        code: 'ZZZZZZZZ',
        decision: 'approved',
        channelName: 'tg',
        externalThreadId: 'other',
      });
      expect(other._unsafeUnwrap().outcome).toBe('refused');
      // a valid code from the unblocked chat still works
      const code = ask();
      db.prepare('UPDATE script_approvals SET external_thread_id = ?').run('other');
      const ok = svc.decide({
        code,
        decision: 'approved',
        channelName: 'tg',
        externalThreadId: 'other',
      });
      expect(ok._unsafeUnwrap().outcome).toBe('approved');
    });

    it('does not block when the refusals are spread over more than 10 minutes', () => {
      const code = ask();
      for (let i = 0; i < 5; i++) {
        decide('ZZZZZZZZ');
        clock += 3 * MIN;
      }
      expect(decide(code)._unsafeUnwrap().outcome).toBe('approved');
    });
  });

  describe('parseCommand', () => {
    it('accepts the two commands with spaces and any case of the code', () => {
      expect(svc.parseCommand('  /approve abcd2345  ')).toEqual({
        decision: 'approved',
        code: 'ABCD2345',
      });
      expect(svc.parseCommand('/reject\tABCD2345')).toEqual({
        decision: 'rejected',
        code: 'ABCD2345',
      });
    });

    it.each([
      '/approve',
      '/approve ABCD234',
      '/approve ABCD23456',
      '/approve ABCD2345 now',
      '/approve ABCD2345\nhello',
      '/approve@bot ABCD2345',
      '/Approve ABCD2345',
      'please /approve ABCD2345',
      '/approve ABCD-345',
      '',
    ])('returns undefined for %j', (text) => {
      expect(svc.parseCommand(text)).toBeUndefined();
    });
  });
});
