---
id: EPIC-durable-lifecycle-pipeline-RESOURCE-task-findings
kind: shared_context_resource
epic: EPIC-durable-lifecycle-pipeline
resource: task-findings
updated_at: 2026-07-26
---

# Shared Context Resource: Task Findings

## Purpose

Collect only reconciled discoveries that later tasks, reviewers, or validators
need. Workers should propose concise updates; the controller owns reconciliation.

## Summary

WAVE-001 froze the lifecycle contracts and registry boundary. WAVE-002 added
durable event/delivery persistence, deterministic interceptor execution, and a
capability-scoped sub-agent adapter. WAVE-003 added transaction-owned
publication and an independently supervised durable dispatcher. WAVE-004 wired
that runtime through daemon, inbound message, queue, and scheduler boundaries.
WAVE-005 added run/tool/outbound publishers, context contracts/projector, and
behavior-ledger persistence. Later tasks must consume these APIs and resolved
identities rather than re-deriving authority, safety, causality, durability,
compatibility, context projection, behavior evidence, or execution policy.
WAVE-006 migrated context rotation to configured lifecycle handlers, added the
typed explicit-feedback detector, and wired bounded lifecycle telemetry/
correlation. Later tasks must preserve durable restart/retry recovery, trusted
behavior provenance, and after-commit telemetry boundaries.

## Details

- Source: TASK-001 / PR #257, merged at `e5fda2a` on 2026-07-16.
- Runtime authority is capability-bearing and external to YAML. Native handlers
  must exactly match the bootstrap catalog; sub-agent handlers must exactly
  match the loader-owned manifest capability catalog. Catalogs are bounded,
  materialized once, and reject accessors, proxies, callable proxies, malformed
  iterator steps, and conflicting or duplicate capability tuples.
- Contract resolution is frozen to registered mode/input/output/safety pairs.
  Only native interceptors may be enforcing; sub-agent interceptors remain
  advisory and cannot become a hard security boundary through configuration.
- Handler-emitted signals must preserve aggregate and correlation identity,
  use the invocation identity as causation, increment recursion depth exactly
  once, preserve max depth, and stay within the recursion boundary.
- Lifecycle omission and `enabled: false` preserve legacy configuration
  behavior. Lifecycle-only duplicate persona/channel validation applies only
  when lifecycle is enabled.
- Interceptor JSON is iteratively bounded by depth, collection size, node count,
  string length, and UTF-8 bytes, and materialized into detached snapshots.
  TASK-003 must close the remaining in-process hardening gap by rejecting root
  and nested object/array proxies before any reflection and asserting zero trap
  execution.
- WAVE-002 dependencies and parallel conflict domains remain valid; no new
  architecture dependency was introduced.
- Source: TASK-002 / PR #260, merged at `49e47bf` on 2026-07-16. Lifecycle
  events and per-handler deliveries are bounded and atomically fanned out in
  real SQLite. Repository-controlled claim time, stable event/handler identity,
  ordered claims, leases, retry, dead-letter, and replay transitions are
  enforced in repositories plus SQL guards.
- SQLite `BEFORE INSERT` observes an omitted `INTEGER PRIMARY KEY` as provisional
  `-1`; replacement guards must exclude that sentinel. Replay eligibility must
  be validated before global expiry recovery so rejected replay remains atomic.
  Downstream transactional publication/dispatch must not bypass these guards.
- Source: TASK-003 / PR #258, merged at `fcde60a` on 2026-07-16. Interceptors
  execute deterministically by priority and stable ID, compose bounded
  transforms, enforce per-handler and total budgets, short-circuit restrictive
  outcomes, and emit redacted audit evidence. A fail-open per-handler timeout
  continues to later enforcing handlers unless the total deadline expires.
- Interceptor JSON rejects proxies and accessors before reflection, remains
  bounded and detached, and defaults omitted signal metadata to `{}` only after
  strict materialization. Native-only enforcing authority and causal identity
  remain registry-owned.
- Source: TASK-004 / PR #259, merged at `54dc872` on 2026-07-16. Lifecycle
  sub-agents are advisory-only, explicitly attached, loader-authorized,
  capability/persona scoped, repository-free, prompt-fenced, bounded by model/
  token/time attempts, and validated against named output contracts. Approval
  is never inferred and adapter/runner identities require exact canonical
  safety tuples.
- Contract and persistence string domains now agree: event/runtime/reference/
  metadata strings reject NUL and malformed Unicode before persistence;
  lifecycle-enabled persona owners are bounded to 256 Unicode scalars and 1024
  UTF-8 bytes. Omitted or disabled lifecycle configuration preserves legacy
  owner acceptance and exact valid spelling.
- One non-blocking TASK-004 Low remains: final-attempt failover logging can imply
  another attempt after the deadline. It is recorded for follow-up and must not
  be auto-remediated.
- Delivery throughput policy proven in WAVE-002: execute disjoint task worktrees
  in parallel, remediate blockers in parallel across tasks, use one integration
  owner for overlapping same-task findings, ignore Low/P3 for automatic edits,
  and require a fresh full GPT-5.5/xhigh review plus status/hash integrity proof
  before every commit.
- Source: TASK-005 / PR #261, merged at `d3357fb` on 2026-07-16. The lifecycle
  event bus owns its SQLite transaction coordinator, binds transaction authority
  opaquely to the exact bus and connection, snapshots stable subscribers, and
  wakes dispatch only after the owned commit succeeds. Caller-owned publication
  remains a typed `Result` boundary; external or nested active transactions are
  rejected rather than risking a pre-outer-commit wake.
- Derived publication preserves correlation and aggregate identity, uses the
  parent invocation as causation, increments recursion depth exactly once, and
  cannot cross the configured depth boundary. Rejected asynchronous wake work
  is contained and cannot escape as an unhandled rejection.
- Source: TASK-006 / PR #262, merged at `8f74740` on 2026-07-16. Dispatcher
  construction snapshots immutable repository, executor, policy, clock, and
  wake authority through bounded descriptor-safe validation. Native and
  sub-agent execution require the complete captured handler identity; one
  global sub-agent handler may serve multiple personas only through separate
  explicit persona attachments.
- Dispatcher concurrency accounts for the underlying execution, not only its
  timeout race. An abort-ignoring timed-out handler retains its global and
  per-handler slot until it actually settles, while graceful shutdown remains
  bounded and clears the losing shutdown timer so an idle stop does not pin the
  Node event loop.
- Migration 014 remains immutable. Additive migration 015 upgrades existing v14
  databases so captured non-retryable failures dead-letter immediately even
  when `max_attempts > 1`; migration-runner coverage must retain v13-to-v15 and
  v14-to-v15 data, trigger/index, and foreign-key checks.
- Dispatcher claims and dependency calls are contained at typed `Result`
  boundaries; public dispatch still participates in global concurrency,
  exclusion scans are bounded without starving healthy handlers, and wake
  notifications remain drain-safe. Daemon wiring in TASK-007 must supervise
  this workload independently of the user queue and preserve these invariants.
- Two WAVE-003 Lows remain follow-ups and were intentionally not remediated:
  TASK-005 standalone strict-TypeScript fixture shapes and TASK-006's historical
  `git show fbe4f08` migration fixture dependency in shallow/source checkouts.
- Source: TASK-007 / PR #263, final task commit `fab9495`, merged at `67e93ac`
  on 2026-07-16. Daemon bootstrap constructs one shared lifecycle runtime and
  passes that exact optional authority to message, queue, scheduler, and
  background producers. Omitted or disabled lifecycle configuration preserves
  null wiring and the legacy path.
- Inbound acceptance owns message persistence, persisted/routed publication,
  and queue enqueue in one lifecycle-bus transaction. Only the authoritative
  message insert outcome publishes/enqueues; duplicate detection cannot commit
  a message without its queue/event side effects or publish them twice.
- Queue lifecycle persona/item scope is stored in manager-owned database
  columns, never trusted from caller payload metadata. Enqueue and terminal
  events share stable correlation; terminal publication occurs only for a
  successful claimed-state transition, so repeated/conflicting completion is
  event-idempotent.
- Scheduler work carries its originating generation across every asynchronous
  boundary and revalidates before enqueue or state mutation. Queue, scheduler,
  and lifecycle dispatcher shutdown use bounded drain results; failed or timed-
  out drains retain teardown/restart gates instead of closing dependencies
  beneath active work.
- Successful lifecycle handler signals use an atomic, persona-scoped durable
  handoff. Additive migrations 016 and 017 introduce signal handoff and
  database-owned queue scope without rewriting earlier migrations. Opening a
  v14 database now applies migrations 015-017 and ends at `user_version` 17;
  migration tests must expect three applied migrations, not one.
- Hot reload does not rebuild the bootstrap-owned lifecycle runtime. Reload
  therefore rejects top-level lifecycle configuration or lifecycle-attached
  persona subscription, sub-agent assignment, and capability-authority changes
  before applying any mutable reload setting. TASK-014 owns restart/reload
  evolution from this explicit restart-required baseline.
- WAVE-004 evidence passed 385 focused integration tests under Node 24 plus
  build/scoped static checks, 30/30 focused migration tests, 26/26 focused
  reload tests, Verify PR run `29511783210`, final substantive GPT-5.5/xhigh
  review and integrity adjudication, and a clean WDD marker review. PR Agent had
  no review threads; no Low/P3 finding was auto-remediated.
- Source: TASK-009 / PR #266, merged at `3c1b5f4` on 2026-07-25. Context
  observer/reducer contracts now live under `src/lifecycle/context`, and the
  native context projector preserves observation, named-memory append
  idempotency, pre-roll tail, reduction, continuation, and boundary invariants.
  Downstream TASK-011 must consume the explicit projector contracts instead of
  re-encoding ContextRoller name-based behavior. One non-blocking P3 remains:
  tombstone visibility in projection evidence. It must not trigger automatic
  edits.
- Source: TASK-010 / PR #267, merged at `08c564a` on 2026-07-25. Migration 018
  adds persona-scoped behavior evidence, candidates, promotions, activations,
  and rollback lineage. `BehaviorSignalRepository` owns guarded transitions,
  fingerprint/provenance uniqueness, persona isolation, and rollback lineage
  tests. Existing migration-upgrade tests must now expect v14 databases to apply
  four forward migrations and finish at `user_version` 18.
- Source: TASK-008 / PR #268, merged at `6921a9e` on 2026-07-25. AgentRunner,
  host-tool, and channel-send boundaries publish run started/completed/failed,
  provider tool started/completed, and outbound sent/send_failed events.
  `run.before_execute`, `tool.before_execute`, and `message.before_send` route
  through existing authoritative paths while preserving capability/approval
  semantics. Outbound delivery uses stable queue-item-scoped idempotency keys
  for final, streamed, waiting, and tool-notice messages. Streamed intermediate
  reservations suppress the synthetic final fallback transcript row when the
  provider returns no final text, preventing duplicate already-flushed text.
- WAVE-005 evidence passed focused context tests (65 tests), focused
  run/tool/outbound tests (164 tests after remediation/rebase), behavior
  repository/migration tests plus CI-selected migration coverage, build, scoped
  lint, diff checks, GitHub Verify PR/PR Agent gates as applicable, and
  GPT-5.5/xhigh reviews. No Critical/High/Medium findings remain.
- Source: TASK-011 / PR #271, merged at `3bba6a0` on 2026-07-26. Context
  rotation now uses explicit `summarizer` or `observation` context-management
  modes and configured summarizer/observer/reducer handlers rather than
  hard-coded `session-observer`/`session-reflector` names. Legacy
  `summarizer: session-observer` configs translate to observation mode with a
  deprecation path.
- Context projection must remain durable across crash/retry windows. Persisted
  summary or observation rotation metadata defines the restart session boundary
  before DB session restoration. Stateless-provider continuation work uses a
  stable queue-item-derived id/idempotency key and can be repaired below the
  current threshold from either an existing continuation message or a durable
  same-queue-item open rotation marker.
- Source: TASK-012 / PR #269, merged at `af75d4b` on 2026-07-26. The
  `behavior-feedback-detector` is repository-free and emits only typed
  `talon.behavior.signal.v1` outputs derived from trusted lifecycle references.
  Model output cannot choose its own provenance; the detector validates source
  ids against trusted input and supports `tool_call` evidence consistently
  through contract validation and behavior ledger persistence.
- Source: TASK-013 / PR #270, merged at `3e09c37` on 2026-07-26. Lifecycle
  telemetry and audit evidence are bounded and correlated across publication,
  handler delivery, interceptor decisions, signal handoff, replay/reopen, and
  behavior promotion mutations. Publication success evidence is emitted only
  after the lifecycle event-bus transaction commits; rollback paths emit no
  false success metrics.
- Trace evidence remains optional and bounded. Traceparent normalization rejects
  invalid W3C `ff` versions. Langfuse observations are parent-linked only when
  valid trace context exists; interceptor/retry/signal-handoff paths may remain
  audit/metric evidence instead of trace-nested spans.
- WAVE-006 evidence passed three GitHub PR gates (#269/#270/#271), task-level
  GPT-5.5/xhigh reviews with no remaining Critical/High/Medium findings, and
  integrated epic verification: 19 targeted files / 647 tests, `npm run build`,
  scoped ESLint with 0 errors and known warnings only, and `git diff --check`.
  All three clean worktrees were removed and pruned.

## Durable Memory

- Preserve these authority, causality, compatibility, bounded-input,
  persistence, interceptor, sub-agent, transaction, dispatch, migration, context
  projection, behavior-ledger, outbound idempotency, durable continuation
  repair, telemetry commit-boundary, trusted behavior provenance, and
  review-throughput rules in later lifecycle implementation and review prompts.
