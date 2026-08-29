---
id: TICKET-001-extension-contracts
kind: ticket
epic: EPIC-durable-lifecycle-pipeline
slug: TICKET-001-extension-contracts
title: Lifecycle Extension Contracts and Adapters
status: done
task_count: 3
depends_on: []
conflict_domains:
  - "src/lifecycle/contracts/**"
  - "src/lifecycle/interceptors/**"
  - "src/lifecycle/adapters/**"
  - "src/core/config/config-schema.ts"
adapter_links:
  github_issue: https://github.com/ivo-toby/talon/issues/256
---

# Lifecycle Extension Contracts and Adapters

## Summary

Define the typed, validated, default-deny extension surface and its native/sub-agent adapters.

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
| TASK-001-lifecycle-contracts-registry | done | WAVE-001 | Create versioned event, signal, interceptor, handler, subscription, identity, filter, budget, and failure-policy contracts plus deterministic registry/config validation. |
| TASK-003-interceptor-engine | done | WAVE-002 | Implement deterministic allow, deny, approval, and transform composition with strict handler/total budgets, explicit failure policy, recursion protection, and redacted audit evidence. |
| TASK-004-subagent-lifecycle-adapter | done | WAVE-002 | Invoke only configured sub-agents with fenced untrusted input, persona/capability scope, timeout/token/model bounds, named output contracts, and typed signals/errors. |

## Dependencies

- Task-level prerequisites are authoritative in wave-plan.md and orchestration.json.

## Conflict Domains

- src/lifecycle/contracts/**
- src/lifecycle/interceptors/**
- src/lifecycle/adapters/**
- src/core/config/config-schema.ts

## Validation Expectations

- Complete every child task or explicitly cancel it.
- Reconcile focused verification, required review, freshness, and shared findings.

## Review Focus

- Native policy/projection versus pluggable reasoning boundaries.
- Persistence, scope, privacy, idempotency, ordering, failure, and compatibility risks.

## Completion Criteria

- [x] All child task review and verification gates are resolved.
- [x] Shared-context updates are reconciled.
- [x] Ticket status matches child task state.
