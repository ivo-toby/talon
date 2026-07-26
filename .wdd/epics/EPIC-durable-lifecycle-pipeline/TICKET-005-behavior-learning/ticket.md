---
id: TICKET-005-behavior-learning
kind: ticket
epic: EPIC-durable-lifecycle-pipeline
slug: TICKET-005-behavior-learning
title: Behavior Feedback and Governed Self-Improvement
status: in_progress
task_count: 5
depends_on: []
conflict_domains:
  - "src/core/database/migrations/**"
  - "src/lifecycle/behavior/**"
  - "src/subagents/default/behavior-*/**"
  - "src/personas/**"
  - "src/daemon/reload.ts"
adapter_links:
  github_issue: https://github.com/ivo-toby/talon/issues/256
---

# Behavior Feedback and Governed Self-Improvement

## Summary

Detect/deduplicate persona feedback, reduce evidence, and apply only governed, evaluated, reversible improvements.

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
| TASK-010-behavior-ledger-persistence | done | WAVE-005 | Add dedicated behavior signal/evidence/evaluation/promotion/activation/rollback storage with provenance, evidence fingerprints, persona scope, and guarded transitions. |
| TASK-012-feedback-detector-subagent | done | WAVE-006 | Add an optional built-in behavior detector implementing talon.behavior.signal.v1 for explicit correction, positive feedback, inferred pattern, missed action, noise, and tool failure. |
| TASK-015-behavior-signal-projector | done | WAVE-007 | Project validated signals into the persona ledger with provenance, deterministic source fingerprints, schedule/direct copy suppression, distinct-source thresholds, scope enforcement, and notes-only behavior. |
| TASK-017-behavior-review-reducers | todo | WAVE-008 | Add typed optional daily/weekly review sub-agents and native bounded evidence orchestration that groups independent signals, rejects duplicates/conflicts, and records notes-only proposals. |
| TASK-018-governed-prompt-promotion | todo | WAVE-009 | Apply accepted behavior proposals through native structured patching with default approval, pre-authorized narrow policy, evaluation, atomic write, verified reload, activation evidence, and rollback. |

## Dependencies

- Task-level prerequisites are authoritative in wave-plan.md and orchestration.json.

## Conflict Domains

- src/core/database/migrations/**
- src/lifecycle/behavior/**
- src/subagents/default/behavior-*/**
- src/personas/**
- src/daemon/reload.ts

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
