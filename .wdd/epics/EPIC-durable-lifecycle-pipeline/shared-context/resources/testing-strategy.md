---
id: EPIC-durable-lifecycle-pipeline-RESOURCE-testing-strategy
kind: shared_context_resource
epic: EPIC-durable-lifecycle-pipeline
resource: testing-strategy
updated_at: 2026-07-15
---

# Shared Context Resource: Testing Strategy

## Purpose

Define the verification layers required for a full-profile lifecycle,
persistence, security, and provider-session change.

## Summary

Tasks use focused RED/GREEN tests. Persistence and integration tests use real
in-memory or temporary-file SQLite, not repository mocks alone. Reviews block
on P1/P2. Epic validation adds the approved full test suite and a real daemon
terminal smoke round trip.

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
- `gpt-5.6-sol` review with high reasoning before every commit; no unresolved Critical/High/Medium or
  P1/P2 findings.

## Epic Validation

- All focused task checks and integration suites pass on the reconciled epic
  branch.
- `npm run build` and `npm run lint` pass or advisory lint limitations are
  recorded.
- `npm test` runs only with user approval because the repository marks it slow.
- `$run-talon-smoke` proves daemon boot, SQLite migrations, terminal IPC, queue,
  provider runtime, and response delivery; no listeners remain afterward.
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
