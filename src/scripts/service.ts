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
import type { ExecutionBroker } from '../execution-broker/index.js';
import type { ApprovalService } from './approval.js';
import { SCRIPT_PROFILE, SCRIPT_WORKSPACE } from './config.js';
import { runScript } from './runner.js';
import type { ScriptStore, ScriptFile, StoredVersion } from './store.js';
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
  /** Sends a text to a chat. Used only for the approval message. */
  send(
    channelName: string,
    externalThreadId: string,
    body: string,
  ): Promise<Result<void, ScriptError>>;
  /** Sends a text to the chat that a thread belongs to. Used for failure notices. */
  notifyThread(threadId: string, body: string): Promise<Result<void, ScriptError>>;
  audit(entry: {
    action: string;
    personaId: string;
    threadId: string;
    runId: string;
    tool?: string;
    details: Record<string, unknown>;
  }): void;
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
  requestApproval(input: {
    personaId: string;
    versionId: string;
    channelName: string;
    externalThreadId: string;
  }): Promise<Result<void, ScriptError>>;
  /** True if the event is an approval command. Synchronous, never throws. */
  matchesInbound(event: InboundEvent): boolean;
  handleInbound(event: InboundEvent): Promise<string | undefined>;
  runScheduled(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    scheduleId: string;
  }): Promise<Result<ScriptRunReport | 'skipped', ScriptError>>;
  notifyFailure(input: { threadId: string; scriptName: string; errorCode: string }): Promise<void>;
  hasApproved(personaId: string, scriptName: string): boolean;
  /** True if the last finished scheduled run of this script was a failure. */
  lastScheduledRunFailed(personaId: string, scriptName: string): boolean;
  /** Marks runs that a crashed daemon left open as failed. Call one time at start. */
  recoverStaleRuns(): Result<number, ScriptError>;
}

const MAX_REPORT_CHARS = 1_000_000;
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
  /** Version ids with a `test` in flight. */
  const testing = new Set<string>();

  const runDeps: RunDeps = {
    broker: deps.broker,
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
    trigger: 'test' | 'dry-run' | 'schedule',
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

  async function requestApprovalImpl(input: {
    personaId: string;
    versionId: string;
    channelName: string;
    externalThreadId: string;
  }): Promise<Result<void, ScriptError>> {
    const owned = loadOwned(input.personaId, input.versionId);
    if (owned.isErr()) return err(owned.error);
    const { version, row } = owned.value;
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

    const requested = approval.request({
      versionId: version.versionId,
      channelName: input.channelName,
      externalThreadId: input.externalThreadId,
    });
    if (requested.isErr()) return err(requested.error);

    const body = buildApprovalSummary({
      name: version.manifest.name,
      version: version.version,
      description: version.manifest.description,
      report,
      code: requested.value.code,
      ttlMinutes: config.approvalTtlMinutes,
    });
    let sent: Result<void, ScriptError>;
    try {
      sent = await deps.send(input.channelName, input.externalThreadId, body);
    } catch {
      sent = err(new ScriptError('TOOL_FAILED', 'send threw'));
    }
    if (sent.isErr()) {
      const expired = repo.expireOpenApprovals(version.versionId, now());
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

  function handleInboundImpl(event: InboundEvent): string | undefined {
    const command = approval.parseCommand(event.content);
    if (!command) return undefined;

    const decided = approval.decide({
      code: command.code,
      decision: command.decision,
      channelName: event.channelName,
      externalThreadId: event.externalThreadId,
    });
    if (decided.isErr()) {
      logger.error({ scriptCode: decided.error.scriptCode }, 'script approval decision failed');
      return 'This code is not valid.';
    }
    const outcome = decided.value;
    if (outcome.outcome === 'refused') return 'This code is not valid.';

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
        },
      });
    }
    const name = cleanName(outcome.scriptName);
    const version = outcome.version ?? 0;
    return outcome.outcome === 'approved'
      ? `Approved: script "${name}" v${version}. It can now run on a schedule.`
      : `Rejected: script "${name}" v${version}.`;
  }

  async function runScheduledImpl(input: {
    personaId: string;
    threadId: string;
    scriptName: string;
    scheduleId: string;
  }): Promise<Result<ScriptRunReport | 'skipped', ScriptError>> {
    const noApproved = (): ScriptError =>
      new ScriptError('SCRIPT_FAILED', 'no approved version of this script');
    const script = repo.findScript(input.personaId, input.scriptName);
    if (script.isErr()) return err(sandbox(script.error));
    if (!script.value) return err(noApproved());
    const scriptId = script.value.id;
    const approved = repo.latestApproved(scriptId);
    if (approved.isErr()) return err(sandbox(approved.error));
    if (!approved.value) return err(noApproved());

    if (active.has(scriptId)) {
      audit({
        action: 'script.run.skipped',
        personaId: input.personaId,
        threadId: input.threadId,
        runId: randomUUID(),
        details: { script: input.scriptName, scheduleId: input.scheduleId },
      });
      return ok('skipped');
    }
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
      const loaded = store.load(approved.value.id);
      if (loaded.isErr()) return err(loaded.error);
      const version = loaded.value;
      known = { name: version.manifest.name, version: version.version };
      const runRow = startRun(version.versionId, 'live', 'schedule', input.scheduleId);
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
          details: { script: input.scriptName, version: version.version },
        });
        return err(verified.error);
      }

      const manifest = version.manifest;
      const created = await deps.createProvider(
        {
          personaId: input.personaId,
          threadId: input.threadId,
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

      const run = await runScript(deps.broker, {
        manifest: {
          name: manifest.name,
          personaId: input.personaId,
          tools: manifest.tools,
          channels: manifest.channels,
        },
        mode: 'live',
        provider,
        scriptPath: version.scriptPath,
        input: manifest.liveInput ?? null,
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

    test: (input) => guard(() => testImpl(input)),

    requestApproval: (input) => guard(() => requestApprovalImpl(input)),

    matchesInbound(event): boolean {
      try {
        return approval.parseCommand(event.content) !== undefined;
      } catch {
        return false;
      }
    },

    handleInbound(event): Promise<string | undefined> {
      try {
        return Promise.resolve(handleInboundImpl(event));
      } catch (error) {
        logger.error({ err: error }, 'script approval handling failed unexpectedly');
        return Promise.resolve(undefined);
      }
    },

    runScheduled: (input) => guard(() => runScheduledImpl(input)),

    async notifyFailure(input): Promise<void> {
      try {
        const code = KNOWN_CODES.has(input.errorCode) ? input.errorCode : 'SCRIPT_FAILED';
        const name = cleanName(input.scriptName);
        const sent = await deps.notifyThread(
          input.threadId,
          `Script "${name}" failed (${code}). It stays scheduled. I will tell you again only if it fails after a success.`,
        );
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
      try {
        const script = repo.findScript(personaId, scriptName);
        if (script.isErr() || !script.value) return false;
        const last = repo.lastFinishedRun(script.value.id, 'schedule');
        return last.isOk() && last.value !== null && last.value.ok === 0;
      } catch {
        return false;
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
