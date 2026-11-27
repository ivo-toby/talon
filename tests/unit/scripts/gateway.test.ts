import { describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from 'neverthrow';
import { createScriptGateway } from '../../../src/scripts/gateway.js';
import {
  ScriptError,
  type GatewayOptions,
  type ScriptMode,
  type ToolClass,
  type ToolProvider,
} from '../../../src/scripts/types.js';

interface FakeProvider extends ToolProvider {
  calls: Array<{ name: string; input: unknown; signal: AbortSignal }>;
  open: number;
  maxOpen: number;
}

function fakeProvider(
  classes: Record<string, ToolClass>,
  impl?: (
    name: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<Result<unknown, ScriptError>>,
): FakeProvider {
  const p: FakeProvider = {
    calls: [],
    open: 0,
    maxOpen: 0,
    describe: (name) => (name in classes ? { toolClass: classes[name] } : undefined),
    call: async (name, input, signal) => {
      p.calls.push({ name, input, signal });
      p.open++;
      p.maxOpen = Math.max(p.maxOpen, p.open);
      try {
        return impl ? await impl(name, input, signal) : ok({ echo: input });
      } finally {
        p.open--;
      }
    },
  };
  return p;
}

const TOOLS = ['r', 'w', 'm'];
const CLASSES: Record<string, ToolClass> = { r: 'read', w: 'write', m: 'model' };

function make(
  mode: ScriptMode,
  provider: ToolProvider,
  extra: Partial<GatewayOptions> = {},
): ReturnType<typeof createScriptGateway> extends Result<infer G, unknown> ? G : never {
  const result = createScriptGateway({
    manifest: { name: 's', personaId: 'p', tools: TOOLS },
    mode,
    provider,
    ...extra,
  });
  if (result.isErr()) throw new Error('create failed');
  return result.value;
}

const call = (id: number, name: string, input: unknown = {}) => ({ id, name, input });

describe('createScriptGateway validation', () => {
  const base = { manifest: { name: 's', personaId: 'p', tools: ['r'] }, mode: 'live' as const };
  const provider = fakeProvider(CLASSES);
  it.each([
    ['empty name', { manifest: { name: '', personaId: 'p', tools: ['r'] } }],
    ['empty persona', { manifest: { name: 's', personaId: '', tools: ['r'] } }],
    ['empty tool entry', { manifest: { name: 's', personaId: 'p', tools: [''] } }],
    ['bad maxCalls', { maxCalls: 0 }],
    ['bad concurrency', { maxConcurrentCalls: 1.5 }],
    ['bad result size', { maxResultChars: -1 }],
  ])('%s gives INVALID_ARGUMENT', (_label, override) => {
    const result = createScriptGateway({ ...base, provider, ...override });
    expect(result.isErr() && result.error.scriptCode).toBe('INVALID_ARGUMENT');
  });
});

describe('rules', () => {
  it('rule 1: call 201 gives CALL_LIMIT', async () => {
    const provider = fakeProvider(CLASSES);
    const gw = make('live', provider);
    for (let i = 1; i <= 200; i++) {
      expect((await gw.handleCall(call(i, 'r'))).t).toBe('result');
    }
    const reply = await gw.handleCall(call(201, 'r'));
    expect(reply).toMatchObject({ ok: false, code: 'CALL_LIMIT' });
    expect(gw.records()[200]).toMatchObject({
      seq: 201,
      outcome: 'denied',
      errorCode: 'CALL_LIMIT',
    });
    expect(provider.calls).toHaveLength(200);
  });

  it('keeps one CALL_LIMIT record and no input clone for later calls', async () => {
    const gw = make('live', fakeProvider(CLASSES), { maxCalls: 2 });
    expect(gw.limitExceeded()).toBe(false);
    await gw.handleCall(call(1, 'r'));
    await gw.handleCall(call(2, 'r'));
    expect(gw.limitExceeded()).toBe(false);
    expect(await gw.handleCall(call(3, 'r'))).toMatchObject({ ok: false, code: 'CALL_LIMIT' });
    expect(gw.limitExceeded()).toBe(true);
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
    for (let i = 4; i < 100; i++) {
      expect(await gw.handleCall(call(i, 'r'))).toMatchObject({ id: i, code: 'CALL_LIMIT' });
    }
    expect(cloneSpy).not.toHaveBeenCalled();
    cloneSpy.mockRestore();
    const recs = gw.records();
    expect(recs).toHaveLength(3);
    expect(recs[2]).toMatchObject({ outcome: 'denied', errorCode: 'CALL_LIMIT' });
  });

  it('ends the run with CALL_LIMIT when the call input passes 8 MiB', async () => {
    const provider = fakeProvider(CLASSES, () => Promise.resolve(ok({ done: true })));
    const gw = make('live', provider);
    const big = 'x'.repeat(1_000_000);
    for (let i = 1; i <= 8; i++) {
      expect(await gw.handleCall(call(i, 'r', { big }))).toMatchObject({ ok: true });
    }
    expect(gw.limitExceeded()).toBe(false);
    expect(await gw.handleCall(call(9, 'r', { big }))).toMatchObject({
      ok: false,
      code: 'CALL_LIMIT',
    });
    expect(gw.limitExceeded()).toBe(true);
    // later calls cost nothing and leave no record, also small ones
    expect(await gw.handleCall(call(10, 'r'))).toMatchObject({ code: 'CALL_LIMIT' });
    const recs = gw.records();
    expect(recs).toHaveLength(9);
    expect(recs[8]).toMatchObject({ seq: 9, outcome: 'denied', errorCode: 'CALL_LIMIT' });
    expect(provider.calls).toHaveLength(8);
  });

  it('rule 1 counts denied calls too', async () => {
    const gw = make('live', fakeProvider(CLASSES), { maxCalls: 2 });
    await gw.handleCall(call(1, 'nope'));
    await gw.handleCall(call(2, 'nope'));
    expect(await gw.handleCall(call(3, 'r'))).toMatchObject({ code: 'CALL_LIMIT' });
  });

  it('rule 2: name outside manifest is denied without asking the provider', async () => {
    const provider = fakeProvider({ ...CLASSES, x: 'read' });
    const describe = provider.describe;
    let described = 0;
    provider.describe = (n) => (described++, describe(n));
    const gw = make('live', provider);
    expect(await gw.handleCall(call(1, 'x'))).toMatchObject({ ok: false, code: 'NOT_IN_MANIFEST' });
    expect(described).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(gw.records()[0]).toMatchObject({ toolClass: 'unknown', outcome: 'denied' });
  });

  it('rule 3: unknown to provider gives UNKNOWN_TOOL', async () => {
    const gw = make('live', fakeProvider({ r: 'read' }));
    expect(await gw.handleCall(call(1, 'w'))).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' });
    expect(gw.records()[0]).toMatchObject({ outcome: 'denied', errorCode: 'UNKNOWN_TOOL' });
  });

  it('rule 4: unit mode returns stubs in order and never calls the provider', async () => {
    const provider = fakeProvider(CLASSES);
    const gw = make('unit', provider, { stubs: { r: [1, 2], m: ['x'] } });
    expect(await gw.handleCall(call(1, 'r'))).toEqual({ t: 'result', id: 1, ok: true, value: 1 });
    expect(await gw.handleCall(call(2, 'r'))).toMatchObject({ value: 2 });
    expect(await gw.handleCall(call(3, 'r'))).toMatchObject({ ok: false, code: 'NO_STUB' });
    expect(await gw.handleCall(call(4, 'w'))).toMatchObject({ ok: false, code: 'NO_STUB' });
    expect(await gw.handleCall(call(5, 'm'))).toMatchObject({ ok: true, value: 'x' });
    expect(provider.calls).toHaveLength(0);
    const recs = gw.records();
    expect(recs[0]).toMatchObject({ outcome: 'stubbed', toolClass: 'read' });
    expect(recs[2]).toMatchObject({ outcome: 'failed', errorCode: 'NO_STUB' });
  });

  it('rule 5: write in dry-run is skipped, record holds the input', async () => {
    const provider = fakeProvider(CLASSES);
    const gw = make('dry-run', provider, { stubs: { w: ['stub'] } });
    expect(await gw.handleCall(call(1, 'w', { a: 1 }))).toMatchObject({ ok: true, value: 'stub' });
    expect(await gw.handleCall(call(2, 'w', { a: 2 }))).toMatchObject({ value: { dryRun: true } });
    expect(provider.calls).toHaveLength(0);
    expect(gw.records()[1]).toMatchObject({
      outcome: 'skipped-dry-run',
      toolClass: 'write',
      input: { a: 2 },
    });
  });

  it('a write tool never reaches the provider in unit or dry-run', async () => {
    for (const mode of ['unit', 'dry-run'] as const) {
      const provider = fakeProvider(CLASSES);
      const gw = make(mode, provider);
      await gw.handleCall(call(1, 'w'));
      expect(provider.calls).toHaveLength(0);
    }
  });

  it('write runs in live mode', async () => {
    const provider = fakeProvider(CLASSES);
    const gw = make('live', provider);
    expect(await gw.handleCall(call(1, 'w', 5))).toMatchObject({ ok: true, value: { echo: 5 } });
    expect(gw.records()[0]).toMatchObject({ outcome: 'executed', toolClass: 'write' });
  });

  it('model and read classes run in dry-run and live', async () => {
    for (const mode of ['dry-run', 'live'] as const) {
      const provider = fakeProvider(CLASSES);
      const gw = make(mode, provider);
      await gw.handleCall(call(1, 'm'));
      await gw.handleCall(call(2, 'r'));
      expect(provider.calls.map((c) => c.name)).toEqual(['m', 'r']);
    }
  });

  it('rule 6: at most 8 provider calls open out of 20', async () => {
    const provider = fakeProvider(CLASSES, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return ok(1);
    });
    const gw = make('live', provider);
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) => gw.handleCall(call(i, 'r'))),
    );
    expect(replies.every((r) => r.t === 'result' && r.ok)).toBe(true);
    expect(provider.maxOpen).toBe(8);
    expect(provider.calls).toHaveLength(20);
  });

  it('rule 6: waiting calls start in arrival order', async () => {
    const provider = fakeProvider(CLASSES, async () => {
      await new Promise((r) => setTimeout(r, 2));
      return ok(1);
    });
    const gw = make('live', provider, { maxConcurrentCalls: 1 });
    await Promise.all([0, 1, 2, 3].map((i) => gw.handleCall(call(i, 'r', i))));
    expect(provider.calls.map((c) => c.input)).toEqual([0, 1, 2, 3]);
  });

  it('rule 7: oversized result gives RESULT_TOO_LARGE', async () => {
    const provider = fakeProvider(CLASSES, async () => ok('x'.repeat(50)));
    const gw = make('live', provider, { maxResultChars: 20 });
    expect(await gw.handleCall(call(1, 'r'))).toMatchObject({
      ok: false,
      code: 'RESULT_TOO_LARGE',
    });
    expect(gw.records()[0]).toMatchObject({ outcome: 'failed', errorCode: 'RESULT_TOO_LARGE' });
  });

  it('unserializable result gives TOOL_FAILED; undefined becomes null', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const values = [circular, BigInt(1), undefined];
    let i = 0;
    const provider = fakeProvider(CLASSES, async () => ok(values[i++]));
    const gw = make('live', provider);
    expect(await gw.handleCall(call(1, 'r'))).toMatchObject({ code: 'TOOL_FAILED' });
    expect(await gw.handleCall(call(2, 'r'))).toMatchObject({ code: 'TOOL_FAILED' });
    expect(await gw.handleCall(call(3, 'r'))).toEqual({
      t: 'result',
      id: 3,
      ok: true,
      value: null,
    });
  });
});

describe('provider failures', () => {
  const secret = 'SECRET-PROVIDER-TEXT';
  it.each([
    ['error result', async () => err(new ScriptError('TOOL_FAILED', secret))],
    ['rejection', async () => Promise.reject(new Error(secret))],
    [
      'sync throw',
      (() => {
        throw new Error(secret);
      }) as never,
    ],
  ])('%s gives TOOL_FAILED with a fixed message', async (_label, impl) => {
    const provider = fakeProvider(CLASSES);
    provider.call = impl as ToolProvider['call'];
    const gw = make('live', provider);
    const reply = await gw.handleCall(call(1, 'r', 'SECRET-INPUT'));
    expect(reply).toMatchObject({ ok: false, code: 'TOOL_FAILED' });
    expect(JSON.stringify(reply)).not.toContain(secret);
    expect(JSON.stringify(reply)).not.toContain('SECRET-INPUT');
  });
});

describe('abortAll', () => {
  it('aborts the signal of each open call, fails waiting calls, refuses new ones', async () => {
    const provider = fakeProvider(
      CLASSES,
      (_n, _i, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(err(new ScriptError('TIMEOUT', 'x'))));
        }),
    );
    const gw = make('live', provider, { maxConcurrentCalls: 2 });
    const pending = [1, 2, 3, 4].map((i) => gw.handleCall(call(i, 'r')));
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.calls).toHaveLength(2);
    expect(gw.records()).toHaveLength(0);
    gw.abortAll();
    const replies = await Promise.all(pending);
    for (const reply of replies) {
      expect(reply).toMatchObject({ ok: false, code: 'SCRIPT_FAILED' });
    }
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.every((c) => c.signal.aborted)).toBe(true);
    expect(await gw.handleCall(call(5, 'r'))).toMatchObject({ code: 'SCRIPT_FAILED' });
    const recs = gw.records();
    expect(recs).toHaveLength(5);
    // The two calls that reached the provider have an unknown effect; the others never started.
    expect(recs.map((r) => r.outcome)).toEqual([
      'aborted',
      'aborted',
      'failed',
      'failed',
      'failed',
    ]);
    expect(recs.every((r) => r.errorCode === 'SCRIPT_FAILED')).toBe(true);
  });

  it('an open live write at abort is aborted, a waiting one is failed', async () => {
    const provider = fakeProvider(
      CLASSES,
      (_n, _i, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(err(new ScriptError('TIMEOUT', 'x'))));
        }),
    );
    const gw = make('live', provider, { maxConcurrentCalls: 1 });
    const open = gw.handleCall(call(1, 'w'));
    const waiting = gw.handleCall(call(2, 'w'));
    await new Promise((r) => setTimeout(r, 5));
    gw.abortAll();
    await Promise.all([open, waiting]);
    expect(provider.calls).toHaveLength(1);
    expect(gw.records().map((r) => [r.outcome, r.errorCode])).toEqual([
      ['aborted', 'SCRIPT_FAILED'],
      ['failed', 'SCRIPT_FAILED'],
    ]);
  });

  it('a provider that returns ok after the abort is still aborted', async () => {
    let release: () => void = () => undefined;
    const provider = fakeProvider(
      CLASSES,
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok('late'));
        }),
    );
    const gw = make('live', provider);
    const pending = gw.handleCall(call(1, 'w'));
    await new Promise((r) => setTimeout(r, 5));
    gw.abortAll();
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'SCRIPT_FAILED' });
    expect(gw.records()[0]).toMatchObject({ outcome: 'aborted', errorCode: 'SCRIPT_FAILED' });
  });

  it('each provider call gets its own signal', async () => {
    const provider = fakeProvider(CLASSES);
    const gw = make('live', provider);
    await gw.handleCall(call(1, 'r'));
    await gw.handleCall(call(2, 'r'));
    expect(provider.calls[0].signal).not.toBe(provider.calls[1].signal);
  });
});

describe('records', () => {
  it('returns copies in seq order', async () => {
    const gw = make('live', fakeProvider(CLASSES));
    await Promise.all([
      gw.handleCall(call(9, 'r')),
      gw.handleCall(call(8, 'nope')),
      gw.handleCall(call(7, 'w')),
    ]);
    const recs = gw.records();
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(recs.map((r) => r.name)).toEqual(['r', 'nope', 'w']);
    recs[0].outcome = 'denied';
    expect(gw.records()[0].outcome).toBe('executed');
  });
});

describe('fail-closed hardening', () => {
  const base = { manifest: { name: 's', personaId: 'p', tools: ['r'] } };
  const provider = fakeProvider(CLASSES);

  it('rejects an unrecognised mode', () => {
    const result = createScriptGateway({ ...base, provider, mode: 'dryrun' as never });
    expect(result.isErr() && result.error.scriptCode).toBe('INVALID_ARGUMENT');
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['non-array value', { r: 5 }],
  ])('rejects stubs that are %s without throwing', (_label, stubs) => {
    const result = createScriptGateway({ ...base, provider, mode: 'unit', stubs: stubs as never });
    expect(result.isErr() && result.error.scriptCode).toBe('INVALID_ARGUMENT');
  });

  it('refuses inherited names and returns no inherited stub', async () => {
    const p = fakeProvider({ ...CLASSES });
    const gw = make('unit', p, { stubs: { r: [1] } });
    for (const [i, name] of ['__proto__', 'constructor', 'toString'].entries()) {
      expect(await gw.handleCall(call(i, name))).toMatchObject({ code: 'NOT_IN_MANIFEST' });
    }
    expect(p.calls).toHaveLength(0);
    // a listed tool whose name is inherited has no stub either
    const result = createScriptGateway({
      manifest: { name: 's', personaId: 'p', tools: ['toString'] },
      mode: 'unit',
      provider: fakeProvider({ toString: 'read' }),
    });
    if (result.isErr()) throw new Error('create failed');
    expect(await result.value.handleCall(call(1, 'toString'))).toMatchObject({ code: 'NO_STUB' });
  });

  it('a describe that throws gives a denied call and no provider call', async () => {
    const p = fakeProvider(CLASSES);
    p.describe = () => {
      throw new Error('boom');
    };
    const gw = make('live', p);
    expect(await gw.handleCall(call(1, 'r'))).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' });
    expect(gw.records()[0].outcome).toBe('denied');
    expect(p.calls).toHaveLength(0);
  });

  it('an unknown tool class is treated as write in dry-run', async () => {
    const p = fakeProvider({ r: 'bogus' as never });
    const gw = make('dry-run', p);
    expect(await gw.handleCall(call(1, 'r'))).toMatchObject({ ok: true, value: { dryRun: true } });
    expect(p.calls).toHaveLength(0);
  });

  it('a describe result without toolClass is a write tool and is skipped in dry-run', async () => {
    const p = fakeProvider(CLASSES);
    p.describe = () => ({}) as never;
    const gw = make('dry-run', p);
    expect(await gw.handleCall(call(1, 'r'))).toMatchObject({ ok: true, value: { dryRun: true } });
    expect(p.calls).toHaveLength(0);
    expect(gw.records()[0].outcome).toBe('skipped-dry-run');
  });

  it('stub values get the serialisation and size check', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const gw = make('unit', fakeProvider(CLASSES), {
      stubs: { r: [circular, 'x'.repeat(50)], w: [BigInt(1)] },
      maxResultChars: 20,
    });
    expect(await gw.handleCall(call(1, 'r'))).toMatchObject({ code: 'TOOL_FAILED' });
    expect(await gw.handleCall(call(2, 'r'))).toMatchObject({ code: 'RESULT_TOO_LARGE' });
    expect(await gw.handleCall(call(3, 'w'))).toMatchObject({ code: 'TOOL_FAILED' });
    expect(gw.records().map((r) => r.outcome)).toEqual(['failed', 'failed', 'failed']);
    const dry = make('dry-run', fakeProvider(CLASSES), {
      stubs: { w: ['x'.repeat(50)] },
      maxResultChars: 20,
    });
    expect(await dry.handleCall(call(1, 'w'))).toMatchObject({ code: 'RESULT_TOO_LARGE' });
  });

  it('record input is a snapshot of the caller object', async () => {
    const input = { a: { b: 1 } };
    const gw = make('live', fakeProvider(CLASSES));
    await gw.handleCall(call(1, 'r', input));
    input.a.b = 2;
    expect(gw.records()[0].input).toEqual({ a: { b: 1 } });
  });

  it('record input falls back to the reference when cloning throws', async () => {
    const input = { f: () => 1 };
    const gw = make('live', fakeProvider(CLASSES));
    await gw.handleCall(call(1, 'r', input));
    expect(gw.records()[0].input).toBe(input);
  });
});
