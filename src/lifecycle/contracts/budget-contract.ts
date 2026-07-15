import { z } from 'zod';

import { LifecycleContractVersionSchema } from './common.js';

export const LifecycleBudgetContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(60 * 60 * 1000),
    maxConcurrency: z.number().int().min(1).max(256).optional(),
  })
  .strict();

export type LifecycleBudgetContract = z.infer<typeof LifecycleBudgetContractSchema>;
