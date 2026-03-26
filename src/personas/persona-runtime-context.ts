import type { LoadedPersona } from './persona-types.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { SkillResolver } from '../skills/skill-resolver.js';
import type { CanonicalMcpServer } from '../providers/provider-types.js';

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

  const lines = resolvedSkills.map(
    (skill) => `- **${skill.manifest.name}**: ${skill.manifest.description}`,
  );

  return [
    '## Available Skills',
    ...lines,
    '',
    'To use a skill, call the `skill_load` tool with the skill name. The tool returns the full instructions for that skill.',
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
  const skillPrompt =
    mode === 'eager'
      ? options.skillResolver.mergePromptFragments(options.resolvedSkills)
      : buildSkillIndex(options.resolvedSkills);
  const personaPrompt = [
    options.loadedPersona.systemPromptContent ?? '',
    options.loadedPersona.personalityContent ?? '',
    skillPrompt,
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
    };
  }

  return { personaPrompt, mcpServers };
}
