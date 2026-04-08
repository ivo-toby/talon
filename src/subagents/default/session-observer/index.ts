import { generateText } from 'ai';
import { ok, err } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { Result } from 'neverthrow';

/**
 * Expected shape of the observer's JSON output.
 *
 * Uses generateText + manual JSON parsing instead of generateObject
 * because many Ollama/OpenAI-compatible models don't support the
 * structured output / tool-use mode that generateObject requires.
 */
interface ObserverOutput {
  observations: Array<{
    date: string;
    time: string;
    priority: 'high' | 'medium' | 'low';
    text: string;
  }>;
  currentTask: string;
  suggestedContinuation: string;
  memoryUpdates: Array<{
    key: string;
    value: string;
    mode: 'append' | 'replace';
  }>;
}

const JSON_FORMAT_INSTRUCTIONS = `
Respond with a JSON object (no markdown fences, no extra text) matching this structure:

{
  "observations": [
    { "date": "YYYY-MM-DD", "time": "HH:MM", "priority": "high|medium|low", "text": "one sentence" }
  ],
  "currentTask": "what was being worked on (empty string if nothing)",
  "suggestedContinuation": "what to do next (empty string if nothing)",
  "memoryUpdates": [
    { "key": "namespace:topic", "value": "fact prefixed with date", "mode": "append|replace" }
  ]
}`;

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';

  if (!transcript.trim()) {
    return err(new SubAgentError('Cannot observe empty transcript'));
  }

  try {
    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Create observations from this conversation transcript.

${JSON_FORMAT_INSTRUCTIONS}

Transcript:

${transcript}`,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
      providerOptions: ctx.providerOptions,
    });

    // Extract JSON from the response — handle models that wrap in markdown fences.
    const jsonStr = extractJson(text);
    if (!jsonStr) {
      return err(new SubAgentError(
        `Session observer returned non-JSON response (${text.length} chars). First 200 chars: ${text.slice(0, 200)}`,
      ));
    }

    const parsed = JSON.parse(jsonStr) as ObserverOutput;

    // Validate minimum structure.
    if (!Array.isArray(parsed.observations)) {
      return err(new SubAgentError('Session observer response missing observations array'));
    }

    return ok({
      summary: parsed.currentTask || 'Observations recorded',
      data: parsed as unknown as Record<string, unknown>,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return err(new SubAgentError(`Session observer returned invalid JSON: ${error.message}`));
    }
    return err(new SubAgentError(
      `Session observation failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}

/**
 * Extract a JSON object from text that may contain markdown fences,
 * preamble, or trailing text around the JSON.
 */
function extractJson(text: string): string | null {
  // Try the raw text first.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }

  // Try extracting from markdown code fences.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Try finding the first { ... } block.
  const braceStart = trimmed.indexOf('{');
  if (braceStart >= 0) {
    return trimmed.slice(braceStart);
  }

  return null;
}
