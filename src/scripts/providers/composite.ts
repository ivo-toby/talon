import { err, type Result } from 'neverthrow';
import { ScriptError } from '../types.js';
import type { RunProvider, ToolClass, ToolProvider } from '../types.js';

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
  host: ToolProvider;
  judge?: ToolProvider;
  mcp?: RunProvider;
}): RunProvider {
  let closed = false;
  let closing: Promise<void> | undefined;

  const route = (name: string): ToolProvider | undefined => {
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

  return {
    describe,

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
