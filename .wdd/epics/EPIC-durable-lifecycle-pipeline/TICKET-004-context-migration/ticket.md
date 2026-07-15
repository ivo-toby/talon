---
id: TICKET-004-context-migration
kind: ticket
epic: EPIC-durable-lifecycle-pipeline
slug: TICKET-004-context-migration
title: Observational Memory Contract Migration
status: planned
task_count: 2
depends_on: []
conflict_domains:
  - "src/daemon/agent-runner.ts"
  - "src/daemon/context-roller.ts"
  - "src/daemon/daemon-bootstrap.ts"
  - "src/lifecycle/context/**"
adapter_links:
  github_issue: https://github.com/ivo-toby/talon/issues/256
---

# Observational Memory Contract Migration

## Summary

Move context reasoning behind typed contracts and a native projector while preserving session invariants.

## Objective

Complete the child tasks, reconcile durable findings, and preserve the epic native-policy/pluggable-reasoning split.

## Scope

- Included: all child outcomes below.
- Excluded: remote handlers, arbitrary filter expressions, and implementation of issue #70.

## Non-Scope

- Work owned by other tickets or excluded by the epic.

## Shared Context References

- ../shared-context/index.md
- ../shared-context/resources/architecture.md
- ../shared-context/resources/design-decisions.md
- ../shared-context/resources/testing-strategy.md

## Task Inventory

| Task | Status | Wave | Summary |
|------|--------|------|---------|
| TASK-009-context-contracts-projector | todo | WAVE-005 | Define talon.context.observer.v1 and reducer.v1 plus an idempotent native projector preserving observation, memory, pre-roll, reduction, continuation, boundary, and session invariants. |
| TASK-011-context-lifecycle-migration | todo | WAVE-006 | Route context thresholds through configured contracts/projector, remove observer/reflector name checks and auto-binding, and translate legacy summarizer config with clear deprecation. |

## Dependencies

- Task-level prerequisites are authoritative in wave-plan.md and orchestration.json.

## Conflict Domains

- src/daemon/agent-runner.ts
- src/daemon/context-roller.ts
- src/daemon/daemon-bootstrap.ts
- src/lifecycle/context/**

## Validation Expectations

- Complete every child task or explicitly cancel it.
- Reconcile focused verification, required review, freshness, and shared findings.

## Review Focus

- Native policy/projection versus pluggable reasoning boundaries.
- Persistence, scope, privacy, idempotency, ordering, failure, and compatibility risks.

## Completion Criteria

- [ ] All child task review and verification gates are resolved.
- [ ] Shared-context updates are reconciled.
- [ ] Ticket status matches child task state.
