/**
 * `talonctl run-subagent` command.
 *
 * Manually invokes a sub-agent for testing/debugging purposes.
 * Loads the sub-agent, resolves the model, and executes it with
 * the provided JSON input. No database, daemon, or persona required.
 *
 * The pure `runSubAgent()` function can be called programmatically.
 * The `runSubAgentCommand()` wrapper handles config loading and console output.
 */

import { join } from 'node:path';
import { SubAgentLoader } from '../../subagents/subagent-loader.js';
import { ModelResolver } from '../../subagents/model-resolver.js';
import type { SubAgentContext, SubAgentResult } from '../../subagents/subagent-types.js';
import { runSubAgentModelChain } from '../../subagents/subagent-model-chain.js';
import type {
  SubAgentCliConfig,
  SubAgentSandboxConfig,
  SubAgentsConfig,
} from '../../core/config/config-types.js';
import type pino from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunSubAgentOptions {
  name: string;
  input: string; // JSON string
  subagentsDir: string;
  providers: Record<string, { apiKey?: string; baseURL?: string }>;
  subagentCli?: SubAgentCliConfig;
  subagentSandbox?: SubAgentSandboxConfig;
  subagentOverrides?: SubAgentsConfig;
}

// ---------------------------------------------------------------------------
// Core logic (importable, no console / process.exit)
// ---------------------------------------------------------------------------

function makeStderrLogger(): pino.Logger {
  const formatArgs = (args: unknown[]): string => args.map(formatLogArgument).join(' ');
  const logger = {
    info: (...args: unknown[]) => {
      process.stderr.write(`[info] ${formatArgs(args)}\n`);
    },
    warn: (...args: unknown[]) => {
      process.stderr.write(`[warn] ${formatArgs(args)}\n`);
    },
    error: (...args: unknown[]) => {
      process.stderr.write(`[error] ${formatArgs(args)}\n`);
    },
    debug: () => {},
    child: () => logger,
  };

  return logger as unknown as pino.Logger;
}

function formatLogArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailableServices(logger: pino.Logger): SubAgentContext['services'] {
  return { logger } as unknown as SubAgentContext['services'];
}

export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const { name, input: inputStr, subagentsDir, providers } = options;

  // Parse input JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputStr);
  } catch {
    throw new Error(`Invalid JSON input: ${inputStr}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('Invalid JSON input: must be a JSON object');
  }
  const input = parsed;

  // Load sub-agents.
  const logger = makeStderrLogger();
  const loader = new SubAgentLoader(logger);
  const loadResult = await loader.loadAll(subagentsDir);
  if (loadResult.isErr()) {
    throw new Error(`Failed to load sub-agents: ${loadResult.error.message}`);
  }

  const agent = loadResult.value.find((a) => a.manifest.name === name);
  if (!agent) {
    const available = loadResult.value.map((a) => a.manifest.name).join(', ') || 'none';
    throw new Error(`Sub-agent "${name}" not found. Available: ${available}`);
  }

  // Resolve and run the ordered model chain with the same semantics the
  // daemon uses, including timeout cancellation and fallbacks.
  const resolver = new ModelResolver(providers, options.subagentCli, options.subagentSandbox);
  const systemPrompt = agent.promptContents.join('\n\n');
  const chainResult = await runSubAgentModelChain({
    name,
    agent,
    input,
    override: options.subagentOverrides?.[name],
    modelResolver: resolver,
    logger,
    createContext: ({ model, entry, abortSignal, providerOptions }) => ({
      threadId: 'cli-test',
      personaId: 'cli-test',
      systemPrompt,
      model,
      maxOutputTokens: entry.maxTokens,
      rootPaths: agent.manifest.rootPaths,
      services: unavailableServices(logger),
      telemetry: { isEnabled: false },
      abortSignal,
      providerOptions,
    }),
  });

  if (chainResult.isErr()) {
    throw new Error(`Sub-agent execution failed: ${chainResult.error.message}`);
  }

  return chainResult.value.result;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function runSubAgentCommand(options: {
  name: string;
  input: string;
  configPath?: string;
  subagentsDir?: string;
}): Promise<void> {
  const { loadConfig } = await import('../../core/config/config-loader.js');

  const configPath = options.configPath ?? 'talond.yaml';
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
  }

  const config = configResult.value;

  // When no explicit dir is given, search built-in, cwd/subagents, and dataDir/subagents
  // (same three-source loading as daemon-bootstrap).
  const subagentsDirs = options.subagentsDir
    ? [options.subagentsDir]
    : [
        join(import.meta.dirname, '../../subagents/default'),
        join(process.cwd(), 'subagents'),
        join(config.dataDir, 'subagents'),
      ];

  try {
    // Try each directory in order until we find the requested sub-agent.
    let lastError: Error | null = null;
    for (const dir of subagentsDirs) {
      try {
        const result = await runSubAgent({
          name: options.name,
          input: options.input,
          subagentsDir: dir,
          providers: config.auth.providers ?? {},
          subagentCli: config.subagentCli,
          subagentSandbox: config.subagentSandbox,
          subagentOverrides: config.subagents ?? {},
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      } catch (e) {
        lastError = e as Error;
        // If it's "not found", try next directory
        if ((e as Error).message.includes('not found')) continue;
        // Any other error (model, execution) — stop immediately
        throw e;
      }
    }
    throw lastError ?? new Error(`Sub-agent "${options.name}" not found`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
