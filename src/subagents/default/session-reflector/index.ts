import { generateText } from 'ai';
import { ok, err } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { Result } from 'neverthrow';

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const observationLog = typeof input.observationLog === 'string' ? input.observationLog : '';

  if (!observationLog.trim()) {
    return err(new SubAgentError('Cannot reflect on empty observation log'));
  }

  try {
    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Consolidate this observation log:\n\n${observationLog}`,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });

    return ok({
      summary: 'Observations consolidated',
      data: { consolidatedLog: text } as unknown as Record<string, unknown>,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(new SubAgentError(
      `Session reflection failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}
