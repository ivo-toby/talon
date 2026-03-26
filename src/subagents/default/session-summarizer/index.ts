import { generateObject } from 'ai';
import { z } from 'zod';
import { ok, err } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { Result } from 'neverthrow';

const MemoryUpdateSchema = z.object({
  key: z.string().describe('Namespace:topic key for this fact (e.g., work:people, groceries:preferences)'),
  value: z.string().describe('The fact to store, prefixed with date'),
  mode: z.enum(['append', 'replace']).describe('Whether to append to or replace the existing entry'),
});

const SummarySchema = z.object({
  keyFacts: z.array(z.string()).describe('Key facts and decisions from the conversation'),
  openThreads: z.array(z.string()).describe('Unresolved topics or pending items'),
  memoryUpdates: z.array(MemoryUpdateSchema).describe('Facts to store in specific memory namespace:topic keys'),
  summary: z.string().describe('Short narrative summary (max 500 chars) for conversation resumption context only'),
});

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';

  if (!transcript.trim()) {
    return err(new SubAgentError('Cannot summarize empty transcript'));
  }

  try {
    const { object, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Summarize this conversation transcript:\n\n${transcript}`,
      schema: SummarySchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
    });

    return ok({
      summary: object.summary || 'Session summarized successfully',
      data: object as unknown as Record<string, unknown>,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(new SubAgentError(
      `Session summarization failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}
