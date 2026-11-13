/**
 * Delegation-target policy derived from `persona.send` capability labels.
 *
 * Label grammar (same `<domain>.<action>[:<scope>]` shape as every other
 * capability; see `tool-filter.ts`):
 *
 *   - `persona.send:*`        any persona may be a delegation target
 *   - `persona.send`          unscoped: same as `*` (tool-level grant only,
 *                             matching how an unscoped label behaves for every
 *                             other tool such as `channel.send`)
 *   - `persona.send:<name>`   only the persona called `<name>`; several scoped
 *                             labels accumulate
 *
 * Both `allow` and `requireApproval` count as grants, exactly like
 * `isToolAllowed` in `tool-filter.ts`. A wildcard anywhere wins over scoped
 * labels. With no `persona.send` label at all the result is an empty set
 * (fail closed), although the tools are not exposed in that case anyway.
 *
 * Callers must pass the CALLING persona's capabilities, resolved on the host
 * from the trusted run context, never anything derived from tool arguments.
 */

import type { ResolvedCapabilities } from './persona-types.js';

/** Capability prefix shared by persona_send, persona_list and the task tools. */
export const PERSONA_SEND_CAPABILITY_PREFIX = 'persona.send';

/** Either unrestricted, or the exact set of persona names that may be targeted. */
export type DelegationTargets = 'all' | ReadonlySet<string>;

/** Scope of a `persona.send` label, or `null` when the label is for another capability. */
function personaSendScope(label: string): string | null {
  const colonIndex = label.indexOf(':');
  const prefix = colonIndex === -1 ? label : label.slice(0, colonIndex);
  if (prefix !== PERSONA_SEND_CAPABILITY_PREFIX) return null;
  return colonIndex === -1 ? '' : label.slice(colonIndex + 1).trim();
}

/** Computes which personas the capabilities allow delegating to. */
export function allowedDelegationTargets(capabilities: ResolvedCapabilities): DelegationTargets {
  const names = new Set<string>();
  for (const label of [...capabilities.allow, ...capabilities.requireApproval]) {
    const scope = personaSendScope(label);
    if (scope === null) continue;
    if (scope === '' || scope === '*') return 'all';
    names.add(scope);
  }
  return names;
}

/** True when the capabilities allow delegating to `target` (exact, case-sensitive name match). */
export function canDelegateTo(capabilities: ResolvedCapabilities, target: string): boolean {
  const allowed = allowedDelegationTargets(capabilities);
  return allowed === 'all' || allowed.has(target);
}

/** Restricts a list of persona names to the delegation targets the capabilities allow. */
export function filterDelegationTargets(
  capabilities: ResolvedCapabilities,
  names: readonly string[],
): string[] {
  const allowed = allowedDelegationTargets(capabilities);
  return allowed === 'all' ? [...names] : names.filter((name) => allowed.has(name));
}

/** Human-readable allowed-target list for error messages (sorted, or "any persona"). */
export function describeDelegationTargets(allowed: DelegationTargets): string {
  if (allowed === 'all') return 'any persona';
  return allowed.size === 0 ? 'none' : [...allowed].sort().join(', ');
}

/**
 * Scoped `persona.send:<name>` targets that do not name a known persona.
 * Used for config-load warnings; `*` and unscoped labels are never reported.
 */
export function unknownDelegationTargets(
  capabilities: ResolvedCapabilities,
  knownPersonaNames: ReadonlySet<string>,
): string[] {
  const unknown = new Set<string>();
  for (const label of [...capabilities.allow, ...capabilities.requireApproval]) {
    const scope = personaSendScope(label);
    if (scope === null || scope === '' || scope === '*') continue;
    if (!knownPersonaNames.has(scope)) unknown.add(scope);
  }
  return [...unknown].sort();
}
