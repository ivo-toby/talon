/**
 * Unit tests for PersonaListHandler.
 *
 * Tests cover:
 *   - Manifest metadata
 *   - Returns all personas except the calling one with name and parsed skills
 *   - Malformed skills JSON → empty array for that persona, no failure
 *   - Empty personas table → empty array
 *   - personaRepo.findAll() error → tool error result
 */

import { describe, expect, it, vi } from 'vitest';
import { err, ok } from 'neverthrow';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { PersonaListHandler } from '../../../../src/tools/host-tools/persona-list.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { PersonaRepository, PersonaRow } from '../../../../src/core/database/repositories/persona-repository.js';
import { DbError } from '../../../../src/core/errors/index.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makePersonaRow(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return {
    id: 'persona-001',
    name: 'coordinator',
    model: 'gpt-test',
    system_prompt_file: null,
    skills: '[]',
    capabilities: '{}',
    mounts: '[]',
    max_concurrent: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makePersonaRepo(rows: PersonaRow[] = []): PersonaRepository {
  return {
    findAll: vi.fn().mockReturnValue(ok(rows)),
  } as unknown as PersonaRepository;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('PersonaListHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(PersonaListHandler.manifest.name).toBe('persona.list');
  });

  it('requires persona.send:* capability', () => {
    expect(PersonaListHandler.manifest.capabilities).toContain('persona.send:*');
  });

  it('runs on host', () => {
    expect(PersonaListHandler.manifest.executionLocation).toBe('host');
  });
});

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe('PersonaListHandler — success', () => {
  it('returns all personas except the calling one with parsed skills', async () => {
    const rows = [
      makePersonaRow({ id: 'persona-001', name: 'coordinator', skills: '[]' }),
      makePersonaRow({
        id: 'persona-002',
        name: 'researcher',
        skills: '["web-research","summarize"]',
      }),
      makePersonaRow({
        id: 'persona-003',
        name: 'coder',
        skills: '["typescript","testing"]',
      }),
    ];
    const handler = new PersonaListHandler({
      personaRepo: makePersonaRepo(rows),
      logger: makeLogger(),
    });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    expect(result.tool).toBe('persona.list');
    expect(result.requestId).toBe('req-001');
    expect(result.result).toEqual([
      { name: 'researcher', description: null, skills: ['web-research', 'summarize'] },
      { name: 'coder', description: null, skills: ['typescript', 'testing'] },
    ]);
  });

  it('returns empty array when personas table is empty', async () => {
    const handler = new PersonaListHandler({
      personaRepo: makePersonaRepo([]),
      logger: makeLogger(),
    });

    const result = await handler.execute({}, makeContext());

    expect(result.status).toBe('success');
    expect(result.result).toEqual([]);
  });

  it('returns empty skills array for a persona with no skills configured (empty JSON array)', async () => {
    const rows = [
      makePersonaRow({ id: 'persona-002', name: 'other', skills: '[]' }),
    ];
    const handler = new PersonaListHandler({
      personaRepo: makePersonaRepo(rows),
      logger: makeLogger(),
    });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    expect(result.result).toEqual([{ name: 'other', description: null, skills: [] }]);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

describe('PersonaListHandler — graceful degradation', () => {
  it('returns empty skills array when skills column contains malformed JSON', async () => {
    const rows = [
      makePersonaRow({ id: 'persona-002', name: 'broken', skills: 'not-json' }),
    ];
    const handler = new PersonaListHandler({
      personaRepo: makePersonaRepo(rows),
      logger: makeLogger(),
    });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    expect(result.result).toEqual([{ name: 'broken', description: null, skills: [] }]);
  });

  it('returns empty skills array when skills column is a JSON object (not array)', async () => {
    const rows = [
      makePersonaRow({ id: 'persona-002', name: 'weird', skills: '{"key":"value"}' }),
    ];
    const handler = new PersonaListHandler({
      personaRepo: makePersonaRepo(rows),
      logger: makeLogger(),
    });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    expect(result.result).toEqual([{ name: 'weird', description: null, skills: [] }]);
  });
});

// ---------------------------------------------------------------------------
// Description extraction
// ---------------------------------------------------------------------------

describe('PersonaListHandler — description extraction', () => {
  it('returns null when system_prompt_file is null', async () => {
    const rows = [makePersonaRow({ id: 'persona-002', name: 'other', system_prompt_file: null })];
    const handler = new PersonaListHandler({ personaRepo: makePersonaRepo(rows), logger: makeLogger() });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    const cards = result.result as Array<{ name: string; description: string | null; skills: string[] }>;
    expect(cards[0].description).toBeNull();
  });

  it('extracts first non-empty line stripping leading # and whitespace', async () => {
    vi.mocked(readFileSync).mockReturnValueOnce('# My Persona Title\n\nSome content' as unknown as Buffer);
    const rows = [makePersonaRow({ id: 'persona-002', name: 'titled', system_prompt_file: '/path/to/sys.md' })];
    const handler = new PersonaListHandler({ personaRepo: makePersonaRepo(rows), logger: makeLogger() });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    const cards = result.result as Array<{ name: string; description: string | null; skills: string[] }>;
    expect(cards[0].description).toBe('My Persona Title');
  });

  it('extracts first non-empty line when no # prefix', async () => {
    vi.mocked(readFileSync).mockReturnValueOnce('You are a coder.\n\nDetails here.' as unknown as Buffer);
    const rows = [makePersonaRow({ id: 'persona-002', name: 'coder2', system_prompt_file: '/path/to/sys.md' })];
    const handler = new PersonaListHandler({ personaRepo: makePersonaRepo(rows), logger: makeLogger() });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    const cards = result.result as Array<{ name: string; description: string | null; skills: string[] }>;
    expect(cards[0].description).toBe('You are a coder.');
  });

  it('returns null when system_prompt_file does not exist (read throws)', async () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); });
    const rows = [makePersonaRow({ id: 'persona-002', name: 'missing', system_prompt_file: '/no/such/file.md' })];
    const handler = new PersonaListHandler({ personaRepo: makePersonaRepo(rows), logger: makeLogger() });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    const cards = result.result as Array<{ name: string; description: string | null; skills: string[] }>;
    expect(cards[0].description).toBeNull();
  });

  it('skips blank leading lines and returns first non-empty trimmed line', async () => {
    vi.mocked(readFileSync).mockReturnValueOnce('\n\n## Section\nActual content' as unknown as Buffer);
    const rows = [makePersonaRow({ id: 'persona-002', name: 'spaced', system_prompt_file: '/path/to/sys.md' })];
    const handler = new PersonaListHandler({ personaRepo: makePersonaRepo(rows), logger: makeLogger() });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    const cards = result.result as Array<{ name: string; description: string | null; skills: string[] }>;
    expect(cards[0].description).toBe('Section');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('PersonaListHandler — errors', () => {
  it('returns error result when personaRepo.findAll() fails', async () => {
    const repo = {
      findAll: vi.fn().mockReturnValue(err(new DbError('DB unavailable'))),
    } as unknown as PersonaRepository;
    const handler = new PersonaListHandler({ personaRepo: repo, logger: makeLogger() });

    const result = await handler.execute({}, makeContext());

    expect(result.status).toBe('error');
    expect(result.tool).toBe('persona.list');
    expect(result.error).toMatch(/DB unavailable/);
  });
});
