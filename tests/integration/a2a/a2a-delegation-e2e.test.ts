/**
 * Integration test — end-to-end persona-to-persona delegation (A2A).
 *
 * REAL components wired together:
 *   - better-sqlite3 database (in-memory) with the real migrations
 *   - real repositories (queue, thread, channel, persona, message, memory, run, a2a_tasks)
 *   - real QueueManager + QueueProcessor processing loop (real 500 ms poll, real
 *     QueueDeferral / defer / retry / dead-letter behaviour)
 *   - real A2ATaskMapper (submit, cancelTask, reapStaleTasks) + real agent-card registry
 *   - real AgentRunner.run as the queue handler (A2A gate, admission, run rows,
 *     abort registry shared with mapper.setAbortHook exactly as src/daemon/daemon.ts does)
 *   - real PersonaSendHandler with a waitScope that mirrors src/tools/host-tools-bridge.ts
 *     (queueManager.runWithSlotReleased keyed by run id)
 *   - real ProviderRegistry, real ContextAssembler, real SessionTracker
 *
 * STUBBED (the minimum needed to construct a DaemonContext without a network / model):
 *   - the LLM provider: a scripted fake `AgentProvider` (stateless CLI-style strategy,
 *     registered through the real ProviderRegistry). The fake invokes
 *     PersonaSendHandler.execute directly using a ToolExecutionContext built from the env the
 *     runner puts on the `__talond_host_tools` MCP server entry (run id, thread id, persona id,
 *     TALOND_A2A_TASK_ID, TALOND_A2A_HOP_COUNT), i.e. what the real bridge would reconstruct.
 *   - hostToolsBridge: only `path` + register/unregisterRunAuthentication (no socket server)
 *   - channelRegistry: one recording connector (captures outbound sends / typing)
 *   - observability: pass-through `observe`/`start*` (no Langfuse)
 *   - threadWorkspace: `ensureDirectories` returns a temp path (no filesystem layout)
 *   - skillResolver / loadedSkills / toolInstructions: empty
 *   - personaLoader: in-memory Map-backed stub (getByName/listNames) over the same LoadedPersona
 *     objects that feed the real agent-card registry
 *   - contextRoller (null), backgroundAgentManager (null), oauthTokenStore, image* members,
 *     scheduler, auditLogger, messagePipeline, subAgentRunner, executionEnvManager: unused
 *
 * Timing notes (src is not modified): QueueManager POLL_INTERVAL_MS (500 ms) and the 2000 ms
 * QueueDeferral delay in AgentRunner are hard-coded constants, so scenarios that exercise
 * deferral take several real seconds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { ok } from 'neverthrow';

import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { A2ATaskRepository } from '../../../src/core/database/repositories/a2a-task-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { MemoryRepository } from '../../../src/core/database/repositories/memory-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { A2ATaskMapper } from '../../../src/a2a/a2a-task-mapper.js';
import { buildAgentCardRegistry } from '../../../src/a2a/persona-agent-card.js';
import { defaultA2ALimits, type A2ALimits, type A2ATaskRow } from '../../../src/a2a/a2a-types.js';
import { QueueManager } from '../../../src/queue/queue-manager.js';
import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import { ContextAssembler } from '../../../src/daemon/context-assembler.js';
import { SessionTracker } from '../../../src/sandbox/session-tracker.js';
import { ProviderRegistry } from '../../../src/providers/provider-registry.js';
import { PersonaSendHandler, type PersonaSendArgs } from '../../../src/tools/host-tools/persona-send.js';
import type { ToolExecutionContext } from '../../../src/tools/host-tools/channel-send.js';
import type { ToolCallResult } from '../../../src/tools/tool-types.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import type { LoadedPersona } from '../../../src/personas/persona-types.js';
import type { QueueItem } from '../../../src/queue/queue-types.js';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  settled: boolean;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const d = { settled: false } as Deferred<T>;
  d.promise = new Promise<T>((res, rej) => {
    resolve = (v) => {
      d.settled = true;
      res(v);
    };
    reject = (e) => {
      d.settled = true;
      rej(e);
    };
  });
  d.resolve = resolve;
  d.reject = reject;
  return d;
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 15_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await sleep(intervalMs);
  }
}

const TEST_TIMEOUT = 40_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PERSONAS = ['alpha', 'beta', 'gamma'] as const;
type PersonaName = (typeof PERSONAS)[number];

/** What the fake provider sees for one run. */
interface FakeCall {
  persona: PersonaName;
  /** 0-based index of this execution for the persona. */
  index: number;
  model: string;
  prompt: string;
  systemPrompt: string;
  ctx: ToolExecutionContext;
  /** Calls PersonaSendHandler.execute as this run (what the bridge would do). */
  send: (args: PersonaSendArgs) => Promise<ToolCallResult>;
}

type Script = (call: FakeCall) => Promise<string>;

interface HarnessOptions {
  limits?: Partial<A2ALimits>;
  concurrencyLimit?: number;
  /** Queue max attempts for non-A2A (message) items. */
  messageMaxAttempts?: number;
  /** When false the PersonaSendHandler has no waitScope (no slot release). */
  releaseSlotWhileWaiting?: boolean;
}

function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

function makeHarness(opts: HarnessOptions = {}) {
  const logger = pino({ level: process.env.E2E_LOG ?? 'silent' });
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrated = runMigrations(db, migrationsDir());
  if (migrated.isErr()) throw new Error(`Migration failed: ${migrated.error.message}`);

  const limits: A2ALimits = { ...defaultA2ALimits(), ...opts.limits };

  const taskRepo = new A2ATaskRepository(db);
  const queueRepo = new QueueRepository(db);
  const threadRepo = new ThreadRepository(db);
  const channelRepo = new ChannelRepository(db);
  const personaRepo = new PersonaRepository(db);
  const messageRepo = new MessageRepository(db);
  const memoryRepo = new MemoryRepository(db);
  const runRepo = new RunRepository(db);

  // --- personas ------------------------------------------------------------
  const personaIds = new Map<PersonaName, string>();
  const loadedByName = new Map<string, LoadedPersona>();
  for (const name of PERSONAS) {
    const id = uuidv4();
    personaIds.set(name, id);
    personaRepo.insert({
      id,
      name,
      model: `model-${name}`,
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{"allow":[],"requireApproval":[]}',
      mounts: '[]',
      max_concurrent: null,
    });
    loadedByName.set(name, {
      config: {
        name,
        model: `model-${name}`,
        systemPromptFile: undefined,
        skills: [],
        subagents: [],
        capabilities: { allow: [], requireApproval: [] },
        mounts: [],
        maxConcurrent: undefined,
        provider: undefined,
      },
      description: `persona ${name}`,
      systemPromptContent: `SYSTEM-PROMPT-OF-${name.toUpperCase()}`,
      personalityContent: undefined,
      taskPromptPaths: undefined,
      resolvedCapabilities: { allow: ['persona.send:*'], requireApproval: [] },
    } as unknown as LoadedPersona);
  }
  const personaNameById = new Map([...personaIds].map(([n, id]) => [id, n]));

  // --- source thread ---------------------------------------------------------
  const channelId = uuidv4();
  channelRepo.insert({
    id: channelId,
    type: 'terminal',
    name: 'e2e-channel',
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });
  const threadId = uuidv4();
  threadRepo.insert({ id: threadId, channel_id: channelId, external_id: 'ext-e2e', metadata: '{}' });

  // --- fake provider -----------------------------------------------------------
  const scripts = new Map<PersonaName, Script>();
  const calls: Record<PersonaName, FakeCall[]> = { alpha: [], beta: [], gamma: [] };
  const active: Record<PersonaName, number> = { alpha: 0, beta: 0, gamma: 0 };
  const maxActive: Record<PersonaName, number> = { alpha: 0, beta: 0, gamma: 0 };
  const executionLog: string[] = [];

  const queueManager = new QueueManager(
    queueRepo,
    threadRepo,
    {
      maxAttempts: opts.messageMaxAttempts ?? 1,
      backoffBaseMs: 10,
      backoffMaxMs: 20,
      concurrencyLimit: opts.concurrencyLimit ?? 8,
    },
    logger,
  );

  const mapper = new A2ATaskMapper(
    taskRepo,
    queueRepo,
    threadRepo,
    personaRepo,
    buildAgentCardRegistry([...loadedByName.values()]),
    logger,
    limits,
  );

  // Mirrors src/tools/host-tools-bridge.ts waitScope.
  const sendHandler = new PersonaSendHandler({
    taskMapper: mapper,
    taskRepo,
    personaRepo,
    logger,
    pollIntervalMs: 15,
    // Mirrors HostToolsBridge.resolvePersonaCapabilities (fail closed when unknown).
    resolveCapabilities: (personaId: string) => {
      const name = personaNameById.get(personaId);
      return (
        (name ? loadedByName.get(name)?.resolvedCapabilities : undefined) ?? { allow: [], requireApproval: [] }
      );
    },
    ...(opts.releaseSlotWhileWaiting === false
      ? {}
      : {
          waitScope: <T>(fn: () => Promise<T>, context: ToolExecutionContext): Promise<T> =>
            context.backgroundTaskId ? fn() : queueManager.runWithSlotReleased(fn, context.runId),
        }),
  });

  const sentBodies: string[] = [];
  const connector = {
    send: vi.fn(async (_to: string, msg: { body: string }) => {
      sentBodies.push(msg.body);
      return ok(undefined);
    }),
    sendTyping: vi.fn(async () => undefined),
  };

  async function fakeRun(input: {
    prompt: string;
    systemPrompt: string;
    model: string;
    mcpServers: Record<string, { env?: Record<string, string> }>;
  }) {
    const persona = PERSONAS.find((p) => `model-${p}` === input.model);
    if (!persona) throw new Error(`fake provider: unknown model ${input.model}`);
    const env = input.mcpServers.__talond_host_tools?.env ?? {};
    const ctx: ToolExecutionContext = {
      runId: env.TALOND_RUN_ID,
      threadId: env.TALOND_THREAD_ID,
      personaId: env.TALOND_PERSONA_ID,
      requestId: uuidv4(),
      ...(env.TALOND_A2A_TASK_ID ? { a2aTaskId: env.TALOND_A2A_TASK_ID } : {}),
      ...(env.TALOND_A2A_HOP_COUNT !== undefined && env.TALOND_A2A_TASK_ID
        ? { a2aHopCount: Number(env.TALOND_A2A_HOP_COUNT) }
        : {}),
    };
    const call: FakeCall = {
      persona,
      index: calls[persona].length,
      model: input.model,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      ctx,
      send: (args) => sendHandler.execute(args, ctx),
    };
    calls[persona].push(call);
    active[persona]++;
    maxActive[persona] = Math.max(maxActive[persona], active[persona]);
    executionLog.push(`start:${persona}:${call.prompt}`);
    try {
      const script = scripts.get(persona);
      const text = script ? await script(call) : `reply from ${persona}`;
      executionLog.push(`end:${persona}:${call.prompt}`);
      return { output: text, usage: { inputTokens: 1, outputTokens: 1 }, isError: false };
    } finally {
      active[persona]--;
    }
  }

  const fakeProvider = {
    name: 'fake',
    skillLoaderTransport: 'stdio' as const,
    createExecutionStrategy: () => ({
      type: 'cli' as const,
      supportsSessionResumption: false as const,
      run: fakeRun,
    }),
    prepareBackgroundInvocation: () => {
      throw new Error('not used');
    },
    parseBackgroundResult: () => {
      throw new Error('not used');
    },
    estimateContextUsage: () => ({ inputTokens: 0, metrics: {} }),
  };

  const providerConfig = { enabled: true, contextWindowTokens: 1000 };
  const providerRegistry = new ProviderRegistry(
    { fake: providerConfig } as never,
    { fake: () => fakeProvider } as never,
  );

  // --- DaemonContext (minimal stubs, see header) ---------------------------------
  const ctx = {
    db,
    config: {
      a2a: limits,
      agentRunner: { defaultProvider: 'fake', providers: { fake: providerConfig } },
      channels: [],
    },
    configPath: '',
    dataDir: tmpdir(),
    repos: {
      queue: queueRepo,
      thread: threadRepo,
      channel: channelRepo,
      persona: personaRepo,
      message: messageRepo,
      memory: memoryRepo,
      run: runRepo,
      a2aTask: taskRepo,
    },
    channelRegistry: {
      get: () => connector,
      listAll: () => [{ name: 'e2e-channel' }],
    },
    queueManager,
    personaLoader: {
      getByName: (name: string) => ok(loadedByName.get(name)),
      listNames: () => [...loadedByName.keys()],
    },
    sessionTracker: new SessionTracker(),
    contextRoller: null,
    contextAssembler: new ContextAssembler({ messageRepo, memoryRepo }),
    threadWorkspace: { ensureDirectories: () => ok(tmpdir()) },
    skillResolver: { mergePromptFragments: () => '' },
    loadedSkills: [],
    toolInstructions: new Map(),
    observability: {
      observe: async (_i: unknown, fn: (h: unknown) => Promise<unknown>) =>
        fn({ update: () => undefined, getTraceparent: () => null }),
      start: () => ({ update: () => undefined, getTraceparent: () => null, end: () => undefined }),
      startWithTraceparent: () => ({ update: () => undefined, getTraceparent: () => null, end: () => undefined }),
      shutdown: async () => undefined,
    },
    hostToolsBridge: {
      path: '/tmp/e2e-host-tools.sock',
      registerRunAuthentication: () => undefined,
      unregisterRunAuthentication: () => undefined,
    },
    providerRegistry,
    backgroundAgentManager: null,
    logger,
    a2aTaskMapper: mapper,
  } as unknown as DaemonContext;

  // Wiring identical to src/daemon/daemon.ts.
  const a2aAborts = new Map<string, () => void>();
  const runner = new AgentRunner(ctx, { a2aAborts });
  mapper.setAbortHook((taskId) => {
    a2aAborts.get(taskId)?.();
  });

  // Count how many times each queue item is handed to the runner (claims).
  const claimCounts = new Map<string, number>();
  let started = false;
  function start(): void {
    started = true;
    queueManager.startProcessing(async (item: QueueItem) => {
      claimCounts.set(item.id, (claimCounts.get(item.id) ?? 0) + 1);
      return runner.run(item);
    });
  }

  // --- helpers used by scenarios -------------------------------------------------
  const gates: Array<Deferred<void>> = [];
  function newGate(): Deferred<void> {
    const g = deferred<void>();
    gates.push(g);
    return g;
  }

  function seedSourceThreadHistory(): { message: string; summary: string } {
    const message = 'SOURCE-THREAD-EARLIER-MESSAGE-7f3a';
    const summary = 'SOURCE-THREAD-SUMMARY-9c1e';
    messageRepo.insert({
      id: uuidv4(),
      thread_id: threadId,
      direction: 'inbound',
      content: JSON.stringify({ body: message }),
      idempotency_key: `seed-${uuidv4()}`,
      provider_id: null,
      run_id: null,
    });
    memoryRepo.insert({
      id: uuidv4(),
      thread_id: threadId,
      type: 'summary',
      content: summary,
      embedding_ref: null,
      metadata: JSON.stringify({ rotatedThroughTs: 0 }),
    });
    return { message, summary };
  }

  function submit(target: PersonaName, content: string, parentTaskId?: string, hopCount = 1) {
    return mapper.submitTask({
      sourcePersona: 'alpha',
      targetPersona: target,
      sourceThreadId: threadId,
      content,
      hopCount,
      ...(parentTaskId ? { parentTaskId } : {}),
    });
  }

  function enqueueMessage(persona: PersonaName, content: string): QueueItem {
    return queueManager
      .enqueue(threadId, 'message', { personaId: personaIds.get(persona)!, content })
      .match(
        (v) => v,
        (e) => {
          throw e;
        },
      );
  }

  function task(id: string): A2ATaskRow {
    const row = taskRepo.findById(id)._unsafeUnwrap();
    if (!row) throw new Error(`task ${id} missing`);
    return row;
  }
  const state = (id: string): string => task(id).state;
  const queueRow = (itemId: string) => queueRepo.findById(itemId)._unsafeUnwrap()!;
  const allTasks = (): A2ATaskRow[] => taskRepo.findAll({ limit: 100 })._unsafeUnwrap();

  async function shutdown(): Promise<void> {
    queueManager.stopProcessing();
    for (const g of gates) if (!g.settled) g.resolve();
    if (started) {
      // Let in-flight runs finish before the DB goes away.
      await waitFor(
        () => {
          const s = queueManager.stats();
          return s.claimed + s.processing === 0;
        },
        'in-flight queue items to drain',
        5000,
      ).catch(() => undefined);
    }
    db.close();
  }

  return {
    db,
    limits,
    taskRepo,
    queueRepo,
    runRepo,
    mapper,
    queueManager,
    runner,
    a2aAborts,
    threadId,
    personaIds,
    personaNameById,
    scripts,
    calls,
    active,
    maxActive,
    executionLog,
    claimCounts,
    sentBodies,
    connector,
    start,
    newGate,
    seedSourceThreadHistory,
    submit,
    enqueueMessage,
    task,
    state,
    queueRow,
    allTasks,
    shutdown,
  };
}

type Harness = ReturnType<typeof makeHarness>;

interface SendOutput {
  task_id: string;
  state: string;
  result?: string;
  error?: string;
}
const output = (r: ToolCallResult): SendOutput => r.result as SendOutput;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2A delegation end-to-end (real queue + runner + mapper, fake provider)', () => {
  let h: Harness;

  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.shutdown();
  });

  // -------------------------------------------------------------------------
  it('1. happy path: alpha delegates (await_reply) to beta, which runs isolated under its own persona', async () => {
    h = makeHarness();
    const seeded = h.seedSourceThreadHistory();

    const callerResult = deferred<ToolCallResult>();
    h.scripts.set('alpha', async (call) => {
      const r = await call.send({
        target_persona: 'beta',
        message: 'DELEGATED-MESSAGE-TEXT',
        await_reply: true,
        timeout_ms: 20_000,
      });
      callerResult.resolve(r);
      return 'ALPHA-FINAL-ANSWER';
    });
    h.scripts.set('beta', async () => 'BETA-RESULT-TEXT');

    h.start();
    const alphaItem = h.enqueueMessage('alpha', 'please delegate this');

    const res = await callerResult.promise;
    expect(res.status).toBe('success');
    const out = output(res);
    expect(out.state).toBe('completed');
    expect(out.result).toBe('BETA-RESULT-TEXT');

    // --- alpha (control): a normal foreground run DOES receive the source thread history
    await waitFor(() => h.queueRow(alphaItem.id).status === 'completed', 'alpha queue item completed');
    expect(h.calls.alpha).toHaveLength(1);
    expect(h.calls.alpha[0].systemPrompt).toContain(seeded.message);
    expect(h.calls.alpha[0].systemPrompt).toContain(seeded.summary);
    expect(h.calls.alpha[0].model).toBe('model-alpha');

    // --- beta: executed under beta's persona config and isolated from the source thread
    expect(h.calls.beta).toHaveLength(1);
    const beta = h.calls.beta[0];
    expect(beta.model).toBe('model-beta');
    expect(beta.systemPrompt).toContain('SYSTEM-PROMPT-OF-BETA');
    expect(beta.systemPrompt).not.toContain('SYSTEM-PROMPT-OF-ALPHA');
    expect(beta.prompt).toBe('DELEGATED-MESSAGE-TEXT');
    for (const secret of [seeded.message, seeded.summary, 'please delegate this']) {
      expect(beta.prompt).not.toContain(secret);
      expect(beta.systemPrompt).not.toContain(secret);
    }
    expect(beta.ctx.a2aTaskId).toBe(out.task_id);
    expect(beta.ctx.a2aHopCount).toBe(1);
    expect(beta.ctx.threadId).toBe(h.threadId);
    expect(h.personaNameById.get(beta.ctx.personaId)).toBe('beta');

    // --- a2a_tasks row
    const rows = h.allTasks();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(out.task_id);
    expect(row.state).toBe('completed');
    expect(row.source_persona).toBe('alpha');
    expect(row.target_persona).toBe('beta');
    expect(JSON.parse(row.result_payload!)).toEqual({ text: 'BETA-RESULT-TEXT' });
    expect(row.error_code).toBeNull();
    expect(row.completed_at).not.toBeNull();
    expect(row.run_id).toBeTruthy();
    const betaRun = h.runRepo.findById(row.run_id!)._unsafeUnwrap()!;
    expect(betaRun.status).toBe('completed');
    expect(betaRun.persona_id).toBe(beta.ctx.personaId);
    expect(betaRun.model_name).toBe('model-beta');

    // --- queue items
    const taskItem = h.queueRow(row.queue_item_id!);
    expect(taskItem.type).toBe('collaboration');
    expect(taskItem.status).toBe('completed');
    expect(taskItem.attempts).toBe(0);

    // --- channel: delegated persona never talks to the source channel; alpha's final does
    expect(h.sentBodies).toContain('ALPHA-FINAL-ANSWER');
    expect(h.sentBodies.join('\n')).not.toContain('BETA-RESULT-TEXT');
  }, TEST_TIMEOUT);

  // -------------------------------------------------------------------------
  describe('2. busy target queues FIFO', () => {
    it('keeps later tasks submitted, never runs concurrently, completes in submission order, consumes no attempts', async () => {
      h = makeHarness({ limits: { maxConcurrentPerTarget: 1 } });
      const gates = [h.newGate(), h.newGate(), h.newGate()];
      h.scripts.set('beta', async (call) => {
        await gates[call.index].promise;
        return `done-${call.prompt}`;
      });
      h.start();

      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        const s = h.submit('beta', `task-${n}`)._unsafeUnwrap();
        ids.push(s.taskId);
        await sleep(5); // distinct submitted_at (see the same-millisecond test below)
      }
      const itemIds = ids.map((id) => h.task(id).queue_item_id!);

      // First is admitted and held open.
      await waitFor(() => h.calls.beta.length === 1 && h.state(ids[0]) === 'working', 'task 1 running');
      // Others must be claimed at least twice (admission wait -> deferral), and stay submitted.
      await waitFor(
        () => (h.claimCounts.get(itemIds[1]) ?? 0) >= 2 && (h.claimCounts.get(itemIds[2]) ?? 0) >= 2,
        'tasks 2 and 3 deferred at least once',
        20_000,
      );
      expect(h.state(ids[1])).toBe('submitted');
      expect(h.state(ids[2])).toBe('submitted');
      expect(h.calls.beta).toHaveLength(1);
      for (const itemId of itemIds.slice(1)) {
        const q = h.queueRow(itemId);
        expect(q.status).toBe('pending');
        expect(q.attempts).toBe(0); // deferral did not consume an attempt (max_attempts is 1)
      }

      gates[0].resolve();
      await waitFor(() => h.state(ids[0]) === 'completed', 'task 1 completed');
      await waitFor(() => h.calls.beta.length === 2 && h.state(ids[1]) === 'working', 'task 2 running', 20_000);
      expect(h.state(ids[2])).toBe('submitted');

      gates[1].resolve();
      await waitFor(() => h.state(ids[1]) === 'completed', 'task 2 completed');
      await waitFor(() => h.calls.beta.length === 3 && h.state(ids[2]) === 'working', 'task 3 running', 20_000);

      gates[2].resolve();
      await waitFor(() => h.state(ids[2]) === 'completed', 'task 3 completed');

      expect(h.maxActive.beta).toBe(1);
      expect(h.calls.beta.map((c) => c.prompt)).toEqual(['task-1', 'task-2', 'task-3']);
      const completedAt = ids.map((id) => h.task(id).completed_at!);
      expect(completedAt[0]).toBeLessThanOrEqual(completedAt[1]);
      expect(completedAt[1]).toBeLessThanOrEqual(completedAt[2]);
      for (const [i, id] of ids.entries()) {
        expect(JSON.parse(h.task(id).result_payload!)).toEqual({ text: `done-task-${i + 1}` });
        const q = h.queueRow(itemIds[i]);
        expect(q.status).toBe('completed');
        expect(q.attempts).toBe(0);
      }
      expect(h.claimCounts.get(itemIds[1])!).toBeGreaterThan(1);
      expect(h.claimCounts.get(itemIds[2])!).toBeGreaterThan(1);
    }, TEST_TIMEOUT);

    it('FIFO holds even when tasks are submitted within the same millisecond', async () => {
      h = makeHarness({ limits: { maxConcurrentPerTarget: 1 } });
      const gates = [h.newGate(), h.newGate(), h.newGate(), h.newGate()];
      h.scripts.set('beta', async (call) => {
        await gates[call.index].promise;
        return 'ok';
      });
      h.start();

      // Freeze the clock for the synchronous submissions so submitted_at ties exactly.
      const realNow = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow);
      const ids: string[] = [];
      try {
        for (const n of [1, 2, 3, 4]) ids.push(h.submit('beta', `burst-${n}`)._unsafeUnwrap().taskId);
      } finally {
        spy.mockRestore();
      }
      expect(new Set(ids.map((id) => h.task(id).submitted_at)).size).toBe(1);

      for (let i = 0; i < 4; i++) {
        await waitFor(() => h.calls.beta.length === i + 1, `burst run ${i + 1} started`, 25_000);
        gates[i].resolve();
        await waitFor(() => h.state(ids[i]) === 'completed' || h.calls.beta.length > i + 1, `burst ${i + 1} done`, 25_000);
      }
      await waitFor(() => ids.every((id) => h.state(id) === 'completed'), 'all burst tasks completed', 25_000);
      expect(h.calls.beta.map((c) => c.prompt)).toEqual(['burst-1', 'burst-2', 'burst-3', 'burst-4']);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  it('3. backlog bound: submit is rejected with a clear error once maxQueuedPerTarget is reached', async () => {
    h = makeHarness({ limits: { maxConcurrentPerTarget: 1, maxQueuedPerTarget: 2 } });
    const g = h.newGate();
    h.scripts.set('beta', async () => {
      await g.promise;
      return 'ok';
    });
    h.start();

    const first = h.submit('beta', 'running')._unsafeUnwrap();
    await waitFor(() => h.state(first.taskId) === 'working', 'first task running');
    const q1 = h.submit('beta', 'queued-1');
    const q2 = h.submit('beta', 'queued-2');
    expect(q1.isOk()).toBe(true);
    expect(q2.isOk()).toBe(true);

    const rejected = h.submit('beta', 'one-too-many');
    expect(rejected.isErr()).toBe(true);
    expect(rejected._unsafeUnwrapErr().message).toMatch(/already has 2 queued task\(s\)\. Max queued: 2/);
    // Nothing persisted for the rejected submission.
    expect(h.allTasks()).toHaveLength(3);
    expect(h.allTasks().some((t) => t.request_payload.includes('one-too-many'))).toBe(false);

    // Another target is unaffected.
    expect(h.submit('gamma', 'other target').isOk()).toBe(true);
  }, TEST_TIMEOUT);

  // -------------------------------------------------------------------------
  describe('4. failure is final', () => {
    it('maxAttempts=1: a throwing provider fails the task, dead-letters the item, runs once, caller sees failed', async () => {
      h = makeHarness({ limits: { maxAttempts: 1 } });
      h.scripts.set('beta', async () => {
        throw new Error('provider exploded');
      });
      const callerResult = deferred<ToolCallResult>();
      h.scripts.set('alpha', async (call) => {
        callerResult.resolve(
          await call.send({ target_persona: 'beta', message: 'do it', await_reply: true, timeout_ms: 20_000 }),
        );
        return 'alpha done';
      });
      h.start();
      h.enqueueMessage('alpha', 'go');

      const res = await callerResult.promise;
      const out = output(res);
      expect(out.state).toBe('failed');
      expect(out.error).toContain('provider exploded');

      const row = h.task(out.task_id);
      expect(row.state).toBe('failed');
      expect(row.error_code).toBe('EXECUTION_ERROR');
      expect(row.result_payload).toBeNull();
      await waitFor(() => h.queueRow(row.queue_item_id!).status === 'dead_letter', 'queue item dead-lettered');
      // NOTE: DeadLetterHandler.moveToDeadLetter does not bump `attempts` (stays 0 here); not asserted.

      // Give the queue time to (wrongly) retry, then confirm exactly one execution.
      await sleep(1200);
      expect(h.calls.beta).toHaveLength(1);
      expect(h.state(out.task_id)).toBe('failed');
    }, TEST_TIMEOUT);

    it('maxAttempts=2: first attempt throws, retry succeeds; task is never observed failed in between', async () => {
      h = makeHarness({ limits: { maxAttempts: 2 } });
      h.scripts.set('beta', async (call) => {
        if (call.index === 0) throw new Error('transient failure');
        return 'recovered';
      });
      h.start();

      const observed = new Set<string>();
      const { taskId } = h.submit('beta', 'flaky')._unsafeUnwrap();
      const poller = setInterval(() => {
        try {
          observed.add(h.state(taskId));
        } catch {
          /* db closed */
        }
      }, 2);
      try {
        await waitFor(() => h.state(taskId) === 'completed', 'task completed after retry', 20_000);
      } finally {
        clearInterval(poller);
      }
      observed.add(h.state(taskId));

      expect(observed.has('failed')).toBe(false);
      expect(observed.has('working')).toBe(true);
      expect(h.calls.beta).toHaveLength(2);
      const row = h.task(taskId);
      expect(JSON.parse(row.result_payload!)).toEqual({ text: 'recovered' });
      expect(row.error_code).toBeNull();
      const q = h.queueRow(row.queue_item_id!);
      expect(q.status).toBe('completed');
      expect(q.attempts).toBe(1); // one real failure consumed one attempt
    }, TEST_TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('5. terminal never resurrects', () => {
    it('canceling a queued task means it never executes and its queue item is not dispatched', async () => {
      h = makeHarness({ limits: { maxConcurrentPerTarget: 1 } });
      const g = h.newGate();
      h.scripts.set('beta', async (call) => {
        if (call.index === 0) await g.promise;
        return `ran-${call.prompt}`;
      });
      h.start();

      const t1 = h.submit('beta', 'holder')._unsafeUnwrap();
      await waitFor(() => h.state(t1.taskId) === 'working', 'holder running');
      const t2 = h.submit('beta', 'to-be-canceled')._unsafeUnwrap();
      const item2 = h.task(t2.taskId).queue_item_id!;
      await waitFor(() => (h.claimCounts.get(item2) ?? 0) >= 1, 'queued task claimed once and deferred', 15_000);

      expect(h.mapper.cancelTask(t2.taskId, 'no longer needed')._unsafeUnwrap()).toBe(true);
      expect(h.state(t2.taskId)).toBe('canceled');
      expect(h.task(t2.taskId).error_message).toBe('no longer needed');
      expect(h.mapper.cancelTask(t2.taskId, 'again')._unsafeUnwrap()).toBe(false);

      g.resolve();
      await waitFor(() => h.state(t1.taskId) === 'completed', 'holder completed');
      // Wait past the deferral window + a couple of polls: the canceled item must stay dead.
      await sleep(3200);

      expect(h.calls.beta.map((c) => c.prompt)).toEqual(['holder']);
      expect(h.state(t2.taskId)).toBe('canceled');
      expect(h.task(t2.taskId).result_payload).toBeNull();
      expect(h.task(t2.taskId).run_id).toBeNull();
      expect(h.queueRow(item2).status).toBe('completed');
      expect(h.queueRow(item2).error).toBe('canceled');
    }, TEST_TIMEOUT);

    it('canceling an in-flight task aborts the run, discards the late result and is not retried', async () => {
      // maxAttempts=3 so a wrong retry would be visible.
      h = makeHarness({ limits: { maxAttempts: 3 } });
      const g = h.newGate();
      h.scripts.set('beta', async () => {
        await g.promise;
        return 'LATE-RESULT-AFTER-CANCEL';
      });
      h.start();

      const { taskId } = h.submit('beta', 'long job')._unsafeUnwrap();
      await waitFor(() => h.calls.beta.length === 1 && h.state(taskId) === 'working', 'in flight');
      await waitFor(() => h.a2aAborts.has(taskId), 'abort hook registered by the runner');
      const itemId = h.task(taskId).queue_item_id!;
      const runId = h.task(taskId).run_id!;

      expect(h.mapper.cancelTask(taskId, 'user canceled')._unsafeUnwrap()).toBe(true);
      expect(h.state(taskId)).toBe('canceled');

      // Runner stops waiting on the provider: queue item completes (not failed / retried).
      await waitFor(() => h.queueRow(itemId).status === 'completed', 'queue item completed after abort');
      expect(h.queueRow(itemId).attempts).toBe(0);
      expect(h.runRepo.findById(runId)._unsafeUnwrap()!.status).toBe('failed');
      expect(h.runRepo.findById(runId)._unsafeUnwrap()!.error).toContain('A2A task canceled');
      expect(h.a2aAborts.has(taskId)).toBe(false);

      // Provider eventually returns: result must be discarded.
      g.resolve();
      await sleep(1500);
      const row = h.task(taskId);
      expect(row.state).toBe('canceled');
      expect(row.result_payload).toBeNull();
      expect(row.error_code).toBe('CANCELED');
      expect(h.calls.beta).toHaveLength(1);
      expect(h.queueRow(itemId).status).toBe('completed');
    }, TEST_TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('6. queue slot release while awaiting', () => {
    it('with concurrencyLimit=1, alpha awaiting beta releases its slot so beta can run (no deadlock)', async () => {
      h = makeHarness({ concurrencyLimit: 1 });
      const callerResult = deferred<ToolCallResult>();
      h.scripts.set('alpha', async (call) => {
        const r = await call.send({
          target_persona: 'beta',
          message: 'needs a slot',
          await_reply: true,
          timeout_ms: 12_000,
        });
        callerResult.resolve(r);
        return 'alpha finished';
      });
      h.scripts.set('beta', async () => 'beta got a slot');
      h.start();
      const alphaItem = h.enqueueMessage('alpha', 'go');

      const res = await callerResult.promise;
      expect(output(res).state).toBe('completed'); // not 'timeout'
      expect(output(res).result).toBe('beta got a slot');
      await waitFor(() => h.queueRow(alphaItem.id).status === 'completed', 'alpha item completed');
      expect(h.calls.beta).toHaveLength(1);
      expect(h.allTasks()[0].state).toBe('completed');
    }, TEST_TIMEOUT);

    it('control: without slot release the same setup cannot make progress and alpha times out', async () => {
      h = makeHarness({ concurrencyLimit: 1, releaseSlotWhileWaiting: false });
      const callerResult = deferred<ToolCallResult>();
      h.scripts.set('alpha', async (call) => {
        const r = await call.send({
          target_persona: 'beta',
          message: 'needs a slot',
          await_reply: true,
          timeout_ms: 1500,
        });
        callerResult.resolve(r);
        return 'alpha finished';
      });
      h.start();
      h.enqueueMessage('alpha', 'go');

      const res = await callerResult.promise;
      expect(output(res).state).toBe('timeout');
      expect(h.calls.beta).toHaveLength(0);
    }, TEST_TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('7. delegation cycles', () => {
    it('alpha -> beta -> gamma -> beta is rejected with the cycle error, no deadlock', async () => {
      h = makeHarness({ limits: { maxConcurrentPerTarget: 1 } });
      const gammaSaw = deferred<ToolCallResult>();
      const alphaGot = deferred<ToolCallResult>();

      h.scripts.set('alpha', async (call) => {
        alphaGot.resolve(
          await call.send({ target_persona: 'beta', message: 'start chain', await_reply: true, timeout_ms: 20_000 }),
        );
        return 'alpha done';
      });
      h.scripts.set('beta', async (call) => {
        const r = await call.send({
          target_persona: 'gamma',
          message: 'pass it on',
          await_reply: true,
          timeout_ms: 20_000,
        });
        return `beta relays: ${output(r).result ?? output(r).error}`;
      });
      h.scripts.set('gamma', async (call) => {
        const r = await call.send({
          target_persona: 'beta',
          message: 'loop back',
          await_reply: true,
          timeout_ms: 20_000,
        });
        gammaSaw.resolve(r);
        return `gamma saw: ${r.status}`;
      });
      h.start();
      h.enqueueMessage('alpha', 'go');

      const cycle = await gammaSaw.promise;
      expect(cycle.status).toBe('error');
      expect(cycle.error).toMatch(/delegation cycle/);
      expect(cycle.error).toMatch(/beta/);

      const final = await alphaGot.promise;
      expect(output(final).state).toBe('completed');
      expect(output(final).result).toContain('beta relays: gamma saw: error');

      const rows = h.allTasks();
      expect(rows).toHaveLength(2); // the rejected submission left no row
      expect(rows.every((t) => t.state === 'completed')).toBe(true);
      expect(h.calls.beta).toHaveLength(1);
      expect(h.calls.gamma).toHaveLength(1);
      const gammaTask = rows.find((t) => t.target_persona === 'gamma')!;
      const betaTask = rows.find((t) => t.target_persona === 'beta')!;
      expect(gammaTask.parent_task_id).toBe(betaTask.id);
      expect(gammaTask.hop_count).toBe(2);
    }, TEST_TIMEOUT);

    it('a persona delegating to itself while running a delegated task is rejected', async () => {
      h = makeHarness({ limits: { maxConcurrentPerTarget: 1 } });
      const selfResult = deferred<ToolCallResult>();
      h.scripts.set('alpha', async (call) => {
        await call.send({ target_persona: 'beta', message: 'go', await_reply: true, timeout_ms: 20_000 });
        return 'alpha done';
      });
      h.scripts.set('beta', async (call) => {
        selfResult.resolve(
          await call.send({ target_persona: 'beta', message: 'me again', await_reply: true, timeout_ms: 5_000 }),
        );
        return 'beta done';
      });
      h.start();
      h.enqueueMessage('alpha', 'go');

      const r = await selfResult.promise;
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/delegation cycle/);
      await waitFor(() => h.allTasks().every((t) => t.state === 'completed'), 'tasks completed');
      expect(h.allTasks()).toHaveLength(1);
    }, TEST_TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('8. reaper', () => {
    it('fails orphaned tasks (queue item finished/deleted/missing), leaves healthy ones alone', async () => {
      h = makeHarness(); // loop NOT started: tasks stay submitted with pending queue items
      const healthy = h.submit('beta', 'healthy')._unsafeUnwrap();
      const completedItem = h.submit('beta', 'item completed')._unsafeUnwrap();
      const deadLettered = h.submit('beta', 'item dead-lettered')._unsafeUnwrap();
      const deleted = h.submit('beta', 'item deleted')._unsafeUnwrap();
      const unattached = h.submit('beta', 'no queue item')._unsafeUnwrap();

      h.queueRepo.complete(h.task(completedItem.taskId).queue_item_id!);
      h.db
        .prepare(`UPDATE queue_items SET status = 'dead_letter' WHERE id = ?`)
        .run(h.task(deadLettered.taskId).queue_item_id!);
      h.db.pragma('foreign_keys = OFF');
      h.db.prepare(`DELETE FROM queue_items WHERE id = ?`).run(h.task(deleted.taskId).queue_item_id!);
      h.db.pragma('foreign_keys = ON');
      h.db.prepare(`UPDATE a2a_tasks SET queue_item_id = NULL WHERE id = ?`).run(unattached.taskId);

      // Within the grace period nothing is reaped.
      expect(h.mapper.reapStaleTasks(Date.now())._unsafeUnwrap()).toEqual([]);

      const reaped = h.mapper.reapStaleTasks(Date.now() + 61_000)._unsafeUnwrap();
      expect(new Set(reaped)).toEqual(
        new Set([completedItem.taskId, deadLettered.taskId, deleted.taskId, unattached.taskId]),
      );
      for (const id of reaped) {
        expect(h.task(id).state).toBe('failed');
        expect(h.task(id).error_code).toBe('ORPHANED');
      }
      expect(h.state(healthy.taskId)).toBe('submitted');
      expect(h.queueRow(h.task(healthy.taskId).queue_item_id!).status).toBe('pending');
    }, TEST_TIMEOUT);

    it('cancels tasks past taskTtlMinutes (aborting the in-flight run) but not a healthy in-flight task before that', async () => {
      h = makeHarness({ limits: { taskTtlMinutes: 10 } });
      const g = h.newGate();
      h.scripts.set('beta', async () => {
        await g.promise;
        return 'too late';
      });
      h.start();

      const running = h.submit('beta', 'in flight')._unsafeUnwrap();
      await waitFor(() => h.calls.beta.length === 1 && h.state(running.taskId) === 'working', 'running');
      const itemId = h.task(running.taskId).queue_item_id!;
      expect(h.queueRow(itemId).status).toMatch(/claimed|processing/);

      // Past the orphan grace, before the TTL: untouched.
      expect(h.mapper.reapStaleTasks(Date.now() + 5 * 60_000)._unsafeUnwrap()).toEqual([]);
      expect(h.state(running.taskId)).toBe('working');

      // Past TTL: canceled and the abort hook fires.
      const reaped = h.mapper.reapStaleTasks(Date.now() + 11 * 60_000)._unsafeUnwrap();
      expect(reaped).toEqual([running.taskId]);
      expect(h.state(running.taskId)).toBe('canceled');
      expect(h.task(running.taskId).error_message).toBe('ttl expired');
      await waitFor(() => h.queueRow(itemId).status === 'completed', 'queue item completed after ttl abort');

      g.resolve();
      await sleep(600);
      expect(h.state(running.taskId)).toBe('canceled');
      expect(h.task(running.taskId).result_payload).toBeNull();
    }, TEST_TIMEOUT);
  });

  // -------------------------------------------------------------------------
  it('9. cancel_on_timeout: alpha gets canceled, beta run is aborted, task row is canceled', async () => {
    h = makeHarness();
    const g = h.newGate();
    h.scripts.set('beta', async () => {
      await g.promise;
      return 'LATE-BETA-RESULT';
    });
    const callerResult = deferred<ToolCallResult>();
    h.scripts.set('alpha', async (call) => {
      callerResult.resolve(
        await call.send({
          target_persona: 'beta',
          message: 'slow job',
          await_reply: true,
          // Long enough (> 2 queue polls) for beta to be claimed and running when it expires.
          timeout_ms: 3000,
          cancel_on_timeout: true,
        }),
      );
      return 'alpha done';
    });
    h.start();
    h.enqueueMessage('alpha', 'go');

    const res = await callerResult.promise;
    const out = output(res);
    expect(res.status).toBe('success');
    expect(out.state).toBe('canceled');
    expect(out.error).toMatch(/canceled/);

    const row = h.task(out.task_id);
    expect(row.state).toBe('canceled');
    expect(row.error_message).toBe('await_reply timed out');
    expect(h.calls.beta).toHaveLength(1);

    // beta's in-flight run is aborted by the runner (queue item completes, run row failed).
    await waitFor(() => h.queueRow(row.queue_item_id!).status === 'completed', 'beta queue item completed');
    expect(h.queueRow(row.queue_item_id!).attempts).toBe(0);
    const betaRun = h.runRepo.findById(row.run_id!)._unsafeUnwrap()!;
    expect(betaRun.status).toBe('failed');
    expect(betaRun.error).toContain('A2A task canceled');

    g.resolve();
    await sleep(800);
    expect(h.state(out.task_id)).toBe('canceled');
    expect(h.task(out.task_id).result_payload).toBeNull();
    expect(h.calls.beta).toHaveLength(1);
  }, TEST_TIMEOUT);
});
