/**
 * Builds the real tool provider of one script run from daemon state.
 *
 * A run gets only what its approved manifest names (`allServers` is for tool
 * listing only, which calls nothing): the host tools always, the
 * MCP servers whose tools the manifest lists, and `model.judge` if the manifest
 * lists it and the persona runs on an `openai-compatible` provider. A server
 * that the manifest does not name is never connected, so a run cannot start a
 * server process or refresh a login token that the user did not approve.
 */

import { err, ok, type Result } from 'neverthrow';
import type { Logger } from 'pino';
import type { OAuthTokenStore } from '../auth/oauth-token-store.js';
import type { TalondConfig } from '../core/config/config-types.js';
import { resolveMcpServers } from '../mcp/resolve-mcp-servers.js';
import type { PersonaLoader } from '../personas/persona-loader.js';
import { buildPersonaRuntimeContext } from '../personas/persona-runtime-context.js';
import type { LoadedPersona } from '../personas/persona-types.js';
import type { SerializableMcpServer } from '../providers/openai-compatible/agent-cli/mcp-tool-limits.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { SkillResolver } from '../skills/skill-resolver.js';
import { createCompositeProvider } from './providers/composite.js';
import { createHostToolProvider, type HostToolExecutor } from './providers/host-tools.js';
import {
  createJudgeProvider,
  createOpenAiCompatibleJudgeModel,
  type JudgeModel,
} from './providers/judge.js';
import { createMcpProvider } from './providers/mcp.js';
import {
  ScriptError,
  type AuthoredManifest,
  type RunContext,
  type RunProvider,
  type ProviderOptions,
  type ToolProvider,
  type ToolLister,
} from './types.js';

const HOST_PREFIX = 'talon.';
const MODEL_PREFIX = 'model.';
const JUDGE_NAME = 'model.judge';
const MCP_CONNECT_TIMEOUT_MS = 30_000;

export interface DaemonProviderDeps {
  hostTools: HostToolExecutor;
  personaLoader: Pick<PersonaLoader, 'getById'>;
  skillResolver: SkillResolver;
  /** Read at each run, so a reload of skills applies to the next run. */
  loadedSkills(): LoadedSkill[];
  /** Read at each run, so a reload of providers applies to the next run. */
  config(): Pick<TalondConfig, 'agentRunner' | 'auth' | 'scripts'>;
  tokenStore: OAuthTokenStore;
  logger: Logger;
  /** Test seams. */
  createMcp?: typeof createMcpProvider;
  createJudgeModel?: typeof createOpenAiCompatibleJudgeModel;
}

export type ProviderFactory = (
  context: RunContext,
  manifest: AuthoredManifest,
  options?: ProviderOptions,
) => Promise<Result<RunProvider, ScriptError>>;

/** Server names that the manifest reaches: the part of a tool name before the first dot. */
function manifestServers(tools: string[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.startsWith(HOST_PREFIX) || tool.startsWith(MODEL_PREFIX)) continue;
    const dot = tool.indexOf('.');
    if (dot > 0) names.add(tool.slice(0, dot));
  }
  return names;
}

function readString(options: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readHeaders(
  options: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const value = options?.headers;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The judge model of a persona, or `undefined` if its provider is not `openai-compatible`. */
function judgeModelFor(
  persona: LoadedPersona,
  config: Pick<TalondConfig, 'agentRunner' | 'auth'>,
  scriptName: string,
  createModel: typeof createOpenAiCompatibleJudgeModel,
): JudgeModel | undefined {
  const providerName = persona.config.provider ?? config.agentRunner.defaultProvider;
  const provider = Object.hasOwn(config.agentRunner.providers, providerName)
    ? config.agentRunner.providers[providerName]
    : undefined;
  if (!provider || !provider.enabled) return undefined;
  if ((provider.type ?? providerName) !== 'openai-compatible') return undefined;

  // Same credential lookup as the agent provider: the slot of `options.providerId`
  // first, then the `openai-compatible` slot.
  const authProviders = config.auth?.providers ?? {};
  const providerId = readString(provider.options, 'providerId');
  const creds =
    (providerId && Object.hasOwn(authProviders, providerId)
      ? authProviders[providerId]
      : undefined) ?? authProviders['openai-compatible'];

  const baseUrl = readString(provider.options, 'baseUrl') ?? creds?.baseURL;
  const modelId = persona.config.model ?? readString(provider.options, 'defaultModel');
  if (!baseUrl || !modelId) return undefined;

  const headers = readHeaders(provider.options);
  return createModel({
    baseUrl,
    modelId,
    ...(creds?.apiKey ? { apiKey: creds.apiKey } : {}),
    ...(headers ? { headers } : {}),
    telemetry: { scriptName },
  });
}

export function createDaemonProviderFactory(deps: DaemonProviderDeps): ProviderFactory {
  const createMcp = deps.createMcp ?? createMcpProvider;
  const createJudgeModel = deps.createJudgeModel ?? createOpenAiCompatibleJudgeModel;
  const failed = (detail: string, cause?: unknown): ScriptError =>
    new ScriptError('TOOL_FAILED', detail, cause instanceof Error ? cause : undefined);

  return async (context, manifest, options) => {
    const allServers = options?.allServers === true;
    try {
      const personaResult = deps.personaLoader.getById(context.personaId);
      const persona = personaResult.isOk() ? personaResult.value : undefined;
      if (!persona) return err(failed('the persona of the script is not loaded'));

      const config = deps.config();
      const host = createHostToolProvider(deps.hostTools, context, persona.resolvedCapabilities);

      let judge: (ToolProvider & ToolLister) | undefined;
      if (allServers || manifest.tools.includes(JUDGE_NAME)) {
        const model = judgeModelFor(persona, config, context.scriptName, createJudgeModel);
        if (model) {
          judge = createJudgeProvider({
            model,
            context,
            timeoutMs: config.scripts.judgeTimeoutMs,
          });
        }
      }

      let mcp: RunProvider | undefined;
      const wanted = manifestServers(manifest.tools);
      if (allServers || wanted.size > 0) {
        const skills = deps
          .loadedSkills()
          .filter((skill) => persona.config.skills.includes(skill.manifest.name));
        const runtime = buildPersonaRuntimeContext({
          loadedPersona: persona,
          resolvedSkills: skills,
          skillResolver: deps.skillResolver,
          logger: deps.logger,
        });
        const selected = Object.fromEntries(
          Object.entries(runtime.mcpServers).filter(
            ([name, server]) => (allServers || wanted.has(name)) && server.transport !== 'sdk',
          ),
        );
        if (Object.keys(selected).length > 0) {
          // Puts login tokens into the headers. Only the servers of the manifest get here.
          const resolved = await resolveMcpServers(selected, { tokenStore: deps.tokenStore });
          const servers: Record<string, SerializableMcpServer> = {};
          for (const [name, server] of Object.entries(resolved)) {
            if (server.transport !== 'sdk') servers[name] = server;
          }
          const created = await createMcp({
            servers,
            toolClasses: config.scripts.toolClasses,
            connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
            logger: deps.logger,
          });
          if (created.isErr()) return err(created.error);
          mcp = created.value;
        }
      }

      return ok(createCompositeProvider({ host, judge, mcp }));
    } catch (cause) {
      // The cause can name a server or a login problem. It travels in `cause` only.
      deps.logger.error(
        { errName: cause instanceof Error ? cause.name : 'unknown', personaId: context.personaId },
        'scripts: tool provider could not be built',
      );
      return err(failed('the tools of the script could not be prepared', cause));
    }
  };
}
