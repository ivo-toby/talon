# Background Docker command execution for background agents

Status: Proposed design, 2026-09-30. This document records the current failure and recommends a Docker-backed execution boundary. It does not implement or enable the runner.

## Summary

Background agents can start and use OAuth-backed MCP servers, but they currently have no safe local command-execution path in this Docker deployment. The configured top-level `sandbox.runtime: docker` value is schema-only at the deployed revision; the implemented background execution-environment manager is initialized only for Sprites. Meanwhile, OAuth-backed MCP runs deliberately have native local shell and filesystem tools disabled.

The recommended fix is a dedicated, narrowly scoped Docker execution broker outside the Talond process. Talon remains the model/MCP control plane; the broker launches one disposable worker container per background task with only an operator-allowlisted workspace mounted. The worker receives no OAuth credentials, Talon data/config mounts, Docker socket, or unrestricted network. The wiki-maintenance task must select its workspace explicitly (the current deployment mounts the wiki at /epic-wiki).

## Problem statement

### Observed failure

Background task `1ac9f638-c815-4286-a879-b6c187eb8a8c` was created and completed at the provider level, but the requested nightly wiki maintenance did not run:

- The task attempted to run `df` and create/recreate a clean execution environment through `execution.env`; the host-tool bridge returned “Execution environment system not initialized” before the command ran.
- No `mastra_workspace_execute_command` call appears in the trace.
- The task record had `sandbox_enabled=false` and no working directory.
- The effective Talon configuration has `sprites.enabled=false`.
- The running `talond:v0.2.7` image was built from `dd3e81f88f4565ecfdc988a9967d3598e77b28cb`, which was also the repository’s current main commit when checked on 2026-09-30.
- Talon marked the background task `completed` even though its returned summary said the maintenance did not run. The current manager derives task status from the provider process result; a failed host-tool call does not by itself make that task fail.

This is not a failure to spawn the background agent. The agent ran, but the execution boundary it attempted to use was unavailable.

### Root cause

The repository contains a root `SandboxConfigSchema` with a Docker runtime field, but the code at the deployed revision does not connect that setting to background execution:

- `src/sandbox/index.ts` says the module only exposes the Agent SDK session tracker and that Docker container support is deferred (TASK-037).
- `src/daemon/daemon-bootstrap.ts` constructs `ExecutionEnvManager` only inside the `config.sprites.enabled` branch, using `SpritesClient`.
- The `execution.env` host tool is documented as managing Sprite execution environments. When no execution-environment handler is wired, the host-tool bridge returns the reported “Execution environment system not initialized” error.
- `src/subagents/background/background-agent-manager.ts` sets `disableNativeShellAndFilesystemTools` when a worker has an OAuth-backed MCP server. The OpenAI-compatible provider then does not create its local Mastra Workspace tools, including `mastra_workspace_execute_command`. This preserves the OAuth/host-filesystem security boundary.
- The Talond container has no Docker socket mount, so it cannot create sibling Docker containers itself.

The configuration value is therefore misleading for this use case: it validates, but no background runner consumes it. `sandbox=true` uses the Sprite-backed execution-environment manager when Sprites are enabled and fails when they are not; it never selects Docker. Also, a provider can exit successfully after reporting that the requested work did not happen, so provider completion and task success need distinct status semantics for command-required tasks.

The deployment already mounts `/epic-wiki` and `/workspace` into Talond, but the failed task did not select a working directory. A workspace mount alone neither creates a command runner nor tells a task which files it may modify. A Docker broker must have its own explicit host-side mapping for allowed workspaces; it must not infer host paths from paths visible only inside Talond.

### Related pull requests checked

The open PRs checked on 2026-09-30 do not provide the required Docker-backed background runner:

- [#195 — local git-worktree execution environment adapter](https://github.com/ivo-toby/talon/pull/195) is the closest functional alternative. It adds an environment adapter that runs `bash -lc` in the Talond process and uses git worktrees. Its resource limits are advisory rather than OS-enforced; it is not an inner Docker isolation boundary, and GitHub currently reports it as conflicting.
- [#193 — skill script execution via bubblewrap/apple-container](https://github.com/ivo-toby/talon/pull/193) adds per-skill script execution, not a general background workspace runner and not Docker-backed execution.
- [#192 — remove dormant Docker sandbox config](https://github.com/ivo-toby/talon/pull/192) removes the unused root sandbox configuration; it does not implement a runner.
- [#279 — durable lifecycle pipeline](https://github.com/ivo-toby/talon/pull/279) includes context/lifecycle work but does not change the background command-execution boundary.

Do not merge any of these on the assumption that it supplies the requested Docker runner. The new design should also avoid depending on the root `sandbox.runtime` property, which PR #192 proposes to remove.

## Goals

1. Let a background agent execute commands against an explicitly selected, operator-approved workspace in an isolated Docker container.
2. Keep the LLM, OAuth token store, Glean/Atlassian MCP clients, and Talon host-tool bridge in Talond.
3. Keep Docker authority out of Talond; do not mount `/var/run/docker.sock` into the daemon container.
4. Give the execution container only the workspace and environment required for its task.
5. Fail closed when the runner is unavailable, a workspace is not approved, or a request exceeds its profile.
6. Preserve existing non-command background tasks and keep Sprites as a separate, explicitly selected execution-environment option.

## Non-goals

- Re-enabling provider-native shell or filesystem tools for OAuth-backed runs.
- Replacing Sprites or silently changing the existing `execution.env` contract.
- Giving a background agent arbitrary Docker API access, arbitrary host paths, image selection, privileged flags, or arbitrary environment passthrough.
- Giving the command container OAuth/MCP credentials or direct access to Talon’s config, database, token store, or Docker socket.
- Providing unrestricted network access as a default.
- Making local worktrees, host shell execution, or the optional Codex runner equivalent to the proposed Docker worker.

## Approaches considered

### 1. Restore local workspace tools or run commands in a local worktree

This is the smallest code/config change. It is also the wrong boundary for this deployment: the OAuth guard exists to prevent provider-native tools from reaching local files, and a local-worktree adapter runs commands as children of Talond rather than inside a per-task OS sandbox. PR #195 may restore an execution-environment implementation, but its current design does not provide the required isolation. Do not disable the OAuth guard as a shortcut.

### 2. Add script execution to the wiki skill

A fixed, reviewed script with a narrow input schema could constrain a stable maintenance routine more tightly than a general command tool. PR #193 is related but is not that design: its `skill.exec` tool accepts model-supplied command text and runs it inside a per-skill bubblewrap or Apple Container sandbox. It remains skill-scoped, does not provide the generic background workspace runner needed here, and does not implement the requested Docker backend.

### 3. Add a dedicated Docker execution broker — recommended

A small broker owns Docker access and exposes only a private, authenticated task API. Talon calls that API through a new capability-gated host tool. The broker maps approved workspace IDs and execution profiles to fixed host paths, image digests, resource limits, and network policy. It creates and removes disposable containers; the model cannot pass arbitrary Docker options or host bind paths.

This directly addresses the missing runtime while preserving the OAuth security boundary. The broker is privileged because Docker API access can control the host daemon, so it must be small, private, and strictly validate requests. It must not become a generic, unauthenticated Docker proxy.

## Proposed design

### Component boundary

- **Talond remains the control plane.** It resolves the persona/provider, prepares OAuth-backed MCP servers, runs the background task, and owns task status, trace correlation, and cancellation requests.
- **Docker execution broker is the sole Docker authority.** In the Compose deployment it may be a dedicated service on a private internal network. Only this service may access the Docker socket. The Talond service must not mount that socket. The broker API must be authenticated and unavailable from public ingress.
- **Worker container is the command/data plane.** The broker starts one disposable container for a command-enabled background task, reuses it for that task’s command calls, and removes it on completion, cancellation, timeout, or recovery. It has no Docker socket and is not connected to Talond’s Compose network or external networks by default.
- **Host tools expose a narrow operation.** Add a distinct, capability-gated command-execution tool for background agents (for example, `execution.command`). Do not overload `execution.env`, which is Sprite-specific, or `mastra_workspace_execute_command`, which is intentionally suppressed when OAuth MCPs are present. Talon currently authorizes host tools by capability prefix, so a suffix such as `:<profile>` is not sufficient to enforce a profile boundary. The handler must perform a per-call authorization check against trusted task/persona context and the exact profile/workspace pair.

### Request and workspace contract

At background-task creation, Talon authorizes and persists the task’s exact profile/workspace pair. The agent may request only that pair; it cannot switch to another pair merely because its persona is allowed to use it. The trusted operator configuration maps each workspace ID to:

- A Docker-host absolute source path.
- A container mount target.
- Read-only or read-write mode.
- The profiles/personas allowed to use it.

At task creation, Talon verifies that the parent may spawn that command-enabled persona and bind the selected profile/workspace pair to the task. Talon then authenticates to the broker to create an immutable per-task execution lease. The broker validates the task/persona/profile/workspace combination against its operator-owned allowlist, records the binding, and returns an opaque lease ID. Talon derives `taskId`, `personaId`, and the lease ID from trusted runtime context; none is model-supplied or exposed to the model. Treat the lease ID as a secret: do not log or trace it, scope it to one task, and revoke it on terminal cleanup. Before each broker call, Talon verifies that the caller context still matches the lease binding, and the broker rejects mismatches. The command request may specify a working directory only within the leased workspace. Resolve and validate real paths before execution; reject traversal and symlink escapes. Never accept a raw host mount path, image, Docker argument, network mode, privilege flag, or arbitrary environment map from the model.

The parent-to-worker grant must be operator-owned configuration, not any loaded persona being selectable by a caller with the general `subagent.background` capability. It binds the parent persona to an allowed worker persona/profile/workspace tuple; Talon rejects an ungranted spawn before creating the task or broker lease.

For the wiki-maintenance run, the task must explicitly request the configured wiki workspace and working directory (currently exposed inside Talond as `/epic-wiki`). The broker must have a corresponding host-side mapping to the actual wiki directory. Do not silently default command tasks to Talond’s process directory.

A conceptual Talond configuration could live under `backgroundAgent.commandExecution` rather than the dormant root `sandbox` block:

~~~yaml
backgroundAgent:
  commandExecution:
    enabled: true
    runnerEndpoint: ${TALON_DOCKER_RUNNER_ENDPOINT}
    runnerToken: ${TALON_DOCKER_RUNNER_TOKEN}
    taskGrants:
      - parentPersona: work-context-manager
        workerPersona: work-context-manager
        profile: wiki-maintenance
        workspace: epic-wiki
~~~

The token is for Talond-to-broker authentication only. It must never be forwarded to the model’s command environment. The broker’s trusted configuration separately defines the allowed image digest, workspace-ID-to-host-path mapping, limits, and network policy. Exact field names are illustrative; they should be finalized with the API and schema.

### Execution flow

1. A parent agent requests a background task with a named command-execution profile and explicit workspace ID/working directory. Talon authorizes the parent/persona/profile/workspace tuple and obtains the broker’s immutable task lease before starting a command-required provider run. Tasks that do not need commands remain unchanged.
2. Talon resolves OAuth MCP credentials exactly as it does today. No OAuth/MCP credential is copied to the broker or worker.
3. Talon starts the background model run with the MCPs and the new command tool. It continues to withhold the provider-native local shell/filesystem tools.
4. When the agent calls the command tool, Talon verifies the trusted task/persona context against the lease, then sends the opaque lease ID, relative working directory, command/argv, timeout, and trace correlation. The broker executes only within the immutable profile/workspace binding recorded for that lease.
5. The broker validates every field against trusted configuration, creates or reuses the task’s container, executes the command, and returns bounded stdout/stderr plus exit status and timeout state.
6. On normal completion or any terminal failure, Talon requests cleanup. Cancellation and timeouts must stop the container promptly. Propagate task cancellation and host-tool aborts to the broker's cancel operation; the broker also enforces an absolute command deadline so a lost caller cannot leave a worker running. Do not rely on a timeout race alone to stop the underlying handler. Startup recovery removes orphaned containers associated with dead tasks.

### Isolation and resource policy

Required defaults for a worker container:

- Fixed, operator-approved image pinned by digest; never accept an image from the agent request.
- Read-only root filesystem, non-root UID, dropped Linux capabilities, no-new-privileges, default seccomp, and no privileged mode.
- Only the selected workspace mount; use read-only unless the task needs writes. Do not mount Talon’s `/data`, `/config`, `/personas`, `/skills`, `/userdata`, or Docker socket.
- Bound temporary storage with a size-limited tmpfs. A writable workspace bind mount alone does not enforce a disk quota; use a quota-backed workspace/staging volume or host filesystem quota, and reject write-enabled profiles if the configured disk bound cannot be enforced.
- No host environment inheritance. Pass only explicitly approved non-secret variables.
- Network disabled by default. A profile requiring egress must be an explicit operator choice with a separate, reviewable policy; OAuth MCP traffic should continue through Talon instead.
- CPU, memory, PID, disk/temp-space, wall-clock, concurrency, and output-size bounds.
- Profile command timeouts must fit inside both Talon host-tool/MCP round-trip limits with enough grace to return a structured timeout and clean up the container. If longer commands are required, raise the relevant transport limits consistently; the broker must still enforce its own maximum.
- Structured audit events correlated with Talon task ID and Langfuse trace ID. Do not log credentials, lease IDs, raw command/argv, stdout/stderr, or full secret-bearing environment values. Provider-level observations, the Talon host-tool bridge, and broker logs must all use metadata-only or redacted command telemetry; bounded stdout/stderr may still be returned to the model.

The broker itself is a high-trust component because it can reach Docker. Keep its API private and narrowly typed. Validate profile/workspace IDs server-side, enforce maximum concurrency and timeouts, and reject unknown request fields that could be interpreted as Docker options.

### Failure behavior

- If the broker is disabled or unreachable, report that Docker command execution is unavailable; do not fall back to local shell, Sprites, or an arbitrary provider tool.
- A command-required task is not successful merely because the provider exits with code 0. Persist the broker/execution outcome separately; if required execution is unavailable, times out, or fails its profile-defined completion check, mark the task `failed` and notify the parent truthfully. Define how recoverable non-zero command exits differ from infrastructure failure.
- If a command task omits its workspace/profile, reject it early with an actionable error.
- If a path escapes the configured workspace, reject before launching the command.
- If the worker exceeds its timeout, kill it, collect bounded diagnostics, mark the operation timed out, and remove the container. Ensure the command deadline is below the caller transport timeout with cleanup/response grace, and propagate earlier caller cancellation to the broker.
- If cleanup fails, persist/report the orphaned container ID and retry cleanup during startup recovery.
- A failed broker/API check must not prevent Talond from serving tasks that do not require command execution.

## Implementation sequence

1. Specify and test the parent-to-worker grant, broker task-lease API, immutable task/profile/workspace binding, request validation, and worker lifecycle independently of Talon.
2. Add the Compose broker service and a pinned worker image. Keep the service private; only the broker receives Docker API access.
3. Add Talon configuration, readiness checks, operator-owned parent-to-worker grants, per-task/persona/profile/workspace authorization, broker lease lifecycle, task/container correlation, execution-outcome tracking, redacted command telemetry, cancellation propagation, and orphan cleanup.
4. Add the explicit `epic-wiki` workspace mapping and update the wiki-maintenance background-task invocation to select it.
5. Verify the Docker path end to end with OAuth MCPs enabled while asserting the native workspace shell tool remains absent, command failures are reflected in task status, disk quotas are enforced, and secret sentinels are absent from traces/logs.
6. Enable the capability only for personas/tasks that need it. Keep legacy Sprite execution explicit and separate.

## Acceptance criteria

1. A background task using OAuth-backed Glean/Atlassian MCPs can still call those MCPs and can invoke the new Docker command tool; it does not receive provider-native shell/filesystem tools.
2. An operator-owned parent-to-worker grant is required before spawning a command-enabled persona. Talon and the broker bind an opaque, model-inaccessible lease to one authorized task/persona/profile/workspace tuple. An ungranted spawn is rejected before a task or lease is created, and the agent cannot gain access to another profile or workspace by changing request fields or supplying a different task/persona ID.
3. A task assigned the wiki profile can inspect and update files in the configured wiki workspace, and cannot read or mutate another host-mounted directory.
4. Missing runner, bad authentication, unknown profile/workspace, invalid working directory, path traversal, and symlink escape all fail closed with actionable errors.
5. The worker cannot access Talon secrets, OAuth tokens, config, database, other Compose mounts, Docker socket, or external network under the default profile.
6. CPU/memory/PID/disk/time/output/concurrency bounds are enforced, including the writable workspace quota; command deadline fits within transport limits with response/cleanup grace; caller cancellation reaches the broker, and timeout/cancel/completion remove the task’s container.
7. Task execution outcome is distinct from provider completion: a command-required task is marked `failed` when the runner is unavailable or required work remains incomplete, even if the provider exits successfully.
8. Langfuse, daemon, broker request/access, and worker logs omit command/argv, stdout/stderr, environment values, and lease IDs. Lease IDs may appear only in authenticated Talon↔broker control traffic and protected Talon state, never in model context or logs. Test sentinels supplied through each are absent from captured telemetry while bounded command output remains available to the model.
9. A daemon restart cleans up orphaned task containers without removing containers owned by another service.
10. A non-command background task continues to work without the broker being enabled.
11. No PR currently identified is treated as implementing this design unless its merged code satisfies these criteria.

## Open deployment choice

The broker should be outside Talond’s security domain. For the first Docker Compose implementation, the proposal is a dedicated private broker service with the Docker socket mounted only there. Because that socket is host-equivalent authority, its image, API surface, and workspace allowlist require focused security review. A host-side supervisor with the same narrow API is an alternative if mounting the socket into any container is unacceptable.
