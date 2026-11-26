import { describe, expect, it } from 'vitest';
import { resolveRunInput } from '../../../src/scripts/run-input.js';
import type { AuthoredManifest } from '../../../src/scripts/types.js';

const schema = {
  type: 'object',
  properties: { quiet: { type: 'boolean' } },
  additionalProperties: false,
};
const manifest = (over: Partial<AuthoredManifest>): AuthoredManifest => ({
  name: 'mail-intake',
  description: 'd',
  tools: [],
  channels: [],
  dryRunInput: null,
  ...over,
});

describe('resolveRunInput', () => {
  it('uses liveInput, or null, when no input is given', () => {
    expect(resolveRunInput(manifest({ liveInput: { a: 1 } }), undefined)._unsafeUnwrap()).toEqual({
      a: 1,
    });
    expect(resolveRunInput(manifest({}), undefined)._unsafeUnwrap()).toBeNull();
  });

  it('refuses an input when the script declares no schema', () => {
    const e = resolveRunInput(manifest({}), { quiet: true })._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('INVALID_ARGUMENT');
    expect(e.message).toContain('this script accepts no input');
  });

  it('treats null as a given input', () => {
    expect(resolveRunInput(manifest({}), null)._unsafeUnwrapErr().scriptCode).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('returns an input that matches the schema', () => {
    expect(
      resolveRunInput(manifest({ inputSchema: schema }), { quiet: true })._unsafeUnwrap(),
    ).toEqual({
      quiet: true,
    });
  });

  it('refuses an input that does not match, with a fixed message', () => {
    const wrong = resolveRunInput(manifest({ inputSchema: schema }), { quiet: 'yes' });
    expect(wrong._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(wrong._unsafeUnwrapErr().message).toContain(
      'the input does not match the input schema of the script',
    );
    expect(resolveRunInput(manifest({ inputSchema: schema }), { other: 1 }).isErr()).toBe(true);
  });

  it('refuses an input over 8,000 characters of JSON', () => {
    const s = { type: 'string' };
    expect(
      resolveRunInput(manifest({ inputSchema: s }), 'x'.repeat(7990))._unsafeUnwrap(),
    ).toHaveLength(7990);
    expect(resolveRunInput(manifest({ inputSchema: s }), 'x'.repeat(8000)).isErr()).toBe(true);
  });

  it('refuses an input that cannot be serialized', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(resolveRunInput(manifest({ inputSchema: { type: 'object' } }), loop).isErr()).toBe(true);
  });

  it('refuses a schema that is not safe, without throwing', () => {
    const bad = { type: 'string', pattern: '(a+)+$' };
    expect(resolveRunInput(manifest({ inputSchema: bad }), 'aaa').isErr()).toBe(true);
  });
});
