---
id: EPIC-durable-lifecycle-pipeline-RESOURCE-task-findings
kind: shared_context_resource
epic: EPIC-durable-lifecycle-pipeline
resource: task-findings
updated_at: 2026-07-16
---

# Shared Context Resource: Task Findings

## Purpose

Collect only reconciled discoveries that later tasks, reviewers, or validators
need. Workers should propose concise updates; the controller owns reconciliation.

## Summary

WAVE-001 froze the lifecycle contracts and registry boundary. WAVE-002 added
durable event/delivery persistence, deterministic interceptor execution, and a
capability-scoped sub-agent adapter. WAVE-003 added transaction-owned
publication and an independently supervised durable dispatcher. Later tasks
must consume these APIs and resolved identities rather than re-deriving
authority, safety, causality, durability, compatibility, or execution policy.

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
  and require a fresh full Sol/high review plus status/hash integrity proof
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

## Durable Memory

- Preserve these authority, causality, compatibility, bounded-input,
  persistence, interceptor, sub-agent, transaction, dispatch, migration, and
  review-throughput rules in later lifecycle implementation and review prompts.
