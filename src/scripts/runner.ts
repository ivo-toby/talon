import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type { ExecutionBroker } from '../execution-broker/index.js';
import { createScriptGateway } from './gateway.js';
import { createLineDecoder, encodeMessage, type ScriptMessage } from './protocol.js';
import {
  ScriptError,
  type ScriptErrorCode,
  type ScriptManifest,
  type ScriptMode,
  type ScriptRunReport,
  type ToolProvider,
} from './types.js';

export interface ScriptRunRequest {
  manifest: ScriptManifest;
  mode: ScriptMode;
  provider: ToolProvider;
  /** Relative to the scripts workspace, for example 'mail-intake/script.ts'. */
  scriptPath: string;
  input: unknown;
  timeoutMs: number;
  stubs?: Record<string, unknown[]>;
  /** Passed to the gateway; its default applies when unset. */
  maxCalls?: number;
  /** Broker names. The operator allowlist must grant them to manifest.personaId. */
  profile: string;
  /**
   * Broker workspace id. The operator must configure this workspace as read-only
   * (`mode: 'ro'`) with mount target `/scripts`. With a read-write mount, one script
   * could change the SDK or another script. Part 2 enforces this at configuration load;
   * this runner does not check it.
   */
  workspace: string;
}

const MAX_SCRIPT_PATH_CHARS = 512;
const SCRIPT_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;

function validScriptPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_SCRIPT_PATH_CHARS) {
    return false;
  }
  if (!SCRIPT_PATH_CHARS.test(path) || path.startsWith('/') || path.startsWith('-')) {
    return false;
  }
  if (!path.endsWith('.ts')) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validateRequest(request: ScriptRunRequest): ScriptError | undefined {
  if (!validScriptPath(request.scriptPath)) {
    return new ScriptError('INVALID_ARGUMENT', 'script path is not valid');
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    return new ScriptError('INVALID_ARGUMENT', 'timeout must be a positive integer');
  }
  try {
    JSON.stringify(request.input);
  } catch {
    return new ScriptError('INVALID_ARGUMENT', 'input is not JSON-serializable');
  }
  return undefined;
}

type Broker = Pick<ExecutionBroker, 'createLease' | 'executeStream' | 'revoke'>;

/** Never rejects. `err` only when the run did not start. */
export async function runScript(
  broker: Broker,
  request: ScriptRunRequest,
): Promise<Result<ScriptRunReport, ScriptError>> {
  try {
    return await run(broker, request);
  } catch {
    return err(new ScriptError('SANDBOX', 'script run could not be started'));
  }
}

async function run(
  broker: Broker,
  request: ScriptRunRequest,
): Promise<Result<ScriptRunReport, ScriptError>> {
  const invalid = validateRequest(request);
  if (invalid) {
    return err(invalid);
  }
  const created = createScriptGateway({
    manifest: request.manifest,
    mode: request.mode,
    provider: request.provider,
    stubs: request.stubs,
    maxCalls: request.maxCalls,
  });
  if (created.isErr()) {
    return err(created.error);
  }
  const gateway = created.value;

  const taskId = randomUUID();
  const personaId = request.manifest.personaId;
  const lease = await broker.createLease({
    taskId,
    parentPersonaId: personaId,
    personaId,
    profile: request.profile,
    workspace: request.workspace,
  });
  if (lease.isErr()) {
    return err(new ScriptError('SANDBOX', 'sandbox lease was refused', lease.error));
  }
  const { leaseId } = lease.value;

  type Outcome =
    | { kind: 'done'; message: Extract<ScriptMessage, { t: 'done' }> }
    | { kind: 'failed'; code: ScriptErrorCode };

  let outcome: Outcome | undefined;
  let finish!: (value: Outcome) => void;
  const finished = new Promise<Outcome>((resolve) => {
    finish = resolve;
  });
  const settle = (value: Outcome): void => {
    if (outcome) {
      return;
    }
    outcome = value;
    finish(value);
  };

  const live: { stream?: { writeStdin(text: string): void } } = {};
  const decoder = createLineDecoder();

  const reply = (callMessage: Extract<ScriptMessage, { t: 'call' }>): void => {
    void gateway
      .handleCall({ id: callMessage.id, name: callMessage.name, input: callMessage.input })
      .then((message) => {
        if (!outcome) {
          live.stream?.writeStdin(encodeMessage(message));
        }
      })
      .catch(() => settle({ kind: 'failed', code: 'SCRIPT_FAILED' }));
  };

  let startSent = false;

  const onStdout = (text: string): void => {
    try {
      if (outcome) {
        return;
      }
      if (!startSent) {
        // The script must not speak before it has been sent `start`.
        settle({ kind: 'failed', code: 'PROTOCOL' });
        return;
      }
      const decoded = decoder.push(text);
      if (decoded.isErr()) {
        settle({ kind: 'failed', code: 'PROTOCOL' });
        return;
      }
      for (const message of decoded.value) {
        if (outcome) {
          return;
        }
        if (message.t === 'done') {
          settle({ kind: 'done', message });
        } else {
          reply(message);
          if (gateway.limitExceeded()) {
            // Set synchronously by the call above, so it ranks in stream order with `done`.
            settle({ kind: 'failed', code: 'CALL_LIMIT' });
          }
        }
      }
    } catch {
      settle({ kind: 'failed', code: 'PROTOCOL' });
    }
  };

  let started: Awaited<ReturnType<Broker['executeStream']>>;
  try {
    started = await broker.executeStream(
      {
        leaseId,
        taskId,
        personaId,
        argv: ['node', '/scripts/node_modules/talon/run.js', request.scriptPath],
        cwd: '',
        timeoutMs: request.timeoutMs,
      },
      { onStdout },
    );
  } catch {
    await safeRevoke(broker, leaseId);
    return err(new ScriptError('SANDBOX', 'sandbox exec could not be started'));
  }
  if (started.isErr()) {
    await safeRevoke(broker, leaseId);
    return err(new ScriptError('SANDBOX', 'sandbox exec was refused', started.error));
  }
  live.stream = started.value;

  const execEnded = started.value.result.then(
    (result) => {
      if (result.isErr()) {
        // The backend failed; the script did not necessarily do anything wrong.
        settle({ kind: 'failed', code: 'SANDBOX' });
        return;
      }
      settle({ kind: 'failed', code: result.value.timedOut ? 'TIMEOUT' : 'SCRIPT_FAILED' });
    },
    () => settle({ kind: 'failed', code: 'SCRIPT_FAILED' }),
  );

  try {
    if (!outcome) {
      startSent = true;
      started.value.writeStdin(encodeMessage({ t: 'start', input: request.input ?? null }));
    }
  } catch {
    settle({ kind: 'failed', code: 'SCRIPT_FAILED' });
  }

  const final = await finished;
  gateway.abortAll();
  await safeRevoke(broker, leaseId);
  await execEnded;

  const calls = gateway.records();
  if (final.kind === 'done') {
    if (final.message.ok) {
      return ok({ ok: true, result: final.message.result, calls });
    }
    return ok({ ok: false, errorCode: 'SCRIPT_FAILED', calls });
  }
  return ok({ ok: false, errorCode: final.code, calls });
}

async function safeRevoke(broker: Broker, leaseId: string): Promise<void> {
  try {
    await broker.revoke(leaseId);
  } catch {
    // A failing revoke does not change the report.
  }
}
