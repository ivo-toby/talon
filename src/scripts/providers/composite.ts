import { err, type Result } from 'neverthrow';
import { ScriptError } from '../types.js';
import type { RunProvider, ScriptToolInfo, ToolClass, ToolLister, ToolProvider } from '../types.js';

type Part = ToolProvider & Partial<ToolLister>;

const HOST_PREFIX = 'talon.';
const MODEL_PREFIX = 'model.';
const JUDGE_NAME = 'model.judge';

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('non-error value thrown');
}

/**
 * Routes a script tool name to one provider. Names come from untrusted code,
 * so routing is by exact prefix and name:
 * `talon.*` -> host, `model.judge` -> judge, other `model.*` -> nobody,
 * everything else -> mcp.
 */
export function createCompositeProvider(parts: {
  host: Part;
  judge?: Part;
  mcp?: RunProvider;
}): RunProvider {
  let closed = false;
  let closing: Promise<void> | undefined;

  const route = (name: string): Part | undefined => {
    if (name.startsWith(HOST_PREFIX)) return parts.host;
    if (name === JUDGE_NAME) return parts.judge;
    if (name.startsWith(MODEL_PREFIX)) return undefined;
    return parts.mcp;
  };

  const describe = (name: string): { toolClass: ToolClass } | undefined => {
    if (closed) return undefined;
    try {
      return route(name)?.describe(name);
    } catch {
      return undefined;
    }
  };

  const list = (): ScriptToolInfo[] => {
    if (closed) return [];
    const out: ScriptToolInfo[] = [];
    for (const part of [parts.host, parts.judge, parts.mcp]) {
      try {
        out.push(...(part?.list?.() ?? []));
      } catch {
        // a part that cannot list offers nothing
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  const inputSchema = (name: string): unknown => {
    if (closed) return undefined;
    try {
      return route(name)?.inputSchema?.(name);
    } catch {
      return undefined;
    }
  };

  return {
    describe,
    list,
    inputSchema,

    async call(
      name: string,
      input: unknown,
      signal: AbortSignal,
    ): Promise<Result<unknown, ScriptError>> {
      if (closed) return err(new ScriptError('TOOL_FAILED', 'tool provider is closed'));
      const part = route(name);
      if (part === undefined || describe(name) === undefined) {
        return err(new ScriptError('UNKNOWN_TOOL', 'tool is not available'));
      }
      try {
        return await part.call(name, input, signal);
      } catch (e) {
        return err(new ScriptError('TOOL_FAILED', 'tool provider failed', toError(e)));
      }
    },

    close(): Promise<void> {
      closed = true;
      closing ??= (async (): Promise<void> => {
        try {
          await parts.mcp?.close();
        } catch {
          // close never rejects
        }
      })();
      return closing;
    },
  };
}
