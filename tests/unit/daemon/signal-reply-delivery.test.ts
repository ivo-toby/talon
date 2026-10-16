import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import type Database from 'better-sqlite3';
import pino from 'pino';
import { err, ok, type Result } from 'neverthrow';
import { createTestDb } from '../core/database/repositories/helpers.js';
import { AuditRepository } from '../../../src/core/database/repositories/audit-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import {
  QueueRepository,
  type QueueStatus,
} from '../../../src/core/database/repositories/queue-repository.js';
import { queuePurgeCommand } from '../../../src/cli/commands/queue-purge.js';
import { DaemonIpcServer } from '../../../src/ipc/daemon-ipc-server.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import {
  SignalAccountStateRepository,
  SignalStateError,
} from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { SignalConnector } from '../../../src/channels/connectors/signal/signal-connector.js';
import { SignalDeviceRegistry } from '../../../src/channels/connectors/signal/signal-device-registry.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';
import type { SignalRpcRequest } from '../../../src/channels/connectors/signal/signal-wire.js';
import { SignalInvocationGuard } from '../../../src/daemon/signal-invocation-guard.js';
import {
  SignalReplyDelivery,
  type SignalReplyPreparation,
} from '../../../src/daemon/signal-reply-delivery.js';
import {
  DbError,
  DeliveryCancelled,
  DeliveryDeferredError,
  NonRetryableRunError,
  SignalDeliveryError,
} from '../../../src/core/errors/error-types.js';
import { QueueProcessor } from '../../../src/queue/queue-processor.js';
import { DeadLetterHandler } from '../../../src/queue/dead-letter.js';
import { calculateBackoff } from '../../../src/queue/retry-strategy.js';
import { parseSignalQueuePayload } from '../../../src/queue/signal-delivery-state.js';
import type { SignalReplyDeliveryDependencies } from '../../../src/daemon/signal-reply-delivery.js';
import { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { ChannelRouter } from '../../../src/channels/channel-router.js';
import {
  SIGNAL_DELIVERY_CHECKPOINT_KEY,
  SIGNAL_CHECKPOINT_TEXT_MAX_BYTES,
  SIGNAL_CHECKPOINT_MAX_BYTES,
  SignalCheckpointError,
  parseSignalDeliveryCheckpoint,
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  type SignalDeliveryCheckpoint,
} from '../../../src/queue/signal-delivery-checkpoint.js';

const account = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const target = `signal:v1:${account}:self`;
const initial = 1_000_000;
type Request = SignalRpcRequest & { readonly id: string };

// Source-shaped socket fixtures only, NOT live evidence. v0.14.9 commit
// 3997429779095ff3a2d64c877126e84fce9852aa: VersionCommand.java:60-66;
// ListAccountsCommand.java:12-47; ListDevicesCommand.java:40-67;
// SignalJsonRpcDispatcherHandler.java:255-280; JsonRpcResponse.java:13-46.
// Target: ListContactsCommand.java:30-65,117-167; JsonContact.java:9-29.
// Send: JsonSendMessageResult.java:10-48; JsonRecipientAddress.java:9-15;
// SendMessageResultUtils.java:43-68. Limit: ServiceConfig.java:24,
// ManagerImpl.java:942-975 (over 2000 UTF-8 bytes becomes an attachment).
function success(): unknown {
  return {
    timestamp: 900,
    results: [
      { type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } },
    ],
  };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !predicate(); i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate()).toBe(true);
}

describe('SignalReplyDelivery actual guard/connector/socket/migrated SQLite', () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let accounts: SignalAccountStateRepository;
  let leases: SignalDestinationLeaseRepository;
  let runs: RunRepository;
  let messages: MessageRepository;
  let connector: SignalConnector;
  let connectors: SignalConnector[];
  let server: Server;
  let sockets: Socket[];
  let directory: string;
  let requests: Request[];
  let answer: (request: Request, socket: Socket) => void;
  let actor: SignalReplyDelivery;
  let audit: AuditRepository;
  let guard: SignalInvocationGuard;
  let input: SignalReplyPreparation;
  let phases: string[];
  let rotations: unknown[];
  let sendObservations: unknown[];

  function reply(socket: Socket, request: Request, result: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
  function defaultAnswer(request: Request, socket: Socket): void {
    if (request.method === 'version') reply(socket, request, { version: '0.14.9' });
    else if (request.method === 'listAccounts')
      reply(socket, request, [{ number: null, aci: account }]);
    else if (request.method === 'listDevices')
      reply(socket, request, [
        { id: 1, name: null, createdTimestamp: 100, lastSeenTimestamp: 500 },
        { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 },
      ]);
    else if (request.method === 'subscribeReceive') reply(socket, request, 7);
    else if (request.method === 'listContacts')
      reply(socket, request, [
        {
          uuid: request.params.recipient[0],
          isBlocked: false,
          unregistered: false,
          messageExpirationTime: 0,
        },
      ]);
    else if (request.method === 'listGroups')
      reply(socket, request, [
        {
          // ListGroupsCommand.java:105-179: required membership/provenance and safe timer fields.
          id: request.params.groupId?.[0],
          isMember: true,
          isBlocked: false,
          isTerminated: false,
          messageExpirationTime: 0,
          members: [{ uuid: account, number: null, isAdmin: false }],
          pendingMembers: [],
          requestingMembers: [],
          admins: [],
          banned: [],
          permissionAddMember: 'EVERY_MEMBER',
          permissionEditDetails: 'EVERY_MEMBER',
          permissionSendMessage: 'EVERY_MEMBER',
        },
      ]);
    else if (request.method === 'send') {
      sendObservations.push(queue.inspectSignalDelivery('queue', Date.now()));
      reply(socket, request, success());
    } else reply(socket, request, {});
  }
  function createConnector(): SignalConnector {
    const config = SignalConfigSchema.parse({
      accountMode: 'personal',
      socketPath: join(directory, 'rpc.sock'),
      account,
      accountUuid: account,
      deviceId: 3,
      deviceCreatedTimestamp: 200,
      allowedGroups: ['QQ==', 'Qg=='],
    });
    const next = new SignalConnector(config, 'signal-test', pino({ level: 'silent' }), {
      queue,
      accounts,
      leases,
      registry: SignalDeviceRegistry.create(1, [config])._unsafeUnwrap(),
      random: () => 0.5,
      monotonicNow: () => performance.now(),
    });
    next.onMessageWithReceipt(() => ok('accepted'));
    connectors.push(next);
    return next;
  }
  function persist(
    phase: 'prepared' | 'delivered',
    checkpoint: SignalDeliveryCheckpoint,
  ): Result<void, Error> {
    phases.push(phase);
    if (phase === 'prepared') {
      if (checkpoint.runId === undefined) return ok(undefined);
      return runs
        .updateTokens(checkpoint.runId, { input_tokens: 123, output_tokens: 45 })
        .andThen(() => runs.updateSessionId(checkpoint.runId!, 'session-result'));
    }
    const key: Result<string, Error> =
      checkpoint.runId === undefined
        ? queue.findById(checkpoint.queueItemId).andThen((row) => {
            if (row === null) return err(new DeliveryCancelled());
            return parseSignalQueuePayload(row.payload).andThen((notification) => {
              if (
                row.type !== 'collaboration' ||
                notification.kind !== 'background_task_notification' ||
                typeof notification.content !== 'string' ||
                typeof notification.taskId !== 'string' ||
                typeof notification.status !== 'string'
              )
                return err(new SignalCheckpointError('INVALID'));
              return ok(`background-task:${notification.taskId}:${notification.status}`);
            });
          })
        : ok(`outbound:${checkpoint.runId}`);
    if (key.isErr()) return err(key.error);
    return messages
      .insert({
        id: `history-${checkpoint.deliveryId}`,
        thread_id: checkpoint.threadId,
        direction: 'outbound',
        content: JSON.stringify({ body: checkpoint.body }),
        idempotency_key: key.value,
        provider_id: null,
        run_id: checkpoint.runId ?? null,
      })
      .andThen(() =>
        checkpoint.runId === undefined
          ? ok(undefined)
          : runs
              .updateStatus(checkpoint.runId, 'completed', { ended_at: Date.now() })
              .map(() => undefined),
      );
  }
  function createActor(
    overrides: Partial<SignalReplyDeliveryDependencies> = {},
  ): SignalReplyDelivery {
    return new SignalReplyDelivery({
      queue,
      audit,
      resolve: () => ok(connector),
      persist,
      afterFinalize: async (checkpoint) => {
        rotations.push({
          history: messages.findByThread(checkpoint.threadId, 100, 0)._unsafeUnwrap(),
          run:
            checkpoint.runId === undefined ? null : runs.findById(checkpoint.runId)._unsafeUnwrap(),
          queue: queue.findById(checkpoint.queueItemId)._unsafeUnwrap()?.status,
        });
      },
      ...overrides,
    });
  }
  async function finish<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    for (let i = 0; i < 200 && !done; i++) {
      for (let j = 0; j < 10; j++) await new Promise<void>((resolve) => setImmediate(resolve));
      if (!done) await vi.advanceTimersByTimeAsync(1000);
    }
    expect(done).toBe(true);
    return promise;
  }
  function checkpoint(id = 'queue'): SignalDeliveryCheckpoint {
    const state = queue.inspectSignalDelivery(id, Date.now())._unsafeUnwrap();
    if (state.kind !== 'checkpoint') throw new Error('Expected checkpoint fixture');
    return state.checkpoint;
  }
  function accepted(saved: SignalDeliveryCheckpoint): SignalDeliveryCheckpoint {
    const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
    const ownership = queue.beginSignalChunk(saved, state.revision, Date.now())._unsafeUnwrap();
    return queue
      .settleSignalChunk(ownership, { kind: 'accepted', successCount: 1 }, Date.now())
      ._unsafeUnwrap();
  }
  function extra(
    id: string,
    destination: string,
    kind: 'reply' | 'background' = 'background',
  ): { input: SignalReplyPreparation; guard: SignalInvocationGuard } {
    const threads = new ThreadRepository(db);
    const existing = threads.findByExternalId('channel', destination)._unsafeUnwrap();
    const threadId = existing?.id ?? `thread-${id}`;
    if (existing === null)
      threads
        .insert({ id: threadId, channel_id: 'channel', external_id: destination, metadata: '{}' })
        ._unsafeUnwrap();
    queue
      .enqueue({
        id,
        thread_id: threadId,
        type: kind === 'background' ? 'collaboration' : 'message',
        message_id: null,
        max_attempts: 3,
        payload: JSON.stringify({
          kind: 'background_task_notification',
          taskId: id,
          status: 'completed',
          content: 'background body',
          personaId: 'persona',
        }),
      })
      ._unsafeUnwrap();
    const entry = SignalInvocationGuard.enter(queue, id)._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected extra execution');
    if (kind === 'reply') {
      runs
        .insert({
          id: `run-${id}`,
          thread_id: threadId,
          persona_id: 'persona',
          provider_name: 'fixture',
          sandbox_id: null,
          session_id: null,
          status: 'running',
          parent_run_id: null,
          queue_item_id: id,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: 0,
          error: null,
          started_at: initial,
          ended_at: null,
        })
        ._unsafeUnwrap();
      entry.guard.attachRunId(`run-${id}`)._unsafeUnwrap();
    }
    return {
      input: {
        ...input,
        queueItemId: id,
        threadId,
        deliveryId: `delivery-${id}`,
        destination,
        kind,
        body: `background ${id}`,
      },
      guard: entry.guard,
    };
  }
  function remote(socket: Socket, request: Request, code: number, results?: unknown[]): void {
    // SignalJsonRpcCommandHandler.java:249-290: error.data.response, never success-envelope coercion.
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message: 'private remote challenge', data: { response: results === undefined ? undefined : { timestamp: 900, results } } } })}\n`,
    );
  }
  async function purgeViaCli(all: boolean): Promise<void> {
    const ipcDir = join(directory, 'ipc');
    const statuses: QueueStatus[] = all
      ? ['pending', 'claimed', 'processing', 'completed', 'failed', 'dead_letter']
      : ['pending', 'failed', 'completed'];
    const ipc = new DaemonIpcServer({
      inputDir: join(ipcDir, 'input'),
      outputDir: join(ipcDir, 'output'),
      errorsDir: join(ipcDir, 'errors'),
      logger: pino({ level: 'silent' }),
      commandHandler: async (command) => {
        // Disposable fixture connects the ACTUAL file parser/CLI to the ACTUAL queue method.
        // Does not claim daemon authentication/runtime handler wiring (011/012).
        const valid =
          command.command === 'queue-purge' &&
          JSON.stringify(command.payload?.statuses) === JSON.stringify(statuses);
        const result = valid
          ? queue.purge(statuses)
          : err(new DbError('Unexpected fixture command'));
        return {
          id: randomUUID(),
          commandId: command.id,
          success: result.isOk(),
          ...(result.isOk()
            ? { data: { purged: result.value, statuses } }
            : { error: 'fixture refused' }),
        };
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const command = queuePurgeCommand({ ipcDir, all });
    await until(
      () =>
        fs.existsSync(join(ipcDir, 'input')) &&
        fs.readdirSync(join(ipcDir, 'input')).some((file) => file.endsWith('.json')),
    );
    const processed = await ipc.pollOnce();
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatchObject({ command: 'queue-purge', payload: { statuses } });
    await finish(command);
    expect(log.mock.calls.some(([line]) => String(line) === 'Purged 1 queue items.')).toBe(true);
    log.mockRestore();
  }
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(initial);
    db = createTestDb();
    queue = new QueueRepository(db);
    audit = new AuditRepository(db);
    accounts = new SignalAccountStateRepository(db);
    leases = new SignalDestinationLeaseRepository(db);
    runs = new RunRepository(db);
    messages = new MessageRepository(db);
    new ChannelRepository(db)
      .insert({
        id: 'channel',
        name: 'signal-test',
        type: 'signal',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    new ThreadRepository(db)
      .insert({ id: 'thread', channel_id: 'channel', external_id: target, metadata: '{}' })
      ._unsafeUnwrap();
    new PersonaRepository(db)
      .insert({
        id: 'persona',
        name: 'fixture',
        model: 'fixture',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
    queue
      .enqueue({
        id: 'queue',
        thread_id: 'thread',
        message_id: null,
        type: 'message',
        payload: JSON.stringify({ personaId: 'persona', content: 'command', untouched: true }),
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    runs
      .insert({
        id: 'run',
        thread_id: 'thread',
        persona_id: 'persona',
        provider_name: 'fixture',
        sandbox_id: null,
        session_id: null,
        status: 'running',
        parent_run_id: null,
        queue_item_id: 'queue',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        error: null,
        started_at: initial,
        ended_at: null,
      })
      ._unsafeUnwrap();
    const entry = SignalInvocationGuard.enter(queue, 'queue')._unsafeUnwrap();
    if (entry.kind !== 'execution') throw new Error('Expected live execution fixture');
    guard = entry.guard;
    guard.attachRunId('run')._unsafeUnwrap();
    input = {
      queueItemId: 'queue',
      deliveryId: 'delivery',
      kind: 'reply',
      personaId: 'persona',
      threadId: 'thread',
      channelName: 'signal-test',
      accountUuid: account,
      destination: target,
      body: '**original** 😀',
    };
    phases = [];
    rotations = [];
    sendObservations = [];
    requests = [];
    sockets = [];
    connectors = [];
    answer = defaultAnswer;
    directory = fs.mkdtempSync(join(homedir(), '.sig-reply-'));
    fs.chmodSync(directory, 0o700);
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)) as Request;
          buffer = buffer.slice(end + 1);
          requests.push(request);
          answer(request, socket);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(directory, 'rpc.sock'), resolve);
    });
    fs.chmodSync(join(directory, 'rpc.sock'), 0o600);
    connector = createConnector();
    await connector.start();
    await until(() => connector.status().state === 'ready');
    actor = createActor();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    guard.close();
    await finish(Promise.all(connectors.map((value) => value.stopWithResult())));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
    if (db.open) db.close();
    vi.useRealTimers();
  });

  it('persists exact original body and actual prepared fixed chunks/TTL before any bytes', async () => {
    const preparation = await actor.prepare(input, guard);
    expect(preparation.isOk()).toBe(true);
    const prepared = preparation._unsafeUnwrap();
    expect(prepared).toMatchObject({
      body: '**original** 😀',
      chunks: ['original 😀'],
      createdAt: initial,
      expiresAt: initial + SIGNAL_CHECKPOINT_LIFETIME_MS,
      runId: 'run',
      phase: 'ready',
    });
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
    expect((await finish(actor.deliver('queue', guard))).isOk()).toBe(true);
    expect(sendObservations).toHaveLength(1);
    expect(sendObservations[0]).toMatchObject({
      value: {
        kind: 'checkpoint',
        checkpoint: { body: input.body, chunks: ['original 😀'], phase: 'in_flight' },
      },
    });
    expect(JSON.parse(queue.findById('queue')._unsafeUnwrap()!.payload).untouched).toBe(true);
  });

  it('retains generated text through actual SQLite initial write failure and repairs only that transition', async () => {
    db.pragma('query_only = ON');
    const pending = actor.prepare(input, guard);
    await Promise.resolve();
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
      kind: 'ordinary',
    });
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
    db.pragma('query_only = OFF');
    const preparation = await finish(pending);
    expect(preparation.isOk()).toBe(true);
    const checkpoint = preparation._unsafeUnwrap();
    expect(checkpoint.body).toBe(input.body);
    expect(checkpoint.createdAt).toBe(initial);
    expect(runs.findById('run')._unsafeUnwrap()).toMatchObject({
      status: 'running',
      input_tokens: 123,
      session_id: 'session-result',
    });
    expect((await finish(actor.deliver('queue', guard))).isOk()).toBe(true);
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
  });

  it('finalizes delivered current state only once, history/full body before best-effort rotation', async () => {
    expect((await actor.prepare(input, guard)).isOk()).toBe(true);
    expect((await finish(actor.deliver('queue', guard))).isOk()).toBe(true);
    expect((await actor.deliver('queue')).isOk()).toBe(true);
    expect(phases).toEqual(['prepared', 'delivered']);
    expect(messages.findByThread('thread', 100, 0)._unsafeUnwrap()).toMatchObject([
      {
        content: JSON.stringify({ body: input.body }),
        idempotency_key: 'outbound:run',
        run_id: 'run',
      },
    ]);
    expect(rotations).toMatchObject([
      {
        history: [{ content: JSON.stringify({ body: input.body }) }],
        run: { status: 'completed' },
        queue: 'completed',
      },
    ]);
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
  });

  it('prepares and delivers background output without inventing a run/session', async () => {
    const work = extra('background', `signal:v1:${account}:group:QQ`);
    const before = runs.findByThread(work.input.threadId)._unsafeUnwrap();
    const saved = (await actor.prepare(work.input, work.guard))._unsafeUnwrap();
    expect(saved.runId).toBeUndefined();
    expect((await finish(actor.deliver(work.input.queueItemId, work.guard))).isOk()).toBe(true);
    expect(runs.findByThread(work.input.threadId)._unsafeUnwrap()).toEqual(before);
    expect(before).toEqual([]);
    expect(messages.findByThread(work.input.threadId, 20, 0)._unsafeUnwrap()).toMatchObject([
      {
        run_id: null,
        idempotency_key: 'background-task:background:completed',
        content: JSON.stringify({ body: work.input.body }),
      },
    ]);
    work.guard.close();
  });

  it('resumes only the saved ready cursor, never prepare/format or accepted chunks again', async () => {
    input = { ...input, body: '😀'.repeat(600) };
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    const ready = accepted(saved);
    expect(ready).toMatchObject({ nextChunk: 1, acceptedChunks: 1, phase: 'ready' });
    const prepare = vi.spyOn(connector, 'prepare');
    expect((await finish(actor.deliver('queue'))).isOk()).toBe(true);
    const sends = requests.filter((r) => r.method === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ params: { message: saved.chunks[1] } });
    expect(prepare).not.toHaveBeenCalled();
    expect(checkpoint()).toMatchObject({
      nextChunk: 2,
      successCount: 2,
      phase: 'delivered',
      body: input.body,
      expiresAt: saved.expiresAt,
    });
  });

  it('keeps terminal PARTIAL/UNKNOWN and permanent target refusal terminal without history or continuation', async () => {
    input = { ...input, body: 'x'.repeat(4100) };
    (await actor.prepare(input, guard))._unsafeUnwrap();
    let sends = 0;
    answer = (request, socket) => {
      if (request.method !== 'send' || ++sends === 1) defaultAnswer(request, socket);
      else
        reply(socket, request, {
          timestamp: 900,
          results: [
            { type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } },
            {
              type: 'IDENTITY_FAILURE',
              recipientAddress: { uuid: account, number: null, username: null },
            },
          ],
        });
    };
    const result = await finish(actor.deliver('queue', guard));
    expect(result._unsafeUnwrapErr()).toMatchObject({
      deliveryError: {
        outcome: 'PARTIAL',
        currentChunkAcceptance: 'partial',
        acceptedChunks: 1,
        successCount: 2,
        failureCount: 1,
      },
    });
    expect(checkpoint()).toMatchObject({ phase: 'terminal', nextChunk: 1 });
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toBeInstanceOf(NonRetryableRunError);
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(2);
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('failed');
  });

  it.each(['network', 'empty', 'timeout'] as const)(
    'makes %s acceptance terminal UNKNOWN and never resends',
    async (outcome) => {
      input = { ...input, body: 'x'.repeat(2100) };
      (await actor.prepare(input, guard))._unsafeUnwrap();
      answer = (request, socket) => {
        if (request.method !== 'send') defaultAnswer(request, socket);
        else if (outcome !== 'timeout')
          reply(socket, request, {
            timestamp: 900,
            results:
              outcome === 'empty'
                ? []
                : [
                    {
                      type: 'NETWORK_FAILURE',
                      recipientAddress: { uuid: account, number: null, username: null },
                    },
                  ],
          });
      };
      const result = await finish(actor.deliver('queue', guard));
      expect(result._unsafeUnwrapErr()).toMatchObject({
        deliveryError: { outcome: 'UNKNOWN', retryScope: 'none' },
      });
      expect(checkpoint().phase).toBe('terminal');
      expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('recovery');
      expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
      expect((await actor.deliver('queue')).isErr()).toBe(true);
      expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    },
  );

  it('blocks unknown-owner in_flight untouched; explicitly cold producer recovery alone terminalizes UNKNOWN', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    // Actual public producer ownership, but NO live transport/old callback exists in this cold fixture.
    const state = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
    queue.beginSignalChunk(saved, state.revision, Date.now())._unsafeUnwrap();
    const before = queue.findById('queue')._unsafeUnwrap();
    const reservation = accounts.findByAccount(account)._unsafeUnwrap();
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toMatchObject({ reason: 'CONFLICT' });
    expect(queue.findById('queue')._unsafeUnwrap()).toEqual(before);
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(reservation);
    // No live sends/actors remain; test driver explicitly stops actual connector before cold recovery.
    expect((await connector.stopWithResult()).isOk()).toBe(true);
    queue.recoverSignalQueue(Date.now())._unsafeUnwrap();
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toMatchObject({
      deliveryError: { outcome: 'UNKNOWN' },
    });
    expect(audit.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
    expect(JSON.parse(audit.findByThread('thread')._unsafeUnwrap()[0]!.details)).toMatchObject({
      reason: 'UNKNOWN_ACCEPTANCE',
      outcome: 'UNKNOWN',
    });
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
  });

  it('expires unsent saved work at the original inclusive deadline without RPC/history', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    vi.setSystemTime(saved.expiresAt);
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toMatchObject({
      deliveryError: { reason: 'CHECKPOINT_EXPIRED' },
    });
    expect(checkpoint()).toMatchObject({ phase: 'terminal', expiresAt: saved.expiresAt });
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
    expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('failed');
  });

  it('finalizes already delivered work even after TTL with no connector resolution', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    accepted(saved);
    vi.setSystemTime(saved.expiresAt + 1);
    actor = createActor({
      resolve: () => {
        throw new Error('must not resolve delivered');
      },
    });
    expect((await actor.deliver('queue')).isOk()).toBe(true);
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toHaveLength(1);
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
  });

  it.each([SIGNAL_CHECKPOINT_TEXT_MAX_BYTES - 1, SIGNAL_CHECKPOINT_TEXT_MAX_BYTES])(
    'admits %i original/formatted UTF-8 bytes inclusively with exact fixed Unicode chunks',
    async (bytes) => {
      input = { ...input, body: '😀'.repeat(Math.floor(bytes / 4)) + 'x'.repeat(bytes % 4) };
      const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
      expect(saved.body).toBe(input.body);
      expect(saved.chunks.join('')).toBe(input.body);
      expect(
        saved.chunks.every(
          (chunk) =>
            Buffer.byteLength(chunk) <= 2000 && Buffer.from(chunk).toString('utf8') === chunk,
        ),
      ).toBe(true);
      expect(Buffer.byteLength(saved.body)).toBe(bytes);
      expect(requests.filter((r) => r.method === 'send')).toEqual([]);
    },
  );

  it.each(['oversize', 'codec', 'unicode'] as const)(
    'refuses %s output before bytes, without truncating or partial checkpoint',
    async (kind) => {
      input = {
        ...input,
        body:
          kind === 'oversize'
            ? 'x'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES + 1)
            : kind === 'codec'
              ? '\u0000'.repeat(300_000)
              : '\ud800',
      };
      const result = await actor.prepare(input, guard);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        kind === 'codec' ? SignalCheckpointError : SignalDeliveryError,
      );
      expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
        kind: 'ordinary',
      });
      expect(requests.filter((r) => r.method === 'send')).toEqual([]);
      expect(runs.findById('run')._unsafeUnwrap()?.input_tokens).toBe(0);
    },
  );

  it('current persisted checkpoint wins stale preparation/body/catches without calling preparation twice', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    const prepare = vi.spyOn(connector, 'prepare');
    const latest = (
      await actor.prepare(
        { ...input, body: 'stale different generated output', deliveryId: 'stale-id' },
        guard,
      )
    )._unsafeUnwrap();
    expect(latest).toEqual(saved);
    expect(prepare).not.toHaveBeenCalled();
    expect(phases).toEqual(['prepared']);
  });

  it('rolls back actual history/run and queue completion on expected callback Err, then retries local writes only', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    accepted(saved);
    const expected = new DbError('safe expected fixture failure');
    actor = createActor({
      persist: (phase, current) => persist(phase, current).andThen(() => err(expected)),
    });
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toBe(expected);
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    expect(runs.findById('run')._unsafeUnwrap()).toMatchObject({
      status: 'running',
      input_tokens: 123,
      session_id: 'session-result',
    });
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('pending');
    expect(rotations).toEqual([]);
    actor = createActor();
    expect((await actor.deliver('queue')).isOk()).toBe(true);
    expect((await actor.deliver('queue')).isOk()).toBe(true);
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toHaveLength(1);
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
    expect(phases.filter((phase) => phase === 'prepared')).toHaveLength(1);
  });

  it('sanitizes thrown callback diagnostics and rolls back its actual writes without losing expected Err identity', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    accepted(saved);
    actor = createActor({
      persist: (phase, current) => {
        persist(phase, current);
        throw new Error('private arbitrary challenge body');
      },
    });
    const error = (await actor.deliver('queue'))._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(NonRetryableRunError);
    expect(error.message).not.toContain('private');
    expect(error.cause).toBeUndefined();
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('running');
  });

  it('does not undo committed finalization or repeat rotation when best-effort rotation throws', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    accepted(saved);
    let attempts = 0;
    actor = createActor({
      afterFinalize: async () => {
        attempts++;
        throw new Error('rotation unavailable');
      },
    });
    expect((await actor.deliver('queue')).isOk()).toBe(true);
    expect((await actor.deliver('queue')).isOk()).toBe(true);
    expect(attempts).toBe(1);
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('completed');
  });

  it('retains typed delivery-only restriction and cursor after a server rate refusal instead of retrying inside the actor', async () => {
    (await actor.prepare(input, guard))._unsafeUnwrap();
    answer = (request, socket) =>
      request.method === 'send'
        ? remote(socket, request, -5, [
            {
              type: 'RATE_LIMIT_FAILURE',
              retryAfterSeconds: 1800,
              recipientAddress: { uuid: account, number: null, username: null },
            },
          ])
        : defaultAnswer(request, socket);
    const result = await finish(actor.deliver('queue', guard));
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(DeliveryDeferredError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      deliveryError: {
        reason: 'RATE_LIMITED',
        currentChunkAcceptance: 'refused',
        retryScope: 'delivery_only',
      },
    });
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
    expect(checkpoint()).toMatchObject({ phase: 'ready', nextChunk: 0 });
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      pauseKind: 'rate_limit',
      notBefore: initial + 1800_000,
    });
    expect(Date.now()).toBeLessThan(initial + 10_000);
  });

  it('retains the original producer known complete outcome through real SQLite settlement failure and DB-only public repair', async () => {
    (await actor.prepare(input, guard))._unsafeUnwrap();
    const original = connector;
    const repair = vi.spyOn(original, 'retryStateWrites');
    answer = (request, socket) => {
      if (request.method !== 'send') return defaultAnswer(request, socket);
      db.pragma('query_only = ON');
      reply(socket, request, success());
    };
    const pending = actor.deliver('queue', guard);
    await until(() => requests.some((r) => r.method === 'send'));
    await vi.advanceTimersByTimeAsync(6500);
    expect(checkpoint().phase).toBe('in_flight');
    expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).not.toBeNull();
    expect(repair).toHaveBeenCalled();
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    db.pragma('query_only = OFF');
    expect((await finish(pending)).isOk()).toBe(true);
    expect(checkpoint()).toMatchObject({ phase: 'delivered', successCount: 1, nextChunk: 1 });
    expect(accounts.findByAccount(account)._unsafeUnwrap()).toMatchObject({
      reservation: null,
      recoveryNotBefore: 0,
    });
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
    expect((await original.stopWithResult()).isOk()).toBe(true);
  });

  it('preserves a verifier repair Err even when the actual sender repair commits its known receipt', async () => {
    (await actor.prepare(input, guard))._unsafeUnwrap();
    // Retain ACTUAL obligations in BOTH producers, not a fake healthy/empty result.
    let sending: { request: Request; socket: Socket } | undefined;
    let checking: { request: Request; socket: Socket } | undefined;
    answer = (request, socket) => {
      if (request.method === 'send') sending = { request, socket };
      else if (request.method === 'listDevices') checking = { request, socket };
      else defaultAnswer(request, socket);
    };
    const pending = actor.deliver('queue', guard);
    await until(() => sending !== undefined);
    vi.setSystemTime(initial + 60_000); // elapsed persisted server-check budget, not RPC timer advancement
    const verification = connector.requestVerificationRefresh();
    await until(() => checking !== undefined);
    db.pragma('query_only = ON');
    if (checking === undefined || sending === undefined)
      throw new Error('Missing actual pending requests');
    remote(checking.socket, checking.request, -6);
    reply(sending.socket, sending.request, success());
    expect((await verification).isErr()).toBe(true);
    const stopping = connector.stopWithResult();
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await stopping).isErr()).toBe(true);
    db.pragma('query_only = OFF');
    const result = await finish(pending);
    expect(result.isErr()).toBe(true);
    expect(checkpoint().phase).toBe('delivered');
    expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'STALE_CONNECTION' });
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    expect((await connector.stopWithResult()).isOk()).toBe(true);
    expect((await actor.deliver('queue')).isOk()).toBe(true);
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
  });

  it('commits prepared usage/session effects once despite a rolled-back DB callback attempt', async () => {
    const failure = new DbError('safe prepared callback DB failure');
    let first = true;
    actor = createActor({
      persist: (phase, current) => {
        const writes = persist(phase, current);
        if (phase === 'prepared' && first) {
          first = false;
          return writes.andThen(() => err(failure));
        }
        return writes;
      },
    });
    const pending = actor.prepare(input, guard);
    await Promise.resolve();
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap()).toEqual({
      kind: 'ordinary',
    });
    expect(runs.findById('run')._unsafeUnwrap()).toMatchObject({
      input_tokens: 0,
      session_id: null,
      status: 'running',
    });
    const saved = (await finish(pending))._unsafeUnwrap();
    expect(saved.createdAt).toBe(initial);
    expect(runs.findById('run')._unsafeUnwrap()).toMatchObject({
      input_tokens: 123,
      session_id: 'session-result',
      status: 'running',
    });
    expect((await finish(actor.deliver('queue', guard))).isOk()).toBe(true);
    expect(runs.findById('run')._unsafeUnwrap()).toMatchObject({
      input_tokens: 123,
      output_tokens: 45,
      status: 'completed',
    });
    expect(phases).toEqual(['prepared', 'prepared', 'delivered']); // committed effects, NOT callback invocation count
  });

  it('actual QueueProcessor defers >3 times with default maxAttempts3 unchanged, then default purge permanently cancels', async () => {
    (await actor.prepare(input, guard))._unsafeUnwrap();
    expect((await connector.stopWithResult()).isOk()).toBe(true);
    const logger = pino({ level: 'silent' });
    const processor = new QueueProcessor(
      queue,
      calculateBackoff,
      new DeadLetterHandler(queue, logger),
      logger,
    );
    const ordinary = vi.fn(async () => err(new Error('ordinary execution forbidden')));
    for (let i = 0; i < 5; i++) {
      expect(
        await finish(processor.processNext(ordinary, (item) => actor.deliver(item.id))),
      ).not.toBeNull();
      const row = queue.findById('queue')._unsafeUnwrap()!;
      expect(row).toMatchObject({
        status: 'failed',
        attempts: 0,
        max_attempts: 3,
        error: 'SIGNAL_DELIVERY_DEFERRED',
      });
      expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('running');
      vi.setSystemTime(row.next_retry_at!);
    }
    expect(ordinary).not.toHaveBeenCalled(); // actual queue routing, not an AgentRunner/provider call-count claim
    expect(phases).toEqual(['prepared']);
    await purgeViaCli(false);
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
    expect(runs.findById('run')._unsafeUnwrap()).toMatchObject({
      status: 'cancelled',
      queue_item_id: null,
    });
    expect(queue.findById('queue')._unsafeUnwrap()).toBeNull();
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
  });

  it.each(['complete', 'unknown'] as const)(
    'actual --all selection purge during submitted RPC preserves late %s classification but no body/history/run revival or next chunk',
    async (outcome) => {
      input = { ...input, body: 'x'.repeat(4100) };
      (await actor.prepare(input, guard))._unsafeUnwrap();
      let held: { request: Request; socket: Socket } | undefined;
      answer = (request, socket) => {
        if (request.method === 'send') held = { request, socket };
        else defaultAnswer(request, socket);
      };
      const logger = pino({ level: 'silent' });
      const processor = new QueueProcessor(
        queue,
        calculateBackoff,
        new DeadLetterHandler(queue, logger),
        logger,
      );
      const pending = processor.processNext(
        async () => err(new Error('must route saved')),
        (item) => actor.deliver(item.id),
      );
      await until(() => held !== undefined);
      expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('claimed');
      await purgeViaCli(true);
      if (held === undefined) throw new Error('Missing submitted fixture');
      reply(
        held.socket,
        held.request,
        outcome === 'complete' ? success() : { timestamp: 900, results: [] },
      );
      expect(await finish(pending)).not.toBeNull();
      expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
      expect(queue.findById('queue')._unsafeUnwrap()).toBeNull();
      expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
      expect(runs.findById('run')._unsafeUnwrap()).toMatchObject({
        status: 'cancelled',
        queue_item_id: null,
      });
      expect(accounts.findByAccount(account)._unsafeUnwrap()?.reservation).toBeNull();
      expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
      expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
      if (outcome === 'unknown')
        expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe('recovery');
    },
  );

  it('purge during initial write backoff is cancellation, never a checkpoint/body/usage resurrection', async () => {
    db.pragma('query_only = ON');
    const pending = actor.prepare(input, guard);
    await Promise.resolve();
    db.pragma('query_only = OFF');
    queue.purge(['pending'])._unsafeUnwrap();
    expect((await finish(pending))._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
    expect(queue.findById('queue')._unsafeUnwrap()).toBeNull();
    expect(runs.findById('run')._unsafeUnwrap()?.input_tokens).toBe(0);
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
  });

  it('same conversation retains whole-message lease across four chunks/background/cross-thread explicit while a different group progresses', async () => {
    const groupA = `signal:v1:${account}:group:QQ`;
    const groupB = `signal:v1:${account}:group:Qg`;
    const a = extra('a', groupA, 'reply');
    const b = extra('b', groupB, 'reply');
    const bg = extra('notification', groupA);
    const explicit = extra('explicit', groupB);
    const aInput = { ...a.input, body: 'A'.repeat(6100) };
    const bInput = { ...b.input, body: 'B'.repeat(2100) };
    (await actor.prepare(aInput, a.guard))._unsafeUnwrap();
    (await actor.prepare(bInput, b.guard))._unsafeUnwrap();
    (await actor.prepare(bg.input, bg.guard))._unsafeUnwrap();
    let first: { request: Request; socket: Socket } | undefined;
    answer = (request, socket) => {
      if (request.method === 'send' && first === undefined) first = { request, socket };
      else defaultAnswer(request, socket);
    };
    const aPending = actor.deliver(aInput.queueItemId, a.guard);
    await until(() => first !== undefined); // A has the actual lease/reservation before competitors enter.
    const competitors = [
      actor.deliver(bInput.queueItemId, b.guard),
      actor.deliver(bg.input.queueItemId, bg.guard),
      explicit.guard.invoke(
        {
          deliveryId: 'cross-thread-explicit',
          purpose: 'explicit',
          accountUuid: account,
          destination: groupA,
        },
        (trustedDelivery) =>
          connector.send(groupA, { body: 'explicit cross-thread', trustedDelivery }),
      ),
    ];
    if (first === undefined) throw new Error('Missing first send');
    reply(first.socket, first.request, success());
    const results = await finish(Promise.all([aPending, ...competitors]));
    expect(results.every((result) => result.isOk())).toBe(true);
    const sends = requests.filter(
      (r): r is Extract<Request, { method: 'send' }> => r.method === 'send',
    );
    const toA = sends.filter((r) => 'groupId' in r.params && r.params.groupId === 'QQ==');
    expect(toA.slice(0, 4).map((r) => r.params.message)).toEqual([
      'A'.repeat(2000),
      'A'.repeat(2000),
      'A'.repeat(2000),
      'A'.repeat(100),
    ]);
    expect(
      toA
        .slice(4)
        .map((r) => r.params.message)
        .sort(),
    ).toEqual([bg.input.body, 'explicit cross-thread'].sort());
    const aEnd = sends.findIndex((r) => r.params.message === 'A'.repeat(100));
    expect(
      sends.slice(0, aEnd).some((r) => 'groupId' in r.params && r.params.groupId === 'Qg=='),
    ).toBe(true);
    expect(checkpoint(aInput.queueItemId).phase).toBe('delivered');
    expect(checkpoint(bInput.queueItemId).phase).toBe('delivered');
    expect(leases.find(account, groupA)._unsafeUnwrap()).toBeNull();
    for (const work of [a, b, bg, explicit]) work.guard.close();
  });

  it('re-resolves the real named registry after old-owner quiesce/drain; accepted cursor survives replacement without reformat', async () => {
    input = { ...input, body: 'z'.repeat(4100) };
    const registry = new ChannelRegistry(pino({ level: 'silent' }));
    registry.register(connector);
    const selected: SignalConnector[] = [];
    actor = createActor({
      resolve: (identity) => {
        const current = registry.get(identity.channelName);
        if (!(current instanceof SignalConnector))
          return err(
            new SignalDeliveryError({
              reason: 'UNAVAILABLE',
              outcome: 'NOT_SENT',
              acceptedChunks: 0,
              currentChunkAcceptance: 'unwritten',
              successCount: 0,
              failureCount: 0,
              retryScope: 'delivery_only',
            }),
          );
        selected.push(current);
        return ok(current);
      },
    });
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    let held: { request: Request; socket: Socket } | undefined;
    answer = (request, socket) => {
      if (request.method === 'send') held = { request, socket };
      else defaultAnswer(request, socket);
    };
    const old = connector;
    const pending = actor.deliver('queue', guard);
    await until(() => held !== undefined);
    const stopping = old.stopWithResult(); // irreversible quiesce BEFORE authority replacement
    if (held === undefined) throw new Error('Missing held send');
    reply(held.socket, held.request, success());
    expect((await finish(pending))._unsafeUnwrapErr()).toBeInstanceOf(DeliveryDeferredError);
    expect((await finish(stopping)).isOk()).toBe(true); // not health/count0 or ordinary stop
    expect(checkpoint()).toMatchObject({ phase: 'ready', nextChunk: 1, acceptedChunks: 1 });
    registry.unregister('signal-test');
    connector = createConnector();
    registry.register(connector);
    vi.setSystemTime(Date.now() + 60_000); // preserve producer device-check budget on replacement
    answer = defaultAnswer;
    await connector.start();
    await until(() => connector.status().state === 'ready');
    const prepare = vi.spyOn(connector, 'prepare');
    expect((await finish(actor.deliver('queue'))).isOk()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(selected).toContain(old);
    expect(selected.slice(-2)).toEqual([connector, connector]);
    expect(
      requests
        .filter((r): r is Extract<Request, { method: 'send' }> => r.method === 'send')
        .map((r) => r.params.message),
    ).toEqual(saved.chunks);
    expect(checkpoint().expiresAt).toBe(saved.expiresAt);
  });

  it('rechecks actual binding resolution after a wait and quiesce, never dispatching the next chunk under revoked authority', async () => {
    const bindings = new BindingRepository(db);
    bindings
      .insert({
        id: 'binding',
        channel_id: 'channel',
        thread_id: 'thread',
        persona_id: 'persona',
        is_default: 0,
      })
      ._unsafeUnwrap();
    const router = new ChannelRouter(bindings, pino({ level: 'silent' }));
    const resolutions: unknown[] = [];
    actor = createActor({
      resolve: (identity) =>
        router.resolvePersona('channel', identity.threadId).andThen((persona) => {
          resolutions.push(persona);
          return persona === identity.personaId
            ? ok(connector)
            : err(
                new SignalDeliveryError({
                  reason: 'TARGET_REFUSED',
                  outcome: 'NOT_SENT',
                  acceptedChunks: 0,
                  currentChunkAcceptance: 'unwritten',
                  successCount: 0,
                  failureCount: 0,
                  retryScope: 'none',
                }),
              );
        }),
    });
    input = { ...input, body: 'q'.repeat(2100) };
    (await actor.prepare(input, guard))._unsafeUnwrap();
    let held: { request: Request; socket: Socket } | undefined;
    answer = (request, socket) => {
      if (request.method === 'send') held = { request, socket };
      else defaultAnswer(request, socket);
    };
    const pending = actor.deliver('queue', guard);
    await until(() => held !== undefined);
    const stopping = connector.stopWithResult();
    bindings.delete('binding')._unsafeUnwrap(); // old sender already quiesced; one submitted chunk may settle
    if (held === undefined) throw new Error('Missing held fixture');
    reply(held.socket, held.request, success());
    expect((await finish(pending))._unsafeUnwrapErr()).toMatchObject({
      deliveryError: { reason: 'TARGET_REFUSED', outcome: 'PARTIAL', acceptedChunks: 1 },
    });
    expect((await finish(stopping)).isOk()).toBe(true);
    expect(resolutions).toEqual(['persona', 'persona', null]);
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
  });

  it('actual short disconnect before bytes defers only saved delivery, then current connector resumes once healthy', async () => {
    (await actor.prepare(input, guard))._unsafeUnwrap();
    let interrupted = false;
    answer = (request, socket) => {
      if (request.method === 'listContacts' && !interrupted) {
        interrupted = true;
        socket.destroy();
      } else defaultAnswer(request, socket);
    };
    const first = await finish(actor.deliver('queue', guard));
    expect(first._unsafeUnwrapErr()).toBeInstanceOf(DeliveryDeferredError);
    expect(checkpoint()).toMatchObject({ phase: 'ready', nextChunk: 0 });
    expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(61_000);
    await until(() => connector.status().state === 'ready');
    expect((await finish(actor.deliver('queue'))).isOk()).toBe(true);
    expect(phases).toEqual(['prepared', 'delivered']);
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
  });

  it.each(['rate', 'challenge'] as const)(
    'preserves prior accepted chunks on %s refused current cursor with typed delivery-only restriction',
    async (restriction) => {
      input = { ...input, body: 'r'.repeat(4100) };
      const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
      accepted(saved);
      answer = (request, socket) =>
        request.method === 'send'
          ? remote(socket, request, restriction === 'rate' ? -5 : -6, [
              {
                type: 'RATE_LIMIT_FAILURE',
                ...(restriction === 'challenge' ? { token: 'discard-private-token' } : {}),
                recipientAddress: { uuid: account, number: null, username: null },
              },
            ])
          : defaultAnswer(request, socket);
      const result = await finish(actor.deliver('queue', guard));
      expect(result._unsafeUnwrapErr()).toMatchObject({
        deliveryError: {
          outcome: 'PARTIAL',
          acceptedChunks: 1,
          successCount: 1,
          currentChunkAcceptance: 'refused',
          retryScope: 'delivery_only',
          providerRetryable: false,
        },
      });
      expect(result._unsafeUnwrapErr().message).not.toContain('private');
      expect(checkpoint()).toMatchObject({
        phase: 'ready',
        nextChunk: 1,
        acceptedChunks: 1,
        expiresAt: saved.expiresAt,
      });
      expect(accounts.findByAccount(account)._unsafeUnwrap()?.pauseKind).toBe(
        restriction === 'rate' ? 'rate_limit' : 'challenge',
      );
      expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
      expect(guard.checkTarget(account, target).isOk()).toBe(true);
    },
  );

  it('checks live exact-target latch before any final checkpoint and NOT_SENT cleanup permits a later saved reply', async () => {
    const before = connector;
    answer = (request, socket) =>
      request.method === 'listContacts'
        ? reply(socket, request, [
            { uuid: account, isBlocked: true, unregistered: false, messageExpirationTime: 0 },
          ])
        : defaultAnswer(request, socket);
    const refused = await finish(
      guard.invoke(
        {
          deliveryId: 'explicit-refused',
          purpose: 'explicit',
          accountUuid: account,
          destination: target,
        },
        (trustedDelivery) => before.send(target, { body: 'explicit', trustedDelivery }),
      ),
    );
    expect(refused._unsafeUnwrapErr()).toMatchObject({ outcome: 'NOT_SENT', retryScope: 'none' });
    expect(leases.find(account, target)._unsafeUnwrap()).toBeNull();
    answer = defaultAnswer;
    expect((await actor.prepare(input, guard)).isOk()).toBe(true);
    expect((await finish(actor.deliver('queue', guard))).isOk()).toBe(true);
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
  });

  it('latched UNKNOWN explicit target refuses final preparation across delivery IDs without suppressing another origin', async () => {
    answer = (request, socket) =>
      request.method === 'send'
        ? reply(socket, request, { timestamp: 900, results: [] })
        : defaultAnswer(request, socket);
    const result = await finish(
      guard.invoke(
        {
          deliveryId: 'explicit-unknown',
          purpose: 'explicit',
          accountUuid: account,
          destination: target,
        },
        (trustedDelivery) => connector.send(target, { body: 'explicit', trustedDelivery }),
      ),
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ outcome: 'UNKNOWN' });
    expect((await actor.prepare(input, guard))._unsafeUnwrapErr()).toMatchObject({
      reason: 'TARGET_LATCHED',
    });
    expect(queue.inspectSignalDelivery('queue', Date.now())._unsafeUnwrap().kind).toBe('invoked');
    expect(guard.checkTarget(account, `signal:v1:${account}:group:QQ`).isOk()).toBe(true);
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
  });

  it('rejects exact absolute codec-cap preparation when derived lifecycle budget needs additional bytes', async () => {
    input = { ...input, body: '\u0000'.repeat(250_000) };
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    const work = extra('budget', `signal:v1:${account}:group:QQ`);
    const { runId: _runId, ...withoutRun } = saved;
    const base = { ...withoutRun, ...work.input, body: input.body };
    const padding = SIGNAL_CHECKPOINT_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
    const padded = { ...base, deliveryId: base.deliveryId + 'x'.repeat(padding) };
    expect(Buffer.byteLength(JSON.stringify(padded))).toBe(SIGNAL_CHECKPOINT_MAX_BYTES);
    expect(
      parseSignalDeliveryCheckpoint(padded, {
        queueItemId: work.input.queueItemId,
        now: Date.now(),
      }).isOk(),
    ).toBe(true);
    const result = await actor.prepare(
      { ...work.input, deliveryId: padded.deliveryId, body: input.body },
      work.guard,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'TOO_LARGE' });
    expect(queue.inspectSignalDelivery(work.input.queueItemId, Date.now())._unsafeUnwrap()).toEqual(
      { kind: 'ordinary' },
    );
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
    work.guard.close();
  });

  it('invalid reserved state and expected inspection Err never become ordinary fallback or absence', async () => {
    const failure = new SignalStateError('CONFLICT');
    const inspection = vi.spyOn(queue, 'inspectSignalDelivery').mockReturnValueOnce(err(failure));
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toBe(failure);
    inspection.mockRestore();
    queue
      .enqueue({
        id: 'invalid',
        thread_id: 'thread',
        message_id: null,
        type: 'message',
        max_attempts: 3,
        payload: JSON.stringify({ [SIGNAL_DELIVERY_CHECKPOINT_KEY]: null }),
      })
      ._unsafeUnwrap();
    expect((await actor.deliver('invalid'))._unsafeUnwrapErr()).toBeInstanceOf(
      SignalCheckpointError,
    );
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
  });

  it('a current delivered checkpoint wins a stale resolver catch/error', async () => {
    (await actor.prepare(input, guard))._unsafeUnwrap();
    const stale = new SignalStateError('CONFLICT');
    actor = createActor({
      resolve: () => {
        accepted(checkpoint());
        return err(stale);
      },
    });
    expect((await actor.deliver('queue')).isOk()).toBe(true);
    expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('completed');
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toHaveLength(1);
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
  });

  it.each(['expiry', 'refusal'] as const)(
    'atomically rolls back actor-owned %s and run status on actual audit write failure, retrying DB only',
    async (reason) => {
      const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
      if (reason === 'expiry') vi.setSystemTime(saved.expiresAt);
      else
        actor = createActor({
          resolve: () =>
            err(
              new SignalDeliveryError({
                reason: 'TARGET_REFUSED',
                outcome: 'NOT_SENT',
                acceptedChunks: 0,
                currentChunkAcceptance: 'unwritten',
                successCount: 0,
                failureCount: 0,
                retryScope: 'none',
              }),
            ),
        });
      const insertActual = audit.insert.bind(audit);
      const failures: Error[] = [];
      let fail = true;
      const insert = vi.spyOn(audit, 'insert').mockImplementation((entry) => {
        // Execute the ACTUAL prepared SQLite INSERT under write refusal, not a made-up producer error.
        if (fail) db.pragma('query_only = ON');
        const result = insertActual(entry);
        db.pragma('query_only = OFF');
        fail = false;
        if (result.isErr()) failures.push(result.error);
        return result;
      });
      const pending = actor.deliver('queue');
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(insert).toHaveBeenCalledOnce();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(DbError);
      expect(checkpoint()).toMatchObject({ phase: 'ready', nextChunk: 0 });
      expect(queue.findById('queue')._unsafeUnwrap()?.status).toBe('pending');
      expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('running');
      expect(audit.findByThread('thread')._unsafeUnwrap()).toEqual([]);
      expect((await finish(pending))._unsafeUnwrapErr()).toBeInstanceOf(NonRetryableRunError);
      expect(checkpoint().phase).toBe('terminal');
      expect(audit.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'send')).toEqual([]);
    },
  );

  it('deduplicates producer-terminal audit across concurrent/fresh actors with safe fields and throwing optional warning', async () => {
    (await actor.prepare(input, guard))._unsafeUnwrap();
    answer = (request, socket) =>
      request.method === 'send'
        ? reply(socket, request, { timestamp: 900, results: [] })
        : defaultAnswer(request, socket);
    const warn = vi.fn(() => {
      throw new Error('logger failure');
    });
    actor = createActor({ logger: { warn } });
    expect((await finish(actor.deliver('queue', guard))).isErr()).toBe(true);
    const first = audit.findByThread('thread')._unsafeUnwrap();
    expect(first).toHaveLength(1);
    const stored = first[0]!;
    expect(stored).toMatchObject({
      action: 'signal.delivery.terminal',
      run_id: 'run',
      thread_id: 'thread',
      persona_id: 'persona',
      tool: null,
      request_id: null,
    });
    expect(stored.id).toMatch(/^signal-reply-terminal:v1:[a-f0-9]{64}$/);
    const text = stored.details;
    expect(text).not.toContain(account);
    expect(text).not.toContain(input.body);
    expect(text).not.toContain('private');
    expect(JSON.parse(text)).toEqual({
      queueItemId: 'queue',
      deliveryId: 'delivery',
      reason: 'INVALID_RESPONSE',
      outcome: 'UNKNOWN',
      acceptedChunks: 0,
      successCount: 0,
      failureCount: 0,
    });
    const results = await Promise.all([
      createActor({ logger: { warn } }).deliver('queue'),
      createActor({ logger: { warn } }).deliver('queue'),
    ]);
    expect(results.every((result) => result.isErr())).toBe(true);
    expect(audit.findByThread('thread')._unsafeUnwrap()).toEqual(first);
    expect(warn).toHaveBeenCalledOnce();
    expect(requests.filter((r) => r.method === 'send')).toHaveLength(1);
  });

  it('audit read DB failure retries only local work, while purge during repair cancels without recreating diagnostics/body/history', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    queue
      .terminateSignalDelivery(
        saved,
        new SignalDeliveryError({
          reason: 'TARGET_REFUSED',
          outcome: 'NOT_SENT',
          acceptedChunks: 0,
          currentChunkAcceptance: 'unwritten',
          successCount: 0,
          failureCount: 0,
          retryScope: 'none',
        }),
        Date.now(),
      )
      ._unsafeUnwrap();
    const failure = new DbError('safe audit read failure');
    const read = vi.spyOn(audit, 'findByThread').mockReturnValue(err(failure));
    const pending = actor.deliver('queue');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    queue.purge(['dead_letter'])._unsafeUnwrap();
    read.mockRestore();
    expect((await finish(pending))._unsafeUnwrapErr()).toBeInstanceOf(DeliveryCancelled);
    expect(audit.findByThread('thread')._unsafeUnwrap()).toEqual([]);
    expect(messages.findByThread('thread', 20, 0)._unsafeUnwrap()).toEqual([]);
    expect(queue.findById('queue')._unsafeUnwrap()).toBeNull();
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
  });

  it('conflicting exact audit identity is not successful dedup and rolls back actor-owned expiry', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    const id =
      'signal-reply-terminal:v1:' +
      createHash('sha256')
        .update(JSON.stringify(['queue', 'delivery']))
        .digest('hex');
    audit
      .insert({
        id,
        run_id: 'run',
        thread_id: 'thread',
        persona_id: 'persona',
        action: 'signal.delivery.terminal',
        tool: null,
        request_id: null,
        details: '{"conflicting":true}',
      })
      ._unsafeUnwrap();
    vi.setSystemTime(saved.expiresAt);
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toMatchObject({ reason: 'CONFLICT' });
    expect(checkpoint().phase).toBe('ready');
    expect(runs.findById('run')._unsafeUnwrap()?.status).toBe('running');
    expect(audit.findByThread('thread')._unsafeUnwrap()).toHaveLength(1);
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
  });

  it('resolves current canonical account config from the actual channel row, refusing replacement identity before saved dispatch', async () => {
    const saved = (await actor.prepare(input, guard))._unsafeUnwrap();
    const old = connector;
    expect((await old.stopWithResult()).isOk()).toBe(true);
    const channels = new ChannelRepository(db);
    const replacement = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const config = SignalConfigSchema.parse({
      accountMode: 'dedicated',
      socketPath: join(directory, 'rpc.sock'),
      account: replacement,
      accountUuid: replacement,
      deviceId: 1,
    });
    channels.update('channel', { config: JSON.stringify(config) })._unsafeUnwrap();
    actor = createActor({
      resolve: (identity) =>
        channels.findByName(identity.channelName).andThen((row) => {
          if (row === null) return err(new SignalStateError('NOT_FOUND'));
          const current = SignalConfigSchema.parse(JSON.parse(row.config));
          return current.accountUuid === identity.accountUuid
            ? ok(connector)
            : err(
                new SignalDeliveryError({
                  reason: 'ACCOUNT_MISMATCH',
                  outcome: 'NOT_SENT',
                  acceptedChunks: 0,
                  currentChunkAcceptance: 'unwritten',
                  successCount: 0,
                  failureCount: 0,
                  retryScope: 'none',
                }),
              );
        }),
    });
    expect((await actor.deliver('queue'))._unsafeUnwrapErr()).toMatchObject({
      deliveryError: { reason: 'ACCOUNT_MISMATCH' },
    });
    expect(checkpoint()).toMatchObject({
      body: saved.body,
      chunks: saved.chunks,
      phase: 'terminal',
    });
    expect(requests.filter((r) => r.method === 'send')).toEqual([]);
  });

  it('finalizes distinct original background task/status notifications separately and only once across fresh-actor replay', async () => {
    const destination = `signal:v1:${account}:group:QQ`;
    const threadId = 'notification-history';
    new ThreadRepository(db)
      .insert({ id: threadId, channel_id: 'channel', external_id: destination, metadata: '{}' })
      ._unsafeUnwrap();
    const originalRun = runs.findById('run')._unsafeUnwrap();
    const notifications = [
      {
        id: 'notification-alpha',
        taskId: 'task-alpha',
        status: 'completed',
        content: '**alpha complete** 😀',
      },
      {
        id: 'notification-beta',
        taskId: 'task-beta',
        status: 'completed',
        content: '**beta complete** 🐦',
      },
      {
        id: 'notification-alpha-failed',
        taskId: 'task-alpha',
        status: 'failed',
        content: '**alpha failed** 🚫',
      },
    ];
    for (const notification of notifications) {
      queue
        .enqueue({
          id: notification.id,
          thread_id: threadId,
          message_id: null,
          type: 'collaboration',
          max_attempts: 3,
          payload: JSON.stringify({
            kind: 'background_task_notification',
            taskId: notification.taskId,
            status: notification.status,
            content: notification.content,
            personaId: 'persona',
          }),
        })
        ._unsafeUnwrap();
      const entry = SignalInvocationGuard.enter(queue, notification.id)._unsafeUnwrap();
      if (entry.kind !== 'execution') throw new Error('Expected original notification execution');
      try {
        const saved = (
          await actor.prepare(
            {
              ...input,
              queueItemId: notification.id,
              deliveryId: `delivery-${notification.id}`,
              kind: 'background',
              threadId,
              destination,
              body: notification.content,
            },
            entry.guard,
          )
        )._unsafeUnwrap();
        expect(Object.hasOwn(saved, 'runId')).toBe(false);
        expect((await finish(actor.deliver(notification.id, entry.guard))).isOk()).toBe(true);
      } finally {
        entry.guard.close();
      }
    }
    const stored = messages.findByThread(threadId, 20, 0)._unsafeUnwrap();
    expect(stored).toHaveLength(3);
    expect(
      stored.map((row) => ({ key: row.idempotency_key, content: row.content, runId: row.run_id })),
    ).toEqual(
      notifications.map((notification) => ({
        key: `background-task:${notification.taskId}:${notification.status}`,
        content: JSON.stringify({ body: notification.content }),
        runId: null,
      })),
    );
    expect(requests.filter((request) => request.method === 'send')).toHaveLength(3);
    const completedPhases = [...phases];
    const completedRotations = [...rotations];
    for (const notification of notifications) {
      expect(queue.findById(notification.id)._unsafeUnwrap()?.status).toBe('completed');
      expect((await createActor().deliver(notification.id)).isOk()).toBe(true);
    }
    expect(messages.findByThread(threadId, 20, 0)._unsafeUnwrap()).toEqual(stored);
    expect(phases).toEqual(completedPhases);
    expect(completedPhases).toEqual([
      'prepared',
      'delivered',
      'prepared',
      'delivered',
      'prepared',
      'delivered',
    ]);
    expect(rotations).toEqual(completedRotations);
    expect(requests.filter((request) => request.method === 'send')).toHaveLength(3);
    expect(runs.findByThread(threadId)._unsafeUnwrap()).toEqual([]);
    expect(runs.findById('run')._unsafeUnwrap()).toEqual(originalRun);
  });

  it.each(['network', 'timeout'] as const)(
    'saved background %s is terminal UNKNOWN without runId, history, continuation or repeat dispatch',
    async (outcome) => {
      const work = extra(`background-unknown-${outcome}`, `signal:v1:${account}:group:QQ`);
      const originalRun = runs.findById('run')._unsafeUnwrap();
      try {
        const body = '**saved background** 😀'.repeat(200);
        // Actual sender deadline aborts the request before its forced timeout Result settles:
        // signal-send-coordinator.ts:1129-1131; signal-rpc-client.ts:229-241 => CANCELLED/UNKNOWN.
        const reason = outcome === 'network' ? 'NETWORK_FAILURE' : 'CANCELLED';
        const saved = (await actor.prepare({ ...work.input, body }, work.guard))._unsafeUnwrap();
        expect(saved.kind).toBe('background');
        expect(Object.hasOwn(saved, 'runId')).toBe(false);
        expect(saved.body).toBe(body);
        expect(saved.chunks.length).toBeGreaterThan(1);
        expect(requests.filter((request) => request.method === 'send')).toEqual([]);
        const submitted: unknown[] = [];
        answer = (request, socket) => {
          if (request.method !== 'send') return defaultAnswer(request, socket);
          submitted.push({
            checkpoint: checkpoint(work.input.queueItemId),
            reservation: accounts.findByAccount(account)._unsafeUnwrap()?.reservation,
          });
          // Source-shaped, NOT live: v0.14.9/3997429779095ff3a2d64c877126e84fce9852aa,
          // JsonSendMessageResult.java:10-48; JsonRecipientAddress.java:9-15;
          // SendMessageResultUtils.java:43-68. Timeout leaves this actual submitted RPC unanswered.
          if (outcome === 'network')
            reply(socket, request, {
              timestamp: 900,
              results: [
                {
                  type: 'NETWORK_FAILURE',
                  recipientAddress: { uuid: account, number: null, username: null },
                },
              ],
            });
        };
        const result = await finish(actor.deliver(work.input.queueItemId, work.guard));
        expect(result._unsafeUnwrapErr()).toBeInstanceOf(NonRetryableRunError);
        expect(result._unsafeUnwrapErr()).toMatchObject({
          deliveryError: {
            reason,
            outcome: 'UNKNOWN',
            currentChunkAcceptance: 'unknown',
            acceptedChunks: 0,
            successCount: 0,
            failureCount: outcome === 'network' ? 1 : 0,
            retryScope: 'none',
            providerRetryable: false,
          },
        });
        if (outcome === 'timeout') expect(Date.now()).toBeGreaterThanOrEqual(initial + 30_000);
        expect(submitted).toHaveLength(1);
        expect(submitted[0]).toMatchObject({
          checkpoint: {
            queueItemId: work.input.queueItemId,
            kind: 'background',
            phase: 'in_flight',
            body,
            chunks: saved.chunks,
          },
          reservation: {
            queueItemId: work.input.queueItemId,
            deliveryId: work.input.deliveryId,
            purpose: 'background',
          },
        });
        const terminal = checkpoint(work.input.queueItemId);
        expect(Object.hasOwn(terminal, 'runId')).toBe(false);
        expect(terminal).toMatchObject({
          phase: 'terminal',
          terminalOutcome: 'UNKNOWN',
          currentChunkAcceptance: 'unknown',
          nextChunk: 0,
          acceptedChunks: 0,
          expiresAt: saved.expiresAt,
        });
        expect(queue.findById(work.input.queueItemId)._unsafeUnwrap()?.status).toBe('dead_letter');
        const restriction = accounts.findByAccount(account)._unsafeUnwrap();
        expect(restriction).toMatchObject({
          reservation: null,
          pauseKind: 'recovery',
          rateLimitNotBefore: 0,
        });
        expect(restriction!.recoveryNotBefore).toBeGreaterThan(Date.now());
        expect(restriction!.notBefore).toBe(restriction!.recoveryNotBefore);
        expect(leases.find(account, work.input.destination)._unsafeUnwrap()).toBeNull();
        const terminalAudit = audit.findByThread(work.input.threadId)._unsafeUnwrap();
        expect(terminalAudit).toHaveLength(1);
        expect(terminalAudit[0]).toMatchObject({
          run_id: null,
          action: 'signal.delivery.terminal',
        });
        expect(JSON.parse(terminalAudit[0]!.details)).toEqual({
          queueItemId: work.input.queueItemId,
          deliveryId: work.input.deliveryId,
          reason,
          outcome: 'UNKNOWN',
          acceptedChunks: 0,
          successCount: 0,
          failureCount: outcome === 'network' ? 1 : 0,
        });
        for (const replay of [actor, createActor()]) {
          expect((await replay.deliver(work.input.queueItemId))._unsafeUnwrapErr()).toMatchObject({
            deliveryError: { outcome: 'UNKNOWN', retryScope: 'none' },
          });
        }
        expect(checkpoint(work.input.queueItemId)).toEqual(terminal);
        expect(audit.findByThread(work.input.threadId)._unsafeUnwrap()).toEqual(terminalAudit);
        expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(restriction);
        expect(messages.findByThread(work.input.threadId, 20, 0)._unsafeUnwrap()).toEqual([]);
        expect(runs.findByThread(work.input.threadId)._unsafeUnwrap()).toEqual([]);
        expect(runs.findById('run')._unsafeUnwrap()).toEqual(originalRun);
        expect(phases).toEqual(['prepared']);
        expect(rotations).toEqual([]);
        expect(requests.filter((request) => request.method === 'send')).toHaveLength(1);
        expect(requests.find((request) => request.method === 'send')).toMatchObject({
          params: { message: saved.chunks[0] },
        });
      } finally {
        work.guard.close();
      }
    },
  );

  it('saved background without runId blocks unknown-owner in_flight until actual quiesced cold recovery, then deduplicates terminal UNKNOWN audit', async () => {
    const work = extra('background-cold-unknown', `signal:v1:${account}:group:QQ`);
    const originalRun = runs.findById('run')._unsafeUnwrap();
    try {
      const saved = (await actor.prepare(work.input, work.guard))._unsafeUnwrap();
      expect(Object.hasOwn(saved, 'runId')).toBe(false);
      // Cold fixture has durable public producer ownership but NO submitted RPC or retained live callback.
      const accountState = accounts.getOrCreate(account, Date.now())._unsafeUnwrap();
      const owned = queue
        .beginSignalChunk(saved, accountState.revision, Date.now())
        ._unsafeUnwrap();
      const before = queue.findById(work.input.queueItemId)._unsafeUnwrap();
      const reservation = accounts.findByAccount(account)._unsafeUnwrap();
      expect(Object.hasOwn(owned.checkpoint, 'runId')).toBe(false);
      expect(owned.reservation).toMatchObject({
        queueItemId: work.input.queueItemId,
        deliveryId: work.input.deliveryId,
        purpose: 'background',
      });
      expect((await actor.deliver(work.input.queueItemId))._unsafeUnwrapErr()).toMatchObject({
        reason: 'CONFLICT',
      });
      expect(queue.findById(work.input.queueItemId)._unsafeUnwrap()).toEqual(before);
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(reservation);
      expect(audit.findByThread(work.input.threadId)._unsafeUnwrap()).toEqual([]);
      work.guard.close();
      expect((await connector.stopWithResult()).isOk()).toBe(true);
      // Test driver is explicitly cold/quiesced; never recover globally during live actor dispatch.
      const recovered = queue.recoverSignalQueue(Date.now())._unsafeUnwrap();
      expect(recovered).toMatchObject({ reservationsClassified: 1, terminal: 1 });
      expect((await actor.deliver(work.input.queueItemId))._unsafeUnwrapErr()).toMatchObject({
        deliveryError: { reason: 'UNKNOWN_ACCEPTANCE', outcome: 'UNKNOWN', retryScope: 'none' },
      });
      const terminal = checkpoint(work.input.queueItemId);
      expect(Object.hasOwn(terminal, 'runId')).toBe(false);
      expect(terminal).toMatchObject({
        phase: 'terminal',
        terminalOutcome: 'UNKNOWN',
        currentChunkAcceptance: 'unknown',
        nextChunk: 0,
      });
      const restriction = accounts.findByAccount(account)._unsafeUnwrap();
      expect(restriction).toMatchObject({ reservation: null, pauseKind: 'recovery' });
      expect(restriction!.recoveryNotBefore).toBeGreaterThan(Date.now());
      expect(leases.find(account, work.input.destination)._unsafeUnwrap()).toBeNull();
      const terminalAudit = audit.findByThread(work.input.threadId)._unsafeUnwrap();
      expect(terminalAudit).toHaveLength(1);
      expect(terminalAudit[0]).toMatchObject({ run_id: null, action: 'signal.delivery.terminal' });
      expect(JSON.parse(terminalAudit[0]!.details)).toMatchObject({
        queueItemId: work.input.queueItemId,
        deliveryId: work.input.deliveryId,
        reason: 'UNKNOWN_ACCEPTANCE',
        outcome: 'UNKNOWN',
      });
      expect(
        (await createActor().deliver(work.input.queueItemId))._unsafeUnwrapErr(),
      ).toBeInstanceOf(NonRetryableRunError);
      expect(checkpoint(work.input.queueItemId)).toEqual(terminal);
      expect(audit.findByThread(work.input.threadId)._unsafeUnwrap()).toEqual(terminalAudit);
      expect(accounts.findByAccount(account)._unsafeUnwrap()).toEqual(restriction);
      expect(messages.findByThread(work.input.threadId, 20, 0)._unsafeUnwrap()).toEqual([]);
      expect(runs.findByThread(work.input.threadId)._unsafeUnwrap()).toEqual([]);
      expect(runs.findById('run')._unsafeUnwrap()).toEqual(originalRun);
      expect(phases).toEqual(['prepared']);
      expect(rotations).toEqual([]);
      expect(requests.filter((request) => request.method === 'send')).toEqual([]);
    } finally {
      work.guard.close();
    }
  });
});
