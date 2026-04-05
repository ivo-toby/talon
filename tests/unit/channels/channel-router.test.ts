/**
 * Unit tests for ChannelRouter.
 *
 * Uses an in-memory SQLite database with real migrations and repositories
 * so the routing logic is exercised against actual SQL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { ChannelRouter } from '../../../src/channels/channel-router.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) {
    throw new Error(`Test DB migration failed: ${result.error.message}`);
  }
  return db;
}

function uuid(): string {
  return uuidv4();
}

function testLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelRouter', () => {
  let db: Database.Database;
  let bindingRepo: BindingRepository;
  let channelRepo: ChannelRepository;
  let personaRepo: PersonaRepository;
  let router: ChannelRouter;

  // IDs seeded once per test
  let channelId: string;
  let personaId: string;
  let defaultPersonaId: string;

  beforeEach(() => {
    db = createTestDb();
    bindingRepo = new BindingRepository(db);
    channelRepo = new ChannelRepository(db);
    personaRepo = new PersonaRepository(db);
    router = new ChannelRouter(bindingRepo, testLogger());

    // Seed a channel row (required by FK on bindings).
    channelId = uuid();
    channelRepo.insert({
      id: channelId,
      type: 'telegram',
      name: `test-channel-${uuid()}`,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    // Seed two persona rows.
    personaId = uuid();
    personaRepo.insert({
      id: personaId,
      name: `persona-specific-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      max_concurrent: null,
    });

    defaultPersonaId = uuid();
    personaRepo.insert({
      id: defaultPersonaId,
      name: `persona-default-${uuid()}`,
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

  // -------------------------------------------------------------------------
  // Specific binding
  // -------------------------------------------------------------------------

  describe('specific binding', () => {
    it('returns the persona from the specific (channel, thread) binding', () => {
      const threadId = uuid();
      bindingRepo.insert({
        id: uuid(),
        channel_id: channelId,
        thread_id: threadId,
        persona_id: personaId,
        is_default: 0,
      });

      const result = router.resolvePersona(channelId, threadId);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(personaId);
    });

    it('prefers specific binding over default when both exist', () => {
      const threadId = uuid();

      // Insert specific binding (personaId) and default binding (defaultPersonaId).
      bindingRepo.insert({
        id: uuid(),
        channel_id: channelId,
        thread_id: threadId,
        persona_id: personaId,
        is_default: 0,
      });
      bindingRepo.insert({
        id: uuid(),
        channel_id: channelId,
        thread_id: null,
        persona_id: defaultPersonaId,
        is_default: 1,
      });

      const result = router.resolvePersona(channelId, threadId);

      expect(result._unsafeUnwrap()).toBe(personaId);
    });
  });

  // -------------------------------------------------------------------------
  // Default binding
  // -------------------------------------------------------------------------

  describe('default binding', () => {
    it('falls back to the channel default when there is no specific binding', () => {
      const threadId = uuid();
      bindingRepo.insert({
        id: uuid(),
        channel_id: channelId,
        thread_id: null,
        persona_id: defaultPersonaId,
        is_default: 1,
      });

      const result = router.resolvePersona(channelId, threadId);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(defaultPersonaId);
    });

    it('returns the default persona when threadId is null', () => {
      bindingRepo.insert({
        id: uuid(),
        channel_id: channelId,
        thread_id: null,
        persona_id: defaultPersonaId,
        is_default: 1,
      });

      const result = router.resolvePersona(channelId, null);

      expect(result._unsafeUnwrap()).toBe(defaultPersonaId);
    });
  });

  // -------------------------------------------------------------------------
  // No binding
  // -------------------------------------------------------------------------

  describe('no binding found', () => {
    it('returns Ok(null) when there are no bindings at all', () => {
      const result = router.resolvePersona(channelId, uuid());

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns Ok(null) when there is a specific binding for a different thread', () => {
      bindingRepo.insert({
        id: uuid(),
        channel_id: channelId,
        thread_id: uuid(), // different thread
        persona_id: personaId,
        is_default: 0,
      });

      const result = router.resolvePersona(channelId, uuid());

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns Ok(null) when there are no bindings for a different channel', () => {
      // Seed a binding for our known channel.
      bindingRepo.insert({
        id: uuid(),
        channel_id: channelId,
        thread_id: null,
        persona_id: defaultPersonaId,
        is_default: 1,
      });

      // Query with an entirely different channel ID.
      const otherChannelId = uuid();
      const result = router.resolvePersona(otherChannelId, uuid());

      expect(result._unsafeUnwrap()).toBeNull();
    });
  });
});
