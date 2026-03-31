/**
 * `talonctl test-provider` command.
 *
 * Tests a configured provider by running a minimal invocation:
 *   1. Checks the binary is reachable (`<command> --version`).
 *   2. Runs a real "Say hello in one word" prompt and validates JSON output.
 *
 * Uses child_process.spawn with a 30-second timeout.
 */

import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  DEFAULT_CONFIG_PATH,
  readConfig,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TestProviderContext = 'agent-runner' | 'background';

export interface TestProviderOptions {
  name: string;
  context?: TestProviderContext;
  configPath?: string;
}

export interface TestProviderResult {
  binaryFound: boolean;
  version: string | null;
  response: string | null;
  jsonValid: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SPAWN_TIMEOUT_MS = 30_000;

/**
 * Runs a child process and collects stdout/stderr within a timeout.
 *
 * @returns stdout string on success.
 * @throws Error if the process fails, exits non-zero, or times out.
 */
function runProcess(
  command: string,
  args: string[],
  input?: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options?.cwd,
      env: options?.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Process timed out after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}. stderr: ${stderr.trim()}`));
      } else {
        resolve(stdout);
      }
    });

    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/**
 * Extracts a version string from `--version` output.
 * Handles formats like "1.2.3", "claude 1.2.3", "gemini 0.33.1", etc.
 */
function extractVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+[\.\d]*)/);
  return match ? match[1] : output.trim().split('\n')[0].trim() || null;
}

/**
 * Tries to parse a text response from JSON output formats used by
 * claude (--print) and gemini (--output-format json).
 *
 * Returns { text, inputTokens, outputTokens } or null if unparseable.
 */
function parseJsonResponse(raw: string): { text: string; inputTokens: number | null; outputTokens: number | null } | null {
  // Try to find a JSON object/array anywhere in the output (providers may
  // prefix with warnings or ANSI codes).
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) return null;

  const jsonStr = raw.slice(jsonStart, jsonEnd + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try array form
    const arrStart = raw.indexOf('[');
    const arrEnd = raw.lastIndexOf(']');
    if (arrStart === -1 || arrEnd === -1) return null;
    try {
      parsed = JSON.parse(raw.slice(arrStart, arrEnd + 1));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  // Claude `--print` JSON format: { type: 'result', result: '...', ... }
  // or array of message events with role/content.
  const obj = parsed as Record<string, unknown>;

  // Claude SDK output style: { type: 'result', result: string }
  if (typeof obj.result === 'string') {
    const usage = obj.usage as Record<string, unknown> | undefined;
    return {
      text: obj.result,
      inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : null,
      outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : null,
    };
  }

  // Gemini CLI --output-format json: { response: "...", stats: { models: { <name>: { tokens: { input, candidates } } } } }
  if (typeof obj.response === 'string') {
    const stats = obj.stats as Record<string, unknown> | undefined;
    const models = stats?.models as Record<string, Record<string, unknown>> | undefined;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    if (models) {
      for (const modelStats of Object.values(models)) {
        const tokens = modelStats?.tokens as Record<string, unknown> | undefined;
        if (typeof tokens?.input === 'number') inputTokens = (inputTokens ?? 0) + tokens.input;
        if (typeof tokens?.candidates === 'number') outputTokens = (outputTokens ?? 0) + tokens.candidates;
      }
    }
    return { text: obj.response, inputTokens, outputTokens };
  }

  // Fallback: look for any 'text' or 'content' field.
  if (typeof obj.text === 'string') {
    return { text: obj.text, inputTokens: null, outputTokens: null };
  }
  if (typeof obj.content === 'string') {
    return { text: obj.content, inputTokens: null, outputTokens: null };
  }

  return null;
}

function parseCodexJsonl(raw: string): {
  hasThreadStarted: boolean;
  hasTurnCompleted: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
} {
  let hasThreadStarted = false;
  let hasTurnCompleted = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === 'thread.started') {
      hasThreadStarted = true;
    }

    if (event.type === 'turn.completed') {
      hasTurnCompleted = true;
      if (typeof event.usage === 'object' && event.usage !== null) {
        const usage = event.usage as Record<string, unknown>;
        inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
        outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
      }
    }
  }

  return { hasThreadStarted, hasTurnCompleted, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Tests a provider by running a version check and a minimal prompt.
 *
 * Pure business logic — no console output or process.exit.
 *
 * @throws Error if the config file can't be read or the provider isn't found.
 */
export async function testProvider(options: TestProviderOptions): Promise<TestProviderResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const ctx = options.context ?? 'agent-runner';

  if (!options.name || options.name.trim() === '') {
    throw new Error('Provider name must not be empty.');
  }

  const doc = await readConfig(configPath);

  const sectionKey = ctx === 'agent-runner' ? 'agentRunner' : 'backgroundAgent';
  const section = doc[sectionKey] as Record<string, unknown> | undefined;
  const providers = section?.providers as Record<string, unknown> | undefined;

  if (!providers || !(options.name in providers)) {
    const available = providers ? Object.keys(providers).join(', ') || 'none' : 'none';
    throw new Error(
      `Provider "${options.name}" not found in "${sectionKey}" context of "${configPath}". Available: ${available}.`,
    );
  }

  const providerEntry = providers[options.name] as Record<string, unknown>;
  if (providerEntry.enabled === false) {
    throw new Error(
      `Provider "${options.name}" is disabled. Enable it before testing.`,
    );
  }

  const command = typeof providerEntry.command === 'string' ? providerEntry.command : '';
  if (!command) {
    throw new Error(`Provider "${options.name}" has no command configured.`);
  }

  const result: TestProviderResult = {
    binaryFound: false,
    version: null,
    response: null,
    jsonValid: false,
    inputTokens: null,
    outputTokens: null,
    error: null,
  };

  // Step 1: version check.
  try {
    const versionOutput = await runProcess(command, ['--version']);
    result.binaryFound = true;
    result.version = extractVersion(versionOutput);
  } catch (err) {
    result.binaryFound = false;
    result.error = `Binary check failed: ${(err as Error).message}`;
    return result;
  }

  // Step 2: real test — determine flags based on provider name/command.
  const prompt = 'Say hello in one word';
  const normalizedCommandFull = command.trim().toLowerCase();
  const normalizedCommandBase = basename(command.trim())
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/u, '');
  const normalizedName = options.name.trim().toLowerCase();
  const isCodex = normalizedName.includes('codex')
    || normalizedCommandBase.includes('codex')
    || normalizedCommandFull.includes('codex');
  const isGemini = normalizedName.includes('gemini')
    || normalizedCommandBase.includes('gemini')
    || normalizedCommandFull.includes('gemini');
  const providerOptions = (
    typeof providerEntry.options === 'object' && providerEntry.options !== null
      ? providerEntry.options
      : undefined
  ) as Record<string, unknown> | undefined;
  const defaultModel = typeof providerOptions?.defaultModel === 'string'
    && providerOptions.defaultModel.trim().length > 0
    ? providerOptions.defaultModel.trim()
    : undefined;

  if (isCodex) {
    let tempHome: string | null = null;
    try {
      tempHome = await mkdtemp(join(tmpdir(), 'talonctl-test-provider-codex-'));
      const codexDir = join(tempHome, '.codex');
      await mkdir(codexDir, { recursive: true, mode: 0o700 });

      const operatorHome = process.env.HOME ?? homedir();
      const authSrc = join(operatorHome, '.codex', 'auth.json');
      const authDest = join(codexDir, 'auth.json');
      const authJson = await readFile(authSrc, 'utf8');
      await writeFile(authDest, authJson, { encoding: 'utf8', mode: 0o600 });

      const configPath = join(codexDir, 'config.toml');
      const configToml = `[projects.${JSON.stringify(tempHome)}]\ntrust_level = "trusted"\n`;
      await writeFile(configPath, configToml, { encoding: 'utf8', mode: 0o600 });

      const lastMessagePath = join(tempHome, 'last-message.txt');
      const codexArgs = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        tempHome,
        '-o',
        lastMessagePath,
      ];
      if (defaultModel) {
        codexArgs.push('--model', defaultModel);
      }
      codexArgs.push(prompt);

      const testOutput = await runProcess(command, codexArgs, undefined, {
        env: {
          ...process.env,
          HOME: tempHome,
        },
      });

      const parsed = parseCodexJsonl(testOutput);
      result.jsonValid = parsed.hasThreadStarted && parsed.hasTurnCompleted;
      result.inputTokens = parsed.inputTokens;
      result.outputTokens = parsed.outputTokens;

      try {
        const message = (await readFile(lastMessagePath, 'utf8')).trim();
        result.response = message.length > 0 ? message : null;
      } catch {
        result.response = null;
      }

      if (!result.jsonValid) {
        result.error = 'Codex CLI returned invalid JSONL output (expected thread.started and turn.completed).';
      }
      if (!result.response) {
        result.error = result.error
          ? `${result.error} Missing final assistant output file content.`
          : 'Codex CLI did not produce a final assistant output file.';
      }
    } catch (err) {
      result.error = `Test query failed: ${(err as Error).message}`;
    } finally {
      if (tempHome) {
        await rm(tempHome, { recursive: true, force: true });
      }
    }

    return result;
  }

  const testArgs = isGemini
    ? ['--approval-mode', 'yolo', '--output-format', 'json', prompt]
    : ['--print', '--output-format', 'json', '-p', prompt];

  try {
    const testOutput = await runProcess(command, testArgs);
    const parsed = parseJsonResponse(testOutput);
    if (parsed) {
      result.response = parsed.text.trim();
      result.jsonValid = true;
      result.inputTokens = parsed.inputTokens;
      result.outputTokens = parsed.outputTokens;
    } else if (isGemini) {
      // Gemini requires structured JSON output. Plain text means the CLI
      // version is incompatible or misconfigured.
      result.response = testOutput.trim().split('\n')[0].trim() || null;
      result.jsonValid = false;
      result.error = 'Gemini CLI returned non-JSON output despite --output-format json. Upgrade to a compatible version.';
    } else {
      // Claude plain-text fallback is acceptable for the test.
      result.response = testOutput.trim().split('\n')[0].trim() || null;
      result.jsonValid = false;
    }
  } catch (err) {
    result.error = `Test query failed: ${(err as Error).message}`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl test-provider`.
 *
 * Thin wrapper around {@link testProvider} that prints structured output and exits.
 */
export async function testProviderCommand(options: TestProviderOptions): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Peek at the command for display (best-effort, ignore read errors here).
  let commandDisplay = '';
  try {
    const doc = await readConfig(configPath);
    const ctx = options.context ?? 'agent-runner';
    const sectionKey = ctx === 'agent-runner' ? 'agentRunner' : 'backgroundAgent';
    const section = doc[sectionKey] as Record<string, unknown> | undefined;
    const providers = section?.providers as Record<string, unknown> | undefined;
    const entry = providers?.[options.name] as Record<string, unknown> | undefined;
    if (typeof entry?.command === 'string') {
      commandDisplay = ` (command: ${entry.command})`;
    }
  } catch {
    // ignore
  }

  console.log(`Testing provider "${options.name}"${commandDisplay}...`);
  console.log('');

  try {
    const result = await testProvider(options);

    const label = (text: string): string => `  ${text.padEnd(18)}`;

    console.log(`${label('Binary found:')}${result.binaryFound ? 'yes' : 'no'}`);

    if (result.binaryFound) {
      console.log(`${label('Version:')}${result.version ?? '(unknown)'}`);

      if (result.error && result.response === null) {
        console.log(`${label('Test query:')}failed`);
        console.log(`${label('Error:')}${result.error}`);
      } else {
        console.log(`${label('Test query:')}${result.response !== null ? 'ok' : 'running...'}`);
        if (result.response !== null) {
          console.log(`${label('Response:')}${JSON.stringify(result.response)}`);
          console.log(`${label('JSON output:')}${result.jsonValid ? 'valid' : 'invalid (plain text)'}`);
          if (result.inputTokens !== null || result.outputTokens !== null) {
            const inp = result.inputTokens ?? '?';
            const out = result.outputTokens ?? '?';
            console.log(`${label('Token usage:')}${inp} input, ${out} output`);
          }
        }
      }
    } else {
      console.log(`${label('Error:')}${result.error ?? 'binary not found'}`);
    }

    console.log('');

    if (result.binaryFound && result.response !== null && !result.error) {
      console.log(`Provider "${options.name}" is working correctly.`);
    } else if (!result.binaryFound) {
      console.error(`Provider "${options.name}" binary not found. Check the command path.`);
      process.exit(1);
    } else {
      console.error(`Provider "${options.name}" test failed. See details above.`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
