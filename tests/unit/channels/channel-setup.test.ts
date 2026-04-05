import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { reconcileBindings } from '../../../src/channels/channel-setup.js';
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
      system_prompt_file: null, skills: '[]', capabilities: '{}', max_concurrent: null,
    });
    personaRepo.insert({
      id: personaIdB, name: 'bob', model: 'claude-sonnet-4-6',
      system_prompt_file: null, skills: '[]', capabilities: '{}', max_concurrent: null,
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
