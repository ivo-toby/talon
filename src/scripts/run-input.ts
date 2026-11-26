import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';
import { isSafeSchema } from './providers/judge.js';
import { ScriptError, type AuthoredManifest } from './types.js';

/** The JSON text of an input schema in a manifest is at most this long. */
export const MAX_INPUT_SCHEMA_CHARS = 4_000;
/** The JSON text of a run input is at most this long. */
const MAX_INPUT_CHARS = 8_000;

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Builds the zod check of a script-supplied input schema, or `undefined` if the
 * schema is too long, fails the safety walk of `model.judge` or cannot be built.
 */
export function compileInputSchema(schema: unknown): z.ZodType | undefined {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
  if (jsonLength(schema) > MAX_INPUT_SCHEMA_CHARS || !isSafeSchema(schema)) return undefined;
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return undefined;
  }
}

/** True if the value matches the compiled schema. Never throws. */
export function matchesInputSchema(check: z.ZodType, value: unknown): boolean {
  try {
    return check.safeParse(value).success;
  } catch {
    return false;
  }
}

/**
 * The input of a live run. `undefined` means that the caller gave none: the
 * `liveInput` of the manifest (or null) is used. A given input needs a declared
 * schema and must match it.
 */
export function resolveRunInput(
  manifest: AuthoredManifest,
  input?: unknown,
): Result<unknown, ScriptError> {
  if (input === undefined) return ok(manifest.liveInput ?? null);
  if (manifest.inputSchema === undefined) {
    return err(new ScriptError('INVALID_ARGUMENT', 'this script accepts no input'));
  }
  const mismatch = (): ScriptError =>
    new ScriptError('INVALID_ARGUMENT', 'the input does not match the input schema of the script');
  const check = compileInputSchema(manifest.inputSchema);
  if (check === undefined || jsonLength(input) > MAX_INPUT_CHARS) return err(mismatch());
  return matchesInputSchema(check, input) ? ok(input) : err(mismatch());
}
