import { generateObject } from 'ai';
import { z } from 'zod';
import { ok, err } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { Result } from 'neverthrow';

const ObservationSchema = z.object({
  date: z.string().describe('ISO date YYYY-MM-DD'),
  time: z.string().describe('HH:MM timestamp'),
  priority: z.enum(['high', 'medium', 'low']).describe('Importance level'),
  text: z.string().describe('One clear sentence'),
});

const MemoryUpdateSchema = z.object({
  key: z.string().describe('Namespace:topic key (e.g., work:people, projects:talon)'),
  value: z.string().describe('The fact to store, prefixed with date'),
  mode: z.enum(['append', 'replace']).describe('Whether to append to or replace the existing entry'),
});

const ObserverOutputSchema = z.object({
  observations: z.array(ObservationSchema).describe('Dated, prioritized observations from the conversation'),
  currentTask: z.string().describe('What the agent was actively working on (empty if nothing)'),
  suggestedContinuation: z.string().describe('What the agent should do next to resume (empty if nothing)'),
  memoryUpdates: z.array(MemoryUpdateSchema).describe('Facts to store in specific memory namespace:topic keys'),
});

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';

  if (!transcript.trim()) {
    return err(new SubAgentError('Cannot observe empty transcript'));
  }

  try {
    const { object, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Create observations from this conversation transcript:\n\n${transcript}`,
      schema: ObserverOutputSchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });

    return ok({
      summary: object.currentTask || 'Observations recorded',
      data: object as unknown as Record<string, unknown>,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(new SubAgentError(
      `Session observation failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}
