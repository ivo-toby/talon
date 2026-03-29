/**
 * Host-side tool: persona.list
 *
 * Returns discovery cards for all personas available for delegation via
 * persona_send — excluding the calling persona itself.
 */

import { readFileSync } from 'node:fs';
import type pino from 'pino';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
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
    description: 'Lists available personas for delegation via persona_send.',
    capabilities: ['persona.send:*'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      personaRepo: PersonaRepository;
      logger: pino.Logger;
    },
  ) {}

  async execute(_args: PersonaListArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    this.deps.logger.info(
      { requestId, runId: context.runId, personaId: context.personaId },
      'persona.list: executing',
    );

    const allResult = this.deps.personaRepo.findAll();
    if (allResult.isErr()) {
      const msg = `persona.list: failed to load personas — ${allResult.error.message}`;
      this.deps.logger.error({ requestId, err: allResult.error }, msg);
      return { requestId, tool: 'persona.list', status: 'error', error: msg };
    }

    const cards: PersonaCard[] = allResult.value
      .filter((row) => row.id !== context.personaId)
      .map((row) => ({
        name: row.name,
        description: this.extractDescription(row.system_prompt_file),
        skills: this.parseSkills(row.skills),
      }));

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

  private extractDescription(filePath: string | null): string | null {
    if (!filePath) return null;
    try {
      const content = readFileSync(filePath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.replace(/^#+\s*/, '').trim();
        if (trimmed) return trimmed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private parseSkills(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }
}
