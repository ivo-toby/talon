import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { ok } from '../../../src/core/types/result.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import {
  BROWSER_VOICE_CHANNEL_NAME,
  registerVoiceChannel,
  registerVoiceConnector,
  reconcileBindings,
} from '../../../src/channels/channel-setup.js';
import type { ChannelConnector } from '../../../src/channels/channel-types.js';
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

describe('registerVoiceChannel()', () => {
  it('persists only sanitized logical metadata and is idempotent', () => {
    const db = createTestDb();
    const channelRepo = new ChannelRepository(db);

    const first = registerVoiceChannel({ channelRepo, logger });
    const second = registerVoiceChannel({ channelRepo, logger });

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(second._unsafeUnwrap()).toBe(first._unsafeUnwrap());
    const row = db
      .prepare('SELECT type, name, config, credentials_ref, enabled FROM channels WHERE name = ?')
      .get(BROWSER_VOICE_CHANNEL_NAME) as {
      type: string;
      name: string;
      config: string;
      credentials_ref: string | null;
      enabled: number;
    };
    expect(row).toEqual({
      type: 'voice',
      name: BROWSER_VOICE_CHANNEL_NAME,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });
    db.close();
  });

  it('binds the logical voice channel to the configured voice persona', () => {
    const db = createTestDb();
    const channelRepo = new ChannelRepository(db);
    const bindingRepo = new BindingRepository(db);
    const personaRepo = new PersonaRepository(db);
    const personaId = uuid();
    personaRepo.insert({
      id: personaId,
      name: 'voice-persona',
      model: 'model',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    const registered = registerVoiceChannel({
      channelRepo,
      bindingRepo,
      personaId,
      logger,
    });

    expect(registered.isOk()).toBe(true);
    expect(bindingRepo.findDefaultForChannel(registered._unsafeUnwrap())._unsafeUnwrap()).toMatchObject({
      persona_id: personaId,
      is_default: 1,
    });
    db.close();
  });

  it('rejects a persisted ordinary channel without changing its metadata or binding', () => {
    const db = createTestDb();
    try {
      const channelRepo = new ChannelRepository(db);
      const bindingRepo = new BindingRepository(db);
      const personaRepo = new PersonaRepository(db);
      const ordinaryPersonaId = uuid();
      const voicePersonaId = uuid();
      channelRepo.insert({
        id: uuid(),
        type: 'terminal',
        name: BROWSER_VOICE_CHANNEL_NAME,
        config: '{"port":17700}',
        credentials_ref: 'fixture-ref',
        enabled: 1,
      });
      personaRepo.insert({
        id: ordinaryPersonaId,
        name: 'ordinary-persona',
        model: 'model',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      });
      personaRepo.insert({
        id: voicePersonaId,
        name: 'voice-persona',
        model: 'model',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      });
      const channel = channelRepo.findByName(BROWSER_VOICE_CHANNEL_NAME)._unsafeUnwrap()!;
      bindingRepo.insert({
        id: uuid(),
        channel_id: channel.id,
        thread_id: null,
        persona_id: ordinaryPersonaId,
        is_default: 1,
      });

      const registered = registerVoiceChannel({
        channelRepo,
        bindingRepo,
        personaId: voicePersonaId,
        logger,
      });

      expect(registered.isErr()).toBe(true);
      expect(channelRepo.findByName(BROWSER_VOICE_CHANNEL_NAME)._unsafeUnwrap()).toMatchObject({
        type: 'terminal',
        config: '{"port":17700}',
        credentials_ref: 'fixture-ref',
      });
      expect(bindingRepo.findDefaultForChannel(channel.id)._unsafeUnwrap()).toMatchObject({
        persona_id: ordinaryPersonaId,
      });
    } finally {
      db.close();
    }
  });
});

describe('registerVoiceConnector()', () => {
  function connectorDeps(db: Database.Database, registry: ChannelRegistry) {
    const channelRepo = new ChannelRepository(db);
    const registered = registerVoiceChannel({ channelRepo, logger });
    expect(registered.isOk()).toBe(true);
    return {
      channelRepo,
      channelRegistry: registry,
      threadRepository: new ThreadRepository(db),
      sessionService: {
        notifyThread: async () =>
          ok({ sessionId: 'session-1', notificationId: 'notification-1', speechRequested: false }),
      },
      logger,
    };
  }

  it('rejects an incompatible registry connector without replacing it', () => {
    const db = createTestDb();
    try {
      const registry = new ChannelRegistry(logger);
      const ordinaryConnector = {
        type: 'terminal',
        name: BROWSER_VOICE_CHANNEL_NAME,
        start: async () => undefined,
        stop: async () => undefined,
        onMessage: () => undefined,
        send: async () => ok(undefined),
        format: (markdown: string) => markdown,
      } as ChannelConnector;
      registry.register(ordinaryConnector);

      const result = registerVoiceConnector(connectorDeps(db, registry));

      expect(result.isErr()).toBe(true);
      expect(registry.get(BROWSER_VOICE_CHANNEL_NAME)).toBe(ordinaryConnector);
    } finally {
      db.close();
    }
  });

  it('keeps an existing browser voice connector idempotent', () => {
    const db = createTestDb();
    try {
      const registry = new ChannelRegistry(logger);
      const deps = connectorDeps(db, registry);
      const first = registerVoiceConnector(deps);
      const connector = registry.get(BROWSER_VOICE_CHANNEL_NAME);
      const second = registerVoiceConnector(deps);

      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
      expect(registry.get(BROWSER_VOICE_CHANNEL_NAME)).toBe(connector);
    } finally {
      db.close();
    }
  });
});
