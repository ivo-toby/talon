---
id: TASK-007-daemon-message-queue-schedule-events
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-003-core-boundary-integration
wave: WAVE-004
slug: daemon-message-queue-schedule-events
title: Wire lifecycle runtime plus inbound, queue, and schedule boundaries
status: in_progress
depends_on: ["TASK-005-transactional-event-bus", "TASK-006-durable-event-dispatcher"]
conflict_domains:
  - "src/daemon/daemon-bootstrap.ts"
  - "src/daemon/daemon.ts"
  - "src/pipeline/message-pipeline.ts"
  - "src/queue/**"
  - "src/scheduler/scheduler.ts"
assigned_model_class: codexHigh
actual_model: gpt-5.6-terra
reasoning_effort: high
review_model_class: reviewGate
current_review_model: gpt-5.5
current_review_reasoning_effort: xhigh
branch: task/TASK-007-daemon-message-queue-schedule-events
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-004-daemon-message-queue-schedule-events
worktree_status: clean_after_reviewed_commit
worker_thread_id: 019f6a80-eb6a-7051-9e84-f448be2c2a17
review_thread_id: 019f6b0f-f3c8-7160-bb2a-81329c61d473
pr: null
current_gate: controller_state_marker_blocker_remediated_gpt55_xhigh_rereview_required
branch_freshness: task_commit_pushed_pending_refresh_from_model_policy_checkpoint_d104ba4
verification:
  - "npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/pipeline/message-pipeline.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/scheduler/scheduler.test.ts"
  - "npx vitest run tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/core/database/migrations/runner.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-007-daemon-message-queue-schedule-events: Wire lifecycle runtime plus inbound, queue, and schedule boundaries

## Status

in_progress

## Parent Ticket

TICKET-003-core-boundary-integration

## Wave

WAVE-004

## Objective

Construct/supervise lifecycle services and publish message, routing, queue, and schedule events while enforcing message.before_persist without disabled-behavior drift.

## Scope

- Wire daemon bootstrap/start/stop/restart.
- Publish message.persisted/routed, queue transition, and schedule.fired events.
- Run inbound interceptor before persistence.
- Use atomic state/event writes where practical.
- Preserve dedup, FIFO, retries, and synchronous Result behavior.

## Non-Scope

No run/tool/outbound, context, behavior, or operator CLI work.

## Relevant Context

### Local Context

- Inspect the likely files and their focused tests before broad discovery.
- Follow the epic architecture and design decisions; preserve existing disabled and legacy behavior.
- Treat untrusted content, capability scope, idempotency, ordering, audit, and privacy as explicit review concerns.

### Shared Context References

- ../../shared-context/index.md
- ../../shared-context/resources/architecture.md
- ../../shared-context/resources/design-decisions.md
- ../../shared-context/resources/testing-strategy.md
- ../../shared-context/resources/task-findings.md

## Likely Files / Areas

- src/daemon/daemon-bootstrap.ts
- src/daemon/daemon.ts
- src/pipeline/message-pipeline.ts
- src/queue/**
- src/scheduler/scheduler.ts
- tests/unit/daemon/daemon-bootstrap.test.ts
- tests/unit/pipeline/message-pipeline.test.ts
- tests/unit/queue/**
- tests/unit/scheduler/scheduler.test.ts

## Dependencies

- TASK-005-transactional-event-bus
- TASK-006-durable-event-dispatcher

## Conflict Domains

- src/daemon/daemon-bootstrap.ts
- src/daemon/daemon.ts
- src/pipeline/message-pipeline.ts
- src/queue/**
- src/scheduler/scheduler.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-007-daemon-message-queue-schedule-events

## Worker Worktree

Created clean at `/Users/ivo.toby/workspace/talon/.worktrees/WAVE-004-daemon-message-queue-schedule-events` from reviewed and pushed activation-sync commit `923623b`, then fast-forwarded through readiness checkpoint `a6d48f7` to reviewed/pushed dispatch checkpoint `c682625`. TASK-007 completed exactly six bounded Terra/high remediation passes. Final controller verification passed 12 focused files / 385 tests under exact Node v24.15.0 ABI 137, plus build, latest-source lint, targeted formatting, and diff checks. Fresh complete-diff Sol/high source review `019f6b0f-f3c8-7160-bb2a-81329c61d473` passed 0C/0H/0M/0L on fingerprint `0333fdfbe0fd25403b59a5acbd9e7cb3028cefddfd7af1ec6fc61fe73d2ed3a0`. Reviewed task commit `8a994eac930b18ce5ec1e3fe78999c2a021e4308` is clean, pushed, and aligned with the local remote-tracking ref. The amended WDD/model-policy checkpoint passed GPT-5.5/xhigh review and is pushed at `d104ba4`. Only the durable controller-state marker review/commit/push, exact epic refresh review/commit/push, PR checks/review/freshness/merge/cleanup/reconciliation remain.

## PR / Patch Reference

Reviewed commit `8a994eac930b18ce5ec1e3fe78999c2a021e4308` is pushed. The
task PR will target `epic/durable-lifecycle-pipeline` after the reviewed WDD
state checkpoint and epic-branch refresh.

## Current Canonical State

TASK-007 completed exactly six bounded Terra/high remediation passes. Final
controller verification passed 12 focused files / 385 tests under exact Node
v24.15.0 ABI 137, plus build, latest-source lint, targeted formatting, and diff
checks. Fresh complete-diff Sol/high source review
`019f6b0f-f3c8-7160-bb2a-81329c61d473` passed 0C/0H/0M/0L on fingerprint
`0333fdfbe0fd25403b59a5acbd9e7cb3028cefddfd7af1ec6fc61fe73d2ed3a0`.
Reviewed task commit `8a994eac930b18ce5ec1e3fe78999c2a021e4308` is clean,
pushed, and aligned with the local remote-tracking ref. The WDD/model-policy
checkpoint passed GPT-5.5/xhigh review 0C/0H/0M/2L on fingerprint
`9242e2c0b7bfcd138aae37abe4402a6e8020b3b4290d4e24c372beedb63dfdfd` and is
pushed at `d104ba4`. The controller-state marker, exact epic refresh, PR,
merge, cleanup, and reconciliation remain. Historical GPT-5.6 worker/reviewer
references in this task remain provenance only; no new GPT-5.6 activity is
permitted.

## RED-GREEN TDD Plan

### RED

Failing tests for daemon lifecycle, exactly-once transition events, atomic inbound state/event, deny/transform, queue failure/dead-letter, schedule provenance, and disabled equivalence.

### GREEN

Inject lifecycle services and add calls at authoritative transitions.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Preserve unrelated user changes and use typed neverthrow results across module boundaries.
- Audit side effects and keep durable payloads bounded and secret-free.
- Construct the merged event bus with exact bus/connection transaction authority;
  do not publish through external or nested active SQLite transactions that can
  wake before the owning commit.
- Supervise the merged dispatcher as an independent daemon workload. Preserve
  immutable repository/executor authority, exact handler-plus-persona identity,
  retained concurrency slots for abort-ignoring timed-out handlers, and bounded
  stop behavior without coupling failures back into the user-facing queue.
- Exercise migration 015 when runtime boot opens an existing v14 database and
  retain the repository's retry/dead-letter transition guards.
- Request reviewGate/`gpt-5.5` review with xhigh reasoning before commit; resolve all P1/P2 or Critical/High/Medium findings. Never use GPT-5.6.

## Review Focus

- Correctness and regressions at the listed conflict domains.
- Security/scope/privacy/idempotency/ordering/failure semantics relevant to the task.
- RED/GREEN evidence and contract/config/documentation drift.

## Durable Memory Notes To Consider

- Propose only stable decisions, root causes, constraints, or verified outcomes for task-findings.md.

## Task-Level Definition of Done

- [ ] Objective and scoped behavior are complete.
- [ ] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [ ] Required review has no unresolved P1/P2 findings.
- [ ] PR targets the epic branch and freshness is checked.
- [ ] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/pipeline/message-pipeline.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/scheduler/scheduler.test.ts
- npx vitest run tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/core/database/migrations/runner.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Independent controller verification passed 179 focused tests under the
  repository-pinned Node 24 runtime: 129 daemon/pipeline/queue/scheduler tests
  and 50 lifecycle event-bus/dispatcher/migration tests.
- `npm run build` and `git diff --check` passed. Scoped source ESLint reported
  zero errors and one pre-existing explicit-return-type warning.
- No dependency install or rebuild occurred. The worker-shell SQLite ABI
  mismatch was cleared by the controller's pinned Node 24 run.
- Full-file Prettier checks still expose repository-baseline drift in six
  touched files; the new runtime and intentionally changed hunks were checked,
  and unrelated bootstrap-test formatter churn was removed before review.
- Terra/high remediation verification passes 229 focused tests across nine
  daemon/bootstrap, pipeline, queue, scheduler, lifecycle, and migration files,
  plus build, zero-error scoped ESLint, and `git diff --check`.
- Second Terra/high remediation and independent controller verification pass
  238 focused tests across ten files, including real-SQLite lifecycle signal
  handoff coverage, plus build, zero-error scoped ESLint, and `git diff --check`.
  No dependency install, rebuild, full-suite run, or `.minispec` edit occurred.
- Third Terra/high remediation and independent controller verification pass
  243 focused tests across the same ten-file boundary, including finite queue
  and scheduler drain behavior, startup/restart gating, unsupported subagent
  interceptor rejection, and long-identity signal handoff coverage. Build,
  zero-error scoped ESLint, and `git diff --check` pass; no dependency install,
  rebuild, full-suite run, or `.minispec` edit occurred.
- Fourth Terra/high remediation and independent controller verification pass
  380 focused tests across twelve files, adding AgentRunner and background-agent
  producer coverage plus scheduler-generation and drain-exception regressions.
  Build, targeted Prettier, zero-error scoped ESLint, and `git diff --check`
  pass; the full suite and dependency mutation remain prohibited.
- Sixth bounded Terra/high remediation and independent controller verification
  pass 385 focused tests across the established twelve files under exact Node
  v24.15.0 ABI 137, plus a pinned Node 24 build, zero-issue latest-source
  ESLint, targeted Prettier, and `git diff --check`. No full suite, dependency
  mutation, commit, push, WDD worker edit, `.minispec` edit, or Low/P3 edit
  occurred.

## Review Feedback

### P1

- Resolved by direct review: inbound persistence, persisted/routed events, and queue enqueue/event share one bus-owned transaction with insert-vs-duplicate semantics.
- Resolved by fresh review: successful subagent signals enter an atomic, persona-scoped durable handoff for later signal projectors instead of being rejected by bootstrap.

### P2

- Resolved by direct review: joined-transaction enqueue validates exact authority before mutation.
- Resolved by direct review: conditional claimed-state transitions publish only once.
- Resolved by direct review: `message.routed.v1` includes bounded persona provenance.
- Resolved by fresh review: bootstrap requires each lifecycle subagent implementation to be explicitly assigned to the owning persona.
- Resolved by fresh review: queue lifecycle persona/item type are manager-owned database columns rather than caller-controlled payload metadata.
- Resolved by fresh review: message queue enqueue and terminal transitions retain one stable message correlation identifier.
- Partially resolved and reopened by fresh review: failed startup and normal stop join finite in-flight scheduler/queue work before closing dependencies, but thrown drains can still be treated as success or wedge normal stop.
- Resolved by fresh review: bootstrap rejects configured subagent interceptors because the synchronous interceptor engine can execute only native implementations.
- Resolved by fresh review for finite stop results: queue and scheduler shutdown return bounded drain status while unfinished work retains dependency and restart gates.
- Resolved by fresh review: a valid event-id plus handler-id tuple maps to a deterministic bounded signal handoff digest.
- Routed to Terra/high: lifecycle-enabled queue publication must not remain optional for internal AgentRunner continuation and background-completion producers.
- Routed to Terra/high: invalidate and generation-check scheduler work across every asynchronous boundary so a timed-out tick cannot resume under a later start.
- Routed to Terra/high: treat all drain exceptions as not drained, honor deferred cleanup results, and keep normal stop recoverable without closing dependencies early.
- Remediation is active in the same Terra/high integration-owner thread
  `019f6a80-eb6a-7051-9e84-f448be2c2a17`; no new or overlapping owner was
  introduced.
- Remediated pending fresh review: internal continuation and background
  completion messages attach trusted lifecycle scope, while disabled mode
  discards that scope and retains the legacy persistence path.
- Remediated pending fresh review: scheduler work keeps its originating
  generation and rechecks it after asynchronous prompt lookup and before every
  enqueue or schedule-state mutation.
- Remediated pending fresh review: drain exceptions remain not-drained,
  dependency teardown and restart stay gated, and deferred cleanup honors its
  result instead of marking stopped unconditionally.
- Resolved by fresh review: scheduler work cannot cross a stop/start generation
  after asynchronous prompt lookup or before schedule-state mutation.
- Resolved by fresh review: drain exceptions remain not-drained and preserve
  dependency and restart gates through deferred cleanup.
- Routed to the same Terra/high integration owner: new lifecycle-enabled
  message and schedule enqueues must fail closed when manager-owned scope or
  persona resolution is unavailable; only persisted legacy rows and
  collaboration items may remain scope-less.
- Routed to the same Terra/high integration owner: deduplicate exact native
  runtime capability identities when one handler is attached to multiple
  personas, while retaining persona-specific sub-agent entries.
- Fifth bounded remediation is active in the same Terra/high owner thread
  `019f6a80-eb6a-7051-9e84-f448be2c2a17`; no overlapping integration owner was
  introduced.
- Remediated pending fresh review: lifecycle-enabled message and schedule
  enqueues require manager-owned scope; background and scheduler persona lookup
  failures create no scope-less work or schedule advancement.
- Remediated pending fresh review: native runtime capabilities are deduplicated
  by exact immutable identity across persona attachments, while sub-agent
  catalog entries remain persona-specific.
- Resolved by fresh review: lifecycle-enabled scope omission and native runtime
  capability duplication are closed; every earlier blocker also passed its
  explicit audit.
- Routed to the same Terra/high integration owner: contain the newly fallible
  daemon `stop()` promise in the IPC shutdown callback so rejected or timed-out
  drains cannot become unhandled rejections, and add the focused IPC shutdown
  regression. No Low/P3 finding exists or may be edited.
- Remediated pending fresh review: the IPC callback catches/logs a failed
  bounded-drain `stop()` promise, and focused coverage confirms the shutdown
  acknowledgment remains successful without an `unhandledRejection`.
- Resolved by fresh review: IPC shutdown promise containment and every earlier
  blocker passed the immutable complete-diff audit. Review
  `019f6b0f-f3c8-7160-bb2a-81329c61d473` reported 0C/0H/0M/0L.

### P3

- None.

## Completion Notes

- Direct Sol/high review `019f6aac-4608-7440-b701-fc45c9a7ca17` preserved the
  complete reviewed patch fingerprint and blocked 0C/1H/4M/0L. The earlier
  recursive reviewer attempt is invalid evidence. No Low finding was reported
  or edited.
- The second-remediation patch is based on `c682625` with status fingerprint
  `9761648d65fa51993b262454ff22fa1f0c4eeb58acd6266acd0785a5905b984f`.
  Fresh direct Sol/high review `019f6ac4-d662-7c53-b878-ea71a9ba68da`
  preserved the complete fingerprint and blocked 0C/2H/1M/0L. It confirmed
  prior blockers 2-6 and 9-12 resolved, while runtime authority, cleanup
  boundedness, and long-identity signal handoff remain blocking. No Low finding
  was reported or edited.
- The third-remediation patch remains based on `c682625`; its complete status
  plus file-content fingerprint is
  `55050184e7d70985d790741f52f23f303153b3284a15312c52d15e4b76cad874`.
  Fresh direct complete-diff Sol/high review
  `019f6ad6-88bb-7f62-a142-f45966d9ff8d` preserved that exact fingerprint and
  blocked 0C/0H/3M/0L. It found optional lifecycle publication for two internal
  queue producers, stale scheduler work crossing a stop/start generation, and
  unsafe drain-exception cleanup. Prior blockers 13-15 are resolved. No Low
  finding was introduced or edited.
- The fourth-remediation patch remains based on `c682625`; its complete status
  plus file-content fingerprint is
  `4b49b9517bfe2822cb93440c8fad66087bc2f87c7238a55ba74bbbcf7c24daba`.
  Independent controller verification passed 380 focused tests, build, scoped
  lint, targeted formatting, and diff checks. Fresh complete-diff Sol/high
  review `019f6ae9-e594-7e52-9da3-3cb877db332f` preserved that exact
  fingerprint and blocked 0C/0H/2M/0L on enabled-mode scope omission and native
  runtime capability duplication across personas. The scheduler-generation
  and drain-exception blockers passed. No Low finding exists or was edited.
  Interrupted prompt-corruption attempt
  `019f6ae9-15a0-7ba1-b0b8-da440087ef2f` is invalid evidence.
- The fifth-remediation patch remains based on `c682625`; its complete status
  plus file-content fingerprint is
  `9f8d5071ef9a5ca47335941b5c86bfb0d2e0fc632dda7c8138c3787ba9db4de6`.
  Independent controller verification passed 384 focused tests, build, scoped
  lint with zero errors and seven warnings, targeted formatting, and diff
  checks. Fresh complete-diff Sol/high review
  `019f6afb-7dee-7e73-8104-cac36de905a5` preserved the exact fingerprint and
  blocked 0C/0H/1M/0L only because the IPC shutdown callback discards the now
  fallible `stop()` promise. All prior blockers passed. Only that Medium is
  routed to the same Terra/high owner; no Low finding exists or was edited.
- The sixth-remediation patch remains based on `c682625`; its controller-
  reproduced complete status-plus-file-content fingerprint is
  `0333fdfbe0fd25403b59a5acbd9e7cb3028cefddfd7af1ec6fc61fe73d2ed3a0`.
  The worker-reported hash used a differing calculation and is not gate
  evidence. Independent controller verification passed 385 focused tests,
  build, latest-source lint, targeted formatting, and diff checks. Fresh direct
  complete-diff Sol/high review `019f6b0f-f3c8-7160-bb2a-81329c61d473`
  preserved that exact fingerprint and passed the commit gate 0C/0H/0M/0L.
  The exact reviewed snapshot was committed as
  `8a994eac930b18ce5ec1e3fe78999c2a021e4308` and its remote task branch was
  verified at the same commit. No Low/P3 finding exists or was edited.
