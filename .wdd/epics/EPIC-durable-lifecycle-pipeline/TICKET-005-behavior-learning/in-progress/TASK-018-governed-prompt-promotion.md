---
id: TASK-018-governed-prompt-promotion
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-005-behavior-learning
wave: WAVE-009
slug: governed-prompt-promotion
title: Implement governed prompt promotion, evaluation, reload, and rollback
status: in-progress
depends_on: ["TASK-016-lifecycle-operator-cli", "TASK-017-behavior-review-reducers"]
conflict_domains:
  - "src/lifecycle/behavior/**"
  - "src/personas/**"
  - "src/daemon/reload.ts"
  - "src/cli/commands/lifecycle*.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-018-governed-prompt-promotion
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-009-governed-prompt-promotion
worktree_status: created_clean_pending_readiness
pr: null
current_gate: worktree_readiness_review_pending
branch_freshness: current_at_activation_sync_d1a5152
verification:
  - "npx vitest run tests/unit/lifecycle/prompt-improvement-projector.test.ts tests/integration/lifecycle-prompt-promotion.test.ts tests/unit/daemon/reload.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-018-governed-prompt-promotion: Implement governed prompt promotion, evaluation, reload, and rollback

## Status

in-progress

## Parent Ticket

TICKET-005-behavior-learning

## Wave

WAVE-009

## Objective

Apply accepted behavior proposals through native structured patching with default approval, pre-authorized narrow policy, evaluation, atomic write, verified reload, activation evidence, and rollback.

## Scope

- Resolve prompt ownership and validate structured patches.
- Default to approval; allow only explicit narrow auto-policy.
- Run/record bounded evaluations.
- Perform atomic versioned writes and verify reload.
- Record provenance and rollback on any failure.
- Require approval for security/capability/integration/notification increases.

## Non-Scope

No arbitrary sub-agent file writes or generic code self-modification.

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

- src/lifecycle/behavior/prompt-improvement-projector.ts
- src/lifecycle/behavior/promotion-policy.ts
- src/lifecycle/behavior/prompt-evaluator.ts
- src/personas/**
- src/daemon/reload.ts
- src/cli/commands/lifecycle*.ts
- tests/unit/lifecycle/prompt-improvement-projector.test.ts
- tests/integration/lifecycle-prompt-promotion.test.ts

## Dependencies

- TASK-016-lifecycle-operator-cli
- TASK-017-behavior-review-reducers

## Conflict Domains

- src/lifecycle/behavior/**
- src/personas/**
- src/daemon/reload.ts
- src/cli/commands/lifecycle*.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-018-governed-prompt-promotion

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-009-governed-prompt-promotion

Allocated by the controller for WAVE-009 bundled execution. Branch/worktree
creation remains blocked until the activation checkpoint passes GPT-5.5/xhigh
review, is committed/pushed to the epic branch, the activation-sync checkpoint
passes GPT-5.5/xhigh review and is committed/pushed, and the worktree-readiness
checkpoint passes GPT-5.5/xhigh review and is committed/pushed.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for approval, narrow auto-policy, forbidden changes, conflicts, evaluation, atomic write, reload, provenance, failure rollback, explicit rollback, and audit.

### GREEN

Implement the native promotion pipeline with injected filesystem/reload/evaluator dependencies.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Implementation may not start until the controller confirms the reviewed
  readiness commit is pushed on the epic branch, fast-forwarded into this
  branch/worktree, and verified clean with current WDD state.
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

- npx vitest run tests/unit/lifecycle/prompt-improvement-projector.test.ts tests/integration/lifecycle-prompt-promotion.test.ts tests/unit/daemon/reload.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Activation checkpoint review `019f9d13-d0be-7d90-84ef-b4a9e96e23d3` passed
  0C/0H/0M/0L. Reviewed activation checkpoint
  `25fb028bfec71dd1ca86db38e9726822932a96bf` was committed and pushed.
- Activation-sync review `019f9d19-d543-7a52-ab93-09d31ff743f4` passed
  0C/0H/0M/0L. Reviewed sync marker
  `d1a5152fb9e4f4c1ef8449e9c1a622d3b48a6f4d` was committed and pushed.
  TASK-018 branch/worktree were created and pushed from that exact commit, and
  the worktree is clean with current task, orchestration, and controller
  artifacts present. Worktree-readiness review is pending before dispatch.
- Worktree-readiness review attempt `019f9d20-b7c0-7d53-8526-1ba021c57451`
  exited before verdict with a Codex usage-limit error. The user reported quota
  reset, so readiness review is pending again; readiness commit and worker
  dispatch remain blocked until a valid GPT-5.5/xhigh readiness review passes
  with 0C/0H/0M.

## Review Feedback

### P1

- None.

### P2

- None.

### P3

- None.

## Completion Notes

- None yet.
