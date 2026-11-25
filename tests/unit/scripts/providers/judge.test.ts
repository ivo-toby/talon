import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateText } from 'ai';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(actual.generateText) };
});
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';
import {
  createJudgeProvider,
  createOpenAiCompatibleJudgeModel,
  type JudgeModel,
} from '../../../../src/scripts/providers/judge.js';
import { ScriptError } from '../../../../src/scripts/types.js';
import type { RunContext } from '../../../../src/scripts/types.js';

const live = new AbortController().signal;
const schema = {
  type: 'object',
  properties: { label: { type: 'string' } },
  required: ['label'],
  additionalProperties: false,
};

let dir: string;
let context: RunContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judge-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', 'classify.md'), 'You classify mail.');
  context = {
    personaId: 'p',
    threadId: 't',
    scriptRunId: 'r',
    scriptName: 'demo',
    channels: [],
    versionDir: dir,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake(reply: unknown = { label: 'spam' }): {
  model: JudgeModel;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn().mockResolvedValue(ok(reply));
  return { model: { generate }, generate };
}

function make(model: JudgeModel, timeoutMs = 1000): ReturnType<typeof createJudgeProvider> {
  return createJudgeProvider({ model, context, timeoutMs });
}

async function code(p: Promise<{ isErr(): boolean; error?: unknown }>): Promise<string> {
  const r = await p;
  expect(r.isErr()).toBe(true);
  return (r.error as ScriptError).scriptCode;
}

describe('createJudgeProvider', () => {
  it('describes only model.judge', () => {
    const { model } = fake();
    const p = make(model);
    expect(p.describe('model.judge')).toEqual({ toolClass: 'model' });
    expect(p.describe('model.other')).toBeUndefined();
    expect(p.describe('toString')).toBeUndefined();
  });

  it('rejects another tool name', async () => {
    const { model, generate } = fake();
    expect(await code(make(model).call('model.x', {}, live))).toBe('UNKNOWN_TOOL');
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends the prompt file as system and the input JSON as the only user text', async () => {
    const { model, generate } = fake();
    const input = { mails: ['a', 'b'] };
    const r = await make(model).call('model.judge', { prompt: 'classify', input, schema }, live);
    expect(r._unsafeUnwrap()).toEqual({ label: 'spam' });
    expect(generate).toHaveBeenCalledTimes(1);
    const req = generate.mock.calls[0][0];
    expect(req.system).toBe('You classify mail.');
    expect(req.user).toBe(JSON.stringify(input));
    expect(req.schema).toEqual(schema);
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts null input', async () => {
    const { model, generate } = fake();
    await make(model).call('model.judge', { prompt: 'classify', input: null, schema }, live);
    expect(generate.mock.calls[0][0].user).toBe('null');
  });

  it.each([
    ['missing input key', { prompt: 'classify', schema }],
    ['path characters', { prompt: '../classify', input: 1, schema }],
    ['upper case', { prompt: 'Classify', input: 1, schema }],
    ['too long name', { prompt: 'a'.repeat(65), input: 1, schema }],
    ['extra key', { prompt: 'classify', input: 1, schema, model: 'x' }],
    ['extra system key', { prompt: 'classify', input: 1, schema, system: 'x' }],
    ['schema not object type', { prompt: 'classify', input: 1, schema: { type: 'string' } }],
    [
      'schema too large',
      { prompt: 'classify', input: 1, schema: { type: 'object', d: 'x'.repeat(16384) } },
    ],
    ['input too large', { prompt: 'classify', input: 'x'.repeat(200_001), schema }],
    ['not an object', 'classify'],
  ])('rejects bad input: %s', async (_n, bad) => {
    const { model, generate } = fake();
    expect(await code(make(model).call('model.judge', bad, live))).toBe('INVALID_ARGUMENT');
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a missing prompt file with a fixed message', async () => {
    const { model, generate } = fake();
    const r = await make(model).call('model.judge', { prompt: 'nope', input: 1, schema }, live);
    const e = r._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('INVALID_ARGUMENT');
    expect(e.message).not.toContain(dir);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a prompts directory that is a symbolic link', async () => {
    const other = mkdtempSync(join(tmpdir(), 'judge-other-'));
    try {
      writeFileSync(join(other, 'classify.md'), 'outside');
      rmSync(join(dir, 'prompts'), { recursive: true });
      symlinkSync(other, join(dir, 'prompts'));
      const { model, generate } = fake();
      expect(
        await code(make(model).call('model.judge', { prompt: 'classify', input: 1, schema }, live)),
      ).toBe('INVALID_ARGUMENT');
      expect(generate).not.toHaveBeenCalled();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic link and an oversized prompt file', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'secret');
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'prompts', 'link.md'));
    writeFileSync(join(dir, 'prompts', 'big.md'), 'x'.repeat(65_537));
    mkdirSync(join(dir, 'prompts', 'folder.md'));
    const { model, generate } = fake();
    const p = make(model);
    for (const prompt of ['link', 'big', 'folder']) {
      expect(await code(p.call('model.judge', { prompt, input: 1, schema }, live))).toBe(
        'INVALID_ARGUMENT',
      );
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a schema that cannot be converted, without calling the model', async () => {
    const { model, generate } = fake();
    const bad = { type: 'object', properties: { a: { $ref: '#/definitions/missing' } } };
    expect(
      await code(
        make(model).call('model.judge', { prompt: 'classify', input: 1, schema: bad }, live),
      ),
    ).toBe('INVALID_ARGUMENT');
    expect(generate).not.toHaveBeenCalled();
  });

  it('fails TOOL_FAILED when the reply does not match the schema', async () => {
    const { model } = fake({ label: 5 });
    const r = await make(model).call('model.judge', { prompt: 'classify', input: 1, schema }, live);
    const e = r._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(e.message).not.toContain('label');
  });

  it('passes through a model error', async () => {
    const model: JudgeModel = {
      generate: () =>
        Promise.resolve(err(new ScriptError('TOOL_FAILED', 'judge model request failed'))),
    };
    expect(
      await code(make(model).call('model.judge', { prompt: 'classify', input: 1, schema }, live)),
    ).toBe('TOOL_FAILED');
  });

  it('fails TOOL_FAILED when the model throws', async () => {
    const model: JudgeModel = { generate: () => Promise.reject(new Error('secret detail')) };
    const r = await make(model).call('model.judge', { prompt: 'classify', input: 1, schema }, live);
    const e = r._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(e.message).not.toContain('secret');
  });

  it('times out at once, aborts the model signal and ignores a late result', async () => {
    let signal: AbortSignal | undefined;
    let late: (v: unknown) => void = () => undefined;
    const model: JudgeModel = {
      generate: (req) => {
        signal = req.signal;
        return new Promise((resolve) => {
          late = resolve;
        });
      },
    };
    const r = await make(model, 30).call(
      'model.judge',
      { prompt: 'classify', input: 1, schema },
      live,
    );
    expect(r._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
    expect(signal?.aborted).toBe(true);
    late(ok({ label: 'x' }));
  });

  it('does not leave an unhandled rejection after a timeout', async () => {
    const seen: unknown[] = [];
    const onRej = (e: unknown): number => seen.push(e);
    process.on('unhandledRejection', onRej);
    const model: JudgeModel = {
      generate: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60)),
    };
    await make(model, 20).call('model.judge', { prompt: 'classify', input: 1, schema }, live);
    await new Promise((r) => setTimeout(r, 120));
    process.off('unhandledRejection', onRej);
    expect(seen).toEqual([]);
  });

  it('aborts when the caller aborts', async () => {
    const ac = new AbortController();
    let signal: AbortSignal | undefined;
    const model: JudgeModel = {
      generate: (req) => {
        signal = req.signal;
        return new Promise(() => undefined);
      },
    };
    const pending = make(model, 10_000).call(
      'model.judge',
      { prompt: 'classify', input: 1, schema },
      ac.signal,
    );
    setTimeout(() => ac.abort(), 10);
    expect(await code(pending)).toBe('TOOL_FAILED');
    expect(signal?.aborted).toBe(true);
  });

  it('fails at once when the caller signal is already aborted', async () => {
    const { model, generate } = fake();
    const ac = new AbortController();
    ac.abort();
    expect(
      await code(
        make(model).call('model.judge', { prompt: 'classify', input: 1, schema }, ac.signal),
      ),
    ).toBe('TOOL_FAILED');
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('judge schema safety', () => {
  const run = async (s: object): Promise<{ code?: string; calls: number }> => {
    const { model, generate } = fake({});
    const r = await make(model).call(
      'model.judge',
      { prompt: 'classify', input: 1, schema: s },
      live,
    );
    return { code: r.isErr() ? r.error.scriptCode : undefined, calls: generate.mock.calls.length };
  };
  const withProp = (prop: unknown): object => ({ type: 'object', properties: { a: prop } });
  /** A chain of n nested schema nodes below `properties.a`; the leaf is at JSON depth n + 2. */
  const chain = (n: number): unknown =>
    n === 1 ? { type: 'string' } : { type: 'array', items: chain(n - 1) };

  it('refuses a catastrophic pattern without calling the model', async () => {
    const r = await run(withProp({ type: 'string', pattern: '^(a+)+$' }));
    expect(r).toEqual({ code: 'INVALID_ARGUMENT', calls: 0 });
  });

  it.each([
    ['pattern in items', withProp({ type: 'array', items: { type: 'string', pattern: 'a' } })],
    ['pattern in anyOf', withProp({ anyOf: [{ type: 'string', pattern: 'a' }] })],
    [
      'pattern in additionalProperties',
      {
        type: 'object',
        additionalProperties: { type: 'string', pattern: 'a' },
      },
    ],
    ['format', withProp({ type: 'string', format: 'email' })],
    ['$ref', withProp({ $ref: '#/$defs/x' })],
    ['patternProperties', { type: 'object', patternProperties: { a: { type: 'string' } } }],
    ['not', withProp({ not: { type: 'string' } })],
    ['pattern in unknown schema keyword', withProp({ contains: { type: 'string', pattern: 'a' } })],
  ])('refuses %s', async (_n, s) => {
    expect(await run(s as object)).toEqual({ code: 'INVALID_ARGUMENT', calls: 0 });
  });

  it('accepts properties merely named pattern or format, and keyword words in data', async () => {
    const r = await run({
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        format: { type: 'string', enum: ['pattern', 'format'], description: 'format' },
      },
    });
    expect(r.code).toBeUndefined();
    expect(r.calls).toBe(1);
  });

  it('accepts depth 12 and refuses depth 13', async () => {
    expect((await run(withProp(chain(10)))).code).toBeUndefined();
    expect(await run(withProp(chain(11)))).toEqual({ code: 'INVALID_ARGUMENT', calls: 0 });
  });

  it('refuses more than 500 nodes, also inside data keywords', async () => {
    const many = Array.from({ length: 501 }, () => ({}));
    expect((await run({ type: 'object', properties: { a: { enum: many } } })).code).toBe(
      'INVALID_ARGUMENT',
    );
    const props = Object.fromEntries(
      Array.from({ length: 501 }, (_, i) => [`p${i}`, { type: 'string' }]),
    );
    expect(await run({ type: 'object', properties: props })).toEqual({
      code: 'INVALID_ARGUMENT',
      calls: 0,
    });
  });
});

describe('createOpenAiCompatibleJudgeModel', () => {
  let server: Server;
  let baseUrl: string;
  let bodies: Array<Record<string, any>>;
  let headersSeen: Array<Record<string, unknown>>;
  let respond: (res: import('node:http').ServerResponse) => void;

  const completion = (content: string): string =>
    JSON.stringify({
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

  const replyWith = (content: string): void => {
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(completion(content));
    };
  };

  beforeEach(async () => {
    bodies = [];
    headersSeen = [];
    replyWith('{"label":"spam"}');
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/chat/completions');
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        headersSeen.push(req.headers);
        respond(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const request = (input: unknown = { a: 1 }): Parameters<JudgeModel['generate']>[0] => ({
    system: 'Be a judge.',
    user: JSON.stringify(input),
    schema,
    signal: live,
  });

  it('sends one system and one user message, no tools, and parses plain JSON', async () => {
    const model = createOpenAiCompatibleJudgeModel({
      baseUrl,
      apiKey: 'k',
      headers: { 'x-extra': 'yes' },
      modelId: 'm',
    });
    const r = await model.generate(request());
    expect(r._unsafeUnwrap()).toEqual({ label: 'spam' });
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1].content).toBe('{"a":1}');
    expect(body.messages[0].content.startsWith('Be a judge.')).toBe(true);
    expect(body.messages[0].content).toContain(
      'Reply with one JSON value that matches this JSON Schema, and with nothing else:',
    );
    expect(body.messages[0].content).toContain(JSON.stringify(schema));
    expect(body.temperature).toBe(0);
    expect(headersSeen[0].authorization).toBe('Bearer k');
    expect(headersSeen[0]['x-extra']).toBe('yes');
  });

  it('passes the telemetry object to generateText only when given', async () => {
    const spy = vi.mocked(generateText);
    spy.mockClear();
    await createOpenAiCompatibleJudgeModel({
      baseUrl,
      modelId: 'm',
      telemetry: { scriptName: 'demo' },
    }).generate(request());
    expect(spy.mock.calls[0][0].experimental_telemetry).toEqual({
      isEnabled: true,
      functionId: 'script.judge',
      metadata: { scriptName: 'demo' },
    });
    expect(spy.mock.calls[0][0]).not.toHaveProperty('tools');
    await createOpenAiCompatibleJudgeModel({ baseUrl, modelId: 'm' }).generate(request());
    expect(spy.mock.calls[1][0].experimental_telemetry).toBeUndefined();
  });

  it('strips one Markdown code fence', async () => {
    replyWith('```json\n{"label":"ham"}\n```');
    const model = createOpenAiCompatibleJudgeModel({ baseUrl, modelId: 'm' });
    expect((await model.generate(request()))._unsafeUnwrap()).toEqual({ label: 'ham' });
  });

  it('fails TOOL_FAILED on a reply that is not JSON', async () => {
    replyWith('I think it is spam.');
    const model = createOpenAiCompatibleJudgeModel({ baseUrl, modelId: 'm' });
    const e = (await model.generate(request()))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(e.message).not.toContain('spam');
  });

  it('refuses a reply over 262,144 characters before it is parsed', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    replyWith(`{"label":"${'s'.repeat(262_144)}"}`);
    const model = createOpenAiCompatibleJudgeModel({ baseUrl, modelId: 'm' });
    parse.mockClear();
    const e = (await model.generate(request()))._unsafeUnwrapErr();
    const parsedReply = parse.mock.calls.some(
      ([text]) => typeof text === 'string' && text.startsWith('{"label"'),
    );
    parse.mockRestore();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(e.message).toContain('too long');
    expect(parsedReply).toBe(false);
    replyWith(`{"label":"${'s'.repeat(1000)}"}`);
    expect((await model.generate(request())).isOk()).toBe(true);
  });

  it('fails TOOL_FAILED on HTTP 500', async () => {
    respond = (res) => {
      res.statusCode = 500;
      res.end('{"error":{"message":"boom"}}');
    };
    const model = createOpenAiCompatibleJudgeModel({ baseUrl, modelId: 'm' });
    const e = (await model.generate(request()))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(e.message).not.toContain('boom');
    expect(e.cause).toBeInstanceOf(Error);
  }, 15_000);
});
