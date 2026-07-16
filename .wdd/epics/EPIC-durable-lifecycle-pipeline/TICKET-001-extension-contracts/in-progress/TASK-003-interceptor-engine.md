---
id: TASK-003-interceptor-engine
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-001-extension-contracts
wave: WAVE-002
slug: interceptor-engine
title: Implement bounded synchronous interceptor execution
status: in_progress
depends_on: ["TASK-001-lifecycle-contracts-registry"]
conflict_domains:
  - "src/lifecycle/interceptors/**"
  - "src/lifecycle/contracts/interceptor-contract.ts"
  - "src/core/logging/audit-logger.ts"
assigned_model_class: codexHigh
actual_model: gpt-5.6-terra
reasoning_effort: high
review_model_class: reviewGate
branch: task/TASK-003-interceptor-engine
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-002-interceptor-engine
worktree_status: active
worker_thread_id: 019f6850-67ee-70c3-971f-8580236dfc04
pr: null
current_gate: no_pr
branch_freshness: current_at_d153e17_at_dispatch
verification:
  - "npx vitest run tests/unit/lifecycle/interceptor-engine.test.ts tests/unit/core/logging/audit-logger.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-003-interceptor-engine: Implement bounded synchronous interceptor execution

## Status

in_progress

## Parent Ticket

TICKET-001-extension-contracts

## Wave

WAVE-002

## Objective

Implement deterministic allow, deny, approval, and transform composition with strict handler/total budgets, explicit failure policy, recursion protection, and redacted audit evidence.

## Scope

- Execute by stable priority and compose transforms.
- Enforce time budgets and typed fail-open/fail-closed behavior.
- Audit handler identity, decision, reason, duration, and bounded transform metadata.
- Ship deterministic native example handlers.
- Reject root and nested proxy-valued interceptor JSON before any reflection,
  including object and array proxies, and prove validation executes zero traps.

## Non-Scope

No boundary wiring and no model-backed security boundary.

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

- src/lifecycle/interceptors/**
- src/lifecycle/contracts/interceptor-contract.ts
- src/core/logging/audit-logger.ts
- tests/unit/lifecycle/interceptor-engine.test.ts

## Dependencies

- TASK-001-lifecycle-contracts-registry

## Conflict Domains

- src/lifecycle/interceptors/**
- src/lifecycle/contracts/interceptor-contract.ts
- src/core/logging/audit-logger.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-003-interceptor-engine

## Worker Worktree

`/Users/ivo.toby/workspace/talon/.worktrees/WAVE-002-interceptor-engine` is
active on `task/TASK-003-interceptor-engine` from reviewed and pushed readiness
commit `d153e17` under Terra/high worker
`019f6850-67ee-70c3-971f-8580236dfc04`.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for order, composition, short-circuit, approval, timeouts, errors,
failure policy, recursion, audit redaction, and root/nested object/array proxy
rejection with zero trap execution.

### GREEN

Implement an injected in-process executor over registry-resolved handlers.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Preserve unrelated user changes and use typed neverthrow results across module boundaries.
- Audit side effects and keep durable payloads bounded and secret-free.
- Treat the TASK-001 carried Low as part of this task: call `types.isProxy()`
  before `Array.isArray`, prototype lookup, own-key enumeration, or descriptor
  inspection for every bounded interceptor JSON container.
- Request reviewGate/`gpt-5.6-sol` review with high reasoning before commit; resolve all P1/P2 or Critical/High/Medium findings.

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

- npx vitest run tests/unit/lifecycle/interceptor-engine.test.ts tests/unit/core/logging/audit-logger.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Not run yet.

## Review Feedback

### P1

- None.

### P2

- None.

### P3

- None.

## Completion Notes

- None yet.
