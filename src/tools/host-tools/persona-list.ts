/**
 * Host-side tool: persona.list
 *
 * Returns discovery cards for the currently-loaded personas the caller may
 * delegate to via persona_send (per its `persona.send` scopes) — excluding the
 * calling persona itself.
 *
 * Uses PersonaLoader (the live in-memory cache) rather than the raw DB so
 * that stale/unloaded personas are never advertised.
 */

import type pino from 'pino';
import { getPersonaDescription } from '../../personas/persona-description.js';
import { filterDelegationTargets } from '../../personas/persona-delegation.js';
import type { PersonaLoader } from '../../personas/persona-loader.js';
import type { ResolvedCapabilities } from '../../personas/persona-types.js';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';

export interface PersonaListTool {
  readonly manifest: ToolManifest;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PersonaListArgs {}

export interface PersonaCard {
  name: string;
  description: string | null;
  skills: string[];
}

export class PersonaListHandler {
  static readonly manifest: ToolManifest = {
    name: 'persona.list',
    description:
      'Lists the personas you can delegate to via persona_send: name, description and skills of each.',
    capabilities: ['persona.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      personaLoader: PersonaLoader;
      /** Resolves the CALLING persona's capabilities on the host (fail-closed). */
      resolveCapabilities: (personaId: string) => ResolvedCapabilities;
      logger: pino.Logger;
    },
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- handler interface is async; this one is synchronous
  async execute(_args: PersonaListArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    this.deps.logger.info(
      { requestId, runId: context.runId, personaId: context.personaId },
      'persona.list: executing',
    );

    // Resolve the calling persona's name so we can exclude it from the list.
    const callerResult = this.deps.personaLoader.getById(context.personaId);
    const callerName = callerResult.isOk() && callerResult.value
      ? callerResult.value.config.name
      : null;

    // List only live (loaded) personas — stale DB rows are excluded.
    // Only personas the caller may actually delegate to (persona.send scopes).
    const delegable = filterDelegationTargets(
      this.deps.resolveCapabilities(context.personaId),
      this.deps.personaLoader.listNames(),
    );
    const cards: PersonaCard[] = delegable
      .filter((name) => name !== callerName)
      .map((name) => {
        const loadedResult = this.deps.personaLoader.getByName(name);
        const loaded = loadedResult.isOk() && loadedResult.value ? loadedResult.value : null;
        const skills = loaded ? loaded.config.skills : [];
        const description = getPersonaDescription(loaded);
        return { name, description, skills };
      });

    this.deps.logger.info(
      { requestId, count: cards.length },
      'persona.list: returning persona cards',
    );

    return {
      requestId,
      tool: 'persona.list',
      status: 'success',
      result: cards,
    };
  }
}
