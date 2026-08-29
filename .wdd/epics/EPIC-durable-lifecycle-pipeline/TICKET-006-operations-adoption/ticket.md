---
id: TICKET-006-operations-adoption
kind: ticket
epic: EPIC-durable-lifecycle-pipeline
slug: TICKET-006-operations-adoption
title: Operator Controls, Verification, and Adoption
status: planned
task_count: 3
depends_on: []
conflict_domains:
  - "src/cli/**"
  - "src/ipc/**"
  - "tests/integration/**"
  - "README.md"
  - "AGENTS.md"
  - "config/talond.example.yaml"
  - ".agents/skills/**"
adapter_links:
  github_issue: https://github.com/ivo-toby/talon/issues/256
---

# Operator Controls, Verification, and Adoption

## Summary

Expose safe operator controls, prove the full system, and synchronize docs/examples/skills.

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
| TASK-016-lifecycle-operator-cli | todo | WAVE-008 | Expose effective handlers, delivery/backlog/health state, exact replay, disablement, and behavior-candidate provenance through protected typed IPC and talonctl commands. |
| TASK-019-lifecycle-end-to-end-verification | todo | WAVE-010 | Prove inbound-to-outbound async analysis, context rotation, restart/replay, retention, isolation, interceptors, governed behavior promotion, e2e coverage, and Sprites event-pipeline validation across real SQLite and daemon boundaries. |
| TASK-020-lifecycle-documentation-adoption | todo | WAVE-011 | Synchronize README, architecture self-doc, config/starter examples, AGENTS, default sub-agent docs, and affected setup/profile/personality/schedule/smoke skills with the verified implementation. |

## Dependencies

- Task-level prerequisites are authoritative in wave-plan.md and orchestration.json.

## Conflict Domains

- src/cli/**
- src/ipc/**
- tests/integration/**
- README.md
- AGENTS.md
- config/talond.example.yaml
- .agents/skills/**

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
