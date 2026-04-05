import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('PersonaRepository', () => {
  let db: Database.Database;
  let repo: PersonaRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new PersonaRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function makePersona(overrides: Partial<Parameters<PersonaRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      name: `persona-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      max_concurrent: null,
      ...overrides,
    };
  }

  describe('schema', () => {
    it('does not expose a `mounts` column (dropped in migration 010)', () => {
      const cols = db.pragma('table_info(personas)') as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).not.toContain('mounts');
    });
  });

  describe('insert', () => {
    it('inserts and returns the new persona', () => {
      const input = makePersona({ name: 'alfred' });
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      const row = result._unsafeUnwrap();
      expect(row.name).toBe('alfred');
      expect(row.model).toBe('claude-sonnet-4-6');
    });

    it('returns err on duplicate name', () => {
      repo.insert(makePersona({ name: 'alice' }));
      const result = repo.insert(makePersona({ name: 'alice' }));
      expect(result.isErr()).toBe(true);
    });
  });

  describe('findById', () => {
    it('returns the persona when it exists', () => {
      const input = makePersona();
      repo.insert(input);
      const row = repo.findById(input.id)._unsafeUnwrap();
      expect(row?.id).toBe(input.id);
    });

    it('returns null for unknown id', () => {
      expect(repo.findById(uuid())._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findByName', () => {
    it('returns the persona by name', () => {
      const input = makePersona({ name: 'bob' });
      repo.insert(input);
      expect(repo.findByName('bob')._unsafeUnwrap()?.id).toBe(input.id);
    });

    it('returns null for unknown name', () => {
      expect(repo.findByName('unknown')._unsafeUnwrap()).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns all personas ordered by name', () => {
      repo.insert(makePersona({ name: 'zara' }));
      repo.insert(makePersona({ name: 'alice' }));
      repo.insert(makePersona({ name: 'mike' }));
      const rows = repo.findAll()._unsafeUnwrap();
      const names = rows.map((r) => r.name);
      expect(names[0]).toBe('alice');
      expect(names[1]).toBe('mike');
      expect(names[2]).toBe('zara');
    });

    it('returns empty array when no personas exist', () => {
      expect(repo.findAll()._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('updates specified fields', () => {
      const input = makePersona();
      repo.insert(input);
      const result = repo.update(input.id, { model: 'claude-opus-4-6', max_concurrent: 3 });
      const row = result._unsafeUnwrap();
      expect(row?.model).toBe('claude-opus-4-6');
      expect(row?.max_concurrent).toBe(3);
    });

    it('returns null for unknown id', () => {
      expect(repo.update(uuid(), { model: 'x' })._unsafeUnwrap()).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the persona', () => {
      const input = makePersona();
      repo.insert(input);
      repo.delete(input.id);
      expect(repo.findById(input.id)._unsafeUnwrap()).toBeNull();
    });
  });
});
