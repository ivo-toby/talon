/**
 * Run policy derived from `script.run` capability labels.
 *
 * Label grammar (same shape as `persona.send` in `persona-delegation.ts`):
 *   - `script.run:*` or `script.run`  any script
 *   - `script.run:<name>`             only the script called `<name>` (exact, case-sensitive)
 *
 * A matching label in `requireApproval` wins over `allow`.
 * Callers pass the capabilities of the trusted run context, never tool arguments.
 */

import type { ResolvedCapabilities } from '../personas/persona-types.js';

export const SCRIPT_RUN_CAPABILITY_PREFIX = 'script.run';

export type ScriptRunAccess = 'denied' | 'allowed' | 'approval';

/** Scope of a `script.run` label, or `null` when the label is for another capability. */
function scriptRunScope(label: string): string | null {
  const colonIndex = label.indexOf(':');
  const prefix = colonIndex === -1 ? label : label.slice(0, colonIndex);
  if (prefix !== SCRIPT_RUN_CAPABILITY_PREFIX) return null;
  return colonIndex === -1 ? '' : label.slice(colonIndex + 1).trim();
}

function matches(labels: readonly string[], scriptName: string): boolean {
  return labels.some((label) => {
    const scope = scriptRunScope(label);
    return scope !== null && (scope === '' || scope === '*' || scope === scriptName);
  });
}

/** How the capabilities let a persona run the named script live. */
export function scriptRunAccess(
  capabilities: ResolvedCapabilities,
  scriptName: string,
): ScriptRunAccess {
  if (matches(capabilities.requireApproval, scriptName)) return 'approval';
  if (matches(capabilities.allow, scriptName)) return 'allowed';
  return 'denied';
}
