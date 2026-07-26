import { z } from 'zod';

import {
  LifecycleContractVersionSchema,
  LifecycleIdentifierSchema,
  LifecyclePrioritySchema,
} from './common.js';
import { LifecycleBudgetContractSchema } from './budget-contract.js';
import { LifecycleEventContractSchema } from './event-contract.js';
import { LifecycleFailurePolicyContractSchema } from './failure-policy-contract.js';
import { LifecycleInterceptorContractSchema } from './interceptor-contract.js';
import { LifecycleFilterContractSchema } from './filter-contract.js';
import { LifecycleHandlerContractSchema } from './handler-contract.js';
import { LifecycleSignalContractSchema } from './signal-contract.js';

const MAX_LIFECYCLE_ATTACHMENTS = 32;

const LifecycleSubscriptionBaseSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    filter: LifecycleFilterContractSchema.optional(),
  })
  .strict();

export const LifecycleEventSubscriptionContractSchema = LifecycleSubscriptionBaseSchema.extend({
  kind: z.literal('event'),
  events: z.array(LifecycleEventContractSchema).min(1).max(MAX_LIFECYCLE_ATTACHMENTS),
}).strict();

export const LifecycleSignalSubscriptionContractSchema = LifecycleSubscriptionBaseSchema.extend({
  kind: z.literal('signal'),
  signals: z.array(LifecycleSignalContractSchema).min(1).max(MAX_LIFECYCLE_ATTACHMENTS),
}).strict();

export const LifecycleInterceptorSubscriptionContractSchema =
  LifecycleSubscriptionBaseSchema.extend({
    kind: z.literal('interceptor'),
    interceptors: z.array(LifecycleInterceptorContractSchema).min(1).max(MAX_LIFECYCLE_ATTACHMENTS),
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
    subscriptions: z
      .array(PersonaLifecycleSubscriptionSchema)
      .max(MAX_LIFECYCLE_ATTACHMENTS)
      .default([]),
  })
  .strict();

export const LifecycleRetentionConfigSchema = z
  .object({
    completedAuditWindowMs: z
      .number()
      .int()
      .min(0)
      .default(30 * 24 * 60 * 60 * 1000),
  })
  .strict();

export const LifecycleConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    handlers: z.array(LifecycleHandlerContractSchema).max(MAX_LIFECYCLE_ATTACHMENTS).default([]),
    retention: LifecycleRetentionConfigSchema.default(() =>
      LifecycleRetentionConfigSchema.parse({}),
    ),
  })
  .strict();

export type LifecycleSubscriptionContract = z.infer<typeof LifecycleSubscriptionContractSchema>;
export type PersonaLifecycleSubscription = z.infer<typeof PersonaLifecycleSubscriptionSchema>;
export type PersonaLifecycleConfig = z.infer<typeof PersonaLifecycleConfigSchema>;
export type LifecycleRetentionConfig = z.infer<typeof LifecycleRetentionConfigSchema>;
export type LifecycleConfig = z.infer<typeof LifecycleConfigSchema>;
