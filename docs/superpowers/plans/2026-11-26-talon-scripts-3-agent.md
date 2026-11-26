# Talon Scripts, Part 3: Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent writes a script, tests it, sends it for approval, attaches it to a schedule and starts it. Two capabilities control this: `script.manage` and `script.run`.

**Architecture:** Part 2 built `ScriptService`. Part 3 adds two host tools on top of it: `script_manage` and `script_run`. A small policy module reads the `script.run` labels of a persona. The approval table gets a purpose, so one `/approve` path decides three things: a version, one run, and one schedule change. The `schedule_manage` tool and `talonctl add-schedule` learn the `script` payload. An authoring guide ships as a template that the agent reads on demand.

**Tech Stack:** TypeScript, neverthrow, better-sqlite3, Commander.js, vitest, the script runtime of Parts 1 and 2.

**Spec:** `docs/superpowers/specs/2026-11-25-talon-scripts-design.md`, sections "Run permissions" and "Authoring skill and host tools".

## Scope

Part 3 does not contain the mail intake script. The assistant on `talon-vm` writes it after the deploy, and Ivo approves it. No task of this plan touches `talon-vm`.

Part 3 does not add an input argument to `script_run`. A run that the agent starts uses `liveInput` of the approved manifest, the same as a scheduled run.

## Global Constraints

- All Global Constraints of the Part 2 plan stay in force. Read them in `docs/superpowers/plans/2026-11-25-talon-scripts-2-daemon.md`.
- The capability labels are `script.manage` and `script.run`. The scope of `script.run` is a script name or `*`. An unscoped label is equal to `*`.
- A live run needs a `script.run` label that matches the script, in `allow` or in `requireApproval`. This applies to the agent trigger and to the schedule trigger.
- A matching `script.run` label in `requireApproval` wins over `allow`. For each run that the agent starts, the user must send one `/approve`. If the agent attaches the script to a schedule, the user must also send one `/approve`. A scheduled run never asks.
- The approval of a version is necessary before any live run. No label removes it.
- The model never sees an approval code. A tool result never contains one.
- The persona and the capabilities of a tool call come from the trusted run context. They never come from tool arguments.
- A tool result that holds script output or dry-run data is untrusted data. It is cut to 8,000 characters.
- With `scripts.enabled: false`, both tools return the error `scripts are off` and do nothing.
- No new npm dependency. No new migration: change `021-scripts.sql` in place. The branch is not merged and not deployed, so no database holds migration 021.
- Documents pass the simple-english hook. For an existing file, add no new hits. Commit messages end with the two trailer lines of `implementer-common.md`.

## Review Focus

1. A persona loses `script.run` after a schedule was made. Expected: the next scheduled run does not start, and the chat gets one failure message.
2. The agent asks for a run two times while the first approval is open. Expected: one message in the chat, and the second call returns `awaiting-approval`.
3. The user approves a run after a newer version was approved. Expected: refusal with a text that tells the user to ask again. No run starts.
4. A leaked or malformed code cancels a run approval or a schedule approval. Expected: the state of the version stays `approved`.
5. The agent passes the `versionId` or the script name of a different persona. Expected: the same error as for an unknown script, and no data of the other persona in the result.

## File Structure

| File | Responsibility |
| ---- | -------------- |
| `src/scripts/run-policy.ts` | Read the `script.run` labels of a persona |
| `src/core/database/migrations/021-scripts.sql` | `purpose` and `payload` of an approval, trigger `agent` |
| `src/core/database/repositories/script-repository.ts` | New columns, open-approval lookup, list queries |
| `src/scripts/approval.ts` | Approvals with a purpose |
| `src/scripts/service.ts` | `runByAgent`, `requestScheduleChange`, `listTools`, `list`, `show`, the capability check of a scheduled run |
| `src/scripts/providers/*.ts`, `src/scripts/daemon-provider.ts` | `list()` on a provider, a factory mode that connects all servers |
| `src/tools/host-tools/script-manage.ts` | The `script_manage` tool |
| `src/tools/host-tools/script-run.ts` | The `script_run` tool |
| `src/tools/host-tools/schedule-manage.ts` | The `script` argument |
| `src/tools/tool-filter.ts`, `host-tools-bridge.ts`, `host-tools-mcp-server.ts`, `tool-timeouts.ts` | Registration of the two tools |
| `templates/script-authoring.md` | The guide that the agent reads |
| `templates/tool-instructions/script.manage.md`, `script.run.md` | Short system prompt text for each capability |
| `src/cli/commands/script.ts`, `add-schedule.ts`, `list-schedules.ts` | `talonctl script`, `--script` |

## Controller-owned contract

These names are fixed. Each task uses them as written.

```ts
// src/scripts/run-policy.ts
export type ScriptRunAccess = 'denied' | 'allowed' | 'approval';
export function scriptRunAccess(
  capabilities: ResolvedCapabilities,
  scriptName: string,
): ScriptRunAccess;

// src/scripts/approval.ts
export type ApprovalPurpose = 'version' | 'run' | 'schedule';

// src/scripts/service.ts (additions to ScriptService)
runByAgent(input: {
  personaId: string;
  threadId: string;          // the conversation of the agent
  scriptName: string;
  access: 'allowed' | 'approval';
}): Promise<Result<ScriptRunReport | 'awaiting-approval', ScriptError>>;

requestScheduleChange(input: {
  personaId: string;
  threadId: string;
  scriptName: string;
  change: ScriptScheduleChange;
}): Promise<Result<'awaiting-approval', ScriptError>>;

listTools(input: {
  personaId: string;
  threadId: string;
  name?: string;             // with a name: the input schema of that tool
}): Promise<Result<ScriptToolInfo[], ScriptError>>;

list(personaId: string): Result<ScriptInfo[], ScriptError>;
show(input: { personaId: string; scriptName: string; version?: number }):
  Result<{ info: ScriptVersionInfo; files: ScriptFile[] }, ScriptError>;

export interface ScriptScheduleChange {
  action: 'create' | 'update';
  scheduleId?: string;       // for update
  cronExpr?: string;
  label?: string;
}
export interface ScriptToolInfo {
  name: string;              // the name that a manifest lists
  toolClass: ToolClass;
  description?: string;      // at most 200 characters
  inputSchema?: unknown;     // only with `name`
}
export interface ScriptInfo {
  name: string;
  latest: { version: number; state: VersionState; versionId: string };
  approvedVersion?: number;
  lastRun?: { ok: boolean; errorCode?: string; endedAt: number; trigger: string };
}
export type ScriptVersionInfo = ScriptInfo['latest'] & { name: string; contentHash: string };
```

New dependencies of `ScriptServiceDeps`:

```ts
/** Capabilities of a persona by database ID, or `undefined` if it is not loaded. */
capabilities(personaId: string): ResolvedCapabilities | undefined;
/** Writes an approved schedule change. Bound to the schedule tool by the wiring. */
applyScheduleChange(input: {
  personaId: string; threadId: string; scriptName: string; change: ScriptScheduleChange;
}): Result<{ scheduleId: string }, ScriptError>;
```

`ScriptNotRunReason` gets the value `'not-permitted'`. The trigger of a run that the agent starts is `'agent'`.

---

### Task 1: Run policy

**Files:**
- Create: `src/scripts/run-policy.ts`
- Test: `tests/unit/scripts/run-policy.test.ts`

**Interfaces:**
- Produces: `scriptRunAccess`, `ScriptRunAccess`, `SCRIPT_RUN_CAPABILITY_PREFIX = 'script.run'`.

- [ ] **Step 1: Write the failing tests**

```ts
const caps = (allow: string[], requireApproval: string[] = []) => ({ allow, requireApproval });
expect(scriptRunAccess(caps([]), 'mail-intake')).toBe('denied');
expect(scriptRunAccess(caps(['script.manage:own']), 'mail-intake')).toBe('denied');
expect(scriptRunAccess(caps(['script.run:*']), 'mail-intake')).toBe('allowed');
expect(scriptRunAccess(caps(['script.run']), 'mail-intake')).toBe('allowed');
expect(scriptRunAccess(caps(['script.run:mail-intake']), 'mail-intake')).toBe('allowed');
expect(scriptRunAccess(caps(['script.run:mail-intake']), 'heartbeat')).toBe('denied');
expect(scriptRunAccess(caps(['script.run: mail-intake ']), 'mail-intake')).toBe('allowed');
expect(scriptRunAccess(caps([], ['script.run:*']), 'mail-intake')).toBe('approval');
expect(scriptRunAccess(caps(['script.run:*'], ['script.run:mail-intake']), 'mail-intake')).toBe('approval');
expect(scriptRunAccess(caps(['script.run:*'], ['script.run:mail-intake']), 'heartbeat')).toBe('allowed');
expect(scriptRunAccess(caps(['script.run:Mail-Intake']), 'mail-intake')).toBe('denied');
expect(scriptRunAccess(caps(['script.running:*']), 'mail-intake')).toBe('denied');
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/scripts/run-policy.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `scriptRunAccess`.** Follow the label parsing of `src/personas/persona-delegation.ts`. Check `requireApproval` first.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(scripts): add the run policy for script.run labels`.

### Task 2: Approvals with a purpose

**Files:**
- Modify: `src/core/database/migrations/021-scripts.sql`, `src/core/database/repositories/script-repository.ts`, `src/scripts/approval.ts`
- Test: `tests/unit/core/database/repositories/script-repository.test.ts`, `tests/unit/scripts/approval.test.ts`

**Interfaces:**
- Produces: `ApprovalPurpose`. `ApprovalService.request` takes `purpose?: ApprovalPurpose` (default `'version'`) and `payload?: string`. `Decision` gets `purpose: ApprovalPurpose` and `payload?: string`. `CancelledApproval` gets `purpose`. New repository method `findOpenApprovalFor(versionId: string, purpose: ApprovalPurpose, now: number): Result<ScriptApprovalRow | null, DbError>`.

Schema changes in `021-scripts.sql`:

```sql
-- script_approvals
purpose  TEXT NOT NULL DEFAULT 'version' CHECK (purpose IN ('version', 'run', 'schedule')),
payload  TEXT,                -- JSON of the schedule change, null for other purposes
-- script_runs
trigger  TEXT NOT NULL CHECK (trigger IN ('test', 'dry-run', 'schedule', 'agent')),
```

Rules:

- `request` with purpose `version` behaves as now.
- `request` with purpose `run` or `schedule` needs a version in state `approved`. It never changes the state of the version.
- `decide` for purpose `run` or `schedule` records the decision and leaves the state of the version alone. If the version is not in state `approved`, it refuses.
- `cancelLeaked`, `cancelWrongChat` and the expiry path move a version back to `tested` only for purpose `version`.
- `expireVersion` expires the approvals of all purposes.
- A payload is at most 2,000 characters.

- [ ] **Step 1: Write the failing tests.** One test for each rule above. Add these two:

```ts
it('keeps an approved version approved when a run approval leaks', () => {
  // version approved, request({ purpose: 'run' }), cancelLeaked(message with the code)
  expect(repo.getVersion(versionId)._unsafeUnwrap()?.state).toBe('approved');
  expect(outcome.cancelled[0].purpose).toBe('run');
});
it('returns the payload of a schedule approval on approve', () => {
  expect(decision).toMatchObject({ outcome: 'approved', purpose: 'schedule', payload });
});
```

- [ ] **Step 2: Run both test files.** Expected: FAIL.
- [ ] **Step 3: Implement.** The index that is rebuilt at boot must carry the purpose.
- [ ] **Step 4: Run** `npx vitest run tests/unit/scripts tests/unit/core/database`. Expected: PASS, with the old tests unchanged.
- [ ] **Step 5: Commit** `feat(scripts): give an approval a purpose and a payload`.

### Task 3: Capability check of a scheduled run

**Files:**
- Modify: `src/scripts/service.ts`, `src/scripts/daemon-wiring.ts`, `src/daemon/daemon-bootstrap.ts`
- Test: `tests/unit/scripts/service.test.ts`, `tests/unit/scripts/daemon-wiring.test.ts`

**Interfaces:**
- Consumes: `scriptRunAccess` (Task 1).
- Produces: the `capabilities` dependency of the contract. `ScriptNotRunReason` value `'not-permitted'`.

Rules:

- `runScheduled` reads `deps.capabilities(personaId)` before it verifies the files. If the result is `undefined` or the access is `denied`, it returns `ScriptNotRunError('not-permitted')`. No run row, no provider, one audit entry with `details.reason: 'not-permitted'`.
- The access `approval` runs a scheduled run without a question.
- `notifyFailure` text for the reason: `Script <name> did not run: the persona has no script.run capability for it.`
- The wiring builds `capabilities` from the persona loader. It resolves the database ID to the loaded persona in the same way as `HostToolsBridge.resolvePersonaCapabilities`. Hot reload changes the answer at the next run.

- [ ] **Step 1: Write the failing tests**

```ts
it('does not start a scheduled run without the script.run capability', async () => {
  const result = await service.runScheduled(input);        // capabilities: () => ({ allow: [], requireApproval: [] })
  expect(result._unsafeUnwrapErr()).toMatchObject({ reason: 'not-permitted' });
  expect(createProvider).not.toHaveBeenCalled();
});
it('runs a scheduled run when the label is only in requireApproval', async () => { /* ok: true */ });
it('does not start when the persona is not loaded', async () => { /* 'not-permitted' */ });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Change the fixtures of the old tests and of `tests/integration/script-flow-docker.test.ts` to grant `script.run:*`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/scripts tests/unit/daemon tests/unit/scheduler`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scripts): require script.run for a scheduled run`.

### Task 4: Runs that the agent starts

**Files:**
- Modify: `src/scripts/service.ts`
- Test: `tests/unit/scripts/service.test.ts`

**Interfaces:**
- Consumes: Task 2 (`purpose: 'run'`), the run path of `runScheduled`.
- Produces: `runByAgent` of the contract.

Rules:

- The run uses the newest approved version, `store.verify`, the active set, the run row and the audit entries of `runScheduled`. Put the shared part in one private function. The trigger is `'agent'` and `schedule_id` is null.
- No approved version: `ScriptNotRunError('not-approved')`. A run of the same script is active: `SCRIPT_FAILED` with the message `the script is already running`.
- `access: 'allowed'`: run now and return the report.
- `access: 'approval'`: resolve the chat with `resolveChat(input.threadId)`. No chat: `INVALID_ARGUMENT`, `this conversation has no chat for an approval`. If an open run approval exists for the version (`findOpenApprovalFor`), send nothing and return `'awaiting-approval'`. Else create the approval and send this text:

```
<persona agent> wants to run script <name> (version <n>) now.
/approve <code>
/reject <code>
```

- `handleInbound` with a decision of purpose `run`:
  - `rejected`: reply `Script <name> was not started.`
  - `approved`, and the version is not the newest approved version: reply `Script <name> changed after this request. Ask again.` No run.
  - `approved`: start the run and do not wait for it. Reply `Script <name> started.` At the end, send `Script <name> finished.` or the failure text of `notifyFailure` to the same chat.
- A run that the agent starts does not change `lastScheduledRunFailed`.
- `shutdown` also waits for these runs.

- [ ] **Step 1: Write the failing tests.** One test for each rule. Include Review Focus 2 and 3:

```ts
it('sends one message for two requests while the approval is open', async () => {
  expect((await service.runByAgent(approvalInput))._unsafeUnwrap()).toBe('awaiting-approval');
  expect((await service.runByAgent(approvalInput))._unsafeUnwrap()).toBe('awaiting-approval');
  expect(send).toHaveBeenCalledTimes(1);
});
it('refuses an approved run when a newer version is approved', async () => {
  const reply = await service.handleInbound(approveEvent(code));
  expect(reply?.reply).toContain('Ask again');
  expect(createProvider).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/scripts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scripts): let the agent start an approved script`.

### Task 5: List, show and tool listing

**Files:**
- Modify: `src/scripts/service.ts`, `src/scripts/store.ts`, `src/scripts/types.ts`, `src/scripts/providers/host-tools.ts`, `mcp.ts`, `judge.ts`, `composite.ts`, `src/scripts/daemon-provider.ts`, `src/core/database/repositories/script-repository.ts`
- Test: the matching files in `tests/unit/scripts/` and `tests/unit/core/database/repositories/`

**Interfaces:**
- Produces: `list`, `show`, `listTools` of the contract. `ScriptStore.readFiles(version: StoredVersion): Result<ScriptFile[], ScriptError>`. `RunProvider.list(): ScriptToolInfo[]`. `RunProvider.inputSchema(name: string): unknown`. `ProviderFactory` takes a third argument `options?: { allServers?: boolean }`. Repository methods `listScripts(personaId)`, `listVersions(scriptId)`, `getVersionByNumber(scriptId, version)`, `listRuns(scriptId, limit)`.

Rules:

- `list` and `show` read only the scripts of `personaId`. A name of a different persona gives the same error as an unknown name: `INVALID_ARGUMENT`, `unknown script`.
- `show` without `version` returns the newest version. `readFiles` verifies the hash first. Changed files give the error of `store.verify`.
- `listTools` opens a provider with `allServers: true` and a manifest with no tools, reads `list()`, and closes the provider in a `finally`. If the persona has no judge, `model.judge` is not in the list.
- `listTools` with `name` returns one entry with `inputSchema`. Without `name`, no entry has a schema.
- A description is cut to 200 characters. The list is sorted by name.
- An MCP server that does not connect makes `listTools` fail with `TOOL_FAILED`. The message names no server detail.

- [ ] **Step 1: Write the failing tests.** Cover each rule, and Review Focus 5 for `show`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/scripts tests/unit/core/database`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scripts): list scripts, show a version and list script tools`.

### Task 6: The `script_manage` tool and the authoring guide

**Files:**
- Create: `src/tools/host-tools/script-manage.ts`, `templates/script-authoring.md`, `templates/tool-instructions/script.manage.md`
- Modify: `src/tools/tool-filter.ts`, `src/tools/host-tools-bridge.ts`, `src/tools/host-tools-mcp-server.ts`, `src/tools/tool-timeouts.ts`, `src/tools/index.ts`, `src/scripts/daemon-wiring.ts`, `src/daemon/daemon-bootstrap.ts`, `package.json`
- Test: `tests/unit/tools/host-tools/script-manage.test.ts`, `tests/unit/tools/tool-filter.test.ts`

**Interfaces:**
- Consumes: `ScriptService` (`save`, `test`, `requestApproval`, `list`, `show`, `listTools`).
- Produces: registry entry `{ capabilityPrefix: 'script.manage', internalName: 'script.manage', mcpName: 'script_manage' }`. `HostToolsBridge.setScriptService(service: ScriptService | null): void`. `SCRIPT_TOOL_REQUEST_TIMEOUT_MS = 11 * 60 * 1000` in `tool-timeouts.ts`, used for `script.manage` and `script.run`.

Arguments: `action` is one of `guide`, `tools`, `save`, `test`, `request_approval`, `list`, `show`.

| Action | Arguments | Result |
| ------ | --------- | ------ |
| `guide` | none | The text of `templates/script-authoring.md` |
| `tools` | `name?` | `ScriptToolInfo[]` |
| `save` | `files: { path, content }[]` | `{ versionId, name, version, state }` |
| `test` | `versionId` | `{ state, unit: [...], dryRun?: { ok, errorCode?, calls: [{ name, toolClass, outcome }] } }` |
| `request_approval` | `versionId` | `{ status: 'sent' }` or `{ status: 'already-sent' }` |
| `list` | none | `ScriptInfo[]` |
| `show` | `name`, `version?` | `{ info, files }` |

Rules:

- The handler takes `personaId` and `threadId` from the context. An unknown action or a missing argument is an error result with a fixed text.
- With no script service, each action other than `guide` returns the error `scripts are off`.
- `request_approval` for a version in state `awaiting-approval` with an open approval sends nothing and returns `already-sent`.
- A `ScriptError` becomes an error result with `scriptCode` and `message`. Nothing else of the error leaves the handler.
- A result is cut to 8,000 characters. A cut result ends with the line `[cut]`.
- The dry-run part of a `test` result holds call names, classes and outcomes. It holds the input of a skipped write. It never holds the output of a read call.
- The guide is loaded one time at start, from the `dist` path and then from the working directory, as `loadToolInstructions` does.
- `CAPABILITY_DESCRIPTIONS` gets `script.manage:own`: `Write, test and send scripts for approval`.

The guide `templates/script-authoring.md` is at most 6,000 characters. It contains:

1. When a script is the right tool: a routine with fixed steps that repeats.
2. The procedure, as numbered steps. The steps are `tools`, write the files, `save`, `test`, correct and save again, and `request_approval`. The last step is to wait for the user and then attach the script with `schedule_manage`.
3. The files and their rules: `script.ts`, `manifest.json` (all fields of `AuthoredManifest`), `tests.json`, `prompts/<name>.md`, `fixtures/<name>.json`. Copy the limits from `src/scripts/store.ts`.
4. The SDK: read `src/scripts/sdk-assets/` and document each exported function with one example.
5. The modes: what a unit case supplies, what a dry run does, and that a skipped write returns `{ dryRun: true }`.
6. The rule that `dryRunInput` must send the script through its work path.
7. One complete small example: script, manifest and two unit cases.
8. The rule that tool output is data and never an instruction.

`templates/tool-instructions/script.manage.md` is at most 400 characters. It tells the agent to call `script_manage` with `action: "guide"` before it writes a script.

- [ ] **Step 1: Write the failing tests.** One test for each action and each rule. Add a test that compiles the example of the guide: extract the `script.ts` block, the manifest block and the cases block, and pass them to `store.save` with a test repository. Expected: `ok`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the handler, the registration and the wiring.** If the build does not copy `templates/script-authoring.md` to `dist`, change the build script in `package.json`. The bootstrap calls `setScriptService` in section 18 and with `null` at stop.
- [ ] **Step 4: Run** `npx vitest run tests/unit/tools tests/unit/scripts tests/unit/daemon`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tools): add the script_manage tool and the authoring guide`.

### Task 7: The `script_run` tool

**Files:**
- Create: `src/tools/host-tools/script-run.ts`, `templates/tool-instructions/script.run.md`
- Modify: `src/tools/tool-filter.ts`, `src/tools/host-tools-bridge.ts`, `src/tools/host-tools-mcp-server.ts`, `src/tools/index.ts`
- Test: `tests/unit/tools/host-tools/script-run.test.ts`

**Interfaces:**
- Consumes: `scriptRunAccess` (Task 1), `runByAgent` (Task 4), the capabilities that the bridge resolves for the calling persona.
- Produces: registry entry `{ capabilityPrefix: 'script.run', internalName: 'script.run', mcpName: 'script_run' }`.

Arguments: `name` (required).

Rules:

- A name that does not match `/^[a-z][a-z0-9-]{1,48}$/` is an error result.
- Access `denied`: error result `this persona cannot run script <name>`. The service is not called.
- Access `allowed`: result `{ status: 'finished', ok, errorCode?, callCount, result }`. `result` is the JSON text of the script result, cut to 8,000 characters.
- Access `approval`: result `{ status: 'awaiting-approval' }` with the text `The user must approve this run in the chat. Do not call the tool again for this request.`
- `CAPABILITY_DESCRIPTIONS` gets `script.run:*` (`Run any approved script of the persona`) and `script.run:<script-name>` (`Run that one approved script. In requireApproval: ask the user for each run that the agent starts`).
- The instruction file is at most 400 characters.

- [ ] **Step 1: Write the failing tests.** One for each rule.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/tools`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tools): add the script_run tool`.

### Task 8: Script schedules from the agent

**Files:**
- Modify: `src/tools/host-tools/schedule-manage.ts`, `src/tools/host-tools-mcp-server.ts`, `src/tools/host-tools-bridge.ts`, `src/scripts/service.ts`, `src/scripts/daemon-wiring.ts`
- Test: `tests/unit/tools/host-tools/schedule-manage.test.ts`, `tests/unit/scripts/service.test.ts`

**Interfaces:**
- Consumes: `scriptRunAccess`, Task 2 (`purpose: 'schedule'`), `hasApproved`.
- Produces: `ScheduleManageArgs.script?: string`. `requestScheduleChange` and `applyScheduleChange` of the contract. `ScheduleManageHandler.applyScriptChange(input): Result<{ scheduleId: string }, ToolError>`, which the wiring binds to `applyScheduleChange`.

Rules for `create` and `update` with `script`:

- `script` with `prompt` or `promptFile` is an error. The name must match the name pattern.
- With no script service: error `scripts are off`.
- Access `denied`: error. No approved version: error `script <name> has no approved version`.
- Access `allowed`: write the schedule now, with payload `{ label, script }`.
- Access `approval`: call `requestScheduleChange`. It sends this text to the chat of the conversation, and the tool returns `{ status: 'awaiting-approval' }`:

```
<persona agent> wants to run script <name> on this schedule: <cronExpr> (<label>).
/approve <code>
/reject <code>
```

- On `/approve`, the service calls `applyScheduleChange` with the stored payload and replies `Schedule for script <name> saved.` On a failure it replies `The schedule for script <name> was not saved.` On `/reject` it replies `The schedule was not changed.`
- One open schedule approval for each version. A second request returns `awaiting-approval` and sends nothing.
- An `update` that changes a prompt schedule to a script schedule, or a script schedule to a different script, follows the same rules. An `update` that changes only `cronExpr` or `label` of a script schedule also follows them.
- `cancel`, `delete` and `list` need no approval. `list` shows `script` for a script schedule.
- If the version is not the newest approved version at decide time, the schedule approval is refused.

- [ ] **Step 1: Write the failing tests.** One for each rule.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `execute` becomes async for the script path. The prompt path stays synchronous inside.
- [ ] **Step 4: Run** `npx vitest run tests/unit/tools tests/unit/scripts tests/unit/scheduler`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tools): let schedule_manage attach an approved script`.

### Task 9: `talonctl`

**Files:**
- Create: `src/cli/commands/script.ts`
- Modify: `src/cli/commands/add-schedule.ts`, `src/cli/commands/list-schedules.ts`, `src/cli/index.ts`
- Test: `tests/unit/cli/script.test.ts`, the tests of the two changed commands

**Interfaces:**
- Consumes: the repository methods of Task 5.
- Produces: `listScripts`, `showScript`, `listScriptRuns` as pure functions, in the style of `listSchedules`.

Commands:

- `talonctl script list [--persona <name>]`: persona, name, newest version and state, approved version, last run.
- `talonctl script show <persona> <name> [--version <n>] [--code]`: the versions with state and hash. With `--code`, the files of the version from `scripts.root`.
- `talonctl script runs <persona> <name> [--limit <n>]`: default 20. Trigger, mode, result, error code, call count, start time.
- `talonctl add-schedule --script <name>`: excludes `--prompt` and `--prompt-file`. If the persona has no script with that name, it fails. If no version is approved, it prints a warning. It needs no approval.
- `talonctl list-schedules` shows the script name of a script schedule.

The commands read the database directly. They do not need a running daemon.

- [ ] **Step 1: Write the failing tests** for the pure functions.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): add talonctl script and script schedules`.

### Task 10: Full flow test and documents (controller)

**Files:**
- Modify: `tests/integration/script-flow-docker.test.ts`, `README.md`, `CLAUDE.md`, `config/talond.example.yaml`, `.claude/skills/manage-schedules/SKILL.md`, `.claude/skills/talon-setup/SKILL.md`

- [ ] **Step 1: Extend the Docker test.** Drive the flow through `HostToolsBridge` with the dispatch that an agent call uses: `script_manage` `save`, `test`, `request_approval`, then `/approve` through the pipeline handler, then `script_run`. Run it for a persona with `allow: ['script.manage:own', 'script.run:*']` and for one with the `script.run` label in `requireApproval`. For the second persona, make sure that the run starts only after `/approve`. Add the schedule path of Task 8 for both.
- [ ] **Step 2: Run** `TALON_SCRIPT_IT_IMAGE=<digest> npx vitest run tests/integration/script-flow-docker.test.ts`. Expected: PASS, and no container with the label `talon.broker=1` stays behind.
- [ ] **Step 3: Update the documents.** README: the two capabilities, the meaning of `requireApproval`, the two tools, `talonctl script`, the stop procedure (remove the label or the schedule). CLAUDE.md: tool count, command count, the `script.run` rule. Example configuration: a commented `script.manage:own` and `script.run:*`. The two Claude skills: script schedules and the capabilities.
- [ ] **Step 4: Run** `npx tsc --noEmit`, `npm run lint` and the unit tests of the changed modules. Expected: clean.
- [ ] **Step 5: Commit** `docs(scripts): document the agent tools and the run permissions`.

## After the plan

Ivo deploys the branch to `talon-vm` and sets `scripts.enabled`, the image digest and the two capabilities for the `assistant` persona. He then asks the assistant for the mail intake routine. The assistant writes the script, and Ivo approves it from the dry-run summary. This step is the test of the first slice of the spec. It needs a decision of Ivo for each action on `talon-vm`.
