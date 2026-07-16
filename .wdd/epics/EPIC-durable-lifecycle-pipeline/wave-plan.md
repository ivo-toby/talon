---
id: EPIC-durable-lifecycle-pipeline-WAVES
kind: wave_plan
epic: EPIC-durable-lifecycle-pipeline
status: in_progress
created_at: 2026-07-15
updated_at: 2026-07-16
---

# Wave Plan: EPIC-durable-lifecycle-pipeline

## Delivery-Speed Policy

- Critical, High, and Medium findings block; Low findings are recorded as
  follow-ups and are not automatically remediated.
- After a full review identifies blockers, intermediate GPT-5.5/xhigh reviews focus
  on the blocking remediation delta. Every task still receives one fresh full
  task-diff GPT-5.5/xhigh review immediately before commit.
- GPT-5.5/xhigh reviewers may use a writable isolated task worktree only for
  ephemeral test-runner artifacts. Controller before/after status comparison
  must prove no unexpected persistent edits.
- Each task is committed, pushed, reviewed in GitHub, and merged into the epic
  branch as soon as its individual gate passes; tasks are not held for a
  wave-wide batch.
- Five-minute monitoring applies during review/fix/freshness/merge-ready gates;
  slower cadence applies only during steady implementation.
- GPT-5.6 is forbidden for all new work. Implementation and remediation agents
  are capped at GPT-5.5; every review uses GPT-5.5 with xhigh reasoning.

The remaining dependency graph was rechecked on 2026-07-16. Its longest chain
still requires the planned ordering through dispatcher, daemon integration,
outbound events, telemetry, retention, CLI, governed promotion, verification,
and documentation. Collapsing those barriers would combine central config,
daemon, persistence, or operator boundaries and is not a safe acceleration.
The plan therefore preserves task dependencies and gains speed from review and
gate throughput rather than speculative conflict-heavy parallelism.

## Task Inventory

| Task | Ticket | Depends On | Conflict Domains | Status |
|------|--------|------------|------------------|--------|
| TASK-001-lifecycle-contracts-registry | TICKET-001-extension-contracts | None | lifecycle contracts, config schema | done |
| TASK-002-lifecycle-event-persistence | TICKET-002-durable-event-runtime | TASK-001-lifecycle-contracts-registry | database migrations, lifecycle repositories | done |
| TASK-003-interceptor-engine | TICKET-001-extension-contracts | TASK-001-lifecycle-contracts-registry | lifecycle interceptors, interceptor contract, audit logger | done |
| TASK-004-subagent-lifecycle-adapter | TICKET-001-extension-contracts | TASK-001-lifecycle-contracts-registry | lifecycle adapters, subagent runner, personas | done |
| TASK-005-transactional-event-bus | TICKET-002-durable-event-runtime | TASK-001-lifecycle-contracts-registry, TASK-002-lifecycle-event-persistence | event bus, database transaction helpers | done |
| TASK-006-durable-event-dispatcher | TICKET-002-durable-event-runtime | TASK-001-lifecycle-contracts-registry, TASK-002-lifecycle-event-persistence, TASK-003-interceptor-engine, TASK-004-subagent-lifecycle-adapter | dispatcher, handler executor, lifecycle delivery repository/migration/tests | done |
| TASK-007-daemon-message-queue-schedule-events | TICKET-003-core-boundary-integration | TASK-005-transactional-event-bus, TASK-006-durable-event-dispatcher | daemon bootstrap, message pipeline, queue, scheduler | in_progress |
| TASK-008-run-tool-outbound-events | TICKET-003-core-boundary-integration | TASK-007-daemon-message-queue-schedule-events | AgentRunner, host tools, outbound delivery | todo |
| TASK-009-context-contracts-projector | TICKET-004-context-migration | TASK-004-subagent-lifecycle-adapter, TASK-005-transactional-event-bus | lifecycle context, ContextRoller, memory repository | todo |
| TASK-010-behavior-ledger-persistence | TICKET-005-behavior-learning | TASK-002-lifecycle-event-persistence | database migrations, behavior repositories | todo |
| TASK-011-context-lifecycle-migration | TICKET-004-context-migration | TASK-008-run-tool-outbound-events, TASK-009-context-contracts-projector | AgentRunner, ContextRoller, daemon bootstrap, config schema, queue | todo |
| TASK-012-feedback-detector-subagent | TICKET-005-behavior-learning | TASK-004-subagent-lifecycle-adapter, TASK-010-behavior-ledger-persistence | behavior contracts, default detector subagent | todo |
| TASK-013-handler-telemetry-correlation | TICKET-003-core-boundary-integration | TASK-006-durable-event-dispatcher, TASK-008-run-tool-outbound-events | observability, audit logger, lifecycle telemetry | todo |
| TASK-014-lifecycle-retention-reload-replay | TICKET-002-durable-event-runtime | TASK-006-durable-event-dispatcher, TASK-013-handler-telemetry-correlation | lifecycle admin/retention, lifecycle repositories, daemon reload | todo |
| TASK-015-behavior-signal-projector | TICKET-005-behavior-learning | TASK-007-daemon-message-queue-schedule-events, TASK-010-behavior-ledger-persistence, TASK-012-feedback-detector-subagent | lifecycle behavior, config schema, behavior integration tests | todo |
| TASK-016-lifecycle-operator-cli | TICKET-006-operations-adoption | TASK-014-lifecycle-retention-reload-replay, TASK-015-behavior-signal-projector | CLI registration, IPC, daemon admin handlers | todo |
| TASK-017-behavior-review-reducers | TICKET-005-behavior-learning | TASK-013-handler-telemetry-correlation, TASK-015-behavior-signal-projector | behavior review, default reviewer subagents, scheduler | todo |
| TASK-018-governed-prompt-promotion | TICKET-005-behavior-learning | TASK-016-lifecycle-operator-cli, TASK-017-behavior-review-reducers | lifecycle behavior, personas, daemon reload, lifecycle CLI | todo |
| TASK-019-lifecycle-end-to-end-verification | TICKET-006-operations-adoption | TASK-018-governed-prompt-promotion | integration tests, fixtures, defect-fix hotspots | todo |
| TASK-020-lifecycle-documentation-adoption | TICKET-006-operations-adoption | TASK-019-lifecycle-end-to-end-verification | README, selfdoc, AGENTS, example config, starter assets, agent skills | todo |

## Dependency Grid

| Task | Blocks | Blocked By |
|------|--------|------------|
| TASK-001-lifecycle-contracts-registry | TASK-002-lifecycle-event-persistence, TASK-003-interceptor-engine, TASK-004-subagent-lifecycle-adapter, TASK-005-transactional-event-bus, TASK-006-durable-event-dispatcher | None |
| TASK-002-lifecycle-event-persistence | TASK-005-transactional-event-bus, TASK-006-durable-event-dispatcher, TASK-010-behavior-ledger-persistence | TASK-001-lifecycle-contracts-registry |
| TASK-003-interceptor-engine | TASK-006-durable-event-dispatcher | TASK-001-lifecycle-contracts-registry |
| TASK-004-subagent-lifecycle-adapter | TASK-006-durable-event-dispatcher, TASK-009-context-contracts-projector, TASK-012-feedback-detector-subagent | TASK-001-lifecycle-contracts-registry |
| TASK-005-transactional-event-bus | TASK-007-daemon-message-queue-schedule-events, TASK-009-context-contracts-projector | TASK-001-lifecycle-contracts-registry, TASK-002-lifecycle-event-persistence |
| TASK-006-durable-event-dispatcher | TASK-007-daemon-message-queue-schedule-events, TASK-013-handler-telemetry-correlation, TASK-014-lifecycle-retention-reload-replay | TASK-001-lifecycle-contracts-registry, TASK-002-lifecycle-event-persistence, TASK-003-interceptor-engine, TASK-004-subagent-lifecycle-adapter |
| TASK-007-daemon-message-queue-schedule-events | TASK-008-run-tool-outbound-events, TASK-015-behavior-signal-projector | TASK-005-transactional-event-bus, TASK-006-durable-event-dispatcher |
| TASK-008-run-tool-outbound-events | TASK-011-context-lifecycle-migration, TASK-013-handler-telemetry-correlation | TASK-007-daemon-message-queue-schedule-events |
| TASK-009-context-contracts-projector | TASK-011-context-lifecycle-migration | TASK-004-subagent-lifecycle-adapter, TASK-005-transactional-event-bus |
| TASK-010-behavior-ledger-persistence | TASK-012-feedback-detector-subagent, TASK-015-behavior-signal-projector | TASK-002-lifecycle-event-persistence |
| TASK-011-context-lifecycle-migration | None | TASK-008-run-tool-outbound-events, TASK-009-context-contracts-projector |
| TASK-012-feedback-detector-subagent | TASK-015-behavior-signal-projector | TASK-004-subagent-lifecycle-adapter, TASK-010-behavior-ledger-persistence |
| TASK-013-handler-telemetry-correlation | TASK-014-lifecycle-retention-reload-replay, TASK-017-behavior-review-reducers | TASK-006-durable-event-dispatcher, TASK-008-run-tool-outbound-events |
| TASK-014-lifecycle-retention-reload-replay | TASK-016-lifecycle-operator-cli | TASK-006-durable-event-dispatcher, TASK-013-handler-telemetry-correlation |
| TASK-015-behavior-signal-projector | TASK-016-lifecycle-operator-cli, TASK-017-behavior-review-reducers | TASK-007-daemon-message-queue-schedule-events, TASK-010-behavior-ledger-persistence, TASK-012-feedback-detector-subagent |
| TASK-016-lifecycle-operator-cli | TASK-018-governed-prompt-promotion | TASK-014-lifecycle-retention-reload-replay, TASK-015-behavior-signal-projector |
| TASK-017-behavior-review-reducers | TASK-018-governed-prompt-promotion | TASK-013-handler-telemetry-correlation, TASK-015-behavior-signal-projector |
| TASK-018-governed-prompt-promotion | TASK-019-lifecycle-end-to-end-verification | TASK-016-lifecycle-operator-cli, TASK-017-behavior-review-reducers |
| TASK-019-lifecycle-end-to-end-verification | TASK-020-lifecycle-documentation-adoption | TASK-018-governed-prompt-promotion |
| TASK-020-lifecycle-documentation-adoption | None | TASK-019-lifecycle-end-to-end-verification |

The dependency graph is acyclic. Contracts and persistence precede consumers; context and behavior each have explicit foundation chains.

## Conflict Grid

| Task Pair | Risk | Decision |
|-----------|------|----------|
| TASK-001 / TASK-011 | high | Config/context identity is sequenced through dependencies. |
| TASK-002 / TASK-010 | high | Lifecycle and behavior migrations run in separate waves. |
| TASK-005 / TASK-006 | medium | Parallel on distinct files; TASK-006 owns the bounded delivery-claim extension while TASK-005 consumes event persistence unchanged. |
| TASK-007 / TASK-008 | high | Daemon and AgentRunner integration are sequential waves. |
| TASK-008 / TASK-011 | high | AgentRunner changes are dependency-sequenced. |
| TASK-009 / TASK-011 | high | Projector lands before orchestration migration. |
| TASK-013 / TASK-014 | medium | Telemetry/audit precedes retention/admin hooks. |
| TASK-014 / TASK-016 | high | Admin service precedes CLI/IPC façade. |
| TASK-015 / TASK-017 / TASK-018 | high | Projection, reduction, and promotion form a sequential chain. |
| TASK-019 / TASK-020 | medium | Verification may change behavior; documentation follows in WAVE-011. |

## Waves

### WAVE-001

Status: done

Completed: 2026-07-16

Tasks:

- TASK-001-lifecycle-contracts-registry

Recommended strategy:

- Profile: full
- Execution mode: bundled
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- The shared contracts and configuration identity must freeze before all consumers.
- One worker keeps the public extension surface coherent.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

Outcome:

- TASK-001 merged through PR #257 at epic merge commit `e5fda2a` after the
  task branch was refreshed from epic head `999772d`.
- Focused verification passed 130 tests, build, TypeScript, scoped ESLint,
  Prettier, merge-fidelity, and GitHub Verify PR checks.
- Sol/high task and merge-state reviews passed with no Critical, High, or
  Medium findings; one non-blocking proxy-reflection hardening item was routed
  to TASK-003.
- The clean task worktree was removed after final evidence reconciliation.

Drift notes:

- No architecture or dependency drift changes the planned WAVE-002 parallel
  strategy.
- TASK-003 now owns rejection of proxy-valued interceptor JSON before any
  reflection, including nested arrays and objects, with zero-trap tests.

### WAVE-002

Status: done

Completed: 2026-07-16

Tasks:

- TASK-002-lifecycle-event-persistence
- TASK-003-interceptor-engine
- TASK-004-subagent-lifecycle-adapter

Recommended strategy:

- Profile: full
- Execution mode: parallel
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Persistence, interceptor execution, and sub-agent adaptation consume frozen contracts but have separate primary conflicts.
- Three isolated workers provide real speedup.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

Outcome:

- TASK-003 merged through PR #258 at `fcde60a`, TASK-002 merged through PR #260
  at `49e47bf`, and TASK-004 merged through PR #259 at final epic head
  `54dc872`.
- Final task/refresh Sol/high reviews passed with no Critical, High, or Medium
  findings. TASK-004's final combined integration gate passed after aligning
  lifecycle contract and persistence string domains.
- Focused evidence included 37 real-SQLite persistence tests, 141 interceptor
  tests, 163 sub-agent task tests, and 339 tests in the final combined review,
  plus build/TypeScript, scoped lint, formatting, diff, GitHub CI, freshness,
  and review-integrity checks.
- All three PRs had zero review threads. Clean task worktrees were removed and
  pruned; unrelated `.minispec/` and the messaging worktree were untouched.

Drift notes:

- No dependency drift changes WAVE-003's TASK-005/TASK-006 parallel strategy.
- TASK-005 must publish through the atomic repository boundary. TASK-006 must
  reuse repository claim/replay semantics, native-only enforcing interceptors,
  and exact loader-owned sub-agent authority.
- The TASK-004 final-attempt log-wording Low remains a non-blocking follow-up.

### WAVE-003

Status: done

Activated: 2026-07-16

Completed: 2026-07-16

Tasks:

- TASK-005-transactional-event-bus
- TASK-006-durable-event-dispatcher

Recommended strategy:

- Profile: full
- Execution mode: parallel
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Publication consumes the frozen event-persistence API while dispatch owns a
  bounded, real-SQLite-tested delivery-claim eligibility and transition
  extension, including the lifecycle delivery migration; the task patches
  remain file-disjoint.
- Daemon wiring is deliberately deferred.

Activation rule:

- Readiness gates passed at pushed checkpoint `fbe4f08`; both isolated workers
  completed their uncommitted implementations in parallel.
- Independent Sol/high reviews found blocking High/Medium issues in both tasks;
  separate Terra/high integration owners completed their remediations in
  parallel, with 43 TASK-005 and 64 refreshed TASK-006 focused tests passing.
- TASK-005's fresh full-diff Sol/high review passed 0C/0H/0M/1L and PR #261
  merged at epic head `d3357fb`. TASK-006 passed its final full-diff Sol/high
  review 0C/0H/0M/1L after 80 focused tests and merged through PR #262 at final
  epic head `8f74740`. Both clean task worktrees were removed and pruned.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

Outcome:

- TASK-005 merged through PR #261 at `d3357fb`; TASK-006 merged through PR #262
  at final epic head `8f74740`.
- Final full-diff Sol/high reviews passed with no Critical, High, or Medium
  findings. Focused evidence passed 43 transactional publication tests and 80
  dispatcher/repository/migration/event-bus tests, plus build, scoped static
  checks, GitHub CI, freshness, and zero unresolved review threads.
- The dispatcher work added immutable captured authority, exact persona-scoped
  handler execution, retained timeout concurrency accounting, bounded shutdown,
  and additive v15 upgrade behavior without modifying migration 014.
- Both Low findings remain recorded and unmodified. Both clean task worktrees
  were removed; unrelated `.minispec/` and the messaging worktree were untouched.

Drift notes:

- No dependency drift changes WAVE-004 eligibility or its bundled strategy.
- TASK-007 must construct the exact-bus transaction authority, supervise the
  dispatcher independently of the user queue, preserve timeout-slot accounting,
  and verify v14-to-v15 runtime boot behavior.

### WAVE-004

Status: in_progress

Activated: 2026-07-16

Tasks:

- TASK-007-daemon-message-queue-schedule-events

Recommended strategy:

- Profile: full
- Execution mode: bundled
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Daemon composition and message/queue/schedule transitions share bootstrap and transaction ownership.
- A single loop reduces shutdown and state/event coupling risk.

Activation rule:

- TASK-007 is allocated as the sole bundled task from reviewed and pushed
  reconciliation head `7e3402c`. Allocation checkpoint `67b3457` passed
  Sol/high review and is pushed/recorded exactly; its branch/worktree remain
  forbidden until the activation-sync checkpoint independently passes fresh
  Sol/high review and is committed/pushed.
- Activation-sync checkpoint `923623b` passed fresh Sol/high review and was
  pushed. The isolated branch/worktree were created clean from that exact
  commit. Separate readiness checkpoint `a6d48f7` passed fresh Sol/high review,
  was committed/pushed, and was fast-forwarded/pushed into the clean worktree;
  Terra/high dispatch was historical authorization for the completed TASK-007
  source run only, is now expired, and is explicitly unauthorized for redispatch
  because TASK-007 source is complete.

Current execution state:

- TASK-007 source work is complete, reviewed, committed, and pushed at
  `8a994ea`; only the amended WDD checkpoint, exact epic refresh, task PR,
  merge, cleanup, and WAVE-004 reconciliation remain.
- The user replaced the model policy on 2026-07-16: no new GPT-5.6 use,
  GPT-5.5/high at most for implementation or remediation, and GPT-5.5/xhigh for
  every review.
- Pause after WAVE-004 reconciliation. Do not activate WAVE-005 without new
  user direction.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-005

Status: planned

Tasks:

- TASK-008-run-tool-outbound-events
- TASK-009-context-contracts-projector
- TASK-010-behavior-ledger-persistence

Recommended strategy:

- Profile: full
- Execution mode: parallel
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Run/tool/outbound integration, context projection, and behavior persistence have separate primary domains.
- All three are prerequisites for later migrations.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-006

Status: planned

Tasks:

- TASK-011-context-lifecycle-migration
- TASK-012-feedback-detector-subagent
- TASK-013-handler-telemetry-correlation

Recommended strategy:

- Profile: full
- Execution mode: parallel
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Context migration, detector implementation, and telemetry are isolated after prerequisites merge.
- Each has a focused high-risk review boundary.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-007

Status: planned

Tasks:

- TASK-014-lifecycle-retention-reload-replay
- TASK-015-behavior-signal-projector

Recommended strategy:

- Profile: full
- Execution mode: parallel
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Lifecycle retention/reload reliability and behavior projection use separate services.
- Both must land before operator and reducer workflows.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-008

Status: planned

Tasks:

- TASK-016-lifecycle-operator-cli
- TASK-017-behavior-review-reducers

Recommended strategy:

- Profile: full
- Execution mode: parallel
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Operator IPC/CLI and behavior review reducers touch distinct CLI versus sub-agent/scheduler domains.
- Stable replay and projection semantics make this parallelism safe.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-009

Status: planned

Tasks:

- TASK-018-governed-prompt-promotion

Recommended strategy:

- Profile: full
- Execution mode: bundled
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Prompt mutation, evaluation, reload, and rollback form one sensitive transaction boundary.
- Bundled execution keeps governance evidence and failure recovery coherent.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-010

Status: planned

Tasks:

- TASK-019-lifecycle-end-to-end-verification

Recommended strategy:

- Profile: full
- Execution mode: bundled
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Final black-box verification must settle behavior before adoption documentation begins.
- One focused verification worker owns the full-suite approval and runtime-smoke evidence.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-011

Status: planned

Tasks:

- TASK-020-lifecycle-documentation-adoption

Recommended strategy:

- Profile: full
- Execution mode: bundled
- Review mode: risk_based
- Monitoring mode: adaptive
- Confidence: high
- Requires user confirmation: yes
- Confirmed by: user request on 2026-07-15 to implement issue #256 with WDD

Rationale:

- Documentation, example configuration, starter assets, and setup skills must reflect the verified final implementation.
- Sequencing after TASK-019 prevents documentation from becoming stale during verification fixes.

Activation rule:

- Activate the eligible task after syncing activation artifacts.
- Create one isolated worktree from the synced epic branch.

Stop condition:

- The task is done, blocked, cancelled, or explicitly closed.
- Review, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before epic validation.

## Known Conflict Risks

- Controller reconciliation hotspots: config schema, migrations/repository exports, daemon bootstrap/context, AgentRunner, ContextRoller, audit, IPC registration, lifecycle barrels, shared tests, and docs.
- Parallel workers may not broaden into another task hotspot.
- Material branch refreshes require affected verification and review to rerun.

## Activation Rules

- WAVE-001 through WAVE-003 are done. WAVE-003 merged PRs #261 and #262 and its
  reconciliation passed Sol/high review 0C/0H/0M/2L before commit `7e3402c`
  was pushed. WAVE-004 is active after TASK-007 source completion at reviewed
  and pushed task commit `8a994ea`; the amended WDD checkpoint, exact epic
  refresh, task PR, merge, cleanup, and reconciliation remain.
- Reconciliation of WAVE-004 is the terminal action for this run. WAVE-005 must
  remain planned and inactive until the user explicitly resumes the epic.
- The explicit implementation request confirms the full-profile strategy recommendations; reconciliation may narrow later parallelism when evidence changes.
- Commit/sync planning and activation artifacts to epic/durable-lifecycle-pipeline before task worktrees.
- Waves never overlap across reconciliation boundaries.

## Manual Adjustments

- Issue #70 historical trace access is optional; TASK-013 creates a provider seam and existing tracing.
- The full test suite remains a user-approval gate at epic validation.
