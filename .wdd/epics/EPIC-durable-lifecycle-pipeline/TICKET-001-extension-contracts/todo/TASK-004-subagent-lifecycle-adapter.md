---
id: TASK-004-subagent-lifecycle-adapter
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-001-extension-contracts
wave: WAVE-002
slug: subagent-lifecycle-adapter
title: Implement the capability-scoped sub-agent lifecycle adapter
status: todo
depends_on: ["TASK-001-lifecycle-contracts-registry"]
conflict_domains:
  - "src/lifecycle/adapters/**"
  - "src/subagents/subagent-runner.ts"
  - "src/personas/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-004-subagent-lifecycle-adapter
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/subagents/subagent-runner.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-004-subagent-lifecycle-adapter: Implement the capability-scoped sub-agent lifecycle adapter

## Status

todo

## Parent Ticket

TICKET-001-extension-contracts

## Wave

WAVE-002

## Objective

Invoke only configured sub-agents with fenced untrusted input, persona/capability scope, timeout/token/model bounds, named output contracts, and typed signals/errors.

## Scope

- Reuse loader, runner, model resolver, and failover paths.
- Fence event/message/tool/trace material as untrusted data.
- Enforce explicit attachment, scope, budgets, schema validation, and correlation.
- Return proposals only; expose no repositories.

## Non-Scope

No default behavior/context prompts, projection, dispatch, or trace fetching.

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

- src/lifecycle/adapters/subagent-lifecycle-adapter.ts
- src/lifecycle/adapters/prompt-fencing.ts
- src/subagents/subagent-runner.ts
- src/personas/**
- tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts

## Dependencies

- TASK-001-lifecycle-contracts-registry

## Conflict Domains

- src/lifecycle/adapters/**
- src/subagents/subagent-runner.ts
- src/personas/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-004-subagent-lifecycle-adapter

## Worker Worktree

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for explicit attachment, cross-persona/capability denial, prompt fencing, timeout/token limits, schema rejection, failover, and correlation.

### GREEN

Implement a thin adapter over existing sub-agent execution.

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

- npx vitest run tests/unit/lifecycle/subagent-lifecycle-adapter.test.ts tests/unit/subagents/subagent-runner.test.ts
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
