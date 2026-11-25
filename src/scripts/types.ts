import type { Result } from 'neverthrow';
import { TalonError } from '../core/errors/error-types.js';

/** How a script run treats tool calls. */
export type ScriptMode = 'unit' | 'dry-run' | 'live';

/** `model` is a model request with no tools; it runs in `dry-run` and `live`. */
export type ToolClass = 'read' | 'write' | 'model';

export type ScriptErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_IN_MANIFEST'
  | 'UNKNOWN_TOOL'
  | 'NO_STUB'
  | 'TOOL_FAILED'
  | 'RESULT_TOO_LARGE'
  | 'CALL_LIMIT'
  | 'PROTOCOL'
  | 'SCRIPT_FAILED'
  | 'TIMEOUT'
  | 'SANDBOX';

/**
 * Script runtime error.
 *
 * Constraint: `detail` must never carry tool input, tool output, script text,
 * a lease ID, a host path, or a cause's message; the cause travels only in `cause`.
 */
export class ScriptError extends TalonError {
  readonly code = 'SCRIPT_ERROR' as const;
  readonly scriptCode: ScriptErrorCode;

  constructor(scriptCode: ScriptErrorCode, detail: string, cause?: Error) {
    super(`script: [${scriptCode}] ${detail}`, cause);
    this.scriptCode = scriptCode;
  }
}

/** What the user approves: the script may call only these tools. */
export interface ScriptManifest {
  name: string;
  personaId: string;
  /** Tool names as the script calls them, e.g. `mailbox.list_metadata`. */
  tools: string[];
}

/** Source of real tools. The gateway is its only caller. */
export interface ToolProvider {
  /** `undefined` means the tool does not exist for this persona. */
  describe(name: string): { toolClass: ToolClass } | undefined;
  call(name: string, input: unknown, signal: AbortSignal): Promise<Result<unknown, ScriptError>>;
}

export type CallOutcome =
  | 'executed'
  | 'stubbed'
  | 'skipped-dry-run'
  | 'denied'
  | 'failed'
  /** The provider call was started and then aborted, so the effect is unknown. */
  | 'aborted';

export interface CallRecord {
  seq: number;
  name: string;
  toolClass: ToolClass | 'unknown';
  input: unknown;
  outcome: CallOutcome;
  errorCode?: ScriptErrorCode;
}

export interface ScriptRunReport {
  ok: boolean;
  result?: unknown;
  errorCode?: ScriptErrorCode;
  calls: CallRecord[];
}

export interface GatewayOptions {
  manifest: ScriptManifest;
  mode: ScriptMode;
  provider: ToolProvider;
  /**
   * `unit`: answers per tool name, used in order.
   * `dry-run`: placeholder results for write tools, used in order.
   */
  stubs?: Record<string, unknown[]>;
  /** Default 8. */
  maxConcurrentCalls?: number;
  /** Default 200. */
  maxCalls?: number;
  /** Default 262_144. Measured on the JSON text of a tool result. */
  maxResultChars?: number;
}
