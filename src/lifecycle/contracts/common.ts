import { z } from 'zod';

export const LifecycleContractVersionSchema = z.literal('v1');

const MAX_LIFECYCLE_IDENTIFIER_LENGTH = 128;
const MAX_LIFECYCLE_RUNTIME_ID_LENGTH = 256;
export const MAX_LIFECYCLE_DURABLE_PERSONA_SCALARS = 256;
export const MAX_LIFECYCLE_DURABLE_PERSONA_UTF8_BYTES = 1_024;

/**
 * Bounds JavaScript UTF-16 code units and UTF-8 bytes without allowing Node
 * to replace malformed surrogate code units during encoding.
 */
export function isBoundedWellFormedUtf8(
  value: string,
  maxCodeUnits: number,
  maxBytes: number,
): boolean {
  if (value.length > maxCodeUnits) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let byteLength: number;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      byteLength = 4;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    } else if (codeUnit < 0x80) {
      byteLength = 1;
    } else if (codeUnit < 0x800) {
      byteLength = 2;
    } else {
      byteLength = 3;
    }
    bytes += byteLength;
    if (bytes > maxBytes) return false;
  }
  return true;
}

/** Bounds Unicode scalar values and UTF-8 bytes without changing the spelling. */
export function isBoundedUnicodeScalarsUtf8(
  value: string,
  maxScalars: number,
  maxBytes: number,
): boolean {
  let scalars = 0;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let byteLength: number;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      byteLength = 4;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    } else if (codeUnit < 0x80) {
      byteLength = 1;
    } else if (codeUnit < 0x800) {
      byteLength = 2;
    } else {
      byteLength = 3;
    }
    scalars += 1;
    bytes += byteLength;
    if (scalars > maxScalars || bytes > maxBytes) return false;
  }
  return true;
}

function isPersistableLifecycleText(
  value: string,
  maxCodeUnits: number,
  maxBytes: number,
): boolean {
  return value.indexOf('\0') === -1 && isBoundedWellFormedUtf8(value, maxCodeUnits, maxBytes);
}

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

/**
 * A persona becomes a durable delivery owner only when lifecycle resolution
 * is enabled. This intentionally remains separate from the legacy root
 * persona schema and general owner-name filter contract.
 */
export const LifecycleDurablePersonaOwnerNameSchema = LifecycleFilterOwnerNameSchema.refine(
  (value) =>
    value.indexOf('\0') === -1 &&
    isBoundedUnicodeScalarsUtf8(
      value,
      MAX_LIFECYCLE_DURABLE_PERSONA_SCALARS,
      MAX_LIFECYCLE_DURABLE_PERSONA_UTF8_BYTES,
    ),
  {
    message:
      'lifecycle delivery persona names must be at most 256 Unicode scalars and 1024 UTF-8 bytes without NUL characters',
  },
);

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
  .refine((value) => isPersistableLifecycleText(value, MAX_LIFECYCLE_RUNTIME_ID_LENGTH, 1_024), {
    message: 'lifecycle runtime identifiers must be well-formed Unicode without NUL characters',
  })
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
