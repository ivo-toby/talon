/**
 * Host-side tool: persona.list
 *
 * Returns discovery cards for all currently-loaded personas available for
 * delegation via persona_send — excluding the calling persona itself.
 *
 * Uses PersonaLoader (the live in-memory cache) rather than the raw DB so
 * that stale/unloaded personas are never advertised.
 */

import type pino from 'pino';
import type { PersonaLoader } from '../../personas/persona-loader.js';
import type { ToolCallResult, ToolManifest } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';

export interface PersonaListTool {
  readonly manifest: ToolManifest;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PersonaListArgs {}

export interface PersonaCard {
  name: string;
  skills: string[];
}

export class PersonaListHandler {
  static readonly manifest: ToolManifest = {
    name: 'persona.list',
    description: 'Lists available personas for delegation via persona_send.',
    capabilities: ['persona.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      personaLoader: PersonaLoader;
      logger: pino.Logger;
    },
  ) {}

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
    const cards: PersonaCard[] = this.deps.personaLoader.listNames()
      .filter((name) => name !== callerName)
      .map((name) => {
        const loadedResult = this.deps.personaLoader.getByName(name);
        const skills = loadedResult.isOk() && loadedResult.value
          ? loadedResult.value.config.skills
          : [];
        return { name, skills };
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
