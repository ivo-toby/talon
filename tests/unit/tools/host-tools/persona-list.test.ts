/**
 * Unit tests for PersonaListHandler.
 *
 * Tests cover:
 *   - Manifest metadata
 *   - Returns all live personas except the calling one with name and skills
 *   - Stale/unloaded personas are excluded (loader is source of truth)
 *   - Empty loader → returns empty array
 *   - Caller persona excluded from results
 */

import { describe, expect, it, vi } from 'vitest';
import { ok } from 'neverthrow';
import { PersonaListHandler } from '../../../../src/tools/host-tools/persona-list.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { PersonaLoader } from '../../../../src/personas/persona-loader.js';
import type { LoadedPersona } from '../../../../src/personas/persona-types.js';
import type { PersonaConfig } from '../../../../src/core/config/config-schema.js';

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

function makePersonaConfig(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    name: 'test',
    model: 'claude-test',
    skills: [],
    subagents: [],
    capabilities: { allow: [], requireApproval: [] },
    mounts: [],
    queryTimeoutMinutes: 10,
    maxConcurrent: undefined,
    ...overrides,
  } as unknown as PersonaConfig;
}

function makeLoadedPersona(overrides: Partial<LoadedPersona> = {}): LoadedPersona {
  return {
    config: makePersonaConfig(),
    resolvedCapabilities: { allow: [], requireApproval: [] },
    ...overrides,
  };
}

function makePersonaLoader(personas: Array<{ id?: string; name: string; skills: string[] }>): PersonaLoader {
  const names = personas.map((p) => p.name);
  return {
    listNames: vi.fn().mockReturnValue(names),
    getByName: vi.fn().mockImplementation((name: string) => {
      const found = personas.find((p) => p.name === name);
      if (!found) return ok(undefined);
      return ok(makeLoadedPersona({ config: makePersonaConfig({ name, skills: found.skills }) }));
    }),
    getById: vi.fn().mockImplementation((id: string) => {
      const found = personas.find((p) => p.id === id);
      if (!found) return ok(undefined);
      return ok(makeLoadedPersona({ config: makePersonaConfig({ name: found.name, skills: found.skills }) }));
    }),
  } as unknown as PersonaLoader;
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
  it('returns all live personas except the calling one with parsed skills', async () => {
    const loader = makePersonaLoader([
      { id: 'persona-001', name: 'coordinator', skills: [] },
      { id: 'persona-002', name: 'researcher', skills: ['web-research', 'summarize'] },
      { id: 'persona-003', name: 'coder', skills: ['typescript', 'testing'] },
    ]);
    const handler = new PersonaListHandler({ personaLoader: loader, logger: makeLogger() });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    expect(result.tool).toBe('persona.list');
    expect(result.requestId).toBe('req-001');
    expect(result.result).toEqual([
      { name: 'researcher', skills: ['web-research', 'summarize'] },
      { name: 'coder', skills: ['typescript', 'testing'] },
    ]);
  });

  it('returns empty array when no personas are loaded', async () => {
    const loader = makePersonaLoader([]);
    const handler = new PersonaListHandler({ personaLoader: loader, logger: makeLogger() });

    const result = await handler.execute({}, makeContext());

    expect(result.status).toBe('success');
    expect(result.result).toEqual([]);
  });

  it('returns empty skills array for a persona with no skills configured', async () => {
    const loader = makePersonaLoader([
      { id: 'persona-002', name: 'other', skills: [] },
    ]);
    const handler = new PersonaListHandler({ personaLoader: loader, logger: makeLogger() });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    expect(result.result).toEqual([{ name: 'other', skills: [] }]);
  });

  it('shows all personas when caller cannot be resolved from loader', async () => {
    const loader = makePersonaLoader([
      { id: 'persona-002', name: 'researcher', skills: [] },
    ]);
    const handler = new PersonaListHandler({ personaLoader: loader, logger: makeLogger() });

    // personaId that has no match in the loader — callerName will be null
    const result = await handler.execute({}, makeContext({ personaId: 'unknown-id' }));

    expect(result.status).toBe('success');
    // All personas are shown since we can't identify the caller
    expect(result.result).toEqual([{ name: 'researcher', skills: [] }]);
  });
});

// ---------------------------------------------------------------------------
// Stale persona isolation
// ---------------------------------------------------------------------------

describe('PersonaListHandler — only live personas shown', () => {
  it('does not include personas not present in PersonaLoader (stale DB rows)', async () => {
    // Loader only has 'researcher' — 'stale-persona' is in DB but not in loader
    const loader = makePersonaLoader([
      { id: 'persona-002', name: 'researcher', skills: [] },
    ]);
    const handler = new PersonaListHandler({ personaLoader: loader, logger: makeLogger() });

    const result = await handler.execute({}, makeContext({ personaId: 'persona-001' }));

    expect(result.status).toBe('success');
    const names = (result.result as Array<{ name: string }>).map((c) => c.name);
    expect(names).not.toContain('stale-persona');
    expect(names).toContain('researcher');
  });
});
