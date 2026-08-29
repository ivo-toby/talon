import { z } from 'zod';

import { LifecycleContractVersionSchema } from './common.js';

export const LifecycleFailurePolicyModeSchema = z.enum([
  'fail_closed',
  'fail_open',
  'dead_letter',
  'preserve_session',
]);

export const LifecycleFailurePolicyContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    mode: LifecycleFailurePolicyModeSchema,
  })
  .strict();

export type LifecycleFailurePolicyContract = z.infer<typeof LifecycleFailurePolicyContractSchema>;
