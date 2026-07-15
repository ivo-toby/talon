import { z } from 'zod';

import {
  LifecycleContractVersionSchema,
  LifecycleItemOriginSchema,
  LifecycleItemTypeSchema,
  LifecycleMessageSourceSchema,
  LifecycleScheduleSourceSchema,
} from './common.js';

const NonEmptyStringListSchema = z.array(z.string().trim().min(1)).min(1);

export const LifecycleFilterContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    itemOrigins: z.array(LifecycleItemOriginSchema).min(1).optional(),
    itemTypes: z.array(LifecycleItemTypeSchema).min(1).optional(),
    channels: NonEmptyStringListSchema.optional(),
    personas: NonEmptyStringListSchema.optional(),
    messageSources: z.array(LifecycleMessageSourceSchema).min(1).optional(),
    scheduleSources: z.array(LifecycleScheduleSourceSchema).min(1).optional(),
  })
  .strict();

export type LifecycleFilterContract = z.infer<typeof LifecycleFilterContractSchema>;
