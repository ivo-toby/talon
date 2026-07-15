import { z } from 'zod';

import {
  LifecycleContractVersionSchema,
  LifecycleFilterOwnerNameSchema,
  LifecycleItemOriginSchema,
  LifecycleItemTypeSchema,
  LifecycleMessageSourceSchema,
  LifecycleScheduleSourceSchema,
} from './common.js';

const MAX_LIFECYCLE_FILTER_VALUES = 32;

export const LifecycleFilterContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    itemOrigins: z
      .array(LifecycleItemOriginSchema)
      .min(1)
      .max(MAX_LIFECYCLE_FILTER_VALUES)
      .optional(),
    itemTypes: z.array(LifecycleItemTypeSchema).min(1).max(MAX_LIFECYCLE_FILTER_VALUES).optional(),
    channels: z
      .array(LifecycleFilterOwnerNameSchema)
      .min(1)
      .max(MAX_LIFECYCLE_FILTER_VALUES)
      .optional(),
    personas: z
      .array(LifecycleFilterOwnerNameSchema)
      .min(1)
      .max(MAX_LIFECYCLE_FILTER_VALUES)
      .optional(),
    messageSources: z
      .array(LifecycleMessageSourceSchema)
      .min(1)
      .max(MAX_LIFECYCLE_FILTER_VALUES)
      .optional(),
    scheduleSources: z
      .array(LifecycleScheduleSourceSchema)
      .min(1)
      .max(MAX_LIFECYCLE_FILTER_VALUES)
      .optional(),
  })
  .strict();

export type LifecycleFilterContract = z.infer<typeof LifecycleFilterContractSchema>;
