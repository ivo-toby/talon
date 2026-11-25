import { describe, expect, it } from 'vitest';
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
    expect(recs.every((r) => r.outcome === 'failed' && r.errorCode === 'SCRIPT_FAILED')).toBe(true);
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
