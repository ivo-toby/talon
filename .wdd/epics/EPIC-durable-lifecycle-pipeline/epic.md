---
id: EPIC-durable-lifecycle-pipeline
kind: epic
type: feature
slug: durable-lifecycle-pipeline
title: Durable Lifecycle Pipeline and Pluggable Handlers
status: in_progress
created_at: 2026-07-15
updated_at: 2026-07-16
target_branch: main
epic_branch: epic/durable-lifecycle-pipeline
profile: full
review_mode: risk_based
monitoring_mode: adaptive
schema_version: 1
ticket_count: 6
task_count: 20
adapter_links:
  github_issue: https://github.com/ivo-toby/talon/issues/256
  jira_epic: null
---

# Durable Lifecycle Pipeline and Pluggable Handlers

## Summary

Add a daemon-wide, two-lane lifecycle extension system: bounded synchronous
interceptors for decisions that must precede a state transition, and a durable
asynchronous event pipeline for independently retryable observers, reducers,
projectors, and listeners. Native orchestration and state projection remain
trusted Talon responsibilities, while model-driven analysis stays optional,
typed, capability-scoped, and replaceable through configured sub-agents.

## Goal

Make lifecycle integrations pluggable without editing central daemon paths,
while preserving Talon's security, persistence, queue ordering, context
rotation, audit, and provider-session invariants. Migrate observational memory
off sub-agent name checks and provide a safe foundation for behavior feedback,
self-review, notifications, trace analysis, and future guardrails.

## Background

GitHub issue #256 identifies lifecycle boundaries across `MessagePipeline`,
`QueueProcessor`, `AgentRunner`, scheduler execution, host-tool execution, and
outbound delivery that currently have no shared extension mechanism. The
existing observational-memory path checks for `session-observer`, injects
`session-reflector` by name, and commits context state inside central runner
logic. Other cross-cutting analyzers would require similar coupling.

## Product Context

Operators need to attach analysis and policy behavior explicitly per persona,
inspect effective subscriptions and failed deliveries, and replace optional
model implementations without weakening core invariants. Existing
configurations must retain their behavior during migration. Background handlers
must not delay or duplicate a user-facing run, and installed sub-agents must
never receive lifecycle data merely because they exist.

## Technical Context

- SQLite and `better-sqlite3` provide WAL-mode durable state and synchronous
  transactions through repository classes returning `neverthrow` results.
- The user-facing durable queue already demonstrates FIFO, retry, and
  dead-letter patterns, but lifecycle delivery must be independent so handler
  failures cannot affect originating work.
- `AgentRunner` currently evaluates context thresholds after a successful run,
  selects observational memory by comparing the summarizer name, and passes a
  hard-coded reflector name into `ContextRoller`.
- Daemon bootstrap currently auto-binds `session-reflector` when it sees
  `session-observer`.
- Sub-agents are manifest-loaded, model-resolved, optional implementations and
  already support structured inputs, timeouts, failover, and observability.
- Audit logs and Langfuse correlation exist and must be extended rather than
  replaced.
- Issue #70 owns bounded read-only Langfuse trace access; this epic may consume
  that adapter but does not implement #70.

## Deliverables

1. Versioned lifecycle event, signal, interceptor, handler, and contract types,
   plus a daemon-scoped registry with deterministic subscription resolution.
2. Durable lifecycle outbox and per-handler delivery state with atomic publish
   support, at-least-once processing, idempotency, retry, dead-letter,
   aggregate ordering, recursion guards, retention, and restart recovery.
3. A dispatcher isolated from the user-facing queue, with bounded global and
   per-handler concurrency, backpressure, circuit-breaking behavior, health,
   metrics, and audit records.
4. Native and sub-agent handler adapters that enforce configuration,
   capabilities, scope, time/token budgets, untrusted-input fencing, contract
   validation, correlation, and failure policy.
5. Initial lifecycle publications across inbound messages, routing, queue
   transitions, runs, provider tool activity, outbound delivery, context
   thresholds/rotation, and schedules.
6. Ordered synchronous interception at the initial message, run, tool, and
   outbound boundaries, with composable transforms, strict budgets, explicit
   fail-open/fail-closed behavior, approval results, and audit evidence.
7. Observational-memory migration to configured observer/reducer contracts and
   a native projector, including compatibility translation and deprecation for
   existing `contextManagement.summarizer` configuration.
8. Persona-scoped behavior-signal storage, explicit-feedback detection,
   evidence deduplication, daily/weekly reduction, provenance, governed prompt
   proposals, evaluation records, activation/reload status, and rollback data.
9. Operator configuration and CLI surfaces for effective handlers, delivery
   inspection/replay, handler disablement, and behavior-candidate provenance.
10. Unit, integration, migration, reload/restart, security/scope, and real
    runtime smoke coverage, plus synchronized README, self-documentation,
    example config, AGENTS guidance, and affected setup skills.

## Non-Goals

- Implementing arbitrary expression evaluation in lifecycle filters.
- Treating model-backed interceptors as hard security boundaries.
- Automatically subscribing a newly installed sub-agent.
- Giving sub-agents direct database mutation authority.
- Supporting remote webhook or MCP handlers before their authentication and
  delivery contracts are separately designed.
- Duplicating transcripts, complete tool payloads, secrets, or Langfuse traces
  into lifecycle event payloads.
- Implementing the read-only Langfuse trace API tracked by issue #70.

## Assumptions

- Native core contracts are versioned TypeScript schemas; operator-supplied
  handler contracts may additionally use validated JSON Schema without
  replacing built-in schemas for native projectors.
- Handler definitions are global, subscriptions are explicit per persona, and
  provider configuration remains the owner of context-usage measurement.
- Completed events and deliveries are compacted after a configurable audit
  window rather than retained forever; live references participate in privacy
  and thread deletion.
- Context rotation becomes a durable, high-priority, per-thread ordered handler
  whose pending projection blocks only the next ordinary item for that thread.
  This preserves session invariants without adding latency to the completed
  user-facing response.
- Prompt promotion defaults to operator approval. Only narrowly scoped changes
  explicitly pre-authorized by policy may auto-promote after validation and a
  successful evaluation/reload gate.

## Constraints

- Existing configurations must behave identically while lifecycle is disabled
  or while compatibility translation is active.
- Async failures must never fail, retry, or duplicate the originating queue
  item or outbound response.
- Security enforcement remains deterministic and native by default.
- Durable payloads are bounded, secret-free references plus minimal metadata.
- Side effects and projectors are idempotent under at-least-once delivery.
- Per-thread/persona capability and data isolation is default-deny.
- Handler-emitted events preserve correlation/causation and enforce a maximum
  recursion depth.
- Database, queue, provider session, context rotation, and prompt-write
  transitions must retain transactional or explicitly recoverable invariants.
- Expected failures cross module boundaries as typed `Result` values.
- RED/GREEN TDD, `gpt-5.5`/xhigh pre-commit review, P1/P2 gates, task PRs, and the full
  WDD review/validation policy apply.
- Feature/config changes require README, affected `.agents/skills/`, example
  config, self-documentation, and AGENTS updates in the same epic.

## Risks

- Incorrect outbox transaction boundaries could lose events or publish events
  for state changes that rolled back.
- Per-aggregate ordering and retry locks could starve delivery or deadlock a
  thread if context rotation is not modeled separately from the user queue.
- Replayed projector/listener work could duplicate memory, messages,
  notifications, behavior evidence, or prompt mutations.
- Broad instrumentation could leak content or secrets into durable payloads,
  logs, audit rows, or model prompts.
- Compatibility translation could silently change context behavior or session
  continuation semantics.
- Dynamic reload could orphan pending deliveries or change handler identity in
  a way that breaks idempotency.
- Behavior promotion could create conflicting rules or unsafe feedback loops
  without provenance, evaluation, approval, and rollback gates.
- Cross-module work has high conflict potential; shared contracts and schema
  must land before parallel integration tasks.

## Dependencies

- Existing database migration/repository, queue retry/dead-letter, audit,
  capability, sub-agent, config reload, and Langfuse correlation mechanisms.
- GitHub issue #70 only for optional bounded trace evidence consumption; its
  absence must not block the native lifecycle pipeline or handler tracing.
- Current observational-memory tests and semantics are the compatibility oracle
  for the context migration.

## Affected Areas

- `src/lifecycle/` (new contracts, registry, bus, dispatcher, adapters,
  projectors, policies, metrics)
- `src/core/database/migrations/` and `src/core/database/repositories/`
- `src/core/config/config-schema.ts` and configuration loading/reload
- `src/daemon/agent-runner.ts`, `src/daemon/context-roller.ts`, daemon bootstrap,
  lifecycle, watchdog, and daemon context wiring
- `src/pipeline/`, `src/queue/`, `src/scheduler/`, `src/tools/`, outbound channel
  delivery, and provider tool-stream handling
- `src/subagents/`, default observer/reflector manifests, model resolution, and
  lifecycle input/output contracts
- `src/observability/`, audit logging, IPC, and `src/cli/`
- Unit/integration tests, migrations, reload/restart tests, runtime smoke
  harnesses, README, self-documentation, example config, AGENTS, and setup skills

## Validation Strategy

Use layered verification. Each task starts with focused RED tests and runs its
targeted Vitest files plus build/lint as appropriate. Persistence tasks prove
atomicity, idempotency, ordering, retry, dead-letter, retention, and restart
recovery against real SQLite. Security tasks prove default-deny scope,
capability filtering, prompt fencing, schema rejection, timeout/failure policy,
and no secret-bearing payloads. Integration tests prove inbound-to-outbound
event flow and context threshold-to-projector-to-reducer-to-rotation behavior.
Epic validation runs the full suite with user approval, build, lint,
documentation/config drift checks, migration-from-existing-schema coverage,
config reload, and `$run-talon-smoke` daemon/terminal round trips.

## Definition of Done

- [ ] Existing configs and lifecycle-disabled behavior are regression-tested.
- [ ] Core paths contain no observer/reflector sub-agent name checks.
- [ ] All deliverables are implemented with typed contracts and focused tests.
- [ ] Async failure/restart/replay/ordering/idempotency and recursion behavior is
      verified against real SQLite.
- [ ] Cross-persona/thread scope isolation and interceptor timeout/failure policy
      are verified.
- [ ] Observational memory passes its existing and new contract/projector tests,
      including continuation and atomic reducer replacement behavior.
- [ ] Explicit feedback is traceable from source message through evidence,
      proposal/policy, evaluation, activation/reload, and rollback records.
- [ ] Handler runs are correlated in audit and Langfuse without making issue #70
      mandatory.
- [ ] Operator CLI, metrics, health, replay, disable, and provenance flows are
      documented and tested.
- [ ] README, self-documentation, example config, AGENTS, default sub-agent docs,
      and affected setup skills match the implementation.
- [ ] Task reviews have no unresolved P1/P2 findings.
- [ ] Epic validation, including the approved full test suite and runtime smoke,
      passes.
- [ ] Final epic PR into `main` is ready for human review.

## Open Questions

- None block planning. The decisions recorded in shared context are the initial
  implementation defaults and may be amended only with evidence and an epic
  decision note.

## Planning Notes

- Use the issue's six delivery phases as ticket boundaries, but split
  foundations into smaller tasks so contracts/schema precede integration.
- Land shared contracts, configuration identity rules, and database schema in
  early narrow waves before parallel publishers/handlers.
- Treat database schema, lifecycle public contracts, daemon bootstrap, config
  schema, `AgentRunner`, context rotation, and CLI command registration as
  explicit conflict domains.
- Keep the first implementation native/in-process. Defer remote handlers and
  arbitrary filters.
- Schedule issue #70 consumption as a final optional adapter task; handler
  tracing through existing Langfuse instrumentation remains in scope.
- The next phase is `wdd-start-wave` for WAVE-001.
