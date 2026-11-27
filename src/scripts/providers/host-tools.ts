import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';
import type { HostToolsBridge } from '../../tools/host-tools-bridge.js';
import { ScriptError } from '../types.js';
import { isToolAllowed } from '../../tools/tool-filter.js';
import type { ResolvedCapabilities } from '../../personas/persona-types.js';
import type { RunContext, ScriptToolInfo, ToolClass, ToolLister, ToolProvider } from '../types.js';

export interface HostToolExecutor {
  executeInProcess: HostToolsBridge['executeInProcess'];
}

const key = z.string().min(1).max(256);
const namespace = z.string().min(1).max(128).optional();

interface ToolSpec {
  toolClass: ToolClass;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  /** Internal bridge tool name. */
  bridgeTool: string;
  /** Bridge arguments from the validated input. */
  toArgs(input: Record<string, unknown>): Record<string, unknown>;
}

function strict<T extends z.ZodRawShape>(shape: T): z.ZodType<Record<string, unknown>> {
  return z.object(shape).strict();
}

const SPECS: Record<string, ToolSpec> = {
  'talon.memory_read': {
    description: 'Reads one memory item of the thread by key.',
    toolClass: 'read',
    schema: strict({ key, namespace }),
    bridgeTool: 'memory.access',
    toArgs: (i) => ({ operation: 'read', key: i.key, namespace: i.namespace }),
  },
  'talon.memory_list': {
    description: 'Lists the memory items of the thread.',
    toolClass: 'read',
    schema: strict({ namespace }),
    bridgeTool: 'memory.access',
    toArgs: (i) => ({ operation: 'list', namespace: i.namespace }),
  },
  'talon.memory_write': {
    description: 'Writes one memory item of the thread.',
    toolClass: 'write',
    schema: z
      .object({ key, value: z.unknown(), namespace })
      .strict()
      .refine((v) => 'value' in v, { message: 'value is required' }),
    bridgeTool: 'memory.access',
    toArgs: (i) => ({ operation: 'write', key: i.key, value: i.value, namespace: i.namespace }),
  },
  'talon.memory_delete': {
    description: 'Deletes one memory item of the thread.',
    toolClass: 'write',
    schema: strict({ key, namespace }),
    bridgeTool: 'memory.access',
    toArgs: (i) => ({ operation: 'delete', key: i.key, namespace: i.namespace }),
  },
  'talon.channel_list': {
    description: 'Lists the channels and chats that the persona can send to.',
    toolClass: 'read',
    schema: strict({}),
    bridgeTool: 'channel.list',
    toArgs: () => ({}),
  },
  'talon.channel_send': {
    description: 'Sends a text to a channel that the manifest lists.',
    toolClass: 'write',
    schema: strict({
      channelId: z.string().min(1).max(200),
      content: z.string().min(1).max(4000),
      externalChatId: z.string().min(1).max(200).optional(),
    }),
    bridgeTool: 'channel.send',
    toArgs: (i) => ({
      channelId: i.channelId,
      content: i.content,
      externalChatId: i.externalChatId,
    }),
  },
};

function withoutUndefined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

/**
 * A call is allowed when the capabilities grant the bridge tool and no
 * `requireApproval` label does: the bridge refuses approval-gated tools for
 * in-process callers.
 */
function callable(bridgeTool: string, capabilities: ResolvedCapabilities): boolean {
  return (
    isToolAllowed(bridgeTool, capabilities) &&
    !isToolAllowed(bridgeTool, { allow: [], requireApproval: capabilities.requireApproval })
  );
}

/**
 * Host tools of the Talon bridge, as the script calls them: `talon.memory_*`, `talon.channel_*`.
 * With `capabilities`, `list` offers only the tools that a call would be allowed to use;
 * without them it offers all six.
 */
export function createHostToolProvider(
  executor: HostToolExecutor,
  context: RunContext,
  capabilities?: ResolvedCapabilities,
): ToolProvider & ToolLister {
  const failed = (): ScriptError => new ScriptError('TOOL_FAILED', 'host tool call failed');
  return {
    describe(name): { toolClass: ToolClass } | undefined {
      const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : undefined;
      return spec ? { toolClass: spec.toolClass } : undefined;
    },
    list(): ScriptToolInfo[] {
      return Object.entries(SPECS)
        .filter(([, spec]) => capabilities === undefined || callable(spec.bridgeTool, capabilities))
        .map(([name, spec]) => ({
          name,
          toolClass: spec.toolClass,
          description: spec.description,
        }));
    },
    inputSchema(name): unknown {
      const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : undefined;
      if (!spec) return undefined;
      try {
        return z.toJSONSchema(spec.schema);
      } catch {
        return undefined;
      }
    },
    async call(name, input, signal): Promise<Result<unknown, ScriptError>> {
      const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : undefined;
      if (!spec) return err(new ScriptError('UNKNOWN_TOOL', 'tool is not available'));
      const parsed = spec.schema.safeParse(input);
      if (!parsed.success) {
        return err(new ScriptError('INVALID_ARGUMENT', 'tool input does not match the schema'));
      }
      const data = parsed.data;
      if (name === 'talon.channel_send' && !context.channels.includes(data.channelId as string)) {
        return err(new ScriptError('NOT_IN_MANIFEST', 'channel is not in the manifest'));
      }
      if (signal.aborted) return err(failed());

      let onAbort: (() => void) | undefined;
      const aborted = new Promise<'aborted'>((resolve) => {
        onAbort = (): void => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const call = executor
          .executeInProcess(spec.bridgeTool, withoutUndefined(spec.toArgs(data)), {
            runId: context.scriptRunId,
            threadId: context.threadId,
            personaId: context.personaId,
            requestId: randomUUID(),
          })
          .then(
            (r) => r,
            () => null,
          );
        const outcome = await Promise.race([call, aborted]);
        if (outcome === 'aborted' || outcome === null) return err(failed());
        if (outcome.status === 'success') return ok(outcome.result);
        if (outcome.denied === true) {
          return err(new ScriptError('UNKNOWN_TOOL', 'tool is not available'));
        }
        return err(failed());
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
