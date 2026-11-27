/**
 * Host-side tool: script.manage
 *
 * The way an agent writes, tests and sends a script for approval. A thin layer
 * on the ScriptService. The persona and the thread come from the trusted
 * execution context, never from the arguments. Gated by `script.manage:own`.
 */

import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import type { ScriptService } from '../../scripts/service.js';
import type { ScriptFile } from '../../scripts/store.js';
import { ScriptError } from '../../scripts/types.js';

/** Arguments accepted by the script.manage tool. */
export interface ScriptManageArgs {
  action: 'guide' | 'tools' | 'save' | 'test' | 'request_approval' | 'list' | 'show';
  /** `tools` (tool name) and `show` (script name). */
  name?: string;
  /** `save`. */
  files?: { path: string; content: string }[];
  /** `test` and `request_approval`. */
  versionId?: string;
  /** `show`. */
  version?: number;
}

export interface ScriptManageTool {
  readonly manifest: ToolManifest;
}

/** A result that holds script or dry-run data is cut to this many characters. */
const MAX_RESULT_CHARS = 8000;
const CUT_MARKER = '\n[cut]';
const MAX_FILES = 20;
const MAX_ID_CHARS = 100;

const ACTIONS = new Set(['guide', 'tools', 'save', 'test', 'request_approval', 'list', 'show']);

class ArgumentError extends Error {}

function boundedString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_CHARS) {
    throw new ArgumentError(message);
  }
  return value;
}

function parseFiles(value: unknown): ScriptFile[] {
  const message = `files must be a list of at most ${MAX_FILES} { path, content }`;
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new ArgumentError(message);
  return value.map((entry: unknown): ScriptFile => {
    if (typeof entry !== 'object' || entry === null) throw new ArgumentError(message);
    const { path, content } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || typeof content !== 'string') throw new ArgumentError(message);
    return { path, content };
  });
}

export class ScriptManageHandler {
  static readonly manifest: ToolManifest = {
    name: 'script.manage',
    description:
      'Writes, tests and sends scripts for approval. Call action "guide" before writing a script. Gated by script.manage:own.',
    capabilities: ['script.manage:own'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      /** The current script service, or null when scripts are off. */
      getService: () => ScriptService | null;
      /** The text of the authoring guide, or undefined when it did not load. */
      getGuide: () => string | undefined;
      logger: pino.Logger;
    },
  ) {}

  async execute(args: ScriptManageArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';
    const fail = (message: string, result?: unknown): ToolCallResult => ({
      requestId,
      tool: 'script.manage',
      status: 'error',
      error: message,
      ...(result !== undefined ? { result } : {}),
    });
    const action = (args as { action?: unknown } | undefined)?.action;
    this.deps.logger.info(
      { requestId, runId: context.runId, personaId: context.personaId, action },
      'script.manage: executing',
    );
    if (typeof action !== 'string' || !ACTIONS.has(action)) {
      return fail(
        'script.manage: invalid action. Must be one of: guide, tools, save, test, request_approval, list, show',
      );
    }

    if (action === 'guide') {
      const guide = this.deps.getGuide();
      if (guide === undefined) return fail('the script guide is not available');
      return { requestId, tool: 'script.manage', status: 'success', result: guide };
    }

    const service = this.deps.getService();
    if (service === null) return fail('scripts are off');

    try {
      const outcome = await this.dispatch(service, args, context);
      if (outcome.error !== undefined) {
        return fail(outcome.error.message, {
          scriptCode: outcome.error.scriptCode,
          message: outcome.error.message,
        });
      }
      return {
        requestId,
        tool: 'script.manage',
        status: 'success',
        result: cutResult(outcome.value),
      };
    } catch (cause) {
      if (cause instanceof ArgumentError) return fail(cause.message);
      this.deps.logger.error({ requestId, action }, 'script.manage: unexpected failure');
      return fail('script.manage failed');
    }
  }

  private async dispatch(
    service: ScriptService,
    args: ScriptManageArgs,
    context: ToolExecutionContext,
  ): Promise<{ value: unknown; error?: undefined } | { error: ScriptError }> {
    const { personaId, threadId } = context;
    switch (args.action) {
      case 'tools': {
        const name =
          args.name === undefined ? undefined : boundedString(args.name, 'name is required');
        const r = await service.listTools({
          personaId,
          threadId,
          ...(name !== undefined ? { name } : {}),
        });
        return r.isErr() ? { error: r.error } : { value: r.value };
      }
      case 'save': {
        const files = parseFiles(args.files);
        const r = service.save({ personaId, threadId, files });
        if (r.isErr()) return { error: r.error };
        const v = r.value;
        return {
          value: {
            versionId: v.versionId,
            name: v.manifest.name,
            version: v.version,
            state: v.state,
          },
        };
      }
      case 'test': {
        const versionId = boundedString(args.versionId, 'versionId is required');
        const r = await service.test({ personaId, versionId });
        if (r.isErr()) return { error: r.error };
        const { unit, dryRun, state } = r.value;
        return {
          value: {
            state,
            unit,
            ...(dryRun === undefined
              ? {}
              : {
                  dryRun: {
                    ok: dryRun.report.ok,
                    ...(dryRun.report.errorCode !== undefined
                      ? { errorCode: dryRun.report.errorCode }
                      : {}),
                    calls: dryRun.report.calls.map((call) => ({
                      name: call.name,
                      toolClass: call.toolClass,
                      outcome: call.outcome,
                      // Only the input of a skipped write: the approver sees what it would do.
                      ...(call.outcome === 'skipped-dry-run' ? { input: call.input } : {}),
                    })),
                  },
                }),
          },
        };
      }
      case 'request_approval': {
        const versionId = boundedString(args.versionId, 'versionId is required');
        const r = await service.requestApproval({ personaId, versionId });
        return r.isErr() ? { error: r.error } : { value: { status: r.value } };
      }
      case 'list': {
        const r = service.list(personaId);
        return r.isErr() ? { error: r.error } : { value: r.value };
      }
      case 'show': {
        const scriptName = boundedString(args.name, 'name is required');
        if (
          args.version !== undefined &&
          (typeof args.version !== 'number' || !Number.isInteger(args.version) || args.version < 1)
        ) {
          throw new ArgumentError('version must be a positive integer');
        }
        const r = service.show({
          personaId,
          scriptName,
          ...(args.version !== undefined ? { version: args.version } : {}),
        });
        return r.isErr() ? { error: r.error } : { value: r.value };
      }
      default:
        throw new ArgumentError('script.manage: invalid action');
    }
  }
}

/** Returns the value as is when its JSON fits, else a cut text ending in `[cut]`. */
function cutResult(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= MAX_RESULT_CHARS) return value;
  return text.slice(0, MAX_RESULT_CHARS) + CUT_MARKER;
}
