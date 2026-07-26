---
id: TASK-017-behavior-review-reducers
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-005-behavior-learning
wave: WAVE-008
slug: behavior-review-reducers
title: Add daily and weekly behavior review reducers
status: in-progress
depends_on: ["TASK-013-handler-telemetry-correlation", "TASK-015-behavior-signal-projector"]
conflict_domains:
  - "src/lifecycle/behavior/behavior-review-service.ts"
  - "src/subagents/default/behavior-*-reviewer/**"
  - "src/scheduler/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-017-behavior-review-reducers
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-008-behavior-review-reducers
worktree_status: allocated_pending_creation
pr: null
current_gate: activation_checkpoint_review_pending
branch_freshness: pending_activation_checkpoint
verification:
  - "npx vitest run tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/subagents"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-017-behavior-review-reducers: Add daily and weekly behavior review reducers

## Status

in-progress

## Parent Ticket

TICKET-005-behavior-learning

## Wave

WAVE-008

## Objective

Add typed optional daily/weekly review sub-agents and native bounded evidence orchestration that groups independent signals, rejects duplicates/conflicts, and records notes-only proposals.

## Scope

- Define review/reducer contracts.
- Add default daily and weekly reviewer manifests/prompts/schemas.
- Trigger notes-only reductions from configured schedules.
- Enforce bounded evidence, conflicts/redundancy, source thresholds, and expiry.
- Use optional trace evidence only when available.

## Non-Scope

No prompt activation, approval decision, or rollback.

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

- src/lifecycle/behavior/review-contracts.ts
- src/lifecycle/behavior/behavior-review-service.ts
- src/subagents/default/behavior-daily-reviewer/**
- src/subagents/default/behavior-weekly-reviewer/**
- src/scheduler/**
- tests/unit/lifecycle/behavior-review-service.test.ts

## Dependencies

- TASK-013-handler-telemetry-correlation
- TASK-015-behavior-signal-projector

## Conflict Domains

- src/lifecycle/behavior/behavior-review-service.ts
- src/subagents/default/behavior-*-reviewer/**
- src/scheduler/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-017-behavior-review-reducers

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-008-behavior-review-reducers

Allocated by the controller during WAVE-008 activation. Do not create or use
this worktree until the activation checkpoint is reviewed by GPT-5.5/xhigh,
committed, pushed, recorded as the exact activation checkpoint, and activation
sync plus readiness gates have passed.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for evidence bounds, grouping, duplicates, conflicts, thresholds, expiry, unavailable traces, schedule provenance, notes-only output, and schema errors.

### GREEN

Implement contracts, default reviewers, and native proposal orchestration.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Do not begin implementation until the controller confirms the reviewed
  readiness commit has been pushed, fast-forwarded into this branch/worktree,
  and verified clean with current WDD state.
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

- [ ] Objective and scoped behavior are complete.
- [ ] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [ ] Required review has no unresolved P1/P2 findings.
- [ ] PR targets the epic branch and freshness is checked.
- [ ] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/subagents
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
