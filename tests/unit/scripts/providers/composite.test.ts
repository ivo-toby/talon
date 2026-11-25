import { describe, it, expect, vi } from 'vitest';
import { ok } from 'neverthrow';
import { createCompositeProvider } from '../../../../src/scripts/providers/composite.js';
import type { RunProvider, ToolProvider } from '../../../../src/scripts/types.js';

const live = new AbortController().signal;

function fakePart(tools: string[]): ToolProvider & {
  describe: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
} {
  return {
    describe: vi.fn((name: string) => (tools.includes(name) ? { toolClass: 'read' } : undefined)),
    call: vi.fn(async (name: string) => ok(`result:${name}`)),
  } as never;
}

function fakeMcp(
  tools: string[],
): ReturnType<typeof fakePart> & { close: ReturnType<typeof vi.fn> } {
  return Object.assign(fakePart(tools), { close: vi.fn(async () => {}) }) as never;
}

describe('createCompositeProvider routing', () => {
  it('routes talon.* to host only', async () => {
    const host = fakePart(['talon.memory_get']);
    const mcp = fakeMcp(['talon.memory_get']);
    const p = createCompositeProvider({ host, mcp });
    expect(p.describe('talon.memory_get')).toEqual({ toolClass: 'read' });
    const r = await p.call('talon.memory_get', {}, live);
    expect(r._unsafeUnwrap()).toBe('result:talon.memory_get');
    expect(host.call).toHaveBeenCalledTimes(1);
    expect(mcp.describe).not.toHaveBeenCalled();
    expect(mcp.call).not.toHaveBeenCalled();
  });

  it('routes the exact name model.judge to judge only', async () => {
    const host = fakePart([]);
    const judge = fakePart(['model.judge']);
    const mcp = fakeMcp(['model.judge']);
    const p = createCompositeProvider({ host, judge, mcp });
    expect(p.describe('model.judge')).toEqual({ toolClass: 'read' });
    expect((await p.call('model.judge', {}, live)).isOk()).toBe(true);
    expect(judge.call).toHaveBeenCalledTimes(1);
    expect(mcp.call).not.toHaveBeenCalled();
    expect(host.call).not.toHaveBeenCalled();
  });

  it('never falls other model.* names through to mcp', async () => {
    const mcp = fakeMcp(['model.other']);
    const judge = fakePart(['model.other']);
    const p = createCompositeProvider({ host: fakePart([]), judge, mcp });
    expect(p.describe('model.other')).toBeUndefined();
    expect(p.describe('model.judge2')).toBeUndefined();
    const r = await p.call('model.other', {}, live);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('UNKNOWN_TOOL');
    expect(mcp.call).not.toHaveBeenCalled();
    expect(judge.call).not.toHaveBeenCalled();
  });

  it('routes every other name to mcp', async () => {
    const host = fakePart(['mail.list']);
    const mcp = fakeMcp(['mail.list']);
    const p = createCompositeProvider({ host, mcp });
    expect(p.describe('mail.list')).toEqual({ toolClass: 'read' });
    expect((await p.call('mail.list', {}, live))._unsafeUnwrap()).toBe('result:mail.list');
    expect(mcp.call).toHaveBeenCalledTimes(1);
    expect(host.call).not.toHaveBeenCalled();
  });

  it('does not treat a lookalike prefix as talon.*', async () => {
    const host = fakePart(['talonx.y']);
    const mcp = fakeMcp([]);
    const p = createCompositeProvider({ host, mcp });
    expect(p.describe('talonx.y')).toBeUndefined();
    expect(host.describe).not.toHaveBeenCalled();
  });
});

describe('createCompositeProvider missing parts and unknown tools', () => {
  it('returns undefined and UNKNOWN_TOOL when the part is missing', async () => {
    const p = createCompositeProvider({ host: fakePart([]) });
    for (const name of ['model.judge', 'srv.tool']) {
      expect(p.describe(name)).toBeUndefined();
      const e = (await p.call(name, {}, live))._unsafeUnwrapErr();
      expect(e.scriptCode).toBe('UNKNOWN_TOOL');
      expect(e.message).not.toContain(name);
    }
  });

  it('returns UNKNOWN_TOOL without calling the part when the part does not describe the name', async () => {
    const host = fakePart(['talon.a']);
    const p = createCompositeProvider({ host });
    const e = (await p.call('talon.nope', {}, live))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('UNKNOWN_TOOL');
    expect(host.call).not.toHaveBeenCalled();
  });
});

describe('createCompositeProvider failures', () => {
  it('describe returns undefined when a part throws', () => {
    const host = fakePart([]);
    host.describe.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(createCompositeProvider({ host }).describe('talon.x')).toBeUndefined();
  });

  it('call maps a thrown describe to UNKNOWN_TOOL', async () => {
    const host = fakePart([]);
    host.describe.mockImplementation(() => {
      throw new Error('boom');
    });
    const e = (
      await createCompositeProvider({ host }).call('talon.x', {}, live)
    )._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('UNKNOWN_TOOL');
  });

  it('call maps a rejection to TOOL_FAILED with the cause attached and a fixed message', async () => {
    const host = fakePart(['talon.x']);
    const cause = new Error('secret-input-leak');
    host.call.mockRejectedValue(cause);
    const e = (
      await createCompositeProvider({ host }).call('talon.x', {}, live)
    )._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(e.message).not.toContain('secret-input-leak');
    expect(e.cause).toBe(cause);
  });

  it('call maps a synchronous throw to TOOL_FAILED', async () => {
    const host = fakePart(['talon.x']);
    host.call.mockImplementation(() => {
      throw new Error('sync');
    });
    const e = (
      await createCompositeProvider({ host }).call('talon.x', {}, live)
    )._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
  });

  it('wraps a non-Error rejection as the cause', async () => {
    const host = fakePart(['talon.x']);
    host.call.mockRejectedValue('str');
    const e = (
      await createCompositeProvider({ host }).call('talon.x', {}, live)
    )._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(e.cause).toBeInstanceOf(Error);
  });
});

describe('createCompositeProvider close', () => {
  it('closes the mcp part once, idempotently', async () => {
    const mcp = fakeMcp([]);
    const p: RunProvider = createCompositeProvider({ host: fakePart([]), mcp });
    await p.close();
    await p.close();
    expect(mcp.close).toHaveBeenCalledTimes(1);
  });

  it('works without an mcp part', async () => {
    await expect(createCompositeProvider({ host: fakePart([]) }).close()).resolves.toBeUndefined();
  });

  it('never rejects when mcp.close rejects or throws', async () => {
    const a = fakeMcp([]);
    a.close.mockRejectedValue(new Error('x'));
    await expect(
      createCompositeProvider({ host: fakePart([]), mcp: a }).close(),
    ).resolves.toBeUndefined();
    const b = fakeMcp([]);
    b.close.mockImplementation(() => {
      throw new Error('y');
    });
    await expect(
      createCompositeProvider({ host: fakePart([]), mcp: b }).close(),
    ).resolves.toBeUndefined();
  });

  it('after close, call gives TOOL_FAILED and describe gives undefined', async () => {
    const host = fakePart(['talon.x']);
    const p = createCompositeProvider({ host, mcp: fakeMcp([]) });
    await p.close();
    expect(p.describe('talon.x')).toBeUndefined();
    const e = (await p.call('talon.x', {}, live))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(host.call).not.toHaveBeenCalled();
  });
});
