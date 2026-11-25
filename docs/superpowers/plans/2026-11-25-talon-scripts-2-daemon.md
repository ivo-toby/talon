# Talon Scripts, Part 2: Daemon Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stored script goes from saved files to an approved version. A schedule runs that version in `live` mode inside the Talon daemon, with real tools and one model request.

**Architecture:** Part 1 built the runtime in `src/scripts/` (runner, gateway, protocol, SDK). Part 2 adds the tool providers behind the gateway, a script store with versions and a test runner. It also adds the `/approve` path in the message pipeline and a schedule payload that names a script. A `ScriptService` connects these parts. If `scripts.enabled` is true, the daemon bootstrap builds it.

**Tech Stack:** TypeScript, neverthrow, better-sqlite3, zod 4, `@mastra/mcp` `MCPClient`, `ai` with `@ai-sdk/openai-compatible`, the execution broker of this branch, vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-talon-scripts-design.md`

## Scope

Part 2 does not contain the host tools for the agent, the authoring skill, the `talonctl` commands or the mail intake script. Part 3 adds them. At the end of Part 2 the full flow works from code and from tests: save, unit tests, dry run, approval request, `/approve`, schedule, live run.

## Global Constraints

- Functions that can fail return a neverthrow `Result`. No throw crosses a module boundary.
- A `ScriptError` message never contains tool input, tool output, script text, a lease ID, a host path or an approval code.
- A tool with no class information is a `write` tool. A `write` tool runs only in `live` mode.
- Script code that a model wrote never runs inside the Talon process. The daemon only reads script files as bytes and as JSON.
- A script has the tool rights of its persona and no more. A live run is held to the tools and channels of the approved manifest.
- An approval is bound to one content hash. The model has no path to an approval decision and never sees an approval code.
- Mail and other tool results are untrusted data. They never become a system prompt and never select a tool.
- With `scripts.enabled: false`, the daemon behaves as before this plan. This is the default.
- The `scripts` configuration is fixed for the process lifetime. Hot reload keeps the running values and warns, as for `images`.
- No new npm dependency. Migration number is `021`.
- Documents pass the simple-english hook. Commit messages end with the two trailer lines of `implementer-common.md`.

## Review Focus

1. A script edits its files after approval. Expected: the live run compares the content hash with the approved hash and refuses to run.
2. A user sends `/approve` with a code from a different chat, or a code that was used. Expected: refusal, and the version state does not change.
3. A persona loses a capability or a skill after approval. Expected: the live call fails with `UNKNOWN_TOOL`. The approved manifest does not grant rights.
4. An MCP server does not start or hangs. Expected: the run ends with a failed call inside the time limit, and the daemon stays up.
5. A schedule fires while the previous run of the same script is active. Expected: the new run is skipped and recorded.

## File Structure

| File | Responsibility |
| ---- | -------------- |
| `src/core/config/config-schema.ts` | `scripts` section |
| `src/scripts/config.ts` | Build the broker allowlist and backend options from the `scripts` section |
| `src/core/database/migrations/021-scripts.sql` | Tables `scripts`, `script_versions`, `script_approvals`, `script_runs` |
| `src/core/database/repositories/script-repository.ts` | All SQL for the four tables |
| `src/scripts/store.ts` | Script files on disk, content hash, version states |
| `src/scripts/providers/host-tools.ts` | `talon.*` tools through the host-tools bridge |
| `src/scripts/providers/mcp.ts` | MCP tools of the persona, one client per run |
| `src/scripts/providers/judge.ts` | `model.judge` |
| `src/scripts/providers/composite.ts` | Route a tool name to one provider |
| `src/scripts/test-runner.ts` | Unit cases and the dry run |
| `src/scripts/summary.ts` | Text of the approval message |
| `src/scripts/approval.ts` | Codes and decisions |
| `src/scripts/service.ts` | `ScriptService`: the operations that Part 3 tools call |
| `src/pipeline/message-pipeline.ts` | Hand `/approve` and `/reject` to an injected handler |
| `src/scheduler/scheduler.ts`, `schedule-types.ts` | Payload form that names a script |
| `src/daemon/daemon-bootstrap.ts`, `daemon-context.ts`, `daemon.ts` | Build and connect the service |

## Controller-owned contract

The controller commits these types before Task 3. Implementers do not change them.

```ts
// src/scripts/types.ts (additions)
export interface ScriptManifest {
  name: string;
  personaId: string;
  tools: string[];
  /** Channel names that talon.channel_send can use. Default: none. */
  channels?: string[];
}

/** manifest.json as the author writes it. The store adds personaId. */
export interface AuthoredManifest {
  name: string;          // /^[a-z][a-z0-9-]{1,48}$/
  description: string;   // 1 to 500 characters
  tools: string[];       // at most 50
  channels: string[];    // at most 5
  dryRunInput: unknown;  // input of the dry run
  liveInput?: unknown;   // input of a scheduled run, default null
}

export type VersionState =
  | 'draft' | 'tested' | 'awaiting-approval' | 'approved' | 'rejected' | 'retired';

export interface RunContext {
  personaId: string;
  threadId: string;
  scriptRunId: string;
  scriptName: string;
  channels: string[];
  /** Absolute directory of the version, for prompt files of model.judge. */
  versionDir: string;
}

/** A provider that holds resources for one run. */
export interface RunProvider extends ToolProvider {
  close(): Promise<void>;
}
```

Tool names in a script:

| Name | Class | Maps to |
| ---- | ----- | ------- |
| `talon.memory_read` `{ key, namespace? }` | read | `memory.access` with `operation: 'read'` |
| `talon.memory_list` `{ namespace? }` | read | `memory.access` with `operation: 'list'` |
| `talon.memory_write` `{ key, value, namespace? }` | write | `memory.access` with `operation: 'write'` |
| `talon.memory_delete` `{ key, namespace? }` | write | `memory.access` with `operation: 'delete'` |
| `talon.channel_list` `{}` | read | `channel.list` |
| `talon.channel_send` `{ channelId, content, externalChatId? }` | write | `channel.send` |
| `model.judge` `{ prompt, input, schema }` | model | one model request |
| `<server>.<tool>` | from `readOnlyHint` or the configuration | MCP tool of the persona |

The name splits at the first dot. An MCP server named `talon` or `model` is not reachable from a script.

Version directory on disk: `<scripts.root>/<scriptId>/v<version>/`. The container sees it as `/scripts/<scriptId>/v<version>/`. Files: `script.ts`, `manifest.json`, `tests.json`, optional `prompts/*.md` and `fixtures/*.json`.

`tests.json` is the unit test file. The host runs each case as one run in `unit` mode and compares the outcome. No test code runs anywhere.

```ts
interface UnitCase {
  name: string;
  input: unknown;
  stubs: Record<string, unknown[]>;
  expect: {
    ok?: boolean;                                   // default true
    result?: unknown;                               // deep equal, if present
    writes?: Array<{ name: string; input: unknown }>; // exact ordered list of write-class calls, if present
  };
}
// tests.json: { cases: UnitCase[] } with 1 to 20 cases
```

---

### Task 1: `scripts` configuration and broker setup

**Files:** Modify `src/core/config/config-schema.ts`, `config/talond.example.yaml`. Create `src/scripts/config.ts`. Test `tests/unit/scripts/config.test.ts`, and the existing test file of the configuration schema.

**Interfaces, produces:**

```ts
// config-schema.ts
ScriptsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  root: z.string().default('data/scripts'),
  image: z.string().default(''),              // 'name@sha256:<64 hex>'
  dockerSocket: z.string().default('/var/run/docker.sock'),
  runTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  maxCallsPerRun: z.number().int().min(1).max(2000).default(200),
  judgeTimeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
  approvalTtlMinutes: z.number().int().min(5).max(10_080).default(1440),
  toolClasses: z.record(z.string(), z.enum(['read', 'write'])).default({}),
})
// src/scripts/config.ts
export const SCRIPT_PROFILE = 'script';
export const SCRIPT_WORKSPACE = 'scripts';
export function buildScriptBroker(
  config: ScriptsConfig, personaIds: string[],
): Result<ExecutionBroker, ScriptError>;
```

- [ ] **Step 1:** Tests. `enabled: true` with an image that is not digest-pinned fails the configuration load (in `superRefine`). Defaults parse from `{}`. `buildScriptBroker` gives one profile `script`, one workspace `scripts` with `mode: 'ro'` and `mountTarget: '/scripts'`, and one grant per persona with the same ID as parent and worker. A relative `root` resolves against the working directory. A `root` that is not present gives `INVALID_ARGUMENT`.
- [ ] **Step 2:** Implement. The profile uses `maxTimeoutMs: runTimeoutMs`, `outputCapChars: 10_000`, `maxArgvCount: 8`, `maxArgvChars: 1_000`, `maxConcurrentExecsPerLease: 1`, `maxActiveLeases: 4`. The backend options are those of `tests/integration/script-runtime-docker.test.ts`.
- [ ] **Step 3:** Add the section to `config/talond.example.yaml` with a comment block, after `images`.
- [ ] **Step 4:** Commit `feat(scripts): add the scripts configuration section`.

### Task 2: Migration and repository

**Files:** Create `src/core/database/migrations/021-scripts.sql`, `src/core/database/repositories/script-repository.ts`. Modify `repositories/index.ts`. Test `tests/unit/core/database/repositories/script-repository.test.ts`.

Tables:

- `scripts(id PK, persona_id FK cascade, name, created_at, UNIQUE(persona_id, name))`
- `script_versions(id PK, script_id FK cascade, version INTEGER, content_hash, manifest JSON, state CHECK in the six states, thread_id, dry_run_report JSON NULL, created_at, updated_at, UNIQUE(script_id, version))`
- `script_approvals(id PK, version_id FK cascade, code_hash UNIQUE, channel_name, external_thread_id, expires_at, decided_at NULL, decision NULL CHECK in ('approved','rejected'), created_at)`
- `script_runs(id PK, version_id FK cascade, mode, trigger CHECK in ('test','dry-run','schedule'), schedule_id NULL, ok INTEGER NULL, error_code NULL, call_count INTEGER, started_at, ended_at NULL)`

**Interfaces, produces.** Each method returns `Result<_, DbError>`.

- `upsertScript(personaId, name)`, `findScript(personaId, name)`
- `insertVersion(input)`. The version is the highest plus 1, in one transaction.
- `getVersion(id)`, `latestVersion(scriptId)`, `latestApproved(scriptId)`
- `setVersionState(id, from: VersionState[], to)`. If the current state is not in `from`, it returns `false`.
- `setDryRunReport(id, json)`
- `insertApproval(input)`, `findOpenApproval(codeHash)`, `expireOpenApprovals(versionId)`
- `decideApproval(id, decision, now)`. One transaction sets the approval and moves the version from `awaiting-approval`. On `approved` it also sets the older `approved` version of the same script to `retired`.
- `insertRun(input)`, `finishRun(id, ok, errorCode, callCount, now)`, `activeRun(scriptId)`, `lastFinishedRun(scriptId, trigger)`

- [ ] **Step 1:** Tests with `createTestDb()` for each method, the version counter and the state guard. Also test the `decideApproval` transaction with the retire rule, a second decision on the same approval, and the cascade on persona delete.
- [ ] **Step 2:** Implement in the style of `message-ref-repository.ts`. Use `runLedgerTransaction` for the two transactions.
- [ ] **Step 3:** Commit `feat(scripts): add script tables and repository`.

### Task 3: Script store

**Files:** Create `src/scripts/store.ts`. Test `tests/unit/scripts/store.test.ts`.

**Interfaces, produces:**

```ts
export interface ScriptFile { path: string; content: string }
export interface StoredVersion {
  versionId: string; scriptId: string; version: number;
  contentHash: string; manifest: AuthoredManifest; state: VersionState;
  dir: string;          // absolute host directory
  scriptPath: string;   // '<scriptId>/v<n>/script.ts'
  threadId: string;
}
export function createScriptStore(options: { root: string; repo: ScriptRepository }): ScriptStore;
interface ScriptStore {
  save(input: { personaId: string; threadId: string; files: ScriptFile[] }): Result<StoredVersion, ScriptError>;
  load(versionId: string): Result<StoredVersion, ScriptError>;
  /** Reads the files again and compares the hash with the stored hash. */
  verify(version: StoredVersion): Result<void, ScriptError>;
  readUnitCases(version: StoredVersion): Result<UnitCase[], ScriptError>;
  hashFiles(files: ScriptFile[]): string;
}
```

Rules: 2 to 20 files, at most 262,144 bytes in total. Each path matches `/^(script\.ts|manifest\.json|tests\.json|prompts\/[a-z0-9-]+\.md|fixtures\/[a-z0-9-]+\.json)$/`. `script.ts`, `manifest.json` and `tests.json` are required. `manifest.json` and `tests.json` parse with zod schemas for `AuthoredManifest` and `UnitCase`. The hash is SHA-256 over the files sorted by path, as `path`, a zero byte, the content length, a zero byte, and the content. Files are written with mode `0o644` and directories with `0o755`. A save with the same hash as the latest version returns that version and writes nothing. A new error code is not necessary: use `INVALID_ARGUMENT` for bad input and `SANDBOX` for a file-system failure. If the hash differs or a file is extra, `verify` returns `SCRIPT_FAILED` with a fixed message.

- [ ] **Step 1:** Tests for each rule and for hash stability across file order. Test `verify` after a changed byte, an added file and a removed file. Test a path that tries to leave the directory.
- [ ] **Step 2:** Implement. **Step 3:** Commit `feat(scripts): add the script store with content hash and versions`.

### Task 4: SDK additions (controller commits the types first)

**Files:** Modify `src/scripts/sdk-assets/index.js`, `index.d.ts`. Test `tests/unit/scripts/sdk.test.ts`.

**Interfaces, produces** in the `talon` module:

```ts
export const memory: {
  read(key: string, namespace?: string): Promise<unknown>;
  list(namespace?: string): Promise<unknown>;
  write(key: string, value: unknown, namespace?: string): Promise<unknown>;
  delete(key: string, namespace?: string): Promise<unknown>;
};
export function notify(channelId: string, content: string, externalChatId?: string): Promise<unknown>;
export const model: {
  judge(request: { prompt: string; input: unknown; schema: object }): Promise<unknown>;
};
```

Each is a thin wrapper over `call` with the names of the contract table.

- [ ] **Step 1:** Tests: each helper sends the right `call` line. **Step 2:** Implement. **Step 3:** Commit `feat(scripts): add memory, notify and model helpers to the SDK`.

### Task 5: Host tool provider

**Files:** Modify `src/tools/host-tools-bridge.ts`. Create `src/scripts/providers/host-tools.ts`. Tests `tests/unit/scripts/providers/host-tools.test.ts` and the bridge test file.

**Interfaces, produces:**

```ts
// HostToolsBridge, new public method. Applies the same capability check and
// time limit as handleRequest. It skips the socket authentication only.
executeInProcess(tool: string, args: Record<string, unknown>,
  context: ToolExecutionContext): Promise<ToolCallResult>;

export interface HostToolExecutor {
  executeInProcess: HostToolsBridge['executeInProcess'];
}
export function createHostToolProvider(
  executor: HostToolExecutor, context: RunContext): ToolProvider;
```

Rules: `describe` knows only the six `talon.*` names. Input is checked with a zod schema per tool before the call, and a bad input gives `INVALID_ARGUMENT`. `talon.channel_send` with a `channelId` that is not in `context.channels` gives `NOT_IN_MANIFEST` and does not call the executor. A `ToolCallResult` with status `error` or `timeout` gives `TOOL_FAILED` with a fixed message. A denied capability gives `UNKNOWN_TOOL`. The `ToolExecutionContext` uses `runId: context.scriptRunId`.

- [ ] **Step 1:** Tests for the mapping of each name, the channel rule, the error mapping, and for `executeInProcess`: a persona without `memory.access` is refused, and a persona with it reaches the handler.
- [ ] **Step 2:** Implement. Read `handleRequest` and share its capability and time-limit code with the new method. Do not change the behavior of the socket path.
- [ ] **Step 3:** Commit `feat(scripts): reach host tools from a script run`.

### Task 6: MCP provider

**Files:** Create `src/scripts/providers/mcp.ts`. Test `tests/unit/scripts/providers/mcp.test.ts`.

**Interfaces, produces:**

```ts
export interface McpClientLike {
  listToolsets(): Promise<Record<string, Record<string, McpToolLike>>>;
  disconnect(): Promise<void>;
}
export interface McpToolLike {
  execute(input: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  mcp?: { annotations?: { readOnlyHint?: boolean } };
}
export function createMcpProvider(options: {
  servers: Record<string, SerializableMcpServer>;
  toolClasses: Record<string, 'read' | 'write'>;
  connectTimeoutMs: number;                       // 20_000 from the service
  createClient?: (servers: unknown) => McpClientLike; // default: Mastra MCPClient
}): Promise<Result<RunProvider, ScriptError>>;
```

Rules: The client is created one time per run and `close()` disconnects it. `close()` never rejects and has a 5 second limit. The class of `<server>.<tool>` comes from three sources in this order: the `toolClasses` entry, then `read` for `readOnlyHint === true`, then `write`. A tool that the server configuration excludes with `allowedTools` is not described. A connect failure or a connect time-out gives `err` with `TOOL_FAILED`. A tool that throws gives `TOOL_FAILED` with a fixed message. The abort signal goes to the tool call. An aborted call resolves with `TOOL_FAILED` inside 1 second after the abort. This also applies to a tool that ignores the signal. Server names `talon` and `model` are dropped. Read `src/providers/openai-compatible/agent-cli/index.ts` and `mcp-tool-limits.ts` for the exact way the existing code builds the client, and reuse `toMastraMcpServers`.

- [ ] **Step 1:** Tests with a fake client for each rule. One test with the real `MCPClient` and a small local stdio server in a fixture file: list, call, class from annotation, disconnect.
- [ ] **Step 2:** Implement. **Step 3:** Commit `feat(scripts): reach the MCP tools of a persona from a script run`.

### Task 7: `model.judge` provider

**Files:** Create `src/scripts/providers/judge.ts`. Test `tests/unit/scripts/providers/judge.test.ts`.

**Interfaces, produces:**

```ts
export interface JudgeModel {
  /** One request with no tools. Returns the raw JSON value of the reply. */
  generate(request: { system: string; user: string; schema: object; signal: AbortSignal }):
    Promise<Result<unknown, ScriptError>>;
}
export function createJudgeProvider(options: {
  model: JudgeModel; context: RunContext; timeoutMs: number;
}): ToolProvider;
export function createOpenAiCompatibleJudgeModel(options: {
  baseUrl: string; apiKey?: string; headers?: Record<string, string>; modelId: string;
  telemetry?: { scriptName: string };
}): JudgeModel;
```

Rules: `describe('model.judge')` gives class `model`. Input schema: `prompt` matches `/^[a-z0-9-]+$/` and names `prompts/<prompt>.md` in `context.versionDir`. `schema` is a JSON Schema object of at most 16,384 characters. `input` is any JSON value. The prompt file text is the system message. The user message is `JSON.stringify(input)` and nothing else. The reply is checked against the schema. If the installed zod has `z.fromJSONSchema`, use it. If it does not, stop and report NEEDS_CONTEXT. A reply that does not match gives `TOOL_FAILED`. A time-out gives `TOOL_FAILED`. The model implementation uses `createOpenAICompatible` and `generateText` or `generateObject` from `ai`, with `experimental_telemetry` that carries the script name. No tool is passed to the model.

- [ ] **Step 1:** Tests with a fake `JudgeModel`: prompt file read, missing prompt file, path characters, schema match, schema mismatch, time-out, abort. One test of `createOpenAiCompatibleJudgeModel` against a local `node:http` server that returns a chat completion.
- [ ] **Step 2:** Implement. **Step 3:** Commit `feat(scripts): add the model.judge provider`.

### Task 8: Composite provider

**Files:** Create `src/scripts/providers/composite.ts`. Test `tests/unit/scripts/providers/composite.test.ts`.

```ts
export function createCompositeProvider(parts: {
  host: ToolProvider; judge?: ToolProvider; mcp?: RunProvider;
}): RunProvider;
```

Rules: `talon.*` goes to `host`, `model.judge` to `judge`, each other name to `mcp`. A missing part gives `undefined` from `describe`. `close()` closes the MCP part.

- [ ] Tests, implement, commit `feat(scripts): route script tool names to providers`.

### Task 9: Test runner and summary

**Files:** Create `src/scripts/test-runner.ts`, `src/scripts/summary.ts`. Tests `tests/unit/scripts/test-runner.test.ts`, `summary.test.ts`.

**Interfaces, consumes:** `runScript`, `StoredVersion`, `UnitCase`. **Produces:**

```ts
export interface UnitOutcome { name: string; passed: boolean; reason?: string }
export interface DryRunOutcome { report: ScriptRunReport; didWork: boolean }
export function runUnitCases(deps: RunDeps, version: StoredVersion, cases: UnitCase[]):
  Promise<Result<UnitOutcome[], ScriptError>>;
export function runDryRun(deps: RunDeps, version: StoredVersion, provider: ToolProvider):
  Promise<Result<DryRunOutcome, ScriptError>>;
export function buildApprovalSummary(input: {
  name: string; version: number; description: string; report: ScriptRunReport;
  code: string; ttlMinutes: number;
}): string;
```

`RunDeps` holds the broker, the profile and workspace names, the time limit and the call limit.

Rules: A unit case uses a provider that describes each manifest tool as `write`, except `model.judge` (`model`), and that fails each call. The gateway never calls it in `unit` mode. A `reason` is a fixed text: `result differs`, `writes differ`, `run failed: <errorCode>`, `expected a failure`. It never quotes data. `didWork` needs a report that is `ok`. The report must also have one or more calls with outcome `skipped-dry-run`, or one or more executed calls of class `model`. The summary is at most 3,500 characters. It gives the name, version and description. It lists the read calls as counts per tool name and the model requests as a count. It lists each skipped write as the tool name plus the input as JSON, cut at 600 characters per write. If the writes do not fit, the last line gives the count of those left out. The last two lines are `/approve <code>` and `/reject <code>`, and the period of validity.

- [ ] **Step 1:** Tests with a real `ExecutionBroker` on `InMemoryContainerBackend` whose stream handler plays the script, as in `runner.test.ts`. Cases: pass, wrong result, wrong writes, expected failure, dry run with a skipped write, dry run with no work. Summary tests: counts, the cut, the length limit, the code lines.
- [ ] **Step 2:** Implement. **Step 3:** Commit `feat(scripts): add unit case runner, dry run and approval summary`.

### Task 10: Approval

**Files:** Create `src/scripts/approval.ts`. Test `tests/unit/scripts/approval.test.ts`.

```ts
export function createApprovalService(options: {
  repo: ScriptRepository; ttlMinutes: number; now?: () => number;
  randomBytes?: (n: number) => Buffer;
}): ApprovalService;
interface ApprovalService {
  /** Version must be 'tested'. Sets 'awaiting-approval'. Returns the code one time. */
  request(input: { versionId: string; channelName: string; externalThreadId: string }):
    Result<{ code: string }, ScriptError>;
  decide(input: { code: string; decision: 'approved' | 'rejected';
    channelName: string; externalThreadId: string }):
    Result<{ outcome: 'approved' | 'rejected' | 'refused'; scriptName?: string; version?: number }, ScriptError>;
  parseCommand(text: string): { decision: 'approved' | 'rejected'; code: string } | undefined;
}
```

Rules: A code is 8 characters from the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, from `crypto.randomBytes`. The database stores only the SHA-256 of the code. A new request for the same version expires the open approvals of that version. `decide` gives `refused` for an unknown code, a used code, an expired code, a different channel or thread, or a version that is not `awaiting-approval`. It gives the same outcome for each of these and does not say which. After 5 refused attempts from one channel and thread in 10 minutes, each attempt from there is refused for 10 minutes. This counter is in memory. `parseCommand` accepts `/approve CODE` and `/reject CODE`, with any case of the code and with surrounding spaces, and nothing else in the message.

- [ ] Tests for each rule, implement, commit `feat(scripts): add approval codes bound to a content hash`.

### Task 11: `/approve` in the message pipeline

**Files:** Modify `src/pipeline/message-pipeline.ts` and its types. Test in the existing pipeline test file.

**Interfaces, produces:**

```ts
export interface InboundCommandHandler {
  /** Returns the reply text if the event was a command, or undefined. Never throws. */
  handle(event: InboundEvent): Promise<string | undefined>;
}
// MessagePipeline gets an optional setter: setInboundCommandHandler(handler)
```

Rules: The pipeline calls the handler after it resolved the channel and before it finds or creates a thread. If the handler returns a text, the pipeline sends that text with `connector.send(event.externalThreadId, { body })` and stops: no thread, no message row, no queue item, no image ingestion. An event with attachments or a reaction never goes to the handler. With no handler set, the pipeline behaves as before. The reply is not stored in the conversation, so the model never reads it.

- [ ] **Step 1:** Tests: handled command is not persisted and not enqueued, and the reply is sent. Unhandled text continues as before. A handler that rejects is treated as not handled and is logged.
- [ ] **Step 2:** Implement. **Step 3:** Commit `feat(pipeline): hand approval commands to an injected handler`.

### Task 12: Script service and scheduler link

**Files:** Create `src/scripts/service.ts`. Modify `src/scheduler/scheduler.ts`, `schedule-types.ts`, `src/scripts/index.ts`. Tests `tests/unit/scripts/service.test.ts`, the scheduler test file.

**Interfaces, produces:**

```ts
export interface ScriptServiceDeps {
  store: ScriptStore; repo: ScriptRepository; approval: ApprovalService;
  broker: Broker; config: ScriptsConfig;
  /** Builds the provider for one run. The daemon supplies the real one. */
  createProvider(context: RunContext, manifest: AuthoredManifest):
    Promise<Result<RunProvider, ScriptError>>;
  send(channelName: string, externalThreadId: string, body: string): Promise<Result<void, ScriptError>>;
  audit(entry: { action: string; personaId: string; threadId: string; runId: string;
    tool?: string; details: Record<string, unknown> }): void;
}
interface ScriptService {
  save(input): Result<StoredVersion, ScriptError>;
  test(versionId: string): Promise<Result<{ unit: UnitOutcome[]; dryRun?: DryRunOutcome }, ScriptError>>;
  requestApproval(input: { versionId: string; channelName: string; externalThreadId: string }):
    Promise<Result<void, ScriptError>>;
  handleInbound: InboundCommandHandler['handle'];
  runScheduled(input: { personaId: string; threadId: string; scriptName: string; scheduleId: string }):
    Promise<Result<ScriptRunReport | 'skipped', ScriptError>>;
  hasApproved(personaId: string, scriptName: string): boolean;
}
// schedule-types.ts
interface SchedulePayload { label: string; prompt?: string; promptFile?: string; script?: string }
// scheduler.ts
export interface ScriptScheduleRunner {
  runScheduled: ScriptService['runScheduled'];
  notifyFailure(input: { threadId: string; scriptName: string; errorCode: string }): Promise<void>;
}
```

Rules for the service:

- `test` runs the unit cases. If all pass, it runs the dry run with `manifest.dryRunInput` and stores the report. If the dry run is `ok` and `didWork`, the state becomes `tested`. In each other case the state stays `draft`.
- `requestApproval` needs state `tested` and a stored report. It calls `approval.request`, builds the summary and sends it. The code exists only in that message. The return value does not contain it. If the send fails, the open approval expires and the state returns to `tested`.
- `handleInbound` uses `approval.parseCommand` and `approval.decide`. Replies are fixed texts: approved with name and version, rejected with name and version, or `This code is not valid.`.
- `runScheduled` takes the newest `approved` version. If there is none, it returns `SCRIPT_FAILED`. If a run of that script is active, it returns `'skipped'`. It calls `store.verify` first, and a failed check ends the run before a container exists. The manifest for the gateway holds the tools and channels of the approved version. The mode is `live` and the input is `manifest.liveInput ?? null`. It always closes the provider.
- Each run writes a `script_runs` row at the start and at the end. Each call with outcome `executed` and class `write` gives one audit entry with the tool name and no input. Each run gives one audit entry.

Rules for the scheduler: A payload with `script` cannot have `prompt` or `promptFile`. If `script` is set, `processSchedule` does not enqueue. It starts `runner.runScheduled` without waiting for it, and computes the next run as for a prompt schedule. With no runner set, it logs an error and still computes the next run. A failed run is an error result or a report with `ok: false`. After a failed run the scheduler looks at the last finished scheduled run of that script. If that run was a success or there was none, the scheduler calls `notifyFailure`. One message per change to failure prevents a message every 30 minutes.

- [ ] **Step 1:** Service tests with fakes for provider and `send`, a real store and repository on `createTestDb()`, and the in-memory broker: the full flow, each refusal, tamper before a live run, the skipped run, provider close on each path, audit entries.
- [ ] **Step 2:** Scheduler tests: script payload does not enqueue, next run is computed, the failure rule.
- [ ] **Step 3:** Implement. **Step 4:** Commit `feat(scripts): add the script service and the script schedule payload`.

### Task 13: Daemon wiring, real Docker flow and documents (controller)

**Files:** Modify `src/daemon/daemon-bootstrap.ts`, `daemon-context.ts`, `daemon.ts`. Create `src/scripts/daemon-provider.ts`, `tests/integration/script-flow-docker.test.ts`. Modify `README.md`, `CLAUDE.md`.

- [ ] **Step 1:** `daemon-provider.ts` builds the real `createProvider`. The host provider comes from `ctx.hostToolsBridge`. The MCP servers come from the skills of the persona, through the same functions as `agent-runner.ts` (`collectMcpServers`, `resolveMcpServers`). The judge model comes from the provider configuration of the persona. A persona whose provider is not `openai-compatible` gets no judge part.
- [ ] **Step 2:** Bootstrap. If `scripts.enabled` is true, make the root directory and call `installScriptSdk`. Build the broker, the store, the approval service and the script service. Set the pipeline handler and the scheduler runner, and put the service on the context. A failure aborts the boot with a clear error. Reload keeps the running `scripts` section and warns.
- [ ] **Step 3:** Integration test with real Docker (`TALON_SCRIPT_IT_IMAGE`), a real database, the real pipeline handler path and a fake provider: save, test, request approval, read the code from the captured message, `/approve` through `handleInbound`, `runScheduled` in `live`. Also: `/approve` from a different thread is refused, and a changed file after approval stops the live run.
- [ ] **Step 4:** Documents: `README.md` feature and configuration sections, `CLAUDE.md` source layout and decisions, the example configuration.
- [ ] **Step 5:** `npx tsc --noEmit`, `npm run lint`, the unit tests of the changed areas, both Docker test files. Commit. Report to Ivo.

## Rulings in this plan, open to correction

- The MCP client runs inside the daemon process, one client per script run, not in a helper process. The spec named a helper process and left the choice to a spike. The spike measured a start time of about 370 ms in process. A helper process can replace `createClient` later with no change to callers.
- Unit tests are data in `tests.json`, not code. The host compares results. This removes a test framework from the image and means that a test cannot report a false pass.
- A script reaches six host tool names. `net.http`, `db.query`, `schedule.manage` and the persona tools stay closed in this slice.
- A dry run uses the thread of the authoring conversation for memory. A scheduled run uses the schedule thread.
- A failure message goes out only on a change from success to failure.
- `model.judge` works only for a persona on the `openai-compatible` provider in this slice.

## Not in this plan

- Host tools for the agent, the authoring skill, `talonctl script` commands and the mail intake script: Part 3.
- A cancel signal on `runScript`, script stderr in the report, a Telegram button for approval.
- A test of OAuth-backed MCP servers on `talon-vm`. This needs permission from Ivo.
