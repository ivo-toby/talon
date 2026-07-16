/**
 * Unit tests for SubAgentLoader.
 *
 * Creates temp directories on disk with manifest files and entry points,
 * then exercises the loader's discovery, validation, and import logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SubAgentLoader } from '../../../src/subagents/subagent-loader.js';

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
    expect(agents[0].promptContents).toEqual(['You are a helper.', 'Be concise.']);
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
      writeManifest(agentDir, VALID_MANIFEST.replace('test-agent', name));
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

  it('materializes immutable validated lifecycle authority from the loaded manifest', async () => {
    const agentDir = join(root, 'lifecycle-agent');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(
      agentDir,
      `${VALID_MANIFEST}\nlifecycleCapabilities:\n  - mode: event\n    inputContract: talon.lifecycle.event.envelope.v1\n    outputContract: talon.lifecycle.signal.envelopes.v1`,
    );
    writeEntryPoint(agentDir);

    const result = await new SubAgentLoader(makeLogger()).loadAll(root);

    expect(result.isOk()).toBe(true);
    const capabilities = result._unsafeUnwrap()[0].lifecycleCapabilities;
    expect(capabilities).toEqual([
      {
        mode: 'event',
        inputContract: 'talon.lifecycle.event.envelope.v1',
        outputContract: 'talon.lifecycle.signal.envelopes.v1',
      },
    ]);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities![0])).toBe(true);
  });

  it('publishes frozen detached executable authority, including ordinary empty lifecycle capability lists', async () => {
    const agentDir = join(root, 'frozen-agent');
    const promptsDir = join(agentDir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    writeEntryPoint(agentDir);
    writeFileSync(join(promptsDir, '01-system.md'), 'immutable prompt');

    const result = await new SubAgentLoader(makeLogger()).loadAll(root);

    expect(result.isOk()).toBe(true);
    const agent = result._unsafeUnwrap()[0]!;
    const replacement = async (): Promise<unknown> => ({ summary: 'replacement' });
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.manifest)).toBe(true);
    expect(Object.isFrozen(agent.manifest.model)).toBe(true);
    expect(Object.isFrozen(agent.manifest.requiredCapabilities)).toBe(true);
    expect(Object.isFrozen(agent.manifest.rootPaths)).toBe(true);
    expect(Object.isFrozen(agent.manifest.requiresEnv)).toBe(true);
    expect(Object.isFrozen(agent.promptContents)).toBe(true);
    expect(Object.isFrozen(agent.lifecycleCapabilities)).toBe(true);
    expect(Object.isFrozen(agent.manifest.lifecycleCapabilities)).toBe(true);
    expect(agent.lifecycleCapabilities).toEqual([]);
    expect(Reflect.set(agent, 'run', replacement)).toBe(false);
    expect(Reflect.set(agent.manifest.model, 'name', 'weakened')).toBe(false);
    expect(Reflect.set(agent.promptContents, '0', 'weakened')).toBe(false);
    expect(agent.run).not.toBe(replacement);
    expect(agent.manifest.model.name).toBe('claude-haiku-4-5-20251001');
    expect(agent.promptContents).toEqual(['immutable prompt']);
  });

  it('rejects a callable proxy export without executing its traps', async () => {
    const agentDir = join(root, 'proxy-export-agent');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(agentDir, VALID_MANIFEST);
    writeFileSync(
      join(agentDir, 'index.js'),
      `globalThis.__talonSubagentProxyTraps = 0;
exports.run = new Proxy(async () => ({ ok: true, value: { summary: 'nope' } }), {
  apply() { globalThis.__talonSubagentProxyTraps += 1; },
  get() { globalThis.__talonSubagentProxyTraps += 1; },
});`,
    );

    const result = await new SubAgentLoader(makeLogger()).loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
    expect((globalThis as Record<string, unknown>).__talonSubagentProxyTraps).toBe(0);
    delete (globalThis as Record<string, unknown>).__talonSubagentProxyTraps;
  });

  it('skips a sub-agent that declares unsupported lifecycle authority', async () => {
    const agentDir = join(root, 'bad-lifecycle-agent');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(
      agentDir,
      `${VALID_MANIFEST}\nlifecycleCapabilities:\n  - mode: interceptor\n    inputContract: talon.lifecycle.interceptor.input.v1\n    outputContract: talon.lifecycle.enforcing.interceptor.output.v1\n    interceptorSafety: enforcing`,
    );
    writeEntryPoint(agentDir);

    const result = await new SubAgentLoader(makeLogger()).loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('skips sub-agent when requiresEnv var is missing (info, not warn)', async () => {
    const agentDir = join(root, 'env-gated');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(
      agentDir,
      `name: env-gated
version: "0.1.0"
description: Needs an env var
model:
  provider: openai
  name: gpt-5.4-spark
requiresEnv:
  - TALON_TEST_NONEXISTENT_KEY_12345`,
    );
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
    expect(infos.some((args) => JSON.stringify(args).includes('missing required env vars'))).toBe(
      true,
    );
    expect(warnings).toEqual([]);
  });

  it('loads sub-agent when requiresEnv var is present', async () => {
    const envKey = 'TALON_TEST_SPARK_CODER_KEY_' + Date.now();
    process.env[envKey] = 'test-value';

    try {
      const agentDir = join(root, 'env-present');
      mkdirSync(agentDir, { recursive: true });
      writeManifest(
        agentDir,
        `name: env-present
version: "0.1.0"
description: Has env var
model:
  provider: openai
  name: gpt-5.4-spark
requiresEnv:
  - ${envKey}`,
      );
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
});
