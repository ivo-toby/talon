import { z } from 'zod';

import { LifecycleContractVersionSchema } from './common.js';

export const LifecycleInterceptorHookSchema = z.enum([
  'message.before_persist',
  'run.before_execute',
  'tool.before_execute',
  'message.before_send',
]);

export const LifecycleInterceptorContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    hook: LifecycleInterceptorHookSchema,
  })
  .strict();

export type LifecycleInterceptorContract = z.infer<typeof LifecycleInterceptorContractSchema>;
