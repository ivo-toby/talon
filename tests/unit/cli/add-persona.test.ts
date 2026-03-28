/**
 * Unit tests for the `talonctl add-persona` command.
 *
 * Tests both the pure `addPersona()` function (importable by setup skill /
 * terminal agent) and the `addPersonaCommand()` CLI wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';

import {
  addPersona,
  addPersonaCommand,
  buildSystemPromptTemplate,
} from '../../../src/cli/commands/add-persona.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-add-persona-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmpDir, 'talond.yaml');
}

function writeMinimalConfig(): string {
  const p = configPath();
  writeFileSync(p, 'logLevel: info\npersonas: []\n');
  return p;
}

function writeYaml(content: string): string {
  const p = configPath();
  writeFileSync(p, content);
  return p;
}

function readYaml(p: string): Record<string, unknown> {
  return (yaml.load(readFileSync(p, 'utf-8')) ?? {}) as Record<string, unknown>;
}

async function runCliWithArgs(args: string[]): Promise<ReturnType<typeof vi.fn>> {
  vi.resetModules();

  const addPersonaCommandMock = vi.fn(async () => undefined);
  const originalArgv = process.argv;

  vi.doMock('../../../src/cli/commands/add-persona.js', () => ({
    addPersonaCommand: addPersonaCommandMock,
  }));

  process.argv = ['node', 'talonctl', ...args];

  try {
    await import('../../../src/cli/index.ts');
  } finally {
    process.argv = originalArgv;
    vi.doUnmock('../../../src/cli/commands/add-persona.js');
  }

  return addPersonaCommandMock;
}

// ---------------------------------------------------------------------------
// addPersona() — pure function
// ---------------------------------------------------------------------------

describe('addPersona()', () => {
  it('creates the persona directory', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'assistant', configPath: p, personasDir });

    expect(existsSync(join(personasDir, 'assistant'))).toBe(true);
  });

  it('creates system.md in the persona directory', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'helper', configPath: p, personasDir });

    const systemPromptPath = join(personasDir, 'helper', 'system.md');
    expect(existsSync(systemPromptPath)).toBe(true);
    const content = readFileSync(systemPromptPath, 'utf-8');
    expect(content).toContain('helper');
  });

  it('adds persona entry to talond.yaml', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    const result = await addPersona({ name: 'assistant', configPath: p, personasDir });

    expect(result.name).toBe('assistant');
    expect(result.model).toBeDefined();
    expect(result.systemPromptFile).toBeDefined();
    expect(result.skills).toEqual([]);

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(1);
    expect(personas[0]!.name).toBe('assistant');
  });

  it('uses the provided model in the YAML entry', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    const result = await addPersona({
      name: 'assistant',
      model: 'claude-opus-4-6',
      configPath: p,
      personasDir,
    });

    expect(result.model).toBe('claude-opus-4-6');

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas[0]!.model).toBe('claude-opus-4-6');
  });

  it('stores the provided provider in the YAML entry', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    const result = await addPersona({
      name: 'assistant',
      provider: 'claude-code',
      configPath: p,
      personasDir,
    });

    expect(result.provider).toBe('claude-code');

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas[0]!.provider).toBe('claude-code');
  });

  it('stores provided capabilities in capabilities.allow', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({
      name: 'assistant',
      capabilities: ['fs.read:*', 'memory.access:*'],
      configPath: p,
      personasDir,
    });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    const capabilities = personas[0]!.capabilities as Record<string, unknown>;
    expect(capabilities.allow).toEqual(['fs.read:*', 'memory.access:*']);
    expect(capabilities.requireApproval).toEqual([]);
  });

  it('stores provided approval-gated capabilities in capabilities.requireApproval', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({
      name: 'assistant',
      requireApproval: ['channel.send:*', 'fs.write:workspace'],
      configPath: p,
      personasDir,
    });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    const capabilities = personas[0]!.capabilities as Record<string, unknown>;
    expect(capabilities.allow).toEqual([
      'memory.access:thread',
      'net.http:egress',
      'schedule.manage:own',
    ]);
    expect(capabilities.requireApproval).toEqual(['channel.send:*', 'fs.write:workspace']);
  });

  it('stores the provided skills array', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    const result = await addPersona({
      name: 'assistant',
      skills: ['code-review', 'memory-grooming'],
      configPath: p,
      personasDir,
    });

    expect(result.skills).toEqual(['code-review', 'memory-grooming']);

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas[0]!.skills).toEqual(['code-review', 'memory-grooming']);
  });

  it('copies system prompt content from the provided file', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');
    const systemPromptSource = join(tmpDir, 'custom-system.md');
    writeFileSync(systemPromptSource, '# Custom prompt\n\nAct like a reviewer.\n');

    await addPersona({
      name: 'assistant',
      systemPromptFile: systemPromptSource,
      configPath: p,
      personasDir,
    });

    const content = readFileSync(join(personasDir, 'assistant', 'system.md'), 'utf-8');
    expect(content).toBe('# Custom prompt\n\nAct like a reviewer.\n');
  });

  it('appends to an existing personas list', async () => {
    const p = writeYaml('personas:\n  - name: existing\n    model: claude-sonnet-4-6\n');
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'new-agent', configPath: p, personasDir });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(2);
    expect(personas[1]!.name).toBe('new-agent');
  });

  it('does not overwrite existing system.md', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    // Pre-create persona dir and custom system.md
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(personasDir, 'assistant'), { recursive: true });
    const systemPromptPath = join(personasDir, 'assistant', 'system.md');
    writeFileSync(systemPromptPath, '# Custom content\n');

    await addPersona({ name: 'assistant', configPath: p, personasDir });

    const content = readFileSync(systemPromptPath, 'utf-8');
    expect(content).toBe('# Custom content\n');
  });

  it('creates a personality directory with example file', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'alfred', configPath: p, personasDir });

    const personalityDir = join(personasDir, 'alfred', 'personality');
    const example = readFileSync(join(personalityDir, '01-tone.md'), 'utf-8');
    expect(example).toContain('Tone');
  });

  it('creates an empty prompts directory for new personas', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'briefing-bot', configPath: p, personasDir });

    expect(existsSync(join(personasDir, 'briefing-bot', 'prompts'))).toBe(true);
  });

  it('mentions prompts/ in the generated system prompt template', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'planner', configPath: p, personasDir });

    const content = readFileSync(join(personasDir, 'planner', 'system.md'), 'utf-8');
    expect(content).toContain('prompts/');
    expect(content).toContain('promptFile');
  });

  it('does not scaffold personality for existing persona directories', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    // Pre-create persona dir with system.md (simulates existing persona)
    const { mkdirSync } = await import('node:fs');
    const personaDir = join(personasDir, 'custom-agent');
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(join(personaDir, 'system.md'), '# Existing prompt\n');

    await addPersona({ name: 'custom-agent', configPath: p, personasDir });

    // Personality folder should NOT have been created for existing persona
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(personaDir, 'personality'))).toBe(false);
    expect(existsSync(join(personaDir, 'prompts'))).toBe(false);
  });

  it('creates personas array if missing from config', async () => {
    const p = writeYaml('logLevel: info\n');
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'assistant', configPath: p, personasDir });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(1);
  });

  it('keeps default output unchanged when called with only name', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');
    const defaultTemplatePath = join('templates', 'assistant', 'system.md');
    const expectedSystemPrompt = existsSync(defaultTemplatePath)
      ? readFileSync(defaultTemplatePath, 'utf-8')
      : buildSystemPromptTemplate('assistant');

    const result = await addPersona({ name: 'assistant', configPath: p, personasDir });

    expect(result).toEqual({
      name: 'assistant',
      model: 'claude-sonnet-4-6',
      systemPromptFile: join(personasDir, 'assistant', 'system.md'),
      skills: [],
      capabilities: {
        allow: [
          'memory.access:thread',
          'net.http:egress',
          'schedule.manage:own',
        ],
        requireApproval: [],
      },
    });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas[0]).toEqual({
      name: 'assistant',
      model: 'claude-sonnet-4-6',
      systemPromptFile: join(personasDir, 'assistant', 'system.md'),
      skills: [],
      capabilities: {
        allow: [
          'memory.access:thread',
          'net.http:egress',
          'schedule.manage:own',
        ],
        requireApproval: [],
      },
    });
    expect(readFileSync(join(personasDir, 'assistant', 'system.md'), 'utf-8'))
      .toBe(expectedSystemPrompt);
  });

  it('treats all new options as optional and uses sensible defaults', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'assistant', configPath: p, personasDir });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas[0]).not.toHaveProperty('provider');

    const entry = personas[0] as Record<string, unknown>;
    expect(entry.model).toBe('claude-sonnet-4-6');
    expect(entry.skills).toEqual([]);

    const capabilities = entry.capabilities as Record<string, unknown>;
    expect(capabilities.allow).toEqual([
      'memory.access:thread',
      'net.http:egress',
      'schedule.manage:own',
    ]);
    expect(capabilities.requireApproval).toEqual([]);
  });

  it('returns sensible default capabilities', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    const result = await addPersona({ name: 'agent', configPath: p, personasDir });

    expect(result.capabilities.allow).toContain('memory.access:thread');
    expect(result.capabilities.allow).toContain('net.http:egress');
    expect(result.capabilities.allow).toContain('schedule.manage:own');
    expect(result.capabilities.allow).toHaveLength(3);
    expect(result.capabilities.requireApproval).toEqual([]);
  });

  it('writes default capabilities to config file', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'agent', configPath: p, personasDir });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    const caps = personas[0]!.capabilities as { allow: string[]; requireApproval: string[] };
    expect(caps.allow).toContain('memory.access:thread');
    expect(caps.allow).toHaveLength(3);
  });

  // --- Validation ---

  it('rejects a duplicate persona name', async () => {
    const p = writeYaml('personas:\n  - name: assistant\n    model: claude-sonnet-4-6\n');
    const personasDir = join(tmpDir, 'personas');

    await expect(addPersona({ name: 'assistant', configPath: p, personasDir }))
      .rejects.toThrow(/already exists/);
  });

  it('rejects an invalid persona name', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await expect(addPersona({ name: 'bad name', configPath: p, personasDir }))
      .rejects.toThrow(/invalid/);
  });

  it('rejects an empty persona name', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await expect(addPersona({ name: '', configPath: p, personasDir }))
      .rejects.toThrow(/must not be empty/);
  });

  it('throws for non-existent config file', async () => {
    await expect(addPersona({ name: 'bot', configPath: join(tmpDir, 'nope.yaml'), personasDir: join(tmpDir, 'personas') }))
      .rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// buildSystemPromptTemplate() — template generation
// ---------------------------------------------------------------------------

describe('buildSystemPromptTemplate()', () => {
  it('includes description in YAML frontmatter', () => {
    const result = buildSystemPromptTemplate('researcher', 'Deep web research agent');
    expect(result).toContain('---');
    expect(result).toContain('description: "Deep web research agent"');
  });

  it('omits description key when none provided', () => {
    const result = buildSystemPromptTemplate('assistant');
    expect(result).not.toContain('description:');
    expect(result).toContain('---');
  });

  it('escapes double quotes in description', () => {
    const result = buildSystemPromptTemplate('test', 'Says "hello" often');
    expect(result).toContain('description: "Says \\"hello\\" often"');
  });

  it('escapes newlines in description', () => {
    const result = buildSystemPromptTemplate('test', 'Line one\nLine two');
    expect(result).toContain('description: "Line one\\nLine two"');
  });

  it('escapes backslashes in description', () => {
    const result = buildSystemPromptTemplate('test', 'path\\to\\file');
    expect(result).toContain('description: "path\\\\to\\\\file"');
  });

  it('includes Background Agents section', () => {
    const result = buildSystemPromptTemplate('assistant');
    expect(result).toContain('## Background Agents');
    expect(result).toContain('background_agent action="profiles"');
  });
});

// ---------------------------------------------------------------------------
// addPersonaCommand() — CLI wrapper
// ---------------------------------------------------------------------------

describe('addPersonaCommand()', () => {
  it('prints confirmation on success', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await addPersonaCommand({ name: 'assistant', configPath: p, personasDir });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('assistant');
    expect(output).toContain('prompts');
    consoleSpy.mockRestore();
  });

  it('exits with code 1 on error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await addPersonaCommand({ name: 'bot', configPath: join(tmpDir, 'nonexistent.yaml'), personasDir: join(tmpDir, 'personas') });

    expect(exitSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints error message for invalid name', async () => {
    const p = writeMinimalConfig();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await addPersonaCommand({ name: 'bad name', configPath: p, personasDir: join(tmpDir, 'personas') });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(errOutput).toContain('invalid');
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('add-persona CLI registration', () => {
  it('passes new Commander.js flags through to addPersonaCommand()', async () => {
    const addPersonaCommandMock = await runCliWithArgs([
      'add-persona',
      '--name', 'assistant',
      '--config', 'custom.yaml',
      '--templates-dir', 'custom-templates',
      '--model', 'claude-opus-4-6',
      '--provider', 'claude-code',
      '--capabilities', 'fs.read:*,memory.access:*',
      '--require-approval', 'channel.send:*,fs.write:workspace',
      '--skills', 'code-review,memory-grooming',
      '--system-prompt-file', '/tmp/system.md',
    ]);

    expect(addPersonaCommandMock).toHaveBeenCalledWith({
      name: 'assistant',
      configPath: 'custom.yaml',
      templatesDir: 'custom-templates',
      model: 'claude-opus-4-6',
      provider: 'claude-code',
      capabilities: ['fs.read:*', 'memory.access:*'],
      requireApproval: ['channel.send:*', 'fs.write:workspace'],
      skills: ['code-review', 'memory-grooming'],
      systemPromptFile: '/tmp/system.md',
    });
  });

  it('passes --description through to addPersonaCommand', async () => {
    const addPersonaCommandMock = await runCliWithArgs([
      'add-persona',
      '--name', 'researcher',
      '--description', 'Deep web research agent',
    ]);

    expect(addPersonaCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'researcher',
        description: 'Deep web research agent',
      }),
    );
  });

  it('leaves new Commander.js flags optional', async () => {
    const addPersonaCommandMock = await runCliWithArgs([
      'add-persona',
      '--name', 'assistant',
    ]);

    expect(addPersonaCommandMock).toHaveBeenCalledWith({
      name: 'assistant',
      configPath: 'talond.yaml',
      templatesDir: 'templates',
    });
  });
});
