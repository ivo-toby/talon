---
id: TASK-013-handler-telemetry-correlation
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-003-core-boundary-integration
wave: WAVE-006
slug: handler-telemetry-correlation
title: Add lifecycle audit, metrics, and Langfuse correlation
status: done
depends_on: ["TASK-006-durable-event-dispatcher", "TASK-008-run-tool-outbound-events"]
conflict_domains:
  - "src/observability/**"
  - "src/core/logging/audit-logger.ts"
  - "src/lifecycle/telemetry/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-013-handler-telemetry-correlation
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-006-handler-telemetry-correlation
worktree_status: cleaned_up
pr: https://github.com/ivo-toby/talon/pull/270
current_gate: merged
branch_freshness: merged_into_epic_at_3e09c376f21fdc5697c673def4ec99eb10dd0291
verification:
  - "npx vitest run tests/unit/observability tests/unit/lifecycle/telemetry.test.ts tests/unit/core/logging/audit-logger.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-013-handler-telemetry-correlation: Add lifecycle audit, metrics, and Langfuse correlation

## Status

done

## Parent Ticket

TICKET-003-core-boundary-integration

## Wave

WAVE-006

## Objective

Instrument publication/interceptor/handler/delivery behavior with bounded audit, metrics, and existing Langfuse observations plus an optional issue-70 trace-evidence seam.

## Scope

- Record success/failure/retry/dead-letter/lag/latency/token/cost/timeout/circuit metrics.
- Create correlated Langfuse observations.
- Audit decisions, replay, disablement, projections, and promotions with redaction.
- Define optional bounded TraceEvidenceProvider and no-op implementation.

## Non-Scope

No issue-70 trace querying, dashboard, CLI, or full-trace persistence.

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

- src/observability/**
- src/core/logging/audit-logger.ts
- src/lifecycle/telemetry/**
- src/lifecycle/trace-evidence-provider.ts
- tests/unit/observability/**
- tests/unit/lifecycle/telemetry.test.ts

## Dependencies

- TASK-006-durable-event-dispatcher
- TASK-008-run-tool-outbound-events

## Conflict Domains

- src/observability/**
- src/core/logging/audit-logger.ts
- src/lifecycle/telemetry/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-013-handler-telemetry-correlation

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-006-handler-telemetry-correlation

Allocated by the controller for WAVE-006. Do not create or use this worktree
until the reviewed activation checkpoint has been committed and pushed.

## PR / Patch Reference

PR #270: https://github.com/ivo-toby/talon/pull/270

Merged into `epic/durable-lifecycle-pipeline` at `3e09c376f21fdc5697c673def4ec99eb10dd0291` on 2026-07-26.

## RED-GREEN TDD Plan

### RED

Failing tests for bounded metrics/labels, audit redaction, correlation/traceparent, costs, noop behavior, and unavailable evidence provider.

### GREEN

Extend existing observability/audit interfaces and instrument lifecycle execution.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Preserve unrelated user changes and use typed neverthrow results across module boundaries.
- Audit side effects and keep durable payloads bounded and secret-free.
- Request reviewGate/`gpt-5.5` review with xhigh reasoning before commit; resolve all P1/P2 or Critical/High/Medium findings. Never use GPT-5.6.

## Review Focus

- Correctness and regressions at the listed conflict domains.
- Security/scope/privacy/idempotency/ordering/failure semantics relevant to the task.
- RED/GREEN evidence and contract/config/documentation drift.

## Durable Memory Notes To Consider

- Propose only stable decisions, root causes, constraints, or verified outcomes for task-findings.md.

## Task-Level Definition of Done

- [x] Objective and scoped behavior are complete.
- [x] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [x] Required review has no unresolved P1/P2 findings.
- [x] PR targets the epic branch and freshness is checked.
- [x] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/observability tests/unit/lifecycle/telemetry.test.ts tests/unit/core/logging/audit-logger.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/observability tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/core/logging/audit-logger.test.ts` passed: 7 files, 141 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/observability tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/core/logging/audit-logger.test.ts --reporter=dot` passed after review remediation: 8 files, 160 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/observability tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/core/logging/audit-logger.test.ts --reporter=dot` passed after metrics/docs remediation: 8 files, 161 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed.
- 2026-07-26: `git diff --check` passed.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/logging/audit-logger.ts src/daemon/daemon-bootstrap.ts src/lifecycle/handler-executor.ts src/lifecycle/interceptors/interceptor-engine.ts src/lifecycle/lifecycle-dispatcher.ts src/lifecycle/lifecycle-event-bus.ts src/lifecycle/telemetry/index.ts src/lifecycle/trace-evidence-provider.ts src/observability/langfuse/traceparent.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts` passed with 0 errors; existing `daemon-bootstrap.ts` missing-return-type warnings and test-file ignore warnings remain.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint` still fails on unrelated pre-existing files outside this task's ownership, including WhatsApp Baileys, CLI command files, `daemon/context-assembler.ts`, provider agent-cli files, default subagent files, and `tools/host-tools/persona-list.ts`. Task-owned source files have no lint errors under the scoped ESLint command above.
- 2026-07-26: REVIEW BLOCKER: reviewGate/gpt-5.5 xhigh reported 0C/0H/2M/0L. Medium findings: lifecycle sub-agent traceparent was not forwarded by daemon bootstrap, and Langfuse/lifecycle telemetry docs had drifted.
- 2026-07-26: REMEDIATION READY FOR REVIEW: daemon bootstrap now forwards defined handler traceparents into lifecycle sub-agent invocation, the adapter focused test asserts runner context receives the traceparent, and README/AGENTS document lifecycle Langfuse/audit/trace-evidence behavior.
- 2026-07-26: BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/2M/0L. Medium findings: production bootstrap used the no-op lifecycle metrics recorder, and README/AGENTS overstated Langfuse coverage for interceptor/retry/signal-handoff paths.
- 2026-07-26: REMEDIATION READY FOR REVIEW: daemon bootstrap now wires a logger-backed lifecycle metrics recorder, lifecycle telemetry tests cover structured metric samples, and README/AGENTS now state that Langfuse spans are created for publication/handler delivery while interceptor/retry/signal handoff are audit/metric evidence.
- 2026-07-26: BLOCKER REVIEW: reviewGate/gpt-5.5 xhigh stream identified a follow-on Medium in publication timing: lifecycle publication success telemetry was emitted before the encompassing durable transaction could still roll back.
- 2026-07-26: REMEDIATION READY FOR REVIEW: publication success telemetry is now registered through the event-bus after-commit callback path; rolled-back transactions clear the callback and emit no false success metric/audit/observation. Event-bus regression coverage asserts this boundary.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/observability --reporter=dot` passed after after-commit telemetry remediation: 9 files, 179 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed after after-commit telemetry remediation.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/logging/audit-logger.ts src/daemon/daemon-bootstrap.ts src/lifecycle/handler-executor.ts src/lifecycle/interceptors/interceptor-engine.ts src/lifecycle/lifecycle-dispatcher.ts src/lifecycle/lifecycle-event-bus.ts src/lifecycle/telemetry/index.ts src/lifecycle/trace-evidence-provider.ts src/observability/langfuse/traceparent.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts` passed with 0 errors; existing `daemon-bootstrap.ts` explicit-return-type warnings and test-file ignore warnings remain.
- 2026-07-26: `git diff --check origin/epic/durable-lifecycle-pipeline` passed after after-commit telemetry remediation.
- 2026-07-26: BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/2M/0L. Medium findings: publication success latency started inside the after-commit callback, producing near-zero callback latency, and README still overstated lifecycle Langfuse nesting.
- 2026-07-26: REMEDIATION READY FOR REVIEW: event-bus publication timing now starts before handler resolution and durable fanout, success telemetry is still deferred to after commit, rollback paths close with failure telemetry rather than success, and README now describes lifecycle observations as parent-linked only when valid trace context exists.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/observability --reporter=dot` passed after durable-latency remediation: 9 files, 179 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed after durable-latency remediation.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/logging/audit-logger.ts src/daemon/daemon-bootstrap.ts src/lifecycle/handler-executor.ts src/lifecycle/interceptors/interceptor-engine.ts src/lifecycle/lifecycle-dispatcher.ts src/lifecycle/lifecycle-event-bus.ts src/lifecycle/telemetry/index.ts src/lifecycle/trace-evidence-provider.ts src/observability/langfuse/traceparent.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts` passed after durable-latency remediation with 0 errors; existing `daemon-bootstrap.ts` explicit-return-type warnings and test-file ignore warnings remain.
- 2026-07-26: `git diff --check origin/epic/durable-lifecycle-pipeline` passed after durable-latency remediation.
- 2026-07-26: BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/2M/0L. Medium findings: production behavior promotion mutations lacked bounded lifecycle audit/metric evidence, and trace-evidence normalization trusted `ff-...` traceparent values that are invalid by W3C trace-context rules.
- 2026-07-26: REMEDIATION READY FOR REVIEW: behavior promotion repository mutations now emit bounded audit/metric evidence through optional sinks wired by daemon bootstrap into the production repository bundle, and traceparent parsing now rejects `ff` versions with direct and trace-evidence regression coverage.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/observability/langfuse/traceparent.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/observability tests/unit/daemon/daemon-bootstrap.test.ts --reporter=dot` passed after promotion/traceparent remediation: 11 files, 223 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed after promotion/traceparent remediation.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/database/repositories/behavior-signal-repository.ts src/core/database/repositories/index.ts src/core/logging/audit-logger.ts src/daemon/daemon-bootstrap.ts src/daemon/daemon-context.ts src/lifecycle/handler-executor.ts src/lifecycle/interceptors/interceptor-engine.ts src/lifecycle/lifecycle-dispatcher.ts src/lifecycle/lifecycle-event-bus.ts src/lifecycle/telemetry/index.ts src/lifecycle/trace-evidence-provider.ts src/observability/langfuse/traceparent.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/observability/langfuse/traceparent.test.ts` passed after promotion/traceparent remediation with 0 errors; existing explicit-return-type and ignored-test warnings remain.
- 2026-07-26: `git diff --check origin/epic/durable-lifecycle-pipeline` passed after promotion/traceparent remediation.
- 2026-07-26: BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/1M/0L. Medium finding: signal handoff had no bounded audit/metric evidence of its own, and a successful handoff followed by lost completion produced no delivery-lost telemetry.
- 2026-07-26: REMEDIATION READY FOR REVIEW: dispatcher now emits bounded signal-handoff success/failure telemetry without payloads, and records delivery status `lost` when completion fails after a successful handoff so the crash/lease-loss seam remains observable.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/observability/langfuse/traceparent.test.ts tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/observability tests/unit/daemon/daemon-bootstrap.test.ts --reporter=dot` passed after signal-handoff telemetry remediation: 11 files, 225 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed after signal-handoff telemetry remediation.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/database/repositories/behavior-signal-repository.ts src/core/database/repositories/index.ts src/core/logging/audit-logger.ts src/daemon/daemon-bootstrap.ts src/daemon/daemon-context.ts src/lifecycle/handler-executor.ts src/lifecycle/interceptors/interceptor-engine.ts src/lifecycle/lifecycle-dispatcher.ts src/lifecycle/lifecycle-event-bus.ts src/lifecycle/telemetry/index.ts src/lifecycle/trace-evidence-provider.ts src/observability/langfuse/traceparent.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/observability/langfuse/traceparent.test.ts` passed after signal-handoff telemetry remediation with 0 errors; existing explicit-return-type and ignored-test warnings remain.
- 2026-07-26: `git diff --check origin/epic/durable-lifecycle-pipeline` passed after signal-handoff telemetry remediation.
- 2026-07-26: BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/2M/0L. Medium findings: lost delivery completion status was collapsed to generic failure evidence, and real lifecycle delivery replay/reopen mutations lacked bounded audit/metric evidence.
- 2026-07-26: REMEDIATION READY FOR REVIEW: delivery failure telemetry now preserves `status: lost` as a distinct emitted outcome/status in metrics, audit, and observation metadata; lifecycle delivery reopen now emits bounded replay audit/metric evidence through optional repository sinks wired by daemon bootstrap.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/core/database/repositories/lifecycle-event-repository.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/observability/langfuse/traceparent.test.ts tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/observability tests/unit/daemon/daemon-bootstrap.test.ts --reporter=dot` passed after replay/lost-status remediation: 12 files, 257 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed after replay/lost-status remediation.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/database/repositories/behavior-signal-repository.ts src/core/database/repositories/lifecycle-delivery-repository.ts src/core/database/repositories/index.ts src/core/logging/audit-logger.ts src/daemon/daemon-bootstrap.ts src/daemon/daemon-context.ts src/lifecycle/handler-executor.ts src/lifecycle/interceptors/interceptor-engine.ts src/lifecycle/lifecycle-dispatcher.ts src/lifecycle/lifecycle-event-bus.ts src/lifecycle/telemetry/index.ts src/lifecycle/trace-evidence-provider.ts src/observability/langfuse/traceparent.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts tests/unit/core/logging/audit-logger.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/lifecycle/lifecycle-event-bus.test.ts tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/lifecycle/telemetry.test.ts tests/unit/observability/langfuse/traceparent.test.ts` passed after replay/lost-status remediation with 0 errors; existing explicit-return-type and ignored-test warnings remain.
- 2026-07-26: `git diff --check origin/epic/durable-lifecycle-pipeline` passed after replay/lost-status remediation.
- 2026-07-26: MERGED: PR #270 merged into `epic/durable-lifecycle-pipeline` at `3e09c376f21fdc5697c673def4ec99eb10dd0291` after GitHub PR Agent and Verify PR checks passed.
- 2026-07-26: WAVE-006 INTEGRATED VERIFICATION: after PR #271, #270, and #269 merged, the epic branch passed the combined Wave 6 targeted suite: 19 files / 647 tests, `npm run build`, scoped ESLint with 0 errors and known warnings only, and `git diff --check`.

## Review Feedback

### P1

- None.

### P2

- Fixed in remediation: lifecycle sub-agent handler invocation now forwards the dispatcher child traceparent when present.
- Fixed in remediation: README and AGENTS now document lifecycle Langfuse observations, bounded audit/metric evidence, and optional trace-evidence semantics. No setup/add skill covers Langfuse lifecycle telemetry, so no `.agents/skills` update was applicable.
- Fixed in remediation: production bootstrap now supplies a logger-backed lifecycle metrics recorder instead of falling back to the no-op recorder.
- Fixed in remediation: README and AGENTS now distinguish Langfuse observations from audit/metric-only lifecycle paths.
- Fixed in remediation: publication success telemetry now waits for the durable event transaction to commit; rolled-back publishes no longer create success evidence.
- Fixed in remediation: publication latency now measures the durable publication path instead of the after-commit callback body, while rollback paths avoid false success evidence.
- Fixed in remediation: README no longer promises lifecycle publication/handler work is always nested under agent-run traces; it documents parent-linking only when trace context is available.
- Fixed in remediation: behavior promotion create/transition/activate/rollback mutations now emit bounded audit and metric evidence through daemon-wired production sinks.
- Fixed in remediation: trace-evidence normalization now rejects invalid W3C `ff` traceparent versions via the shared traceparent parser.
- Fixed in remediation: signal handoff now emits bounded audit/metric evidence for success and failure, and completion loss after a successful handoff records delivery `lost` telemetry for crash/lease recovery visibility.
- Fixed in remediation: lost completion telemetry now keeps `lost` as a distinct emitted status/outcome rather than collapsing it to generic failure.
- Fixed in remediation: lifecycle delivery replay/reopen now emits bounded audit/metric evidence from the real repository mutation path, wired through production daemon bootstrap.

### P3

- None.

## Completion Notes

- Implemented lifecycle telemetry with a no-op test/default metrics sink plus a logger-backed production recorder, correlated Langfuse observations for publication and handler delivery, bounded audit records for lifecycle decisions/replay/disablement/projections/promotions, dispatcher delivery metrics for success/failure/retry/dead-letter/lag/latency/timeout/circuit-open, publication token/cost metrics, interceptor decision metrics, and a bounded optional TraceEvidenceProvider seam with no-op implementation.
- Publication success telemetry is tied to the event-bus after-commit boundary, so success evidence only appears for durable commits; publish failures still record bounded failure telemetry immediately.
- Wired one telemetry instance through daemon bootstrap into the lifecycle event bus, interceptor engine, and dispatcher. Handler executions now receive the dispatcher child traceparent when lifecycle telemetry can start an observation.
- Lifecycle sub-agent handlers now receive that traceparent too; the bootstrap wrapper omits the property when undefined to preserve adapter input hardening.
- Updated README and AGENTS documentation for lifecycle observability and trace-evidence behavior.
- No durable shared findings proposed; this added instrumentation seams and tests without changing lifecycle persistence or authority decisions.
