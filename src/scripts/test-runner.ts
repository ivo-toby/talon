import { isDeepStrictEqual } from 'node:util';
import { err, ok, type Result } from 'neverthrow';
import type { ExecutionBroker } from '../execution-broker/index.js';
import { runScript } from './runner.js';
import type { StoredVersion } from './store.js';
import {
  ScriptError,
  type ScriptManifest,
  type ScriptRunReport,
  type ToolClass,
  type ToolProvider,
  type UnitCase,
} from './types.js';

export interface RunDeps {
  broker: Pick<ExecutionBroker, 'createLease' | 'executeStream' | 'revoke'>;
  profile: string;
  workspace: string;
  timeoutMs: number;
  maxCalls: number;
}

export interface UnitOutcome {
  name: string;
  passed: boolean;
  reason?: string;
}

export interface DryRunOutcome {
  report: ScriptRunReport;
  didWork: boolean;
}

function gatewayManifest(version: StoredVersion, personaId: string): ScriptManifest {
  return {
    name: version.manifest.name,
    personaId,
    tools: version.manifest.tools,
    channels: version.manifest.channels,
  };
}

function jsonValue(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return isDeepStrictEqual(jsonValue(a), jsonValue(b));
  } catch {
    return false;
  }
}

function compare(testCase: UnitCase, report: ScriptRunReport): string | undefined {
  const expect = testCase.expect;
  if (expect.ok === false) {
    return report.ok ? 'expected a failure' : undefined;
  }
  if (!report.ok) {
    return `run failed: ${report.errorCode ?? 'SCRIPT_FAILED'}`;
  }
  if (Object.hasOwn(expect, 'result') && !sameJson(expect.result, report.result)) {
    return 'result differs';
  }
  if (Object.hasOwn(expect, 'writes')) {
    const writes = report.calls
      .filter((call) => call.toolClass === 'write')
      .sort((a, b) => a.seq - b.seq)
      .map((call) => ({ name: call.name, input: call.input }));
    if (!sameJson(expect.writes, writes)) {
      return 'writes differ';
    }
  }
  return undefined;
}

/** Runs the cases one after the other. A sandbox failure stops the whole run. */
export async function runUnitCases(
  deps: RunDeps,
  version: StoredVersion,
  personaId: string,
  cases: UnitCase[],
  describe: (name: string) => { toolClass: ToolClass } | undefined,
): Promise<Result<UnitOutcome[], ScriptError>> {
  const tools = new Set(version.manifest.tools);
  const provider: ToolProvider = {
    describe: (name) => (tools.has(name) ? describe(name) : undefined),
    call: () => Promise.resolve(err(new ScriptError('TOOL_FAILED', 'unit runs call no tool'))),
  };
  const outcomes: UnitOutcome[] = [];
  for (const testCase of cases) {
    const run = await runScript(deps.broker, {
      manifest: gatewayManifest(version, personaId),
      mode: 'unit',
      provider,
      scriptPath: version.scriptPath,
      input: testCase.input,
      stubs: testCase.stubs,
      timeoutMs: deps.timeoutMs,
      maxCalls: deps.maxCalls,
      profile: deps.profile,
      workspace: deps.workspace,
    });
    if (run.isErr()) {
      return err(run.error);
    }
    const reason = compare(testCase, run.value);
    outcomes.push(
      reason === undefined
        ? { name: testCase.name, passed: true }
        : { name: testCase.name, passed: false, reason },
    );
  }
  return ok(outcomes);
}

/** One run on real data: read tools run, write tools are recorded and skipped. */
export async function runDryRun(
  deps: RunDeps,
  version: StoredVersion,
  personaId: string,
  provider: ToolProvider,
): Promise<Result<DryRunOutcome, ScriptError>> {
  const run = await runScript(deps.broker, {
    manifest: gatewayManifest(version, personaId),
    mode: 'dry-run',
    provider,
    scriptPath: version.scriptPath,
    input: version.manifest.dryRunInput,
    timeoutMs: deps.timeoutMs,
    maxCalls: deps.maxCalls,
    profile: deps.profile,
    workspace: deps.workspace,
  });
  if (run.isErr()) {
    return err(run.error);
  }
  const report = run.value;
  const didWork =
    report.ok &&
    report.calls.some(
      (call) =>
        call.outcome === 'skipped-dry-run' ||
        (call.toolClass === 'model' && call.outcome === 'executed'),
    );
  return ok({ report, didWork });
}
