---
id: TASK-001-lifecycle-contracts-registry
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-001-extension-contracts
wave: WAVE-001
slug: lifecycle-contracts-registry
title: Define lifecycle contracts, configuration, and handler registry
status: in_progress
depends_on: []
conflict_domains:
  - "src/lifecycle/contracts/**"
  - "src/lifecycle/handler-registry.ts"
  - "src/core/config/config-schema.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-001-lifecycle-contracts-registry
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-001-lifecycle-contracts-registry
worktree_status: pending_creation
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/lifecycle/handler-registry.test.ts tests/unit/core/config/config-schema.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-001-lifecycle-contracts-registry: Define lifecycle contracts, configuration, and handler registry

## Status

in_progress

## Parent Ticket

TICKET-001-extension-contracts

## Wave

WAVE-001

## Objective

Create versioned event, signal, interceptor, handler, subscription, identity, filter, budget, and failure-policy contracts plus deterministic registry/config validation.

## Scope

- Add lifecycle contract and registry modules.
- Add global handler definitions and explicit persona attachment to config validation.
- Reject duplicate IDs, incompatible contracts, unsafe policies, invalid filters, and missing handlers.
- Preserve configs with lifecycle omitted.

## Non-Scope

No persistence, dispatch, boundary wiring, remote handlers, or arbitrary filter expressions.

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

- src/lifecycle/contracts/**
- src/lifecycle/handler-registry.ts
- src/core/config/config-schema.ts
- src/personas/persona-loader.ts
- tests/unit/lifecycle/handler-registry.test.ts

## Dependencies

- None.

## Conflict Domains

- src/lifecycle/contracts/**
- src/lifecycle/handler-registry.ts
- src/core/config/config-schema.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-001-lifecycle-contracts-registry

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-001-lifecycle-contracts-registry (pending creation from the synced epic branch).

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing registry/config tests for priority, identity, explicit attachment, compatibility, validation, and legacy config acceptance.

### GREEN

Implement the smallest typed schemas and deterministic registry resolution API.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Preserve unrelated user changes and use typed neverthrow results across module boundaries.
- Audit side effects and keep durable payloads bounded and secret-free.
- Request reviewGate/GPT-5.4 review before commit; resolve all P1/P2 or Critical/High/Medium findings.

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

- npx vitest run tests/unit/lifecycle/handler-registry.test.ts tests/unit/core/config/config-schema.test.ts
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
