import { generateObject } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ok, err } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../subagent-types.js';
import { SubAgentError } from '../../../core/errors/index.js';
import type { MemoryItemRow, InsertMemoryItemInput } from '../../../core/database/repositories/memory-repository.js';

// Note: no .min() on arrays — Haiku's structured output doesn't support minItems.
// Empty/insufficient arrays are handled at runtime (validIds check + consolidate guard).
// Flat schema instead of discriminatedUnion — Anthropic structured output does not support
// the `oneOf` keyword that discriminatedUnion generates in JSON Schema.
// superRefine enforces the consolidate/mergedContent invariant at parse time without oneOf.
const GroomActionSchema = z
  .object({
    type: z.enum(['prune', 'consolidate', 'keep']),
    ids: z.array(z.string()),
    reason: z.string(),
    mergedContent: z
      .string()
      .optional()
      .describe('Required when type="consolidate".'),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'consolidate' && !value.mergedContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mergedContent'],
        message: 'mergedContent is required when type="consolidate".',
      });
    }
  });

const GroomResponseSchema = z.object({
  actions: z.array(GroomActionSchema),
});

/** Format memory items into a numbered list for the model prompt. */
function formatMemories(items: MemoryItemRow[]): string {
  return items
    .map(
      (item, idx) =>
        `${idx + 1}. [id=${item.id}] type=${item.type} created=${new Date(item.created_at).toISOString()}\n   ${item.content}`,
    )
    .join('\n\n');
}

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const { memory, logger } = ctx.services;

  const periodMs = typeof input.periodMs === 'number' && input.periodMs > 0
    ? input.periodMs
    : 0;

  // 1. Read all memory items for this thread.
  const findResult = memory.findByThread(ctx.threadId);
  if (findResult.isErr()) {
    return err(new SubAgentError(`Failed to read memory items: ${findResult.error.message}`));
  }

  // Filter by time window if periodMs is set.
  let items = findResult.value;
  if (periodMs > 0) {
    const cutoff = Date.now() - periodMs;
    items = items.filter((item) => item.created_at >= cutoff);
  }
  if (items.length === 0) {
    return ok({
      summary: 'No memory items to groom.',
      data: { pruned: 0, consolidated: 0, kept: 0 },
    });
  }

  // 2. Format memories and send to model.
  const prompt = `Review the following ${items.length} memory entries and recommend grooming actions:\n\n${formatMemories(items)}`;

  try {
    const { object: response, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      schema: GroomResponseSchema,
      maxOutputTokens: ctx.maxOutputTokens,
      experimental_telemetry: ctx.telemetry,
    });

    // 3. Check if any actions were returned.
    if (response.actions.length === 0) {
      return ok({
        summary: 'Memory grooming complete. No changes recommended.',
        data: { pruned: 0, consolidated: 0, kept: 0 },
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costUsd: 0,
        },
      });
    }

    // 4. Execute actions — only operate on IDs that exist in the fetched items.
    const knownIds = new Set(items.map((i) => i.id));
    let pruned = 0;
    let consolidated = 0;
    let kept = 0;

    for (const action of response.actions) {
      // Filter out any IDs the model hallucinated.
      const validIds = action.ids.filter((id) => knownIds.has(id));
      if (validIds.length === 0) {
        logger.warn({ action }, 'All IDs in action are unknown, skipping');
        continue;
      }
      // Work with only valid IDs from here.
      const actionIds = validIds;

      switch (action.type) {
        case 'prune': {
          for (const id of actionIds) {
            const deleteResult = memory.delete(ctx.threadId, id);
            if (deleteResult.isErr()) {
              logger.warn({ id, error: deleteResult.error.message }, 'Failed to delete memory item during prune');
            } else {
              pruned++;
            }
          }
          break;
        }

        case 'consolidate': {
          if (actionIds.length < 2) {
            logger.warn({ action }, 'Skipping consolidate action with fewer than 2 valid ids');
            break;
          }
          if (!action.mergedContent) {
            logger.warn({ action }, 'Skipping consolidate action missing mergedContent');
            break;
          }

          // Find the first source item to inherit its type and metadata.
          const sourceItem = items.find((i) => i.id === actionIds[0]);
          if (!sourceItem) {
            logger.warn({ ids: actionIds }, 'Source item not found for consolidation');
            break;
          }

          // Insert merged entry FIRST to prevent data loss if insert fails.
          const newItem: InsertMemoryItemInput = {
            id: randomUUID(),
            thread_id: ctx.threadId,
            type: sourceItem.type,
            content: action.mergedContent,
            embedding_ref: null,
            metadata: sourceItem.metadata,
          };
          const insertResult = memory.insert(newItem);
          if (insertResult.isErr()) {
            logger.warn({ error: insertResult.error.message }, 'Failed to insert consolidated memory item, skipping consolidation');
            break;
          }

          // Delete source entries only after successful insert.
          for (const id of actionIds) {
            const deleteResult = memory.delete(ctx.threadId, id);
            if (deleteResult.isErr()) {
              logger.warn({ id, error: deleteResult.error.message }, 'Failed to delete memory item during consolidation');
            }
          }
          consolidated++;
          break;
        }

        case 'keep': {
          kept += actionIds.length;
          break;
        }
      }
    }

    return ok({
      summary: `Memory grooming complete: ${pruned} pruned, ${consolidated} consolidated, ${kept} kept.`,
      data: { pruned, consolidated, kept },
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(
      new SubAgentError(
        `Memory grooming failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}
