import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { err, ok } from 'neverthrow';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { reconcileBindings, registerChannels } from '../../../src/channels/channel-setup.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';
import { PipelineError } from '../../../src/core/errors/index.js';
import type { InboundEvent } from '../../../src/channels/channel-types.js';
import type { MessagePipeline } from '../../../src/pipeline/message-pipeline.js';
import type { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import type { TalondConfig, BindingConfig } from '../../../src/core/config/config-types.js';

// Capture the handler channel-setup registers on the connector so the
// async awaiting behavior can be exercised directly, plus the factory
// arguments so the images-settings passthrough can be asserted.
const connectorCapture = vi.hoisted(() => ({
  handler: undefined as ((event: InboundEvent) => void | Promise<void>) | undefined,
  factoryArgs: [] as unknown[][],
}));

vi.mock('../../../src/daemon/channel-factory.js', () => ({
  createConnector: (...args: unknown[]) => {
    connectorCapture.factoryArgs.push(args);
    return {
      type: 'telegram',
      name: 'tg',
      start: async () => {},
      stop: async () => {},
      send: async () => ok(undefined),
      onMessage: (fn: (event: InboundEvent) => void | Promise<void>) => {
        connectorCapture.handler = fn;
      },
    };
  },
}));

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

// ---------------------------------------------------------------------------
// registerChannels() inbound handler
// ---------------------------------------------------------------------------

describe('registerChannels() inbound handler', () => {
  let db: Database.Database;
  let channelRepo: ChannelRepository;
  let personaRepo: PersonaRepository;
  let bindingRepo: BindingRepository;
  let lines: string[];
  let log: pino.Logger;

  const event: InboundEvent = {
    channelType: 'telegram',
    channelName: 'tg',
    externalThreadId: 'ext-1',
    senderId: 'u1',
    idempotencyKey: 'k1',
    content: 'hi',
    timestamp: 1_700_000_000_000,
  };

  beforeEach(() => {
    db = createTestDb();
    channelRepo = new ChannelRepository(db);
    personaRepo = new PersonaRepository(db);
    bindingRepo = new BindingRepository(db);
    lines = [];
    log = pino({ level: 'info' }, { write: (chunk: unknown) => lines.push(String(chunk)) });
    connectorCapture.handler = undefined;
    connectorCapture.factoryArgs.length = 0;
  });

  afterEach(() => {
    db.close();
  });

  function register(pipeline: MessagePipeline): void {
    registerChannels(
      {
        channels: [{ name: 'tg', type: 'telegram', enabled: true, config: {} }],
        personas: [],
        images: {
          maxInputBytes: 12_345_678,
          maxPerMessage: 7,
          maxPerInspection: 5,
          maxEdge: 4096,
          jpegQuality: 85,
          retentionHours: 24,
        },
      } as unknown as TalondConfig,
      { register: vi.fn() } as unknown as ChannelRegistry,
      { channelRepo, bindingRepo, personaRepo, messagePipeline: pipeline, logger: log },
    );
  }

  it('forwards the validated images limits to the connector factory', async () => {
    const pipeline = {
      handleInboundEvent: vi.fn().mockResolvedValue(ok('enqueued')),
    } as unknown as MessagePipeline;
    register(pipeline);

    expect(connectorCapture.factoryArgs).toHaveLength(1);
    expect(connectorCapture.factoryArgs[0]![4]).toEqual({
      maxInputBytes: 12_345_678,
      maxPerMessage: 7,
    });
  });

  it('awaits the async pipeline Result and logs Err outcomes', async () => {
    const pipeline = {
      handleInboundEvent: vi.fn().mockResolvedValue(err(new PipelineError('boom'))),
    } as unknown as MessagePipeline;
    register(pipeline);

    expect(connectorCapture.handler).toBeDefined();
    // Awaiting the handler must surface the pipeline Err as a logged failure —
    // possible only because the handler awaits the pipeline Promise.
    await connectorCapture.handler!(event);

    expect(pipeline.handleInboundEvent).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.includes('inbound message pipeline failed'))).toBe(true);
  });

  it('logs nothing on Ok outcomes', async () => {
    const pipeline = {
      handleInboundEvent: vi.fn().mockResolvedValue(ok('enqueued')),
    } as unknown as MessagePipeline;
    register(pipeline);

    await connectorCapture.handler!(event);

    expect(lines.some((line) => line.includes('pipeline failed'))).toBe(false);
  });

  it('contains unexpected throws instead of producing an unhandled rejection', async () => {
    const pipeline = {
      handleInboundEvent: vi.fn().mockRejectedValue(new Error('kaboom')),
    } as unknown as MessagePipeline;
    register(pipeline);

    await expect(connectorCapture.handler!(event)).resolves.toBeUndefined();
    expect(lines.some((line) => line.includes('pipeline threw'))).toBe(true);
  });
});
