import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { reconcileBindings, registerChannels } from '../../../src/channels/channel-setup.js';
import { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import { SignalConnector } from '../../../src/channels/connectors/signal/signal-connector.js';
import { SignalAccountStateRepository } from '../../../src/core/database/repositories/signal-account-state-repository.js';
import { SignalDestinationLeaseRepository } from '../../../src/core/database/repositories/signal-destination-lease-repository.js';
import { QueueRepository } from '../../../src/core/database/repositories/queue-repository.js';
import { ok } from 'neverthrow';
import { vi } from 'vitest';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { MessageRepository } from '../../../src/core/database/repositories/message-repository.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import {
  AuditRepository,
  RepositoryAuditStore,
} from '../../../src/core/database/repositories/audit-repository.js';
import { QueueManager } from '../../../src/queue/queue-manager.js';
import { rowToQueueItem } from '../../../src/queue/queue-mapper.js';
import { MessagePipeline } from '../../../src/pipeline/message-pipeline.js';
import { ChannelRouter } from '../../../src/channels/channel-router.js';
import { AuditLogger } from '../../../src/core/logging/audit-logger.js';
import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import { SignalToolExecutionRegistry } from '../../../src/tools/host-tools/signal-tool-execution.js';
import type { DaemonContext, SignalRunGeneration } from '../../../src/daemon/daemon-context.js';
import type { SignalConnectorDependencies } from '../../../src/channels/connectors/signal/signal-connector.js';
import type { TalondConfig } from '../../../src/core/config/config-types.js';
import type { MessagePipeline } from '../../../src/pipeline/message-pipeline.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';
import type { BindingConfig } from '../../../src/core/config/config-types.js';

const logger = pino({ level: 'silent' });

describe('reconcileBindings()', () => {
  let db: Database.Database;
  let channelRepo: ChannelRepository;
  let personaRepo: PersonaRepository;
  let bindingRepo: BindingRepository;
  let channelId: string;
  let personaIdA: string;
  let personaIdB: string;

  beforeEach(() => {
    db = createTestDb();
    channelRepo = new ChannelRepository(db);
    personaRepo = new PersonaRepository(db);
    bindingRepo = new BindingRepository(db);

    channelId = uuid();
    channelRepo.insert({
      id: channelId,
      type: 'terminal',
      name: 'terminal',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    personaIdA = uuid();
    personaIdB = uuid();
    personaRepo.insert({
      id: personaIdA, name: 'alice', model: 'claude-sonnet-4-6',
      system_prompt_file: null, skills: '[]', capabilities: '{}', mounts: '[]', max_concurrent: null,
    });
    personaRepo.insert({
      id: personaIdB, name: 'bob', model: 'claude-sonnet-4-6',
      system_prompt_file: null, skills: '[]', capabilities: '{}', mounts: '[]', max_concurrent: null,
    });
  });

  afterEach(() => { db.close(); });

  it('creates a new binding from config', () => {
    const bindings: BindingConfig[] = [
      { persona: 'alice', channel: 'terminal', isDefault: true },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()!.persona_id).toBe(personaIdA);
  });

  it('updates an existing binding when persona changes', () => {
    // Pre-existing binding: terminal -> alice
    bindingRepo.insert({
      id: uuid(), channel_id: channelId, thread_id: null,
      persona_id: personaIdA, is_default: 1,
    });

    // Config says terminal -> bob
    const bindings: BindingConfig[] = [
      { persona: 'bob', channel: 'terminal', isDefault: true },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()!.persona_id).toBe(personaIdB);
  });

  it('leaves binding unchanged when config matches DB', () => {
    const bindingId = uuid();
    bindingRepo.insert({
      id: bindingId, channel_id: channelId, thread_id: null,
      persona_id: personaIdA, is_default: 1,
    });

    const bindings: BindingConfig[] = [
      { persona: 'alice', channel: 'terminal', isDefault: true },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result._unsafeUnwrap()!.id).toBe(bindingId);
  });

  it('does nothing when bindings array is empty', () => {
    bindingRepo.insert({
      id: uuid(), channel_id: channelId, thread_id: null,
      persona_id: personaIdA, is_default: 1,
    });

    reconcileBindings([], { channelRepo, personaRepo, bindingRepo, logger });

    // Existing binding should remain (auto-default fallback still applies)
    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result._unsafeUnwrap()).not.toBeNull();
  });

  it('skips non-default bindings', () => {
    const bindings: BindingConfig[] = [
      { persona: 'bob', channel: 'terminal', isDefault: false },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    // No binding should have been created since isDefault is false.
    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('skips bindings with unknown persona or channel', () => {
    const bindings: BindingConfig[] = [
      { persona: 'nonexistent', channel: 'terminal', isDefault: true },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('registerChannels Signal wiring', () => {
  const firstAccount = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const secondAccount = 'cccccccc-1111-2222-3333-dddddddddddd';
  const signal = (name: string, accountUuid: string) => ({
    name,
    type: 'signal',
    enabled: true,
    config: {
      accountMode: 'dedicated',
      socketPath: `/run/talon-signal/${name}.sock`,
      account: '+12025550123',
      accountUuid,
      deviceId: 1,
    },
  });
  const configWith = (channels: unknown[]): TalondConfig =>
    ({ channels, personas: [], bindings: [] }) as unknown as TalondConfig;
  const quietLogger = (): pino.Logger =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }) as unknown as pino.Logger;

  let registry: ChannelRegistry;
  let logger: pino.Logger;
  let pipeline: { handleInboundEvent: ReturnType<typeof vi.fn>; handleInboundEventWithReceipt: ReturnType<typeof vi.fn> };
  let db: Database.Database;
  let deps: Parameters<typeof registerChannels>[2];

  beforeEach(() => {
    db = createTestDb();
    registry = new ChannelRegistry(pino({ level: 'silent' }));
    logger = quietLogger();
    pipeline = {
      handleInboundEvent: vi.fn(),
      handleInboundEventWithReceipt: vi.fn().mockReturnValue(ok('accepted')),
    };
    deps = {
      channelRepo: new ChannelRepository(db),
      bindingRepo: new BindingRepository(db),
      personaRepo: new PersonaRepository(db),
      messagePipeline: pipeline as unknown as MessagePipeline,
      logger,
      signal: {
        accounts: new SignalAccountStateRepository(db),
        leases: new SignalDestinationLeaseRepository(db),
        queue: new QueueRepository(db),
        generation: 7,
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('registers a real Signal connector wired to the pipeline receipt handler', () => {
    const receiptSpy = vi.spyOn(SignalConnector.prototype, 'onMessageWithReceipt');

    registerChannels(configWith([signal('signal-main', firstAccount)]), registry, deps);

    const connector = registry.get('signal-main');
    expect(connector).toBeInstanceOf(SignalConnector);
    expect(receiptSpy).toHaveBeenCalledOnce();
    const event = { channelName: 'signal-main' } as never;
    receiptSpy.mock.calls[0]![0](event);
    expect(pipeline.handleInboundEventWithReceipt).toHaveBeenCalledWith(event);
    expect(pipeline.handleInboundEvent).not.toHaveBeenCalled();
  });

  it('keeps distinct named Signal instances for distinct accounts', () => {
    registerChannels(
      configWith([signal('signal-one', firstAccount), signal('signal-two', secondAccount)]),
      registry,
      deps,
    );

    expect(registry.get('signal-one')).toBeInstanceOf(SignalConnector);
    expect(registry.get('signal-two')).toBeInstanceOf(SignalConnector);
  });

  it('rejects every instance that shares an account before any start, keeping other accounts', () => {
    const startSpy = vi.spyOn(SignalConnector.prototype, 'start');

    registerChannels(
      configWith([
        signal('signal-one', firstAccount),
        signal('signal-dup', firstAccount),
        signal('signal-other', secondAccount),
      ]),
      registry,
      deps,
    );

    expect(registry.get('signal-one')).toBeUndefined();
    expect(registry.get('signal-dup')).toBeUndefined();
    expect(registry.get('signal-other')).toBeInstanceOf(SignalConnector);
    expect(registry.listAll()).toHaveLength(1);
    expect(startSpy).not.toHaveBeenCalled();
    const warnings = JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(warnings).toContain('signal-one');
    expect(warnings).toContain('signal-dup');
    expect(warnings).not.toContain(firstAccount);
  });

  it('routes a foreign-account device refresh to that generation\'s owning connector only', () => {
    registerChannels(
      configWith([signal('signal-one', firstAccount), signal('signal-two', secondAccount)]),
      registry,
      deps,
    );
    const one = registry.get('signal-one') as SignalConnector;
    const two = registry.get('signal-two') as SignalConnector;
    const refreshOne = vi.spyOn(one, 'requestVerificationRefresh');
    const refreshTwo = vi.spyOn(two, 'requestVerificationRefresh');
    // The wiring seam: the SAME callback every connector in the generation receives.
    const request = (one as unknown as { dependencies: SignalConnectorDependencies }).dependencies
      .requestDeviceRefresh;
    expect(request).toBeDefined();
    expect(request).toBe(
      (two as unknown as { dependencies: SignalConnectorDependencies }).dependencies.requestDeviceRefresh,
    );

    request!(secondAccount);
    expect(refreshTwo).toHaveBeenCalledOnce();
    expect(refreshOne).not.toHaveBeenCalled();

    request!('eeeeeeee-1111-2222-3333-ffffffffffff');
    expect(refreshOne).not.toHaveBeenCalled();
    expect(refreshTwo).toHaveBeenCalledOnce();
  });

  it('routes refreshes within their own generation, never to a replaced generation\'s connector', () => {
    registerChannels(configWith([signal('signal-two', secondAccount)]), registry, deps);
    const oldOwner = registry.get('signal-two') as SignalConnector;
    const oldRequest = (oldOwner as unknown as { dependencies: SignalConnectorDependencies }).dependencies
      .requestDeviceRefresh!;
    registry.unregister('signal-two');
    registerChannels(configWith([signal('signal-two', secondAccount)]), registry, {
      ...deps,
      signal: { ...deps.signal!, generation: 8 },
    });
    const newOwner = registry.get('signal-two') as SignalConnector;
    const refreshOld = vi.spyOn(oldOwner, 'requestVerificationRefresh');
    const refreshNew = vi.spyOn(newOwner, 'requestVerificationRefresh');
    const newRequest = (newOwner as unknown as { dependencies: SignalConnectorDependencies }).dependencies
      .requestDeviceRefresh!;

    newRequest(secondAccount);
    expect(refreshNew).toHaveBeenCalledOnce();
    expect(refreshOld).not.toHaveBeenCalled();
    oldRequest(secondAccount);
    expect(refreshOld).toHaveBeenCalledOnce();
  });

  it('allows different accounts to share one bridge socket (multi-account daemon)', () => {
    const shared = (name: string, accountUuid: string) => ({
      ...signal(name, accountUuid),
      config: { ...signal(name, accountUuid).config, socketPath: '/run/talon-signal/shared.sock' },
    });

    registerChannels(configWith([shared('signal-one', firstAccount), shared('signal-two', secondAccount)]), registry, deps);

    expect(registry.get('signal-one')).toBeInstanceOf(SignalConnector);
    expect(registry.get('signal-two')).toBeInstanceOf(SignalConnector);
  });

  it('rejects the same account on a different socket or device, keeping neither instance', () => {
    const otherSocket = {
      ...signal('signal-other', firstAccount),
      config: { ...signal('signal-other', firstAccount).config, socketPath: '/run/talon-signal/other.sock', deviceId: 2 },
    };
    registerChannels(configWith([signal('signal-one', firstAccount), otherSocket]), registry, deps);

    expect(registry.listAll()).toHaveLength(0);
    expect(registry.get('signal-other')).toBeUndefined();
  });

  it('does not register Signal channels when no Signal wiring is supplied', () => {
    registerChannels(configWith([signal('signal-main', firstAccount)]), registry, {
      ...deps,
      signal: undefined,
    });

    expect(registry.get('signal-main')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integrated wiring: real registerChannels, real pipeline/router/queue on a migrated in-memory DB,
// a real SignalConnector over a fake bridge socket, and the real AgentRunner background path.
// Bridge replies follow signal-cli v0.14.9 as in signal-connector.test.ts (VersionCommand.java:60-66,
// ListAccountsCommand.java:33-47, ListDevicesCommand.java:40-67, SignalJsonRpcCommandHandler.java:68-139,
// JsonReceiveMessageHandler.java:23-35, JsonSyncDataMessage.java:14-30).
// ---------------------------------------------------------------------------

describe('integrated Signal wiring through the real registerChannels and pipeline', () => {
  const account = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const target = `signal:v1:${account}:self`;
  const bridgeDevice = 3;
  const humanDevice = 2;
  const quiet = pino({ level: 'silent' });
  interface BridgeRequest {
    readonly id: string;
    readonly method: string;
    readonly params?: Record<string, unknown>;
  }

  let directory: string;
  let server: Server;
  let sockets: Socket[];
  let requests: BridgeRequest[];
  let db: Database.Database;
  let queue: QueueRepository;
  let pipeline: MessagePipeline;
  let registry: ChannelRegistry;
  let config: TalondConfig;
  let receiptResults: string[];

  function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
  }
  function receive(timestamp: number, text: string, device: number): unknown {
    return {
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        subscription: 7,
        result: {
          account,
          envelope: {
            sourceUuid: account,
            sourceDevice: device,
            timestamp: timestamp + 1,
            syncMessage: {
              sentMessage: { destinationUuid: account, timestamp, message: text, expiresInSeconds: 0 },
            },
          },
        },
      },
    };
  }
  function push(value: unknown): void {
    for (const socket of sockets) socket.write(line(value));
  }
  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 400 && !predicate(); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(predicate(), label).toBe(true);
  }
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const connector = (): SignalConnector => registry.get('signal-test') as SignalConnector;

  beforeEach(async () => {
    sockets = [];
    requests = [];
    receiptResults = [];
    directory = fs.mkdtempSync(join(homedir(), '.signal-setup-'));
    fs.chmodSync(directory, 0o700);
    const socketPath = join(directory, 'rpc.sock');
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)) as BridgeRequest;
          buffer = buffer.slice(end + 1);
          requests.push(request);
          const answer = (result: unknown): void => {
            socket.write(line({ jsonrpc: '2.0', id: request.id, result }));
          };
          if (request.method === 'version') answer({ version: '0.14.9' });
          else if (request.method === 'listAccounts') answer([{ number: null, aci: account }]);
          else if (request.method === 'listDevices')
            answer([
              { id: 1, name: null, createdTimestamp: 100, lastSeenTimestamp: 500 },
              { id: humanDevice, name: null, createdTimestamp: 150, lastSeenTimestamp: 500 },
              { id: bridgeDevice, name: null, createdTimestamp: 200, lastSeenTimestamp: 500 },
            ]);
          else if (request.method === 'subscribeReceive') answer(7);
          else if (request.method === 'listContacts')
            answer([
              {
                uuid: (request.params?.recipient as string[])[0],
                isBlocked: false,
                unregistered: false,
                messageExpirationTime: 0,
              },
            ]);
          else if (request.method === 'send')
            answer({
              timestamp: 900,
              results: [{ type: 'SUCCESS', recipientAddress: { uuid: account, number: null, username: null } }],
            });
          else answer({});
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);

    db = createTestDb();
    queue = new QueueRepository(db);
    const channels = new ChannelRepository(db);
    const personas = new PersonaRepository(db);
    const bindings = new BindingRepository(db);
    const threads = new ThreadRepository(db);
    personas
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
    const queueManager = new QueueManager(
      queue,
      threads,
      { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60_000, concurrencyLimit: 2 },
      quiet,
    );
    pipeline = new MessagePipeline(
      new MessageRepository(db),
      threads,
      channels,
      queueManager,
      new ChannelRouter(bindings, quiet),
      new AuditLogger(quiet, new RepositoryAuditStore(new AuditRepository(db))),
      quiet,
    );
    const handle = pipeline.handleInboundEventWithReceipt.bind(pipeline);
    vi.spyOn(pipeline, 'handleInboundEventWithReceipt').mockImplementation((event) => {
      const result = handle(event);
      receiptResults.push(result.isOk() ? result.value : 'error');
      return result;
    });
    config = {
      channels: [
        {
          name: 'signal-test',
          type: 'signal',
          enabled: true,
          config: {
            accountMode: 'personal',
            socketPath,
            account,
            accountUuid: account,
            deviceId: bridgeDevice,
            deviceCreatedTimestamp: 200,
            allowedGroups: ['QQ=='],
          },
        },
      ],
      personas: [{ name: 'fixture' }],
      bindings: [],
    } as unknown as TalondConfig;
    registry = new ChannelRegistry(quiet);
    registerChannels(config, registry, {
      channelRepo: channels,
      bindingRepo: bindings,
      personaRepo: personas,
      messagePipeline: pipeline,
      logger: quiet,
      signal: {
        accounts: new SignalAccountStateRepository(db),
        leases: new SignalDestinationLeaseRepository(db),
        queue,
        generation: 1,
      },
    });
    await registry.startAll();
    await until(() => connector().status().state === 'ready', 'connector ready');
  });

  afterEach(async () => {
    await registry.stopAll();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('excludes Talon\'s own bridge-device output and accepts a verified human-device command', async () => {
    push(receive(1_000, 'own output', bridgeDevice));
    push(receive(2_000, 'human command', humanDevice));

    await until(() => count('queue_items') === 1, 'human command accepted');

    expect(receiptResults).toEqual(['accepted']);
    expect(count('messages')).toBe(1);
    expect((db.prepare('SELECT content FROM messages').get() as { content: string }).content).toContain(
      'human command',
    );
    expect(JSON.stringify(db.prepare('SELECT * FROM messages').all())).not.toContain('own output');
  });

  it('rolls back atomically on an enqueue failure and the replayed envelope completes exactly one turn', async () => {
    db.exec(`CREATE TRIGGER refuse_queue BEFORE INSERT ON queue_items
      BEGIN SELECT RAISE(ABORT, 'fixture enqueue failure'); END`);
    push(receive(3_000, 'retry me', humanDevice));
    await until(() => receiptResults.includes('error'), 'first attempt failed');

    expect(count('messages')).toBe(0);
    expect(count('threads')).toBe(0);
    expect(count('queue_items')).toBe(0);

    db.exec('DROP TRIGGER refuse_queue');
    push(receive(3_000, 'retry me', humanDevice));
    await until(() => count('queue_items') === 1, 'replay accepted');
    push(receive(3_000, 'retry me', humanDevice));
    await until(() => receiptResults.includes('duplicate'), 'replay deduplicated');

    expect(count('messages')).toBe(1);
    expect(count('queue_items')).toBe(1);
    expect(receiptResults.filter((entry) => entry === 'accepted')).toHaveLength(1);
  });

  it('delivers a background notification through the real runner with a trusted delivery id', async () => {
    const channelId = new ChannelRepository(db).findByName('signal-test')._unsafeUnwrap()!.id;
    const threads = new ThreadRepository(db);
    threads
      .insert({ id: 'bg-thread', channel_id: channelId, external_id: target, metadata: '{}' })
      ._unsafeUnwrap();
    const item = queue
      .enqueue({
        id: 'bg-item',
        thread_id: 'bg-thread',
        message_id: null,
        type: 'collaboration',
        payload: JSON.stringify({
          personaId: 'persona',
          kind: 'background_task_notification',
          taskId: 'task-1',
          status: 'completed',
          content: 'background finished',
        }),
        max_attempts: 3,
      })
      ._unsafeUnwrap();
    const runs = new RunRepository(db);
    const bridge = new HostToolsBridge({
      db,
      config: { ...config, storage: { type: 'sqlite', path: join(directory, 'missing.db') } },
      dataDir: directory,
      repos: { queue, thread: threads, channel: new ChannelRepository(db), run: runs },
      channelRegistry: registry,
      logger: quiet,
    } as never);
    const ctx = {
      db,
      logger: quiet,
      channelRegistry: registry,
      config,
      repos: {
        queue,
        thread: threads,
        channel: new ChannelRepository(db),
        run: runs,
        message: new MessageRepository(db),
        audit: new AuditRepository(db),
        binding: new BindingRepository(db),
        persona: new PersonaRepository(db),
      },
      hostToolsBridge: bridge,
      signalRuntime: {
        executions: new SignalToolExecutionRegistry({
          queue,
          runs,
          personas: { getByName: vi.fn() } as never,
        }),
        sealAndDrain: (generation: SignalRunGeneration) => bridge.sealSignalGeneration(generation),
      },
    } as unknown as DaemonContext;

    const result = await new AgentRunner(ctx).run(rowToQueueItem(queue.findById(item.id)._unsafeUnwrap()!));

    expect(result.isOk()).toBe(true);
    const sent = requests.filter((request) => request.method === 'send');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params?.message).toBe('background finished');
    expect(queue.findById('bg-item')._unsafeUnwrap()?.status).toBe('completed');
    const state = queue.inspectSignalDelivery('bg-item', Date.now())._unsafeUnwrap();
    expect(state).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { phase: 'delivered', kind: 'background', queueItemId: 'bg-item', successCount: 1 },
    });
    // The trusted delivery id is minted by the runner, never taken from the payload.
    const deliveryId = state.kind === 'checkpoint' ? state.checkpoint.deliveryId : '';
    expect(deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(sent[0])).not.toContain(deliveryId);
  });
});
