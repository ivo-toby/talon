import type { LoadedPersona } from './persona-types.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { SkillResolver } from '../skills/skill-resolver.js';
import type { CanonicalMcpServer } from '../providers/provider-types.js';
import {
  TALON_SKILL_INDEX_GUIDANCE,
  TALON_SKILL_INDEX_HEADING,
  TALON_SKILL_INDEX_INTRO,
  normalizeSkillDescription,
} from '../skills/skill-runtime-text.js';

export interface PersonaRuntimeContext {
  personaPrompt: string;
  mcpServers: Record<string, CanonicalMcpServer>;
}

interface BuildPersonaRuntimeContextOptions {
  loadedPersona: LoadedPersona;
  resolvedSkills: LoadedSkill[];
  skillResolver: SkillResolver;
  skillLoadingMode?: 'lazy' | 'eager';
  excludeServerNames?: string[];
  logger?: {
    warn: (payload: Record<string, unknown>, message: string) => void;
  };
}

export function buildSkillIndex(resolvedSkills: LoadedSkill[]): string {
  if (resolvedSkills.length === 0) {
    return '';
  }

  const lines = resolvedSkills.map((skill) => {
    const description = normalizeSkillDescription(skill.manifest.description ?? '');
    return description.length > 0
      ? `- **${skill.manifest.name}**: ${description}`
      : `- **${skill.manifest.name}**`;
  });

  return [
    TALON_SKILL_INDEX_HEADING,
    TALON_SKILL_INDEX_INTRO,
    ...lines,
    '',
    TALON_SKILL_INDEX_GUIDANCE,
  ].join('\n');
}

function resolveEnvPlaceholder(value: string): string {
  const match = /^\$\{(\w+)\}$/.exec(value);
  return match ? (process.env[match[1] ?? ''] ?? '') : value;
}

function resolveHeaderPlaceholders(
  value: string,
  serverName: string,
  header: string,
  logger?: BuildPersonaRuntimeContextOptions['logger'],
): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      logger?.warn(
        { mcpServer: serverName, header, variable: varName },
        'agent-sdk: unresolved env var in MCP header — value will be empty',
      );
    }
    return envValue ?? '';
  });
}

export function buildPersonaRuntimeContext(
  options: BuildPersonaRuntimeContextOptions,
): PersonaRuntimeContext {
  const mode = options.skillLoadingMode ?? 'lazy';

  // In `eager` mode every skill is treated as eager (legacy behavior).
  // In `lazy` mode each skill's `manifest.eager` flag decides individually:
  // eager skills have their bodies merged into the system prompt up-front,
  // lazy skills only appear in the index and are loaded via `skill_load`.
  const eagerSkills = mode === 'eager'
    ? options.resolvedSkills
    : options.resolvedSkills.filter((s) => s.manifest.eager === true);
  const lazySkills = mode === 'eager'
    ? []
    : options.resolvedSkills.filter((s) => s.manifest.eager !== true);

  const eagerBodies = eagerSkills.length > 0
    ? options.skillResolver.mergePromptFragments(eagerSkills)
    : '';
  const skillIndex = lazySkills.length > 0 ? buildSkillIndex(lazySkills) : '';

  const personaPrompt = [
    options.loadedPersona.systemPromptContent ?? '',
    options.loadedPersona.personalityContent ?? '',
    eagerBodies,
    skillIndex,
  ]
    .filter(Boolean)
    .join('\n\n');

  const excluded = new Set(options.excludeServerNames ?? []);
  const mcpServers: Record<string, CanonicalMcpServer> = {};
  const serverDefs =
    typeof options.skillResolver.collectMcpServers === 'function'
      ? options.skillResolver.collectMcpServers(options.resolvedSkills)
      : options.resolvedSkills.flatMap((skill) => skill.resolvedMcpServers);

  for (const server of serverDefs) {
    if (server.name.startsWith('__talond_')) {
      throw new Error(
        `MCP server name "${server.name}" uses reserved prefix "__talond_". Skill-defined MCP servers must not use this prefix.`,
      );
    }

    if (excluded.has(server.name)) {
      continue;
    }

    const cfg = server.config;
    const resolvedEnv: Record<string, string> = {};
    if (cfg.env) {
      for (const [key, value] of Object.entries(cfg.env)) {
        resolvedEnv[key] = resolveEnvPlaceholder(value);
      }
    }

    const resolvedHeaders: Record<string, string> = {};
    if (cfg.headers && (cfg.transport === 'http' || cfg.transport === 'sse')) {
      for (const [key, value] of Object.entries(cfg.headers)) {
        resolvedHeaders[key] = resolveHeaderPlaceholders(
          value,
          server.name,
          key,
          options.logger,
        );
      }
    }

    if (cfg.transport === 'stdio') {
      if (!cfg.command) {
        options.logger?.warn(
          { mcpServer: server.name, transport: 'stdio' },
          'agent-sdk: skipping stdio MCP server without command',
        );
        continue;
      }

      mcpServers[server.name] = {
        transport: 'stdio',
        command: cfg.command,
        args: cfg.args ?? [],
        ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
      };
      continue;
    }

    if (!cfg.url) {
      options.logger?.warn(
        { mcpServer: server.name, transport: cfg.transport },
        'agent-sdk: skipping remote MCP server without URL',
      );
      continue;
    }

    mcpServers[server.name] = {
      transport: cfg.transport,
      url: cfg.url,
      ...(Object.keys(resolvedHeaders).length > 0 ? { headers: resolvedHeaders } : {}),
      // Forward dynamic auth verbatim. `resolveMcpServers()` runs in the
      // agent-runner and turns this into a materialized Bearer header
      // before the entry reaches a provider — domain `McpAuthConfig`
      // and canonical `McpAuthSpec` are structurally identical (same
      // discriminator + same `tokenStore` field) so a flat copy is safe.
      ...(cfg.auth ? { auth: cfg.auth } : {}),
    };
  }

  return { personaPrompt, mcpServers };
}
