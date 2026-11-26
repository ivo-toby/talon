import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'neverthrow';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboundEvent } from '../../src/channels/channel-types.js';
import { ScriptsConfigSchema } from '../../src/core/config/config-schema.js';
import { ChannelRepository } from '../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../src/core/database/repositories/persona-repository.js';
import { ScheduleRepository } from '../../src/core/database/repositories/schedule-repository.js';
import { ThreadRepository } from '../../src/core/database/repositories/thread-repository.js';
import { ScriptRepository } from '../../src/core/database/repositories/script-repository.js';
import {
  buildScriptBroker,
  createApprovalService,
  createScriptService,
  createScriptStore,
  installScriptSdk,
} from '../../src/scripts/index.js';
import { ScriptError } from '../../src/scripts/index.js';
import type {
  RunProvider,
  ScriptFile,
  ScriptRunReport,
  ScriptService,
} from '../../src/scripts/index.js';
import { ScheduleManageHandler } from '../../src/tools/host-tools/schedule-manage.js';
import { ScriptManageHandler } from '../../src/tools/host-tools/script-manage.js';
import { ScriptRunHandler } from '../../src/tools/host-tools/script-run.js';
import type { ToolCallResult } from '../../src/tools/tool-types.js';
import type { ResolvedCapabilities } from '../../src/personas/persona-types.js';
import { createTestDb } from '../unit/core/database/repositories/helpers.js';

const TEST_APPROVAL_KEY = Buffer.alloc(32, 7);

/**
 * Real-Docker run of the full script flow: save, unit cases, dry run, approval
 * message, `/approve` from the chat, and a scheduled run in `live` mode. Then
 * the same flow through the agent tools (`script_manage`, `script_run`,
 * `schedule_manage`) for a persona that can run scripts freely and for one that
 * holds `script.run` under `requireApproval`. The database, the store, the
 * approval service, the broker and the tool handlers are real. Only the tools
 * that a script calls are fake. Skipped unless TALON_SCRIPT_IT_IMAGE names a digest-pinned
 * Node.js (22.18 or later) image that already exists locally.
 *
 *   TALON_SCRIPT_IT_IMAGE='node@sha256:<64 hex>' npx vitest run tests/integration/script-flow-docker.test.ts
 */
const IMAGE = process.env.TALON_SCRIPT_IT_IMAGE ?? '';
const SOCKET = process.env.TALON_DOCKER_SOCKET ?? '/var/run/docker.sock';
const enabled = IMAGE !== '' && existsSync(SOCKET);

const PERSONA = 'assistant';
const CHANNEL = 'my-telegram';
const CHAT = 'chat-1';
/** Can run scripts with no question. */
const FREE = 'free';
/** Holds `script.run` under `requireApproval`: the user decides each agent run and each schedule. */
const GUARDED = 'guarded';
const CAPABILITIES: Record<string, ResolvedCapabilities> = {
  [PERSONA]: { allow: ['script.run:*'], requireApproval: [] },
  [FREE]: {
    allow: ['script.manage:own', 'schedule.manage:own', 'script.run:*'],
    requireApproval: [],
  },
  [GUARDED]: {
    allow: ['script.manage:own', 'schedule.manage:own'],
    requireApproval: ['script.run:*'],
  },
};

function containerIds(hostPath: string): string[] {
  return execFileSync('docker', ['ps', '-aq', '--no-trunc', '--filter', `volume=${hostPath}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

const SCRIPT = `
import { tools } from 'talon';
interface Mail { id: number; subject: string }
export default async function (input: { limit: number }): Promise<unknown> {
  const mails = (await tools.mailbox.list({ limit: input.limit })) as Mail[];
  let filed = 0;
  for (const mail of mails) {
    if (mail.subject.startsWith('Invoice')) {
      await tools.mailbox.label({ id: mail.id, label: 'finance' });
      filed += 1;
    }
  }
  return { seen: mails.length, filed };
}
`;

function scriptFiles(): ScriptFile[] {
  return [
    { path: 'script.ts', content: SCRIPT },
    {
      path: 'manifest.json',
      content: JSON.stringify({
        name: 'mail-intake',
        description: 'Labels invoice mails as finance.',
        tools: ['mailbox.list', 'mailbox.label'],
        channels: [],
        dryRunInput: { limit: 5 },
        liveInput: { limit: 5 },
      }),
    },
    {
      path: 'tests.json',
      content: JSON.stringify({
        cases: [
          {
            name: 'labels only invoices',
            input: { limit: 2 },
            stubs: {
              'mailbox.list': [
                [
                  { id: 7, subject: 'Invoice 12' },
                  { id: 8, subject: 'Hello' },
                ],
              ],
              'mailbox.label': [{ done: true }],
            },
            expect: {
              result: { seen: 2, filed: 1 },
              writes: [{ name: 'mailbox.label', input: { id: 7, label: 'finance' } }],
            },
          },
        ],
      }),
    },
  ];
}

const FLAGGER = `
import { tools } from 'talon';
export default async function (input: { quiet: boolean }): Promise<unknown> {
  await tools.mailbox.list({ limit: 1 });
  if (!input.quiet) {
    await tools.mailbox.label({ id: 1, label: 'seen' });
  }
  return { quiet: input.quiet };
}
`;

/** A script with a declared input: one boolean that selects a mode. */
function flaggerFiles(): ScriptFile[] {
  return [
    { path: 'script.ts', content: FLAGGER },
    {
      path: 'manifest.json',
      content: JSON.stringify({
        name: 'flagger',
        description: 'Marks the first mail as seen, or does nothing in quiet mode.',
        tools: ['mailbox.list', 'mailbox.label'],
        channels: [],
        inputSchema: {
          type: 'object',
          properties: { quiet: { type: 'boolean' } },
          required: ['quiet'],
          additionalProperties: false,
        },
        dryRunInput: { quiet: false },
        liveInput: { quiet: true },
      }),
    },
    {
      path: 'tests.json',
      content: JSON.stringify({
        cases: [
          {
            name: 'marks the mail when not quiet',
            input: { quiet: false },
            stubs: { 'mailbox.list': [[]], 'mailbox.label': [{ done: true }] },
            expect: {
              result: { quiet: false },
              writes: [{ name: 'mailbox.label', input: { id: 1, label: 'seen' } }],
            },
          },
        ],
      }),
    },
  ];
}

function inbound(content: string, externalThreadId = CHAT): InboundEvent {
  return {
    channelType: 'telegram',
    channelName: CHANNEL,
    externalThreadId,
    senderId: 'user-1',
    idempotencyKey: `k-${Math.random()}`,
    content,
    timestamp: Date.now(),
  } as InboundEvent;
}

describe.skipIf(!enabled)('script flow against a real Docker daemon', () => {
  let root: string;
  let service: ScriptService;
  let repo: ScriptRepository;
  let listCalls: unknown[];
  let labelCalls: unknown[];
  let sent: Array<{ channel: string; thread: string; body: string }>;
  let versionId: string;
  let scriptDir: string;
  let scheduleRepo: ScheduleRepository;
  let scriptManage: ScriptManageHandler;
  let scriptRun: ScriptRunHandler;
  let scheduleManage: ScheduleManageHandler;

  const context = (personaId: string): { runId: string; threadId: string; personaId: string } => ({
    runId: `run-${personaId}`,
    threadId: `thread-${personaId}`,
    personaId,
  });
  const success = (result: ToolCallResult): Record<string, unknown> => {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('success');
    return result.result as Record<string, unknown>;
  };
  const lastCode = (): string => /^\/approve ([A-Z2-9]{8})$/m.exec(sent[sent.length - 1].body)![1];
  const waitForMessage = async (text: string): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (!sent.some((m) => m.body.includes(text)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sent.map((m) => m.body)).toContainEqual(expect.stringContaining(text));
  };
  /** Saves, tests and sends the flagger script for approval through the tool, then approves it in the chat. */
  const authorFlagger = async (personaId: string): Promise<void> => {
    const saved = success(
      await scriptManage.execute({ action: 'save', files: flaggerFiles() }, context(personaId)),
    );
    const id = saved.versionId as string;
    const tested = success(
      await scriptManage.execute({ action: 'test', versionId: id }, context(personaId)),
    );
    expect(tested.state).toBe('tested');
    const asked = success(
      await scriptManage.execute({ action: 'request_approval', versionId: id }, context(personaId)),
    );
    expect(asked).toEqual({ status: 'sent' });
    // The code is in the chat message and nowhere in a tool result.
    const code = lastCode();
    expect(JSON.stringify([saved, tested, asked])).not.toContain(code);
    const reply = await service.handleInbound(inbound(`/approve ${code}`, `chat-${personaId}`));
    expect(reply?.reply).toContain('Approved: script "flagger" v1');
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'script-flow-'));
    chmodSync(root, 0o755);
    installScriptSdk(root)._unsafeUnwrap();

    const db = createTestDb();
    const personaRepo = new PersonaRepository(db);
    const channelRepo = new ChannelRepository(db);
    const threadRepo = new ThreadRepository(db);
    channelRepo
      .insert({
        id: 'channel-1',
        type: 'telegram',
        name: CHANNEL,
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    for (const id of [PERSONA, FREE, GUARDED]) {
      personaRepo
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
    for (const id of [FREE, GUARDED]) {
      threadRepo
        .insert({
          id: `thread-${id}`,
          channel_id: 'channel-1',
          external_id: `chat-${id}`,
          metadata: '{}',
        })
        ._unsafeUnwrap();
    }
    repo = new ScriptRepository(db);
    scheduleRepo = new ScheduleRepository(db);

    const config = ScriptsConfigSchema.parse({
      enabled: true,
      root,
      image: IMAGE,
      dockerSocket: SOCKET,
      runTimeoutMs: 30_000,
    });
    const logger = pino({ level: 'silent' });
    listCalls = [];
    labelCalls = [];
    sent = [];

    const provider = (): RunProvider => ({
      describe(name) {
        if (name === 'mailbox.list') return { toolClass: 'read' };
        if (name === 'mailbox.label') return { toolClass: 'write' };
        return undefined;
      },
      call(name, input) {
        if (name === 'mailbox.list') {
          listCalls.push(input);
          return Promise.resolve(
            ok([
              { id: 1, subject: 'Invoice 2026-11' },
              { id: 2, subject: 'Lunch' },
              { id: 3, subject: 'Invoice 2026-12' },
            ]),
          );
        }
        labelCalls.push(input);
        return Promise.resolve(ok({ done: true }));
      },
      close: () => Promise.resolve(),
    });

    service = createScriptService({
      store: createScriptStore({ root, repo, logger }),
      repo,
      approval: createApprovalService({
        hashKey: TEST_APPROVAL_KEY,
        repo,
        ttlMinutes: config.approvalTtlMinutes,
        logger,
      })._unsafeUnwrap(),
      broker: buildScriptBroker(config, [PERSONA, FREE, GUARDED])._unsafeUnwrap(),
      config,
      createProvider: () => Promise.resolve(ok(provider())),
      send: (channel, thread, body) => {
        sent.push({ channel, thread, body });
        return Promise.resolve(ok(undefined));
      },
      resolveChat: (threadId) => {
        if (threadId === 'thread-1') return { channelName: CHANNEL, externalThreadId: CHAT };
        const persona = [FREE, GUARDED].find((id) => threadId === `thread-${id}`);
        return persona ? { channelName: CHANNEL, externalThreadId: `chat-${persona}` } : undefined;
      },
      audit: () => {},
      capabilities: (personaId) => CAPABILITIES[personaId],
      applyScheduleChange: (input) =>
        scheduleManage
          .applyScriptChange(input)
          .mapErr((error) => new ScriptError('TOOL_FAILED', 'the schedule was not saved', error)),
      logger,
    });

    const resolveCapabilities = (personaId: string): ResolvedCapabilities =>
      CAPABILITIES[personaId] ?? { allow: [], requireApproval: [] };
    scriptManage = new ScriptManageHandler({
      getService: () => service,
      getGuide: () => 'guide',
      logger,
    });
    scriptRun = new ScriptRunHandler({ getService: () => service, resolveCapabilities, logger });
    scheduleManage = new ScheduleManageHandler({
      scheduleRepository: scheduleRepo,
      threadRepository: threadRepo,
      channelRepository: channelRepo,
      personaRepository: personaRepo,
      getService: () => service,
      resolveCapabilities,
      logger,
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('saves a version and passes the unit cases and the dry run with no write', async () => {
    const saved = service
      .save({ personaId: PERSONA, threadId: 'thread-1', files: scriptFiles() })
      ._unsafeUnwrap();
    versionId = saved.versionId;
    scriptDir = saved.dir;

    const tested = (await service.test({ personaId: PERSONA, versionId }))._unsafeUnwrap();
    expect(tested.unit).toEqual([
      expect.objectContaining({ name: 'labels only invoices', passed: true }),
    ]);
    expect(tested.state).toBe('tested');
    expect(tested.dryRun?.didWork).toBe(true);
    // The dry run read real data one time and skipped both writes.
    expect(listCalls).toEqual([{ limit: 5 }]);
    expect(labelCalls).toEqual([]);
  }, 120_000);

  it('does not run before approval', async () => {
    const result = await service.runScheduled({
      personaId: PERSONA,
      threadId: 'thread-1',
      scriptName: 'mail-intake',
      scheduleId: 's1',
    });
    expect(result.isErr()).toBe(true);
    expect(labelCalls).toEqual([]);
  }, 60_000);

  it('sends an approval message that shows the skipped writes and holds the code', async () => {
    const requested = await service.requestApproval({ personaId: PERSONA, versionId });
    expect(requested._unsafeUnwrap()).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: CHANNEL, thread: CHAT });
    expect(sent[0].body).toContain('May write with: mailbox.label\n');
    expect(sent[0].body).toContain('Would write (2):');
    expect(sent[0].body).toContain('"label":"finance"');
    expect(sent[0].body).toMatch(/^\/approve [A-Z2-9]{8}$/m);
  });

  it('refuses the code from a different chat and accepts it from the right one', async () => {
    const code = /^\/approve ([A-Z2-9]{8})$/m.exec(sent[0].body)![1];

    expect(service.matchesInbound(inbound(`/approve ${code}`))).toBe(true);
    expect(service.matchesInbound(inbound('hello'))).toBe(false);

    // Free text in a chat with no open approval is not scanned.
    expect(service.matchesInbound(inbound(`approve ${code}`, 'other-chat'))).toBe(false);
    // A well-formed command there would cancel the code (wrong chat), so it is only classified.
    expect(service.matchesInbound(inbound(`/approve ${code}`, 'other-chat'))).toBe(true);
    expect(service.hasApproved(PERSONA, 'mail-intake')).toBe(false);

    expect(await service.handleInbound(inbound(`/approve ${code.toLowerCase()}`))).toEqual({
      reply: 'Approved: script "mail-intake" v1. It can now run on a schedule.',
    });
    expect(service.hasApproved(PERSONA, 'mail-intake')).toBe(true);

    // One-time use: the chat has no open approval any more.
    expect(service.matchesInbound(inbound(`/approve ${code}`))).toBe(false);
  });

  it('runs the approved version in live mode and the writes run', async () => {
    listCalls.length = 0;
    const result = await service.runScheduled({
      personaId: PERSONA,
      threadId: 'thread-1',
      scriptName: 'mail-intake',
      scheduleId: 's1',
    });
    const report = result._unsafeUnwrap() as ScriptRunReport;
    expect(report).toMatchObject({ ok: true, result: { seen: 3, filed: 2 } });
    expect(labelCalls).toEqual([
      { id: 1, label: 'finance' },
      { id: 3, label: 'finance' },
    ]);
    expect(service.lastScheduledRunFailed(PERSONA, 'mail-intake')).toBe(false);
  }, 60_000);

  it('lets a persona with script.run in allow write, run and schedule a script through the tools', async () => {
    await authorFlagger(FREE);
    labelCalls.length = 0;

    // With no input the run gets liveInput of the manifest: quiet mode, no write.
    const quiet = success(await scriptRun.execute({ name: 'flagger' }, context(FREE)));
    expect(quiet).toMatchObject({ status: 'finished', ok: true, result: '{"quiet":true}' });
    expect(labelCalls).toEqual([]);

    // The input of the agent reaches the script and changes the mode.
    const loud = success(
      await scriptRun.execute({ name: 'flagger', input: { quiet: false } }, context(FREE)),
    );
    expect(loud).toMatchObject({ status: 'finished', ok: true, result: '{"quiet":false}' });
    expect(labelCalls).toEqual([{ id: 1, label: 'seen' }]);

    // An input that does not match the schema of the script starts nothing.
    const bad = await scriptRun.execute({ name: 'flagger', input: { quiet: 'no' } }, context(FREE));
    expect(bad.status).toBe('error');
    expect(labelCalls).toHaveLength(1);

    // The schedule is written at once, with the input in its payload.
    const sentBefore = sent.length;
    const created = success(
      await scheduleManage.execute(
        {
          action: 'create',
          cronExpr: '0 * * * *',
          label: 'flag',
          script: 'flagger',
          input: { quiet: false },
        },
        context(FREE),
      ),
    );
    expect(sent).toHaveLength(sentBefore);
    const schedules = scheduleRepo.findByPersona(FREE)._unsafeUnwrap();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).toBe(created.scheduleId);
    expect(JSON.parse(schedules[0].payload)).toEqual({
      label: 'flag',
      script: 'flagger',
      input: { quiet: false },
    });

    // The scheduler passes that input to the run.
    const run = await service.runScheduled({
      personaId: FREE,
      threadId: schedules[0].thread_id,
      scriptName: 'flagger',
      scheduleId: schedules[0].id,
      input: { quiet: false },
    });
    expect(run._unsafeUnwrap()).toMatchObject({ ok: true, result: { quiet: false } });
    expect(labelCalls).toHaveLength(2);
  }, 180_000);

  it('asks the user before a run and before a schedule when script.run is in requireApproval', async () => {
    await authorFlagger(GUARDED);
    labelCalls.length = 0;
    listCalls.length = 0;

    // The run does not start. The chat gets a message with the input and a code.
    const asked = success(
      await scriptRun.execute({ name: 'flagger', input: { quiet: false } }, context(GUARDED)),
    );
    expect(asked.status).toBe('awaiting-approval');
    expect(listCalls).toEqual([]);
    const runMessage = sent[sent.length - 1];
    expect(runMessage.thread).toBe(`chat-${GUARDED}`);
    expect(runMessage.body).toContain('The agent wants to run script flagger (version 1) now.');
    expect(runMessage.body).toContain('Input: {"quiet":false}');
    const runCode = lastCode();
    expect(JSON.stringify(asked)).not.toContain(runCode);

    // A second call for the same request sends nothing.
    const sentBefore = sent.length;
    success(
      await scriptRun.execute({ name: 'flagger', input: { quiet: false } }, context(GUARDED)),
    );
    expect(sent).toHaveLength(sentBefore);
    expect(listCalls).toEqual([]);

    // The user approves: the run starts with the input that the message showed.
    const started = await service.handleInbound(inbound(`/approve ${runCode}`, `chat-${GUARDED}`));
    expect(started?.reply).toBe('Script flagger started.');
    await waitForMessage('Script flagger finished.');
    expect(labelCalls).toEqual([{ id: 1, label: 'seen' }]);

    // A schedule is not written before the user approves it.
    const pending = success(
      await scheduleManage.execute(
        { action: 'create', cronExpr: '30 * * * *', label: 'guarded flag', script: 'flagger' },
        context(GUARDED),
      ),
    );
    expect(pending.status).toBe('awaiting-approval');
    expect(scheduleRepo.findByPersona(GUARDED)._unsafeUnwrap()).toEqual([]);
    const scheduleMessage = sent[sent.length - 1].body;
    expect(scheduleMessage).toContain('30 * * * *');
    expect(scheduleMessage).toContain('guarded flag');
    expect(scheduleMessage).toContain('Input: {"quiet":true} (default of the script)');

    const saved = await service.handleInbound(inbound(`/approve ${lastCode()}`, `chat-${GUARDED}`));
    expect(saved?.reply).toBe('Schedule for script flagger saved.');
    const schedules = scheduleRepo.findByPersona(GUARDED)._unsafeUnwrap();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].expression).toBe('30 * * * *');
    expect(JSON.parse(schedules[0].payload)).toEqual({ label: 'guarded flag', script: 'flagger' });

    // The scheduled run itself never asks.
    const sentBeforeRun = sent.length;
    const run = await service.runScheduled({
      personaId: GUARDED,
      threadId: schedules[0].thread_id,
      scriptName: 'flagger',
      scheduleId: schedules[0].id,
    });
    expect(run._unsafeUnwrap()).toMatchObject({ ok: true, result: { quiet: true } });
    expect(sent).toHaveLength(sentBeforeRun);
  }, 180_000);

  it('does not let a persona with no script.run label start a script', async () => {
    const before = listCalls.length;
    const denied = await scriptRun.execute(
      { name: 'mail-intake' },
      {
        runId: 'r',
        threadId: 'thread-1',
        personaId: 'nobody',
      },
    );
    expect(denied.status).toBe('error');
    expect(listCalls).toHaveLength(before);
  });

  it('refuses a live run after a file changed on disk', async () => {
    labelCalls.length = 0;
    const scriptFile = join(scriptDir, 'script.ts');
    chmodSync(scriptFile, 0o644);
    appendFileSync(scriptFile, '\n// changed after approval\n');

    const result = await service.runScheduled({
      personaId: PERSONA,
      threadId: 'thread-1',
      scriptName: 'mail-intake',
      scheduleId: 's1',
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().scriptCode).toBe('SCRIPT_FAILED');
    expect(labelCalls).toEqual([]);
    expect(service.lastScheduledRunFailed(PERSONA, 'mail-intake')).toBe(true);
  }, 60_000);

  it('removes the container of an active run at shutdown and refuses new runs', async () => {
    const spin = service
      .save({
        personaId: PERSONA,
        threadId: 'thread-1',
        files: [
          {
            path: 'script.ts',
            content: 'export default async function (): Promise<void> {\n  while (true) {}\n}\n',
          },
          {
            path: 'manifest.json',
            content: JSON.stringify({
              name: 'spinner',
              description: 'Never returns.',
              tools: ['mailbox.list'],
              channels: [],
              dryRunInput: null,
            }),
          },
          {
            path: 'tests.json',
            content: JSON.stringify({
              cases: [{ name: 'spins', input: null, stubs: {}, expect: { ok: true } }],
            }),
          },
        ],
      })
      ._unsafeUnwrap();
    const running = service.test({ personaId: PERSONA, versionId: spin.versionId });
    const deadline = Date.now() + 20_000;
    while (containerIds(root).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(containerIds(root)).toHaveLength(1);

    await service.shutdown();
    expect(containerIds(root)).toEqual([]);
    // The test settled: its exec was refused, or its unit case failed, because the lease went away.
    const outcome = await running;
    if (outcome.isErr()) {
      expect(outcome.error.scriptCode).toBe('SANDBOX');
    } else {
      expect(outcome.value.state).toBe('draft');
    }
    const later = await service.runScheduled({
      personaId: PERSONA,
      threadId: 'thread-1',
      scriptName: 'mail-intake',
      scheduleId: 's1',
    });
    expect(later._unsafeUnwrapErr().scriptCode).toBe('SANDBOX');
  }, 60_000);

  it('removes every container it created', () => {
    expect(containerIds(root)).toEqual([]);
  });
});
