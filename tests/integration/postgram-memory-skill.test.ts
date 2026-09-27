import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import pino from 'pino';

import { SkillLoader } from '../../src/skills/skill-loader.js';
import { SkillResolver } from '../../src/skills/skill-resolver.js';
import { buildPersonaRuntimeContext } from '../../src/personas/persona-runtime-context.js';
import type { LoadedPersona } from '../../src/personas/persona-types.js';

const skillDir = resolve(import.meta.dirname, '../../starter-stack/skills/postgram-memory');

const persona = {
  config: { name: 'assistant', model: 'test-model', skills: ['postgram-memory'] },
  systemPromptContent: 'You are a helpful assistant.',
  personalityContent: '',
  resolvedCapabilities: { allow: [], requireApproval: [] },
} as LoadedPersona;

describe('bundled Postgram memory skill', () => {
  it('puts the search-to-recall contract in the eager persona prompt', async () => {
    const logger = pino({ level: 'silent' });
    const loader = new SkillLoader(logger);
    const loaded = await loader.loadFromDirectory(skillDir);
    expect(loaded.isOk()).toBe(true);

    const skill = loaded._unsafeUnwrap();
    expect(skill.manifest.eager).toBe(true);

    const context = buildPersonaRuntimeContext({
      loadedPersona: persona,
      resolvedSkills: [skill],
      skillResolver: new SkillResolver(logger),
    });
    const prompt = context.personaPrompt.replace(/\s+/g, ' ');

    expect(prompt).toMatch(/search results? .*matched chunks?/i);
    expect(prompt).toMatch(
      /before answering[^.]*status[^.]*call `postgram_recall`[^.]*read the full entity/i,
    );
    expect(prompt).toMatch(/(?:conflict|disagree)[^.]*recall the relevant candidates/i);
    expect(prompt).toMatch(/later conclusion[^.]*supersedes an earlier provisional statement/i);
    expect(prompt).toMatch(/if recall fails[^.]*cannot be confirmed/i);
  });
});
