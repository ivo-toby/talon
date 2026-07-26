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
worktree_status: implementation_complete_uncommitted
pr: null
current_gate: implementation_complete_pending_review
branch_freshness: at_readiness_commit_c8057fa_with_uncommitted_task_changes
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

Created clean by the controller from reviewed activation-sync commit
`723b07444b53adc4dc310d036f30e998ff1b0f99` on branch
`task/TASK-017-behavior-review-reducers`, which is pushed to origin. Do not
begin implementation until the readiness checkpoint is reviewed by GPT-5.5/xhigh,
committed, pushed, fast-forwarded into this branch/worktree, and verified clean.

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

- RED check:
  `npx vitest run tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/subagents/behavior-reviewer.test.ts`
  failed before implementation because `src/lifecycle/behavior/behavior-review-service.ts`
  and `src/lifecycle/behavior/review-contracts.ts` did not exist.
- GREEN focused implementation check:
  `npx vitest run tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/subagents/behavior-reviewer.test.ts`
  passed, 6 tests / 2 files.
- Scheduler integration check:
  `npx vitest run tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/subagents/behavior-reviewer.test.ts tests/unit/scheduler/scheduler.test.ts`
  passed, 45 tests / 3 files.
- Task-relevant subagent/lifecycle/scheduler check:
  `npx vitest run tests/unit/subagents/behavior-reviewer.test.ts tests/unit/subagents/behavior-feedback-detector.test.ts tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/scheduler/scheduler.test.ts`
  passed, 57 tests / 4 files.
- Broader expected subagent-directory check:
  `npx vitest run tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/subagents tests/unit/scheduler/scheduler.test.ts`
  failed only in unrelated `tests/unit/subagents/file-searcher.test.ts`
  (`searchFiles (rg backend, real fs) > cascades to node backend when rg
  searches mocked paths`, expected 1 result, got 0). The same isolated file
  failed when rerun directly with the same assertion; TASK-017 files were not
  involved.
- `npm run build` passed after implementation and after bootstrap wiring.
- `npm run lint` was attempted and failed on existing unrelated repository
  lint errors outside TASK-017, including WhatsApp, CLI, context assembler,
  provider, file-searcher, session-observer, and host-tool files.
- Scoped lint passed:
  `npx eslint src/core/database/repositories/behavior-signal-repository.ts src/lifecycle/behavior/review-contracts.ts src/lifecycle/behavior/behavior-review-service.ts src/lifecycle/behavior/index.ts src/scheduler/scheduler.ts src/scheduler/schedule-types.ts src/subagents/default/behavior-daily-reviewer/index.ts src/subagents/default/behavior-weekly-reviewer/index.ts src/daemon/daemon-bootstrap.ts`
- `git diff --check` passed.
- GPT-5.5/xhigh remediation focused check:
  `npx vitest run tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/scheduler/scheduler.test.ts`
  passed, 64 tests / 3 files. Covered collecting-to-ready promotion,
  SQL-bounded review candidate/evidence reads with aggregate counts, and
  null-thread native behavior review schedules.
- GPT-5.5/xhigh remediation build check: `npm run build` passed.
- GPT-5.5/xhigh remediation scoped Prettier check:
  `npx prettier --check src/core/database/repositories/behavior-signal-repository.ts src/core/database/repositories/index.ts src/lifecycle/behavior/behavior-review-service.ts src/scheduler/scheduler.ts tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/scheduler/scheduler.test.ts`
  passed after formatting the touched service/repository test files.
- GPT-5.5/xhigh remediation scoped source lint:
  `npx eslint src/core/database/repositories/behavior-signal-repository.ts src/core/database/repositories/index.ts src/lifecycle/behavior/behavior-review-service.ts src/scheduler/scheduler.ts`
  passed.
- GPT-5.5/xhigh remediation `git diff --check` passed.

## Review Feedback

### P1

- None.

### P2

- None.

### P3

- Low/P3 follow-up intentionally left unresolved per worker scope: behavior
  review payload is not consumed by an external adapter/scheduler path beyond
  `data.lifecycleResult`.

## Completion Notes

- Implemented native daily/weekly behavior review reduction as notes-only
  proposed promotions using existing behavior ledger guards; no prompt
  activation, approval, or rollback behavior was added.
- Added bounded review output contracts, deterministic review promotion ids,
  duplicate/conflict/source-threshold/expiry handling, optional trace evidence
  metadata, and bounded audit evidence with `signalCount: 0`.
- Added default `behavior-daily-reviewer` and `behavior-weekly-reviewer`
  subagent manifests/prompts using `gpt-5.5`, no filesystem authority, and the
  existing lifecycle event-to-signal adapter contract.
- Wired configured scheduler payloads with `behaviorReview.cadence` to run the
  native review service and advance the schedule without enqueueing a
  user-facing agent task; normal schedules continue to use the existing queue
  path.
- Added repository read support for candidate-linked evidence. No migrations
  were required.
- README, `.agents` skills, and AGENTS adoption documentation are intentionally
  deferred to TASK-020; this task added the runtime primitive and tests only.
- Controller GPT-5.5/xhigh review, commit, push, and PR remain pending by
  protocol.
