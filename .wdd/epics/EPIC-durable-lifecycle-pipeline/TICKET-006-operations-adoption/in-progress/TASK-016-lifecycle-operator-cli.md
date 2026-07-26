---
id: TASK-016-lifecycle-operator-cli
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-006-operations-adoption
wave: WAVE-008
slug: lifecycle-operator-cli
title: Add lifecycle operator CLI, IPC, health, and backlog controls
status: in-progress
depends_on: ["TASK-014-lifecycle-retention-reload-replay", "TASK-015-behavior-signal-projector"]
conflict_domains:
  - "src/cli/index.ts"
  - "src/ipc/**"
  - "src/daemon/daemon.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-016-lifecycle-operator-cli
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-008-lifecycle-operator-cli
worktree_status: created_clean_pending_readiness_review
pr: null
current_gate: worktree_readiness_review_pending
branch_freshness: at_activation_sync_commit_pending_readiness
verification:
  - "npx vitest run tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-016-lifecycle-operator-cli: Add lifecycle operator CLI, IPC, health, and backlog controls

## Status

in-progress

## Parent Ticket

TICKET-006-operations-adoption

## Wave

WAVE-008

## Objective

Expose effective handlers, delivery/backlog/health state, exact replay, disablement, and behavior-candidate provenance through protected typed IPC and talonctl commands.

## Scope

- Add IPC contracts and daemon handlers.
- Add list/inspect/replay/disable/candidate commands.
- Surface bounded backlog, lag, circuit, and handler health.
- Audit mutations and enforce admin/capability protection.
- Test registration, formatting, failures, and bounded output.

## Non-Scope

No web UI, bulk replay, raw secrets, or direct SQLite CLI access.

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

- src/cli/index.ts
- src/cli/commands/lifecycle*.ts
- src/ipc/**
- src/daemon/daemon.ts
- tests/unit/cli/lifecycle-commands.test.ts
- tests/unit/ipc/**

## Dependencies

- TASK-014-lifecycle-retention-reload-replay
- TASK-015-behavior-signal-projector

## Conflict Domains

- src/cli/index.ts
- src/ipc/**
- src/daemon/daemon.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-016-lifecycle-operator-cli

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-008-lifecycle-operator-cli

Created clean by the controller from reviewed activation-sync commit
`723b07444b53adc4dc310d036f30e998ff1b0f99` on branch
`task/TASK-016-lifecycle-operator-cli`, which is pushed to origin. Do not begin
implementation until the readiness checkpoint is reviewed by GPT-5.5/xhigh,
committed, pushed, fast-forwarded into this branch/worktree, and verified clean.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for each command, protection, exact replay, disable audit, effective resolution, health/backlog, candidate provenance, and bounded output.

### GREEN

Implement thin CLI/IPC façades over lifecycle and behavior services.

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

- npx vitest run tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc
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
