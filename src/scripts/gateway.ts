import { err, ok, type Result } from 'neverthrow';
import type { HostMessage } from './protocol.js';
import {
  ScriptError,
  type CallOutcome,
  type CallRecord,
  type GatewayOptions,
  type ScriptErrorCode,
  type ToolClass,
} from './types.js';

export interface ScriptGateway {
  /** Never rejects. The returned message is the reply for the script. */
  handleCall(message: { id: number; name: string; input: unknown }): Promise<HostMessage>;
  /** Aborts every open provider call and fails every waiting call. */
  abortAll(): void;
  records(): CallRecord[];
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_CALLS = 200;
const DEFAULT_MAX_RESULT_CHARS = 262_144;

/** Fixed texts: never tool input, tool output or provider error text. */
const MESSAGES: Partial<Record<ScriptErrorCode, string>> = {
  CALL_LIMIT: 'call limit reached',
  NOT_IN_MANIFEST: 'tool is not in the approved manifest',
  UNKNOWN_TOOL: 'tool is not available',
  NO_STUB: 'no stub available for this call',
  TOOL_FAILED: 'tool call failed',
  RESULT_TOO_LARGE: 'tool result is too large',
  SCRIPT_FAILED: 'script run was aborted',
};

interface OpenRecord {
  record: CallRecord;
  finished: boolean;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function createScriptGateway(options: GatewayOptions): Result<ScriptGateway, ScriptError> {
  const { manifest, mode, provider } = options;
  const invalid = (detail: string): Result<ScriptGateway, ScriptError> =>
    err(new ScriptError('INVALID_ARGUMENT', detail));

  if (typeof manifest?.name !== 'string' || manifest.name.length === 0) {
    return invalid('manifest name is empty');
  }
  if (typeof manifest.personaId !== 'string' || manifest.personaId.length === 0) {
    return invalid('manifest persona is empty');
  }
  if (
    !Array.isArray(manifest.tools) ||
    manifest.tools.some((tool) => typeof tool !== 'string' || tool.length === 0)
  ) {
    return invalid('manifest tools must be non-empty strings');
  }
  const maxConcurrent = options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  if (!isPositiveInt(maxConcurrent) || !isPositiveInt(maxCalls) || !isPositiveInt(maxResultChars)) {
    return invalid('limits must be positive integers');
  }

  const allowed = new Set(manifest.tools);
  const stubQueues = new Map<string, unknown[]>();
  for (const [name, list] of Object.entries(options.stubs ?? {})) {
    stubQueues.set(name, [...list]);
  }
  const takeStub = (name: string): { value: unknown } | undefined => {
    const queue = stubQueues.get(name);
    if (queue === undefined || queue.length === 0) {
      return undefined;
    }
    return { value: queue.shift() };
  };

  const all: OpenRecord[] = [];
  let aborted = false;
  let running = 0;
  const waiting: Array<() => void> = [];
  const controllers = new Set<AbortController>();

  const failure = (id: number, code: ScriptErrorCode): HostMessage => ({
    t: 'result',
    id,
    ok: false,
    code,
    message: MESSAGES[code] ?? 'call failed',
  });
  const success = (id: number, value: unknown): HostMessage => ({
    t: 'result',
    id,
    ok: true,
    value: value === undefined ? null : value,
  });

  const finish = (entry: OpenRecord, outcome: CallOutcome, errorCode?: ScriptErrorCode): void => {
    if (entry.finished) {
      return;
    }
    entry.finished = true;
    entry.record.outcome = outcome;
    if (errorCode !== undefined) {
      entry.record.errorCode = errorCode;
    }
  };

  const deny = (id: number, entry: OpenRecord, code: ScriptErrorCode): HostMessage => {
    finish(entry, 'denied', code);
    return failure(id, code);
  };
  const fail = (id: number, entry: OpenRecord, code: ScriptErrorCode): HostMessage => {
    finish(entry, 'failed', code);
    return failure(id, code);
  };

  const acquire = async (): Promise<void> => {
    if (running < maxConcurrent) {
      running++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      running--;
    } else {
      next(); // the slot passes straight to the next waiting call
    }
  };

  const runProvider = async (
    id: number,
    name: string,
    input: unknown,
    entry: OpenRecord,
  ): Promise<HostMessage> => {
    await acquire();
    try {
      if (aborted) {
        return fail(id, entry, 'SCRIPT_FAILED');
      }
      const controller = new AbortController();
      controllers.add(controller);
      let result: Result<unknown, ScriptError>;
      try {
        result = await provider.call(name, input, controller.signal);
      } catch {
        return fail(id, entry, 'TOOL_FAILED');
      } finally {
        controllers.delete(controller);
      }
      if (aborted) {
        return fail(id, entry, 'SCRIPT_FAILED');
      }
      if (result.isErr()) {
        return fail(id, entry, 'TOOL_FAILED');
      }
      const value = result.value === undefined ? null : result.value;
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch {
        return fail(id, entry, 'TOOL_FAILED');
      }
      if (typeof text !== 'string') {
        return fail(id, entry, 'TOOL_FAILED');
      }
      if (text.length > maxResultChars) {
        return fail(id, entry, 'RESULT_TOO_LARGE');
      }
      finish(entry, 'executed');
      return success(id, value);
    } finally {
      release();
    }
  };

  const dispatch = (
    id: number,
    name: string,
    input: unknown,
    entry: OpenRecord,
    counter: number,
  ): Promise<HostMessage> => {
    if (aborted) {
      return Promise.resolve(fail(id, entry, 'SCRIPT_FAILED'));
    }
    if (counter > maxCalls) {
      return Promise.resolve(deny(id, entry, 'CALL_LIMIT'));
    }
    if (!allowed.has(name)) {
      return Promise.resolve(deny(id, entry, 'NOT_IN_MANIFEST'));
    }
    let toolClass: ToolClass;
    try {
      const described = provider.describe(name);
      if (described === undefined) {
        return Promise.resolve(deny(id, entry, 'UNKNOWN_TOOL'));
      }
      toolClass = described.toolClass;
    } catch {
      return Promise.resolve(deny(id, entry, 'UNKNOWN_TOOL'));
    }
    entry.record.toolClass = toolClass;

    if (mode === 'unit') {
      const stub = takeStub(name);
      if (stub === undefined) {
        return Promise.resolve(fail(id, entry, 'NO_STUB'));
      }
      finish(entry, 'stubbed');
      return Promise.resolve(success(id, stub.value));
    }
    // A tool that is not 'read' or 'model' is treated as write.
    if (mode === 'dry-run' && toolClass !== 'read' && toolClass !== 'model') {
      const stub = takeStub(name);
      finish(entry, 'skipped-dry-run');
      return Promise.resolve(success(id, stub === undefined ? { dryRun: true } : stub.value));
    }
    return runProvider(id, name, input, entry);
  };

  let counter = 0;
  return ok({
    async handleCall(message): Promise<HostMessage> {
      counter++;
      const entry: OpenRecord = {
        finished: false,
        record: {
          seq: all.length + 1,
          name: message.name,
          toolClass: 'unknown',
          input: message.input,
          outcome: 'failed',
        },
      };
      all.push(entry);
      try {
        return await dispatch(message.id, message.name, message.input, entry, counter);
      } catch {
        return fail(message.id, entry, 'TOOL_FAILED');
      }
    },

    abortAll(): void {
      aborted = true;
      for (const entry of all) {
        if (!entry.finished) {
          finish(entry, 'failed', 'SCRIPT_FAILED');
        }
      }
      for (const controller of controllers) {
        controller.abort();
      }
      // Waiting calls wake up, see `aborted` and fail without calling the provider.
      const wake = waiting.splice(0);
      running += wake.length;
      for (const resolve of wake) {
        resolve();
      }
    },

    records(): CallRecord[] {
      return all.filter((entry) => entry.finished).map((entry) => ({ ...entry.record }));
    },
  });
}
