---
id: EPIC-durable-lifecycle-pipeline-SHARED-CONTEXT
kind: shared_context_index
epic: EPIC-durable-lifecycle-pipeline
updated_at: 2026-07-25
---

# Shared Context: EPIC-durable-lifecycle-pipeline

## Overview

Issue #256 introduces a full-profile, cross-module lifecycle architecture.
Workers must preserve native ownership of policy and state, isolate async
delivery from user-facing work, and treat pluggable reasoning as untrusted.

## Resource Index

| Resource | Summary | Read When |
|----------|---------|-----------|
| `resources/architecture.md` | Current and target boundaries, invariants, and integration map | Touching lifecycle contracts, daemon flow, persistence, handlers, or context rotation |
| `resources/design-decisions.md` | Resolved issue questions and initial implementation defaults | Planning or changing config, retention, handler identity, promotion, or deletion behavior |
| `resources/testing-strategy.md` | Risk-based verification layers and required gates | Writing task verification or running reviews/validation |
| `resources/task-findings.md` | Reconciled discoveries from workers | Planning or starting later waves |

## Key Decisions

- Full WDD profile with risk-based review and adaptive monitoring.
- Native orchestration and projection; optional pluggable reasoning.
- Global handler definitions with explicit persona subscriptions.
- Independent durable dispatcher with at-least-once delivery.
- High-priority ordered context projection blocks only the next ordinary item
  for that thread.
- Configurable audit-window compaction; no permanent full event history.

## Key Warnings

- Do not emit durable events after a state transition if the event can be
  written atomically with it.
- Do not place transcripts, secrets, or complete tool payloads in event rows.
- Do not reuse handler display names as unstable idempotency identities.
- Do not let model-backed handlers mutate repositories directly.
- Do not treat configured handler declarations as runtime authority; native and
  sub-agent handlers must exactly match bootstrap- or loader-owned capability
  catalogs materialized into canonical snapshots.
- Reject proxy/accessor/callable-proxy paths before reflection or invocation at
  lifecycle trust boundaries.
- Do not remediate Low/P3 review findings automatically. Route only
  Critical/High/Medium blockers, use focused delta re-review while fixing them,
  and require one final full-diff GPT-5.5/xhigh review immediately before commit.
- Do not break continuation, rotation-boundary, or observational-memory reducer
  semantics while removing name-based special cases.

## Known Constraints

- Preserve existing configs through explicit compatibility translation and
  deprecation.
- Follow `neverthrow`, audit logging, RED/GREEN TDD, `gpt-5.5`/xhigh pre-commit review,
  task PR, documentation, and runtime-smoke requirements.
- Issue #70 is an optional evidence dependency, not a core-pipeline blocker.

## Recent Durable Memory

- No directly relevant durable Postgram memory was found; live repository and
  issue state are the source of truth.

## Reconciled Waves

- WAVE-001 / TASK-001 merged in PR #257. See `resources/task-findings.md` for
  the frozen contract, authority, causality, compatibility, and follow-up rules.
- WAVE-002 / TASK-002, TASK-003, and TASK-004 merged in PRs #260, #258, and
  #259 at epic head `54dc872`. See `resources/task-findings.md` for persistence,
  interceptor, sub-agent, contract-domain, and review-throughput rules.
- WAVE-003 / TASK-005 and TASK-006 merged in PRs #261 and #262 at epic head
  `8f74740`. See `resources/task-findings.md` for transactional publication,
  dispatcher authority, timeout/concurrency, forward-migration, and daemon
  supervision rules.
- WAVE-004 / TASK-007 merged in PR #263 at epic head `67e93ac`. See
  `resources/task-findings.md` for daemon-owned lifecycle wiring, atomic inbound
  publication, database-owned queue scope, scheduler generation/drain, durable
  signal handoff migrations, and restart-required reload rules.
- WAVE-005 / TASK-008, TASK-009, and TASK-010 merged in PRs #268, #266, and
  #267 at epic head `6921a9e`. See `resources/task-findings.md` for
  run/tool/outbound lifecycle events, before-execute/send interception,
  outbound idempotency, context observer/reducer contracts, native context
  projection, behavior-ledger migration 018, and the remaining non-blocking
  TASK-009 P3 tombstone-visibility follow-up.
