import { z } from 'zod';

import { LifecycleContractVersionSchema, LifecycleIdentifierSchema, LifecyclePrioritySchema } from './common.js';
import { LifecycleBudgetContractSchema } from './budget-contract.js';
import { LifecycleEventContractSchema } from './event-contract.js';
import { LifecycleFailurePolicyContractSchema } from './failure-policy-contract.js';
import {
  LifecycleInterceptorContractSchema,
} from './interceptor-contract.js';
import { LifecycleFilterContractSchema } from './filter-contract.js';
import { LifecycleHandlerContractSchema } from './handler-contract.js';
import { LifecycleSignalContractSchema } from './signal-contract.js';

const LifecycleSubscriptionBaseSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    filter: LifecycleFilterContractSchema.optional(),
  })
  .strict();

export const LifecycleEventSubscriptionContractSchema = LifecycleSubscriptionBaseSchema.extend({
  kind: z.literal('event'),
  events: z.array(LifecycleEventContractSchema).min(1),
}).strict();

export const LifecycleSignalSubscriptionContractSchema = LifecycleSubscriptionBaseSchema.extend({
  kind: z.literal('signal'),
  signals: z.array(LifecycleSignalContractSchema).min(1),
}).strict();

export const LifecycleInterceptorSubscriptionContractSchema =
  LifecycleSubscriptionBaseSchema.extend({
    kind: z.literal('interceptor'),
    interceptors: z.array(LifecycleInterceptorContractSchema).min(1),
  }).strict();

export const LifecycleSubscriptionContractSchema = z.discriminatedUnion('kind', [
  LifecycleEventSubscriptionContractSchema,
  LifecycleSignalSubscriptionContractSchema,
  LifecycleInterceptorSubscriptionContractSchema,
]);

export const PersonaLifecycleSubscriptionSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    handler: LifecycleIdentifierSchema,
    priority: LifecyclePrioritySchema.default(0),
    subscription: LifecycleSubscriptionContractSchema,
    budget: LifecycleBudgetContractSchema.optional(),
    failurePolicy: LifecycleFailurePolicyContractSchema.optional(),
  })
  .strict();

export const PersonaLifecycleConfigSchema = z
  .object({
    subscriptions: z.array(PersonaLifecycleSubscriptionSchema).default([]),
  })
  .strict();

export const LifecycleConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    handlers: z.array(LifecycleHandlerContractSchema).default([]),
  })
  .strict();

export type LifecycleSubscriptionContract = z.infer<typeof LifecycleSubscriptionContractSchema>;
export type PersonaLifecycleSubscription = z.infer<typeof PersonaLifecycleSubscriptionSchema>;
export type PersonaLifecycleConfig = z.infer<typeof PersonaLifecycleConfigSchema>;
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;
