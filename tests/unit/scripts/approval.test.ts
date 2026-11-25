import { describe, it, expect, beforeEach } from 'vitest';
import { err } from 'neverthrow';
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
    })._unsafeUnwrap();
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
      expect(r).toEqual({
        outcome: 'approved',
        scriptName: 'daily',
        version: 1,
        versionId,
        personaId: repo
          .getScript(repo.getVersion(versionId)._unsafeUnwrap()!.script_id)
          ._unsafeUnwrap()!.persona_id,
        threadId: '',
      });
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
      expect(decide(code)._unsafeUnwrap()).toEqual({ outcome: 'blocked' });
      clock += 10 * MIN - 2000;
      expect(decide(code)._unsafeUnwrap()).toEqual({ outcome: 'blocked' });
      clock += 2000;
      expect(decide(code)._unsafeUnwrap().outcome).toBe('approved');
    });

    it('does not read the database while blocked', () => {
      for (let i = 0; i < 5; i++) {
        decide('ZZZZZZZZ');
      }
      db.exec('DROP TABLE script_approvals');
      expect(decide('ZZZZZZZZ')._unsafeUnwrap().outcome).toBe('blocked');
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
      '/Approve abcd2345',
      '/approve@my_bot ABCD2345',
      '/APPROVE ABCD2345.',
      '/approve ABCD2345!',
    ])('accepts %j', (text) => {
      expect(svc.parseCommand(text)).toEqual({ decision: 'approved', code: 'ABCD2345' });
    });

    it.each([
      '/approve',
      '/approve ABCD234',
      '/approve ABCD23456',
      '/approve ABCD2345 now',
      '/approve ABCD2345\nhello',
      '/approve@ ABCD2345',
      '/approve ABCD2345..',
      'approve ABCD2345',
      'please /approve ABCD2345',
      '/approve ABCD-345',
      '',
    ])('returns undefined for %j', (text) => {
      expect(svc.parseCommand(text)).toBeUndefined();
    });
  });

  describe('classify', () => {
    const msg = (content: unknown, externalThreadId = 't1') => ({
      channelName: 'tg',
      externalThreadId,
      content,
    });
    let hashes: number;
    beforeEach(() => {
      hashes = 0;
      svc = createApprovalService({
        repo,
        ttlMinutes: 30,
        logger: pino({ level: 'silent' }),
        now: () => clock,
        randomBytes: (n) => Buffer.from(Array.from({ length: n }, (_, i) => seed + i)),
        hashCode: (code) => {
          hashes++;
          return createHash('sha256').update(code.toUpperCase()).digest('hex');
        },
      })._unsafeUnwrap();
    });
    const quoted = (code: string): string =>
      `Thanks.\n\n${'> On Monday Talon wrote a long message\n'.repeat(120)}> /approve ${code}\n> /reject ${code}\n`;

    it('classifies each kind in a chat with an open approval', () => {
      const code = ask();
      expect(quoted(code).length).toBeGreaterThan(4000);
      const cases: Array<[unknown, string]> = [
        [`/approve ${code}`, 'command'],
        [`/Approve ${code}`, 'command'],
        [`/approve@my_bot ${code}`, 'command'],
        [`/approve ${code}.`, 'command'],
        [`  /reject ${code.toLowerCase()}  `, 'command'],
        ['/approve ZZZZZZZZ', 'command'],
        [`approve ${code}`, 'leak'],
        [`/approve ${code} please`, 'leak'],
        [quoted(code), 'leak'],
        [`code:${code.toLowerCase()}!`, 'leak'],
        ['/approve', 'malformed'],
        ['/reject@my_bot not a code', 'malformed'],
        ['/approve ZZZ', 'malformed'],
        ['/approvefoo', 'malformed'],
        ['/REJECT now please', 'malformed'],
        [`/approve${code}`, 'leak'],
        [`/reject${code}`, 'leak'],
        [`X${code}`, 'leak'],
        [`${code}1`, 'leak'],
        [`ABCD-EFGH`, 'leak'],
        [`abcd efgh`, 'leak'],
        [`ABC_DEFGH`, 'leak'],
        [`ABCDE.FGH`, 'leak'],
        [`ABCD\u200bEFGH`, 'leak'],
        [`AB\ufeffCD\u2060EF\u200dGH`, 'leak'],
        ['ABCD--EFGH', 'none'],
        ['ABCD  EFGH', 'none'],
        ['ABCD/EFGH', 'none'],
        ['hello there', 'none'],
        ['approve ZZZZZZZZ', 'none'],
        [42, 'none'],
      ];
      for (const [content, kind] of cases) {
        expect([content, svc.classify(msg(content))]).toEqual([content, kind]);
      }
    });

    it('hashes nothing when no approval is open anywhere', () => {
      hashes = 0;
      for (const content of [
        '/approve ABCDEFGH',
        'approve ABCDEFGH',
        quoted('ABCDEFGH'),
        '/approve',
        'hello',
      ]) {
        expect(svc.classify(msg(content, 'other'))).toBe('none');
      }
      expect(hashes).toBe(0);
    });

    it('checks only a well-formed command in a chat with no open approval', () => {
      const code = ask();
      hashes = 0;
      for (const content of [
        `approve ${code}`,
        quoted(code),
        '/approve',
        `/approve${code}`,
        'hi',
      ]) {
        expect(svc.classify(msg(content, 'other'))).toBe('none');
      }
      expect(hashes).toBe(0);
      expect(svc.classify(msg('/approve ZZZZZZZZ', 'other'))).toBe('none');
      expect(hashes).toBe(1);
      expect(svc.classify(msg(`/approve ${code}`, 'other'))).toBe('wrong-chat');
      expect(svc.classify(msg(`/Reject@my_bot ${code.toLowerCase()}.`, 'other'))).toBe(
        'wrong-chat',
      );
      expect(hashes).toBe(3);
    });

    it('cancelWrongChat expires the code, and the right chat refuses it later', () => {
      const code = ask();
      const other = makeVersion();
      seed = 8;
      const keep = ask(other);
      const cancelled = svc.cancelWrongChat(msg(`/approve ${code}`, 'other'));
      expect(cancelled.map((c) => c.versionId)).toEqual([versionId]);
      expect(repo.getVersion(versionId)._unsafeUnwrap()?.state).toBe('tested');
      expect(svc.classify(msg(`/approve ${code}`, 'other'))).toBe('none');
      expect(svc.classify(msg(`/approve ${code}`))).toBe('command');
      expect(decide(code)._unsafeUnwrap().outcome).toBe('refused');
      expect(decide(keep)._unsafeUnwrap().outcome).toBe('approved');
    });

    it('scans the first and the last 16,000 characters of a long message', () => {
      const code = ask();
      const pad = (n: number): string => 'x'.repeat(n);
      expect(svc.classify(msg(`${code} ${pad(40_000)}`))).toBe('leak');
      expect(svc.classify(msg(`${pad(40_000)} ${code}`))).toBe('leak');
      expect(svc.classify(msg(`${pad(20_000)} ${code} ${pad(20_000)}`))).toBe('none');
      expect(svc.classify(msg(`${'ZZZZZZZZ '.repeat(1000)}${code}`))).toBe('leak');
    });

    it('prunes an expired code, then the chat is none', () => {
      const code = ask();
      clock += 31 * MIN;
      hashes = 0;
      expect(svc.classify(msg(`approve ${code}`))).toBe('none');
      expect(svc.classify(msg(`/approve ${code}`))).toBe('none');
      expect(hashes).toBe(0);
    });

    it('drops a code from the index when it is decided', () => {
      const code = ask();
      expect(decide(code)._unsafeUnwrap().outcome).toBe('approved');
      expect(svc.classify(msg(`/approve ${code}`))).toBe('none');
    });

    it('rebuilds the index from the database in a new service', () => {
      const code = ask();
      const fresh = createApprovalService({
        repo,
        ttlMinutes: 30,
        logger: pino({ level: 'silent' }),
        now: () => clock,
      })._unsafeUnwrap();
      expect(fresh.classify(msg(`approve ${code}`))).toBe('leak');
      expect(fresh.classify(msg(`/approve ${code}`))).toBe('command');
      expect(fresh.classify(msg(`/approve ${code}`, 'other'))).toBe('wrong-chat');
      clock += 31 * MIN;
      const later = createApprovalService({
        repo,
        ttlMinutes: 30,
        logger: pino({ level: 'silent' }),
        now: () => clock,
      })._unsafeUnwrap();
      expect(later.classify(msg(`approve ${code}`))).toBe('none');
    });

    it('cancelLeaked expires the code, moves the version back and the code is refused later', () => {
      const code = ask();
      const other = makeVersion();
      seed = 8;
      const keep = ask(other);
      const cancelled = svc.cancelLeaked(msg(`approve ${code}`));
      expect(cancelled.map((c) => c.versionId)).toEqual([versionId]);
      expect(repo.getVersion(versionId)._unsafeUnwrap()?.state).toBe('tested');
      expect(repo.getVersion(other)._unsafeUnwrap()?.state).toBe('awaiting-approval');
      // the chat still has an open approval, so the old code is a command that is refused
      expect(svc.classify(msg(`/approve ${code}`))).toBe('command');
      expect(decide(code)._unsafeUnwrap().outcome).toBe('refused');
      expect(decide(keep)._unsafeUnwrap().outcome).toBe('approved');
    });

    it('expireVersion drops the codes of the version', () => {
      const code = ask();
      svc.expireVersion(versionId)._unsafeUnwrap();
      expect(svc.classify(msg(`approve ${code}`))).toBe('none');
      expect(decide(code)._unsafeUnwrap().outcome).toBe('refused');
    });
  });

  describe('fail closed', () => {
    it('does not start when the open approvals cannot be read', () => {
      const failing = new ScriptRepository(db);
      failing.listOpenApprovals = () => err(new Error('down') as never);
      const r = createApprovalService({
        repo: failing,
        ttlMinutes: 30,
        logger: pino({ level: 'silent' }),
      });
      expect(r._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    });

    it('keeps the code in the index when the expire write fails', () => {
      const code = ask();
      const expire = repo.expireOpenApprovals.bind(repo);
      repo.expireOpenApprovals = () => err(new Error('down') as never);
      expect(svc.expireVersion(versionId)._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
      const msg = { channelName: 'tg', externalThreadId: 't1', content: `approve ${code}` };
      expect(svc.classify(msg)).toBe('leak');
      expect(svc.cancelLeaked(msg)).toEqual([]);
      expect(svc.classify(msg)).toBe('leak');
      const elsewhere = { channelName: 'tg', externalThreadId: 'o', content: `/approve ${code}` };
      expect(svc.cancelWrongChat(elsewhere)).toEqual([]);
      expect(svc.classify(elsewhere)).toBe('wrong-chat');
      repo.expireOpenApprovals = expire;
      expect(svc.cancelLeaked(msg).map((c) => c.versionId)).toEqual([versionId]);
      expect(svc.classify(msg)).toBe('none');
    });
  });

  describe('noteAttempt', () => {
    it('counts toward the limiter and reports a blocked chat', () => {
      for (let i = 0; i < 5; i++) expect(svc.noteAttempt('tg', 't1')).toBe(false);
      expect(svc.noteAttempt('tg', 't1')).toBe(true);
      expect(decide('ZZZZZZZZ')._unsafeUnwrap().outcome).toBe('blocked');
      expect(svc.noteAttempt('tg', 't2')).toBe(false);
    });
  });

  describe('decide after the commit', () => {
    it('keeps the outcome when the script row cannot be read', () => {
      const code = ask();
      const failing = new ScriptRepository(db);
      failing.getScript = () =>
        ({ isErr: () => true, isOk: () => false, error: new Error('down') }) as never;
      const s2 = createApprovalService({
        repo: failing,
        ttlMinutes: 30,
        logger: pino({ level: 'silent' }),
        now: () => clock,
      })._unsafeUnwrap();
      const r = s2
        .decide({ code, decision: 'rejected', channelName: 'tg', externalThreadId: 't1' })
        ._unsafeUnwrap();
      expect(r).toMatchObject({ outcome: 'rejected', scriptName: 'daily', version: 1, versionId });
      expect(r.personaId).toBeUndefined();
    });
  });
});
