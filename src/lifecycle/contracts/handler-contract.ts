import { z } from 'zod';

import {
  LifecycleContractVersionSchema,
  LifecycleHandlerModeSchema,
  LifecycleIdentifierSchema,
  LifecycleRuntimeKindSchema,
} from './common.js';
import { LifecycleBudgetContractSchema } from './budget-contract.js';
import { LifecycleFailurePolicyContractSchema } from './failure-policy-contract.js';

export const LifecycleHandlerIdentityContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    handlerId: LifecycleIdentifierSchema,
    runtimeKind: LifecycleRuntimeKindSchema,
    implementationRef: z.string().trim().min(1),
    implementationVersion: z.string().trim().min(1),
  })
  .strict();

export const LifecycleHandlerContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    id: LifecycleIdentifierSchema,
    displayName: z.string().trim().min(1).optional(),
    mode: LifecycleHandlerModeSchema,
    runtime: z
      .object({
        kind: LifecycleRuntimeKindSchema,
        ref: z.string().trim().min(1),
        implementationVersion: z.string().trim().min(1),
      })
      .strict(),
    budget: LifecycleBudgetContractSchema.optional(),
    failurePolicy: LifecycleFailurePolicyContractSchema.optional(),
  })
  .strict();

export type LifecycleHandlerIdentityContract = z.infer<typeof LifecycleHandlerIdentityContractSchema>;
export type LifecycleHandlerContract = z.infer<typeof LifecycleHandlerContractSchema>;
