/**
 * Unit tests for the `talonctl init-persona` command.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initPersona } from '../../../src/cli/commands/init-persona.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-init-persona-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function templatesDir(): string {
  return join(tmpDir, 'templates');
}

function personasDir(): string {
  return join(tmpDir, 'personas');
}

function createTemplate(name: string, content: string): void {
  const dir = join(templatesDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'system.md'), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// initPersona() tests
// ---------------------------------------------------------------------------

describe('initPersona()', () => {
  it('copies template to personas/ when template exists and target does not', async () => {
    const templateContent = '# Custom Template\n\nHello from template.\n';
    createTemplate('assistant', templateContent);

    const result = await initPersona({
      name: 'assistant',
      templatesDir: templatesDir(),
      personasDir: personasDir(),
    });

    expect(result.created).toBe(true);
    expect(result.usedTemplate).toBe(join(templatesDir(), 'assistant', 'system.md'));
    expect(existsSync(result.systemPromptFile)).toBe(true);

    const written = readFileSync(result.systemPromptFile, 'utf-8');
    expect(written).toBe(templateContent);
  });

  it('falls back to generic template when no named template exists', async () => {
    // No template created — templates dir doesn't even exist.
    const result = await initPersona({
      name: 'my-agent',
      templatesDir: templatesDir(),
      personasDir: personasDir(),
    });

    expect(result.created).toBe(true);
    expect(result.usedTemplate).toBeNull();
    expect(existsSync(result.systemPromptFile)).toBe(true);

    const written = readFileSync(result.systemPromptFile, 'utf-8');
    expect(written).toContain('my-agent');
    expect(written).toContain('System Prompt');
  });

  it('does NOT overwrite when target file already exists', async () => {
    const existingContent = '# Existing prompt — do not touch\n';
    const personaDir = join(personasDir(), 'assistant');
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(join(personaDir, 'system.md'), existingContent, 'utf-8');

    // Also create a template to prove it's not used.
    createTemplate('assistant', '# Should not be copied\n');

    const result = await initPersona({
      name: 'assistant',
      templatesDir: templatesDir(),
      personasDir: personasDir(),
    });

    expect(result.created).toBe(false);
    expect(result.usedTemplate).toBeNull();

    const content = readFileSync(join(personaDir, 'system.md'), 'utf-8');
    expect(content).toBe(existingContent);
  });

  it('rejects names with path traversal characters', async () => {
    await expect(
      initPersona({
        name: '../evil',
        templatesDir: templatesDir(),
        personasDir: personasDir(),
      }),
    ).rejects.toThrow(/invalid/i);
  });

  it('rejects empty names', async () => {
    await expect(
      initPersona({
        name: '',
        templatesDir: templatesDir(),
        personasDir: personasDir(),
      }),
    ).rejects.toThrow(/empty/i);
  });

  it('creates personas/<name>/ directory if it does not exist', async () => {
    const result = await initPersona({
      name: 'brand-new',
      templatesDir: templatesDir(),
      personasDir: personasDir(),
    });

    expect(result.created).toBe(true);
    expect(existsSync(join(personasDir(), 'brand-new'))).toBe(true);
    expect(existsSync(result.systemPromptFile)).toBe(true);
  });
});
