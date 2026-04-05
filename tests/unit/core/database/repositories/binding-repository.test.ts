import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BindingRepository } from '../../../../../src/core/database/repositories/binding-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('BindingRepository', () => {
  let db: Database.Database;
  let repo: BindingRepository;
  let channelId: string;
  let personaId: string;
  let personaIdB: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new BindingRepository(db);

    // Seed prerequisite rows to satisfy foreign key constraints.
    const channels = new ChannelRepository(db);
    channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'telegram',
      name: `ch-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const personas = new PersonaRepository(db);
    personaId = uuid();
    personas.insert({
      id: personaId,
      name: `persona-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      max_concurrent: null,
    });
    personaIdB = uuid();
    personas.insert({
      id: personaIdB,
      name: `persona-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      max_concurrent: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeBinding(overrides: Partial<Parameters<BindingRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      channel_id: channelId,
      thread_id: uuid(),
      persona_id: personaId,
      is_default: 0,
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the binding', () => {
      const input = makeBinding();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe(input.id);
    });

    it('returns err on duplicate (channel_id, thread_id)', () => {
      const threadId = uuid();
      repo.insert(makeBinding({ thread_id: threadId }));
      const result = repo.insert(makeBinding({ thread_id: threadId }));
      expect(result.isErr()).toBe(true);
    });

    it('returns err for non-existent channel_id (FK violation)', () => {
      const result = repo.insert(makeBinding({ channel_id: uuid() }));
      expect(result.isErr()).toBe(true);
    });
  });

  describe('findByChannelAndThread', () => {
    it('finds binding by channel+thread pair', () => {
      const input = makeBinding();
      repo.insert(input);
      const result = repo.findByChannelAndThread(input.channel_id, input.thread_id!);
      expect(result._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for non-existent pair', () => {
      expect(repo.findByChannelAndThread(uuid(), uuid())._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findDefaultForChannel', () => {
    it('returns the default binding', () => {
      const input = makeBinding({ is_default: 1, thread_id: null });
      repo.insert(input);
      const result = repo.findDefaultForChannel(channelId);
      expect(result._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null when no default binding exists', () => {
      expect(repo.findDefaultForChannel(uuid())._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByPersona', () => {
    it('returns all bindings for a persona', () => {
      repo.insert(makeBinding());
      repo.insert(makeBinding());
      const rows = repo.findByPersona(personaId)._unsafeUnwrap();
      expect(rows).toHaveLength(2);
    });

    it('returns empty array for unknown persona', () => {
      expect(repo.findByPersona(uuid())._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('removes the binding', () => {
      const input = makeBinding();
      repo.insert(input);
      repo.delete(input.id);
      expect(repo.findByChannelAndThread(input.channel_id, input.thread_id!)._unsafeUnwrap()).toBeNull();
    });
  });

  describe('deleteDefaultForChannel', () => {
    it('deletes the default binding for a channel', () => {
      const bindingId = uuid();
      repo.insert({
        id: bindingId,
        channel_id: channelId,
        thread_id: null,
        persona_id: personaId,
        is_default: 1,
      });

      const result = repo.deleteDefaultForChannel(channelId);
      expect(result.isOk()).toBe(true);

      const found = repo.findDefaultForChannel(channelId);
      expect(found.isOk()).toBe(true);
      expect(found._unsafeUnwrap()).toBeNull();
    });

    it('does nothing when no default binding exists', () => {
      const result = repo.deleteDefaultForChannel(channelId);
      expect(result.isOk()).toBe(true);
    });
  });

  describe('updatePersona', () => {
    it('updates the persona on an existing binding', () => {
      const bindingId = uuid();
      repo.insert({
        id: bindingId,
        channel_id: channelId,
        thread_id: null,
        persona_id: personaId,
        is_default: 1,
      });

      const result = repo.updatePersona(bindingId, personaIdB);
      expect(result.isOk()).toBe(true);

      const found = repo.findDefaultForChannel(channelId);
      expect(found.isOk()).toBe(true);
      expect(found._unsafeUnwrap()!.persona_id).toBe(personaIdB);
    });
  });
});
