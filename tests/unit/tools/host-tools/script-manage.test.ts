/**
 * Unit tests for ScriptManageHandler, built on a fake ScriptService.
 */

import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { ScriptManageHandler } from '../../../../src/tools/host-tools/script-manage.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { ScriptService } from '../../../../src/scripts/service.js';
import { ScriptError } from '../../../../src/scripts/types.js';

function makeLogger(): import('pino').Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

const context: ToolExecutionContext = {
  runId: 'run-1',
  threadId: 'thread-ctx',
  personaId: 'persona-ctx',
  requestId: 'req-1',
};

function makeService(overrides: Record<string, unknown> = {}) {
  const service = {
    save: vi.fn(() =>
      ok({ versionId: 'v-id', version: 3, state: 'draft', manifest: { name: 'mail-intake' } }),
    ),
    test: vi.fn(() =>
      Promise.resolve(ok({ unit: [{ name: 'a', passed: true }], state: 'tested' })),
    ),
    requestApproval: vi.fn(() => Promise.resolve(ok('sent'))),
    list: vi.fn(() => ok([{ name: 'mail-intake' }])),
    show: vi.fn(() =>
      ok({ info: { name: 'mail-intake' }, files: [{ path: 'script.ts', content: 'x' }] }),
    ),
    listTools: vi.fn(() => Promise.resolve(ok([{ name: 'mailbox.list', toolClass: 'read' }]))),
    ...overrides,
  };
  return service;
}

function makeHandler(
  service: ReturnType<typeof makeService> | null,
  guide: string | null = 'GUIDE TEXT',
) {
  return new ScriptManageHandler({
    getService: () => service as unknown as ScriptService | null,
    getGuide: () => guide ?? undefined,
    logger: makeLogger(),
  });
}

const files = [
  { path: 'script.ts', content: 'code' },
  { path: 'manifest.json', content: '{}' },
];

describe('ScriptManageHandler', () => {
  it('has a static manifest', () => {
    expect(ScriptManageHandler.manifest.name).toBe('script.manage');
    expect(ScriptManageHandler.manifest.capabilities).toEqual(['script.manage:own']);
  });

  it('returns the guide without a service', async () => {
    const r = await makeHandler(null).execute({ action: 'guide' }, context);
    expect(r.status).toBe('success');
    expect(r.result).toBe('GUIDE TEXT');
  });

  it('returns an error when the guide is missing', async () => {
    const r = await makeHandler(makeService(), null).execute({ action: 'guide' }, context);
    expect(r).toMatchObject({ status: 'error', error: 'the script guide is not available' });
  });

  it.each(['tools', 'save', 'test', 'request_approval', 'list', 'show'])(
    'answers "scripts are off" for %s without a service',
    async (action) => {
      const r = await makeHandler(null).execute(
        { action, versionId: 'x', name: 'n', files } as never,
        context,
      );
      expect(r).toMatchObject({ status: 'error', error: 'scripts are off' });
    },
  );

  it('reads the service at each call', async () => {
    let current: ReturnType<typeof makeService> | null = null;
    const handler = new ScriptManageHandler({
      getService: () => current as unknown as ScriptService | null,
      getGuide: () => 'g',
      logger: makeLogger(),
    });
    expect((await handler.execute({ action: 'list' }, context)).status).toBe('error');
    current = makeService();
    expect((await handler.execute({ action: 'list' }, context)).status).toBe('success');
  });

  it('rejects an unknown action and a missing action', async () => {
    const h = makeHandler(makeService());
    const a = await h.execute({ action: 'nope' } as never, context);
    expect(a).toMatchObject({ status: 'error', error: expect.stringContaining('invalid action') });
    const b = await h.execute({} as never, context);
    expect(b.status).toBe('error');
  });

  it('lists tools with context ids and an optional name', async () => {
    const service = makeService();
    const r = await makeHandler(service).execute(
      { action: 'tools', name: 'mailbox.list', personaId: 'evil', threadId: 'evil' } as never,
      context,
    );
    expect(r.status).toBe('success');
    expect(service.listTools).toHaveBeenCalledWith({
      personaId: 'persona-ctx',
      threadId: 'thread-ctx',
      name: 'mailbox.list',
    });
    expect(r.result).toEqual([{ name: 'mailbox.list', toolClass: 'read' }]);
  });

  it('saves files and returns the version summary', async () => {
    const service = makeService();
    const r = await makeHandler(service).execute(
      { action: 'save', files, personaId: 'evil' } as never,
      context,
    );
    expect(service.save).toHaveBeenCalledWith({
      personaId: 'persona-ctx',
      threadId: 'thread-ctx',
      files,
    });
    expect(r.result).toEqual({
      versionId: 'v-id',
      name: 'mail-intake',
      version: 3,
      state: 'draft',
    });
  });

  it('validates the files of save', async () => {
    const h = makeHandler(makeService());
    const bad: unknown[] = [
      undefined,
      'x',
      [{ path: 'a' }],
      [{ path: 1, content: 'x' }],
      [null],
      Array.from({ length: 21 }, () => ({ path: 'a', content: 'b' })),
    ];
    for (const f of bad) {
      const r = await h.execute({ action: 'save', files: f } as never, context);
      expect(r).toMatchObject({
        status: 'error',
        error: 'files must be a list of at most 20 { path, content }',
      });
    }
  });

  it('validates versionId, name and version', async () => {
    const service = makeService();
    const h = makeHandler(service);
    for (const action of ['test', 'request_approval']) {
      for (const versionId of [undefined, '', 5, 'x'.repeat(101)]) {
        const r = await h.execute({ action, versionId } as never, context);
        expect(r).toMatchObject({ status: 'error', error: 'versionId is required' });
      }
    }
    for (const name of [undefined, '', 5, 'x'.repeat(101)]) {
      const r = await h.execute({ action: 'show', name } as never, context);
      expect(r).toMatchObject({ status: 'error', error: 'name is required' });
    }
    for (const version of [0, -1, 1.5, '2']) {
      const r = await h.execute({ action: 'show', name: 'n', version } as never, context);
      expect(r).toMatchObject({ status: 'error', error: 'version must be a positive integer' });
    }
    expect(service.show).not.toHaveBeenCalled();
  });

  it('tests a version and maps the dry run without outputs', async () => {
    const service = makeService({
      test: vi.fn(() =>
        Promise.resolve(
          ok({
            unit: [{ name: 'a', passed: true }],
            state: 'tested',
            dryRun: {
              didWork: true,
              report: {
                ok: true,
                result: { secret: 'RESULT' },
                calls: [
                  {
                    seq: 1,
                    name: 'mail.list',
                    toolClass: 'read',
                    input: { q: 'IN1' },
                    outcome: 'stubbed',
                    output: 'OUT',
                  },
                  {
                    seq: 2,
                    name: 'mail.send',
                    toolClass: 'write',
                    input: { to: 'bob' },
                    outcome: 'skipped-dry-run',
                  },
                  {
                    seq: 3,
                    name: 'mail.read2',
                    toolClass: 'read',
                    input: { q: 'IN2' },
                    outcome: 'executed',
                  },
                ],
              },
            },
          }),
        ),
      ),
    });
    const r = await makeHandler(service).execute({ action: 'test', versionId: 'v-id' }, context);
    expect(service.test).toHaveBeenCalledWith({ personaId: 'persona-ctx', versionId: 'v-id' });
    expect(r.result).toEqual({
      state: 'tested',
      unit: [{ name: 'a', passed: true }],
      dryRun: {
        ok: true,
        calls: [
          { name: 'mail.list', toolClass: 'read', outcome: 'stubbed' },
          {
            name: 'mail.send',
            toolClass: 'write',
            outcome: 'skipped-dry-run',
            input: { to: 'bob' },
          },
          { name: 'mail.read2', toolClass: 'read', outcome: 'executed' },
        ],
      },
    });
    const text = JSON.stringify(r.result);
    expect(text).not.toContain('RESULT');
    expect(text).not.toContain('OUT');
    expect(text).not.toContain('IN1');
  });

  it('puts the error code in a failed dry run', async () => {
    const service = makeService({
      test: vi.fn(() =>
        Promise.resolve(
          ok({
            unit: [],
            state: 'draft',
            dryRun: { didWork: false, report: { ok: false, errorCode: 'TIMEOUT', calls: [] } },
          }),
        ),
      ),
    });
    const r = await makeHandler(service).execute({ action: 'test', versionId: 'v' }, context);
    expect(r.result).toMatchObject({ dryRun: { ok: false, errorCode: 'TIMEOUT', calls: [] } });
  });

  it('requests approval and passes on sent and already-sent', async () => {
    const service = makeService();
    const h = makeHandler(service);
    const a = await h.execute({ action: 'request_approval', versionId: 'v' }, context);
    expect(service.requestApproval).toHaveBeenCalledWith({
      personaId: 'persona-ctx',
      versionId: 'v',
    });
    expect(a.result).toEqual({ status: 'sent' });
    service.requestApproval.mockResolvedValueOnce(ok('already-sent'));
    const b = await h.execute({ action: 'request_approval', versionId: 'v' }, context);
    expect(b.result).toEqual({ status: 'already-sent' });
  });

  it('lists scripts and shows a version', async () => {
    const service = makeService();
    const h = makeHandler(service);
    const l = await h.execute({ action: 'list' }, context);
    expect(service.list).toHaveBeenCalledWith('persona-ctx');
    expect(l.result).toEqual([{ name: 'mail-intake' }]);
    const s = await h.execute({ action: 'show', name: 'mail-intake', version: 2 }, context);
    expect(service.show).toHaveBeenCalledWith({
      personaId: 'persona-ctx',
      scriptName: 'mail-intake',
      version: 2,
    });
    expect(s.result).toEqual({
      info: { name: 'mail-intake' },
      files: [{ path: 'script.ts', content: 'x' }],
    });
  });

  it('turns a ScriptError into scriptCode and message only', async () => {
    const cause = new Error('/host/secret/path leaked');
    const service = makeService({
      save: vi.fn(() => err(new ScriptError('INVALID_ARGUMENT', 'bad manifest', cause))),
    });
    const r = await makeHandler(service).execute({ action: 'save', files }, context);
    expect(r.status).toBe('error');
    expect(r.result).toEqual({
      scriptCode: 'INVALID_ARGUMENT',
      message: 'script: [INVALID_ARGUMENT] bad manifest',
    });
    expect(r.error).toBe('script: [INVALID_ARGUMENT] bad manifest');
    expect(JSON.stringify(r)).not.toContain('/host/secret');
  });

  it('cuts a large result at 8,000 characters and marks it', async () => {
    const service = makeService({
      listTools: vi.fn(() =>
        Promise.resolve(
          ok([{ name: 't', toolClass: 'read', inputSchema: { a: 'x'.repeat(20000) } }]),
        ),
      ),
    });
    const r = await makeHandler(service).execute({ action: 'tools', name: 't' }, context);
    expect(r.status).toBe('success');
    expect(typeof r.result).toBe('string');
    const text = r.result as string;
    expect(text.length).toBeLessThanOrEqual(8000 + '\n[cut]'.length);
    expect(text.endsWith('\n[cut]')).toBe(true);
  });

  it('leaves a small result as an object', async () => {
    const r = await makeHandler(makeService()).execute({ action: 'list' }, context);
    expect(typeof r.result).toBe('object');
  });
});
