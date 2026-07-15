---
id: TASK-015-behavior-signal-projector
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-005-behavior-learning
wave: WAVE-007
slug: behavior-signal-projector
title: Implement feedback projection and evidence deduplication
status: todo
depends_on: ["TASK-007-daemon-message-queue-schedule-events", "TASK-010-behavior-ledger-persistence", "TASK-012-feedback-detector-subagent"]
conflict_domains:
  - "src/lifecycle/behavior/**"
  - "src/core/config/config-schema.ts"
  - "tests/integration/lifecycle-behavior-feedback.test.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-015-behavior-signal-projector
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/lifecycle/behavior tests/integration/lifecycle-behavior-feedback.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-015-behavior-signal-projector: Implement feedback projection and evidence deduplication

## Status

todo

## Parent Ticket

TICKET-005-behavior-learning

## Wave

WAVE-007

## Objective

Project validated signals into the persona ledger with provenance, deterministic source fingerprints, schedule/direct copy suppression, distinct-source thresholds, scope enforcement, and notes-only behavior.

## Scope

- Implement native BehaviorSignalProjector.
- Fingerprint source evidence and collapse copies/summaries.
- Store explicit correction candidates; require three independent inferred sources.
- Wire explicit persona subscriptions to bounded lifecycle events.
- Audit suppression and candidate creation.

## Non-Scope

No daily/weekly reduction, promotion, reload, or routine chat output.

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

- src/lifecycle/behavior/behavior-signal-projector.ts
- src/lifecycle/behavior/evidence-fingerprint.ts
- src/lifecycle/behavior/behavior-handler.ts
- src/core/config/config-schema.ts
- tests/unit/lifecycle/behavior/**
- tests/integration/lifecycle-behavior-feedback.test.ts

## Dependencies

- TASK-007-daemon-message-queue-schedule-events
- TASK-010-behavior-ledger-persistence
- TASK-012-feedback-detector-subagent

## Conflict Domains

- src/lifecycle/behavior/**
- src/core/config/config-schema.ts
- tests/integration/lifecycle-behavior-feedback.test.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-015-behavior-signal-projector

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for correction candidates, three-source inference, copy/summary suppression, isolation, capability denial, provenance, audit, and notes-only output.

### GREEN

Implement deterministic fingerprinting, projector, and explicit subscription glue.

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

- npx vitest run tests/unit/lifecycle/behavior tests/integration/lifecycle-behavior-feedback.test.ts
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

