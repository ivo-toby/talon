import { generateObject } from 'ai';
import { z } from 'zod';
import { ok, err } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { Result } from 'neverthrow';

const FileOperationSchema = z.object({
  path: z.string()
    .refine((p) => !p.startsWith('/') && !p.includes('..'), {
      message: 'Path must be relative and must not contain ".." segments',
    })
    .describe('Relative file path (no absolute paths or traversal)'),
  content: z.string().describe('Complete file content'),
  action: z.enum(['create', 'replace']).describe('Whether to create a new file or replace an existing one'),
});

const SparkCoderOutputSchema = z.object({
  files: z.array(FileOperationSchema).describe('File operations to apply'),
  explanation: z.string().describe('Brief explanation of what was done and why (1-2 sentences)'),
});

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const task = typeof input.task === 'string' ? input.task.trim() : '';

  if (!task) {
    return err(new SubAgentError('Cannot generate code without a task description'));
  }

  const contextFiles = Array.isArray(input.contextFiles)
    ? (input.contextFiles as unknown[]).filter(
        (f): f is { path: string; content: string } =>
          typeof f === 'object' &&
          f !== null &&
          typeof (f as Record<string, unknown>).path === 'string' &&
          typeof (f as Record<string, unknown>).content === 'string',
      )
    : [];

  const contextBlock = contextFiles.length > 0
    ? contextFiles
        .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join('\n\n')
    : '(no context files provided)';

  const constraints = typeof input.constraints === 'string'
    ? `\n\nConstraints: ${input.constraints}`
    : '';

  const prompt = `## Task\n${task}${constraints}\n\n## Context Files\n${contextBlock}`;

  try {
    const { object, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      schema: SparkCoderOutputSchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
      abortSignal: ctx.abortSignal,
    });

    return ok({
      summary: object.explanation || `Generated ${object.files.length} file(s)`,
      data: {
        files: object.files,
        explanation: object.explanation,
      },
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(new SubAgentError(
      `Code generation failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}
