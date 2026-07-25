---
id: EPIC-durable-lifecycle-pipeline-RESOURCE-testing-strategy
kind: shared_context_resource
epic: EPIC-durable-lifecycle-pipeline
resource: testing-strategy
updated_at: 2026-07-25
---

# Shared Context Resource: Testing Strategy

## Purpose

Define the verification layers required for a full-profile lifecycle,
persistence, security, and provider-session change.

## Summary

Tasks use focused RED/GREEN tests. Persistence and integration tests use real
in-memory or temporary-file SQLite, not repository mocks alone. Reviews block
on Critical/High/Medium findings. Epic validation adds the approved full test
suite, a real daemon terminal smoke round trip, and a sprites validation pass
for the lifecycle event pipeline. WAVE-004 established focused daemon-boundary,
migration-upgrade, and hot-reload regression baselines; WAVE-005 added
run/tool/outbound, context-projector, and behavior-ledger baselines.

## Test Layers

1. **Pure contracts and registry:** schema versions, result unions, priority,
   deterministic composition, subscription/filter resolution, stable identity,
   duplicate registration, incompatible contract/config rejection.
2. **Interceptor execution:** ordered transforms, deny/approval results,
   per-handler and total deadlines, fail-open/closed policy, exception/result
   normalization, audit detail, secret redaction.
3. **SQLite repositories/outbox:** migration upgrade, atomic state+event write,
   delivery uniqueness, claims/leases, aggregate ordering, concurrency limits,
   retry scheduling, dead-letter, replay, retention, privacy deletion, crash and
   restart recovery.
4. **Dispatcher/adapters/projectors:** at-least-once delivery with effectively
   once state, handler isolation, circuit/backpressure, recursion guard,
   capability/scope enforcement, prompt fencing, token/timeout bounds, output
   schema validation, correlation/causation.
5. **Publisher integrations:** message, route, queue, run, provider tool,
   outbound, context, and schedule transitions emit the right bounded event once
   and do not alter disabled behavior.
6. **Context compatibility:** retain usage thresholds, transcript windows,
   schedule/direct context, observation validation, memory/pre-roll writes,
   continuation flags, rotation boundaries, reducer thresholds, atomic
   replacement, provider session rotation, and preserve-session failure.
7. **Behavior governance:** evidence fingerprints collapse schedule/direct
   copies, inferred evidence requires distinct sources, explicit feedback
   provenance, conflict/evaluation gates, default approval, reload result, and
   rollback state.
8. **Operations:** reload retains pending delivery meaning, CLI list/inspect/
   replay/disable/provenance flows, health/backlog metrics, audit rows, and
   Langfuse correlation.

## Task Gates

- Focused Vitest file(s) for every changed behavior.
- `npm run build` for TypeScript/runtime/config changes.
- `npm run lint` for source changes when practical.
- Migration runner and repository tests for schema changes.
- `git diff --check` before handoff.
- `gpt-5.5` review with xhigh reasoning before every commit; no unresolved Critical/High/Medium or
  P1/P2 findings.

## WAVE-004 Regression Baseline

- Preserve the established daemon/pipeline/queue/scheduler integration set that
  passed 385 focused tests under Node 24, plus build and scoped static checks.
- Persistence verification must exercise authoritative insert-vs-duplicate
  outcomes, atomic message/route/enqueue publication, DB-owned queue scope, and
  claimed-only terminal publication with real SQLite where applicable.
- Migration upgrade coverage must prove v14 applies migrations 015, 016, and
  017 and finishes at `user_version` 17 while retaining data, triggers,
  indexes, and foreign-key behavior. The focused repository test passed 30/30.
- Scheduler tests must cover stop/start generation invalidation after async
  prompt lookup and before enqueue/state mutation, plus bounded drain failure
  behavior that keeps teardown and restart gated.
- Reload tests must prove lifecycle configuration and lifecycle-attached
  subscription/sub-agent/capability-authority changes fail before any reload
  mutation, while ordinary non-authority persona changes remain reloadable. The
  focused reload suite passed 26/26.
- Final task evidence includes Verify PR run `29511783210`, PR Agent with no
  review threads, clean branch freshness/merge, and GPT-5.5/xhigh review gates
  with 0C/0H/0M/0L.

## WAVE-005 Regression Baseline

- Run/tool/outbound verification must cover run started/completed/failed,
  provider tool started/completed, outbound sent/send_failed, before-execute and
  before-send interception, approval preservation, redaction/bounded payloads,
  stable outbound idempotency, and no duplicate transcript row when a streamed
  run already flushed intermediate text and returns no final text.
- Context verification must cover strict observer/reducer contracts,
  observation projection, named-memory append idempotency, pre-roll tails,
  reduction, continuation metadata, replay, and boundary preservation through
  `ContextRoller`.
- Behavior-ledger verification must cover migration 018, v14-to-current upgrade
  through user_version 18, persona isolation, evidence fingerprints,
  distinct-source rules, guarded status transitions, promotion/activation, and
  rollback lineage.
- Final task evidence includes PR #266, #267, and #268 merges, focused tests,
  build, scoped lint, diff checks, GitHub Verify PR/PR Agent gates as
  applicable, and GPT-5.5/xhigh reviews with no remaining Critical/High/Medium
  findings. The TASK-009 tombstone-visibility P3 remains non-blocking.

## Epic Validation

- All focused task checks and integration suites pass on the reconciled epic
  branch.
- `npm run build` and `npm run lint` pass or advisory lint limitations are
  recorded.
- `npm test` runs only with user approval because the repository marks it slow.
- `$run-talon-smoke` proves daemon boot, SQLite migrations, terminal IPC, queue,
  provider runtime, and response delivery; no listeners remain afterward.
- End-to-end tests must cover the completed lifecycle/event pipeline behavior
  from publisher through dispatcher/projector side effects. After all waves are
  reconciled, validate that event pipeline in an isolated sprites run before
  declaring the epic complete.
- Documentation, example config, setup skill, migration packaging, and effective
  CLI help are inspected for drift.
- Final review specifically checks event atomicity, data leakage, replay side
  effects, context races, reload identity, and rollback behavior.

## Durable Memory

### Lifecycle Epic Verification Standard

- Source task: epic definition for GitHub issue #256
- Source PR/branch: `epic/durable-lifecycle-pipeline`
- Status: confirmed
- Summary: Focused TDD plus real SQLite transition tests, cross-module
  integration, full-suite approval gate, and daemon terminal smoke are required.
- Why it matters: Mock-only proof is insufficient for durable delivery,
  idempotency, restart, context rotation, or migration behavior.
- Affected files or areas: all lifecycle tasks and epic validation.
- Follow-up implications: Task briefs must name focused tests and identify when
  a runtime smoke or integration gate is deferred to a later dependency.
