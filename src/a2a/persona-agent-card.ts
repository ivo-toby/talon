/**
 * PersonaAgentCard — maps loaded Talon personas to A2A Agent Cards.
 *
 * Each persona in talond.yaml becomes an A2A-discoverable agent with a
 * standardized card describing its capabilities, skills, and internal
 * endpoint URL. Cards are computed at startup and cached for fast lookups.
 */

import type { LoadedPersona } from '../personas/persona-types.js';
import type { A2AAgentCard } from './a2a-types.js';

// ---------------------------------------------------------------------------
// Package version (used as agent card version)
// ---------------------------------------------------------------------------

const AGENT_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts a loaded persona into an A2A Agent Card.
 *
 * The card is a Talon-local representation — internal-only in Milestone 1.
 * It captures the persona's name, skills, capabilities, and model so that
 * other personas can discover and invoke it via the A2A server.
 *
 * @param persona - The runtime persona to map.
 * @returns A fully-populated A2AAgentCard.
 */
export function buildAgentCard(persona: LoadedPersona): A2AAgentCard {
  const { config, description } = persona;

  return {
    id: config.name,
    name: config.name,
    description: description ?? `Talon persona: ${config.name}`,
    url: `/a2a/agents/${config.name}`,
    version: AGENT_VERSION,
    skills: config.skills.map((skill) => ({
      id: skill,
      name: skill,
    })),
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    metadata: {
      personaName: config.name,
      model: config.model,
      ...(config.systemPromptFile !== undefined
        ? { systemPromptFile: config.systemPromptFile }
        : {}),
      skills: config.skills,
      capabilities: {
        allow: config.capabilities.allow,
        requireApproval: config.capabilities.requireApproval,
      },
      internalOnly: true,
    },
  };
}

/**
 * Builds an agent card registry from a list of loaded personas.
 *
 * Returns a Map keyed by persona name for O(1) lookups. The registry
 * should be rebuilt whenever personas are reloaded.
 *
 * @param personas - All currently loaded personas.
 * @returns Map<personaName, A2AAgentCard>.
 */
export function buildAgentCardRegistry(personas: LoadedPersona[]): Map<string, A2AAgentCard> {
  const registry = new Map<string, A2AAgentCard>();
  for (const persona of personas) {
    registry.set(persona.config.name, buildAgentCard(persona));
  }
  return registry;
}
