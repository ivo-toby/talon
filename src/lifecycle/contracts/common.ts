import { z } from 'zod';

export const LifecycleContractVersionSchema = z.literal('v1');

export const LifecycleIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);

export const LifecycleVersionedTypeNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+\.v[1-9][0-9]*$/);

export const LifecycleHandlerModeSchema = z.enum(['event', 'signal', 'interceptor']);
export const LifecycleRuntimeKindSchema = z.enum(['native', 'subagent']);

export const LifecyclePrioritySchema = z.number().int().min(-1000).max(1000);

export const LifecycleItemOriginSchema = z.enum([
  'channel',
  'queue',
  'run',
  'tool',
  'scheduler',
  'context',
]);

export const LifecycleItemTypeSchema = z.enum([
  'message',
  'run',
  'tool_call',
  'schedule',
  'context_projection',
]);

export const LifecycleMessageSourceSchema = z.enum(['inbound', 'outbound', 'direct']);
export const LifecycleScheduleSourceSchema = z.enum(['cron', 'interval', 'oneshot', 'manual']);

export type LifecycleItemOrigin = z.infer<typeof LifecycleItemOriginSchema>;
export type LifecycleItemType = z.infer<typeof LifecycleItemTypeSchema>;
export type LifecycleMessageSource = z.infer<typeof LifecycleMessageSourceSchema>;
export type LifecycleScheduleSource = z.infer<typeof LifecycleScheduleSourceSchema>;
