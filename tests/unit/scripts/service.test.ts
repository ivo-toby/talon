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
import { createScriptService, ScriptNotRunError } from '../../../src/scripts/service.js';
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

function files(
  opts: {
    expectResult?: unknown;
    name?: string;
    extra?: string;
    inputSchema?: object;
    liveInput?: unknown;
  } = {},
): ScriptFile[] {
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
        liveInput: 'liveInput' in opts ? opts.liveInput : { live: true },
        ...(opts.inputSchema ? { inputSchema: opts.inputSchema } : {}),
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
  let codeSeed = 1;
  const now = (): number => (t += 1000);
  const store = createScriptStore({ root, repo, logger });
  const approval = createApprovalService({
    repo,
    ttlMinutes: 60,
    now,
    randomBytes: () => Buffer.from(Array.from({ length: 8 }, () => codeSeed++ % 32)),
    logger,
  })._unsafeUnwrap();
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
  const chats: Record<string, { channelName: string; externalThreadId: string }> = {
    th1: { channelName: 'tg', externalThreadId: 'chat-1' },
    th2: { channelName: 'tg', externalThreadId: 'other-chat' },
    sched: { channelName: 'tg', externalThreadId: 'sched-chat' },
  };
  const resolveChat = vi.fn((threadId: string) => chats[threadId]);
  const audits: Array<Record<string, unknown>> = [];
  const applyScheduleChange = vi.fn(
    (_input: Parameters<ScriptServiceDeps['applyScheduleChange']>[0]) =>
      ok({ scheduleId: 'sched-new' }) as ReturnType<ScriptServiceDeps['applyScheduleChange']>,
  );
  const deps: ScriptServiceDeps = {
    store,
    repo,
    approval,
    broker,
    config: ScriptsConfigSchema.parse({ runTimeoutMs: 5000, maxCallsPerRun: 50 }),
    createProvider,
    send,
    resolveChat,
    audit: (e) => audits.push(e),
    capabilities: () => ({ allow: ['script.run:*'], requireApproval: [] }),
    applyScheduleChange,
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
  async function toAwaiting(f: ScriptFile[] = files(), threadId = 'th1') {
    play(backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const version = service.save({ personaId: 'p1', threadId, files: f })._unsafeUnwrap();
    const tested = (
      await service.test({ personaId: 'p1', versionId: version.versionId })
    )._unsafeUnwrap();
    expect(tested.state).toBe('tested');
    (
      await service.requestApproval({
        personaId: 'p1',
        versionId: version.versionId,
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
    approval,
    repo,
    backend,
    db,
    store,
    root,
    sent,
    send,
    resolveChat,
    applyScheduleChange,
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
    expect(reply).toEqual({
      reply: 'Approved: script "mail-intake" v1. It can now run on a schedule.',
    });
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

describe('requestApproval repeats', () => {
  it('sends a message the first time and sends nothing the second time', async () => {
    const s = setup();
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    await s.service.test({ personaId: 'p1', versionId: v.versionId });
    const first = await s.service.requestApproval({ personaId: 'p1', versionId: v.versionId });
    expect(first._unsafeUnwrap()).toBe('sent');
    expect(s.sent).toHaveLength(1);
    const second = await s.service.requestApproval({ personaId: 'p1', versionId: v.versionId });
    expect(second._unsafeUnwrap()).toBe('already-sent');
    expect(s.sent).toHaveLength(1);
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
    });
    expect(draft._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    s.db.prepare(`UPDATE script_versions SET state = 'tested' WHERE id = ?`).run(v.versionId);
    const noReport = await s.service.requestApproval({
      personaId: 'p1',
      versionId: v.versionId,
    });
    expect(noReport._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    s.db
      .prepare(`UPDATE script_versions SET dry_run_report = '{nope' WHERE id = ?`)
      .run(v.versionId);
    const bad = await s.service.requestApproval({
      personaId: 'p1',
      versionId: v.versionId,
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
    });
    const error = r._unsafeUnwrapErr();
    expect(error.scriptCode).toBe('TOOL_FAILED');
    const code = /\/approve ([A-Z0-9]{8})/.exec(body)![1];
    expect(error.message).not.toContain(code);
    expect(s.stateOf(v.versionId)).toBe('tested');
    // the chat has no open approval any more, so nothing is claimed and nothing is decided
    expect(s.service.matchesInbound(s.event(`/approve ${code}`))).toBe(false);
    expect(await s.service.handleInbound(s.event(`/approve ${code}`))).toBeUndefined();
    expect(s.stateOf(v.versionId)).toBe('tested');
  });

  it('shows the manifest in the approval message', async () => {
    const s = setup();
    await s.toAwaiting();
    const body = s.sent[0].body;
    expect(body).toContain('May write with: mail.send\n');
    expect(body).toContain('The scheduled input differs from the dry-run input.');
    expect(body).not.toContain('May use the model');
    // the provider that described the tools is closed again
    expect(s.providers.at(-1)!.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a dry run whose writes do not fit, keeps tested and sends nothing', async () => {
    const s = setup();
    // Each line fits (about 550 characters), but ten of them do not fit in one message.
    const big = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, 'x'.repeat(100)]));
    let phase = 0;
    s.backend.setExecStreamHandler((c) => {
      const unit = phase++ === 0;
      let next = 0;
      c.onStdin(() => {
        if (unit && next < SCRIPT_CALLS.length) {
          c.emitStdout(line({ t: 'call', id: ++next, ...SCRIPT_CALLS[next - 1] }));
        } else if (!unit && next < 10) {
          c.emitStdout(line({ t: 'call', id: ++next, name: 'mail.send', input: big }));
        } else {
          c.emitStdout(line({ t: 'done', ok: true, result: { sent: 1 } }));
        }
      });
      return new Promise(() => {});
    });
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    expect(
      (await s.service.test({ personaId: 'p1', versionId: v.versionId }))._unsafeUnwrap().state,
    ).toBe('tested');
    const r = await s.service.requestApproval({
      personaId: 'p1',
      versionId: v.versionId,
    });
    expect(r._unsafeUnwrapErr().scriptCode).toBe('RESULT_TOO_LARGE');
    expect(r._unsafeUnwrapErr().message).toContain('do not fit in the approval message');
    expect(s.stateOf(v.versionId)).toBe('tested');
    expect(s.sent).toHaveLength(0);
    expect(s.db.prepare(`SELECT COUNT(*) AS n FROM script_approvals`).get()).toEqual({ n: 0 });
  });

  it('cancels a valid code sent as a command in a chat with no open approval', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    const code = s.codeOf();
    expect(s.service.matchesInbound(s.event(`approve ${code}`, 'thread-reply'))).toBe(false);
    expect(s.service.matchesInbound(s.event(`/approve ${code}`, 'thread-reply'))).toBe(true);
    expect(await s.service.handleInbound(s.event(`/approve ${code}`, 'thread-reply'))).toEqual({
      reply: 'This code belongs to another chat, so I cancelled it. Ask for a new approval.',
    });
    expect(s.stateOf(v.versionId)).toBe('tested');
    expect(s.audits.find((a) => a.action === 'script.approval.expired')).toMatchObject({
      personaId: 'p1',
      details: { versionId: v.versionId, reason: 'wrong-chat', channelName: 'tg' },
    });
    // the right chat no longer has the code: nothing is approved
    expect(await s.service.handleInbound(s.event(`/approve ${code}`))).toBeUndefined();
    expect(s.stateOf(v.versionId)).toBe('tested');
  });

  it('does not claim a cancel when the expire write fails, and the code stays guarded', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    const code = s.codeOf();
    s.repo.expireOpenApprovals = () => err(new Error('down') as never);
    const fallback = { reply: 'This code cannot be used here. Ask for a new approval.' };
    expect(await s.service.handleInbound(s.event(`approve ${code}`))).toEqual(fallback);
    expect(await s.service.handleInbound(s.event(`/approve ${code}`, 'thread-reply'))).toEqual(
      fallback,
    );
    expect(s.audits.some((a) => a.action === 'script.approval.expired')).toBe(false);
    expect(s.stateOf(v.versionId)).toBe('awaiting-approval');
    expect(s.service.matchesInbound(s.event(`approve ${code}`))).toBe(true);
  });

  it('counts malformed, leaked and wrong-chat messages toward the limiter', async () => {
    const s = setup();
    await s.toAwaiting();
    for (let i = 0; i < 5; i++) {
      expect((await s.service.handleInbound(s.event('/approve')))?.reply).toBe(
        'Use: /approve CODE or /reject CODE',
      );
    }
    // blocked: still consumed, no reply, and a leaked code is still cancelled
    expect(await s.service.handleInbound(s.event('/approve'))).toEqual({});
    const leaked = `approve ${s.codeOf()}`;
    expect(s.service.matchesInbound(s.event(leaked))).toBe(true);
    expect(await s.service.handleInbound(s.event(leaked))).toEqual({});
    expect(s.service.matchesInbound(s.event(leaked))).toBe(false);
  });

  it('refuses /approve with the code of another chat and keeps the state', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    const codeA = s.codeOf();
    await s.toAwaiting(files({ name: 'other-script' }), 'th2');
    const reply = await s.service.handleInbound(s.event(`/approve ${codeA}`, 'other-chat'));
    expect(reply).toEqual({ reply: 'This code is not valid.' });
    expect(s.stateOf(v.versionId)).toBe('awaiting-approval');
    expect(s.audits.filter((a) => a.action === 'script.approval')).toHaveLength(0);
  });

  it('accepts the command forms of the classifier', async () => {
    for (const form of [
      '/Approve CODE',
      '/approve@my_bot CODE',
      '  /approve CODE.  ',
      '/APPROVE code!',
    ]) {
      const s = setup();
      const v = await s.toAwaiting();
      const text = form.replace(/code/i, (m) =>
        m === 'code' ? s.codeOf().toLowerCase() : s.codeOf(),
      );
      expect(s.service.matchesInbound(s.event(text))).toBe(true);
      expect((await s.service.handleInbound(s.event(text)))?.reply).toMatch(/^Approved:/);
      expect(s.stateOf(v.versionId)).toBe('approved');
    }
  });

  it('cancels a code that came in a message that is not a command', async () => {
    for (const text of [
      (code: string) => `approve ${code}`,
      (code: string) =>
        `Re: your message\n${'> quoted line of the mail reply\n'.repeat(150)}> /approve ${code}\n> /reject ${code}\n`,
    ]) {
      const s = setup();
      const v = await s.toAwaiting();
      const code = s.codeOf();
      const message = text(code);
      expect(s.service.matchesInbound(s.event(message))).toBe(true);
      expect(await s.service.handleInbound(s.event(message))).toEqual({
        reply: 'The code was not in a valid command, so I cancelled it. Ask for a new approval.',
      });
      expect(s.stateOf(v.versionId)).toBe('tested');
      expect(s.audits.find((a) => a.action === 'script.approval.expired')).toMatchObject({
        personaId: 'p1',
        threadId: 'th1',
        details: { versionId: v.versionId, reason: 'leak', channelName: 'tg' },
      });
      // the old code is dead: with no open approval left, nothing is claimed
      expect(await s.service.handleInbound(s.event(`/approve ${code}`))).toBeUndefined();
      expect(s.stateOf(v.versionId)).toBe('tested');
    }
  });

  it('answers a malformed command with the usage text', async () => {
    const s = setup();
    await s.toAwaiting();
    for (const text of ['/approve', '/reject ABC', '/approve@my_bot please']) {
      expect(s.service.matchesInbound(s.event(text))).toBe(true);
      expect(await s.service.handleInbound(s.event(text))).toEqual({
        reply: 'Use: /approve CODE or /reject CODE',
      });
    }
    expect(s.service.matchesInbound(s.event('hello there'))).toBe(false);
  });

  it('consumes a command from a chat that the attempt limiter holds, without a reply', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    for (let i = 0; i < 5; i++) {
      expect(await s.service.handleInbound(s.event('/approve ZZZZZZZZ'))).toEqual({
        reply: 'This code is not valid.',
      });
    }
    expect(s.service.matchesInbound(s.event(`/approve ${s.codeOf()}`))).toBe(true);
    expect(await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`))).toEqual({});
    expect(s.stateOf(v.versionId)).toBe('awaiting-approval');
  });

  it('still says approved when the script row cannot be read after the decision', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    vi.spyOn(s.repo, 'getScript').mockImplementation(() => err(new Error('db down') as never));
    const reply = await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    expect(reply).toEqual({
      reply: 'Approved: script "mail-intake" v1. It can now run on a schedule.',
    });
    expect(s.stateOf(v.versionId)).toBe('approved');
  });

  it('rejects with a fixed text and audits the decision', async () => {
    const s = setup();
    const v = await s.toAwaiting();
    const reply = await s.service.handleInbound(s.event(`/reject ${s.codeOf()}`));
    expect(reply).toEqual({ reply: 'Rejected: script "mail-intake" v1.' });
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

  it('matchesInbound is false for every message in a chat with no open approval', () => {
    const s = setup();
    expect(s.service.matchesInbound(s.event('/approve ABCDEFGH'))).toBe(false);
    expect(s.service.matchesInbound(s.event('/reject abcdefgh'))).toBe(false);
    expect(s.service.matchesInbound(s.event('hello there'))).toBe(false);
    expect(s.service.matchesInbound(s.event(undefined))).toBe(false);
    expect(s.service.matchesInbound(s.event({ x: 1 }))).toBe(false);
  });
});

describe('runScheduled capability check', () => {
  it('does not start without the script.run capability', async () => {
    const s = setup({ capabilities: () => ({ allow: [], requireApproval: [] }) });
    const r = await s.service.runScheduled(s.live);
    expect(r._unsafeUnwrapErr()).toMatchObject({ reason: 'not-permitted' });
    expect(s.createProvider).not.toHaveBeenCalled();
    const refused = s.audits.filter((a) => a.action === 'script.run.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].details).toMatchObject({ reason: 'not-permitted' });
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
  });

  it('does not start when the persona is not loaded', async () => {
    const s = setup({ capabilities: () => undefined });
    expect((await s.service.runScheduled(s.live))._unsafeUnwrapErr()).toMatchObject({
      reason: 'not-permitted',
    });
    expect(s.createProvider).not.toHaveBeenCalled();
  });

  it('does not start for a label of another script', async () => {
    const s = setup({
      capabilities: () => ({ allow: ['script.run:other'], requireApproval: [] }),
    });
    expect((await s.service.runScheduled(s.live))._unsafeUnwrapErr()).toMatchObject({
      reason: 'not-permitted',
    });
  });

  it('runs without a question when the label is only in requireApproval', async () => {
    const s = setup({
      capabilities: () => ({ allow: [], requireApproval: ['script.run:mail-intake'] }),
    });
    await s.toApproved();
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const run = (await s.service.runScheduled(s.live))._unsafeUnwrap();
    expect(run).not.toBe('skipped');
    if (run === 'skipped') return;
    expect(run.ok).toBe(true);
  });

  it('tells the owner once why the run did not start', async () => {
    const s = setup();
    await s.service.notifyFailure({
      threadId: 'sched',
      scriptName: 'mail-intake',
      errorCode: 'SCRIPT_FAILED',
      reason: 'not-permitted',
    });
    expect(s.sent[0].body).toBe(
      'Script mail-intake did not run: the persona has no script.run capability for it.',
    );
  });
});

describe('runScheduled input', () => {
  const inputSchema = {
    type: 'object',
    properties: { quiet: { type: 'boolean' } },
  };

  it('does not start with an input that the script does not accept', async () => {
    const s = setup();
    await s.toApproved();
    s.createProvider.mockClear();
    const r = await s.service.runScheduled({ ...s.live, input: { quiet: true } });
    expect(r._unsafeUnwrapErr()).toMatchObject({ reason: 'bad-input' });
    expect(s.createProvider).not.toHaveBeenCalled();
    const refused = s.audits.filter((a) => a.action === 'script.run.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].details).toMatchObject({ reason: 'bad-input' });
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
  });

  it('does not start with an input that does not match the schema, and runs with one that does', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.createProvider.mockClear();
    const bad = await s.service.runScheduled({ ...s.live, input: { quiet: 'yes' } });
    expect(bad._unsafeUnwrapErr()).toMatchObject({ reason: 'bad-input' });
    expect(s.createProvider).not.toHaveBeenCalled();
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const good = (
      await s.service.runScheduled({ ...s.live, input: { quiet: true } })
    )._unsafeUnwrap();
    expect(good).not.toBe('skipped');
    expect(s.createProvider).toHaveBeenCalledTimes(1);
  });

  it('tells the owner once why the run did not start', async () => {
    const s = setup();
    await s.service.notifyFailure({
      threadId: 'sched',
      scriptName: 'mail-intake',
      errorCode: 'INVALID_ARGUMENT',
      reason: 'bad-input',
    });
    expect(s.sent[0].body).toBe(
      'Script mail-intake did not run: the input of the schedule does not match the script.',
    );
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
    const spy = vi.spyOn(s.repo, 'finishRun').mockImplementationOnce(() => {
      throw new Error('db exploded');
    });
    s.audits.length = 0;
    const survived = (await s.service.runScheduled(s.live))._unsafeUnwrap();
    expect(survived).not.toBe('skipped');
    spy.mockRestore();
    // the row was finished by the fallback, and the run was audited once
    const row = s.db
      .prepare(
        `SELECT ok, error_code, ended_at FROM script_runs WHERE trigger = 'schedule' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get();
    expect(row).toEqual({ ok: 0, error_code: 'SANDBOX', ended_at: expect.any(Number) });
    expect(s.audits.filter((a) => a.action === 'script.run')).toHaveLength(1);
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

describe('failure streaks and the memory thread', () => {
  /** What the scheduler does at one firing: read the state, run, notify on a new failure. */
  async function firing(s: ReturnType<typeof setup>, live: typeof s.live): Promise<void> {
    const failedBefore = s.service.lastScheduledRunFailed(live.personaId, live.scriptName);
    const result = await s.service.runScheduled(live);
    const failed = result.isErr() || (result.value !== 'skipped' && !result.value.ok);
    if (failed && !failedBefore) {
      const reason = result.isErr() ? (result.error as ScriptNotRunError).reason : undefined;
      await s.service.notifyFailure({
        threadId: live.threadId,
        scriptName: live.scriptName,
        errorCode: result.isErr() ? result.error.scriptCode : 'SCRIPT_FAILED',
        ...(reason ? { reason } : {}),
      });
    }
  }
  const sched = { personaId: 'p1', threadId: 'sched', scriptName: 'mail-intake', scheduleId: 's1' };

  it('sends one notice for five firings with no approved version', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) await firing(s, sched);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledWith(
      'tg',
      'sched-chat',
      'Script "mail-intake" did not run: it has no approved version.',
    );
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
    expect(s.service.lastScheduledRunFailed('p1', 'other')).toBe(false);
  });

  it('clears the flag on a success, so the next failure is told again', async () => {
    const s = setup();
    await firing(s, sched);
    await s.toApproved();
    s.send.mockClear();
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    await firing(s, sched);
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(false);
    expect(s.send).not.toHaveBeenCalled();
    play(s.backend, [], { ok: false, message: 'boom' });
    await firing(s, sched);
    await firing(s, sched);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0][2]).toContain('failed (SCRIPT_FAILED)');
  });

  it('names a change of the files after the approval', async () => {
    const s = setup();
    const { version } = await s.toApproved();
    s.send.mockClear();
    writeFileSync(join(version.dir, 'script.ts'), '// tampered\n');
    await firing(s, sched);
    await firing(s, sched);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0][2]).toBe(
      'Script "mail-intake" did not run: its files changed after the approval.',
    );
  });

  it('gives the dry run and the scheduled run the same memory thread', async () => {
    const s = setup();
    await s.toApproved();
    const dryThread = (s.createProvider.mock.calls[0][0] as { threadId: string }).threadId;
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    s.createProvider.mockClear();
    await s.service.runScheduled(sched);
    const liveThread = (s.createProvider.mock.calls[0][0] as { threadId: string }).threadId;
    expect(dryThread).toBe('th1');
    expect(liveThread).toBe(dryThread);
  });
});

describe('shutdown', () => {
  it('revokes the lease of an active run, waits for it and refuses new work', async () => {
    const s = setup();
    const v = await s.toApproved();
    void v;
    let started = false;
    s.backend.setExecStreamHandler(() => {
      started = true;
      return new Promise(() => {});
    });
    const running = s.service.runScheduled(s.live);
    await vi.waitFor(() => expect(started).toBe(true));
    expect(s.backend.liveContainers()).toHaveLength(1);
    await s.service.shutdown();
    expect(s.backend.liveContainers()).toEqual([]);
    const report = (await running)._unsafeUnwrap();
    expect(report).toMatchObject({ ok: false });
    const row = s.db
      .prepare(`SELECT ok, ended_at FROM script_runs WHERE trigger = 'schedule'`)
      .get() as { ok: number; ended_at: number };
    expect(row.ok).toBe(0);
    expect(row.ended_at).toBeGreaterThan(0);

    const later = await s.service.runScheduled(s.live);
    expect(later._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    const test = await s.service.test({ personaId: 'p1', versionId: 'x' });
    expect(test._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    const req = await s.service.requestApproval({ personaId: 'p1', versionId: 'x' });
    expect(req._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    await expect(s.service.shutdown()).resolves.toBeUndefined();
  });

  it('returns at once with nothing active', async () => {
    const s = setup();
    const started = Date.now();
    await s.service.shutdown();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('notifyFailure, recovery', () => {
  it('sends the fixed text to the chat of the thread and falls back to SCRIPT_FAILED', async () => {
    const s = setup();
    await s.service.notifyFailure({
      threadId: 'sched',
      scriptName: 'mail-intake',
      errorCode: 'TIMEOUT',
    });
    await s.service.notifyFailure({
      threadId: 'sched',
      scriptName: 'mail-intake',
      errorCode: 'weird <b>',
    });
    expect(s.send).toHaveBeenNthCalledWith(
      1,
      'tg',
      'sched-chat',
      'Script "mail-intake" failed (TIMEOUT). It stays scheduled. I will tell you again only if it fails after a success.',
    );
    expect(s.send.mock.calls[1][2]).toContain('(SCRIPT_FAILED)');
    // a thread with no chat sends nothing
    await s.service.notifyFailure({ threadId: 'gone', scriptName: 'a', errorCode: 'TIMEOUT' });
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it('never throws', async () => {
    const s = setup({ send: () => Promise.reject(new Error('x')) });
    await expect(
      s.service.notifyFailure({ threadId: 'sched', scriptName: 'a', errorCode: 'TIMEOUT' }),
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

describe('an exception in a live run', () => {
  it('finishes the row and audits the run when createProvider throws', async () => {
    const s = setup();
    await s.toApproved();
    s.audits.length = 0;
    s.createProvider.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const r = await s.service.runScheduled(s.live);
    expect(r._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
    const row = s.db
      .prepare(`SELECT ok, error_code, ended_at FROM script_runs WHERE trigger = 'schedule'`)
      .get();
    expect(row).toEqual({ ok: 0, error_code: 'SANDBOX', ended_at: expect.any(Number) });
    const runs = s.audits.filter((a) => a.action === 'script.run');
    expect(runs).toHaveLength(1);
    expect(runs[0].details).toMatchObject({ ok: false, errorCode: 'SANDBOX' });
  });

  it('audits a run that could not get a provider', async () => {
    const s = setup();
    await s.toApproved();
    s.audits.length = 0;
    s.createProvider.mockImplementationOnce(() =>
      Promise.resolve(err(new ScriptError('SANDBOX', 'x'))),
    );
    await s.service.runScheduled(s.live);
    expect(s.audits.find((a) => a.action === 'script.run')?.details).toMatchObject({
      ok: false,
      errorCode: 'SANDBOX',
    });
  });

  it('audits the writes before the row is finished, and one failing audit does not stop the rest', async () => {
    const order: string[] = [];
    let failFirst = true;
    const s = setup({
      audit: (e) => {
        order.push(String(e.action));
        if (e.action === 'script.write' && failFirst) {
          failFirst = false;
          throw new Error('audit down');
        }
      },
    });
    await s.toApproved();
    order.length = 0;
    const finish = s.repo.finishRun.bind(s.repo);
    vi.spyOn(s.repo, 'finishRun').mockImplementation((...a) => {
      order.push('finish');
      return finish(...a);
    });
    play(s.backend, [SCRIPT_CALLS[1], SCRIPT_CALLS[1]], { ok: true, result: 1 });
    await s.service.runScheduled(s.live);
    expect(order).toEqual(['script.write', 'script.write', 'finish', 'script.run']);
  });
});

describe('a test that overlaps other changes', () => {
  async function gatedTest() {
    const s = setup();
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    (await s.service.test({ personaId: 'p1', versionId: v.versionId }))._unsafeUnwrap();
    const before = s.repo.getVersion(v.versionId)._unsafeUnwrap()!.dry_run_report;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached = false;
    s.createProvider.mockImplementation(() =>
      Promise.resolve(
        ok({
          describe: (n: string) => (classes[n] ? { toolClass: classes[n] } : undefined),
          call: async () => {
            reached = true;
            await gate;
            return ok({ rows: 2 });
          },
          close: () => Promise.resolve(),
        } as RunProvider),
      ),
    );
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const running = s.service.test({ personaId: 'p1', versionId: v.versionId });
    await vi.waitFor(() => expect(reached).toBe(true));
    return { s, v, before, release, running };
  }

  it('does not touch a version that was approved during the test', async () => {
    const { s, v, before, release, running } = await gatedTest();
    s.db.prepare(`UPDATE script_versions SET state = 'approved' WHERE id = ?`).run(v.versionId);
    release();
    const r = await running;
    expect(r._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    expect(r._unsafeUnwrapErr().message).toContain('changed during the test');
    const row = s.repo.getVersion(v.versionId)._unsafeUnwrap()!;
    expect(row.state).toBe('approved');
    expect(row.dry_run_report).toBe(before);
  });

  it('refuses a second test and an approval request while one runs', async () => {
    const { s, v, release, running } = await gatedTest();
    const second = await s.service.test({ personaId: 'p1', versionId: v.versionId });
    expect(second._unsafeUnwrapErr().message).toContain('being tested');
    const req = await s.service.requestApproval({
      personaId: 'p1',
      versionId: v.versionId,
    });
    expect(req._unsafeUnwrapErr().message).toContain('being tested');
    expect(s.sent).toHaveLength(0);
    release();
    expect((await running).isOk()).toBe(true);
    // the version is free again
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    s.createProvider.mockImplementation(() =>
      Promise.resolve(
        ok({
          describe: (n: string) => (classes[n] ? { toolClass: classes[n] } : undefined),
          call: () => Promise.resolve(ok({})),
          close: () => Promise.resolve(),
        } as RunProvider),
      ),
    );
    expect((await s.service.test({ personaId: 'p1', versionId: v.versionId })).isOk()).toBe(true);
  });
});

describe('runByAgent', () => {
  const inputSchema = { type: 'object', properties: { quiet: { type: 'boolean' } } };
  const base = { personaId: 'p1', threadId: 'th1', scriptName: 'mail-intake' };
  const allowed = { ...base, access: 'allowed' as const };
  const approvalInput = { ...base, access: 'approval' as const };
  const agentRows = (s: ReturnType<typeof setup>): unknown[] =>
    s.db.prepare(`SELECT mode, ok, schedule_id FROM script_runs WHERE trigger = 'agent'`).all();
  const payloads = (s: ReturnType<typeof setup>): Array<string | null> =>
    (
      s.db
        .prepare(`SELECT payload FROM script_approvals WHERE purpose = 'run' ORDER BY created_at`)
        .all() as Array<{ payload: string | null }>
    ).map((r) => r.payload);

  it('runs at once with access allowed and records an agent row without a schedule', async () => {
    const s = setup();
    await s.toApproved();
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const report = (await s.service.runByAgent(allowed))._unsafeUnwrap();
    expect(report).not.toBe('awaiting-approval');
    expect(report).toMatchObject({ ok: true });
    expect(agentRows(s)).toEqual([{ mode: 'live', ok: 1, schedule_id: null }]);
    expect(s.audits.filter((a) => a.action === 'script.run')).toHaveLength(1);
    expect(s.sent).toHaveLength(1); // only the version approval message
  });

  it('fails without an approved version and while the script is running', async () => {
    const s = setup();
    expect((await s.service.runByAgent(allowed))._unsafeUnwrapErr()).toBeInstanceOf(
      ScriptNotRunError,
    );
    await s.toApproved();
    let started = false;
    s.backend.setExecStreamHandler(() => {
      started = true;
      return new Promise(() => {});
    });
    const running = s.service.runByAgent(allowed);
    await vi.waitFor(() => expect(started).toBe(true));
    const second = (await s.service.runByAgent(allowed))._unsafeUnwrapErr();
    expect(second).toMatchObject({ scriptCode: 'SCRIPT_FAILED' });
    expect(second.message).toContain('the script is already running');
    await s.service.shutdown();
    await running;
  });

  it('does not change the failed flag of scheduled runs', async () => {
    const s = setup();
    await s.toApproved();
    play(s.backend, SCRIPT_CALLS, { ok: false, message: 'boom' });
    const report = (await s.service.runByAgent(allowed))._unsafeUnwrap();
    expect(report).toMatchObject({ ok: false });
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(false);
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    await s.service.runScheduled(s.live);
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(false);
    play(s.backend, SCRIPT_CALLS, { ok: false, message: 'boom' });
    await s.service.runScheduled(s.live);
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    await s.service.runByAgent(allowed);
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(true);
  });

  it('refuses a bad input before a run row, a provider or an approval exists', async () => {
    const s = setup();
    await s.toApproved();
    s.createProvider.mockClear();
    const before = s.sent.length;
    for (const access of ['allowed', 'approval'] as const) {
      const r = await s.service.runByAgent({ ...base, access, input: { quiet: true } });
      expect(r._unsafeUnwrapErr()).toMatchObject({ scriptCode: 'INVALID_ARGUMENT' });
    }
    expect(s.createProvider).not.toHaveBeenCalled();
    expect(agentRows(s)).toEqual([]);
    expect(s.sent).toHaveLength(before);
    expect(payloads(s)).toEqual([]);
  });

  it('refuses an approval request without a chat', async () => {
    const s = setup();
    await s.toApproved();
    const r = await s.service.runByAgent({ ...approvalInput, threadId: 'nowhere' });
    const error = r._unsafeUnwrapErr();
    expect(error.scriptCode).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('this conversation has no chat for an approval');
  });

  it('sends the approval text and stores the payload, with and without an input', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.sent.length = 0;
    expect((await s.service.runByAgent(approvalInput))._unsafeUnwrap()).toBe('awaiting-approval');
    const code = s.codeOf();
    expect(s.sent[0].body).toBe(
      `The agent wants to run script mail-intake (version 1) now.\nInput: {"live":true} (default of the script)\n/approve ${code}\n/reject ${code}`,
    );
    expect(s.sent[0]).toMatchObject({ channel: 'tg', thread: 'chat-1' });
    const withInput = { ...approvalInput, input: { quiet: true } };
    expect((await s.service.runByAgent(withInput))._unsafeUnwrap()).toBe('awaiting-approval');
    expect(s.sent[1].body).toContain('Input: {"quiet":true}\n/approve');
    expect(payloads(s)).toEqual(['{}', '{"input":{"quiet":true}}']);
    // a different input expired the first approval
    expect(await s.service.handleInbound(s.event(`/approve ${code}`))).toEqual({
      reply: 'This code is not valid.',
    });
  });

  it('sends one message for two requests while the approval is open', async () => {
    const s = setup();
    await s.toApproved();
    s.sent.length = 0;
    expect((await s.service.runByAgent(approvalInput))._unsafeUnwrap()).toBe('awaiting-approval');
    expect((await s.service.runByAgent(approvalInput))._unsafeUnwrap()).toBe('awaiting-approval');
    expect(s.send).toHaveBeenCalledTimes(2); // one for the version, one for the run
    expect(s.sent).toHaveLength(1);
  });

  it('refuses a message that is too long and sends nothing', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema: { type: ['object', 'string'] } }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.sent.length = 0;
    const r = await s.service.runByAgent({ ...approvalInput, input: 'x'.repeat(3600) });
    expect(r._unsafeUnwrapErr()).toMatchObject({ scriptCode: 'RESULT_TOO_LARGE' });
    expect(s.sent).toHaveLength(0);
    expect(payloads(s)).toEqual([]);
  });

  it('expires the approval when the message cannot be sent', async () => {
    const s = setup();
    await s.toApproved();
    s.send.mockImplementationOnce((channel: string, thread: string, body: string) => {
      s.sent.push({ channel, thread, body });
      return Promise.resolve(err(new ScriptError('TOOL_FAILED', 'nope')));
    });
    const r = await s.service.runByAgent(approvalInput);
    expect(r._unsafeUnwrapErr()).toMatchObject({ scriptCode: 'TOOL_FAILED' });
    expect(payloads(s)).toHaveLength(1);
    const code = s.codeOf();
    s.createProvider.mockClear();
    await s.service.handleInbound(s.event(`/approve ${code}`));
    expect(s.createProvider).not.toHaveBeenCalled();
    expect(agentRows(s)).toEqual([]);
  });

  it('starts the run after /approve and tells the chat when it ends', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent(approvalInput);
    play(s.backend, SCRIPT_CALLS, { ok: true, result: { sent: 1 } });
    const reply = await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    expect(reply).toEqual({ reply: 'Script mail-intake started.' });
    await vi.waitFor(() =>
      expect(s.sent.at(-1)).toMatchObject({
        channel: 'tg',
        thread: 'chat-1',
        body: 'Script mail-intake finished.',
      }),
    );
    expect(agentRows(s)).toEqual([{ mode: 'live', ok: 1, schedule_id: null }]);
  });

  /** Records the input of each `start` message that a script receives. */
  function captureInputs(s: ReturnType<typeof setup>): unknown[] {
    const inputs: unknown[] = [];
    s.backend.setExecStreamHandler((c) => {
      c.onStdin((text) => {
        for (const part of text.split('\n').filter((l) => l !== '')) {
          const message = JSON.parse(part) as { t: string; input?: unknown };
          if (message.t === 'start') {
            inputs.push(message.input);
            c.emitStdout(line({ t: 'done', ok: true, result: 1 }));
          }
        }
      });
      return new Promise(() => {});
    });
    return inputs;
  }

  it('runs with the stored input after /approve', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    await s.service.runByAgent({ ...approvalInput, input: { quiet: true } });
    const inputs = captureInputs(s);
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    await vi.waitFor(() => expect(s.sent.at(-1)!.body).toBe('Script mail-intake finished.'));
    expect(inputs).toEqual([{ quiet: true }]);
  });

  it('runs with the liveInput of the manifest after /approve with no caller input', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent(approvalInput);
    const inputs = captureInputs(s);
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    await vi.waitFor(() => expect(s.sent.at(-1)!.body).toBe('Script mail-intake finished.'));
    expect(inputs).toEqual([{ live: true }]);
  });

  it('runs at once with the given input, or with the liveInput', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    const inputs = captureInputs(s);
    await s.service.runByAgent({ ...allowed, input: { quiet: true } });
    await s.service.runByAgent(allowed);
    expect(inputs).toEqual([{ quiet: true }, { live: true }]);
  });

  it('shows none when the script has no default input', async () => {
    const s = setup();
    await s.toAwaiting(files({ liveInput: null }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.sent.length = 0;
    await s.service.runByAgent(approvalInput);
    expect(s.sent[0].body).toContain('\nInput: none\n/approve');
    expect(payloads(s)).toEqual(['{}']);
  });

  it('counts the default input toward the message limit', async () => {
    const s = setup();
    await s.toAwaiting(files({ liveInput: 'y'.repeat(3600) }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.sent.length = 0;
    const r = await s.service.runByAgent(approvalInput);
    expect(r._unsafeUnwrapErr()).toMatchObject({ scriptCode: 'RESULT_TOO_LARGE' });
    expect(s.sent).toHaveLength(0);
  });

  it('makes a new request when the open approval belongs to another chat', async () => {
    const s = setup();
    await s.toApproved();
    s.sent.length = 0;
    await s.service.runByAgent({ ...approvalInput, threadId: 'th2' });
    await s.service.runByAgent(approvalInput);
    expect(s.sent.map((m) => m.thread)).toEqual(['other-chat', 'chat-1']);
    // the old approval of the other chat was expired by the new request
    expect(await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`))).toEqual({
      reply: 'Script mail-intake started.',
    });
  });

  it('keeps a schedule approval when the send of a run request fails', async () => {
    const s = setup();
    const { version } = await s.toApproved();
    const schedule = s.approval.request({
      versionId: version.versionId,
      channelName: 'tg',
      externalThreadId: 'chat-1',
      purpose: 'schedule',
      payload: '{}',
    });
    const scheduleCode = schedule._unsafeUnwrap().code;
    s.send.mockImplementationOnce(() => Promise.resolve(err(new ScriptError('TOOL_FAILED', 'x'))));
    expect((await s.service.runByAgent(approvalInput))._unsafeUnwrapErr()).toMatchObject({
      scriptCode: 'TOOL_FAILED',
    });
    const decided = s.approval.decide({
      code: scheduleCode,
      decision: 'approved',
      channelName: 'tg',
      externalThreadId: 'chat-1',
    });
    expect(decided._unsafeUnwrap().outcome).toBe('approved');
  });

  it('checks the stored input against the manifest again after /approve', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    await s.service.runByAgent({ ...approvalInput, input: { quiet: true } });
    s.db
      .prepare(`UPDATE script_approvals SET payload = ? WHERE purpose = 'run'`)
      .run('{"input":{"quiet":"yes"}}');
    s.createProvider.mockClear();
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    await vi.waitFor(() => expect(s.sent.at(-1)!.body).toContain('failed (INVALID_ARGUMENT)'));
    expect(s.createProvider).not.toHaveBeenCalled();
    expect(agentRows(s)).toEqual([]);
  });

  it('says a rejected run was not started', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent(approvalInput);
    const reply = await s.service.handleInbound(s.event(`/reject ${s.codeOf()}`));
    expect(reply).toEqual({ reply: 'Script mail-intake was not started.' });
    expect(agentRows(s)).toEqual([]);
  });

  it('refuses a run code when a newer version was approved through the chat', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent(approvalInput);
    const runCode = s.codeOf();
    await s.toAwaiting(files({ extra: 'v2' }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.createProvider.mockClear();
    // The old version is retired, so the database refuses its run code.
    expect(await s.service.handleInbound(s.event(`/approve ${runCode}`))).toEqual({
      reply: 'This code is not valid.',
    });
    expect(s.createProvider).not.toHaveBeenCalled();
    expect(agentRows(s)).toEqual([]);
  });

  it('refuses an approved run when a newer version is approved', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent(approvalInput);
    const runCode = s.codeOf();
    // The old version stays approved here, as in a race with another approval.
    const v2 = s.service
      .save({ personaId: 'p1', threadId: 'th1', files: files({ extra: 'v2' }) })
      ._unsafeUnwrap();
    s.db.prepare(`UPDATE script_versions SET state = 'approved' WHERE id = ?`).run(v2.versionId);
    s.createProvider.mockClear();
    const reply = await s.service.handleInbound(s.event(`/approve ${runCode}`));
    expect(reply).toEqual({ reply: 'Script mail-intake changed after this request. Ask again.' });
    expect(s.createProvider).not.toHaveBeenCalled();
    expect(agentRows(s)).toEqual([]);
  });

  it('sends the failure text when the approved run fails', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent(approvalInput);
    play(s.backend, SCRIPT_CALLS, { ok: false, message: 'boom' });
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    await vi.waitFor(() => expect(s.sent.at(-1)!.body).toContain('failed (SCRIPT_FAILED)'));
    expect(s.sent.at(-1)!.body).not.toContain('stays scheduled');
    expect(s.service.lastScheduledRunFailed('p1', 'mail-intake')).toBe(false);
  });

  it('waits for an approved background run at shutdown', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent(approvalInput);
    let started = false;
    s.backend.setExecStreamHandler(() => {
      started = true;
      return new Promise(() => {});
    });
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    await vi.waitFor(() => expect(started).toBe(true));
    await s.service.shutdown();
    expect(s.backend.liveContainers()).toEqual([]);
    const row = s.db
      .prepare(`SELECT ok, ended_at FROM script_runs WHERE trigger = 'agent'`)
      .get() as {
      ok: number;
      ended_at: number | null;
    };
    expect(row.ended_at).toBeGreaterThan(0);
  });

  it('cancels a leaked run code with a text about the run, and never logs a code', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent(approvalInput);
    const code = s.codeOf();
    const reply = await s.service.handleInbound(s.event(`here: ${code}`));
    expect(reply?.reply).toBe(
      'The run request of script mail-intake was cancelled and must be asked again.',
    );
    expect(JSON.stringify(s.audits)).not.toContain(code);
  });
});

describe('list', () => {
  it('lists the scripts of the persona with latest, approved version and last live run', async () => {
    const s = setup();
    const { version } = await s.toApproved();
    s.service
      .save({ personaId: 'p1', threadId: 'th1', files: files({ extra: 'v2' }) })
      ._unsafeUnwrap();
    s.service
      .save({
        personaId: 'p1',
        threadId: 'th1',
        files: files({ name: 'other-script' }),
      })
      ._unsafeUnwrap();
    s.service
      .save({
        personaId: 'p2',
        threadId: 'th2',
        files: files({ name: 'not-mine' }),
      })
      ._unsafeUnwrap();

    const list = s.service.list('p1')._unsafeUnwrap();
    expect(list.map((i) => i.name)).toEqual(['mail-intake', 'other-script']);
    const intake = list[0];
    expect(intake.latest).toMatchObject({ version: 2, state: 'draft' });
    expect(intake.latest.versionId).not.toBe(version.versionId);
    expect(intake.approvedVersion).toBe(1);
    expect(intake.lastRun).toBeUndefined();
    expect(list[1].approvedVersion).toBeUndefined();
    expect(s.service.list('nobody')._unsafeUnwrap()).toEqual([]);
  });

  it('takes lastRun from the newest finished live run of any version and ignores tests', async () => {
    const s = setup();
    const { version } = await s.toApproved();
    const run = (
      trigger: 'test' | 'dry-run' | 'schedule' | 'agent',
      at: number,
      okRun?: boolean,
      code?: string,
    ) => {
      const id = `run-${trigger}-${at}`;
      s.repo
        .insertRun({
          id,
          versionId: version.versionId,
          mode: 'live',
          trigger,
          scheduleId: null,
          startedAt: at,
        })
        ._unsafeUnwrap();
      if (okRun !== undefined) s.repo.finishRun(id, okRun, code ?? null, 1, at + 5)._unsafeUnwrap();
    };
    run('schedule', 9_000_000_000_000, true);
    run('agent', 9_000_000_000_100, false, 'SCRIPT_FAILED');
    run('test', 9_000_000_000_200, true);
    run('dry-run', 9_000_000_000_300, true);
    run('agent', 9_000_000_000_400); // still open
    const last = s.service.list('p1')._unsafeUnwrap()[0].lastRun;
    expect(last).toEqual({
      ok: false,
      errorCode: 'SCRIPT_FAILED',
      endedAt: 9_000_000_000_105,
      trigger: 'agent',
    });
  });

  it('returns SANDBOX when the database fails', () => {
    const s = setup();
    vi.spyOn(s.repo, 'listScripts').mockReturnValue(err(new Error('db') as never));
    const e = s.service.list('p1')._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('SANDBOX');
  });
});

describe('show', () => {
  it('returns the newest version with its files, or the version asked for', async () => {
    const s = setup();
    const v1 = s.service
      .save({ personaId: 'p1', threadId: 'th1', files: files() })!
      ._unsafeUnwrap();
    const v2 = s.service
      .save({ personaId: 'p1', threadId: 'th1', files: files({ extra: 'second' }) })
      ._unsafeUnwrap();
    const newest = s.service.show({ personaId: 'p1', scriptName: 'mail-intake' })._unsafeUnwrap();
    expect(newest.info).toEqual({
      name: 'mail-intake',
      version: 2,
      state: 'draft',
      versionId: v2.versionId,
      contentHash: v2.contentHash,
    });
    expect(newest.files.find((f) => f.path === 'script.ts')?.content).toBe('// second\n');
    const first = s.service
      .show({ personaId: 'p1', scriptName: 'mail-intake', version: 1 })
      ._unsafeUnwrap();
    expect(first.info.versionId).toBe(v1.versionId);
    expect(first.files.find((f) => f.path === 'script.ts')?.content).toBe('// v\n');
  });

  it('gives one error for an unknown name, another persona and an unknown version', async () => {
    const s = setup();
    s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    const errors = [
      s.service.show({ personaId: 'p1', scriptName: 'nope' }),
      s.service.show({ personaId: 'p2', scriptName: 'mail-intake' }),
      s.service.show({ personaId: 'p1', scriptName: 'mail-intake', version: 9 }),
      s.service.show({ personaId: 'p1', scriptName: 'mail-intake', version: 0 }),
    ].map((r) => r._unsafeUnwrapErr());
    for (const e of errors) {
      expect(e.scriptCode).toBe('INVALID_ARGUMENT');
      expect(e.message).toBe('script: [INVALID_ARGUMENT] unknown script');
    }
  });

  it('fails with the verify error when the files changed, and leaks no content or path', async () => {
    const s = setup();
    const v = s.service.save({ personaId: 'p1', threadId: 'th1', files: files() })._unsafeUnwrap();
    writeFileSync(join(v.dir, 'script.ts'), 'SECRET-CHANGED');
    const e = s.service.show({ personaId: 'p1', scriptName: 'mail-intake' })._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('SCRIPT_FAILED');
    expect(e.message).not.toContain('SECRET');
    expect(e.message).not.toContain(s.root);
  });
});

describe('listTools', () => {
  function toolProvider(
    tools: Array<{ name: string; toolClass: ToolClass; description?: string }>,
    schemas: Record<string, unknown> = {},
  ) {
    const close = vi.fn(() => Promise.resolve());
    const provider = {
      describe: () => undefined,
      call: () => Promise.resolve(ok(null)),
      list: () => tools,
      inputSchema: (name: string) => schemas[name],
      close,
    } as unknown as RunProvider;
    return { provider, close };
  }
  const withProvider = (p: ReturnType<typeof toolProvider>) =>
    setup({ createProvider: vi.fn(() => Promise.resolve(ok(p.provider))) });
  const ask = { personaId: 'p1', threadId: 'th1' };

  it('opens a provider with allServers and an empty manifest, sorts, and closes it', async () => {
    const p = toolProvider([
      { name: 'talon.memory_read', toolClass: 'read', description: 'Reads' },
      { name: 'crm.find', toolClass: 'read', description: 'Finds' },
      { name: 'model.judge', toolClass: 'model' },
    ]);
    const createProvider = vi.fn(() => Promise.resolve(ok(p.provider)));
    const s = setup({ createProvider });
    const list = (await s.service.listTools(ask))._unsafeUnwrap();
    expect(list.map((t) => t.name)).toEqual(['crm.find', 'model.judge', 'talon.memory_read']);
    const [context, manifest, options] = createProvider.mock.calls[0] as unknown as [
      { personaId: string; threadId: string },
      { tools: string[] },
      { allServers?: boolean },
    ];
    expect(context).toMatchObject({ personaId: 'p1', threadId: 'th1' });
    expect(manifest.tools).toEqual([]);
    expect(options).toEqual({ allServers: true });
    expect(p.close).toHaveBeenCalledTimes(1);
  });

  it('has no model.judge when the persona has no judge', async () => {
    const p = toolProvider([{ name: 'talon.memory_read', toolClass: 'read' }]);
    const s = withProvider(p);
    const list = (await s.service.listTools(ask))._unsafeUnwrap();
    expect(list.map((t) => t.name)).not.toContain('model.judge');
  });

  it('gives no schema without a name and one entry with a schema for a name', async () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    const p = toolProvider(
      [
        { name: 'crm.find', toolClass: 'read' },
        { name: 'crm.update', toolClass: 'write' },
      ],
      { 'crm.find': schema, 'crm.update': { type: 'object' } },
    );
    const s = withProvider(p);
    const all = (await s.service.listTools(ask))._unsafeUnwrap();
    for (const tool of all) expect(tool).not.toHaveProperty('inputSchema');
    const one = (await s.service.listTools({ ...ask, name: 'crm.find' }))._unsafeUnwrap();
    expect(one).toEqual([{ name: 'crm.find', toolClass: 'read', inputSchema: schema }]);
    expect(p.close).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown tool name without echoing it', async () => {
    const p = toolProvider([{ name: 'crm.find', toolClass: 'read' }]);
    const s = withProvider(p);
    const e = (await s.service.listTools({ ...ask, name: 'zzz-secret.tool' }))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('INVALID_ARGUMENT');
    expect(e.message).not.toContain('zzz-secret');
    expect(p.close).toHaveBeenCalledTimes(1);
  });

  it('cuts a description to 200 characters after removing control characters', async () => {
    const hostile = `a\u0000b\u001b[31m${'x'.repeat(300)}\nline\u007f`;
    const p = toolProvider([
      { name: 'crm.find', toolClass: 'read', description: hostile },
      { name: 'crm.blank', toolClass: 'read', description: '\u0000\u0001' },
    ]);
    const list = (await withProvider(p).service.listTools(ask))._unsafeUnwrap();
    const find = list.find((t) => t.name === 'crm.find')!;
    // eslint-disable-next-line no-control-regex
    expect(find.description).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(find.description!.length).toBe(200);
    expect(find.description!.startsWith('ab[31m')).toBe(true);
    expect(list.find((t) => t.name === 'crm.blank')).not.toHaveProperty('description');
  });

  it('fails with the TOOL_FAILED error of the factory and names no server detail', async () => {
    const createProvider = vi.fn(() =>
      Promise.resolve(err(new ScriptError('TOOL_FAILED', 'the MCP servers could not be reached'))),
    );
    const s = setup({ createProvider });
    const e = (await s.service.listTools(ask))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('TOOL_FAILED');
    expect(e.message).toBe('script: [TOOL_FAILED] the MCP servers could not be reached');
  });

  it('closes the provider and returns SANDBOX when list throws', async () => {
    const p = toolProvider([]);
    (p.provider as { list: () => never }).list = () => {
      throw new Error('boom with /secret/path');
    };
    const e = (await withProvider(p).service.listTools(ask))._unsafeUnwrapErr();
    expect(e.scriptCode).toBe('SANDBOX');
    expect(e.message).not.toContain('secret');
    expect(p.close).toHaveBeenCalledTimes(1);
  });

  it('is tracked: shutdown waits for it, and a closed service refuses it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = toolProvider([{ name: 'crm.find', toolClass: 'read' }]);
    const createProvider = vi.fn(async () => {
      await gate;
      return ok(p.provider);
    });
    const s = setup({ createProvider });
    const pending = s.service.listTools(ask);
    let down = false;
    const shutdown = s.service.shutdown().then(() => (down = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(down).toBe(false);
    release();
    expect((await pending).isOk()).toBe(true);
    await shutdown;
    expect(p.close).toHaveBeenCalledTimes(1);
    const after = (await s.service.listTools(ask))._unsafeUnwrapErr();
    expect(after.scriptCode).toBe('SANDBOX');
  });
});

describe('requestScheduleChange', () => {
  const inputSchema = { type: 'object', properties: { quiet: { type: 'boolean' } } };
  const base = { personaId: 'p1', threadId: 'th1', scriptName: 'mail-intake' };
  const create = (extra: Record<string, unknown> = {}) => ({
    ...base,
    change: { action: 'create' as const, cronExpr: '0 9 * * 1', label: 'Mail', ...extra },
  });
  const payloads = (s: ReturnType<typeof setup>): Array<string | null> =>
    (
      s.db
        .prepare(
          `SELECT payload FROM script_approvals WHERE purpose = 'schedule' ORDER BY created_at`,
        )
        .all() as Array<{ payload: string | null }>
    ).map((r) => r.payload);

  it('sends the approval text and stores the payload', async () => {
    const s = setup();
    await s.toApproved();
    s.sent.length = 0;
    expect((await s.service.requestScheduleChange(create()))._unsafeUnwrap()).toBe(
      'awaiting-approval',
    );
    const code = s.codeOf();
    expect(s.sent[0]).toMatchObject({ channel: 'tg', thread: 'chat-1' });
    expect(s.sent[0].body).toBe(
      `The agent wants to run script mail-intake on this schedule: 0 9 * * 1 (Mail).\nInput: {"live":true} (default of the script)\n/approve ${code}\n/reject ${code}`,
    );
    expect(payloads(s)).toEqual([
      '{"threadId":"th1","scriptName":"mail-intake","change":{"action":"create","cronExpr":"0 9 * * 1","label":"Mail"}}',
    ]);
  });

  it('shows the given input, and none when the script has no default', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.sent.length = 0;
    await s.service.requestScheduleChange(create({ input: { quiet: true } }));
    expect(s.sent[0].body).toContain('\nInput: {"quiet":true}\n/approve');
    expect(payloads(s)[0]).toContain('"input":{"quiet":true}');
    const none = setup();
    await none.toAwaiting(files({ liveInput: null }));
    await none.service.handleInbound(none.event(`/approve ${none.codeOf()}`));
    none.sent.length = 0;
    await none.service.requestScheduleChange(create());
    expect(none.sent[0].body).toContain('\nInput: none\n/approve');
    expect(payloads(none)).toHaveLength(1);
  });

  it('keeps the difference between no input and an input of null', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema: {} }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    await s.service.requestScheduleChange(create({ input: null }));
    expect(payloads(s)[0]).toContain('"input":null');
    expect(s.sent.at(-1)!.body).toContain('\nInput: null\n/approve');
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    expect(s.applyScheduleChange.mock.calls[0][0].change).toHaveProperty('input', null);
    await s.service.requestScheduleChange(create());
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    expect(s.applyScheduleChange.mock.calls[1][0].change).not.toHaveProperty('input');
  });

  it('checks the input against the manifest before anything is sent', async () => {
    const s = setup();
    await s.toAwaiting(files({ inputSchema }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.sent.length = 0;
    const r = await s.service.requestScheduleChange(create({ input: { quiet: 'yes' } }));
    expect(r.isErr()).toBe(true);
    expect(s.sent).toHaveLength(0);
    expect(payloads(s)).toEqual([]);
  });

  it('shows a label on one line and refuses a cron expression that cleaning would change', async () => {
    const s = setup();
    await s.toApproved();
    s.sent.length = 0;
    await s.service.requestScheduleChange(
      create({ label: 'Mail\n/approve ZZZZZZZZ\u202e' + 'x'.repeat(300) }),
    );
    const [first, ...rest] = s.sent[0].body.split('\n');
    expect(
      first.startsWith(
        'The agent wants to run script mail-intake on this schedule: 0 9 * * 1 (Mail /approve ZZZZZZZZ',
      ),
    ).toBe(true);
    expect(first.length).toBeLessThan(400);
    expect(rest).toHaveLength(3);
    expect(rest[1]).toMatch(/^\/approve [A-Z0-9]{8}$/);
    expect(rest[2]).toBe(rest[1].replace('/approve', '/reject'));
    s.sent.length = 0;
    for (const cronExpr of ['0 9 * * 1\n/approve AAAAAAAA', 'x'.repeat(101)]) {
      const r = await s.service.requestScheduleChange(create({ cronExpr }));
      expect(r._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    }
    expect(s.sent).toHaveLength(0);
  });

  it('refuses a request that does not fit in the message', async () => {
    const s = setup();
    await s.toAwaiting(files({ liveInput: 'y'.repeat(3600) }));
    await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
    s.sent.length = 0;
    const r = await s.service.requestScheduleChange(create());
    expect(r._unsafeUnwrapErr()).toMatchObject({ scriptCode: 'RESULT_TOO_LARGE' });
    expect(s.sent).toHaveLength(0);
  });

  it('refuses without an approved version and without a chat', async () => {
    const s = setup();
    expect((await s.service.requestScheduleChange(create()))._unsafeUnwrapErr()).toBeInstanceOf(
      ScriptNotRunError,
    );
    await s.toApproved();
    const r = await s.service.requestScheduleChange({ ...create(), threadId: 'nowhere' });
    expect(r._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
  });

  it('sends nothing for the same open request, and replaces it for a different one', async () => {
    const s = setup();
    await s.toApproved();
    s.sent.length = 0;
    await s.service.requestScheduleChange(create());
    const firstCode = s.codeOf();
    expect((await s.service.requestScheduleChange(create()))._unsafeUnwrap()).toBe(
      'awaiting-approval',
    );
    expect(s.sent).toHaveLength(1);
    await s.service.requestScheduleChange(create({ cronExpr: '0 10 * * 1' }));
    expect(s.sent).toHaveLength(2);
    expect(await s.service.handleInbound(s.event(`/approve ${firstCode}`))).toEqual({
      reply: 'This code is not valid.',
    });
    // another chat is another request
    await s.service.requestScheduleChange({ ...create(), threadId: 'th2' });
    expect(s.sent.map((m) => m.thread)).toEqual(['chat-1', 'chat-1', 'other-chat']);
  });

  it('rolls the approval back when the send fails, and keeps a run approval', async () => {
    const s = setup();
    await s.toApproved();
    await s.service.runByAgent({ ...base, access: 'approval' });
    const runCode = s.codeOf();
    s.send.mockImplementationOnce(() => Promise.resolve(err(new ScriptError('TOOL_FAILED', 'x'))));
    const r = await s.service.requestScheduleChange(create());
    expect(r._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
    expect(
      s.db
        .prepare(
          `SELECT COUNT(*) AS n FROM script_approvals WHERE purpose = 'schedule' AND decided_at IS NULL AND expires_at > ?`,
        )
        .get(Date.now() + 1e9),
    ).toEqual({ n: 0 });
    expect(
      s.approval
        .decide({
          code: runCode,
          decision: 'approved',
          channelName: 'tg',
          externalThreadId: 'chat-1',
        })
        ._unsafeUnwrap().outcome,
    ).toBe('approved');
  });

  describe('decision', () => {
    async function pending(change: Record<string, unknown> = {}) {
      const s = setup();
      await s.toAwaiting(files({ inputSchema }));
      await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
      await s.service.requestScheduleChange(create(change));
      return s;
    }

    it('applies the stored change on /approve', async () => {
      const s = await pending({ input: { quiet: true } });
      const reply = await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`));
      expect(reply).toEqual({ reply: 'Schedule for script mail-intake saved.' });
      expect(s.applyScheduleChange).toHaveBeenCalledWith({
        personaId: 'p1',
        threadId: 'th1',
        scriptName: 'mail-intake',
        change: { action: 'create', cronExpr: '0 9 * * 1', label: 'Mail', input: { quiet: true } },
      });
    });

    it('says the schedule was not saved when the write fails or throws', async () => {
      const s = await pending();
      s.applyScheduleChange.mockImplementationOnce(() => err(new ScriptError('TOOL_FAILED', 'x')));
      expect(await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`))).toEqual({
        reply: 'The schedule for script mail-intake was not saved.',
      });
      await s.service.requestScheduleChange(create());
      s.applyScheduleChange.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      expect(await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`))).toEqual({
        reply: 'The schedule for script mail-intake was not saved.',
      });
    });

    it.each([
      'not json',
      '[]',
      '{}',
      '{"threadId":"th1","scriptName":"mail-intake","change":{"action":"drop"}}',
    ])('does not save a payload that is wrong: %s', async (payload) => {
      const s = await pending();
      s.db
        .prepare(`UPDATE script_approvals SET payload = ? WHERE purpose = 'schedule'`)
        .run(payload);
      expect(await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`))).toEqual({
        reply: 'The schedule for script mail-intake was not saved.',
      });
      expect(s.applyScheduleChange).not.toHaveBeenCalled();
    });

    it('checks a stored input against the manifest again', async () => {
      const s = await pending({ input: { quiet: true } });
      s.db
        .prepare(`UPDATE script_approvals SET payload = ? WHERE purpose = 'schedule'`)
        .run(
          '{"threadId":"th1","scriptName":"mail-intake","change":{"action":"create","cronExpr":"0 9 * * 1","input":{"quiet":"yes"}}}',
        );
      expect(await s.service.handleInbound(s.event(`/approve ${s.codeOf()}`))).toEqual({
        reply: 'The schedule for script mail-intake was not saved.',
      });
      expect(s.applyScheduleChange).not.toHaveBeenCalled();
    });

    it('says the schedule was not changed on /reject', async () => {
      const s = await pending();
      expect(await s.service.handleInbound(s.event(`/reject ${s.codeOf()}`))).toEqual({
        reply: 'The schedule was not changed.',
      });
      expect(s.applyScheduleChange).not.toHaveBeenCalled();
    });

    it('refuses when a newer version is approved in between', async () => {
      const s = await pending();
      const code = s.codeOf();
      // The old version stays approved here, as in a race with another approval.
      const v2 = s.service
        .save({ personaId: 'p1', threadId: 'th1', files: files({ inputSchema, extra: 'v2' }) })
        ._unsafeUnwrap();
      s.db.prepare(`UPDATE script_versions SET state = 'approved' WHERE id = ?`).run(v2.versionId);
      expect(await s.service.handleInbound(s.event(`/approve ${code}`))).toEqual({
        reply: 'Script mail-intake changed after this request. Ask again.',
      });
      expect(s.applyScheduleChange).not.toHaveBeenCalled();
    });

    it('cancels a leaked schedule code with its own text', async () => {
      const s = await pending();
      const reply = await s.service.handleInbound(s.event(`here: ${s.codeOf()}`));
      expect(reply?.reply).toBe(
        'The schedule request of script mail-intake was cancelled and must be asked again.',
      );
    });
  });
});
