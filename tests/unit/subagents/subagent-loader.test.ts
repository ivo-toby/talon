/**
 * Unit tests for SubAgentLoader.
 *
 * Creates temp directories on disk with manifest files and entry points,
 * then exercises the loader's discovery, validation, and import logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SubAgentLoader } from '../../../src/subagents/subagent-loader.js';
import {
  validateVisionModelChain,
  VISION_SUBAGENT_NAME,
} from '../../../src/subagents/subagent-model-chain.js';
import { isInferenceProvider } from '../../../src/subagents/model-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `subagent-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir: string, yamlContent: string): void {
  writeFileSync(join(dir, 'subagent.yaml'), yamlContent);
}

/**
 * Writes a minimal CJS entry point that exports a `run` function.
 * We use CJS because the temp directory has no package.json with
 * `"type": "module"`, so Node treats .js as CommonJS.
 */
function writeEntryPoint(dir: string): void {
  writeFileSync(
    join(dir, 'index.js'),
    `"use strict";
exports.run = async function run(ctx, input) {
  return { ok: true, value: { summary: 'test', data: {} } };
};`,
  );
}

/**
 * Writes a CJS entry point that uses `module.exports` (default export).
 */
function writeDefaultEntryPoint(dir: string): void {
  writeFileSync(
    join(dir, 'index.js'),
    `"use strict";
module.exports = async function run(ctx, input) {
  return { ok: true, value: { summary: 'test', data: {} } };
};`,
  );
}

const makeLogger = (): ReturnType<typeof Object.create> =>
  ({
    info: (): void => {},
    warn: (): void => {},
    error: (): void => {},
    debug: (): void => {},
    child: function () {
      return this;
    },
  }) as unknown as import('pino').Logger;

const VALID_MANIFEST = `name: test-agent
version: "0.1.0"
description: A test sub-agent
model:
  provider: anthropic
  name: claude-haiku-4-5-20251001`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentLoader', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty array when root directory does not exist', async () => {
    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll('/tmp/nonexistent-subagents-dir-' + randomUUID());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('returns empty array when root has no sub-agent directories', async () => {
    writeFileSync(join(root, 'random-file.txt'), 'nothing');

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('skips directories without subagent.yaml', async () => {
    mkdirSync(join(root, 'not-an-agent'), { recursive: true });
    writeFileSync(join(root, 'not-an-agent', 'readme.md'), 'nothing');

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('loads a valid sub-agent directory', async () => {
    const agentDir = join(root, 'test-agent');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    writeEntryPoint(agentDir);

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    const agents = result._unsafeUnwrap();
    expect(agents).toHaveLength(1);
    expect(agents[0].manifest.name).toBe('test-agent');
    expect(agents[0].manifest.version).toBe('0.1.0');
    expect(agents[0].manifest.model.provider).toBe('anthropic');
    expect(agents[0].manifest.model.maxTokens).toBe(2048); // default
    expect(typeof agents[0].run).toBe('function');
    expect(agents[0].rootDir).toBe(agentDir);
  });

  it('loads a sub-agent with default export', async () => {
    const agentDir = join(root, 'default-agent');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    writeDefaultEntryPoint(agentDir);

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    const agents = result._unsafeUnwrap();
    expect(agents).toHaveLength(1);
    expect(typeof agents[0].run).toBe('function');
  });

  it('loads prompt fragments from prompts/ directory', async () => {
    const agentDir = join(root, 'test-agent');
    const promptsDir = join(agentDir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    writeEntryPoint(agentDir);
    writeFileSync(join(promptsDir, '01-intro.md'), 'You are a helper.');
    writeFileSync(join(promptsDir, '02-rules.md'), 'Be concise.');

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    const agents = result._unsafeUnwrap();
    expect(agents[0].promptContents).toEqual([
      'You are a helper.',
      'Be concise.',
    ]);
  });

  it('sorts prompt fragments alphabetically', async () => {
    const agentDir = join(root, 'test-agent');
    const promptsDir = join(agentDir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    writeEntryPoint(agentDir);
    writeFileSync(join(promptsDir, 'z-last.md'), 'last');
    writeFileSync(join(promptsDir, 'a-first.md'), 'first');

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()[0].promptContents).toEqual(['first', 'last']);
  });

  it('returns empty promptContents when prompts/ does not exist', async () => {
    const agentDir = join(root, 'test-agent');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    writeEntryPoint(agentDir);

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()[0].promptContents).toEqual([]);
  });

  it('skips agents with invalid manifest (warning logged)', async () => {
    const agentDir = join(root, 'bad-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'subagent.yaml'), 'name: ""');

    const warnings: unknown[] = [];
    const logger = {
      ...makeLogger(),
      warn: (...args: unknown[]): void => {
        warnings.push(args);
      },
    };

    const loader = new SubAgentLoader(logger as unknown as import('pino').Logger);
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('skips agents with no entry point', async () => {
    const agentDir = join(root, 'no-entry');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    // No index.js or index.ts

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('loads multiple sub-agents from root', async () => {
    for (const name of ['agent-a', 'agent-b']) {
      const agentDir = join(root, name);
      mkdirSync(agentDir, { recursive: true });
      writeManifest(
        agentDir,
        VALID_MANIFEST.replace('test-agent', name),
      );
      writeEntryPoint(agentDir);
    }

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    const agents = result._unsafeUnwrap();
    expect(agents).toHaveLength(2);
    const names = agents.map((a) => a.manifest.name).sort();
    expect(names).toEqual(['agent-a', 'agent-b']);
  });

  it('applies manifest defaults (maxTokens, timeoutMs, etc.)', async () => {
    const agentDir = join(root, 'defaults-agent');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    writeEntryPoint(agentDir);

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    const manifest = result._unsafeUnwrap()[0].manifest;
    expect(manifest.model.maxTokens).toBe(2048);
    expect(manifest.timeoutMs).toBe(30000);
    expect(manifest.requiredCapabilities).toEqual([]);
    expect(manifest.rootPaths).toEqual([]);
  });

  it('skips sub-agent when requiresEnv var is missing (info, not warn)', async () => {
    const agentDir = join(root, 'env-gated');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(agentDir, `name: env-gated
version: "0.1.0"
description: Needs an env var
model:
  provider: openai
  name: gpt-5.4-spark
requiresEnv:
  - TALON_TEST_NONEXISTENT_KEY_12345`);
    writeEntryPoint(agentDir);

    const infos: unknown[] = [];
    const warnings: unknown[] = [];
    const logger = {
      ...makeLogger(),
      info: (...args: unknown[]): void => {
        infos.push(args);
      },
      warn: (...args: unknown[]): void => {
        warnings.push(args);
      },
    };

    const loader = new SubAgentLoader(logger as unknown as import('pino').Logger);
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
    // Should log at info level, not warn
    expect(infos.some((args) =>
      JSON.stringify(args).includes('missing required env vars'),
    )).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('loads sub-agent when requiresEnv var is present', async () => {
    const envKey = 'TALON_TEST_SPARK_CODER_KEY_' + Date.now();
    process.env[envKey] = 'test-value';

    try {
      const agentDir = join(root, 'env-present');
      mkdirSync(agentDir, { recursive: true });
      writeManifest(agentDir, `name: env-present
version: "0.1.0"
description: Has env var
model:
  provider: openai
  name: gpt-5.4-spark
requiresEnv:
  - ${envKey}`);
      writeEntryPoint(agentDir);

      const loader = new SubAgentLoader(makeLogger());
      const result = await loader.loadAll(root);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toHaveLength(1);
      expect(result._unsafeUnwrap()[0].manifest.name).toBe('env-present');
    } finally {
      delete process.env[envKey];
    }
  });

  // -------------------------------------------------------------------------
  // Built-in vision discovery (TASK-014)
  // -------------------------------------------------------------------------

  describe('built-in sub-agents', () => {
    /** The daemon's built-in directory (`src/subagents/default`). */
    const builtinDir = fileURLToPath(new URL('../../../src/subagents/default/', import.meta.url));

    it('finds the built-in vision sub-agent with a vision-capable chain', async () => {
      const loader = new SubAgentLoader(makeLogger());

      const result = await loader.loadAll(builtinDir);

      expect(result.isOk()).toBe(true);
      const agents = result._unsafeUnwrap();
      const vision = agents.find((agent) => agent.manifest.name === VISION_SUBAGENT_NAME);

      expect(vision).toBeDefined();
      // Entry point and prompts are present, so the runner can dispatch to it.
      expect(typeof vision!.run).toBe('function');
      expect(vision!.promptContents.join(' ')).not.toBe('');
      // The shipped manifest chain (no overrides) is accepted by the same
      // validator the daemon runs at startup.
      expect(validateVisionModelChain(vision!, undefined).isOk()).toBe(true);
      expect(isInferenceProvider(vision!.manifest.model.provider)).toBe(true);
    });

    it('grants the vision sub-agent no capabilities of its own', async () => {
      const loader = new SubAgentLoader(makeLogger());

      const agents = (await loader.loadAll(builtinDir))._unsafeUnwrap();
      const vision = agents.find((agent) => agent.manifest.name === VISION_SUBAGENT_NAME)!;

      // Reaching the Image/Finding services is wiring, not authorization:
      // persona `subagent.invoke` + explicit assignment stay the gates, so the
      // manifest itself must not carry capability labels (e.g. `image.read`).
      expect(vision.manifest.requiredCapabilities).toEqual([]);
    });

    it('loads a text-only custom vision manifest, leaving rejection to chain validation', async () => {
      // The loader stays provider-agnostic; a manifest-level text-only model
      // is only caught by validateVisionModelChain — which is why bootstrap
      // must run that check over the merged map before any channel work.
      const root = makeTempDir();
      try {
        const agentDir = join(root, VISION_SUBAGENT_NAME);
        mkdirSync(agentDir, { recursive: true });
        writeManifest(agentDir, `name: ${VISION_SUBAGENT_NAME}
version: "0.1.0"
description: Text-only custom vision replacement
model:
  provider: claude-code
  name: claude-opus-4-7`);
        writeEntryPoint(agentDir);

        const loader = new SubAgentLoader(makeLogger());
        const loaded = (await loader.loadAll(root))._unsafeUnwrap();
        expect(loaded).toHaveLength(1);

        const validation = validateVisionModelChain(loaded[0]!, undefined);
        expect(validation.isErr()).toBe(true);
        expect(validation._unsafeUnwrapErr().message).toContain(
          'claude-code/claude-opus-4-7 (manifest)',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
