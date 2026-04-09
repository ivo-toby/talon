/**
 * Capability merging and validation for persona + skill combinations.
 *
 * The merging logic follows these rules:
 *   1. Persona capabilities are the base/authority.
 *   2. Skill capabilities are intersected — a skill can only request labels
 *      that the persona also grants (persona is the gatekeeper).
 *   3. `requireApproval` overrides `allow` — if a label appears in both the
 *      persona's `allow` list and any `requireApproval` list, it is treated
 *      as requiring approval.
 *
 * Capability label format: `<domain>.<action>:<scope>` or `<domain>.<action>`
 * (the scope part is optional for validation purposes, matching the broader
 * codebase convention where `isValidCapabilityLabel` requires scope, but we
 * warn rather than reject here to stay non-blocking).
 */

import type { CapabilitiesConfig } from '../core/config/config-types.js';
import type { ResolvedCapabilities } from './persona-types.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Pattern for a well-formed capability label with a required scope segment:
 * `<word>.<word>:<word>`
 *
 * We also accept the no-scope form `<word>.<word>` but emit a warning for it
 * since the canonical format requires a scope.
 */
const CAPABILITY_WITH_SCOPE_RE = /^\w+\.\w+:(?:[A-Za-z0-9_-]+|\*)$/;
const CAPABILITY_WITHOUT_SCOPE_RE = /^\w+\.\w+$/;

/**
 * Validates a set of resolved capability labels and collects warnings about
 * malformed entries.
 *
 * Labels that match `<domain>.<action>:<scope>` are considered fully valid.
 * Labels that match `<domain>.<action>` are accepted with a warning (missing
 * scope is non-fatal). Everything else produces a warning.
 *
 * The function never throws; callers decide whether to act on warnings.
 *
 * @param capabilities - The resolved capability set to validate.
 * @returns Object with `valid` (false if any label is completely malformed)
 *          and `warnings` (human-readable strings for each issue).
 */
export function validateCapabilityLabels(capabilities: ResolvedCapabilities): {
  valid: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  let valid = true;

  const allLabels = [
    ...capabilities.allow.map((l) => ({ label: l, list: 'allow' })),
    ...capabilities.requireApproval.map((l) => ({ label: l, list: 'requireApproval' })),
  ];

  for (const { label, list } of allLabels) {
    if (CAPABILITY_WITH_SCOPE_RE.test(label)) {
      // Fully valid — no warning needed.
      continue;
    }

    if (CAPABILITY_WITHOUT_SCOPE_RE.test(label)) {
      warnings.push(
        `Capability label "${label}" in ${list} is missing scope segment (expected <domain>.<action>:<scope>)`,
      );
      // Missing scope is a warning but not a hard failure.
      continue;
    }

    warnings.push(
      `Capability label "${label}" in ${list} is malformed (expected <domain>.<action>:<scope>)`,
    );
    valid = false;
  }

  return { valid, warnings };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Merges persona-level capabilities with optional skill-level capability lists.
 *
 * Algorithm:
 *   1. Start with the persona's `allow` set.
 *   2. Collect all `requireApproval` labels from the persona and all skills.
 *   3. Intersect skill `allow` requirements against the persona `allow` set —
 *      a skill can only operate within what the persona permits.
 *   4. Any label that appears in `requireApproval` is removed from the final
 *      `allow` set (requireApproval wins on conflict).
 *
 * When no skill capabilities are provided the persona capabilities are
 * returned directly after the `requireApproval` override step.
 *
 * @param personaCapabilities  - The base capability policy from the persona config.
 * @param skillCapabilities    - Optional array of per-skill capability configs.
 * @returns Merged, deduplicated capability set.
 */
export function mergeCapabilities(
  personaCapabilities: CapabilitiesConfig,
  skillCapabilities?: CapabilitiesConfig[],
): ResolvedCapabilities {
  // Build working sets from the persona.
  const personaAllowSet = new Set(personaCapabilities.allow);
  const approvalSet = new Set(personaCapabilities.requireApproval);

  if (skillCapabilities && skillCapabilities.length > 0) {
    // Collect every label requested by skills across allow + requireApproval.
    const skillAllowRequested = new Set<string>();
    for (const skill of skillCapabilities) {
      for (const label of skill.allow) {
        skillAllowRequested.add(label);
      }
      // Skill-level requireApproval feeds into the global approval set.
      for (const label of skill.requireApproval) {
        approvalSet.add(label);
      }
    }

    // Intersect: only labels the persona also allows survive.
    const intersectedAllow = new Set<string>();
    for (const label of skillAllowRequested) {
      if (personaAllowSet.has(label)) {
        intersectedAllow.add(label);
      }
    }

    // requireApproval overrides allow: remove approval labels from the allow set.
    const finalAllow: string[] = [];
    for (const label of intersectedAllow) {
      if (!approvalSet.has(label)) {
        finalAllow.push(label);
      }
    }

    return {
      allow: finalAllow,
      requireApproval: [...approvalSet],
    };
  }

  // No skills — use persona capabilities directly, applying the override rule.
  const finalAllow: string[] = [];
  for (const label of personaAllowSet) {
    if (!approvalSet.has(label)) {
      finalAllow.push(label);
    }
  }

  return {
    allow: finalAllow,
    requireApproval: [...approvalSet],
  };
}
