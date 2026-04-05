/**
 * Unit tests for PersonaAgentCard — persona to A2A agent card mapping.
 */

import { describe, it, expect } from 'vitest';
import { buildAgentCard, buildAgentCardRegistry } from '../../../src/a2a/persona-agent-card.js';
import type { LoadedPersona } from '../../../src/personas/persona-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePersona(overrides: Partial<LoadedPersona['config']> = {}): LoadedPersona {
  return {
    config: {
      name: 'software-engineer',
      model: 'claude-sonnet-4-6',
      systemPromptFile: undefined,
      skills: ['code-review', 'testing'],
      subagents: [],
      capabilities: {
        allow: ['read-repo', 'run-tests'],
        requireApproval: ['write-files'],
      },
      maxConcurrent: undefined,
      provider: undefined,
      ...overrides,
    },
    description: 'A software engineering persona',
    systemPromptContent: undefined,
    personalityContent: undefined,
    taskPromptPaths: undefined,
    resolvedCapabilities: {
      allow: ['read-repo', 'run-tests'],
      requireApproval: ['write-files'],
    },
  };
}

// ---------------------------------------------------------------------------
// buildAgentCard
// ---------------------------------------------------------------------------

describe('buildAgentCard', () => {
  it('sets id equal to persona name', () => {
    const card = buildAgentCard(makePersona());
    expect(card.id).toBe('software-engineer');
  });

  it('sets name equal to persona config name', () => {
    const card = buildAgentCard(makePersona());
    expect(card.name).toBe('software-engineer');
  });

  it('uses frontmatter description when available', () => {
    const card = buildAgentCard(makePersona());
    expect(card.description).toBe('A software engineering persona');
  });

  it('generates fallback description when persona has no description', () => {
    const persona = makePersona();
    persona.description = undefined;
    const card = buildAgentCard(persona);
    expect(card.description).toBe('Talon persona: software-engineer');
  });

  it('sets url to /a2a/agents/:name', () => {
    const card = buildAgentCard(makePersona());
    expect(card.url).toBe('/a2a/agents/software-engineer');
  });

  it('version is a non-empty string', () => {
    const card = buildAgentCard(makePersona());
    expect(typeof card.version).toBe('string');
    expect(card.version.length).toBeGreaterThan(0);
  });

  it('maps persona skills to card skills', () => {
    const card = buildAgentCard(makePersona());
    expect(card.skills).toHaveLength(2);
    expect(card.skills[0]).toMatchObject({ id: 'code-review', name: 'code-review' });
    expect(card.skills[1]).toMatchObject({ id: 'testing', name: 'testing' });
  });

  it('returns empty skills array when persona has no skills', () => {
    const card = buildAgentCard(makePersona({ skills: [] }));
    expect(card.skills).toHaveLength(0);
  });

  it('sets defaultInputModes to text/plain only for M1', () => {
    const card = buildAgentCard(makePersona());
    expect(card.defaultInputModes).toEqual(['text/plain']);
  });

  it('sets defaultOutputModes to text/plain only for M1', () => {
    const card = buildAgentCard(makePersona());
    expect(card.defaultOutputModes).toEqual(['text/plain']);
  });

  it('includes persona name in metadata', () => {
    const card = buildAgentCard(makePersona());
    expect(card.metadata.personaName).toBe('software-engineer');
  });

  it('includes model in metadata', () => {
    const card = buildAgentCard(makePersona());
    expect(card.metadata.model).toBe('claude-sonnet-4-6');
  });

  it('includes capabilities in metadata', () => {
    const card = buildAgentCard(makePersona());
    expect(card.metadata.capabilities.allow).toEqual(['read-repo', 'run-tests']);
    expect(card.metadata.capabilities.requireApproval).toEqual(['write-files']);
  });

  it('marks card as internal only', () => {
    const card = buildAgentCard(makePersona());
    expect(card.metadata.internalOnly).toBe(true);
  });

  it('includes systemPromptFile in metadata when present', () => {
    const card = buildAgentCard(makePersona({ systemPromptFile: '/path/to/system.md' }));
    expect(card.metadata.systemPromptFile).toBe('/path/to/system.md');
  });

  it('omits systemPromptFile from metadata when absent', () => {
    const card = buildAgentCard(makePersona({ systemPromptFile: undefined }));
    expect(card.metadata.systemPromptFile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildAgentCardRegistry
// ---------------------------------------------------------------------------

describe('buildAgentCardRegistry', () => {
  it('returns a map keyed by persona name', () => {
    const personas: LoadedPersona[] = [
      makePersona({ name: 'assistant' }),
      makePersona({ name: 'software-engineer' }),
    ];
    const registry = buildAgentCardRegistry(personas);
    expect(registry.has('assistant')).toBe(true);
    expect(registry.has('software-engineer')).toBe(true);
  });

  it('returns an empty map for empty input', () => {
    const registry = buildAgentCardRegistry([]);
    expect(registry.size).toBe(0);
  });

  it('each entry is a valid agent card', () => {
    const personas: LoadedPersona[] = [makePersona()];
    const registry = buildAgentCardRegistry(personas);
    const card = registry.get('software-engineer');
    expect(card).toBeDefined();
    expect(card!.id).toBe('software-engineer');
  });
});
