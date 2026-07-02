import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testProvider } from '../../../src/cli/commands/test-provider.js';

let testDir: string;
let operatorHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'talon-test-provider-cli-'));
  operatorHome = mkdtempSync(join(tmpdir(), 'talon-test-provider-operator-'));
  mkdirSync(join(operatorHome, '.codex'), { recursive: true });
  writeFileSync(join(operatorHome, '.codex', 'auth.json'), '{"access_token":"operator-token"}', 'utf8');
  originalHome = process.env.HOME;
  process.env.HOME = operatorHome;
});

afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_MODE;
  delete process.env.OLLAMA_MAC_BASE_URL;
  delete process.env.OLLAMA_MAC_API_KEY;
  vi.unstubAllGlobals();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  rmSync(testDir, { recursive: true, force: true });
  rmSync(operatorHome, { recursive: true, force: true });
});

function writeConfig(providerName: string, command: string, defaultModel?: string): string {
  const optionsLines = defaultModel
    ? ['      options:', `        defaultModel: ${JSON.stringify(defaultModel)}`]
    : [];
  const configPath = join(testDir, 'talond.yaml');
  writeFileSync(
    configPath,
    [
      'logLevel: info',
      'agentRunner:',
      '  providers:',
      `    ${providerName}:`,
      '      enabled: true',
      `      command: ${JSON.stringify(command)}`,
      ...optionsLines,
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

function writeOpenAiCompatibleConfig(command: string): string {
  const configPath = join(testDir, 'talond.yaml');
  writeFileSync(
    configPath,
    [
      'logLevel: info',
      'auth:',
      '  providers:',
      '    ollama-mac:',
      '      baseURL: ${OLLAMA_MAC_BASE_URL}',
      '      apiKey: ${OLLAMA_MAC_API_KEY}',
      'agentRunner:',
      '  providers:',
      '    ollama-mac:',
      '      enabled: true',
      '      type: openai-compatible',
      `      command: ${JSON.stringify(command)}`,
      '      options:',
      '        defaultModel: qwen3-coder:30b',
      '        providerId: ollama-mac',
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}

function writeFakeExecutable(binaryName: string): string {
  const scriptPath = join(testDir, binaryName);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'full';

if (args.length === 1 && args[0] === '--version') {
  console.log('codex 0.117.0');
  process.exit(0);
}

if (args[0] !== 'exec') {
  console.error('expected exec');
  process.exit(20);
}

for (const flag of ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', '-o']) {
  if (!args.includes(flag)) {
    console.error('missing flag: ' + flag);
    process.exit(21);
  }
}

const cIndex = args.indexOf('-C');
const oIndex = args.indexOf('-o');
if (cIndex === -1 || oIndex === -1) {
  console.error('missing required options');
  process.exit(22);
}

const codexHome = args[cIndex + 1];
const outputPath = args[oIndex + 1];
if (!codexHome || !outputPath) {
  console.error('missing option values');
  process.exit(23);
}

if (process.env.HOME !== codexHome) {
  console.error('HOME does not match -C directory');
  process.exit(24);
}

const codexDir = path.join(codexHome, '.codex');
const authPath = path.join(codexDir, 'auth.json');
const configPath = path.join(codexDir, 'config.toml');

if (!fs.existsSync(codexDir) || !fs.existsSync(authPath) || !fs.existsSync(configPath)) {
  console.error('codex home not seeded');
  process.exit(25);
}

if (fs.readFileSync(authPath, 'utf8') !== '{"access_token":"operator-token"}') {
  console.error('auth copy mismatch');
  process.exit(26);
}

if (!fs.readFileSync(configPath, 'utf8').trim()) {
  console.error('config.toml is empty');
  process.exit(27);
}

if (args[args.length - 1] !== 'Say hello in one word') {
  console.error('prompt mismatch');
  process.exit(28);
}

fs.writeFileSync(outputPath, 'hello', 'utf8');
if (process.env.FAKE_CODEX_LOG) {
  fs.writeFileSync(
    process.env.FAKE_CODEX_LOG,
    JSON.stringify({ args, codexHome, outputPath, envHome: process.env.HOME }),
    'utf8',
  );
}

if (mode === 'missing-thread-started') {
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 17, output_tokens: 3 } }));
  process.exit(0);
}

if (mode === 'turn-completed-no-usage') {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-codex-123' }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
  process.exit(0);
}

console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-codex-123' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 17, output_tokens: 3 } }));
process.exit(0);
`;
  writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('testProvider() Codex smoke branch', () => {
  it('recognizes Codex by provider name and runs Codex smoke flow', async () => {
    const fakeCli = writeFakeExecutable('provider-cli');
    const configPath = writeConfig('codex-smoke', fakeCli);
    const logPath = join(testDir, 'invoke-by-name.json');
    process.env.FAKE_CODEX_LOG = logPath;

    const result = await testProvider({
      name: 'codex-smoke',
      configPath,
    });

    expect(result.binaryFound).toBe(true);
    expect(result.version).toBe('0.117.0');
    expect(result.response).toBe('hello');
    expect(result.jsonValid).toBe(true);
    expect(result.inputTokens).toBe(17);
    expect(result.outputTokens).toBe(3);
    expect(result.error).toBeNull();

    const invocation = JSON.parse(readFileSync(logPath, 'utf8')) as {
      args: string[];
      codexHome: string;
      outputPath: string;
      envHome: string;
    };

    expect(invocation.args[0]).toBe('exec');
    expect(invocation.args).toContain('--json');
    expect(invocation.args).toContain('--skip-git-repo-check');
    expect(invocation.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(invocation.args).toContain('-C');
    expect(invocation.args).toContain('-o');
    expect(invocation.args[invocation.args.length - 1]).toBe('Say hello in one word');
    expect(invocation.codexHome).not.toBe(operatorHome);
    expect(invocation.envHome).toBe(invocation.codexHome);
  });

  it('recognizes Codex by command when provider name is generic', async () => {
    const fakeCli = writeFakeExecutable('codex-fake');
    const configPath = writeConfig('primary-cli', fakeCli);
    const logPath = join(testDir, 'invoke-by-command.json');
    process.env.FAKE_CODEX_LOG = logPath;

    const result = await testProvider({
      name: 'primary-cli',
      configPath,
    });

    expect(result.binaryFound).toBe(true);
    expect(result.version).toBe('0.117.0');
    expect(result.response).toBe('hello');
    expect(result.jsonValid).toBe(true);
    expect(result.inputTokens).toBe(17);
    expect(result.outputTokens).toBe(3);
    expect(result.error).toBeNull();

    const invocation = JSON.parse(readFileSync(logPath, 'utf8')) as { args: string[] };
    expect(invocation.args[0]).toBe('exec');
  });

  it('recognizes Codex by full command path when basename and provider name are generic', async () => {
    const fakeCli = writeFakeExecutable('custom-codex-bin/provider-cli');
    const configPath = writeConfig('primary-cli', fakeCli);
    const logPath = join(testDir, 'invoke-by-command-path.json');
    process.env.FAKE_CODEX_LOG = logPath;

    const result = await testProvider({
      name: 'primary-cli',
      configPath,
    });

    expect(result.binaryFound).toBe(true);
    expect(result.response).toBe('hello');
    expect(result.jsonValid).toBe(true);
    expect(result.error).toBeNull();

    const invocation = JSON.parse(readFileSync(logPath, 'utf8')) as { args: string[] };
    expect(invocation.args[0]).toBe('exec');
  });

  it('marks JSONL invalid when thread.started is missing', async () => {
    const fakeCli = writeFakeExecutable('codex-missing-thread');
    const configPath = writeConfig('codex-smoke', fakeCli);
    process.env.FAKE_CODEX_MODE = 'missing-thread-started';

    const result = await testProvider({
      name: 'codex-smoke',
      configPath,
    });

    expect(result.binaryFound).toBe(true);
    expect(result.response).toBe('hello');
    expect(result.jsonValid).toBe(false);
    expect(result.error).toContain('thread.started');
  });

  it('accepts turn.completed without usage and leaves tokens null', async () => {
    const fakeCli = writeFakeExecutable('codex-no-usage');
    const configPath = writeConfig('codex-smoke', fakeCli);
    process.env.FAKE_CODEX_MODE = 'turn-completed-no-usage';

    const result = await testProvider({
      name: 'codex-smoke',
      configPath,
    });

    expect(result.binaryFound).toBe(true);
    expect(result.response).toBe('hello');
    expect(result.jsonValid).toBe(true);
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
    expect(result.error).toBeNull();
  });

  it('passes --model when provider options.defaultModel is configured', async () => {
    const fakeCli = writeFakeExecutable('codex-default-model');
    const configPath = writeConfig('codex-smoke', fakeCli, 'gpt-5.4-mini');
    const logPath = join(testDir, 'invoke-default-model.json');
    process.env.FAKE_CODEX_LOG = logPath;

    const result = await testProvider({
      name: 'codex-smoke',
      configPath,
    });

    expect(result.binaryFound).toBe(true);
    expect(result.response).toBe('hello');
    expect(result.error).toBeNull();

    const invocation = JSON.parse(readFileSync(logPath, 'utf8')) as { args: string[] };
    const modelFlagIndex = invocation.args.indexOf('--model');
    expect(modelFlagIndex).toBeGreaterThan(-1);
    expect(invocation.args[modelFlagIndex + 1]).toBe('gpt-5.4-mini');
  });
});

describe('testProvider() OpenAI-compatible smoke branch', () => {
  it('recognizes an aliased provider by type and calls chat completions', async () => {
    const fakeCli = writeFakeExecutable('node-fake');
    const configPath = writeOpenAiCompatibleConfig(fakeCli);
    process.env.OLLAMA_MAC_BASE_URL = 'http://mac.local:11434/v1';
    process.env.OLLAMA_MAC_API_KEY = 'local-key';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'hello',
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await testProvider({
      name: 'ollama-mac',
      configPath,
    });

    expect(result.binaryFound).toBe(true);
    expect(result.response).toBe('hello');
    expect(result.jsonValid).toBe(true);
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(2);
    expect(result.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mac.local:11434/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer local-key',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe('qwen3-coder:30b');
    expect(body.messages[0]?.content).toBe('Say hello in one word');
  });
});
