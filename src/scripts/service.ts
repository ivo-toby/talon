/**
 * The script service: the one object that the daemon and the agent tools call.
 *
 * It saves, tests and puts scripts up for approval, decides approval commands
 * from the chat, and runs approved scripts for the scheduler. The script and
 * everything it produces are untrusted. An approval is bound to one content
 * hash, and the model never gets an approval code: the code leaves this module
 * only inside the `send` call.
 */

import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type { Logger } from 'pino';
import type { InboundEvent } from '../channels/channel-types.js';
import type { ScriptsConfig } from '../core/config/config-schema.js';
import type {
  ScriptRepository,
  ScriptVersionRow,
} from '../core/database/repositories/script-repository.js';
import { createLogger } from '../core/logging/index.js';
import { ExecutionBrokerError, type ExecutionBroker } from '../execution-broker/index.js';
import type { ApprovalService, CancelOutcome, Decision } from './approval.js';
import { SCRIPT_PROFILE, SCRIPT_WORKSPACE } from './config.js';
import type { ResolvedCapabilities } from '../personas/persona-types.js';
import { runScript } from './runner.js';
import { scriptRunAccess } from './run-policy.js';
import type { ScriptStore, ScriptFile, StoredVersion } from './store.js';
import { resolveRunInput } from './run-input.js';
import { buildApprovalSummary } from './summary.js';
import {
  runDryRun,
  runUnitCases,
  type DryRunOutcome,
  type RunDeps,
  type UnitOutcome,
} from './test-runner.js';
import {
  ScriptError,
  type AuthoredManifest,
  type RunContext,
  type RunProvider,
  type ScriptErrorCode,
  type CallRecord,
  type ScriptRunReport,
  type ToolClass,
  type VersionState,
} from './types.js';

export interface ScriptServiceDeps {
  store: ScriptStore;
  repo: ScriptRepository;
  approval: ApprovalService;
  broker: Pick<ExecutionBroker, 'createLease' | 'executeStream' | 'revoke'>;
  config: ScriptsConfig;
  createProvider(
    context: RunContext,
    manifest: AuthoredManifest,
  ): Promise<Result<RunProvider, ScriptError>>;
  /** Sends a text to a chat: the approval message and failure notices. */
  send(
    channelName: string,
    externalThreadId: string,
    body: string,
  ): Promise<Result<void, ScriptError>>;
  /** The chat that a thread belongs to, or `undefined`. Synchronous. */
  resolveChat(threadId: string): { channelName: string; externalThreadId: string } | undefined;
  audit(entry: {
    action: string;
    personaId: string;
    threadId: string;
    runId: string;
    tool?: string;
    details: Record<string, unknown>;
  }): void;
  /** Capabilities of a persona by database ID, or `undefined` if it is not loaded. Never throws. */
  capabilities(personaId: string): ResolvedCapabilities | undefined;
  now?: () => number;
  logger?: Logger;
}

export interface ScriptService {
  save(input: {
    personaId: string;
    threadId: string;
    files: ScriptFile[];
  }): Result<StoredVersion, ScriptError>;
  test(input: {
    personaId: string;
    versionId: string;
  }): Promise<
    Result<{ unit: UnitOutcome[]; dryRun?: DryRunOutcome; state: VersionState }, ScriptError>
  >;
  /** Sends the approval message to the chat of the thread that saved the version. */
  requestApproval(input: {
    personaId: string;
    versionId: string;
  }): Promise<Result<void, ScriptError>>;
  /**
   * True if the event is an approval command, holds a valid code of its chat,
   * or starts like a command, in a chat with an open approval. Synchronous,
   * never throws.
   */
  matchesInbound(event: InboundEvent): boolean;
  /** An object means the event is consumed. Never rejects. */
  handleInbound(event: InboundEvent): Promise<{ reply?: string } | undefined>;
  runScheduled(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    scheduleId: string;
    input?: unknown;
  }): Promise<Result<ScriptRunReport | 'skipped', ScriptError>>;
  /**
   * A live run that the agent starts. `access` comes from the trusted run
   * context: `allowed` runs now, `approval` asks the chat first and returns
   * `awaiting-approval`. The capability check is the caller's.
   */
  runByAgent(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    access: 'allowed' | 'approval';
    input?: unknown;
  }): Promise<Result<ScriptRunReport | 'awaiting-approval', ScriptError>>;
  notifyFailure(input: {
    threadId: string;
    scriptName: string;
    errorCode: string;
    reason?: ScriptNotRunReason;
  }): Promise<void>;
  hasApproved(personaId: string, scriptName: string): boolean;
  /** True if the last finished scheduled run of this script was a failure. */
  lastScheduledRunFailed(personaId: string, scriptName: string): boolean;
  /** Marks runs that a crashed daemon left open as failed. Call one time at start. */
  recoverStaleRuns(): Result<number, ScriptError>;
  /**
   * Refuses new runs and tests, revokes the leases of the active runs (so their
   * containers go away) and waits at most 10 seconds for them to settle. Never throws.
   */
  shutdown(): Promise<void>;
}

/**
 * Why a scheduled run did not start: the files changed, no version is approved,
 * or the persona has no `script.run` capability for the script.
 */
export type ScriptNotRunReason = 'changed' | 'not-approved' | 'not-permitted' | 'bad-input';

/** A `SCRIPT_FAILED` error of `runScheduled` for a run that did not start. */
export class ScriptNotRunError extends ScriptError {
  readonly reason: ScriptNotRunReason;

  constructor(reason: ScriptNotRunReason, cause?: Error) {
    super(
      'SCRIPT_FAILED',
      reason === 'changed'
        ? 'the files changed after the approval'
        : reason === 'not-permitted'
          ? 'the persona has no script.run capability for this script'
          : reason === 'bad-input'
            ? 'the input of the schedule does not match the script'
            : 'no approved version of this script',
      cause,
    );
    this.reason = reason;
  }
}

const MAX_REPORT_CHARS = 1_000_000;
/** The longest approval message for a run that the agent asks for. */
const MAX_RUN_APPROVAL_CHARS = 3_500;
const CODE_CHARS = 8;
const SHUTDOWN_WAIT_MS = 10_000;
const NAME_MAX = 60;
const KNOWN_CODES: ReadonlySet<string> = new Set<ScriptErrorCode>([
  'INVALID_ARGUMENT',
  'NOT_IN_MANIFEST',
  'UNKNOWN_TOOL',
  'NO_STUB',
  'TOOL_FAILED',
  'RESULT_TOO_LARGE',
  'CALL_LIMIT',
  'PROTOCOL',
  'SCRIPT_FAILED',
  'TIMEOUT',
  'SANDBOX',
]);

const unknownVersion = (): ScriptError =>
  new ScriptError('INVALID_ARGUMENT', 'unknown script version');
const sandbox = (cause?: unknown): ScriptError =>
  new ScriptError(
    'SANDBOX',
    'the script service failed',
    cause instanceof Error ? cause : cause === undefined ? undefined : new Error('non-error cause'),
  );

function cleanName(name: string | undefined): string {
  return (name ?? '').replace(/[^a-z0-9-]/g, '').slice(0, NAME_MAX);
}

/** The notice for a run that did not run or failed. `scheduled` adds the sentence about the schedule. */
function failureText(input: {
  name: string;
  code: string;
  reason?: ScriptNotRunReason;
  scheduled: boolean;
}): string {
  const { name, code } = input;
  if (input.reason === 'changed') {
    return `Script "${name}" did not run: its files changed after the approval.`;
  }
  if (input.reason === 'not-approved') {
    return `Script "${name}" did not run: it has no approved version.`;
  }
  if (input.reason === 'not-permitted') {
    return `Script ${name} did not run: the persona has no script.run capability for it.`;
  }
  if (input.reason === 'bad-input') {
    return `Script ${name} did not run: the input of the schedule does not match the script.`;
  }
  return input.scheduled
    ? `Script "${name}" failed (${code}). It stays scheduled. I will tell you again only if it fails after a success.`
    : `Script "${name}" failed (${code}).`;
}

function isReport(value: unknown): value is ScriptRunReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as { ok?: unknown; calls?: unknown };
  return typeof report.ok === 'boolean' && Array.isArray(report.calls);
}

export function createScriptService(deps: ScriptServiceDeps): ScriptService {
  const { store, repo, approval, config } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const logger = deps.logger ?? createLogger({ level: 'info', pretty: false });
  const active = new Set<string>();
  /** `personaId \0 scriptName` of scripts whose last scheduled run failed or did not start. */
  const failedScripts = new Set<string>();
  /** Version ids with a `test` in flight. */
  const testing = new Set<string>();

  let closed = false;
  /** Leases of the runs in flight, so `shutdown` can revoke them. */
  const leases = new Set<string>();
  /** Runs and tests in flight, so `shutdown` can wait for them. */
  const inFlight = new Set<Promise<unknown>>();
  type Broker = ScriptServiceDeps['broker'];
  const broker: Broker = {
    async createLease(input): ReturnType<Broker['createLease']> {
      if (closed) {
        return err(new ExecutionBrokerError('BACKEND_FAILURE', 'the script service is closed'));
      }
      const lease = await deps.broker.createLease(input);
      if (lease.isOk()) {
        if (closed) {
          // `shutdown` started while the lease was made: it cannot see this one.
          await deps.broker.revoke(lease.value.leaseId);
        } else {
          leases.add(lease.value.leaseId);
        }
      }
      return lease;
    },
    executeStream: (request, handlers) => deps.broker.executeStream(request, handlers),
    revoke(leaseId): ReturnType<Broker['revoke']> {
      leases.delete(leaseId);
      return deps.broker.revoke(leaseId);
    },
  };

  /** Runs `fn` as tracked work, or refuses it when the service is closed. */
  function tracked<T>(fn: () => Promise<Result<T, ScriptError>>): Promise<Result<T, ScriptError>> {
    if (closed) {
      return Promise.resolve(err(new ScriptError('SANDBOX', 'the script service is closed')));
    }
    const work = guard(fn);
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return work;
  }

  const runDeps: RunDeps = {
    broker,
    profile: SCRIPT_PROFILE,
    workspace: SCRIPT_WORKSPACE,
    timeoutMs: config.runTimeoutMs,
    maxCalls: config.maxCallsPerRun,
  };

  function audit(entry: Parameters<ScriptServiceDeps['audit']>[0]): void {
    try {
      deps.audit(entry);
    } catch (error) {
      logger.error({ err: error, action: entry.action }, 'script audit failed');
    }
  }

  async function closeProvider(provider: RunProvider): Promise<void> {
    try {
      await provider.close();
    } catch (error) {
      logger.error({ err: error }, 'script provider close failed');
    }
  }

  /** Never throws. Returns true if the row was finished. */
  function finishRun(
    runId: string,
    runOk: boolean,
    errorCode: string | null,
    calls: number,
  ): boolean {
    try {
      const done = repo.finishRun(runId, runOk, errorCode, calls, now());
      if (done.isErr()) {
        logger.error({ runId }, 'could not finish a script run row');
        return false;
      }
      return true;
    } catch (error) {
      logger.error({ err: error, runId }, 'could not finish a script run row');
      return false;
    }
  }

  /** Loads a version and checks that the persona owns its script. */
  function loadOwned(
    personaId: string,
    versionId: string,
  ): Result<{ version: StoredVersion; row: ScriptVersionRow }, ScriptError> {
    const loaded = store.load(versionId);
    if (loaded.isErr()) return err(loaded.error);
    const script = repo.getScript(loaded.value.scriptId);
    if (script.isErr()) return err(sandbox(script.error));
    if (!script.value || script.value.persona_id !== personaId) return err(unknownVersion());
    const row = repo.getVersion(versionId);
    if (row.isErr()) return err(sandbox(row.error));
    if (!row.value) return err(unknownVersion());
    return ok({ version: loaded.value, row: row.value });
  }

  /** Ends a test: the one state write of `test`. */
  function recordTest(
    versionId: string,
    report: string | null,
    to: 'tested' | 'draft',
  ): Result<void, ScriptError> {
    const recorded = repo.recordTestResult(versionId, { report, to });
    if (recorded.isErr()) return err(sandbox(recorded.error));
    if (!recorded.value) {
      return err(new ScriptError('INVALID_ARGUMENT', 'the version changed during the test'));
    }
    return ok(undefined);
  }

  function startRun(
    versionId: string,
    mode: string,
    trigger: 'test' | 'dry-run' | 'schedule' | 'agent',
    scheduleId?: string,
  ): Result<string, ScriptError> {
    const id = randomUUID();
    const inserted = repo.insertRun({
      id,
      versionId,
      mode,
      trigger,
      scheduleId: scheduleId ?? null,
      startedAt: now(),
    });
    return inserted.isErr() ? err(sandbox(inserted.error)) : ok(id);
  }

  async function testImpl(input: {
    personaId: string;
    versionId: string;
  }): Promise<
    Result<{ unit: UnitOutcome[]; dryRun?: DryRunOutcome; state: VersionState }, ScriptError>
  > {
    const owned = loadOwned(input.personaId, input.versionId);
    if (owned.isErr()) return err(owned.error);
    const { version } = owned.value;
    if (version.state !== 'draft' && version.state !== 'tested') {
      return err(
        new ScriptError('INVALID_ARGUMENT', 'only a draft or tested version can be tested'),
      );
    }
    if (testing.has(version.versionId)) {
      return err(new ScriptError('INVALID_ARGUMENT', 'the version is being tested'));
    }
    testing.add(version.versionId);
    const rows = new Set<string>();
    let provider: RunProvider | undefined;
    try {
      const verified = store.verify(version);
      if (verified.isErr()) return err(verified.error);

      const context: RunContext = {
        personaId: input.personaId,
        threadId: version.threadId,
        scriptRunId: randomUUID(),
        scriptName: version.manifest.name,
        channels: version.manifest.channels,
        versionDir: version.dir,
      };
      const created = await deps.createProvider(context, version.manifest);
      if (created.isErr()) return err(created.error);
      const usable = created.value;
      provider = usable;

      const cases = store.readUnitCases(version);
      if (cases.isErr()) return err(cases.error);

      const begin = (mode: string, trigger: 'test' | 'dry-run'): Result<string, ScriptError> => {
        const row = startRun(version.versionId, mode, trigger);
        if (row.isOk()) rows.add(row.value);
        return row;
      };
      const end = (id: string, runOk: boolean, code: string | null, calls: number): void => {
        if (finishRun(id, runOk, code, calls)) rows.delete(id);
      };

      const unitRun = begin('unit', 'test');
      if (unitRun.isErr()) return err(unitRun.error);
      const unit = await runUnitCases(runDeps, version, input.personaId, cases.value, (name) =>
        usable.describe(name),
      );
      if (unit.isErr()) {
        end(unitRun.value, false, unit.error.scriptCode, 0);
        return err(unit.error);
      }
      const allPassed = unit.value.every((outcome) => outcome.passed);
      end(unitRun.value, allPassed, allPassed ? null : 'SCRIPT_FAILED', unit.value.length);

      if (!allPassed) {
        const moved = recordTest(version.versionId, null, 'draft');
        if (moved.isErr()) return err(moved.error);
        return ok({ unit: unit.value, state: 'draft' });
      }

      const dryRow = begin('dry-run', 'dry-run');
      if (dryRow.isErr()) return err(dryRow.error);
      const dry = await runDryRun(runDeps, version, input.personaId, usable);
      if (dry.isErr()) {
        end(dryRow.value, false, dry.error.scriptCode, 0);
        return err(dry.error);
      }
      const { report, didWork } = dry.value;
      end(
        dryRow.value,
        report.ok,
        report.ok ? null : (report.errorCode ?? 'SCRIPT_FAILED'),
        report.calls.length,
      );

      if (report.ok && didWork) {
        const text = JSON.stringify(report);
        if (text.length > MAX_REPORT_CHARS) {
          const moved = recordTest(version.versionId, null, 'draft');
          if (moved.isErr()) return err(moved.error);
          return err(new ScriptError('RESULT_TOO_LARGE', 'the dry-run report is too large'));
        }
        const moved = recordTest(version.versionId, text, 'tested');
        if (moved.isErr()) return err(moved.error);
        return ok({ unit: unit.value, dryRun: dry.value, state: 'tested' });
      }
      const moved = recordTest(version.versionId, null, 'draft');
      if (moved.isErr()) return err(moved.error);
      return ok({ unit: unit.value, dryRun: dry.value, state: 'draft' });
    } finally {
      for (const id of rows) finishRun(id, false, 'SANDBOX', 0);
      if (provider) await closeProvider(provider);
      testing.delete(version.versionId);
    }
  }

  /** The class of each manifest tool, from a provider that is closed again at once. */
  async function describeTools(
    personaId: string,
    version: StoredVersion,
  ): Promise<Result<Map<string, ToolClass | undefined>, ScriptError>> {
    const created = await deps.createProvider(
      {
        personaId,
        threadId: version.threadId,
        scriptRunId: randomUUID(),
        scriptName: version.manifest.name,
        channels: version.manifest.channels,
        versionDir: version.dir,
      },
      version.manifest,
    );
    if (created.isErr()) return err(created.error);
    try {
      return ok(
        new Map(
          version.manifest.tools.map((tool) => [tool, created.value.describe(tool)?.toolClass]),
        ),
      );
    } finally {
      await closeProvider(created.value);
    }
  }

  async function requestApprovalImpl(input: {
    personaId: string;
    versionId: string;
  }): Promise<Result<void, ScriptError>> {
    const owned = loadOwned(input.personaId, input.versionId);
    if (owned.isErr()) return err(owned.error);
    const { version, row } = owned.value;
    const chat = deps.resolveChat(version.threadId);
    if (!chat) {
      return err(new ScriptError('INVALID_ARGUMENT', 'the thread of the version has no chat'));
    }
    if (testing.has(version.versionId)) {
      return err(new ScriptError('INVALID_ARGUMENT', 'the version is being tested'));
    }
    if (version.state !== 'tested' && version.state !== 'awaiting-approval') {
      return err(new ScriptError('INVALID_ARGUMENT', 'version cannot be put up for approval'));
    }
    let report: unknown;
    try {
      report =
        row.dry_run_report === null ? undefined : (JSON.parse(row.dry_run_report) as unknown);
    } catch {
      report = undefined;
    }
    if (!isReport(report)) {
      return err(new ScriptError('INVALID_ARGUMENT', 'version has no usable dry-run report'));
    }
    const verified = store.verify(version);
    if (verified.isErr()) return err(verified.error);

    const classes = await describeTools(input.personaId, version);
    if (classes.isErr()) return err(classes.error);
    const summaryOf = (code: string): Result<string, ScriptError> =>
      buildApprovalSummary({
        name: version.manifest.name,
        version: version.version,
        description: version.manifest.description,
        manifest: version.manifest,
        toolClass: (name) => classes.value.get(name),
        report,
        code,
        ttlMinutes: config.approvalTtlMinutes,
      });
    // A code always has 8 characters, so a probe with 8 characters has the final length.
    if (summaryOf('0'.repeat(CODE_CHARS)).isErr()) {
      return err(
        new ScriptError(
          'RESULT_TOO_LARGE',
          'the dry-run writes do not fit in the approval message',
        ),
      );
    }

    const requested = approval.request({
      versionId: version.versionId,
      channelName: chat.channelName,
      externalThreadId: chat.externalThreadId,
    });
    if (requested.isErr()) return err(requested.error);

    const summary = summaryOf(requested.value.code);
    let sent: Result<void, ScriptError>;
    try {
      sent = summary.isErr()
        ? err(summary.error)
        : await deps.send(chat.channelName, chat.externalThreadId, summary.value);
    } catch {
      sent = err(new ScriptError('TOOL_FAILED', 'send threw'));
    }
    if (sent.isErr()) {
      const expired = approval.expireVersion(version.versionId);
      const back = repo.setVersionState(version.versionId, ['awaiting-approval'], 'tested');
      if (expired.isErr() || back.isErr()) {
        logger.error(
          { versionId: version.versionId },
          'could not roll back a failed approval request',
        );
      }
      return err(new ScriptError('TOOL_FAILED', 'the approval message could not be sent'));
    }
    return ok(undefined);
  }

  function decideCommand(event: InboundEvent): { reply?: string } {
    const command =
      typeof event.content === 'string' ? approval.parseCommand(event.content) : undefined;
    if (!command) return { reply: 'This code is not valid.' };

    const decided = approval.decide({
      code: command.code,
      decision: command.decision,
      channelName: event.channelName,
      externalThreadId: event.externalThreadId,
    });
    if (decided.isErr()) {
      logger.error({ scriptCode: decided.error.scriptCode }, 'script approval decision failed');
      return { reply: 'This code is not valid.' };
    }
    const outcome = decided.value;
    // A chat held by the attempt limiter gets no answer at all.
    if (outcome.outcome === 'blocked') return {};
    if (outcome.outcome === 'refused') return { reply: 'This code is not valid.' };

    if (outcome.versionId !== undefined && outcome.personaId !== undefined) {
      audit({
        action: 'script.approval',
        personaId: outcome.personaId,
        threadId: outcome.threadId ?? '',
        runId: randomUUID(),
        details: {
          versionId: outcome.versionId,
          decision: outcome.outcome,
          channelName: event.channelName,
          ...(outcome.purpose !== undefined && outcome.purpose !== 'version'
            ? { purpose: outcome.purpose }
            : {}),
        },
      });
    }
    if (outcome.purpose === 'run') return decideRun(event, outcome);
    const name = cleanName(outcome.scriptName);
    const label =
      name !== '' && outcome.version !== undefined
        ? ` script "${name}" v${outcome.version}.`
        : ' the script.';
    return outcome.outcome === 'approved'
      ? { reply: `Approved:${label} It can now run on a schedule.` }
      : { reply: `Rejected:${label}` };
  }

  /** The decision on a run that the agent asked for. */
  function decideRun(event: InboundEvent, outcome: Decision): { reply?: string } {
    const name = cleanName(outcome.scriptName);
    if (name === '' || outcome.personaId === undefined || outcome.versionId === undefined) {
      return { reply: 'This request could not be started. Ask again.' };
    }
    if (outcome.outcome === 'rejected') return { reply: `Script ${name} was not started.` };
    const { personaId, versionId } = outcome;
    const changed = { reply: `Script ${name} changed after this request. Ask again.` };

    let stored: { has: boolean; value?: unknown };
    try {
      const parsed: unknown = outcome.payload === undefined ? {} : JSON.parse(outcome.payload);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { reply: `Script ${name} was not started.` };
      }
      stored = 'input' in parsed ? { has: true, value: parsed.input } : { has: false };
    } catch {
      return { reply: `Script ${name} was not started.` };
    }
    const version = repo.getVersion(versionId);
    if (version.isErr() || !version.value) return { reply: `Script ${name} was not started.` };
    const newest = repo.latestApproved(version.value.script_id);
    if (newest.isErr()) return { reply: `Script ${name} was not started.` };
    if (!newest.value || newest.value.id !== versionId) return changed;

    const replyChat = { channelName: event.channelName, externalThreadId: event.externalThreadId };
    const work = (async (): Promise<void> => {
      const result = await tracked(() =>
        agentLive({
          personaId,
          threadId: outcome.threadId ?? '',
          scriptName: name,
          scriptId: version.value!.script_id,
          versionId,
          ...(stored.has ? { input: stored.value } : {}),
        }),
      );
      let text: string;
      if (result.isErr()) {
        const reason = result.error instanceof ScriptNotRunError ? result.error.reason : undefined;
        text = failureText({ name, code: result.error.scriptCode, reason, scheduled: false });
      } else if (result.value.ok) {
        text = `Script ${name} finished.`;
      } else {
        const code = result.value.errorCode ?? 'SCRIPT_FAILED';
        text = failureText({
          name,
          code: KNOWN_CODES.has(code) ? code : 'SCRIPT_FAILED',
          scheduled: false,
        });
      }
      const sent = await deps.send(replyChat.channelName, replyChat.externalThreadId, text);
      if (sent.isErr()) {
        logger.error({ scriptCode: sent.error.scriptCode }, 'script run notice not sent');
      }
    })().catch((error: unknown) => {
      logger.error({ err: error }, 'script run by the agent failed unexpectedly');
    });
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return { reply: `Script ${name} started.` };
  }

  function cancelReply(
    event: InboundEvent,
    outcome: CancelOutcome,
    reason: 'leak' | 'wrong-chat',
    reply: string,
  ): { reply?: string } {
    for (const item of outcome.cancelled) {
      audit({
        action: 'script.approval.expired',
        personaId: item.personaId ?? '',
        threadId: item.threadId ?? '',
        runId: randomUUID(),
        details: {
          versionId: item.versionId,
          reason,
          channelName: event.channelName,
          ...(item.purpose !== 'version' ? { purpose: item.purpose } : {}),
        },
      });
    }
    // Nothing was cancelled, or a write failed: the code stays guarded, but do not claim a cancel.
    const done = outcome.cancelled.length > 0 && !outcome.failed;
    const onlyRuns = outcome.cancelled.every((item) => item.purpose === 'run');
    const runText = done && onlyRuns ? runCancelText(outcome) : undefined;
    return attemptReply(
      event,
      runText ?? (done ? reply : 'This code cannot be used here. Ask for a new approval.'),
    );
  }

  /** The notice for cancelled run requests, or `undefined` if no script name is known. */
  function runCancelText(outcome: CancelOutcome): string | undefined {
    const names = new Set<string>();
    for (const item of outcome.cancelled) {
      try {
        const row = repo.getVersion(item.versionId);
        const parsed: unknown =
          row.isOk() && row.value ? JSON.parse(row.value.manifest) : undefined;
        const name = cleanName((parsed as { name?: string } | undefined)?.name);
        if (name !== '') names.add(name);
      } catch {
        // an unreadable manifest: no name
      }
    }
    if (names.size === 0) return 'The run request was cancelled and must be asked again.';
    return [...names]
      .map((name) => `The run request of script ${name} was cancelled and must be asked again.`)
      .join('\n');
  }

  /** A reply for a claimed message that was no valid decision. A blocked chat gets none. */
  function attemptReply(event: InboundEvent, reply: string): { reply?: string } {
    const isBlocked = approval.noteAttempt(event.channelName, event.externalThreadId);
    return isBlocked ? {} : { reply };
  }

  function handleInboundImpl(event: InboundEvent): { reply?: string } | undefined {
    switch (approval.classify(event)) {
      case 'command':
        return decideCommand(event);
      case 'leak':
        // The code is cancelled also in a blocked chat: it was seen outside a command.
        return cancelReply(
          event,
          approval.cancelLeaked(event),
          'leak',
          'The code was not in a valid command, so I cancelled it. Ask for a new approval.',
        );
      case 'wrong-chat':
        return cancelReply(
          event,
          approval.cancelWrongChat(event),
          'wrong-chat',
          'This code belongs to another chat, so I cancelled it. Ask for a new approval.',
        );
      case 'malformed':
        return attemptReply(event, 'Use: /approve CODE or /reject CODE');
      case 'none':
        return undefined;
    }
  }

  async function runScheduledImpl(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    scheduleId: string;
    input?: unknown;
  }): Promise<Result<ScriptRunReport | 'skipped', ScriptError>> {
    const noApproved = (): ScriptError => new ScriptNotRunError('not-approved');
    // A scheduled run asks nobody: `approval` runs like `allowed`. `undefined`
    // (persona not loaded) fails closed.
    let permitted = false;
    try {
      const capabilities = deps.capabilities(input.personaId);
      permitted =
        capabilities !== undefined && scriptRunAccess(capabilities, input.scriptName) !== 'denied';
    } catch {
      permitted = false;
    }
    if (!permitted) {
      audit({
        action: 'script.run.refused',
        personaId: input.personaId,
        threadId: input.threadId,
        runId: randomUUID(),
        details: { script: input.scriptName, reason: 'not-permitted' },
      });
      return err(new ScriptNotRunError('not-permitted'));
    }
    const script = repo.findScript(input.personaId, input.scriptName);
    if (script.isErr()) return err(sandbox(script.error));
    if (!script.value) return err(noApproved());
    const scriptId = script.value.id;
    const approved = repo.latestApproved(scriptId);
    if (approved.isErr()) return err(sandbox(approved.error));
    if (!approved.value) return err(noApproved());

    const result = await runLive({
      personaId: input.personaId,
      threadId: input.threadId,
      scriptName: input.scriptName,
      trigger: 'schedule',
      scheduleId: input.scheduleId,
      scriptId,
      versionId: approved.value.id,
      input: input.input,
    });
    if (result.isOk() && result.value === 'active') {
      audit({
        action: 'script.run.skipped',
        personaId: input.personaId,
        threadId: input.threadId,
        runId: randomUUID(),
        details: { script: input.scriptName, scheduleId: input.scheduleId },
      });
      return ok('skipped');
    }
    return result as Result<ScriptRunReport, ScriptError>;
  }

  /**
   * The live run that a schedule and the agent share: the active set, the run
   * row, the provider, the audits. `active` means a run of the script is in flight.
   */
  async function runLive(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    trigger: 'schedule' | 'agent';
    scheduleId?: string;
    scriptId: string;
    versionId: string;
    input?: unknown;
  }): Promise<Result<ScriptRunReport | 'active', ScriptError>> {
    const { scriptId } = input;
    // Only a run of the agent names its trigger in a refusal.
    const tag = input.trigger === 'agent' ? { trigger: 'agent' } : {};
    if (active.has(scriptId)) return ok('active');
    active.add(scriptId);
    let provider: RunProvider | undefined;
    let runId: string | undefined;
    let finished = false;
    let runAudited = false;
    let known: { name: string; version: number } | undefined;
    const runAudit = (runOk: boolean, errorCode: string | null, calls: number): void => {
      if (runId === undefined || runAudited) return;
      runAudited = true;
      audit({
        action: 'script.run',
        personaId: input.personaId,
        threadId: input.threadId,
        runId,
        details: {
          script: known?.name ?? input.scriptName,
          version: known?.version ?? null,
          mode: 'live',
          ok: runOk,
          errorCode,
          calls,
        },
      });
    };
    /** Write audits first, then the row, then the run audit. */
    const conclude = (
      runOk: boolean,
      errorCode: string | null,
      calls: readonly CallRecord[],
    ): void => {
      if (runId === undefined) return;
      for (const call of calls) {
        if (
          call.toolClass === 'write' &&
          (call.outcome === 'executed' || call.outcome === 'aborted')
        ) {
          audit({
            action: 'script.write',
            personaId: input.personaId,
            threadId: input.threadId,
            runId,
            tool: call.name,
            details: { outcome: call.outcome },
          });
        }
      }
      finished = finishRun(runId, runOk, errorCode, calls.length);
      runAudit(runOk, errorCode, calls.length);
    };
    try {
      const loaded = store.load(input.versionId);
      if (loaded.isErr()) return err(loaded.error);
      const version = loaded.value;
      known = { name: version.manifest.name, version: version.version };
      // After the capability check, before a run row or a provider exists.
      const liveInput = resolveRunInput(version.manifest, input.input);
      if (liveInput.isErr()) {
        audit({
          action: 'script.run.refused',
          personaId: input.personaId,
          threadId: input.threadId,
          runId: randomUUID(),
          details: {
            script: input.scriptName,
            version: version.version,
            reason: 'bad-input',
            ...tag,
          },
        });
        return err(new ScriptNotRunError('bad-input', liveInput.error));
      }
      const runRow = startRun(version.versionId, 'live', input.trigger, input.scheduleId);
      if (runRow.isErr()) return err(runRow.error);
      runId = runRow.value;

      const verified = store.verify(version);
      if (verified.isErr()) {
        finished = finishRun(runId, false, 'SCRIPT_FAILED', 0);
        audit({
          action: 'script.run.refused',
          personaId: input.personaId,
          threadId: input.threadId,
          runId,
          details: { script: input.scriptName, version: version.version, ...tag },
        });
        return err(new ScriptNotRunError('changed', verified.error));
      }

      const manifest = version.manifest;
      const created = await deps.createProvider(
        {
          personaId: input.personaId,
          // The thread that saved the version, as in the dry run, so memory tools see the same memory.
          threadId: version.threadId,
          scriptRunId: runId,
          scriptName: manifest.name,
          channels: manifest.channels,
          versionDir: version.dir,
        },
        manifest,
      );
      if (created.isErr()) {
        conclude(false, created.error.scriptCode, []);
        return err(created.error);
      }
      provider = created.value;

      const run = await runScript(broker, {
        manifest: {
          name: manifest.name,
          personaId: input.personaId,
          tools: manifest.tools,
          channels: manifest.channels,
        },
        mode: 'live',
        provider,
        scriptPath: version.scriptPath,
        input: liveInput.value,
        timeoutMs: config.runTimeoutMs,
        maxCalls: config.maxCallsPerRun,
        profile: SCRIPT_PROFILE,
        workspace: SCRIPT_WORKSPACE,
      });
      if (run.isErr()) {
        conclude(false, run.error.scriptCode, []);
        return err(run.error);
      }
      const report = run.value;
      conclude(report.ok, report.ok ? null : (report.errorCode ?? 'SCRIPT_FAILED'), report.calls);
      return ok(report);
    } finally {
      if (runId !== undefined && !finished) {
        // An exception ended the run before its row was finished.
        finishRun(runId, false, 'SANDBOX', 0);
        runAudit(false, 'SANDBOX', 0);
      }
      if (provider) await closeProvider(provider);
      active.delete(scriptId);
    }
  }

  /** A live run for the agent. After `/approve` the stored input goes through the manifest again. */
  async function agentLive(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    scriptId: string;
    versionId: string;
    input?: unknown;
  }): Promise<Result<ScriptRunReport, ScriptError>> {
    const result = await runLive({ ...input, trigger: 'agent' });
    if (result.isErr()) {
      const error = result.error;
      // A bad input keeps the plain error of the input check, not the scheduler's reason.
      if (error instanceof ScriptNotRunError && error.reason === 'bad-input' && error.cause) {
        return err(error.cause as ScriptError);
      }
      return err(error);
    }
    if (result.value === 'active') {
      return err(new ScriptError('SCRIPT_FAILED', 'the script is already running'));
    }
    return ok(result.value);
  }

  async function runByAgentImpl(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    access: 'allowed' | 'approval';
    input?: unknown;
  }): Promise<Result<ScriptRunReport | 'awaiting-approval', ScriptError>> {
    const script = repo.findScript(input.personaId, input.scriptName);
    if (script.isErr()) return err(sandbox(script.error));
    if (!script.value) return err(new ScriptNotRunError('not-approved'));
    const scriptId = script.value.id;
    const approved = repo.latestApproved(scriptId);
    if (approved.isErr()) return err(sandbox(approved.error));
    if (!approved.value) return err(new ScriptNotRunError('not-approved'));
    const versionId = approved.value.id;

    if (input.access === 'allowed') {
      return agentLive({
        personaId: input.personaId,
        threadId: input.threadId,
        scriptName: input.scriptName,
        scriptId,
        versionId,
        ...(input.input !== undefined ? { input: input.input } : {}),
      });
    }

    const loaded = store.load(versionId);
    if (loaded.isErr()) return err(loaded.error);
    const version = loaded.value;
    const resolved = resolveRunInput(version.manifest, input.input);
    if (resolved.isErr()) {
      audit({
        action: 'script.run.refused',
        personaId: input.personaId,
        threadId: input.threadId,
        runId: randomUUID(),
        details: {
          script: input.scriptName,
          version: version.version,
          reason: 'bad-input',
          trigger: 'agent',
        },
      });
      return err(resolved.error);
    }
    const chat = deps.resolveChat(input.threadId);
    if (!chat) {
      return err(
        new ScriptError('INVALID_ARGUMENT', 'this conversation has no chat for an approval'),
      );
    }
    let inputText: string | undefined;
    let payload: string | undefined;
    try {
      inputText =
        input.input !== undefined
          ? JSON.stringify(resolved.value)
          : resolved.value === null
            ? 'none'
            : `${JSON.stringify(resolved.value)} (default of the script)`;
      payload = input.input === undefined ? '{}' : JSON.stringify({ input: resolved.value });
    } catch {
      inputText = undefined;
    }
    if (typeof inputText !== 'string' || typeof payload !== 'string') {
      return err(new ScriptError('INVALID_ARGUMENT', 'the input cannot be shown as JSON'));
    }
    const messageOf = (code: string): string =>
      `The agent wants to run script ${version.manifest.name} (version ${version.version}) now.\n` +
      `Input: ${inputText}\n/approve ${code}\n/reject ${code}`;
    if (messageOf('0'.repeat(CODE_CHARS)).length > MAX_RUN_APPROVAL_CHARS) {
      return err(
        new ScriptError('RESULT_TOO_LARGE', 'the input does not fit in the approval message'),
      );
    }
    const open = repo.findOpenApprovalFor(versionId, 'run', now());
    if (open.isErr()) return err(sandbox(open.error));
    if (
      open.value &&
      open.value.payload === payload &&
      open.value.channel_name === chat.channelName &&
      open.value.external_thread_id === chat.externalThreadId
    ) {
      return ok('awaiting-approval');
    }

    // A new request expires the open run approval of the version.
    const requested = approval.request({
      versionId,
      channelName: chat.channelName,
      externalThreadId: chat.externalThreadId,
      purpose: 'run',
      payload,
    });
    if (requested.isErr()) return err(requested.error);
    let sent: Result<void, ScriptError>;
    try {
      sent = await deps.send(
        chat.channelName,
        chat.externalThreadId,
        messageOf(requested.value.code),
      );
    } catch {
      sent = err(new ScriptError('TOOL_FAILED', 'send threw'));
    }
    if (sent.isErr()) {
      if (approval.expireVersion(versionId, 'run').isErr()) {
        logger.error({ versionId }, 'could not roll back a failed run approval request');
      }
      return err(new ScriptError('TOOL_FAILED', 'the approval message could not be sent'));
    }
    return ok('awaiting-approval');
  }

  async function guard<T>(
    fn: () => Promise<Result<T, ScriptError>>,
  ): Promise<Result<T, ScriptError>> {
    try {
      return await fn();
    } catch (error) {
      logger.error({ err: error }, 'script service failed unexpectedly');
      return err(sandbox());
    }
  }

  return {
    save(input): Result<StoredVersion, ScriptError> {
      try {
        return store.save(input);
      } catch (error) {
        logger.error({ err: error }, 'script save failed unexpectedly');
        return err(sandbox());
      }
    },

    test: (input) => tracked(() => testImpl(input)),

    requestApproval: (input) =>
      closed
        ? Promise.resolve(err(new ScriptError('SANDBOX', 'the script service is closed')))
        : guard(() => requestApprovalImpl(input)),

    matchesInbound(event): boolean {
      try {
        return approval.classify(event) !== 'none';
      } catch {
        return false;
      }
    },

    handleInbound(event): Promise<{ reply?: string } | undefined> {
      try {
        return Promise.resolve(handleInboundImpl(event));
      } catch (error) {
        // `matches` claimed the event, so it can hold a code: keep it away from the agent.
        logger.error(
          { errName: error instanceof Error ? error.name : 'unknown' },
          'script approval handling failed unexpectedly',
        );
        return Promise.resolve({});
      }
    },

    async runScheduled(input): Promise<Result<ScriptRunReport | 'skipped', ScriptError>> {
      const result = await tracked(() => runScheduledImpl(input));
      const key = `${input.personaId}\0${input.scriptName}`;
      if (result.isErr() || (result.value !== 'skipped' && !result.value.ok)) {
        failedScripts.add(key);
      } else if (result.value !== 'skipped') {
        failedScripts.delete(key);
      }
      return result;
    },

    runByAgent: (input) => tracked(() => runByAgentImpl(input)),

    async notifyFailure(input): Promise<void> {
      try {
        const code = KNOWN_CODES.has(input.errorCode) ? input.errorCode : 'SCRIPT_FAILED';
        const name = cleanName(input.scriptName);
        const text = failureText({ name, code, reason: input.reason, scheduled: true });
        const chat = deps.resolveChat(input.threadId);
        const sent = chat
          ? await deps.send(chat.channelName, chat.externalThreadId, text)
          : err(new ScriptError('TOOL_FAILED', 'the thread of the script has no chat'));
        if (sent.isErr()) {
          logger.error({ scriptCode: sent.error.scriptCode }, 'script failure notice not sent');
        }
      } catch (error) {
        logger.error({ err: error }, 'script failure notice failed unexpectedly');
      }
    },

    hasApproved(personaId, scriptName): boolean {
      try {
        const script = repo.findScript(personaId, scriptName);
        if (script.isErr() || !script.value) return false;
        const approved = repo.latestApproved(script.value.id);
        return approved.isOk() && approved.value !== null;
      } catch {
        return false;
      }
    },

    lastScheduledRunFailed(personaId, scriptName): boolean {
      // A run that did not start writes no row, so the database alone cannot tell.
      if (failedScripts.has(`${personaId}\0${scriptName}`)) return true;
      try {
        const script = repo.findScript(personaId, scriptName);
        if (script.isErr() || !script.value) return false;
        const last = repo.lastFinishedRun(script.value.id, 'schedule');
        return last.isOk() && last.value !== null && last.value.ok === 0;
      } catch {
        return false;
      }
    },

    async shutdown(): Promise<void> {
      closed = true;
      try {
        const revoked = [...leases].map(async (leaseId) => {
          leases.delete(leaseId);
          try {
            const result = await deps.broker.revoke(leaseId);
            if (result.isErr()) logger.warn('scripts: a lease could not be revoked at shutdown');
          } catch {
            logger.warn('scripts: a lease could not be revoked at shutdown');
          }
        });
        let timer: NodeJS.Timeout | undefined;
        const bound = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), SHUTDOWN_WAIT_MS);
        });
        const settled = Promise.allSettled([...revoked, ...inFlight]).then(
          () => 'settled' as const,
        );
        const outcome = await Promise.race([settled, bound]);
        clearTimeout(timer);
        if (outcome === 'timeout') {
          logger.warn({ active: inFlight.size }, 'scripts: runs were still active at shutdown');
        }
      } catch (error) {
        logger.error({ err: error }, 'scripts: shutdown failed unexpectedly');
      }
    },

    recoverStaleRuns(): Result<number, ScriptError> {
      try {
        const failed = repo.failOpenRuns(now());
        return failed.isErr() ? err(sandbox(failed.error)) : ok(failed.value);
      } catch (error) {
        logger.error({ err: error }, 'recovering stale script runs failed unexpectedly');
        return err(sandbox());
      }
    },
  };
}
