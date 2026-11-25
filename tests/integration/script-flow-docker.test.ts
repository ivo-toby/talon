import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'neverthrow';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboundEvent } from '../../src/channels/channel-types.js';
import { ScriptsConfigSchema } from '../../src/core/config/config-schema.js';
import { PersonaRepository } from '../../src/core/database/repositories/persona-repository.js';
import { ScriptRepository } from '../../src/core/database/repositories/script-repository.js';
import {
  buildScriptBroker,
  createApprovalService,
  createScriptService,
  createScriptStore,
  installScriptSdk,
} from '../../src/scripts/index.js';
import type {
  RunProvider,
  ScriptFile,
  ScriptRunReport,
  ScriptService,
} from '../../src/scripts/index.js';
import { createTestDb } from '../unit/core/database/repositories/helpers.js';

/**
 * Real-Docker run of the full script flow: save, unit cases, dry run, approval
 * message, `/approve` from the chat, and a scheduled run in `live` mode. The
 * database, the store, the approval service and the broker are real. Only the
 * tools are fake. Skipped unless TALON_SCRIPT_IT_IMAGE names a digest-pinned
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

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'script-flow-'));
    chmodSync(root, 0o755);
    installScriptSdk(root)._unsafeUnwrap();

    const db = createTestDb();
    new PersonaRepository(db)
      .insert({
        id: PERSONA,
        name: PERSONA,
        model: 'm',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
    repo = new ScriptRepository(db);

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
      approval: createApprovalService({ repo, ttlMinutes: config.approvalTtlMinutes, logger }),
      broker: buildScriptBroker(config, [PERSONA])._unsafeUnwrap(),
      config,
      createProvider: () => Promise.resolve(ok(provider())),
      send: (channel, thread, body) => {
        sent.push({ channel, thread, body });
        return Promise.resolve(ok(undefined));
      },
      notifyThread: () => Promise.resolve(ok(undefined)),
      audit: () => {},
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
    const requested = await service.requestApproval({
      personaId: PERSONA,
      versionId,
      channelName: CHANNEL,
      externalThreadId: CHAT,
    });
    expect(requested.isOk()).toBe(true);
    expect(requested._unsafeUnwrap()).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: CHANNEL, thread: CHAT });
    expect(sent[0].body).toContain('Would write (2):');
    expect(sent[0].body).toContain('"label":"finance"');
    expect(sent[0].body).toMatch(/^\/approve [A-Z2-9]{8}$/m);
  });

  it('refuses the code from a different chat and accepts it from the right one', async () => {
    const code = /^\/approve ([A-Z2-9]{8})$/m.exec(sent[0].body)![1];

    expect(service.matchesInbound(inbound(`/approve ${code}`))).toBe(true);
    expect(service.matchesInbound(inbound('hello'))).toBe(false);

    expect(await service.handleInbound(inbound(`/approve ${code}`, 'other-chat'))).toBe(
      'This code is not valid.',
    );
    expect(service.hasApproved(PERSONA, 'mail-intake')).toBe(false);

    expect(await service.handleInbound(inbound(`/approve ${code.toLowerCase()}`))).toBe(
      'Approved: script "mail-intake" v1. It can now run on a schedule.',
    );
    expect(service.hasApproved(PERSONA, 'mail-intake')).toBe(true);

    // One-time use.
    expect(await service.handleInbound(inbound(`/approve ${code}`))).toBe(
      'This code is not valid.',
    );
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

  it('removes every container it created', () => {
    expect(containerIds(root)).toEqual([]);
  });
});
