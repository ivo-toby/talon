---
id: EPIC-durable-lifecycle-pipeline-RESOURCE-architecture
kind: shared_context_resource
epic: EPIC-durable-lifecycle-pipeline
resource: architecture
updated_at: 2026-07-15
---

# Shared Context Resource: Architecture

## Purpose

Define the trusted boundaries and repository integration map for issue #256.

## Summary

Talon must own event durability, subscription resolution, scope enforcement,
interceptor budgets, output validation, projection, and audit. Native or
sub-agent implementations run behind registered adapters. Async delivery is a
separate durable workload that cannot affect the originating user-facing queue.

## Current Boundaries

- `MessagePipeline.handleInboundEvent()` resolves channel/thread, normalizes,
  deduplicates, persists, routes, and enqueues synchronously.
- `QueueProcessor.processNext()` owns FIFO claim, completion, retry, and
  dead-letter transitions.
- `AgentRunner.run()` owns run creation, provider execution/tool streams,
  outbound persistence/delivery, context threshold evaluation, rotation, and
  final run status.
- `ContextRoller` reconstructs transcripts and commits summary/observation,
  pre-roll, memory, reducer, and session rotation state.
- Daemon bootstrap binds configured summarizers and currently auto-includes
  `session-reflector` when `session-observer` is named.
- Repository calls are synchronous `better-sqlite3` operations returning typed
  results; migration files are transactionally applied and tracked with
  `user_version`.

## Target Boundaries

1. `LifecycleEventBus` exposes typed publish and intercept operations, writes
   outbox state through transaction-aware repository APIs, and wakes dispatch
   only after commit.
2. `LifecycleHandlerRegistry` resolves stable handler IDs, kinds,
   implementation factories, contracts, explicit persona subscriptions,
   priorities, filters, budgets, and failure policies.
3. `LifecycleDispatcher` claims delivery rows independently from the user queue
   and enforces handler/aggregate ordering, locks, concurrency, retry,
   dead-letter, idempotency, backpressure, and circuit state.
4. Native handlers and `SubAgentLifecycleAdapter` emit typed results/signals;
   they never receive unrestricted repositories.
5. Native projectors validate provenance and commit idempotent state changes,
   optionally publishing causally linked events in the same transaction.
6. A native context policy measures provider usage. The configured observer and
   reducer satisfy named contracts; the native projector preserves all current
   context/session invariants.

## Invariants

- An atomic domain transition and its lifecycle event either both commit or
  neither commits.
- Delivery is at least once; observable state and side effects are effectively
  once through stable `(event_id, handler_id)` identity plus projector/listener
  idempotency keys.
- One failed async handler cannot re-run or fail the original queue item.
- Events use bounded references and metadata; permitted detail is loaded later
  under the handler's persona/capability scope.
- Handler installation and handler subscription are separate explicit actions.
- Transform order is deterministic and every interceptor decision is audited.
- Security-critical denial remains native/deterministic by default.
- Correlation, causation, aggregate identity, schema version, and recursion
  depth are preserved across emitted signals/events.
- Hot reload changes future resolution without discarding already persisted
  deliveries or reinterpreting their stable handler identity.

## Initial Integration Map

| Boundary | Initial output or hook | Transaction/ordering concern |
|---|---|---|
| Inbound normalize/persist | `message.before_persist`, `message.persisted.v1` | Persist transformed message and event atomically |
| Persona route | `message.routed.v1` | Reference message/thread/persona; avoid duplicate content |
| Queue enqueue/complete/fail/dead-letter | versioned queue events | Couple each queue transition to its event |
| Run create/finalize | `run.started.v1`, `run.completed.v1`, `run.failed.v1` | Preserve run status and correlation |
| Provider tool stream | tool started/completed events and `tool.before_execute` | Redact arguments/results; keep approval semantics authoritative |
| Outbound send | `message.before_send`, sent/send-failed events | Avoid double-send on replay; stable message/delivery IDs |
| Context policy/projector | threshold/rotation/reduction events | Order per thread and block only the next ordinary thread item while projection is pending |
| Scheduler | `schedule.fired.v1` | Preserve schedule/source provenance to deduplicate evidence |

## Durable Memory

### Initial Architecture Split

- Source task: epic definition for GitHub issue #256
- Source PR/branch: `epic/durable-lifecycle-pipeline`
- Status: confirmed by issue and repository inspection
- Summary: Native Talon code owns orchestration, validation, persistence, and
  state projection; pluggable native/sub-agent handlers supply bounded logic or
  reasoning behind explicit subscriptions.
- Why it matters: Future workers must not move database/session/security
  invariants into prompts or handler implementations.
- Affected files or areas: daemon, lifecycle, database, config, sub-agents,
  context management, audit, observability.
- Follow-up implications: Plan shared contracts and persistence before parallel
  publishers or handler migrations.
