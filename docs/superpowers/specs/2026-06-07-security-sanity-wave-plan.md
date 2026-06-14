# Talon Security Sanity Review And Wave Plan

Date: 2026-06-07
Repo: `ivo-toby/talon`
Branch prepared on: `codex/security-sanity-wave-plan`
Source review: fresh Codex static review plus targeted SQLite read-only verification

This document is the original review record and ticket draft source. GitHub issue `#184` and the GitHub Project board are now the source of truth for execution.

## Outcome Wanted

Turn the security sanity check into executable work:

- preserve the review findings in a markdown report;
- create an epic or identify the parent issue;
- split the work into bounded, agent-pick-up-ready tickets;
- group tickets into dependency waves;
- set up a GitHub Kanban board for execution;
- define what local/runtime setup is needed so agents can actually verify fixes.

## Existing GitHub State

Tracking created on 2026-06-07:

- Project board: `Talon Security Hardening` - https://github.com/users/ivo-toby/projects/5
- Parent epic: `#184` Security hardening epic (pre-v1.0) - https://github.com/ivo-toby/talon/issues/184
- Existing related work: `#202` security: harden terminal WebSocket channel before public-internet exposure
- Existing related work: `#183` Cross-provider OS-level filesystem & exec sandbox
- Existing potential conflict: `#229` memory access scoping work

Created child issues:

- `#232` SEC-001: Host-tools bridge run authentication and local socket/IPC permissions
- `#233` SEC-002: Shared capability parser and policy helpers
- `#234` SEC-003: Sanitized child-process environment builder
- `#235` SEC-004: Enforce scoped capabilities for handlers and execution env ownership
- `#236` SEC-005: Make `requireApproval` fail closed or implement the first approval gate
- `#237` SEC-006: Harden `net.http` egress policy and scoped domains
- `#238` SEC-007: Fix `db.query` read-only connection and fail-closed behavior
- `#239` SEC-008: Add host-tool audit logging
- `#240` SEC-010: Fix inbound thread/message insert races
- `#241` SEC-011: Make `channel.send` current-thread-only until cross-channel addressing exists
- `#242` SEC-012: Consolidate duplicated internal MCP socket client
- `#243` SEC-013: Align capability docs, manifests, Node version docs, and setup skills

Original relevant open issues:

- Parent epic: `#184` Security scan findings (pre-v1.0), now renamed to security hardening epic
- Related existing work: `#202` security: harden terminal WebSocket channel before public-internet exposure
- Related existing work: `#183` Cross-provider OS-level filesystem & exec sandbox
- Related potential conflict: `#229` memory access scoping work

Decision: build on `#184` instead of creating a duplicate epic. `#202` and `#183` were added to the project and linked from the epic.

## Saved Sanity Check Report

### P0 - Host-tools bridge trusts unauthenticated socket callers

The bridge listens on a predictable Unix socket at `src/tools/host-tools-bridge.ts:68`, accepts raw JSON requests at `src/tools/host-tools-bridge.ts:255`, then authorizes using the caller-supplied `context.personaId` at `src/tools/host-tools-bridge.ts:293`. The intended MCP wrapper filters tools, but the daemon bridge has no proof the request came from that wrapper.

Action: add per-run authentication to bridge requests, for example a random bearer or HMAC secret injected only into the MCP child, and verify `runId`, `threadId`, and `personaId` against an active run. Also create `dataDir` and socket directories with `0700` permissions and socket files with restrictive permissions.

### P1 - Agent/provider child processes inherit the full daemon environment

Multiple child processes are spawned with `...process.env`, including internal MCP servers in `src/daemon/agent-runner.ts:570`, Codex CLI in `src/providers/codex-cli-provider.ts:756`, Gemini CLI in `src/providers/gemini-cli-provider.ts:312`, OpenAI-compatible wrapper in `src/providers/openai-compatible-provider.ts:272`, and Mastra local sandbox in `src/providers/openai-compatible/agent-cli/index.ts:182`.

Action: centralize a sanitized env builder. Allow only `PATH`, `HOME`, temp vars, provider-specific auth that process truly needs, and explicit Talon runtime vars.

### P1 - `requireApproval` currently does not require approval

The filter explicitly unions `allow` and `requireApproval` and says approval is future bridge work in `src/tools/tool-filter.ts:187`. The bridge just calls `isToolAllowed` in `src/tools/host-tools-bridge.ts:293`. README says approval prompts happen at `README.md:976` and `README.md:2098`.

Action: either implement approval-gated execution before dispatch, or rename/document `requireApproval` as non-enforcing policy metadata until implemented.

Recommended wave target: fail closed first. A tool that is only in `requireApproval` should not execute silently. If full in-channel approval is too large for the first wave, return an explicit `approval_required` tool error, audit it, and create a follow-up issue for asynchronous approval UX.

### P1 - Scoped capabilities are documented but mostly unenforced

The filter ignores scope by design at `src/tools/tool-filter.ts:11`. `channel.send` accepts any registered channel at `src/tools/host-tools/channel-send.ts:119`, `persona.send` accepts any target persona at `src/tools/host-tools/persona-send.ts:97`, and `net.http` is constructed with an empty allowlist at `src/tools/host-tools-bridge.ts:102`, which means allow all at `src/tools/host-tools/http-proxy.ts:197`.

Action: centralize capability parsing and enforce exact scope or `*` inside each handler. Add tests for cross-channel, cross-persona, background-profile, and domain-denied calls.

### P1 - `net.http` is unrestricted egress once granted

`allowedDomains: []` means all domains are permitted, and only `http:` and `https:` are checked. There is no localhost, RFC1918, link-local, or metadata-service block in `src/tools/host-tools/http-proxy.ts:112`.

Action: default-deny or at least deny private networks by default. Make domain/IP policy configurable and enforce `net.http:<scope>`.

### P2 - `channel.send` can target one connector but reuse the current thread recipient

The tool looks up the requested connector by `channelId`, but sends to the current thread's `external_id` from `src/tools/host-tools/channel-send.ts:143` through `src/tools/host-tools/channel-send.ts:157`. Cross-channel calls can fail or misroute.

Action: decide semantics. If it only sends to the current channel, enforce `channelId === current thread channel`. If cross-channel is intended, require an explicit target recipient/thread.

Recommended wave target: make `channel.send` current-thread-only for now. Cross-channel messaging should be a separate feature with explicit recipient addressing and approval.

### P2 - `db.query` read-only connection likely falls back to writable DB

`createDatabase(..., { readonly: true })` still runs `PRAGMA journal_mode = WAL` at `src/core/database/connection.ts:24`, which writes. The bridge falls back to `ctx.db` on failure at `src/tools/host-tools-bridge.ts:117`. This was reproduced locally with `better-sqlite3`.

Action: skip mutating PRAGMAs for read-only connections and fail closed if the read-only connection cannot open.

### P2 - Inbound pipeline has check-then-insert races

Thread creation does `findByExternalId` then `insert`, and bails on unique race at `src/pipeline/message-pipeline.ts:95`. Message dedupe checks existence before insert at `src/pipeline/message-pipeline.ts:143`, but then queues the candidate message id instead of the persisted row id at `src/pipeline/message-pipeline.ts:212`.

Action: use insert-or-get for threads, and use the `messageRepo.insert()` returned row to decide duplicate vs enqueue.

### P2 - Host-tool audit trail is not wired through dispatch

The audit logger promises tool execution and approval records at `src/core/logging/audit-logger.ts:4`, but host-tool dispatch uses observability only around `src/tools/host-tools-bridge.ts:275`. README also promises audit records at `README.md:2099`.

Action: audit every host-tool allow, deny, timeout, and result, especially side-effecting tools like schedule, channel, persona, background agent, and execution env.

### P3 - Consistency and duplicate-code cleanup

The NDJSON socket client exists twice in `src/tools/host-tools-mcp-server.ts:65` and `src/tools/skill-loader-mcp-server.ts:56`. Capability validation differs between `src/personas/capability-merger.ts:32` and `src/skills/skill-loader.ts:41`. Node version docs disagree: `package.json` requires 24 at `package.json:8`, while installation docs say 22 at `docs/getting-started/installation.mdx:12`.

Action: extract shared socket client, centralize capability grammar, and make Node version a single documented truth.

### Related existing issue finding to preserve

Issue `#184` also contains an important security finding that should remain in the wave scope: `execution.env` operations are authorized by raw `envId`, not by thread/persona ownership. This was not in the final ten-item sanity report, but it is already tracked and should not be lost when `#184` becomes the parent epic.

## Target Shape

Recommended target architecture:

1. Request identity is bound at the daemon boundary.
   - Internal MCP server calls to `HostToolsBridge` carry a per-run secret.
   - Bridge validates the secret and validates `runId`, `threadId`, and `personaId` against active or persisted run context before dispatch.
   - Filesystem IPC/socket surfaces are owner-only by construction.

2. Capabilities become structured policy, not string prefix hints.
   - One shared parser returns `{ domain, action, scope }`.
   - Tool listing can still expose tools by capability prefix.
   - Handler dispatch enforces scope and approval semantics.
   - `requireApproval` never means "execute immediately".

3. Host egress and local execution are explicit.
   - Child processes receive sanitized environments.
   - `net.http` blocks private/local targets unless explicitly allowed.
   - Read-only DB is a real SQLite read-only connection, or the tool is unavailable.

4. Reliability fixes land where security fixes expose hidden races.
   - Message/thread insert races become insert-or-get flows.
   - `channel.send` has current-thread-only semantics until cross-channel addressing is designed.

5. Docs and audit match runtime.
   - Host-tool calls are audit logged.
   - README, docs, setup skills, and examples reflect real approval/scoping behavior.

## Proposed GitHub Project Board

Board title: `Talon Security Hardening`

Recommended fields:

- `Status`: Todo, In Progress, In Review, Blocked, Done
- `Priority`: P0, P1, P2, P3
- `Wave`: Wave 1 Foundation, Wave 2 Enforcement, Wave 3 Runtime Hardening, Wave 4 Reliability, Wave 5 Cleanup
- `Area`: host-tools, capabilities, providers, db, pipeline, ipc, docs
- `Reviewer`: GPT-5.5-xhigh required, normal review

Labels to use or create:

- existing: `security`, `priority: high`, `priority: medium`, `priority: low`, `bug`, `testing`, `infrastructure`, `refactor`, `documentation`
- new recommended: `wave:security-hardening`, `area:host-tools`, `area:capabilities`, `area:providers`, `area:pipeline`, `area:ipc`, `area:docs`, `needs:high-rigor-review`

Local GitHub auth already appears to have the `project` scope, so `gh project` should be able to create the board after approval.

Created board:

- https://github.com/users/ivo-toby/projects/5

Created fields:

- `Priority`
- `Wave`
- `Area`
- `Review Gate`

Initial status:

- Epic, existing related issues, and all SEC issues are on the board.
- New SEC issues start in `Todo`.

## Dependency Waves

### Wave 1 - Security foundations

Goal: establish shared primitives used by later work.

Tickets:

- SEC-001: Host-tools bridge run authentication and local socket/IPC permissions
- SEC-002: Shared capability parser and policy helpers
- SEC-003: Sanitized child-process environment builder

Expected model: GPT-5.4 or GPT-5.5 for SEC-001 and SEC-002; GPT-5.3-codex-high is acceptable for SEC-003 if the brief is followed tightly.

Stop condition: high-rigor review on SEC-001 and SEC-002 before Wave 2 starts.

Conflict files:

- `src/tools/host-tools-bridge.ts`
- `src/tools/host-tools-mcp-server.ts`
- `src/tools/skill-loader-mcp-server.ts`
- `src/tools/tool-filter.ts`
- `src/personas/capability-merger.ts`
- `src/skills/skill-loader.ts`

### Wave 2 - Authorization enforcement

Goal: make documented policy true at runtime.

Tickets:

- SEC-004: Enforce scoped capabilities for channel, persona, background profiles, and execution env ownership
- SEC-005: Make `requireApproval` fail closed or implement the first approval gate
- SEC-006: Harden `net.http` egress policy and scoped domains

Expected model: GPT-5.5 or GPT-5.4 high reasoning. These touch core security semantics.

Stop condition: run focused unit tests plus a manual terminal-channel smoke test. Reconcile any config/docs impact before Wave 3.

Conflict files:

- `src/tools/host-tools/channel-send.ts`
- `src/tools/host-tools/persona-send.ts`
- `src/tools/host-tools/background-agent.ts`
- `src/tools/host-tools/execution-env.ts`
- `src/tools/host-tools/http-proxy.ts`
- `src/tools/tool-filter.ts`
- `README.md`
- docs under `docs/guides` and `docs/reference`

### Wave 3 - Runtime hardening

Goal: make runtime safety controls actually effective.

Tickets:

- SEC-007: Fix `db.query` read-only connection and fail-closed behavior
- SEC-008: Add host-tool audit logging for allow, deny, approval-required, timeout, and result
- SEC-009: Continue or link existing terminal-channel hardening issue `#202`

Expected model: GPT-5.3-codex-high for SEC-007 and SEC-008, GPT-5.4 for terminal hardening if implemented in this wave.

Stop condition: verify audit rows are written for representative tool calls, and confirm `db.query` cannot silently fall back to the writable connection.

Conflict files:

- `src/core/database/connection.ts`
- `src/tools/host-tools-bridge.ts`
- `src/core/logging/audit-logger.ts`
- `src/channels/connectors/terminal/*`

### Wave 4 - Reliability and semantics

Goal: remove glaring bugs and ambiguous behavior discovered during the security pass.

Tickets:

- SEC-010: Fix inbound thread/message insert races with insert-or-get semantics
- SEC-011: Make `channel.send` current-thread-only until cross-channel addressing is designed

Expected model: GPT-5.3-codex-high.

Stop condition: focused pipeline/channel tests pass, and no duplicate delivery or dead-letter regression is observed in terminal smoke testing.

Conflict files:

- `src/pipeline/message-pipeline.ts`
- `src/core/database/repositories/thread-repository.ts`
- `src/core/database/repositories/message-repository.ts`
- `src/tools/host-tools/channel-send.ts`

### Wave 5 - Cleanup and documentation

Goal: remove drift and duplication left after hardening.

Tickets:

- SEC-012: Consolidate duplicated internal MCP socket client
- SEC-013: Align capability grammar, handler manifests, Node version docs, README, and setup skills

Expected model: GPT-5.3-codex-high.

Stop condition: build, lint, focused tests, and docs diff review pass. No behavior changes beyond documented cleanup.

Conflict files:

- `src/tools/host-tools-mcp-server.ts`
- `src/tools/skill-loader-mcp-server.ts`
- `src/tools/internal/*` or a new shared module
- `package.json`
- `README.md`
- `docs/getting-started/installation.mdx`
- `.agents/skills/*` or `.Codex/skills/*` if present

## Ticket Drafts

These drafts are intended to become GitHub issues. Replace `Parent epic` with the final epic link once `#184` is updated or a new epic is created.

### SEC-001 - Host-tools bridge run authentication and local socket/IPC permissions

Labels: `security`, `priority: high`, `infrastructure`, `area:host-tools`, `area:ipc`, `wave:security-hardening`, `needs:high-rigor-review`

Parent epic: `#184` or replacement epic

#### Context

`HostToolsBridge` listens on `<dataDir>/host-tools.sock`. Requests include caller-controlled `context.runId`, `context.threadId`, and `context.personaId`. The bridge then resolves capabilities for that persona and dispatches the requested host tool. The intended internal MCP server filters tools before sending, but the daemon bridge does not authenticate that the request came from the MCP wrapper that Talon spawned for the run.

Related files:

- `src/tools/host-tools-bridge.ts`
- `src/tools/host-tools-mcp-server.ts`
- `src/tools/skill-loader-mcp-server.ts`
- `src/daemon/agent-runner.ts`
- `src/subagents/background/background-agent-manager.ts`
- `src/daemon/daemon.ts`
- `src/ipc/daemon-ipc-client.ts`
- `src/ipc/daemon-ipc-server.ts`
- `src/cli/commands/setup.ts`

#### End goal / deliverable

Only Talon-spawned internal MCP processes for a specific run can call host tools for that run. Local IPC and socket directories/files are created with explicit owner-only permissions.

#### Scope

- Generate a per-run bridge secret in foreground and background run setup.
- Inject the secret into `__talond_host_tools` and `__talond_skill_loader` environments.
- Include the secret in every bridge request.
- Have `HostToolsBridge` validate the secret before resolving capabilities or dispatching.
- Validate that request `runId`, `threadId`, and `personaId` match the active or persisted run context.
- Make missing, invalid, or mismatched secrets fail closed.
- Create `dataDir`, IPC dirs, and socket parent dirs with restrictive permissions where Talon owns creation.
- Avoid logging the bridge secret.

#### RED/GREEN TDD instructions

RED:

- Add a unit test where a direct bridge request without a secret is rejected.
- Add a unit test where a request with a valid secret but mismatched `personaId` is rejected.
- Add a unit test where an MCP wrapper request with the injected secret succeeds.
- Add a filesystem test for setup/IPC directory mode where practical on POSIX.

GREEN:

- Implement the minimum code to pass the tests.
- Keep existing allowed-tool filtering as defense in depth, not the only security control.

#### Acceptance criteria

- Unauthorized raw socket requests cannot execute host tools.
- Run/persona/thread mismatches are rejected even with a syntactically valid request.
- Internal skill loading still works for valid runs.
- Socket/IPC directories are owner-only when created by Talon.
- No bridge secret appears in logs, errors, or observability payloads.
- Focused tests and `npm run build` pass.

#### Review handoff notes

Ask GPT-5.5-xhigh to look specifically for:

- secret leakage through logs or child process args;
- replay risks across runs;
- confused-deputy paths for background agents;
- compatibility with foreground and background MCP server creation;
- whether the bridge still trusts caller-provided identity too early.

#### Out of scope

- Full OS-level provider sandboxing, tracked in `#183`.
- Public network access to IPC.
- Replacing file-based daemon IPC with a new transport.

#### Suggested branch and PR

Branch: `codex/sec-001-bridge-auth`
PR title: `security: authenticate host-tools bridge requests`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/tools/host-tools-bridge.test.ts`
- `rtk npx vitest run tests/unit/tools/host-tools-mcp-server.test.ts tests/unit/tools/skill-loader-mcp-server.test.ts` if those files exist or are added

### SEC-002 - Shared capability parser and policy helpers

Labels: `security`, `priority: high`, `refactor`, `area:capabilities`, `wave:security-hardening`, `needs:high-rigor-review`

Parent epic: `#184` or replacement epic

#### Context

Capability strings are parsed in multiple places with slightly different grammars. `tool-filter.ts` ignores scopes for tool listing, `capability-merger.ts` accepts `*` scopes, and `skill-loader.ts` rejects `*` in scoped capability labels. Handlers that are supposed to enforce scoped labels do not have a shared helper for exact/wildcard checks.

Related files:

- `src/tools/tool-filter.ts`
- `src/personas/capability-merger.ts`
- `src/skills/skill-loader.ts`
- `src/core/config/config-schema.ts`
- tests under `tests/unit/tools`, `tests/unit/personas`, and `tests/unit/skills`

#### End goal / deliverable

A single capability parser and matching helper are used across validation, merging, filtering, and handler-level scope enforcement.

#### Scope

- Add a shared module, for example `src/personas/capabilities.ts` or `src/tools/capabilities.ts`.
- Parse labels into `{ domain, action, prefix, scope }`.
- Accept both scoped and scope-less labels only where current backward compatibility requires it.
- Treat `*` as a valid wildcard scope.
- Provide helpers like `hasCapability(capabilities, "channel.send", "telegram")`.
- Preserve current tool listing behavior by prefix, but make handler code able to enforce scopes.
- Update unit tests around validation and tool filtering.

#### RED/GREEN TDD instructions

RED:

- Add parser tests for `channel.send:telegram`, `channel.send:*`, `subagent.background`, malformed labels, and labels with unsupported punctuation.
- Add tests proving `skill-loader` and `capability-merger` accept the same valid grammar.
- Add tests proving prefix-only tool listing remains backward compatible.

GREEN:

- Implement shared parser and migrate existing parsing call sites.
- Keep warnings/errors compatible unless a behavior change is explicitly called out in tests.

#### Acceptance criteria

- One shared parser owns capability grammar.
- `channel.send:*` is valid everywhere capability labels are validated.
- Scope-less labels remain handled deliberately, with the current warning behavior if kept.
- Existing tests pass after migration.
- New helper can be used by Wave 2 tickets without more parser work.

#### Review handoff notes

Ask GPT-5.5-xhigh to check for:

- accidental broadening of malformed labels;
- inconsistent treatment of missing scope;
- places still using ad hoc regex parsing;
- behavior changes that could break existing configs without migration notes.

#### Out of scope

- Enforcing every scoped capability in handlers. That belongs to SEC-004 and SEC-006.
- Reworking persona config schema beyond capability validation.

#### Suggested branch and PR

Branch: `codex/sec-002-capability-parser`
PR title: `refactor: centralize capability parsing`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/tools/tool-filter.test.ts tests/unit/personas tests/unit/skills`

### SEC-003 - Sanitized child-process environment builder

Labels: `security`, `priority: high`, `refactor`, `area:providers`, `wave:security-hardening`

Parent epic: `#184` or replacement epic

#### Context

Foreground providers, background providers, and internal MCP servers spawn child processes with `...process.env`. That leaks daemon-level secrets to provider CLIs, wrapper processes, and local execution sandboxes. This includes environment variables loaded from `.env`.

Related files:

- `src/daemon/agent-runner.ts`
- `src/providers/codex-cli-provider.ts`
- `src/providers/gemini-cli-provider.ts`
- `src/providers/openai-compatible-provider.ts`
- `src/providers/openai-compatible/agent-cli/index.ts`
- `src/subagents/background/background-agent-process.ts`
- `src/subagents/background/background-agent-manager.ts`

#### End goal / deliverable

All child process spawns use a shared sanitized environment builder. No unrelated daemon secrets are inherited by default.

#### Scope

- Add a helper, for example `src/core/process/env.ts`.
- Include safe baseline variables needed for process execution: `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, shell locale variables if needed, and platform-specific essentials.
- Allow call sites to add explicit provider env vars and explicit Talon runtime env vars.
- Remove raw `...process.env` from provider and internal MCP spawn paths.
- For OpenAI-compatible Mastra local sandbox, pass sanitized env instead of full `process.env`.
- Add tests with canary variables like `TALON_TEST_SECRET_SHOULD_NOT_LEAK`.

#### RED/GREEN TDD instructions

RED:

- Add tests for env builder allowlist behavior.
- Add provider spawn tests where a canary env var exists in parent but not in child options.
- Add tests proving explicit env overrides still arrive.

GREEN:

- Implement helper and migrate spawn call sites.
- Keep provider-specific required env working by explicit allow or invocation env.

#### Acceptance criteria

- No provider/internal MCP/background spawn directly spreads `process.env`.
- Tests prove unrelated secrets do not leak.
- Existing provider behavior still works with explicit runtime env.
- Build passes.

#### Review handoff notes

Ask reviewer to look for:

- hidden `process.env` spread still present;
- provider auth accidentally removed;
- platform vars required on macOS/Linux;
- secret exposure through command-line args.

#### Out of scope

- OS-level provider sandboxing, tracked in `#183`.
- Removing all environment access from application code.

#### Suggested branch and PR

Branch: `codex/sec-003-sanitized-env`
PR title: `security: sanitize child process environments`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/providers tests/unit/daemon/agent-runner.test.ts tests/unit/subagents`

### SEC-004 - Enforce scoped capabilities for handlers and execution env ownership

Labels: `security`, `priority: high`, `area:host-tools`, `area:capabilities`, `wave:security-hardening`, `needs:high-rigor-review`

Parent epic: `#184` or replacement epic

#### Context

Scoped capability labels are documented, but handlers mostly enforce only tool-level access. `channel.send:<channel>` should restrict channel sends. `persona.send:<persona>` should restrict delegation targets. `subagent.background.profile:<name>` should restrict background profile elevation. Existing issue `#184` also identifies `execution.env` ownership checks as missing.

Related files:

- `src/tools/host-tools/channel-send.ts`
- `src/tools/host-tools/persona-send.ts`
- `src/tools/host-tools/background-agent.ts`
- `src/tools/host-tools/execution-env.ts`
- `src/tools/host-tools-bridge.ts`
- `src/tools/tool-filter.ts`
- `src/personas/capabilities.ts` or equivalent from SEC-002

#### End goal / deliverable

Handlers enforce scoped capability labels at runtime, and `execution.env` operations cannot cross thread/persona ownership boundaries by raw env id.

#### Scope

- Thread resolved capabilities into handlers or provide a bridge helper for scope checks.
- Enforce `channel.send:<channelNameOrId>` or `channel.send:*` before sending.
- Enforce `persona.send:<personaName>` or `persona.send:*` before delegation and persona listing/status behavior.
- Enforce `subagent.background.profile:<name>` or `subagent.background.profile:*` when a background profile is specified.
- For `execution.env`, require the env/checkpoint to belong to the current thread/persona or an explicitly allowed scope.
- Add clear error messages and audit rejections.

#### RED/GREEN TDD instructions

RED:

- Test that `channel.send:telegram` cannot send to Slack.
- Test that `persona.send:researcher` cannot target `ops`.
- Test that background profile `privileged` cannot be spawned without matching scope.
- Test that an `execution.env` id from another thread/persona is rejected.

GREEN:

- Implement scope checks using shared helpers from SEC-002.
- Keep `*` behavior working for existing broad grants.

#### Acceptance criteria

- Scope-specific capabilities are enforced in every listed handler.
- Wildcard grants are explicit and tested.
- Cross-persona/background privilege escalation is blocked.
- Cross-thread/persona execution-env access is blocked.
- Docs and examples are updated if scope syntax changes.

#### Review handoff notes

Ask GPT-5.5-xhigh to check for:

- confused-deputy behavior through persona names vs ids;
- profile-based privilege escalation;
- execution env ownership bypasses through checkpoint/restore paths;
- backward compatibility for current configs using `*`.

#### Out of scope

- Network domain enforcement, covered by SEC-006.
- Approval semantics, covered by SEC-005.

#### Suggested branch and PR

Branch: `codex/sec-004-scoped-capabilities`
PR title: `security: enforce scoped host-tool capabilities`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/tools/host-tools tests/unit/tools/host-tools-bridge.test.ts`

### SEC-005 - Make `requireApproval` fail closed or implement the first approval gate

Labels: `security`, `priority: high`, `area:host-tools`, `area:capabilities`, `wave:security-hardening`, `needs:high-rigor-review`

Parent epic: `#184` or replacement epic

#### Context

`requireApproval` currently exposes and allows tools like `allow`. Docs say Talon prompts the user in-channel, but no bridge-level approval gate exists.

Related files:

- `src/tools/tool-filter.ts`
- `src/tools/host-tools-bridge.ts`
- `src/core/logging/audit-logger.ts`
- README capability sections
- docs under `docs/guides/personas.mdx`, `docs/reference/host-tools.mdx`, and config docs

#### End goal / deliverable

A capability listed only in `requireApproval` no longer executes immediately.

#### Scope

Preferred minimum safe version:

- Keep tools listed if needed for model awareness.
- At bridge dispatch time, classify the matched capability as `allow`, `requireApproval`, or `deny`.
- Execute only `allow`.
- Return an explicit `approval_required` error for `requireApproval` until a full approval workflow exists.
- Audit every `approval_required` decision.
- Update docs to state current behavior exactly.

Optional expanded version if approved:

- Add a persisted approval request model.
- Prompt the originating channel/operator.
- Execute only after an approval decision.

#### RED/GREEN TDD instructions

RED:

- Test that a tool in `requireApproval` but not `allow` is not dispatched.
- Test that a tool in `allow` still dispatches.
- Test that a tool in neither list is denied.
- Test audit entry for approval-required.

GREEN:

- Implement policy classification and fail-closed behavior.
- Update docs/examples to avoid false security claims.

#### Acceptance criteria

- `requireApproval` no longer means immediate execution.
- Agent receives a clear error explaining approval is required.
- Audit log records the attempted tool, persona, run, and decision.
- README and docs no longer promise behavior not implemented.

#### Review handoff notes

Ask GPT-5.5-xhigh to check for:

- any remaining path that unions `allow` and `requireApproval` for execution;
- docs still claiming in-channel prompts if not implemented;
- compatibility impact on existing personas.

#### Out of scope

- Full async approval UX unless explicitly chosen for this ticket.
- New CLI approval commands unless full approval UX is in scope.

#### Suggested branch and PR

Branch: `codex/sec-005-require-approval`
PR title: `security: make requireApproval fail closed`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools-bridge.test.ts`

### SEC-006 - Harden `net.http` egress policy and scoped domains

Labels: `security`, `priority: high`, `area:host-tools`, `area:capabilities`, `wave:security-hardening`

Parent epic: `#184` or replacement epic

#### Context

`HttpProxyHandler` is constructed with `allowedDomains: []`, and empty means allow all. It also allows local/private network targets unless DNS or fetch fails. This creates SSRF and exfiltration risk for any persona granted `net.http:egress`.

Related files:

- `src/tools/host-tools/http-proxy.ts`
- `src/tools/host-tools-bridge.ts`
- capability parser from SEC-002
- README and docs capability tables

#### End goal / deliverable

`net.http` enforces safe egress policy by default and supports scoped domain capabilities.

#### Scope

- Block loopback, link-local, RFC1918/private, multicast, and common metadata IP ranges by default.
- Support `net.http:<domain>` scope checks using the shared capability helper.
- Decide and document whether `net.http:egress` means all public internet or a legacy alias.
- Prefer fail-closed when no allowed domain/scope is configured.
- Add tests for hostnames, subdomains, IP literals, localhost, IPv6 loopback, and metadata IPs.

#### RED/GREEN TDD instructions

RED:

- Test `http://127.0.0.1`, `http://localhost`, `http://169.254.169.254`, and `http://10.0.0.1` are denied by default.
- Test `https://api.example.com` is allowed only when scope permits `example.com` or `api.example.com`.
- Test subdomain matching behavior explicitly.

GREEN:

- Implement IP/hostname checks before fetch.
- Enforce scopes with shared helpers.

#### Acceptance criteria

- No unrestricted empty-allowlist behavior remains unless explicitly configured and documented.
- Private/local targets are blocked by default.
- Domain scopes work with exact and documented subdomain semantics.
- Tests cover IPv4 and IPv6 basics.

#### Review handoff notes

Ask reviewer to check for:

- DNS rebinding risk;
- IPv6 private/link-local gaps;
- accidental broad matching like `badexample.com` matching `example.com`;
- whether default behavior breaks existing personas and docs address migration.

#### Out of scope

- Full egress proxy infrastructure.
- Browser-like CORS policy.

#### Suggested branch and PR

Branch: `codex/sec-006-http-egress`
PR title: `security: enforce net.http egress policy`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/tools/host-tools/http-proxy.test.ts`

### SEC-007 - Fix `db.query` read-only connection and fail-closed behavior

Labels: `security`, `priority: medium`, `bug`, `area:db`, `area:host-tools`, `wave:security-hardening`

Parent epic: `#184` or replacement epic

#### Context

The bridge tries to open a separate read-only SQLite connection for `db.query`, but `createDatabase(..., { readonly: true })` unconditionally runs `PRAGMA journal_mode = WAL`, which writes and can fail on read-only connections. The bridge falls back to the writable main connection.

Related files:

- `src/core/database/connection.ts`
- `src/tools/host-tools-bridge.ts`
- `src/tools/host-tools/db-query.ts`
- `tests/unit/core/database/connection.test.ts`
- tests for `db-query`

#### End goal / deliverable

`db.query` uses a real SQLite read-only connection, and if that connection cannot be opened, the tool is unavailable rather than silently using the writable main DB.

#### Scope

- Skip mutating PRAGMAs in read-only mode.
- Keep safe read-only PRAGMAs if supported.
- Fail closed in `HostToolsBridge` when the read-only DB cannot open.
- Fix stale manifest/docs mismatch if needed: handler manifest says `db.read:own`, registry/docs use `db.query:own`.
- Add tests.

#### RED/GREEN TDD instructions

RED:

- Test `createDatabase(path, { readonly: true })` opens after a DB has been created.
- Test write attempts on the read-only connection fail.
- Test bridge does not fall back to writable DB when read-only open fails.

GREEN:

- Adjust connection factory and bridge behavior.
- Update docs/manifests.

#### Acceptance criteria

- Read-only open works.
- Write attempts through read-only connection fail at SQLite level.
- Bridge fail-closed behavior is tested.
- `db.query` capability naming is consistent.

#### Review handoff notes

Ask reviewer to check for:

- hidden writable fallback;
- mutating PRAGMAs still executed in read-only mode;
- tests that use in-memory DB but miss file-backed behavior.

#### Out of scope

- Redesigning SQL validation.
- Expanding queryable table list.

#### Suggested branch and PR

Branch: `codex/sec-007-db-query-readonly`
PR title: `security: make db.query read-only connection real`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/core/database/connection.test.ts tests/unit/tools/host-tools/db-query.test.ts tests/unit/tools/host-tools-bridge.test.ts`

### SEC-008 - Add host-tool audit logging

Labels: `security`, `priority: medium`, `infrastructure`, `area:host-tools`, `wave:security-hardening`

Parent epic: `#184` or replacement epic

#### Context

`AuditLogger` documents durable audit records for tool execution and approval decisions, but host-tool dispatch currently records observability traces, not audit rows. README promises audit decisions/results for MCP tool calls.

Related files:

- `src/tools/host-tools-bridge.ts`
- `src/core/logging/audit-logger.ts`
- `src/core/database/repositories/audit-repository.ts`
- README security/audit sections
- tests under `tests/unit/tools`

#### End goal / deliverable

Every host-tool request produces durable audit entries for allow/deny/approval-required/timeout/result.

#### Scope

- Add audit writes around bridge dispatch.
- Include run id, thread id, persona id, tool name, request id, decision, status, and sanitized details.
- Avoid storing full sensitive payloads for tools like `net.http` headers or secrets.
- Add tests with an in-memory audit store/repository.
- Update docs if needed.

#### RED/GREEN TDD instructions

RED:

- Test allowed tool call writes audit entry.
- Test denied tool call writes audit entry.
- Test approval-required writes audit entry.
- Test timeout/error writes audit entry.
- Test sensitive fields are redacted or omitted.

GREEN:

- Implement audit calls in one bridge-level place.
- Keep handler-level logging unchanged unless needed.

#### Acceptance criteria

- Host-tool calls are visible in `audit_log`.
- Audit records are sanitized.
- Docs match runtime.
- Tests cover success and denial paths.

#### Review handoff notes

Ask reviewer to check for:

- payload secret leakage;
- missing audit paths for early returns;
- audit writes throwing and breaking tool dispatch;
- excessive row size.

#### Out of scope

- Building an audit viewer UI.
- Backfilling historic audit rows.

#### Suggested branch and PR

Branch: `codex/sec-008-host-tool-audit`
PR title: `security: audit host-tool dispatch decisions`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/tools/host-tools-bridge.test.ts tests/unit/core/logging/audit-logger.test.ts`

### SEC-009 - Terminal WebSocket hardening

Labels: already tracked on `#202`

Parent epic: `#184` or replacement epic

#### Context

Terminal hardening is already tracked in issue `#202`. The current sanity review confirms one of its main findings: shared-token holders can choose arbitrary `clientId`, hijack or kick existing clients, and drive another user's thread.

#### End goal / deliverable

Do not create a duplicate issue. Add `#202` to the security hardening board and link it from the epic.

#### Scope

Use the existing issue body in `#202` as the ticket source. If it is too large for one PR, split it later into sub-issues:

- per-client/server-derived identity;
- auth and message rate limits;
- origin checks;
- terminal config schema;
- heartbeat/connection caps;
- docs and Nginx hardening.

#### Acceptance criteria

- `#202` is on the Kanban board.
- It is linked from the epic.
- If started, it follows the wave stop/review rules.

### SEC-010 - Fix inbound thread/message insert races

Labels: `bug`, `priority: medium`, `area:pipeline`, `wave:security-hardening`

Parent epic: `#184` or replacement epic

#### Context

The pipeline has check-then-insert patterns. Schedule management already has a race recovery pattern and test for dedicated threads. The inbound message path should follow the same idea.

Related files:

- `src/pipeline/message-pipeline.ts`
- `src/core/database/repositories/thread-repository.ts`
- `src/core/database/repositories/message-repository.ts`
- `src/core/database/repositories/queue-repository.ts`
- `tests/unit/pipeline/message-pipeline.test.ts`

#### End goal / deliverable

Concurrent first messages for a thread and concurrent duplicate messages do not produce errors, dead letters, or duplicate runs.

#### Scope

- Add `findOrCreateByExternalId` or insert-or-get behavior for threads.
- Use `MessageRepository.insert()` returned persisted row to identify whether insert won or deduped.
- Queue only when the current event actually materialized as the persisted inbound message, or otherwise return `duplicate`.
- Add tests for unique-race recovery.

#### RED/GREEN TDD instructions

RED:

- Test concurrent thread create race where insert fails with unique constraint and re-query succeeds.
- Test duplicate message race where insert returns an existing row with a different id and pipeline does not enqueue candidate id.

GREEN:

- Implement repository/pipeline changes.
- Keep normal first-message behavior unchanged.

#### Acceptance criteria

- Race cases return deterministic pipeline results.
- Queue item `message_id` always points to an existing message.
- No duplicate queue item is enqueued for a duplicate idempotency key.
- Existing pipeline tests pass.

#### Review handoff notes

Ask reviewer to check for:

- queue payload id vs persisted message id mismatch;
- accidental message drops for non-duplicates;
- transaction boundaries and unique constraint handling.

#### Out of scope

- Changing connector idempotency keys.
- Queue scheduler redesign.

#### Suggested branch and PR

Branch: `codex/sec-010-pipeline-races`
PR title: `fix: make inbound thread and message ingest race-safe`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/pipeline/message-pipeline.test.ts tests/integration/e2e/message-flow.test.ts`

### SEC-011 - Make `channel.send` current-thread-only until cross-channel addressing exists

Labels: `bug`, `priority: medium`, `connector`, `area:host-tools`, `wave:security-hardening`

Parent epic: `#184` or replacement epic

#### Context

`channel.send` accepts a target `channelId` but sends to the current thread's external recipient. If the requested channel differs from the current thread channel, this can fail or misroute.

Related files:

- `src/tools/host-tools/channel-send.ts`
- `src/tools/host-tools/schedule-manage.ts`
- `src/daemon/schedule-thread-utils.ts`
- channel connector tests

#### End goal / deliverable

`channel.send` only sends through the current thread's channel unless a future explicit cross-channel addressing design is implemented.

#### Scope

- Resolve current thread.
- Reject requests where `args.channelId` does not match current thread channel id or channel name.
- Preserve schedule-thread origin recipient behavior.
- Update MCP tool description and docs to clarify current-thread semantics.
- Add tests for same-channel success and cross-channel rejection.

#### RED/GREEN TDD instructions

RED:

- Test Telegram thread cannot call `channel.send` with Slack channel id/name.
- Test same-channel call still sends to current external id.
- Test dedicated schedule thread still sends to `originExternalId`.

GREEN:

- Add validation before connector lookup/send.
- Update docs.

#### Acceptance criteria

- No cross-channel send can happen through this tool.
- Error explains that explicit cross-channel addressing is not supported.
- Schedule notification behavior remains intact.

#### Review handoff notes

Ask reviewer to check for:

- breakage of scheduled notifications;
- channel name vs id ambiguity;
- conflict with scoped `channel.send:<channel>` enforcement from SEC-004.

#### Out of scope

- Designing cross-channel recipients.
- Adding per-channel default destinations.

#### Suggested branch and PR

Branch: `codex/sec-011-channel-send-semantics`
PR title: `fix: make channel.send current-thread scoped`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/tools/host-tools/channel-send.test.ts tests/unit/tools/host-tools/schedule-manage.test.ts`

### SEC-012 - Consolidate duplicated internal MCP socket client

Labels: `refactor`, `priority: low`, `area:host-tools`, `wave:security-hardening`

Parent epic: `#184` or replacement epic

#### Context

`host-tools-mcp-server.ts` and `skill-loader-mcp-server.ts` both implement a very similar NDJSON socket client. Security fixes to bridge request shape and timeout behavior will need to stay consistent across both.

Related files:

- `src/tools/host-tools-mcp-server.ts`
- `src/tools/skill-loader-mcp-server.ts`
- new shared internal module under `src/tools`

#### End goal / deliverable

One shared internal bridge socket client is used by both internal MCP server entry points.

#### Scope

- Extract shared connection/request/timeout/buffer logic.
- Keep each MCP server's tool definitions local.
- Preserve existing CLI entry point behavior.
- Add tests for request/response, timeout, invalid JSON, and connection error if feasible.

#### RED/GREEN TDD instructions

RED:

- Add tests around shared client behavior before extraction or as part of extraction.
- Test both wrappers still construct requests with the right context.

GREEN:

- Extract client and update wrappers.
- Keep emitted stderr labels useful.

#### Acceptance criteria

- Duplicate socket-client implementation is removed.
- Both internal MCP servers still function.
- Tests cover timeout and response routing.

#### Review handoff notes

Ask reviewer to check for:

- behavior drift between host-tools and skill-loader wrappers;
- lost context fields like `a2aTaskId`, `allowedHostRoots`, or `traceparent`;
- process exit behavior changes.

#### Out of scope

- Changing MCP tool schemas.
- Bridge authentication beyond using the shared client shape from SEC-001.

#### Suggested branch and PR

Branch: `codex/sec-012-bridge-client-refactor`
PR title: `refactor: share internal MCP bridge client`

#### Verification commands

- `rtk npm run build`
- `rtk npx vitest run tests/unit/tools`

### SEC-013 - Align capability docs, manifests, Node version docs, and setup skills

Labels: `documentation`, `priority: low`, `area:docs`, `wave:security-hardening`

Parent epic: `#184` or replacement epic

#### Context

Docs and code have drifted. Examples and docs use scoped capabilities that runtime does not fully enforce today. `DbQueryHandler` manifest says `db.read:own` while registry/docs use `db.query:own`. `package.json` requires Node 24, while some docs say Node 22. Setup skills may also need updates after security behavior changes.

Related files:

- `package.json`
- `README.md`
- `docs/getting-started/installation.mdx`
- `docs/landing.mdx`
- `docs/reference/host-tools.mdx`
- `docs/guides/personas.mdx`
- `config/talond.example.yaml`
- `.agents/skills/*` or `.Codex/skills/*` if present and affected

#### End goal / deliverable

Docs, examples, handler manifests, and setup skills accurately describe current runtime behavior.

#### Scope

- Align Node version requirements.
- Align capability names and scope syntax.
- Update docs for `requireApproval` behavior after SEC-005.
- Update setup/add skills affected by changed config or setup guidance.
- Remove or clearly mark stale claims about approval prompts, scoped capabilities, and DB read-only layers.

#### RED/GREEN TDD instructions

RED:

- Add doc/config validation tests if available, or a script/check that catches Node version mismatch and capability name mismatch.
- Add tests for manifest capability names if not present.

GREEN:

- Update docs and examples.
- Add lightweight guard tests where practical.

#### Acceptance criteria

- Node version is consistent across package and docs.
- Capability examples match enforced runtime.
- Setup skills match current implementation.
- README no longer claims unimplemented approval prompts.

#### Review handoff notes

Ask reviewer to check for:

- docs promising stronger security than code;
- stale skill instructions;
- hidden references to Node 22;
- capability name mismatch.

#### Out of scope

- Implementing behavior not already landed in earlier waves.

#### Suggested branch and PR

Branch: `codex/sec-013-doc-consistency`
PR title: `docs: align security capability behavior`

#### Verification commands

- `rtk npm run build`
- `rtk npm run lint`
- any docs checks available in the repo

## Testing Setup Approved By Ivo

Most tickets can be verified with focused unit/integration tests and no external services. Ivo approved the following local verification setup.

### Required local baseline

- Use Node 24+, matching `package.json`.
- Run `npm ci`.
- If native SQLite bindings complain after Node changes, run `npm run rebuild:sqlite`.
- Keep `rtk` available; repo instructions require all shell commands to be prefixed with `rtk`.
- Keep `gh` authenticated with `repo` and `project` scopes. Current local auth already appears to have these scopes.

Status on 2026-06-07: Ivo ran the Node/npm baseline setup and reported no issues.

### Test config for local daemon smoke tests

Ivo approved a checked-in sanitized fixture config for smoke tests, for example `config/talond.smoke.yaml` or `tests/fixtures/talond.smoke.yaml`.

It should include:

- storage path under a throwaway temp/test data dir;
- one terminal channel bound to `127.0.0.1`;
- a strong terminal token from an env var;
- two personas:
  - low-trust persona with narrow capabilities;
  - privileged persona for negative cross-persona tests;
- fake or stub provider command for no-cost smoke tests where possible.

Do not put real provider keys in this fixture.

### Provider/runtime setup

For most security tickets, agents should add fake provider/spawn fixtures rather than call live LLMs. For manual end-to-end confidence, the following providers are available:

- `codex-cli` provider is authenticated and may be used for live smoke testing.
- `openai-compatible` can also be used with:
  - `OLLAMA_BASE_URL=https://trogdor.skynet-mcp.com/`
  - `OLLAMA_API_KEY=<fake>`
  - `OLLAMA_SUBAGENT_MODEL=Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf`
  - `OLLAMA_AGENT_MODEL=Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf`

Live provider testing should be optional and explicitly requested because it costs tokens and can leak prompts to the provider. The mandatory tests should use local fake commands and canary env vars.

### Network test setup

Ivo approved local tests starting temporary HTTP servers and temporary SQLite DB files.

For `net.http`:

- allow tests to start local HTTP servers on ephemeral ports;
- allow DNS/IP tests against blocked local/private addresses without external calls;
- if you want real public-domain allowlist tests, provide a harmless domain or approve using `example.com`.

### Database and audit setup

Agents need permission to create temporary SQLite DB files under `/tmp` or the repo test temp dir. This is enough to verify:

- read-only SQLite open;
- failed write on read-only connection;
- audit row writes;
- message/queue foreign key behavior.

### GitHub project setup

Completed:

- `Talon Security Hardening` project created at https://github.com/users/ivo-toby/projects/5.
- Missing labels were created.
- `#184` was updated into the parent epic.
- SEC child issues were created and added to the board.

If future project automation fails, refresh auth with `rtk gh auth refresh -h github.com -s project -s repo`.

## Approved Decisions

Decisions captured from Ivo on 2026-06-07:

- Build on `#184` and first check whether its findings are still valid.
- The `#184` findings checked in this pass remain valid unless delegated to existing issues `#183` and `#202`.
- For `requireApproval`, use the recommended fail-closed first step. Full async in-channel approval remains follow-up work.
- Add `#202` to the security hardening board, but be selective about when it is picked up.
- Use `codex-cli` for optional live provider smoke tests.
- Allow temporary HTTP servers and SQLite DBs in local tests.

## Next Execution Step

1. Start only Wave 1: `#232`, `#233`, and `#234`.
2. Use stronger/high-rigor review for `#232` and `#233`.
3. Do not dispatch Wave 2 until Wave 1 is merged and reconciled.
4. Record any architecture drift in `#184` before continuing.
