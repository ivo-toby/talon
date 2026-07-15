import { z } from 'zod';

export const LifecycleContractVersionSchema = z.literal('v1');

const MAX_LIFECYCLE_IDENTIFIER_LENGTH = 128;
const MAX_LIFECYCLE_RUNTIME_ID_LENGTH = 256;

/**
 * Lifecycle identifiers are persisted and used as map keys.  They must already
 * be canonical: accepting a value only after trimming would make `foo` and
 * ` foo ` indistinguishable at different boundaries.
 */
export const LifecycleIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_LIFECYCLE_IDENTIFIER_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);

/**
 * Names owned by another Talon subsystem (personas, channels, providers,
 * tools, and loaded subagents).  Unlike lifecycle IDs, these are opaque: the
 * lifecycle boundary must preserve the owning subsystem's valid spelling.
 */
export const LifecycleRuntimeNameSchema = z
  .string()
  .min(1)
  .max(MAX_LIFECYCLE_IDENTIFIER_LENGTH)
  .refine((value) => value === value.trim(), {
    message: 'lifecycle runtime names must not have leading or trailing whitespace',
  })
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint >= 0x20 && (codePoint < 0x7f || codePoint > 0x9f);
      }),
    {
      message: 'lifecycle runtime names must not contain control characters',
    },
  );

/**
 * Persona and channel names are owned by the root configuration schemas,
 * which deliberately accept every non-empty string. Filters compare those
 * names exactly, so they must not impose lifecycle runtime canonicalization.
 */
export const LifecycleFilterOwnerNameSchema = z.string().min(1);

export const LifecycleVersionedTypeNameSchema = z
  .string()
  .min(1)
  .max(MAX_LIFECYCLE_IDENTIFIER_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+\.v[1-9][0-9]*$/);

/** Opaque, stable identifiers supplied by the owning Talon boundary. */
export const LifecycleRuntimeIdSchema = z
  .string()
  .min(1)
  .max(MAX_LIFECYCLE_RUNTIME_ID_LENGTH)
  .refine((value) => value === value.trim(), {
    message: 'lifecycle runtime identifiers must not have leading or trailing whitespace',
  });

export const LifecycleDisplayNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), {
    message: 'lifecycle display names must not have leading or trailing whitespace',
  });

/**
 * The first shipped catalog.  New event names are a contract change, not a
 * configuration-only extension: persistence and dispatch depend on knowing
 * their retention, scope, and ordering semantics.
 */
export const LifecycleEventTypeSchema = z.enum([
  'message.persisted.v1',
  'message.routed.v1',
  'queue.item.enqueued.v1',
  'queue.item.completed.v1',
  'queue.item.failed.v1',
  'queue.item.dead_lettered.v1',
  'run.started.v1',
  'provider.tool.started.v1',
  'provider.tool.completed.v1',
  'run.completed.v1',
  'run.failed.v1',
  'message.sent.v1',
  'message.send_failed.v1',
  'context.threshold_exceeded.v1',
  'context.rotated.v1',
  'context.observation_log_threshold_exceeded.v1',
  'schedule.fired.v1',
]);

/** Signals are bounded proposals/observations, never direct state mutations. */
export const LifecycleSignalTypeSchema = z.enum([
  'context.rotate.requested.v1',
  'context.observation.proposed.v1',
  'context.reduction.proposed.v1',
  'behavior.feedback.detected.v1',
  'behavior.candidate.proposed.v1',
]);

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
export type LifecycleEventType = z.infer<typeof LifecycleEventTypeSchema>;
export type LifecycleSignalType = z.infer<typeof LifecycleSignalTypeSchema>;
