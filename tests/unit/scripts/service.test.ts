import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';
import pino from 'pino';
import { ExecutionBroker, InMemoryContainerBackend } from '../../../src/execution-broker/index.js';
import type { OperatorAllowlist } from '../../../src/execution-broker/index.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ScriptRepository } from '../../../src/core/database/repositories/script-repository.js';
import { ScriptsConfigSchema } from '../../../src/core/config/config-schema.js';
import type { InboundEvent } from '../../../src/channels/channel-types.js';
import { createApprovalService } from '../../../src/scripts/approval.js';
import { createScriptService } from '../../../src/scripts/service.js';
import type { ScriptServiceDeps } from '../../../src/scripts/service.js';
import { createScriptStore } from '../../../src/scripts/store.js';
import type { ScriptFile } from '../../../src/scripts/store.js';
import { ScriptError } from '../../../src/scripts/types.js';
import type { RunProvider, ToolClass } from '../../../src/scripts/types.js';
import { createTestDb } from '../core/database/repositories/helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const classes: Record<string, ToolClass> = { 'mail.read': 'read', 'mail.send': 'write' };
const line = (m: unknown): string => JSON.stringify(m) + '\n';

type Call = { name: string; input: unknown };
const SCRIPT_CALLS: Call[] = [
  { name: 'mail.read', input: { q: 1 } },
  { name: 'mail.send', input: { to: 'a' } },
];

function play(
  backend: InMemoryContainerBackend,
  calls: Call[],
  done: { ok: boolean; result?: unknown; message?: string },
): void {
  backend.setExecStreamHandler((c) => {
    let next = 0;
    c.onStdin(() => {
      if (next < calls.length) {
        const { name, input } = calls[next];
        c.emitStdout(line({ t: 'call', id: ++next, name, input }));
      } else {
        c.emitStdout(line({ t: 'done', ...done }));
      }
    });
    return new Promise(() => {});
  });
}

function files(opts: { expectResult?: unknown; name?: string; extra?: string } = {}): ScriptFile[] {
  return [
    { path: 'script.ts', content: `// ${opts.extra ?? 'v'}\n` },
    {
      path: 'manifest.json',
      content: JSON.stringify({
        name: opts.name ?? 'mail-intake',
        description: 'Reads mail and sends a reply.',
        tools: ['mail.read', 'mail.send'],
        channels: [],
        dryRunInput: { d: 1 },
        liveInput: { live: true },
      }),
    },
    {
      path: 'tests.json',
      content: JSON.stringify({
        cases: [
          {
            name: 'basic',
            input: null,
            stubs: { 'mail.read': [{ n: 1 }], 'mail.send': [{ id: 1 }] },
            expect: {
              result: opts.expectResult ?? { sent: 1 },
              writes: [{ name: 'mail.send', input: { to: 'a' } }],
            },
          },
        ],
      }),
    },
  ];
}

function setup(over: Partial<ScriptServiceDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'svc-'));
  roots.push(root);
  const db = createTestDb();
  const repo = new ScriptRepository(db);
  const personas = new PersonaRepository(db);
  for (const id of ['p1', 'p2']) {
    personas
      .insert({
        id,
        name: id,
        model: 'm',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
  }
  const logger = pino({ level: 'silent' });
  const allowlist: OperatorAllowlist = {
    profiles: [
      {
        id: 'script',
        maxTimeoutMs: 60_000,
        outputCapChars: 1000,
        maxArgvCount: 8,
        maxArgvChars: 200,
        maxConcurrentExecsPerLease: 1,
        maxActiveLeases: 4,
      },
    ],
    workspaces: [{ id: 'scripts', hostPath: root, mountTarget: '/scripts', mode: 'ro' }],
    grants: ['p1', 'p2'].map((id) => ({
      parentPersona: id,
      workerPersona: id,
      profile: 'script',
      workspace: 'scripts',
    })),
  };
  const backend = new InMemoryContainerBackend({ diskQuotaEnforced: true });
  const broker = new ExecutionBroker({ allowlist, backend });
  let t = 1_000_000;
  const now = (): number => (t += 1000);
  const store = createScriptStore({ root, repo, logger });
  const approval = createApprovalService({
    repo,
    ttlMinutes: 60,
    now,
    randomBytes: () => Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
    logger,
  });
  const providers: Array<{ close: ReturnType<typeof vi.fn>; calls: Call[] }> = [];
  const providerCalls: Call[] = [];
  const createProvider = vi.fn((_ctx: unknown, _manifest: unknown) => {
    const close = vi.fn(() => Promise.resolve());
    const provider: RunProvider = {
      describe: (name) => (classes[name] ? { toolClass: classes[name] } : undefined),
      call: (name, input) => {
        providerCalls.push({ name, input });
        return Promise.resolve(ok({ rows: 1 }));
      },
      close,
    };
    providers.push({ close, calls: providerCalls });
    return Promise.resolve(ok(provider));
  });
  const sent: Array<{ channel: string; thread: string; body: string }> = [];
  const send = vi.fn((channel: string, thread: string, body: string) => {
    sent.push({ channel, thread, body });
    return Promise.resolve(ok(undefined));
  });
  const notifyThread = vi.fn(() => Promise.resolve(ok(undefined)));
  const audits: Array<Record<string, unknown>> = [];
  const deps: ScriptServiceDeps = {
    store,
    repo,
    approval,
    broker,
    config: ScriptsConfigSchema.parse({ runTimeoutMs: 5000, maxCallsPerRun: 50 }),
    createProvider,
    send,
    notifyThread,
    audit: (e) => audits.push(e),
    now,
    logger,
    ...over,
  };
  const service = createScriptService(deps);
  const event = (content: unknown, thread = 'chat-1'): InboundEvent =>
    ({
      channelType: 'telegram',
      channelName: 'tg',
      externalThreadId: thread,
      senderId: 'u',
      idempotencyKey: 'k',
      content,
    }) as InboundEvent;
  const stateOf = (versionId: string): string | undefined =>
    repo.getVersion(versionId)._unsafeUnwrap()?.state;
  const codeOf = (): string => /\/approve ([A-Z0-9]{8})/.exec(sent[sent.length - 1].body)![1];

  /** save, test, request approval; returns the version. */
  async function toAwaiting(f: ScriptFile[] = files()) {
    play(backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const version = service.save({ personaId: 'p1', threadId: 'th1', files: f })._unsafeUnwrap();
    const tested = (
      await service.test({ personaId: 'p1', versionId: version.versionId })
    )._unsafeUnwrap();
    expect(tested.state).toBe('tested');
    (
      await service.requestApproval({
        personaId: 'p1',
        versionId: version.versionId,
        channelName: 'tg',
        externalThreadId: 'chat-1',
      })
    )._unsafeUnwrap();
    return version;
  }
  async function toApproved() {
    const version = await toAwaiting();
    const reply = await service.handleInbound(event(`/approve ${codeOf()}`));
    return { version, reply };
  }
  const live = { personaId: 'p1', threadId: 'th1', scriptName: 'mail-intake', scheduleId: 's1' };
  return {
    service,
    repo,
    backend,
    db,
    store,
    root,
    sent,
    send,
    notifyThread,
    audits,
    providers,
    providerCalls,
    createProvider,
    event,
    stateOf,
    codeOf,
    toAwaiting,
    toApproved,
    live,
  };
}

describe('full flow', () => {
  it('goes from save to an approved live run', async () => {
    const s = setup();
    const { version, reply } = await s.toApproved();
    expect(reply).toBe('Approved: script "mail-intake" v1. It can now run on a schedule.');
    expect(s.stateOf(version.versionId)).toBe('approved');
    expect(s.service.hasApproved('p1', 'mail-intake')).toBe(true);
    expect(s.service.hasApproved('p2', 'mail-intake')).toBe(false);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].body).toContain('mail.send');

    s.providerCalls.length = 0;
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const run = (await s.service.runScheduled(s.live))._unsafeUnwrap();
    expect(run).not.toBe('skipped');
    if (run === 'skipped') return;
    expect(run.ok).toBe(true);
    // live mode: the write tool really ran
    expect(s.providerCalls).toEqual(SCRIPT_CALLS);
    expect(run.calls.map((c) => c.outcome)).toEqual(['executed', 'executed']);
    const ctx = s.createProvider.mock.calls.at(-1)![0] as { threadId: string; scriptRunId: string };
    expect(ctx.threadId).toBe('th1');
    const row = s.db.prepare(`SELECT * FROM script_runs WHERE trigger = 'schedule'`).get() as {
      mode: string;
      ok: number;
      call_count: number;
      ended_at: number;
      schedule_id: string;
    };
    expect(row).toMatchObject({ mode: 'live', ok: 1, call_count: 2, schedule_id: 's1' });
    expect(row.ended_at).toBeGreaterThan(0);
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(false);
  });

  it('records the unit and the dry-run rows', async () => {
    const s = setup();
    await s.toAwaiting();
    const rows = s.db
      .prepare(`SELECT mode, trigger, ok, ended_at FROM script_runs ORDER BY started_at`)
      .all();
    expect(rows).toEqual([
      { mode: 'unit', trigger: 'test', ok: 1, ended_at: expect.any(Number) },
      { mode: 'dry-run', trigger: 'dry-run', ok: 1, ended_at: expect.any(Number) },
    ]);
  });
});

describe('save, test and requestApproval refusals', () => {
  it('refuses another persona with the unknown-version message', async () => {
    const s = setup();
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const version = s.service
      .save({ personaId: 'p1', threadId: 'th1', files: files() })
      ._unsafeUnwrap();
    const other = await s.service.test({ personaId: 'p2', versionId: version.versionId });
    const unknown = await s.service.test({ personaId: 'p2', versionId: 'nope' });
    expect(other._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(other._unsafeUnwrapErr().message).toBe(unknown._unsafeUnwrapErr().message);
    await s.service.test({ personaId: 'p1', versionId: version.versionId });
    const req = await s.service.requestApproval({
      personaId: 'p2',
      versionId: version.versionId,
      channelName: 'tg',
      externalThreadId: 'c',
    });
    expect(req._unsafeUnwrapErr().message).toBe(unknown._unsafeUnwrapErr().message);
    expect(s.sent).toHaveLength(0);
  });

  it('refuses a test in the wrong state', async () => {
    const s = setup();
    const { version } = await s.toApproved();
    const r = await s.service.test({ personaId: 'p1', versionId: version.versionId });
    expect(r._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
  });

  it('refuses an approval request for a draft and for a missing report', async () => {
    const s = setup();
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    const draft = await s.service.requestApproval({
      personaId: 'p1',
      versionId: v.versionId,
      channelName: 'tg',
      externalThreadId: 'c',
    });
    expect(draft._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    s.db.prepare(`UPDATE script_versions SET state = 'tested' WHERE id = ?`).run(v.versionId);
    const noReport = await s.service.requestApproval({
      personaId: 'p1',
      versionId: v.versionId,
      channelName: 'tg',
      externalThreadId: 'c',
    });
    expect(noReport._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    s.db
      .prepare(`UPDATE script_versions SET dry_run_report = '{nope' WHERE id = ?`)
      .run(v.versionId);
    const bad = await s.service.requestApproval({
      personaId: 'p1',
      versionId: v.versionId,
      channelName: 'tg',
      externalThreadId: 'c',
    });
    expect(bad._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(s.sent).toHaveLength(0);
  });

  it('returns a provider creation error as it is and runs nothing', async () => {
    const failure = new ScriptError('SANDBOX', 'no provider');
    const s = setup({ createProvider: () => Promise.resolve(err(failure)) });
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    const r = await s.service.test({ personaId: 'p1', versionId: v.versionId });
    expect(r._unsafeUnwrapErr()).toBe(failure);
    expect(s.stateOf(v.versionId)).toBe('draft');
  });

  it('refuses a test when the files changed on disk', async () => {
    const s = setup();
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    writeFileSync(join(v.dir, 'script.ts'), '// changed\n');
    const r = await s.service.test({ personaId: 'p1', versionId: v.versionId });
    expect(r._unsafeUnwrapErr().scriptCode).toBe('SCRIPT_FAILED');
    expect(s.createProvider).not.toHaveBeenCalled();
  });
});

describe('test outcomes', () => {
  it('leaves draft and runs no dry run when a unit case fails', async () => {
    const s = setup();
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const v = s.service
      .save({ personaId: 'p1', threadId: 'th1', files: files({ expectResult: { sent: 2 } }) })
      ._unsafeUnwrap();
    const r = (await s.service.test({ personaId: 'p1', versionId: v.versionId }))._unsafeUnwrap();
    expect(r.state).toBe('draft');
    expect(r.dryRun).toBeUndefined();
    expect(r.unit[0].passed).toBe(false);
    expect(s.providerCalls).toHaveLength(0);
    expect(
      s.db.prepare(`SELECT COUNT(*) AS n FROM script_runs WHERE mode = 'dry-run'`).get(),
    ).toEqual({ n: 0 });
    expect(s.providers[0].close).toHaveBeenCalledTimes(1);
  });

  it('leaves draft when the dry run did no work', async () => {
    const s = setup();
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    // the unit phase plays both calls, the dry run only the read
    let phase = 0;
    s.backend.setExecStreamHandler((c) => {
      const calls = phase++ === 0 ? SCRIPT_CALLS : [SCRIPT_CALLS[0]];
      let next = 0;
      c.onStdin(() => {
        if (next < calls.length) {
          c.emitStdout(line({ t: 'call', id: ++next, ...calls[next - 1] }));
        } else {
          c.emitStdout(line({ t: 'done', ok: true, result: { sent: 1 } }));
        }
      });
      return new Promise(() => {});
    });
    const r = (await s.service.test({ personaId: 'p1', versionId: v.versionId }))._unsafeUnwrap();
    expect(r.unit.every((u) => u.passed)).toBe(true);
    expect(r.dryRun?.didWork).toBe(false);
    expect(r.state).toBe('draft');
  });

  it('sends a tested version back to draft when a new test fails', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    s.db.prepare(`UPDATE script_versions SET state = 'tested' WHERE id = ?`).run(v.versionId);
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 9 } });
    const r = (await s.service.test({ personaId: 'p1', versionId: v.versionId }))._unsafeUnwrap();
    expect(r.state).toBe('draft');
  });

  it('fails a report over one million characters', async () => {
    const s = setup();
    const big = 'x'.repeat(300_000);
    let phase = 0;
    s.backend.setExecStreamHandler((c) => {
      const unit = phase++ === 0;
      let next = 0;
      c.onStdin(() => {
        if (unit && next < SCRIPT_CALLS.length) {
          c.emitStdout(line({ t: 'call', id: ++next, ...SCRIPT_CALLS[next - 1] }));
        } else if (!unit && next < 4) {
          c.emitStdout(line({ t: 'call', id: ++next, name: 'mail.send', input: { big } }));
        } else {
          c.emitStdout(line({ t: 'done', ok: true, result: unit ? { sent: 1 } : null }));
        }
      });
      return new Promise(() => {});
    });
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    const r = await s.service.test({ personaId: 'p1', versionId: v.versionId });
    expect(r._unsafeUnwrapErr().scriptCode).toBe('RESULT_TOO_LARGE');
    expect(s.stateOf(v.versionId)).toBe('draft');
  });
});

describe('approval', () => {
  it('rolls back to tested when send fails, and the code dies', async () => {
    let body = '';
    const s = setup({
      send: (_c, _t, b) => {
        body = b;
        return Promise.resolve(err(new ScriptError('TOOL_FAILED', 'x')));
      },
    });
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    await s.service.test({ personaId: 'p1', versionId: v.versionId });
    const r = await s.service.requestApproval({
      personaId: 'p1',
      versionId: v.versionId,
      channelName: 'tg',
      externalThreadId: 'chat-1',
    });
    const error = r._unsafeUnwrapErr();
    expect(error.scriptCode).toBe('TOOL_FAILED');
    const code = /\/approve ([A-Z0-9]{8})/.exec(body)![1];
    expect(error.message).not.toContain(code);
    expect(s.stateOf(v.versionId)).toBe('tested');
    expect(await s.service.handleInbound(s.event(`/approve ${code}`))).toBe(
      'This code is not valid.',
    );
    expect(s.stateOf(v.versionId)).toBe('tested');
  });

  it('refuses /approve from a different thread and keeps the state', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    const reply = await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`, 'other-chat'));
    expect(reply).toBe('This code is not valid.');
    expect(s.stateOf(v.versionId)).toBe('awaiting-approval');
    expect(s.audits.filter((a) => a.action === 'script.approval')).toHaveLength(0);
  });

  it('rejects with a fixed text and audits the decision', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    const reply = await s.service.handleInbound(s.event(`/reject ${s.codeOf()}`));
    expect(reply).toBe('Rejected: script "mail-intake" v1.');
    expect(s.stateOf(v.versionId)).toBe('rejected');
    expect(s.audits.find((a) => a.action === 'script.approval')).toMatchObject({
      personaId: 'p1',
      threadId: 'th1',
      details: { versionId: v.versionId, decision: 'rejected', channelName: 'tg' },
    });
  });

  it('ignores normal messages and never throws', async () => {
    const s = setup();
    expect(await s.service.handleInbound(s.event('hello'))).toBeUndefined();
    expect(await s.service.handleInbound(s.event(42))).toBeUndefined();
  });

  it('matchesInbound is true only for a valid command', () => {
    const s = setup();
    expect(s.service.matchesInbound(s.event('/approve ABCDEFGH'))).toBe(true);
    expect(s.service.matchesInbound(s.event('/reject abcdefgh'))).toBe(true);
    expect(s.service.matchesInbound(s.event('hello there'))).toBe(false);
    expect(s.service.matchesInbound(s.event(undefined))).toBe(false);
    expect(s.service.matchesInbound(s.event({ x: 1 }))).toBe(false);
  });
});

describe('runScheduled', () => {
  it('fails without an approved version', async () => {
    const s = setup();
    expect((await s.service.runScheduled(s.live))._unsafeUnwrapErr().scriptCode).toBe(
      'SCRIPT_FAILED',
    );
    const v = await s.toAwaiting();
    expect(s.stateOf(v.versionId)).toBe('awaiting-approval');
    expect((await s.service.runScheduled(s.live))._unsafeUnwrapErr().scriptCode).toBe(
      'SCRIPT_FAILED',
    );
  });

  it('refuses before any provider when a byte changed after approval', async () => {
    const s = setup();
    const { version } = await s.toApproved();
    s.createProvider.mockClear();
    writeFileSync(join(version.dir, 'script.ts'), '// tampered\n');
    const r = await s.service.runScheduled(s.live);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('SCRIPT_FAILED');
    expect(s.createProvider).not.toHaveBeenCalled();
    expect(s.audits.some((a) => a.action === 'script.run.refused')).toBe(true);
    const row = s.db
      .prepare(`SELECT ok, error_code, ended_at FROM script_runs WHERE trigger = 'schedule'`)
      .get();
    expect(row).toEqual({ ok: 0, error_code: 'SCRIPT_FAILED', ended_at: expect.any(Number) });
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
  });

  it('skips a second concurrent run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const s = setup();
    const { version } = await s.toApproved();
    void version;
    s.createProvider.mockImplementation(() => {
      const provider: RunProvider = {
        describe: (n) => (classes[n] ? { toolClass: classes[n] } : undefined),
        call: async () => {
          started = true;
          await gate;
          return ok({});
        },
        close: () => Promise.resolve(),
      };
      return Promise.resolve(ok(provider));
    });
    play(s.backend, SCRIPT_CALLS, { ok: true, result: 1 });
    const first = s.service.runScheduled(s.live);
    await vi.waitFor(() => expect(started).toBe(true));
    const second = await s.service.runScheduled(s.live);
    expect(second._unsafeUnwrap()).toBe('skipped');
    expect(s.audits.filter((a) => a.action === 'script.run.skipped')).toHaveLength(1);
    release();
    expect((await first)._unsafeUnwrap()).not.toBe('skipped');
    // the slot is free again
    play(s.backend, [], { ok: true, result: 1 });
    expect((await s.service.runScheduled(s.live))._unsafeUnwrap()).not.toBe('skipped');
  });

  it('closes the provider on success, script failure and an exception', async () => {
    const s = setup();
    await s.toApproved();
    s.providers.length = 0;
    play(s.backend, [], { ok: true, result: 1 });
    await s.service.runScheduled(s.live);
    play(s.backend, [], { ok: false, message: 'boom' });
    const failed = (await s.service.runScheduled(s.live))._unsafeUnwrap();
    expect(failed).toMatchObject({ ok: false, errorCode: 'SCRIPT_FAILED' });
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
    play(s.backend, [], { ok: true, result: 1 });
    vi.spyOn(s.repo, 'finishRun').mockImplementationOnce(() => {
      throw new Error('db exploded');
    });
    const thrown = await s.service.runScheduled(s.live);
    expect(thrown._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    expect(s.providers).toHaveLength(3);
    for (const p of s.providers) expect(p.close).toHaveBeenCalledTimes(1);
    // the active slot was released after the exception
    play(s.backend, [], { ok: true, result: 1 });
    expect((await s.service.runScheduled(s.live))._unsafeUnwrap()).not.toBe('skipped');
  });

  it('writes one run entry and one write entry per executed write, without input', async () => {
    const s = setup();
    await s.toApproved();
    s.audits.length = 0;
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    await s.service.runScheduled(s.live);
    const runs = s.audits.filter((a) => a.action === 'script.run');
    expect(runs).toHaveLength(1);
    expect(runs[0].details).toEqual({
      script: 'mail-intake',
      version: 1,
      mode: 'live',
      ok: true,
      errorCode: null,
      calls: 2,
    });
    const writes = s.audits.filter((a) => a.action === 'script.write');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ tool: 'mail.send', details: { outcome: 'executed' } });
    expect(JSON.stringify(writes)).not.toContain('"to"');
  });

  it('returns SANDBOX when the provider cannot be created', async () => {
    const s = setup();
    await s.toApproved();
    s.createProvider.mockImplementation(() =>
      Promise.resolve(err(new ScriptError('SANDBOX', 'x'))),
    );
    const r = await s.service.runScheduled(s.live);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
  });
});

describe('notifyFailure, recovery', () => {
  it('sends the fixed text and falls back to SCRIPT_FAILED for an unknown code', async () => {
    const s = setup();
    await s.service.notifyFailure({
      threadId: 't',
      scriptName: 'mail-intake',
      errorCode: 'TIMEOUT',
    });
    await s.service.notifyFailure({
      threadId: 't',
      scriptName: 'mail-intake',
      errorCode: 'weird <b>',
    });
    expect(s.notifyThread).toHaveBeenNthCalledWith(
      1,
      't',
      'Script "mail-intake" failed (TIMEOUT). It stays scheduled. I will tell you again only if it fails after a success.',
    );
    expect(s.notifyThread.mock.calls[1][1]).toContain('(SCRIPT_FAILED)');
  });

  it('never throws', async () => {
    const s = setup({ notifyThread: () => Promise.reject(new Error('x')) });
    await expect(
      s.service.notifyFailure({ threadId: 't', scriptName: 'a', errorCode: 'TIMEOUT' }),
    ).resolves.toBeUndefined();
  });

  it('recoverStaleRuns fails open runs', async () => {
    const s = setup();
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    s.repo.insertRun({
      id: 'r1',
      versionId: v.versionId,
      mode: 'live',
      trigger: 'schedule',
      startedAt: 1,
    });
    expect(s.service.recoverStaleRuns()._unsafeUnwrap()).toBe(1);
    expect(s.service.recoverStaleRuns()._unsafeUnwrap()).toBe(0);
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
  });
});
