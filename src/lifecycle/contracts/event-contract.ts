import { z } from 'zod';

import {
  LifecycleContractVersionSchema,
  LifecycleVersionedTypeNameSchema,
} from './common.js';

export const LifecycleEventContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    type: LifecycleVersionedTypeNameSchema,
  })
  .strict();

export type LifecycleEventContract = z.infer<typeof LifecycleEventContractSchema>;
