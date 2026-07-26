---
id: EPIC-durable-lifecycle-pipeline-WAVES
kind: wave_plan
epic: EPIC-durable-lifecycle-pipeline
status: in_progress
created_at: 2026-07-15
updated_at: 2026-07-26
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
| TASK-007-daemon-message-queue-schedule-events | TICKET-003-core-boundary-integration | TASK-005-transactional-event-bus, TASK-006-durable-event-dispatcher | daemon bootstrap, message pipeline, queue, scheduler | done |
| TASK-008-run-tool-outbound-events | TICKET-003-core-boundary-integration | TASK-007-daemon-message-queue-schedule-events | AgentRunner, host tools, outbound delivery | done |
| TASK-009-context-contracts-projector | TICKET-004-context-migration | TASK-004-subagent-lifecycle-adapter, TASK-005-transactional-event-bus | lifecycle context, ContextRoller, memory repository | done |
| TASK-010-behavior-ledger-persistence | TICKET-005-behavior-learning | TASK-002-lifecycle-event-persistence | database migrations, behavior repositories | done |
| TASK-011-context-lifecycle-migration | TICKET-004-context-migration | TASK-008-run-tool-outbound-events, TASK-009-context-contracts-projector | AgentRunner, ContextRoller, daemon bootstrap, config schema, queue | done |
| TASK-012-feedback-detector-subagent | TICKET-005-behavior-learning | TASK-004-subagent-lifecycle-adapter, TASK-010-behavior-ledger-persistence | behavior contracts, default detector subagent | done |
| TASK-013-handler-telemetry-correlation | TICKET-003-core-boundary-integration | TASK-006-durable-event-dispatcher, TASK-008-run-tool-outbound-events | observability, audit logger, lifecycle telemetry | done |
| TASK-014-lifecycle-retention-reload-replay | TICKET-002-durable-event-runtime | TASK-006-durable-event-dispatcher, TASK-013-handler-telemetry-correlation | lifecycle admin/retention, lifecycle repositories, daemon reload | done |
| TASK-015-behavior-signal-projector | TICKET-005-behavior-learning | TASK-007-daemon-message-queue-schedule-events, TASK-010-behavior-ledger-persistence, TASK-012-feedback-detector-subagent | lifecycle behavior, config schema, behavior integration tests | done |
| TASK-016-lifecycle-operator-cli | TICKET-006-operations-adoption | TASK-014-lifecycle-retention-reload-replay, TASK-015-behavior-signal-projector | CLI registration, IPC, daemon admin handlers | done |
| TASK-017-behavior-review-reducers | TICKET-005-behavior-learning | TASK-013-handler-telemetry-correlation, TASK-015-behavior-signal-projector | behavior review, default reviewer subagents, scheduler | done |
| TASK-018-governed-prompt-promotion | TICKET-005-behavior-learning | TASK-016-lifecycle-operator-cli, TASK-017-behavior-review-reducers | lifecycle behavior, personas, daemon reload, lifecycle CLI | in-progress |
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

Status: done

Activated: 2026-07-16

Completed: 2026-07-16

Reconciled: 2026-07-16

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

Outcome:

- TASK-007 final commit `fab94953a41e34520ce216f4bec7acc92c449fa8`
  passed Verify PR run `29511783210`; prior PR Agent run `29507211075` passed
  with no review threads and only its non-actionable failed-suggestions issue
  comment.
- Final GPT-5.5/xhigh substantive review
  `019f6b7d-fd1b-78c3-ba7f-7cade5ca636b`, integrity adjudication
  `019f6b85-a9ac-74f3-9fcd-b10c566acdb8`, and WDD marker review
  `019f6b8a-afe5-7d02-ac39-c4f07fab5173` all cleared with no unresolved
  Critical/High/Medium findings. The final marker fingerprint was
  `f2ecd9ce8aaf09830003c1def7578085ac4bf4e2867e861e87637533c01c3fa4`.
- The branch was fresh when PR #263 merged on 2026-07-16T15:37:10Z at epic
  merge commit `67e93accfc8b62dc1e43102ef173fc20cc2bb0e5`. The clean task
  worktree was removed and pruned.

Drift notes:

- Daemon bootstrap now owns one shared optional lifecycle runtime. Omitted or
  disabled lifecycle configuration keeps null wiring and legacy behavior.
- Inbound message persistence, routed publication, and enqueue are atomic;
  queue lifecycle scope is database-owned and terminal events publish only from
  claimed transitions. Scheduler work is generation-bound with finite drain.
- Migrations 016/017 add durable signal handoff and queue scope; a v14 database
  now applies 015-017 and reaches `user_version` 17.
- Hot reload rejects lifecycle configuration and lifecycle-attached subscription,
  sub-agent assignment, or capability-authority changes before mutation. TASK-014
  must test and extend this restart-required baseline rather than assuming live
  lifecycle runtime reconstruction already exists.
- At WAVE-004 reconciliation time, WAVE-005 remained planned and inactive until
  the user explicitly resumed the epic. That pause has since been superseded;
  WAVE-005 through WAVE-008 are now reconciled.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-005

Status: done

Completed: 2026-07-25

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
- Activation resumed on 2026-07-25 from reviewed/pushed epic base `b6ff72c`;
  activation artifacts passed GPT-5.5/xhigh review and were pushed at
  `185c537`; activation-sync marker `8ebb6db` is pushed. TASK-008/TASK-009/
  TASK-010 branches and worktrees were created clean from `8ebb6db` and verified
  with current task/controller/orchestration artifacts.
- TASK-009 merged first through PR #266 at `3c1b5f4`, delivering lifecycle
  context contracts/projector integration. TASK-010 merged through PR #267 at
  `08c564a`, delivering behavior ledger persistence and the required migration
  expectation fix. TASK-008 merged last through PR #268 at `6921a9e` after a
  GPT-5.5/xhigh Medium finding on streamed fallback transcript duplication was
  remediated and the branch was rebased onto TASK-010.
- Focused verification, build, scoped lint, diff checks, GitHub checks, and
  GPT-5.5/xhigh review gates passed for all three tasks. The only remaining
  finding is a non-blocking TASK-009 P3 tombstone-visibility follow-up, left
  untouched under policy.
- WAVE-005 task worktrees were verified clean, removed, and pruned. The epic
  branch is current locally and remotely at merge commit `6921a9e`.

Drift notes:

- Downstream context migration can depend on explicit lifecycle context
  snapshots/projector contracts from TASK-009 and streamed outbound segment
  idempotency from TASK-008.
- Downstream behavior detector/projector work can depend on the behavior ledger
  tables and repository contract from TASK-010.
- Event-pipeline verification now needs end-to-end coverage after the remaining
  waves are reconciled, including a sprites run against the lifecycle event
  pipeline before the epic is considered complete.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-006

Status: done

Completed: 2026-07-26

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
- Activation started on 2026-07-25 from reviewed/pushed Wave 5 reconciliation
  checkpoint `3231c5be5c736f04d55d8ff94a28a1b1c24de372`. Task branches/worktrees are allocated as:
  `task/TASK-011-context-lifecycle-migration` /
  `.worktrees/WAVE-006-context-lifecycle-migration`,
  `task/TASK-012-feedback-detector-subagent` /
  `.worktrees/WAVE-006-feedback-detector-subagent`, and
  `task/TASK-013-handler-telemetry-correlation` /
  `.worktrees/WAVE-006-handler-telemetry-correlation`.
- Activation checkpoint passed GPT-5.5/xhigh review
  `019f9b72-d7f4-7ee2-b3eb-e3a0f4d19c03` with 0C/0H/0M/0L and was pushed at
  `eec0846676f37db0e9cc5a580c5a3457cbf18689`.
- Activation-sync marker passed GPT-5.5/xhigh review
  `019f9b76-c6a7-7a60-8cd9-2322cfdaf8f7` with 0C/0H/0M/0L and was pushed at
  `e70d27ef04e550546975c4abb4e90929b5f82180`.
- Task branches/worktrees were created, pushed, reviewed, and dispatched from
  the readiness checkpoint `566a9a91d1f57bfcd9938011027d87f668fea13e`.
- TASK-011 merged through PR #271 at
  `3bba6a0a8d2537b6d6aea39d2a916e08b8fb9a2d`, TASK-013 merged through PR #270
  at `3e09c376f21fdc5697c673def4ec99eb10dd0291`, and TASK-012 merged through
  PR #269 at final Wave 6 epic head
  `af75d4be155a528b576f9518edd8e93af6ba5016`.

Stop condition:

- All active tasks are done. PR Agent and Verify PR checks passed for #269,
  #270, and #271. Each task had GPT-5.5/xhigh review with no remaining
  Critical/High/Medium findings.
- Integrated Wave 6 verification passed on the epic branch: 19 targeted files /
  647 tests, `npm run build`, scoped ESLint with 0 errors and known warnings
  only, and `git diff --check`.
- The three clean task worktrees were removed and pruned during reconciliation.

Outcome:

- Context rotation now flows through configured lifecycle projection modes,
  with durable restart boundaries and idempotent stateless-provider continuation
  repair for rotation/retry crash windows.
- The explicit-feedback detector now emits typed `talon.behavior.signal.v1`
  signals only from trusted lifecycle evidence, including `tool_call`
  provenance that matches the real behavior ledger SQL constraint.
- Lifecycle publication, dispatch, handoff, replay/reopen, promotion, audit,
  metric, and Langfuse/trace-evidence seams now have bounded correlated
  telemetry, with success evidence tied to durable commit boundaries.

Drift notes:

- TASK-014 can consume the new telemetry and replay/reopen audit seams when
  adding retention/reload/replay behavior.
- TASK-015 can consume the strict behavior detector contract and the persisted
  `tool_call` evidence source kind when projecting behavior signals.
- TASK-019 must include end-to-end coverage for the merged lifecycle event
  pipeline and run the final event-pipeline validation in Sprites before the
  epic is considered complete.

### WAVE-007

Status: done

Activated: 2026-07-26

Completed: 2026-07-26

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
- Activation started on 2026-07-26 from reviewed/pushed Wave 6 reconciliation
  checkpoint `898197df00c065923dec5f372943628a695c62a1`. Task branches/worktrees are allocated as:
  `task/TASK-014-lifecycle-retention-reload-replay` /
  `.worktrees/WAVE-007-lifecycle-retention-reload-replay`, and
  `task/TASK-015-behavior-signal-projector` /
  `.worktrees/WAVE-007-behavior-signal-projector`.
- Activation checkpoint passed GPT-5.5/xhigh review
  `019f9c37-3c18-7713-a8a4-4d6767ada6b3` with 0C/0H/0M/0L and was pushed at
  `e6e09fa620e59c08d65ada9345941421abef6d54`.
- Activation-sync marker passed GPT-5.5/xhigh review
  `019f9c3b-ae91-7c53-835a-71e0f7633c59` with 0C/0H/0M/1L and was pushed at
  `c7bedf7fb14775d35a09266a8ae36fac8c438905`; the Low/P3 stale per-task gate
  wording remains untouched.
- TASK-014/TASK-015 branches/worktrees were created and pushed from the exact
  activation-sync commit. Readiness review passed, the readiness checkpoint was
  pushed at `330fdd9c0e4b2e35b6f9793e27fbb06a151c0ebd`, both task branches
  were fast-forwarded to that exact commit, and independent GPT-5.5/high
  workers completed the parallel tasks.
- TASK-015 PR #272 merged into the epic branch at
  `61b552a209db197c65b7ea48f18dff05c68d84d2` after GitHub checks and
  GPT-5.5/xhigh review passed.
- TASK-014 PR #273 merged into the epic branch at
  `dde6bacef91462fadb4fa1fb34ed181ba648dcd2` after GitHub checks and
  GPT-5.5/xhigh review passed.
- Integrated WAVE-007 verification on the merged epic branch passed 11 focused
  files / 227 tests, `npm run build`, scoped ESLint on merged task-owned source,
  and `git diff --check`.
- Both completed task worktrees were verified clean, removed, and pruned during
  reconciliation.
- The WAVE-007 reconciliation checkpoint was committed and pushed at
  `5b20a15f15458d9368fed11423ba246c0534e780`; local and remote epic heads
  matched before WAVE-008 activation.

Stop condition:

- Done: all active tasks merged, reviewed, verified, reconciled, and task
  worktrees cleaned up before WAVE-008 activation.

### WAVE-008

Status: done

Completed: 2026-07-26
Reconciled: 2026-07-26

Activated: 2026-07-26

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
- WAVE-007 landed the lifecycle retention/admin primitives and behavior signal
  projector required by both WAVE-008 tasks.

Activation rule:

- Activate the eligible tasks as one batch after syncing activation artifacts.
- Create one isolated worktree per writing task from the synced epic branch.
- Activation started from exact pushed WAVE-007 reconciliation checkpoint
  `5b20a15f15458d9368fed11423ba246c0534e780`.
- TASK-016 is allocated to branch `task/TASK-016-lifecycle-operator-cli` and
  worktree
  `/Users/ivo.toby/workspace/talon/.worktrees/WAVE-008-lifecycle-operator-cli`.
- TASK-017 is allocated to branch `task/TASK-017-behavior-review-reducers` and
  worktree
  `/Users/ivo.toby/workspace/talon/.worktrees/WAVE-008-behavior-review-reducers`.
- Task branches/worktrees were created only after activation, activation-sync,
  and worktree-readiness checkpoints passed GPT-5.5/xhigh review and were
  committed/pushed.
- Activation checkpoint review `019f9ca8-adb5-7822-b8ac-ddc66ad76f64` passed
  0C/0H/0M/0L and the reviewed checkpoint was committed/pushed at
  `104dfa4c00501c85663adc6c6db6e7524f85ed60`.
- Activation-sync review `019f9caf-0a93-7411-94ab-416736a58509` passed
  0C/0H/0M/0L and the reviewed sync checkpoint was committed/pushed at
  `723b07444b53adc4dc310d036f30e998ff1b0f99`. TASK-016/TASK-017 branches and
  clean worktrees were created and pushed from that exact commit. Worktree
  readiness review `019f9cb4-b944-78e0-bc9a-2fc3a43c5973` passed 0C/0H/0M/0L,
  the readiness checkpoint was committed/pushed at
  `c8057fa9ebba53c5b1ddcafe280389519510b04b`, and both task
  branches/worktrees were fast-forwarded and verified clean before worker
  dispatch.
- TASK-017 merged via PR #274 at epic commit
  `a7ac0cd822bbd01957a5cdb1278fddc5c6e9589d` after focused verification,
  GitHub checks, and GPT-5.5/xhigh review passed.
- TASK-016 merged via PR #275 at epic commit
  `3854e86e922b784d574b98bbe054b7b357b6a0b5` after post-PR274 integration,
  focused verification, GitHub Verify PR, and fresh GPT-5.5/xhigh review
  passed.
- Both clean task worktrees were removed and pruned during reconciliation.

Stop condition:

- All active tasks are done, blocked, cancelled, or explicitly closed.
- Reviews, verification, freshness, shared-context reconciliation, and wdd-reconcile-wave complete before the next wave.

### WAVE-009

Status: in_progress

Activated: 2026-07-26

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
- Activation started from exact pushed WAVE-008 reconciliation checkpoint
  `dd2ca290d89157b674d1cbc67d440c9d295f3cbd`.
- TASK-018 is allocated to branch `task/TASK-018-governed-prompt-promotion` and
  worktree
  `/Users/ivo.toby/workspace/talon/.worktrees/WAVE-009-governed-prompt-promotion`.
- Branch/worktree creation remains blocked until the activation checkpoint
  passes GPT-5.5/xhigh review, is committed and pushed, activation sync passes
  GPT-5.5/xhigh review and commit/push, and worktree readiness passes
  GPT-5.5/xhigh review and commit/push.
- Activation checkpoint review `019f9d13-d0be-7d90-84ef-b4a9e96e23d3` passed
  0C/0H/0M/0L, and reviewed activation checkpoint
  `25fb028bfec71dd1ca86db38e9726822932a96bf` is pushed and recorded for the
  activation-sync review. Branch/worktree creation remains blocked.

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
- TASK-019 must create e2e tests for the completed lifecycle waves and validate
  the event pipeline using Sprites before the epic is considered complete.

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

- WAVE-001 through WAVE-008 are done and reconciled. WAVE-008 TASK-017 merged
  through PR #274 at `a7ac0cd`, TASK-016 merged through PR #275 at `3854e86`,
  and both clean task worktrees were removed and pruned.
- WAVE-009 is active as a bundled TASK-018 work packet. WAVE-010 owns the
  user-required e2e tests and Sprites event-pipeline validation after governed
  prompt promotion lands; WAVE-011 documents adoption after verification.
- The explicit implementation request confirms the full-profile strategy recommendations; reconciliation may narrow later parallelism when evidence changes.
- Commit/sync planning and activation artifacts to epic/durable-lifecycle-pipeline before task worktrees.
- Waves never overlap across reconciliation boundaries.

## Manual Adjustments

- Issue #70 historical trace access is optional; TASK-013 creates a provider seam and existing tracing.
- The full test suite remains a user-approval gate at epic validation.
