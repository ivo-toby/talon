# Talon Scripts, Part 1: Script Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a TypeScript script in a hardened container that calls tools through Talon in `unit`, `dry-run` and `live` mode.

**Architecture:** The execution broker gets a streaming exec. The script and Talon exchange one JSON message per line on standard input and output, so the container keeps no network. A gateway in Talon applies the manifest, the tool class and the mode to each call. Tools come from a `ToolProvider` interface, and this part supplies only a fake provider.

**Tech Stack:** TypeScript strict, Node.js 22 or later, neverthrow, vitest, raw `node:http` on the Docker socket. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-talon-scripts-design.md`

## Scope

The spec covers eight parts. This plan builds the shared runtime: sandbox tool channel, gateway, SDK and runner. Two later plans build the rest.

- Part 2: real tool providers (host tools, MCP helper), `model.judge`, script store, test runner, approval, scheduler link.
- Part 3: authoring skill, host tools for authoring, and the mail intake as the first stored script.

Part 1 ends with working software: a developer runs a script file against a fake tool provider on a real Docker daemon.

## Global Constraints

- All functions that can fail return a neverthrow `Result`. No throw crosses a module boundary.
- An `ExecutionBrokerError` or `ScriptError` message never contains tool input, tool output, script text, a lease ID or a host path.
- The container posture of the broker does not change: no network, non-root user, read-only root file system, all capabilities dropped.
- A tool with no class information is a `write` tool.
- A `write` tool never runs in `unit` or `dry-run` mode.
- No new npm dependency.
- Work on branch `feat/talon-scripts`. Commit locally. Do not push.
- Before each commit, the controller reviews the diff. The memory rule of Ivo replaces the Codex step in `CLAUDE.md`.
- Each commit passes `npx tsc --noEmit`, `npx eslint` on the changed files, and `npx vitest run tests/unit/execution-broker tests/unit/scripts`.
- Written documents follow the simple-english hook: short sentences, no semicolons, condition before command.

## Review Focus

These failure modes are likely in real use. Each has a test in the task that owns the code.

1. A script writes text that is not a protocol message to standard output. Expected: the run fails with `PROTOCOL`, and the container is removed. Test in Task 8.
2. A script never sends `done`. Expected: the run ends with `TIMEOUT` at the time limit, and the lease is terminal. Test in Task 10.
3. A tool returns a result larger than the line limit. Expected: the script gets a `RESULT_TOO_LARGE` error for that call, and the run continues. Test in Task 8.
4. A script starts hundreds of calls at the same time. Expected: at most 8 run together, and call number 201 fails with `CALL_LIMIT`. Test in Task 8.
5. A script exits before it sends `done`, with calls still open. Expected: the run fails with `SCRIPT_FAILED`, and each open provider call gets an abort signal. Test in Task 10.

---

## File Structure

| File | Responsibility |
| ---- | -------------- |
| `src/execution-broker/docker-types.ts` | Add `DockerDuplex` and `DockerEngineClient.openStream` |
| `src/execution-broker/docker-stream.ts` | Add an incremental demuxer next to the buffered one |
| `src/execution-broker/docker-client.ts` | Implement `openStream` with an HTTP upgrade |
| `src/execution-broker/types.ts` | Add `BackendStreamExecRequest`, `BackendExecSession`, `StreamExecution`, `ContainerBackend.execStream` |
| `src/execution-broker/docker-backend.ts` | Implement `execStream` |
| `src/execution-broker/container-backend.ts` | Implement `execStream` in the in-memory backend |
| `src/execution-broker/lifecycle.ts` | Add `ExecutionBroker.executeStream` |
| `src/scripts/types.ts` | Script types and `ScriptError` (controller-owned) |
| `src/scripts/protocol.ts` | Message types, line splitter, encode and decode |
| `src/scripts/gateway.ts` | Manifest, class and mode rules for each call |
| `src/scripts/sdk-assets/index.js`, `run.js`, `index.d.ts`, `package.json` | The `talon` module that runs inside the container, plain JavaScript |
| `src/scripts/sdk-install.ts` | Copy the SDK assets into `<scriptsRoot>/node_modules/talon` |
| `src/scripts/runner.ts` | Connect broker, gateway and protocol for one run |
| `src/scripts/index.ts` | Module exports |
| `tests/unit/scripts/*.test.ts`, `tests/integration/script-runtime-docker.test.ts` | Tests |

The SDK is plain JavaScript because Node.js does not strip types under `node_modules`. The build already copies plain `.js` assets for `src/voice/web`.

## Controller-owned contract

The controller writes these types before Task 7. Implementers do not change them.

```ts
// src/scripts/types.ts
export type ScriptMode = 'unit' | 'dry-run' | 'live';
export type ToolClass = 'read' | 'write' | 'model';
export type ScriptErrorCode =
  | 'INVALID_ARGUMENT' | 'NOT_IN_MANIFEST' | 'UNKNOWN_TOOL' | 'NO_STUB'
  | 'TOOL_FAILED' | 'RESULT_TOO_LARGE' | 'CALL_LIMIT'
  | 'PROTOCOL' | 'SCRIPT_FAILED' | 'TIMEOUT' | 'SANDBOX';

export class ScriptError extends Error {
  constructor(readonly scriptCode: ScriptErrorCode, detail: string, readonly cause?: unknown);
}

export interface ScriptManifest { name: string; personaId: string; tools: string[] }

export interface ToolProvider {
  /** undefined means the tool does not exist for this persona. */
  describe(name: string): { toolClass: ToolClass } | undefined;
  call(name: string, input: unknown, signal: AbortSignal): Promise<Result<unknown, ScriptError>>;
}

export type CallOutcome = 'executed' | 'stubbed' | 'skipped-dry-run' | 'denied' | 'failed';
export interface CallRecord {
  seq: number; name: string; toolClass: ToolClass | 'unknown';
  input: unknown; outcome: CallOutcome; errorCode?: ScriptErrorCode;
}
export interface ScriptRunReport { ok: boolean; result?: unknown; errorCode?: ScriptErrorCode; calls: CallRecord[] }

export interface GatewayOptions {
  manifest: ScriptManifest; mode: ScriptMode; provider: ToolProvider;
  /** unit: answers per tool name, used in order. dry-run: placeholder results for write tools. */
  stubs?: Record<string, unknown[]>;
  maxConcurrentCalls?: number;   // default 8
  maxCalls?: number;             // default 200
  maxResultChars?: number;       // default 262_144
}
```

```ts
// src/scripts/protocol.ts  (one JSON object per line, UTF-8, line limit 1_048_576 bytes)
export type HostMessage =
  | { t: 'start'; mode: ScriptMode; input: unknown }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; code: ScriptErrorCode; message: string };
export type ScriptMessage =
  | { t: 'call'; id: number; name: string; input: unknown }
  | { t: 'done'; ok: true; result: unknown }
  | { t: 'done'; ok: false; message: string };
```

Script side API, fixed by `index.d.ts`:

```ts
export const tools: Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;
export function call(name: string, input?: unknown): Promise<unknown>;   // tools.a.b(x) is call('a.b', x)
export class TalonToolError extends Error { readonly code: string }
// script.ts: export default async function (input: unknown): Promise<unknown>
```

The run command inside the container is `['node', '/scripts/node_modules/talon/run.js', '<name>/script.ts']`. `run.js` sends console output to standard error, so only protocol lines reach standard output.

---

### Task 0: Branch and baseline

**Files:** none.

- [ ] **Step 1:** Run `git fetch origin && git rebase origin/main` on `feat/execution-broker-contract`. If a conflict is outside `src/execution-broker/`, stop and report.
- [ ] **Step 2:** Run `git switch -c feat/talon-scripts && npm install`.
- [ ] **Step 3:** Run `npx tsc --noEmit && npx vitest run tests/unit/execution-broker`. Expected: no type errors, 163 tests pass.

### Task 1: Spike A, tool channel on real Docker (controller, throwaway)

The spike can change this plan. Keep the code in the scratchpad directory, not in the repository.

- [ ] **Step 1:** Pull one official Node.js 24 slim image and note its digest. Run `docker image inspect` to make sure that the `name@sha256:` reference resolves locally.
- [ ] **Step 2:** Start a container with the posture of `docker-backend.ts` and a read-only bind mount at `/scripts`. The mount contains `node_modules/talon/index.js` and `demo/script.ts`.
- [ ] **Step 3:** Create an exec with `AttachStdin`, `AttachStdout` and `AttachStderr`. Start it with the headers `Connection: Upgrade` and `Upgrade: tcp`. Write one line to standard input and read one line back.
- [ ] **Step 4:** Record these answers in `docs/superpowers/plans/2026-11-25-talon-scripts-1-spike-notes.md`.

Go criteria, all necessary:

- A line written to standard input reaches the script, and a reply line comes back, with `NetworkMode: none`.
- Output arrives in multiplexed frames while the exec still runs.
- A half-close of the socket ends standard input in the script.
- `node` runs `script.ts` with type annotations as uid 10001 on a read-only root file system.
- `import { call } from 'talon'` resolves from `/scripts/node_modules/talon`.
- An abort of the request ends the exec stream.

If a criterion fails, stop and report to Ivo with the measured behavior. Do not start Task 3.

### Task 2: Spike B, MCP helper start time (controller, throwaway)

Part 1 does not depend on this spike. It runs now because its result can change Part 2.

- [ ] **Step 1:** Write a scratch script that builds an `MCPClient` from `@mastra/mcp` with one local stdio server. It calls `listTools()`, calls one tool, and disconnects.
- [ ] **Step 2:** Measure the time for 5 cold starts. Record the median in the spike notes.
- [ ] **Step 3:** Record whether a tool object exposes the MCP `readOnlyHint` annotation.

Not in this spike: OAuth-backed servers. Their tokens are on `talon-vm`, and a test there can refresh a live token. That test needs permission from Ivo.

### Task 3: Incremental Docker stream demuxer

**Files:**
- Modify: `src/execution-broker/docker-stream.ts`
- Test: `tests/unit/execution-broker/docker-stream.test.ts`

**Interfaces:**
- Produces: `createDockerDemuxer(): DockerDemuxer` with `push(chunk: Buffer): Result<DemuxFrame[], ExecutionBrokerError>` and `end(): Result<DemuxFrame[], ExecutionBrokerError>`. `DemuxFrame` is `{ stream: 'stdout' | 'stderr'; text: string }`.

- [ ] **Step 1: Write failing tests.** Cases: one frame split over three chunks gives one frame. Two frames in one chunk give two frames in order. A multi-byte character split over two frames of the same stream decodes correctly. Stdin frames (type 0) are ignored. An unknown stream type gives `BACKEND_FAILURE`. `end()` with a partial header gives `BACKEND_FAILURE`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/execution-broker/docker-stream.test.ts`. Expected: the new tests fail because `createDockerDemuxer` does not exist.
- [ ] **Step 3: Implement.** Keep one `StringDecoder` per stream and one carry buffer. The frame header is 8 bytes: stream type, 3 zero bytes, size as uint32 big-endian. Do not change `demuxDockerStream`.
- [ ] **Step 4:** Run the test file again. Expected: all pass.
- [ ] **Step 5:** Commit `feat(execution-broker): add incremental Docker stream demuxer`.

### Task 4: Docker client `openStream`

**Files:**
- Modify: `src/execution-broker/docker-types.ts`, `src/execution-broker/docker-client.ts`
- Test: `tests/unit/execution-broker/docker-client.test.ts`

**Interfaces:**
- Produces, in `docker-types.ts`:

```ts
export interface DockerDuplex {
  write(chunk: Buffer): void;
  /** Half-close: no more input, output continues. */
  endInput(): void;
  onData(listener: (chunk: Buffer) => void): void;
  /** Called one time. error is set for a transport failure or an abort. */
  onClose(listener: (error?: ExecutionBrokerError) => void): void;
  destroy(): void;
}
// added to DockerEngineClient:
openStream(request: DockerRequest): Promise<Result<DockerDuplex, ExecutionBrokerError>>;
```

- [ ] **Step 1: Write failing tests** against a local `http.Server` on a temporary unix socket that handles the `upgrade` event. Cases: a 101 reply gives a duplex, and bytes go both ways. A 200 or 404 reply with no upgrade gives `BACKEND_FAILURE`. The request carries `Connection: Upgrade` and `Upgrade: tcp`. `endInput()` ends the readable side of the server socket, and the server can still write. An abort after the upgrade calls `onClose` one time with an error. A connect failure gives `BACKEND_FAILURE`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/execution-broker/docker-client.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement `openStream`.** Use `http.request` with `socketPath` and the `upgrade` event. Deliver the `head` buffer of the upgrade as the first data chunk. Use one settle-once guard for `onClose`.
- [ ] **Step 4:** Run the test file. Expected: all pass, the 7 existing tests included.
- [ ] **Step 5:** Commit `feat(execution-broker): add upgraded duplex stream to the Docker client`.

### Task 5: Backend `execStream`

**Files:**
- Modify: `src/execution-broker/types.ts`, `src/execution-broker/docker-backend.ts`, `src/execution-broker/container-backend.ts`
- Test: `tests/unit/execution-broker/docker-backend.test.ts`, `tests/unit/execution-broker/container-backend.test.ts`

**Interfaces:**
- Consumes: `createDockerDemuxer` (Task 3), `openStream` (Task 4).
- Produces, in `types.ts`:

```ts
export interface BackendStreamExecRequest extends BackendExecRequest {
  onStdout(text: string): void;
}
export interface BackendExecSession {
  writeStdin(text: string): void;
  endStdin(): void;
  /** stderr is capped at 65_536 characters by the backend. */
  done: Promise<Result<{ exitCode: number; stderr: string }, ExecutionBrokerError>>;
}
// added to ContainerBackend:
execStream(containerId: string, request: BackendStreamExecRequest): Promise<Result<BackendExecSession, ExecutionBrokerError>>;
```

- In-memory backend: `setExecStreamHandler(handler: InMemoryExecStreamHandler)`. The handler gets `{ containerId, argv, cwd, signal, emitStdout(text), onStdin(listener), onStdinEnd(listener) }` and returns `Promise<{ exitCode: number; stderr: string }>`.

- [ ] **Step 1: Write failing tests for the Docker backend** with a fake `DockerEngineClient`. Cases: exec create sends `AttachStdin: true`, `AttachStdout: true`, `AttachStderr: true`, `Tty: false`, the argv and the working directory. Exec start uses `openStream` with body `{ Detach: false, Tty: false }`. Stdout frames reach `onStdout` in order. Stderr frames collect in `done`. After the stream closes, the backend reads the exit code from exec inspect. A close with an error gives `BACKEND_FAILURE` in `done`. An invalid container ID gives `INVALID_ARGUMENT` with no client call. An abort of `request.signal` destroys the duplex.
- [ ] **Step 2: Write failing tests for the in-memory backend.** Cases: the handler receives stdin text, `emitStdout` reaches `onStdout`, an unknown container ID gives `BACKEND_FAILURE`, and the call is recorded in `execCalls`.
- [ ] **Step 3:** Run both test files. Expected: the new tests fail.
- [ ] **Step 4: Implement both.** Reuse the validation and status rules of `exec` in `docker-backend.ts`. Do not change `exec`.
- [ ] **Step 5:** Run both test files. Expected: all pass.
- [ ] **Step 6:** Commit `feat(execution-broker): add streaming exec to both container backends`.

### Task 6: Broker `executeStream`

**Files:**
- Modify: `src/execution-broker/types.ts`, `src/execution-broker/lifecycle.ts`, `src/execution-broker/index.ts`
- Test: `tests/unit/execution-broker/lifecycle-stream.test.ts`

**Interfaces:**
- Consumes: `ContainerBackend.execStream` (Task 5).
- Produces:

```ts
export interface StreamExecution {
  writeStdin(text: string): void;
  endStdin(): void;
  /** stdout is '' and stdoutTruncated is false: stdout goes to the handler. */
  result: Promise<Result<ExecutionResult, ExecutionBrokerError>>;
}
// ExecutionBroker:
executeStream(input: unknown, handlers: { onStdout(text: string): void }): Promise<Result<StreamExecution, ExecutionBrokerError>>;
```

`executeStream` applies every rule of `execute`: exact input keys, lease binding, working directory, time limit, concurrency count, and a terminal lease after a time-out.

- [ ] **Step 1: Write failing tests** with the in-memory backend. Cases: a round trip of stdin and stdout. Each validation error of `execute` is returned before a backend call. A time-out resolves `result` with `timedOut: true`, and the next call on the lease gives `LEASE_REVOKED`. A revoke during the stream resolves `result` with `cancelled: true`. A backend that fails its stream after an abort does not replace the time-out result. A stream counts in `maxConcurrentExecsPerLease` together with `execute`. `stderr` is cut at `outputCapChars`. After a time-out, `writeStdin` does nothing and does not throw.
- [ ] **Step 2:** Run `npx vitest run tests/unit/execution-broker/lifecycle-stream.test.ts`. Expected: fail, `executeStream` does not exist.
- [ ] **Step 3: Implement.** Share the validation and the settle-once path with `execute`. Do not copy them. Keep this rule from commit `6acf78f`: the party that aborts an exec owns the outcome.
- [ ] **Step 4:** Run `npx vitest run tests/unit/execution-broker`. Expected: all pass, the 163 existing tests included.
- [ ] **Step 5:** Commit `feat(execution-broker): add streaming execute to the broker`.

### Task 7: Protocol codec

**Files:**
- Create: `src/scripts/types.ts` (controller writes this from the contract above), `src/scripts/protocol.ts`
- Test: `tests/unit/scripts/protocol.test.ts`

**Interfaces:**
- Produces: `encodeMessage(message: HostMessage): string` (one line with a final `\n`), `createLineDecoder(maxLineBytes?: number): { push(text: string): Result<ScriptMessage[], ScriptError> }`.

- [ ] **Step 1: Write failing tests.** Cases: a message split over two chunks decodes one time. Two messages in one chunk decode in order. A line that is not JSON gives `PROTOCOL`. A JSON line with an unknown `t` gives `PROTOCOL`. A `call` with a non-integer `id` or an empty `name` gives `PROTOCOL`. A line over 1,048,576 bytes gives `PROTOCOL` before the newline arrives. An empty line is skipped. `encodeMessage` output contains exactly one newline, at the end.
- [ ] **Step 2:** Run `npx vitest run tests/unit/scripts/protocol.test.ts`. Expected: fail.
- [ ] **Step 3: Implement** with explicit field checks. No schema library.
- [ ] **Step 4:** Run the test file. Expected: pass.
- [ ] **Step 5:** Commit `feat(scripts): add script protocol codec and types`.

### Task 8: Gateway

**Files:**
- Create: `src/scripts/gateway.ts`
- Test: `tests/unit/scripts/gateway.test.ts`

**Interfaces:**
- Consumes: types from Task 7.
- Produces:

```ts
export interface ScriptGateway {
  /** Never rejects. The returned message is the reply for the script. */
  handleCall(message: { id: number; name: string; input: unknown }): Promise<HostMessage>;
  /** Aborts every open provider call. */
  abortAll(): void;
  records(): CallRecord[];
}
export function createScriptGateway(options: GatewayOptions): Result<ScriptGateway, ScriptError>;
```

Rules, in this order for each call:

1. Call number above `maxCalls` gives `CALL_LIMIT`, outcome `denied`.
2. A name that is not in `manifest.tools` gives `NOT_IN_MANIFEST`, outcome `denied`. The provider is not asked.
3. `provider.describe(name)` returns `undefined`: `UNKNOWN_TOOL`, outcome `denied`.
4. Mode `unit`: return the next entry of `stubs[name]`, outcome `stubbed`. No entry gives `NO_STUB`. The provider is never called in this mode.
5. Mode `dry-run` and class `write`: do not call the provider. Return the next entry of `stubs[name]`, or `{ dryRun: true }`. Outcome `skipped-dry-run`.
6. All other cases: call the provider. At most `maxConcurrentCalls` run together, and the rest wait in order.
7. A provider result whose JSON text is longer than `maxResultChars` gives `RESULT_TOO_LARGE`, outcome `failed`.

- [ ] **Step 1: Write failing tests**, one per rule above, plus these. `write` in `dry-run` leaves the provider call count at 0, and the record holds the input. `model` class runs in `dry-run` and `live`. A provider error gives a `result` with `ok: false`, code `TOOL_FAILED` and a fixed message that does not contain the provider text. A provider that throws gives the same. With 20 calls at the same time, the provider sees at most 8 open calls. Call 201 gives `CALL_LIMIT`. `abortAll()` sets the signal of each open call. `records()` returns calls in `seq` order. An empty `manifest.name` gives `INVALID_ARGUMENT` from `createScriptGateway`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/scripts/gateway.test.ts`. Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the test file. Expected: pass.
- [ ] **Step 5:** Commit `feat(scripts): add script gateway with manifest, class and mode rules`.

### Task 9: SDK assets and installer

**Files:**
- Create: `src/scripts/sdk-assets/index.js`, `src/scripts/sdk-assets/run.js`, `src/scripts/sdk-assets/index.d.ts`, `src/scripts/sdk-assets/package.json`, `src/scripts/sdk-install.ts`
- Modify: `package.json` (build script copies `src/scripts/sdk-assets/*` to `dist/scripts/sdk-assets/`)
- Test: `tests/unit/scripts/sdk.test.ts`

**Interfaces:**
- Consumes: the protocol of Task 7 and the script side API in the contract above.
- Produces: `installScriptSdk(scriptsRoot: string): Result<void, ScriptError>`. It writes `<scriptsRoot>/node_modules/talon/` and replaces an older copy.

`run.js` behavior: read the `start` message, import the script path from `process.argv[2]`, call its default export with `input`, and write one `done` message. A thrown error becomes `done` with `ok: false` and the error message. It replaces `console.log`, `console.info`, `console.warn` and `console.error` with writers to standard error. After `done` it exits with code 0, also for `ok: false`.

- [ ] **Step 1: Write failing tests** that start `node <installed>/run.js demo/script.ts` as a child process with piped standard streams, in a temporary scripts root. No Docker. Cases: a script that returns a value sends `done` with that value. `tools.mail.list({ a: 1 })` sends `call` with name `mail.list`, and the promise resolves with the value of the `result` message. A `result` with `ok: false` rejects with `TalonToolError` and the code. Two calls at the same time get different IDs and the correct results. `console.log('x')` puts nothing on standard output. A script that throws sends `done` with `ok: false`. A script with no default export function sends `done` with `ok: false`. A script file with TypeScript type annotations runs. `installScriptSdk` on an existing copy replaces it.
- [ ] **Step 2:** Run `npx vitest run tests/unit/scripts/sdk.test.ts`. Expected: fail.
- [ ] **Step 3: Implement.** The SDK imports only `node:` modules. Add `// @ts-check` to the two `.js` files. `sdk-install.ts` locates the assets relative to its own file, so it works from `src` and from `dist`.
- [ ] **Step 4:** Run the test file. Expected: pass.
- [ ] **Step 5:** Run `npm run build` and make sure that `dist/scripts/sdk-assets/run.js` exists.
- [ ] **Step 6:** Commit `feat(scripts): add the in-container talon SDK and its installer`.

### Task 10: Runner

**Files:**
- Create: `src/scripts/runner.ts`, `src/scripts/index.ts`
- Test: `tests/unit/scripts/runner.test.ts`

**Interfaces:**
- Consumes: `ExecutionBroker.createLease`, `executeStream`, `revoke` (Task 6), `createScriptGateway` (Task 8), the codec (Task 7).
- Produces:

```ts
export interface ScriptRunRequest {
  manifest: ScriptManifest; mode: ScriptMode; provider: ToolProvider;
  /** Relative to the scripts workspace, for example 'mail-intake/script.ts'. */
  scriptPath: string;
  input: unknown; timeoutMs: number;
  stubs?: Record<string, unknown[]>;
  /** Broker names. The operator allowlist must grant them to manifest.personaId. */
  profile: string; workspace: string;
}
export function runScript(
  broker: Pick<ExecutionBroker, 'createLease' | 'executeStream' | 'revoke'>,
  request: ScriptRunRequest,
): Promise<Result<ScriptRunReport, ScriptError>>;
```

`runScript` returns `ok` with a report for each run that started, also for a run that failed. If the run did not start, it returns `err`. The two causes are a bad request (`INVALID_ARGUMENT`) and a lease or exec that the broker refused (`SANDBOX`). It always revokes the lease at the end.

- [ ] **Step 1: Write failing tests** with a real `ExecutionBroker` on the in-memory backend. The stream handler plays the script side. Cases: `start` is the first line the script receives, with mode and input. A call goes through the gateway, and the reply reaches the script. `done` with `ok: true` gives a report with `ok: true`, the result and the call records. A line that is not a protocol message gives `errorCode: 'PROTOCOL'` and a revoked lease. A time-out gives `errorCode: 'TIMEOUT'`. An exit with no `done` gives `errorCode: 'SCRIPT_FAILED'`, and the open provider call sees an aborted signal. `done` with `ok: false` gives `errorCode: 'SCRIPT_FAILED'`. A `scriptPath` that is absolute or contains `..` gives `err` with `INVALID_ARGUMENT` and no lease. A refused lease gives `err` with `SANDBOX`. The lease is revoked after each case. Messages after `done` are ignored.
- [ ] **Step 2:** Run `npx vitest run tests/unit/scripts/runner.test.ts`. Expected: fail.
- [ ] **Step 3: Implement.** The task ID of the lease is a new random UUID. The argv is the fixed run command from the contract.
- [ ] **Step 4:** Run `npx vitest run tests/unit/scripts tests/unit/execution-broker`. Expected: all pass.
- [ ] **Step 5:** Commit `feat(scripts): add script runner on the execution broker`.

### Task 11: Real Docker run and documents (controller)

**Files:**
- Create: `tests/integration/script-runtime-docker.test.ts`
- Modify: `CLAUDE.md` (add `src/scripts/` and `src/execution-broker/` to the source layout table)

The test is skipped unless `TALON_SCRIPT_IT_IMAGE` names a local digest-pinned Node.js image and the Docker socket exists. It follows the pattern of `tests/integration/execution-broker-docker.test.ts`.

- [ ] **Step 1: Write the test.** It installs the SDK into a temporary scripts root and writes the test scripts there. It uses a fake `ToolProvider` with one `read` tool and one `write` tool. Cases: in `live` mode both tools run, and the script result returns. In `dry-run` mode the `write` tool call count stays 0, and the report lists the skipped write with its input. In `unit` mode the provider call count stays 0. A script with `while (true) {}` ends with `TIMEOUT` inside the time limit plus 5 seconds. A script that calls `fetch('http://1.1.1.1')` fails, and the run reports `SCRIPT_FAILED`. A script that writes a file in `/scripts` fails. After all cases, the list of containers equals the list from before the test.
- [ ] **Step 2:** Run it with the image from Task 1. Expected: all cases pass. If a case fails, use superpowers:systematic-debugging. Do not weaken the case.
- [ ] **Step 3:** Update `CLAUDE.md`.
- [ ] **Step 4:** Run `npx tsc --noEmit && npm run lint && npx vitest run tests/unit/scripts tests/unit/execution-broker`. Expected: clean and green.
- [ ] **Step 5:** Commit `test(scripts): run the script runtime against a real Docker daemon`.
- [ ] **Step 6:** Report to Ivo: what works, what the spikes found, and the proposed content of Part 2.

## Not in this plan

- Real tools. The gateway sees only a fake provider.
- `memory`, `notify` and `model.judge` in the SDK. Part 2 adds them as named operations on the same `call` message.
- Tests that the agent writes, the script store, approval, schedules and the authoring skill.
- A change on `talon-vm`.
