import { describe, expect, it } from 'vitest';
import { MAX_LINE_BYTES, createLineDecoder, encodeMessage } from '../../../src/scripts/protocol.js';

function line(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

describe('encodeMessage', () => {
  it('emits one line ending in a single newline', () => {
    const out = encodeMessage({ t: 'start', mode: 'unit', input: { a: 1 } });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.indexOf('\n')).toBe(out.length - 1);
    expect(JSON.parse(out)).toEqual({ t: 'start', mode: 'unit', input: { a: 1 } });
  });

  it('keeps newlines inside values escaped', () => {
    const out = encodeMessage({ t: 'result', id: 1, ok: true, value: 'a\nb\r\nc' });
    expect(out.split('\n')).toHaveLength(2);
    expect(out.indexOf('\n')).toBe(out.length - 1);
  });

  it('encodes an error result', () => {
    const out = encodeMessage({ t: 'result', id: 2, ok: false, code: 'TOOL_FAILED', message: 'x' });
    expect(JSON.parse(out)).toEqual({
      t: 'result',
      id: 2,
      ok: false,
      code: 'TOOL_FAILED',
      message: 'x',
    });
  });
});

describe('createLineDecoder', () => {
  it('decodes a message split over two chunks once', () => {
    const d = createLineDecoder();
    const text = line({ t: 'call', id: 1, name: 'a.b', input: { x: 1 } });
    const first = d.push(text.slice(0, 10));
    expect(first._unsafeUnwrap()).toEqual([]);
    const second = d.push(text.slice(10));
    expect(second._unsafeUnwrap()).toEqual([{ t: 'call', id: 1, name: 'a.b', input: { x: 1 } }]);
    expect(d.push('')._unsafeUnwrap()).toEqual([]);
  });

  it('decodes two messages in one chunk in order', () => {
    const d = createLineDecoder();
    const r = d.push(
      line({ t: 'call', id: 1, name: 'a', input: 1 }) + line({ t: 'done', ok: true, result: 5 }),
    );
    expect(r._unsafeUnwrap()).toEqual([
      { t: 'call', id: 1, name: 'a', input: 1 },
      { t: 'done', ok: true, result: 5 },
    ]);
  });

  it('decodes done failure and absent optional fields', () => {
    const d = createLineDecoder();
    const r = d.push(
      '{"t":"done","ok":false,"message":"boom"}\n{"t":"done","ok":true}\n{"t":"call","id":0,"name":"n"}\n',
    );
    const msgs = r._unsafeUnwrap();
    expect(msgs[0]).toEqual({ t: 'done', ok: false, message: 'boom' });
    expect(msgs[1]).toMatchObject({ t: 'done', ok: true, result: undefined });
    expect(msgs[2]).toMatchObject({ t: 'call', id: 0, name: 'n', input: undefined });
  });

  it('strips a trailing carriage return and skips blank lines', () => {
    const d = createLineDecoder();
    const r = d.push('\n  \r\n{"t":"done","ok":true,"result":1}\r\n');
    expect(r._unsafeUnwrap()).toEqual([{ t: 'done', ok: true, result: 1 }]);
  });

  it.each([
    ['not json', 'hello world\n'],
    ['unknown t', line({ t: 'nope' })],
    ['missing t', line({ id: 1 })],
    ['array', '[1,2]\n'],
    ['string', '"x"\n'],
    ['number', '3\n'],
    ['null', 'null\n'],
    ['float id', line({ t: 'call', id: 1.5, name: 'a', input: 1 })],
    ['negative id', line({ t: 'call', id: -1, name: 'a', input: 1 })],
    ['string id', line({ t: 'call', id: '1', name: 'a', input: 1 })],
    ['empty name', line({ t: 'call', id: 1, name: '', input: 1 })],
    ['non-string name', line({ t: 'call', id: 1, name: 4, input: 1 })],
    ['non-boolean ok', line({ t: 'done', ok: 'yes', result: 1 })],
    ['failed done without message', line({ t: 'done', ok: false })],
    ['failed done with non-string message', line({ t: 'done', ok: false, message: 3 })],
  ])('gives PROTOCOL for %s', (_label, text) => {
    const e = createLineDecoder().push(text)._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('PROTOCOL');
  });

  it('never leaks line content in error messages', () => {
    const e = createLineDecoder().push('SECRET-TOKEN-123 not json\n')._unsafeUnwrapErr();
    expect(e.message).not.toContain('SECRET');
    const e2 = createLineDecoder()
      .push(line({ t: 'SECRET-TOKEN-123' }))
      ._unsafeUnwrapErr();
    expect(e2.message).not.toContain('SECRET');
  });

  it('rejects an over-long line before the newline arrives', () => {
    const d = createLineDecoder();
    const e = d.push('x'.repeat(MAX_LINE_BYTES + 1))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('PROTOCOL');
  });

  it('rejects an over-long line built from several chunks', () => {
    const d = createLineDecoder(10);
    expect(d.push('xxxxx').isOk()).toBe(true);
    expect(d.push('yyyyyy').isErr()).toBe(true);
  });

  it('measures the limit in bytes, not characters', () => {
    const d = createLineDecoder(10);
    expect(d.push('é'.repeat(6)).isErr()).toBe(true);
  });

  it('accepts a complete line of exactly the limit', () => {
    const body = '{"t":"done","ok":true}';
    const exact = createLineDecoder(Buffer.byteLength(body));
    expect(exact.push(body + '\n')._unsafeUnwrap()).toHaveLength(1);
    const tooSmall = createLineDecoder(Buffer.byteLength(body) - 1);
    expect(tooSmall.push(body + '\n').isErr()).toBe(true);
  });

  it('stays failed after an error', () => {
    const d = createLineDecoder();
    expect(d.push('bad\n').isErr()).toBe(true);
    const again = d.push(line({ t: 'done', ok: true, result: 1 }));
    expect(again._unsafeUnwrapErr().scriptCode).toBe('PROTOCOL');
  });
});
