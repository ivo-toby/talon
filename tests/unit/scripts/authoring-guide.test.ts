import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ScriptRepository } from '../../../src/core/database/repositories/script-repository.js';
import { createScriptStore } from '../../../src/scripts/index.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

function block(guide: string, info: string): string {
  const start = guide.indexOf('```' + info + '\n');
  expect(start).toBeGreaterThanOrEqual(0);
  const from = start + info.length + 4;
  return guide.slice(from, guide.indexOf('\n```', from) + 1);
}

describe('script authoring guide', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'script-guide-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is at most 7500 characters and its example saves', () => {
    const guide = read('templates/script-authoring.md');
    expect(guide.length).toBeLessThanOrEqual(7500);

    const db = createTestDb();
    const personaId = uuid();
    new PersonaRepository(db)
      .insert({
        id: personaId,
        name: `p-${personaId}`,
        model: 'm',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
    const store = createScriptStore({ root, repo: new ScriptRepository(db) });
    const saved = store.save({
      personaId,
      threadId: 't1',
      files: [
        { path: 'script.ts', content: block(guide, 'ts script.ts') },
        { path: 'manifest.json', content: block(guide, 'json manifest.json') },
        { path: 'tests.json', content: block(guide, 'json tests.json') },
      ],
    });
    expect(saved.isOk()).toBe(true);
  });

  it('keeps the tool instruction files at most 400 characters', () => {
    for (const name of ['script.manage.md', 'script.run.md']) {
      expect(read(`templates/tool-instructions/${name}`).length).toBeLessThanOrEqual(400);
    }
  });
});
