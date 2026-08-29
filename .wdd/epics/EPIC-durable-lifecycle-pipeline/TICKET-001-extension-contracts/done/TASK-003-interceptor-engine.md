---
id: TASK-003-interceptor-engine
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-001-extension-contracts
wave: WAVE-002
slug: interceptor-engine
title: Implement bounded synchronous interceptor execution
status: done
depends_on: ["TASK-001-lifecycle-contracts-registry"]
conflict_domains:
  - "src/lifecycle/interceptors/**"
  - "src/lifecycle/contracts/interceptor-contract.ts"
  - "src/core/logging/audit-logger.ts"
assigned_model_class: codexHigh
actual_model: gpt-5.6-terra
reasoning_effort: high
review_model_class: reviewGate
branch: task/TASK-003-interceptor-engine
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-002-interceptor-engine
worktree_status: cleaned_up
worker_thread_id: 019f693a-4897-7d70-a2e4-90f3eaa98cd5
review_thread_id: 019f696a-3860-75b0-880c-5565730b8922
pr: https://github.com/ivo-toby/talon/pull/258
current_gate: merged
branch_freshness: merged_current_at_fcde60a
verification:
  - "npx vitest run tests/unit/lifecycle/interceptor-engine.test.ts tests/unit/core/logging/audit-logger.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-003-interceptor-engine: Implement bounded synchronous interceptor execution

## Status

done

## Parent Ticket

TICKET-001-extension-contracts

## Wave

WAVE-002

## Objective

Implement deterministic allow, deny, approval, and transform composition with strict handler/total budgets, explicit failure policy, recursion protection, and redacted audit evidence.

## Scope

- Execute by stable priority and compose transforms.
- Enforce time budgets and typed fail-open/fail-closed behavior.
- Audit handler identity, decision, reason, duration, and bounded transform metadata.
- Ship deterministic native example handlers.
- Reject root and nested proxy-valued interceptor JSON before any reflection,
  including object and array proxies, and prove validation executes zero traps.

## Non-Scope

No boundary wiring and no model-backed security boundary.

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

- src/lifecycle/interceptors/**
- src/lifecycle/contracts/interceptor-contract.ts
- src/core/logging/audit-logger.ts
- tests/unit/lifecycle/interceptor-engine.test.ts

## Dependencies

- TASK-001-lifecycle-contracts-registry

## Conflict Domains

- src/lifecycle/interceptors/**
- src/lifecycle/contracts/interceptor-contract.ts
- src/core/logging/audit-logger.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-003-interceptor-engine

## Worker Worktree

The clean worktree at
`/Users/ivo.toby/workspace/talon/.worktrees/WAVE-002-interceptor-engine` was
removed and pruned after PR #258 merged.

## PR / Patch Reference

PR #258 targeted `epic/durable-lifecycle-pipeline`, used task head `7d4eb47`,
and merged at `fcde60a`.

## RED-GREEN TDD Plan

### RED

Failing tests for order, composition, short-circuit, approval, timeouts, errors,
failure policy, recursion, audit redaction, and root/nested object/array proxy
rejection with zero trap execution.

### GREEN

Implement an injected in-process executor over registry-resolved handlers.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Preserve unrelated user changes and use typed neverthrow results across module boundaries.
- Audit side effects and keep durable payloads bounded and secret-free.
- Treat the TASK-001 carried Low as part of this task: call `types.isProxy()`
  before `Array.isArray`, prototype lookup, own-key enumeration, or descriptor
  inspection for every bounded interceptor JSON container.
- Request reviewGate/`gpt-5.6-sol` review with high reasoning before commit; resolve all P1/P2 or Critical/High/Medium findings.

## Review Focus

- Correctness and regressions at the listed conflict domains.
- Security/scope/privacy/idempotency/ordering/failure semantics relevant to the task.
- RED/GREEN evidence and contract/config/documentation drift.

## Durable Memory Notes To Consider

- Propose only stable decisions, root causes, constraints, or verified outcomes for task-findings.md.

## Task-Level Definition of Done

- [x] Objective and scoped behavior are complete.
- [x] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [x] Required review has no unresolved P1/P2 findings.
- [x] PR targets the epic branch and freshness is checked.
- [x] Shared-context findings are reconciled.

## Validation Steps

- npx vitest run tests/unit/lifecycle/interceptor-engine.test.ts tests/unit/core/logging/audit-logger.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Pre-review Terra/high remediation passed 138 focused tests, build,
  changed-source ESLint, touched-file Prettier, and `git diff --check`.
- Focused Sol/high delta review passed 0C/0H/0M/0L with 108 focused tests and
  exact pre/post worktree status. Its writable-review prompt explicitly forbade
  source, test, and WDD edits plus dependency installation.
- Final full-diff Sol/high review `019f6962-32a0-7af1-9165-c43e6342c4b4`
  passed 0C/0H/0M/0L with 141 focused tests, build, scoped ESLint, and diff
  checks. Refresh review `019f696a-3860-75b0-880c-5565730b8922` passed
  0C/0H/0M/0L against the staged epic checkpoint.
- Source commit `3529693` refreshed at `7d4eb47`; GitHub Verify PR run
  `29474326477` and PR Agent run `29474326478` passed. PR #258 had no review
  threads and merged at `fcde60a`.

## Review Feedback

### P1

- Resolved by focused Sol/high delta review: fail-open pre-invocation timeout
  now continues to later enforcing handlers unless the total deadline or a
  restrictive outcome terminates execution.

### P2

- None.

### P3

- None.

## Completion Notes

- The interceptor engine now composes deterministic priority/ID-ordered
  transforms with strict per-handler/total budgets, explicit failure policies,
  restrictive short-circuiting, recursion guards, and redacted audit evidence.
- Fail-open pre-invocation timeouts continue to later enforcing handlers unless
  the aggregate deadline or a restrictive result terminates execution.
- Bounded interceptor JSON rejects proxies and accessors before reflection;
  omitted signal metadata materializes as `{}` without weakening strict fields.
