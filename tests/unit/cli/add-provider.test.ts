import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { addProvider } from '../../../src/cli/commands/add-provider.js';
import { listProviders } from '../../../src/cli/commands/list-providers.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-add-provider-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmpDir, 'talond.yaml');
}

function writeYaml(content: string): string {
  const p = configPath();
  writeFileSync(p, content);
  return p;
}

function readYaml(p: string): Record<string, unknown> {
  return (yaml.load(readFileSync(p, 'utf-8')) ?? {}) as Record<string, unknown>;
}

describe('addProvider()', () => {
  it('writes nested contextManagement for agent-runner providers', async () => {
    const p = writeYaml('logLevel: info\nagentRunner:\n  providers: {}\n');

    await addProvider({
      name: 'claude-max',
      command: 'claude',
      context: 'agent-runner',
      contextWindowTokens: 1_000_000,
      enabled: false,
      defaultModel: 'claude-sonnet-4-6',
      contextEnabled: true,
      triggerMetric: 'cache_read_input_tokens',
      thresholdRatio: 0.5,
      recentMessageCount: 10,
      summarizer: 'session-summarizer',
      configPath: p,
    });

    const doc = readYaml(p);
    const agentRunner = doc.agentRunner as Record<string, unknown>;
    const providers = agentRunner.providers as Record<string, unknown>;
    const provider = providers['claude-max'] as Record<string, unknown>;
    const contextManagement = provider.contextManagement as Record<string, unknown>;

    expect(provider).toEqual({
      enabled: false,
      command: 'claude',
      contextWindowTokens: 1_000_000,
      options: {
        defaultModel: 'claude-sonnet-4-6',
      },
      contextManagement: {
        enabled: true,
        triggerMetric: 'cache_read_input_tokens',
        thresholdRatio: 0.5,
        recentMessageCount: 10,
        summarizer: 'session-summarizer',
      },
    });
    expect(contextManagement.enabled).toBe(true);
  });

  it('writes provider type aliases and OpenAI-compatible options', async () => {
    const p = writeYaml(
      'logLevel: info\nagentRunner:\n  providers: {}\nbackgroundAgent:\n  providers: {}\n',
    );

    await addProvider({
      name: 'ollama-mac',
      type: 'openai-compatible',
      command: 'node',
      context: 'both',
      contextWindowTokens: 128_000,
      enabled: true,
      contextEnabled: true,
      triggerMetric: 'input_tokens',
      thresholdRatio: 0.75,
      recentMessageCount: 8,
      summarizer: 'session-observer',
      defaultModel: 'qwen3-coder:30b',
      baseUrl: 'http://mac.local:11434/v1',
      providerId: 'ollama-mac',
      toolOutputCap: 2048,
      omlxResponses: true,
      configPath: p,
    });

    const doc = readYaml(p);
    const agentRunner = (
      (doc.agentRunner as Record<string, unknown>).providers as Record<string, unknown>
    )['ollama-mac'] as Record<string, unknown>;
    const backgroundAgent = (
      (doc.backgroundAgent as Record<string, unknown>).providers as Record<string, unknown>
    )['ollama-mac'] as Record<string, unknown>;

    expect(agentRunner).toEqual({
      enabled: true,
      type: 'openai-compatible',
      command: 'node',
      contextWindowTokens: 128_000,
      options: {
        defaultModel: 'qwen3-coder:30b',
        baseUrl: 'http://mac.local:11434/v1',
        providerId: 'ollama-mac',
        toolOutputCap: 2048,
        omlxResponses: true,
      },
      contextManagement: {
        enabled: true,
        triggerMetric: 'input_tokens',
        thresholdRatio: 0.75,
        recentMessageCount: 8,
        summarizer: 'session-observer',
      },
    });
    expect(backgroundAgent).toEqual({
      enabled: true,
      type: 'openai-compatible',
      command: 'node',
      contextWindowTokens: 128_000,
      options: {
        defaultModel: 'qwen3-coder:30b',
        baseUrl: 'http://mac.local:11434/v1',
        providerId: 'ollama-mac',
        toolOutputCap: 2048,
      },
    });
  });

  it('rejects oMLX Responses mode for background-only providers', async () => {
    const p = writeYaml('logLevel: info\nbackgroundAgent:\n  providers: {}\n');

    await expect(
      addProvider({
        name: 'omlx-background',
        type: 'openai-compatible',
        command: 'node',
        context: 'background',
        contextWindowTokens: 128_000,
        defaultModel: 'qwen3.5-9b-optiq-4bit',
        baseUrl: 'http://mac.local:8000/v1',
        providerId: 'omlx-local',
        omlxResponses: true,
        configPath: p,
      }),
    ).rejects.toThrow('--omlx-responses is only supported for agent-runner providers.');
  });

  it('writes contextManagement only to the agent-runner entry when using both contexts', async () => {
    const p = writeYaml('logLevel: info\n');

    await addProvider({
      name: 'claude-shared',
      command: 'claude',
      context: 'both',
      contextWindowTokens: 1_000_000,
      enabled: true,
      contextEnabled: true,
      triggerMetric: 'cache_read_input_tokens',
      thresholdRatio: 0.5,
      recentMessageCount: 12,
      summarizer: 'session-summarizer',
      configPath: p,
    });

    const doc = readYaml(p);
    const agentRunner = (
      (doc.agentRunner as Record<string, unknown>).providers as Record<string, unknown>
    )['claude-shared'] as Record<string, unknown>;
    const backgroundAgent = (
      (doc.backgroundAgent as Record<string, unknown>).providers as Record<string, unknown>
    )['claude-shared'] as Record<string, unknown>;

    expect(agentRunner.contextManagement).toEqual({
      enabled: true,
      triggerMetric: 'cache_read_input_tokens',
      thresholdRatio: 0.5,
      recentMessageCount: 12,
      summarizer: 'session-summarizer',
    });
    expect(backgroundAgent.contextManagement).toBeUndefined();
  });

  it('defaults Gemini-style providers to the input_tokens trigger metric', async () => {
    const p = writeYaml('logLevel: info\nagentRunner:\n  providers: {}\n');

    await addProvider({
      name: 'gemini-cli',
      command: '/usr/local/bin/gemini',
      context: 'agent-runner',
      contextEnabled: true,
      configPath: p,
    });

    const doc = readYaml(p);
    const agentRunner = doc.agentRunner as Record<string, unknown>;
    const providers = agentRunner.providers as Record<string, unknown>;
    const provider = providers['gemini-cli'] as Record<string, unknown>;

    expect(provider.contextManagement).toEqual({
      enabled: true,
      triggerMetric: 'input_tokens',
      thresholdRatio: 0.5,
      recentMessageCount: 10,
      summarizer: 'session-summarizer',
    });
  });

  it('accepts cache_total_input_tokens for Claude providers', async () => {
    const p = writeYaml('logLevel: info\nagentRunner:\n  providers: {}\n');

    await addProvider({
      name: 'claude-max',
      command: 'claude',
      context: 'agent-runner',
      contextEnabled: true,
      triggerMetric: 'cache_total_input_tokens',
      configPath: p,
    });

    const doc = readYaml(p);
    const agentRunner = doc.agentRunner as Record<string, unknown>;
    const providers = agentRunner.providers as Record<string, unknown>;
    const provider = providers['claude-max'] as Record<string, unknown>;

    expect(provider.contextManagement).toEqual({
      enabled: true,
      triggerMetric: 'cache_total_input_tokens',
      thresholdRatio: 0.5,
      recentMessageCount: 10,
      summarizer: 'session-summarizer',
    });
  });

  it('rejects an invalid threshold ratio', async () => {
    const p = writeYaml('logLevel: info\n');

    await expect(
      addProvider({
        name: 'claude-max',
        command: 'claude',
        context: 'agent-runner',
        contextEnabled: true,
        triggerMetric: 'cache_read_input_tokens',
        thresholdRatio: 1.2,
        recentMessageCount: 10,
        summarizer: 'session-summarizer',
        configPath: p,
      }),
    ).rejects.toThrow(/thresholdRatio/);
  });

  it('rejects an unsupported trigger metric', async () => {
    const p = writeYaml('logLevel: info\n');

    await expect(
      addProvider({
        name: 'claude-max',
        command: 'claude',
        context: 'agent-runner',
        contextEnabled: true,
        triggerMetric: 'output_tokens' as 'input_tokens',
        thresholdRatio: 0.5,
        recentMessageCount: 10,
        summarizer: 'session-summarizer',
        configPath: p,
      }),
    ).rejects.toThrow(/triggerMetric/);
  });

  it('rejects a negative recent message count', async () => {
    const p = writeYaml('logLevel: info\n');

    await expect(
      addProvider({
        name: 'claude-max',
        command: 'claude',
        context: 'agent-runner',
        contextEnabled: true,
        triggerMetric: 'cache_read_input_tokens',
        thresholdRatio: 0.5,
        recentMessageCount: -1,
        summarizer: 'session-summarizer',
        configPath: p,
      }),
    ).rejects.toThrow(/recentMessageCount/);
  });

  it('rejects an empty summarizer when context management is enabled', async () => {
    const p = writeYaml('logLevel: info\n');

    await expect(
      addProvider({
        name: 'claude-max',
        command: 'claude',
        context: 'agent-runner',
        contextEnabled: true,
        triggerMetric: 'cache_read_input_tokens',
        thresholdRatio: 0.5,
        recentMessageCount: 10,
        summarizer: '   ',
        configPath: p,
      }),
    ).rejects.toThrow(/summarizer/);
  });

  it('rejects background providers with context management enabled', async () => {
    const p = writeYaml('logLevel: info\n');

    await expect(
      addProvider({
        name: 'claude-background',
        command: 'claude',
        context: 'background',
        contextEnabled: true,
        configPath: p,
      }),
    ).rejects.toThrow(/background.*context management/i);
  });
});

describe('listProviders()', () => {
  it('returns agent-runner context management details for display', async () => {
    const p = writeYaml(`
agentRunner:
  defaultProvider: claude-max
  providers:
    claude-max:
      enabled: true
      command: claude
      contextWindowTokens: 1000000
      contextManagement:
        enabled: true
        triggerMetric: cache_read_input_tokens
        thresholdRatio: 0.5
        recentMessageCount: 10
        summarizer: session-summarizer
backgroundAgent:
  providers:
    claude-max:
      enabled: true
      command: claude
      contextWindowTokens: 1000000
`);

    const providers = await listProviders({ configPath: p });

    expect(providers).toEqual([
      {
        context: 'agent-runner',
        name: 'claude-max',
        type: 'claude-max',
        enabled: true,
        command: 'claude',
        contextWindowTokens: 1_000_000,
        isDefault: true,
        contextManagementEnabled: true,
        triggerMetric: 'cache_read_input_tokens',
        thresholdRatio: 0.5,
      },
      {
        context: 'background',
        name: 'claude-max',
        type: 'claude-max',
        enabled: true,
        command: 'claude',
        contextWindowTokens: 1_000_000,
        isDefault: false,
        contextManagementEnabled: false,
      },
    ]);
  });
});
