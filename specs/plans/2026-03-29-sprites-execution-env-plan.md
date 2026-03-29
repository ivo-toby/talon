# Sprites Execution Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 1 Sprites-backed execution-environment foundations so background workers can be sandbox-aware and Talon can manage isolated execution environments through a host tool.

**Architecture:** Introduce a new `execution-env` domain with typed records, a repository, a manager, and a host-tool handler behind a Sprites adapter interface. Extend background-task metadata and host-tools context so later background-agent sandbox orchestration can provision, track, and clean up primary environments safely.

**Tech Stack:** TypeScript, Zod, better-sqlite3, neverthrow, vitest, pino, MCP host tools.

---

## File Map

**Create:**
- `src/execution-env/execution-env-types.ts`
- `src/execution-env/execution-env-manager.ts`
- `src/execution-env/sprites-client-adapter.ts`
- `src/execution-env/sprites-client.ts`
- `src/execution-env/path-policy.ts`
- `src/tools/host-tools/execution-env.ts`
- `src/core/database/repositories/execution-env-repository.ts`
- `src/core/database/migrations/007-execution-environments.sql`
- `src/core/database/migrations/008-background-task-sandbox-columns.sql`
- `tests/unit/execution-env/path-policy.test.ts`
- `tests/unit/execution-env/execution-env-manager.test.ts`
- `tests/unit/core/database/repositories/execution-env-repository.test.ts`
- `tests/unit/tools/host-tools/execution-env.test.ts`

**Modify:**
- `package.json`
- `src/core/config/config-schema.ts`
- `src/core/config/config-types.ts`
- `src/core/config/config-loader.ts`
- `src/core/errors/error-types.ts`
- `src/core/errors/index.ts`
- `src/core/database/repositories/index.ts`
- `src/subagents/background/background-agent-types.ts`
- `src/core/database/repositories/background-task-repository.ts`
- `src/tools/host-tools/channel-send.ts`
- `src/tools/host-tools/index.ts`
- `src/tools/tool-filter.ts`
- `src/tools/host-tools-mcp-server.ts`
- `src/tools/host-tools-bridge.ts`
- `src/tools/host-tools/background-agent.ts`
- `src/subagents/background/background-agent-manager.ts`
- `src/daemon/daemon-context.ts`
- `src/daemon/daemon-bootstrap.ts`
- `src/daemon/daemon.ts`
- `tests/unit/core/config/config-schema.test.ts`
- `tests/unit/core/config/config-loader.test.ts`
- `tests/unit/core/database/repositories/background-task-repository.test.ts`
- `tests/unit/tools/tool-filter.test.ts`
- `tests/unit/tools/host-tools-bridge.test.ts`
- `tests/unit/tools/background-agent.test.ts`
- `tests/unit/subagents/background/background-agent-manager.test.ts`

## Task 1: Config, capabilities, and background-task metadata

**Intent:** Add the config and persistence primitives required for sandbox-aware background tasks before touching Sprites orchestration.

- [ ] Add `sprites` config and `persona.executionEnv` defaults to the config schema and type exports.
- [ ] Add config-loader coverage for `${SPRITES_TOKEN}` substitution and `sprites.enabled` validation.
- [ ] Add `execution.env` capability/tool mapping to `tool-filter.ts` and extend host-tool tests.
- [ ] Extend `ToolExecutionContext` with `backgroundTaskId`, `primaryExecutionEnvId`, and `allowedHostRoots`.
- [ ] Extend background-task types and repository mapping with `sandboxEnabled` and `primaryExecutionEnvId`.
- [ ] Add migration `008-background-task-sandbox-columns.sql` and update repository tests accordingly.

## Task 2: Execution-environment domain and persistence

**Intent:** Build the domain objects and repository shape independently from background-agent integration.

- [ ] Add `ExecutionEnvError` to the core error hierarchy.
- [ ] Create shared execution-env types covering environments, checkpoints, exec results, resource limits, and tool args.
- [ ] Create `ExecutionEnvRepository` with CRUD/status helpers and repository tests.
- [ ] Create `path-policy.ts` with allowed-root resolution and focused tests.
- [ ] Create `SpritesClientAdapter` plus a concrete `SpritesClient` wrapper scaffold around `@fly/sprites`.
- [ ] Implement `ExecutionEnvManager` create/exec/upload/download/checkpoint/restore/destroy flows against the repository and adapter with fake-adapter tests.

## Task 3: Host tool plumbing

**Intent:** Make the new execution environment functionality reachable from MCP workers in a way that preserves existing host-tools patterns.

- [ ] Add `execution_env` to the MCP server tool list and environment-context forwarding.
- [ ] Implement `ExecutionEnvHandler` argument validation and result shaping around `ExecutionEnvManager`.
- [ ] Register the handler inside `HostToolsBridge` and export it from `src/tools/host-tools/index.ts`.
- [ ] Extend bridge tests to cover dispatch and capability denial for `execution_env`.

## Task 4: Daemon wiring

**Intent:** Wire the domain into runtime bootstrap without yet depending on full sandboxed background-agent orchestration.

- [ ] Add `ExecutionEnvRepository` to repository exports and `ExecutionEnvManager | null` to `DaemonContext`.
- [ ] Initialize the manager in `daemon-bootstrap.ts` when `config.sprites.enabled` is true.
- [ ] Call `recoverOrphanedEnvironments()` during bootstrap and await background-manager shutdown during daemon stop.

## Task 5: Background-agent sandbox integration

**Intent:** Connect background-agent spawn/cancel/shutdown paths to primary execution environments once the domain and host tool are stable.

- [ ] Extend `BackgroundAgentArgs` and `SpawnBackgroundAgentInput` with sandbox and execution-env fields.
- [ ] Make `BackgroundAgentManager.spawn/cancel/recoverOrphanedTasks/shutdown` async.
- [ ] Inject background-worker host tools and capability filtering using the existing agent-runner MCP pattern.
- [ ] When sandboxing is enabled, create a per-task control directory, create a primary env, persist its id on the task, and ensure destroy/cleanup on all terminal paths.
- [ ] Add focused unit tests for spawn validation, control-directory selection, and env cleanup on completion/cancel/shutdown/recovery.

## Session Scope

This implementation session should complete Task 1 and Task 2, plus as much of Task 3 as can be verified cleanly. Background-agent sandbox orchestration should only start after the domain and host-tool slices are green.
