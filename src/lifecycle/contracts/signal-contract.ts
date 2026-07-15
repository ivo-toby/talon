import { z } from 'zod';

import {
  LifecycleContractVersionSchema,
  LifecycleRuntimeIdSchema,
  LifecycleSignalTypeSchema,
} from './common.js';
import {
  LifecycleBoundedPayloadSchema,
  LifecycleExecutionContextSchema,
} from './event-contract.js';

export const LifecycleSignalContractSchema = z
  .object({
    version: LifecycleContractVersionSchema,
    type: LifecycleSignalTypeSchema,
  })
  .strict();

/** A handler-produced, causally linked proposal for a native projector. */
export const LifecycleSignalEnvelopeSchema = LifecycleSignalContractSchema.extend({
  signalId: LifecycleRuntimeIdSchema,
  occurredAt: z.string().max(64).datetime({ offset: true }),
  context: LifecycleExecutionContextSchema,
  payload: LifecycleBoundedPayloadSchema,
}).strict();

export type LifecycleSignalContract = z.infer<typeof LifecycleSignalContractSchema>;
export type LifecycleSignalEnvelope = z.infer<typeof LifecycleSignalEnvelopeSchema>;
