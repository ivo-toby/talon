/**
 * Unit tests for ScriptRunHandler, built on a fake ScriptService and a fake
 * capability resolver.
 */

import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { ScriptRunHandler } from '../../../../src/tools/host-tools/script-run.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { ScriptService } from '../../../../src/scripts/service.js';
import { ScriptError } from '../../../../src/scripts/types.js';
import type { ResolvedCapabilities } from '../../../../src/personas/persona-types.js';

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

const allowAll: ResolvedCapabilities = { allow: ['script.run:*'], requireApproval: [] };
const denyAll: ResolvedCapabilities = { allow: [], requireApproval: [] };

function makeReport(overrides: Record<string, unknown> = {}) {
  return { ok: true, result: { mails: 2 }, calls: [{ name: 'mail.list' }], ...overrides };
}

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    runByAgent: vi.fn(() => Promise.resolve(ok(makeReport()))),
    ...overrides,
  };
}

function makeHandler(
  service: ReturnType<typeof makeService> | null,
  capabilities: ResolvedCapabilities = allowAll,
) {
  const resolveCapabilities = vi.fn((_personaId: string) => capabilities);
  const handler = new ScriptRunHandler({
    getService: () => service as unknown as ScriptService | null,
    resolveCapabilities,
    logger: makeLogger(),
  });
  return { handler, resolveCapabilities };
}

const APPROVAL_TEXT =
  'The user must approve this run in the chat. Do not call the tool again for this request.';

describe('ScriptRunHandler', () => {
  it('has a static manifest', () => {
    expect(ScriptRunHandler.manifest.name).toBe('script.run');
    expect(ScriptRunHandler.manifest.executionLocation).toBe('host');
  });

  it.each(['Mail', 'a', 'mail_intake', 'mail intake', '1mail', '../mail', '', 'x'.repeat(50)])(
    'rejects the script name %j before any other check',
    async (name) => {
      const service = makeService();
      const { handler, resolveCapabilities } = makeHandler(service);
      const r = await handler.execute({ name } as never, context);
      expect(r.status).toBe('error');
      expect(service.runByAgent).not.toHaveBeenCalled();
      expect(resolveCapabilities).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing or non-string name', async () => {
    const service = makeService();
    const { handler } = makeHandler(service);
    for (const args of [{}, { name: 5 }, undefined]) {
      const r = await handler.execute(args as never, context);
      expect(r.status).toBe('error');
    }
    expect(service.runByAgent).not.toHaveBeenCalled();
  });

  it('answers "scripts are off" without a service, before resolving capabilities', async () => {
    const { handler, resolveCapabilities } = makeHandler(null);
    const r = await handler.execute({ name: 'mail-intake' }, context);
    expect(r).toMatchObject({ status: 'error', error: 'scripts are off' });
    expect(resolveCapabilities).not.toHaveBeenCalled();
  });

  it('denies a persona without a matching label and does not call the service', async () => {
    const service = makeService();
    const { handler } = makeHandler(service, denyAll);
    const r = await handler.execute({ name: 'mail-intake' }, context);
    expect(r).toMatchObject({
      status: 'error',
      error: 'this persona cannot run script mail-intake',
    });
    expect(service.runByAgent).not.toHaveBeenCalled();
  });

  it('resolves the capabilities of the calling persona from the context', async () => {
    const service = makeService();
    const { handler, resolveCapabilities } = makeHandler(service, denyAll);
    await handler.execute({ name: 'mail-intake' }, context);
    expect(resolveCapabilities).toHaveBeenCalledWith('persona-ctx');
  });

  it('runs an allowed script and returns the finished result', async () => {
    const service = makeService();
    const { handler } = makeHandler(service, allowAll);
    const r = await handler.execute({ name: 'mail-intake' }, context);
    expect(service.runByAgent).toHaveBeenCalledWith({
      personaId: 'persona-ctx',
      threadId: 'thread-ctx',
      scriptName: 'mail-intake',
      access: 'allowed',
    });
    expect(r).toMatchObject({ status: 'success', tool: 'script.run' });
    expect(r.result).toEqual({
      status: 'finished',
      ok: true,
      callCount: 1,
      result: '{"mails":2}',
    });
  });

  it('passes on errorCode and ok false from a failed report', async () => {
    const service = makeService({
      runByAgent: vi.fn(() =>
        Promise.resolve(ok(makeReport({ ok: false, errorCode: 'TIMEOUT', result: undefined }))),
      ),
    });
    const { handler } = makeHandler(service);
    const r = await handler.execute({ name: 'mail-intake' }, context);
    expect(r.status).toBe('success');
    expect(r.result).toEqual({
      status: 'finished',
      ok: false,
      errorCode: 'TIMEOUT',
      callCount: 1,
      result: 'null',
    });
  });

  it('returns awaiting-approval for a script in requireApproval', async () => {
    const service = makeService({
      runByAgent: vi.fn(() => Promise.resolve(ok('awaiting-approval' as const))),
    });
    const { handler } = makeHandler(service, {
      allow: [],
      requireApproval: ['script.run:mail-intake'],
    });
    const r = await handler.execute({ name: 'mail-intake' }, context);
    expect(service.runByAgent).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'approval', scriptName: 'mail-intake' }),
    );
    expect(r.status).toBe('success');
    expect(r.result).toEqual({ status: 'awaiting-approval', message: APPROVAL_TEXT });
  });

  it('cuts a large result at 8,000 characters and marks it', async () => {
    const service = makeService({
      runByAgent: vi.fn(() =>
        Promise.resolve(ok(makeReport({ result: { big: 'x'.repeat(20000) } }))),
      ),
    });
    const { handler } = makeHandler(service);
    const r = await handler.execute({ name: 'mail-intake' }, context);
    const text = (r.result as { result: string }).result;
    expect(text.length).toBeLessThanOrEqual(8000 + '\n[cut]'.length);
    expect(text.endsWith('\n[cut]')).toBe(true);
  });

  it('turns a ScriptError into scriptCode and message only', async () => {
    const service = makeService({
      runByAgent: vi.fn(() =>
        Promise.resolve(
          err(new ScriptError('SCRIPT_FAILED', 'run failed', new Error('/host/secret'))),
        ),
      ),
    });
    const { handler } = makeHandler(service);
    const r = await handler.execute({ name: 'mail-intake' }, context);
    expect(r.status).toBe('error');
    expect(r.result).toEqual({
      scriptCode: 'SCRIPT_FAILED',
      message: 'script: [SCRIPT_FAILED] run failed',
    });
    expect(JSON.stringify(r)).not.toContain('/host/secret');
  });

  it('passes a null input on as a real input', async () => {
    const service = makeService();
    const { handler } = makeHandler(service);
    await handler.execute({ name: 'mail-intake', input: null }, context);
    expect(service.runByAgent).toHaveBeenCalledWith(expect.objectContaining({ input: null }));
  });

  it('passes input through unchanged when given', async () => {
    const service = makeService();
    const { handler } = makeHandler(service);
    await handler.execute({ name: 'mail-intake', input: { since: 'today' } }, context);
    expect(service.runByAgent).toHaveBeenCalledWith(
      expect.objectContaining({ input: { since: 'today' } }),
    );
  });

  it('calls the service without an input key when the arguments have none', async () => {
    const service = makeService();
    const { handler } = makeHandler(service);
    await handler.execute({ name: 'mail-intake' }, context);
    const call = service.runByAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(call, 'input')).toBe(false);
  });

  it('ignores a personaId in the arguments', async () => {
    const service = makeService();
    const { handler, resolveCapabilities } = makeHandler(service);
    await handler.execute(
      { name: 'mail-intake', personaId: 'evil', threadId: 'evil' } as never,
      context,
    );
    expect(resolveCapabilities).toHaveBeenCalledWith('persona-ctx');
    expect(service.runByAgent).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 'persona-ctx', threadId: 'thread-ctx' }),
    );
  });

  it('returns a generic error when the service throws', async () => {
    const service = makeService({
      runByAgent: vi.fn(() => Promise.reject(new Error('/host/path boom'))),
    });
    const { handler } = makeHandler(service);
    const r = await handler.execute({ name: 'mail-intake' }, context);
    expect(r).toMatchObject({ status: 'error', error: 'script_run failed' });
    expect(JSON.stringify(r)).not.toContain('/host/path');
  });
});
