import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScheduleRepository } from '../../../../../src/core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('ScheduleRepository', () => {
  let db: Database.Database;
  let repo: ScheduleRepository;
  let personaId: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new ScheduleRepository(db);

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
  });

  afterEach(() => {
    db.close();
  });

  function makeSched(overrides: Partial<Parameters<ScheduleRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      persona_id: personaId,
      thread_id: null,
      type: 'cron' as const,
      expression: '0 * * * *',
      payload: '{}',
      enabled: 1,
      last_run_at: null,
      next_run_at: null,
      ...overrides,
    };
  }

  describe('insert', () => {
    it('inserts and returns the schedule', () => {
      const input = makeSched();
      const result = repo.insert(input);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe(input.id);
    });

    it('returns err for non-existent persona_id (FK)', () => {
      expect(repo.insert(makeSched({ persona_id: uuid() })).isErr()).toBe(true);
    });
  });

  describe('findDue', () => {
    it('returns schedules whose next_run_at has elapsed', () => {
      const past = Date.now() - 5000;
      repo.insert(makeSched({ next_run_at: past }));
      const rows = repo.findDue()._unsafeUnwrap();
      expect(rows).toHaveLength(1);
    });

    it('excludes schedules with future next_run_at', () => {
      const future = Date.now() + 60_000;
      repo.insert(makeSched({ next_run_at: future }));
      expect(repo.findDue()._unsafeUnwrap()).toHaveLength(0);
    });

    it('excludes disabled schedules', () => {
      const past = Date.now() - 1000;
      repo.insert(makeSched({ next_run_at: past, enabled: 0 }));
      expect(repo.findDue()._unsafeUnwrap()).toHaveLength(0);
    });

    it('excludes schedules with null next_run_at', () => {
      repo.insert(makeSched({ next_run_at: null }));
      expect(repo.findDue()._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('updateNextRun', () => {
    it('updates last_run_at and next_run_at', () => {
      const input = makeSched();
      repo.insert(input);
      const now = Date.now();
      const next = now + 3600_000;
      const result = repo.updateNextRun(input.id, now, next);
      const row = result._unsafeUnwrap();
      expect(row?.last_run_at).toBe(now);
      expect(row?.next_run_at).toBe(next);
    });

    it('sets next_run_at to null for one_shot schedules', () => {
      const input = makeSched({ type: 'one_shot' });
      repo.insert(input);
      const result = repo.updateNextRun(input.id, Date.now(), null);
      expect(result._unsafeUnwrap()?.next_run_at).toBeNull();
    });
  });

  describe('findByPersona', () => {
    it('returns schedules for a persona', () => {
      repo.insert(makeSched());
      repo.insert(makeSched());
      const rows = repo.findByPersona(personaId)._unsafeUnwrap();
      expect(rows).toHaveLength(2);
    });

    it('returns empty array for unknown persona', () => {
      expect(repo.findByPersona(uuid())._unsafeUnwrap()).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('permanently removes a schedule row', () => {
      const input = makeSched();
      repo.insert(input);
      const result = repo.delete(input.id, personaId);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.id).toBe(input.id);

      const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(input.id);
      expect(row).toBeUndefined();
    });

    it('returns null when schedule does not exist', () => {
      const result = repo.delete(uuid(), personaId);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns null when persona does not own the schedule', () => {
      const input = makeSched();
      repo.insert(input);
      const result = repo.delete(input.id, 'other-persona');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();

      // Row should still exist
      const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(input.id);
      expect(row).toBeDefined();
    });
  });

  describe('enable / disable', () => {
    it('disables an enabled schedule', () => {
      const input = makeSched({ enabled: 1 });
      repo.insert(input);
      repo.disable(input.id);
      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(input.id) as {
        enabled: number;
      };
      expect(row.enabled).toBe(0);
    });

    it('enables a disabled schedule', () => {
      const input = makeSched({ enabled: 0 });
      repo.insert(input);
      repo.enable(input.id);
      const row = db.prepare('SELECT enabled FROM schedules WHERE id = ?').get(input.id) as {
        enabled: number;
      };
      expect(row.enabled).toBe(1);
    });
  });
});
