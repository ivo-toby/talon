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
import type { SubAgentResult } from '../../subagents/subagent-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunSubAgentOptions {
  name: string;
  input: string;          // JSON string
  subagentsDir: string;
  providers: Record<string, { apiKey?: string; baseURL?: string }>;
  subagentOverrides?: Record<string, { model: Array<{ provider: string; name: string; maxTokens?: number; timeoutMs?: number; providerOptions?: Record<string, unknown> }> }>;
}

// ---------------------------------------------------------------------------
// Core logic (importable, no console / process.exit)
// ---------------------------------------------------------------------------

const makeStderrLogger = () =>
  ({
    info: (...args: unknown[]) => { process.stderr.write(`[info] ${args.map(String).join(' ')}\n`); },
    warn: (...args: unknown[]) => { process.stderr.write(`[warn] ${args.map(String).join(' ')}\n`); },
    error: (...args: unknown[]) => { process.stderr.write(`[error] ${args.map(String).join(' ')}\n`); },
    debug: () => {},
    child() { return this; },
  }) as any;

export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const { name, input: inputStr, subagentsDir, providers } = options;

  // Parse input JSON.
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(inputStr);
  } catch {
    throw new Error(`Invalid JSON input: ${inputStr}`);
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Invalid JSON input: must be a JSON object');
  }

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

  // Resolve model — try overrides first, then manifest fallback.
  const resolver = new ModelResolver(providers);
  const overrideConfig = options.subagentOverrides?.[name];
  let resolvedModel;
  let resolvedMaxTokens = agent.manifest.model.maxTokens;
  let resolvedTimeoutMs = agent.manifest.timeoutMs;
  let resolvedProviderOptions: Record<string, unknown> | undefined;
  let resolvedProviderName = agent.manifest.model.provider;

  if (overrideConfig) {
    for (const entry of overrideConfig.model) {
      const entryMaxTokens = entry.maxTokens ?? agent.manifest.model.maxTokens;
      const result = await resolver.resolve({
        provider: entry.provider,
        name: entry.name,
        maxTokens: entryMaxTokens,
      });
      if (result.isOk()) {
        resolvedModel = result.value;
        resolvedMaxTokens = entryMaxTokens;
        resolvedTimeoutMs = entry.timeoutMs ?? agent.manifest.timeoutMs;
        resolvedProviderOptions = entry.providerOptions;
        resolvedProviderName = entry.provider;
        logger.info(`Resolved model: ${entry.provider}/${entry.name}`);
        break;
      }
      logger.warn(`Model ${entry.provider}/${entry.name} failed, trying next`);
    }
  }

  if (!resolvedModel) {
    const modelResult = await resolver.resolve(agent.manifest.model);
    if (modelResult.isErr()) {
      throw new Error(`Model resolution failed: ${modelResult.error.message}`);
    }
    resolvedModel = modelResult.value;
  }

  // Execute with resolved timeout (from override or manifest).
  const systemPrompt = agent.promptContents.join('\n\n');
  const abortController = new AbortController();
  const wrappedProviderOptions = resolvedProviderOptions
    ? { [resolvedProviderName]: resolvedProviderOptions }
    : undefined;
  const runPromise = agent.run(
    {
      threadId: 'cli-test',
      personaId: 'cli-test',
      systemPrompt,
      model: resolvedModel,
      maxOutputTokens: resolvedMaxTokens,
      rootPaths: agent.manifest.rootPaths,
      services: {
        memory: {} as any,
        schedules: {} as any,
        personas: {} as any,
        channels: {} as any,
        threads: {} as any,
        messages: {} as any,
        runs: {} as any,
        queue: {} as any,
        logger,
      },
      telemetry: { isEnabled: false },
      abortSignal: abortController.signal,
      providerOptions: wrappedProviderOptions as Record<string, import('@ai-sdk/provider').JSONObject> | undefined,
    },
    input,
  );

  const timeoutMs = resolvedTimeoutMs;
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => {
        abortController.abort();
        reject(new Error(`Sub-agent "${name}" timed out after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  });

  let result: Awaited<ReturnType<typeof agent.run>>;
  try {
    result = await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }

  if (result.isErr()) {
    throw new Error(`Sub-agent execution failed: ${result.error.message}`);
  }

  return result.value;
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

