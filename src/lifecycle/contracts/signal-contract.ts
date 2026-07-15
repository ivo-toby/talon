import { z } from 'zod';

import {
  LifecycleContractVersionSchema,
  LifecycleVersionedTypeNameSchema,
} from './common.js';

export const LifecycleSignalContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    type: LifecycleVersionedTypeNameSchema,
  })
  .strict();

export type LifecycleSignalContract = z.infer<typeof LifecycleSignalContractSchema>;
