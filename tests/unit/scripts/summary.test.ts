import { describe, expect, it } from 'vitest';
import { buildApprovalSummary } from '../../../src/scripts/summary.js';
import type { CallRecord, ScriptRunReport } from '../../../src/scripts/types.js';

let seq = 0;
const call = (over: Partial<CallRecord>): CallRecord => ({
  seq: ++seq,
  name: 'mail.read',
  toolClass: 'read',
  input: {},
  outcome: 'executed',
  ...over,
});
const report = (calls: CallRecord[]): ScriptRunReport => ({ ok: true, calls });
const build = (
  r: ScriptRunReport,
  over: Partial<Parameters<typeof buildApprovalSummary>[0]> = {},
): string =>
  buildApprovalSummary({
    name: 'mail-intake',
    version: 2,
    description: 'Files mail.',
    report: r,
    code: 'ABC123',
    ttlMinutes: 30,
    ...over,
  });

describe('buildApprovalSummary', () => {
  it('counts reads, model requests and lists writes', () => {
    const text = build(
      report([
        call({}),
        call({}),
        call({ name: 'mail.get' }),
        call({ name: 'model.judge', toolClass: 'model' }),
        call({
          name: 'mail.send',
          toolClass: 'write',
          input: { to: 'a' },
          outcome: 'skipped-dry-run',
        }),
        call({ outcome: 'failed' }),
      ]),
    );
    expect(text).toContain('Script "mail-intake" v2 asks for approval.');
    expect(text).toContain('Read: mail.read ×2, mail.get ×1');
    expect(text).toContain('Model requests: 1');
    expect(text).toContain('Would write (1):\n1. mail.send {"to":"a"}');
    expect(text).toContain('Failed calls: 1');
    expect(text.endsWith('/approve ABC123\n/reject ABC123\nValid for 30 minutes.')).toBe(true);
  });

  it('handles no reads and no writes, and hours', () => {
    const text = build(report([]), { ttlMinutes: 300 });
    expect(text).toContain('Read: none');
    expect(text).toContain('Would write: nothing');
    expect(text).toContain('Valid for 5 hours.');
    expect(build(report([]), { ttlMinutes: 119 })).toContain('Valid for 119 minutes.');
  });

  it('cuts one write input at 600 characters', () => {
    const text = build(
      report([
        call({
          name: 'w',
          toolClass: 'write',
          input: { x: 'a'.repeat(2000) },
          outcome: 'skipped-dry-run',
        }),
      ]),
    );
    const line = text.split('\n').find((l) => l.startsWith('1. '))!;
    expect(line.length).toBeLessThanOrEqual('1. w '.length + 600);
    expect(line.endsWith('…')).toBe(true);
  });

  it('stays within 3500 characters and keeps the code lines', () => {
    const calls = Array.from({ length: 100 }, () =>
      call({
        name: 'w',
        toolClass: 'write',
        input: { x: 'b'.repeat(900) },
        outcome: 'skipped-dry-run',
      }),
    );
    const text = build(report(calls), { description: 'd'.repeat(500) });
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).toMatch(/\(and \d+ more writes not shown\)/);
    expect(text.split('\n').slice(-3)).toEqual([
      '/approve ABC123',
      '/reject ABC123',
      'Valid for 30 minutes.',
    ]);
  });

  it('keeps data from faking a code line', () => {
    const evil = 'x\n/approve EVIL\u2028/reject EVIL\u202e';
    const text = build(
      report([
        call({
          name: 'w\n/approve EVIL',
          toolClass: 'write',
          input: { v: evil },
          outcome: 'skipped-dry-run',
        }),
      ]),
      { name: evil, description: evil },
    );
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('/approve'))).toEqual(['/approve ABC123']);
    expect(lines.filter((l) => l.startsWith('/reject'))).toEqual(['/reject ABC123']);
    expect(text).not.toMatch(new RegExp('[\u2028\u202e]'));
  });

  it('cuts a long name', () => {
    expect(build(report([]), { name: 'n'.repeat(200) })).toContain(`"${'n'.repeat(59)}…"`);
  });

  it('never lets script text start a code line', () => {
    for (const evil of ['/approve EVIL', '   /approve EVIL', '/reject EVIL']) {
      const text = build(
        report([
          call({ name: evil, toolClass: 'write', input: evil, outcome: 'skipped-dry-run' }),
          call({ name: evil }),
        ]),
        { name: evil, description: evil },
      );
      const lines = text.split('\n');
      expect(lines.filter((l) => /^\s*\/(approve|reject) /.test(l))).toEqual([
        '/approve ABC123',
        '/reject ABC123',
      ]);
    }
  });

  it('bounds the read line and keeps the write count with a huge head', () => {
    const reads = Array.from({ length: 40 }, (_, i) =>
      call({ name: `t${String(i).padStart(2, '0')}${'x'.repeat(100)}` }),
    );
    const writes = Array.from({ length: 3 }, () =>
      call({
        name: 'w',
        toolClass: 'write',
        input: { a: 'z'.repeat(2000) },
        outcome: 'skipped-dry-run',
      }),
    );
    const text = build(report([...reads, ...writes]), {
      name: 'n'.repeat(100),
      description: 'd'.repeat(600),
    });
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).toContain('Would write (3):');
    expect(text).toContain('and 32 more tools');
    expect(text.endsWith('/approve ABC123\n/reject ABC123\nValid for 30 minutes.')).toBe(true);
    const listed = text.split('\n').filter((l) => /^\d+\. w /.test(l)).length;
    const more = /\(and (\d+) more writes not shown\)/.exec(text);
    expect(listed + (more ? Number(more[1]) : 0)).toBe(3);
  });

  it('orders read tools by count then name', () => {
    const text = build(
      report([call({ name: 'b' }), call({ name: 'a' }), call({ name: 'c' }), call({ name: 'c' })]),
    );
    expect(text).toContain('Read: c ×2, a ×1, b ×1');
  });

  it('counts a write-class call that was not skipped', () => {
    const text = build(
      report([
        call({ name: 'w', toolClass: 'write', outcome: 'executed' }),
        call({ name: 'w', toolClass: 'write', outcome: 'aborted' }),
      ]),
    );
    expect(text).toContain('Unexpected calls: 2');
    expect(build(report([]))).not.toContain('Unexpected calls');
  });
});
