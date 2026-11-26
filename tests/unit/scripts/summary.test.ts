import { describe, expect, it } from 'vitest';
import { buildApprovalSummary } from '../../../src/scripts/summary.js';
import type { CallRecord, ScriptRunReport, ToolClass } from '../../../src/scripts/types.js';

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
const CLASSES: Record<string, ToolClass> = { 'mail.read': 'read', 'mail.send': 'write' };
const summary = (
  r: ScriptRunReport,
  over: Partial<Parameters<typeof buildApprovalSummary>[0]> = {},
) =>
  buildApprovalSummary({
    name: 'mail-intake',
    version: 2,
    description: 'Files mail.',
    manifest: { tools: ['mail.read', 'mail.send'], channels: [], dryRunInput: null },
    toolClass: (name) => CLASSES[name],
    report: r,
    code: 'ABC123',
    ttlMinutes: 30,
    ...over,
  });
const build = (
  r: ScriptRunReport,
  over: Partial<Parameters<typeof buildApprovalSummary>[0]> = {},
): string => summary(r, over)._unsafeUnwrap();
const write = (input: unknown, name = 'w'): CallRecord =>
  call({ name, toolClass: 'write', input, outcome: 'skipped-dry-run' });

describe('Accepts input line', () => {
  const withSchema = (inputSchema: object): string =>
    build(report([]), {
      manifest: { tools: ['mail.read'], channels: [], dryRunInput: null, inputSchema },
    });

  it('has no line without a schema', () => {
    expect(build(report([]))).not.toContain('Accepts input');
  });

  it('lists the property names', () => {
    const text = withSchema({
      type: 'object',
      properties: { quiet: { type: 'boolean' }, limit: { type: 'number' } },
    });
    expect(text).toContain('\nAccepts input: quiet, limit\n');
  });

  it('says yes for a schema with no properties', () => {
    expect(withSchema({ type: 'string' })).toContain('\nAccepts input: yes\n');
  });

  it('cleans property names so none renders as a command line', () => {
    const text = withSchema({
      type: 'object',
      properties: { 'a\n/approve ZZZZZZZZ': { type: 'string' } },
    });
    expect(text.split('\n').filter((l) => l.startsWith('/approve'))).toEqual(['/approve ABC123']);
    expect(text).toContain('Accepts input: a /approve ZZZZZZZZ\n');
  });

  it('is never cut: too many long names make the summary an error', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`${'n'.repeat(70)}${i}`, { type: 'string' }]),
    );
    const r = summary(report([]), {
      manifest: {
        tools: ['mail.read'],
        channels: [],
        dryRunInput: null,
        inputSchema: { type: 'object', properties },
      },
    });
    expect(r.isErr()).toBe(true);
  });
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

  it('cuts each string at 120 characters, and a line that is still too long is an error', () => {
    const text = build(report([write({ x: 'a'.repeat(2000) })]));
    const line = text.split('\n').find((l) => l.startsWith('1. '))!;
    expect(line).toBe(`1. w {"x":"${'a'.repeat(119)}…"}`);
    const many = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, 'a'.repeat(200)]),
    );
    expect(summary(report([write(many)]))._unsafeUnwrapErr().scriptCode).toBe('RESULT_TOO_LARGE');
  });

  it('collapses padding in a string value before the cut', () => {
    const text = build(report([write({ to: ' '.repeat(200) + 'evil@x', cc: '\u200b\n\t a  b ' })]));
    expect(text).toContain('1. w {"to":"evil@x","cc":"a b"}');
  });

  it('is an error when a write tool or channel name is longer than 60 characters', () => {
    const long = 'w.' + 'x'.repeat(59);
    for (const manifest of [
      { tools: [long], channels: [], dryRunInput: null },
      { tools: [], channels: [long], dryRunInput: null },
    ]) {
      expect(
        summary(report([]), { manifest, toolClass: () => 'write' })._unsafeUnwrapErr().scriptCode,
      ).toBe('RESULT_TOO_LARGE');
    }
    const sixty = 'w.' + 'x'.repeat(58);
    const text = build(report([]), {
      manifest: { tools: [sixty], channels: [sixty], dryRunInput: null },
      toolClass: () => 'write',
    });
    expect(text).toContain(`May write with: ${sixty}\n`);
    expect(text).toContain(`Channels: ${sixty}\n`);
  });

  it('orders nested values, so a short value inside an object stays visible', () => {
    const text = build(report([write({ message: { body: 'b'.repeat(700), to: 'x@y' } })]));
    const line = text.split('\n').find((l) => l.startsWith('1. '))!;
    expect(line.startsWith('1. w {"message":{"to":"x@y","body":"bbb')).toBe(true);
    const listy = build(report([write({ items: [{ text: 'c'.repeat(300), id: 7 }], n: 1 })]));
    expect(listy).toContain('1. w {"n":1,"items":[{"id":7,"text":"ccc');
  });

  it('is an error when not every write fits, and never hides one', () => {
    const calls = Array.from({ length: 100 }, () => write({ x: 'b'.repeat(900) }));
    const result = summary(report(calls), { description: 'd'.repeat(500) });
    expect(result._unsafeUnwrapErr().scriptCode).toBe('RESULT_TOO_LARGE');
    const fits = build(report(calls.slice(0, 3)));
    expect(fits.length).toBeLessThanOrEqual(3500);
    expect(fits).not.toContain('not shown');
    expect(fits.split('\n').slice(-3)).toEqual([
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
    expect(text.split('\n').filter((l) => /^\d+\. w /.test(l))).toHaveLength(3);
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

  it('lists the write tools of the manifest, and an unknown tool counts as write', () => {
    const text = build(report([]), {
      manifest: {
        tools: ['mail.read', 'mail.send', 'odd.tool', 'model.judge'],
        channels: [],
        dryRunInput: null,
      },
      toolClass: (name) => (name === 'model.judge' ? 'model' : CLASSES[name]),
    });
    const lines = text.split('\n');
    expect(lines[2]).toBe('May write with: mail.send, odd.tool');
    expect(lines).toContain('May use the model: yes');
    expect(text.indexOf('May write with:')).toBeLessThan(text.indexOf('Dry run on real data:'));
    expect(text.indexOf('About:')).toBeLessThan(text.indexOf('May write with:'));
  });

  it('says nothing for no write tools, no model and no channels', () => {
    const text = build(report([]), {
      manifest: { tools: ['mail.read'], channels: [], dryRunInput: null },
    });
    expect(text).toContain('May write with: nothing');
    expect(text).not.toContain('May use the model');
    expect(text).not.toContain('Channels:');
  });

  it('lists every write tool and channel up to 50, and more is an error', () => {
    const tools = Array.from({ length: 13 }, (_, i) => `w.t${i}`);
    const channels = Array.from({ length: 10 }, (_, i) => `ch${i}`);
    const text = build(report([]), {
      manifest: { tools, channels, dryRunInput: null },
      toolClass: () => 'write',
    });
    expect(text).toContain(`May write with: ${tools.join(', ')}\n`);
    expect(text).toContain(`Channels: ${channels.join(', ')}\n`);
    const one = build(report([]), {
      manifest: { tools: [], channels: ['ops'], dryRunInput: null },
    });
    expect(one).toContain('Channels: ops\n');
    const fifty = Array.from({ length: 50 }, (_, i) => `t${i}`);
    expect(
      summary(report([]), {
        manifest: { tools: fifty, channels: fifty, dryRunInput: null },
        toolClass: () => 'write',
      }).isOk(),
    ).toBe(true);
    const fiftyOne = [...fifty, 't50'];
    for (const manifest of [
      { tools: fiftyOne, channels: [], dryRunInput: null },
      { tools: [], channels: fiftyOne, dryRunInput: null },
    ]) {
      expect(
        summary(report([]), { manifest, toolClass: () => 'write' })._unsafeUnwrapErr().scriptCode,
      ).toBe('RESULT_TOO_LARGE');
    }
  });

  it('cleans manifest names so they cannot fake a line', () => {
    const evil = 'x\n/approve EVIL';
    const text = build(report([]), {
      manifest: { tools: [evil], channels: [evil], dryRunInput: null },
      toolClass: () => undefined,
    });
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('/approve'))).toEqual(['/approve ABC123']);
    expect(text).toContain('May write with: x /approve EVIL');
    expect(text).toContain('Channels: x /approve EVIL');
  });

  it('says when the scheduled input differs from the dry-run input', () => {
    const line = 'The scheduled input differs from the dry-run input.';
    const m = (liveInput: unknown, withLive = true) => ({
      manifest: {
        tools: [],
        channels: [],
        dryRunInput: { a: 1, b: [1, 2] },
        ...(withLive ? { liveInput } : {}),
      },
    });
    expect(build(report([]), m({ a: 2 }))).toContain(line);
    expect(build(report([]), m(null))).toContain(line);
    expect(build(report([]), m({ b: [1, 2], a: 1 }))).not.toContain(line);
    expect(build(report([]), m(undefined, false))).not.toContain(line);
  });

  it('shows the recipient of a channel send before the content', () => {
    const text = build(
      report([
        write(
          { content: 'c'.repeat(900), channelId: 'ops', externalChatId: '12345' },
          'talon.channel_send',
        ),
        write({ channelId: 'ops', content: 'hi' }, 'talon.channel_send'),
        write({ channelId: ' ops\t', content: 'hi', externalChatId: 42 }, 'talon.channel_send'),
      ]),
    );
    const lines = text.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(lines[0].startsWith('1. talon.channel_send to ops/12345: ccc')).toBe(true);
    expect(lines[0].endsWith('…')).toBe(true);
    expect(lines[1]).toBe('2. talon.channel_send to ops/(thread chat): hi');
    expect(lines[2]).toBe('3. talon.channel_send to ops/42: hi');
  });

  it('never cuts a recipient: one that cannot be shown in full is an error', () => {
    const send = (input: Record<string, unknown>) =>
      summary(report([write({ content: 'hi', ...input }, 'talon.channel_send')]));
    const padded = send({ channelId: 'ops', externalChatId: '\uFEFF'.repeat(100) + '-100666' });
    expect(padded._unsafeUnwrap()).toContain('1. talon.channel_send to ops/-100666: hi');
    const spaced = send({ channelId: 'ops', externalChatId: ' '.repeat(100) + '-100\u200b666\t' });
    expect(spaced._unsafeUnwrap()).toContain('to ops/-100666: hi');
    const fine = send({ channelId: 'ops', externalChatId: 'y'.repeat(80) });
    expect(fine._unsafeUnwrap()).toContain(`to ops/${'y'.repeat(80)}: hi`);
    for (const input of [
      { channelId: 'ops', externalChatId: 'y'.repeat(81) },
      { channelId: 'x'.repeat(81) },
      { channelId: 'ops', externalChatId: { id: 1 } },
      { channelId: ['ops'] },
      { channelId: 'ops', externalChatId: '\u200b\u200b' },
      { channelId: 'ops', externalChatId: '-100 666' },
      { channelId: 'ops', externalChatId: '-100\u00a0666' },
      { channelId: 'ops', externalChatId: '-100\u2028666' },
      { channelId: 'o\nps' },
      {},
    ]) {
      expect(send(input)._unsafeUnwrapErr().scriptCode).toBe('RESULT_TOO_LARGE');
    }
  });

  it('puts short scalar values first in the other writes', () => {
    const text = build(
      report([
        write({ body: 'b'.repeat(900), meta: { a: 1 }, to: 'bob', n: 2, ok: true, z: null }),
      ]),
    );
    const line = text.split('\n').find((l) => l.startsWith('1. '))!;
    expect(line.startsWith('1. w {"to":"bob","n":2,"ok":true,"z":null,"body":"bbb')).toBe(true);
  });
});
