/**
 * Unit tests for PersonaLoader personality folder loading.
 *
 * Tests cover:
 *   - Loading and concatenating personality/*.md files in alphabetical order
 *   - Returning undefined when no personality folder exists
 *   - Returning undefined when personality folder is empty
 *   - Filtering to only .md files
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { PersonaLoader } from '../../../src/personas/persona-loader.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import type { PersonaConfig } from '../../../src/core/config/config-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Database.Database;
let repo: PersonaRepository;
let loader: PersonaLoader;

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as import('pino').Logger;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'talon-personality-test-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migResult = runMigrations(
    db,
    join(import.meta.dirname, '../../../src/core/database/migrations'),
  );
  if (migResult.isErr()) throw new Error(`Migration failed: ${migResult.error.message}`);
  repo = new PersonaRepository(db);
  loader = new PersonaLoader(repo, makeLogger());
});

afterEach(async () => {
  db.close();
  await rm(tmpDir, { recursive: true, force: true });
});

async function scaffoldPersona(
  name: string,
  personality?: Record<string, string>,
): Promise<PersonaConfig> {
  const personaDir = join(tmpDir, 'personas', name);
  await mkdir(personaDir, { recursive: true });
  const systemPromptFile = join(personaDir, 'system.md');
  await writeFile(systemPromptFile, `# ${name}\nYou are a test agent.`);

  if (personality) {
    const personalityDir = join(personaDir, 'personality');
    await mkdir(personalityDir, { recursive: true });
    for (const [file, content] of Object.entries(personality)) {
      await writeFile(join(personalityDir, file), content);
    }
  }

  return {
    name,
    model: 'claude-sonnet-4-6',
    systemPromptFile,
    skills: [],
    capabilities: { allow: [], requireApproval: [] },
  } as unknown as PersonaConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonaLoader — personality folder', () => {
  it('loads and concatenates personality files in alphabetical order', async () => {
    const config = await scaffoldPersona('alfred', {
      '01-tone.md': '## Tone\nBe formal and precise.',
      '02-background.md': '## Background\nYou are a British butler.',
    });

    const result = await loader.loadFromConfig([config]);
    expect(result.isOk()).toBe(true);

    const persona = result._unsafeUnwrap()[0]!;
    expect(persona.personalityContent).toContain('## Tone');
    expect(persona.personalityContent).toContain('## Background');

    // 01-tone should come before 02-background
    const toneIdx = persona.personalityContent!.indexOf('## Tone');
    const bgIdx = persona.personalityContent!.indexOf('## Background');
    expect(toneIdx).toBeLessThan(bgIdx);
  });

  it('returns undefined personalityContent when no personality folder exists', async () => {
    const config = await scaffoldPersona('basic');

    const result = await loader.loadFromConfig([config]);
    expect(result.isOk()).toBe(true);

    const persona = result._unsafeUnwrap()[0]!;
    expect(persona.personalityContent).toBeUndefined();
  });

  it('returns undefined personalityContent when personality folder is empty', async () => {
    const config = await scaffoldPersona('empty-personality', {});

    const result = await loader.loadFromConfig([config]);
    expect(result.isOk()).toBe(true);

    const persona = result._unsafeUnwrap()[0]!;
    expect(persona.personalityContent).toBeUndefined();
  });

  it('only reads .md files from personality folder', async () => {
    const config = await scaffoldPersona('filtered', {
      'tone.md': '## Tone\nCasual.',
      'notes.txt': 'This should be ignored.',
      'draft.bak': 'This too.',
    });

    const result = await loader.loadFromConfig([config]);
    expect(result.isOk()).toBe(true);

    const persona = result._unsafeUnwrap()[0]!;
    expect(persona.personalityContent).toContain('## Tone');
    expect(persona.personalityContent).not.toContain('ignored');
    expect(persona.personalityContent).not.toContain('This too');
  });

  it('returns undefined personalityContent when no systemPromptFile is set', async () => {
    const config = {
      name: 'no-prompt',
      model: 'claude-sonnet-4-6',
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
    } as unknown as PersonaConfig;

    const result = await loader.loadFromConfig([config]);
    expect(result.isOk()).toBe(true);

    const persona = result._unsafeUnwrap()[0]!;
    expect(persona.personalityContent).toBeUndefined();
  });
});
