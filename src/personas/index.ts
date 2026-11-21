/**
 * Persona management.
 *
 * A persona is the unit of configuration for an AI agent: system prompt,
 * channel bindings, capability policy, memory scope, skill set, and model
 * parameters. One persona per channel is the default; sharing is opt-in.
 */

export type { LoadedPersona, ResolvedCapabilities, PersonaConfig, CapabilitiesConfig } from './persona-types.js';
export { PersonaLoader } from './persona-loader.js';
export { mergeCapabilities, validateCapabilityLabels } from './capability-merger.js';
export {
  allowedDelegationTargets,
  canDelegateTo,
  filterDelegationTargets,
  describeDelegationTargets,
  unknownDelegationTargets,
} from './persona-delegation.js';
export type { DelegationTargets } from './persona-delegation.js';
