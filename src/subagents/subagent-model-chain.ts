/** Shared model resolution, failover, and timeout behavior for sub-agents. */

import { err, ok, type Result } from 'neverthrow';
import type { LanguageModel } from 'ai';
import type pino from 'pino';
import type { SubAgentsConfig } from '../core/config/config-types.js';
import { SubAgentError } from '../core/errors/index.js';
import type { ModelResolver } from './model-resolver.js';
import { wrapProviderOptions } from './provider-options.js';
import type {
  LoadedSubAgent,
  SubAgentContext,
  SubAgentInput,
  SubAgentResult,
} from './subagent-types.js';

export interface SubAgentModelChainEntry {
  provider: string;
  name: string;
  maxTokens: number;
  timeoutMs: number;
  providerOptions?: Record<string, unknown>;
  source: 'override' | 'manifest';
}

export interface SubAgentModelChainSuccess {
  result: SubAgentResult;
  model: string;
  source: SubAgentModelChainEntry['source'];
  failedAttempts: number;
}

export interface RunSubAgentModelChainOptions {
  name: string;
  agent: LoadedSubAgent;
  input: SubAgentInput;
  override?: SubAgentsConfig[string];
  modelResolver: ModelResolver;
  logger: pino.Logger;
  createContext: (params: {
    model: LanguageModel;
    entry: SubAgentModelChainEntry;
    abortSignal: AbortSignal;
    providerOptions?: SubAgentContext['providerOptions'];
  }) => SubAgentContext;
}

export function buildSubAgentModelChain(
  agent: LoadedSubAgent,
  override?: SubAgentsConfig[string],
): SubAgentModelChainEntry[] {
  return [
    ...(override?.model ?? []).map((entry) => ({
      provider: entry.provider,
      name: entry.name,
      maxTokens: entry.maxTokens ?? agent.manifest.model.maxTokens,
      timeoutMs: entry.timeoutMs ?? agent.manifest.timeoutMs,
      providerOptions: entry.providerOptions,
      source: 'override' as const,
    })),
    {
      provider: agent.manifest.model.provider,
      name: agent.manifest.model.name,
      maxTokens: agent.manifest.model.maxTokens,
      timeoutMs: agent.manifest.timeoutMs,
      source: 'manifest' as const,
    },
  ];
}

export async function runSubAgentModelChain(
  options: RunSubAgentModelChainOptions,
): Promise<Result<SubAgentModelChainSuccess, SubAgentError>> {
  const entries = buildSubAgentModelChain(options.agent, options.override);
  const failures: string[] = [];

  for (const entry of entries) {
    const label = `${entry.provider}/${entry.name}`;
    const resolved = await options.modelResolver.resolve(entry);
    if (resolved.isErr()) {
      const message = resolved.error.message;
      failures.push(`${label} (${entry.source}): ${message}`);
      options.logger.warn(
        { subagent: options.name, model: label, source: entry.source },
        `Sub-agent model resolution failed, trying next: ${message}`,
      );
      continue;
    }

    const abortController = new AbortController();
    const providerOptions = wrapProviderOptions(
      entry.provider,
      entry.providerOptions,
      options.logger,
      { subagent: options.name, source: entry.source },
    );

    try {
      const result = await runWithTimeout(
        options.agent.run(
          options.createContext({
            model: resolved.value,
            entry,
            abortSignal: abortController.signal,
            providerOptions,
          }),
          options.input,
        ),
        entry.timeoutMs,
        options.name,
        abortController,
      );

      if (result.isOk()) {
        if (failures.length > 0) {
          options.logger.info(
            {
              subagent: options.name,
              model: label,
              source: entry.source,
              failedAttempts: failures.length,
            },
            'Sub-agent succeeded after failover',
          );
        } else {
          options.logger.info(
            { subagent: options.name, model: label, source: entry.source },
            'Sub-agent completed',
          );
        }

        return ok({
          result: result.value,
          model: label,
          source: entry.source,
          failedAttempts: failures.length,
        });
      }

      const message = result.error.message;
      failures.push(`${label} (${entry.source}): ${message}`);
      options.logger.warn(
        { subagent: options.name, model: label, source: entry.source },
        `Sub-agent run failed, trying next: ${message}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${label} (${entry.source}): ${message}`);
      options.logger.warn(
        { subagent: options.name, model: label, source: entry.source, timeoutMs: entry.timeoutMs },
        `Sub-agent execution threw, trying next: ${message}`,
      );
    }
  }

  return err(
    new SubAgentError(
      `All models failed for sub-agent "${options.name}":\n  ${failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n  ')}`,
    ),
  );
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  name: string,
  abortController: AbortController,
): Promise<T> {
  const abortGraceMs = 3_000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let timedOut = false;
  const observedPromise = promise.finally(() => {
    settled = true;
  });
  const deadlineGuardedPromise = observedPromise.then(
    (value) => {
      if (timedOut) return new Promise<never>(() => undefined);
      return value;
    },
    (error: unknown) => {
      if (timedOut) return new Promise<never>(() => undefined);
      throw error;
    },
  );
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      abortController.abort();
      void waitForAbortCleanup(observedPromise, abortGraceMs).finally(() => {
        reject(new SubAgentError(`Sub-agent "${name}" timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([deadlineGuardedPromise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function waitForAbortCleanup(promise: Promise<unknown>, graceMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
