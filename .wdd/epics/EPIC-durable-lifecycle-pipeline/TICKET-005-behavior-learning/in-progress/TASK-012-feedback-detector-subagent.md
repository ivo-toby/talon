---
id: TASK-012-feedback-detector-subagent
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-005-behavior-learning
wave: WAVE-006
slug: feedback-detector-subagent
title: Ship the typed explicit-feedback detector sub-agent
status: in-progress
depends_on: ["TASK-004-subagent-lifecycle-adapter", "TASK-010-behavior-ledger-persistence"]
conflict_domains:
  - "src/lifecycle/behavior/contracts.ts"
  - "src/subagents/default/behavior-feedback-detector/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-012-feedback-detector-subagent
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-006-feedback-detector-subagent
worktree_status: active
pr: null
current_gate: final_review_pending
branch_freshness: synced_to_readiness_checkpoint_566a9a91d1f57bfcd9938011027d87f668fea13e
verification:
  - "npx vitest run tests/unit/subagents/behavior-feedback-detector.test.ts tests/unit/lifecycle/behavior-contracts.test.ts"
  - "npm run build"
  - "git diff --check"
---

# TASK-012-feedback-detector-subagent: Ship the typed explicit-feedback detector sub-agent

## Status

in-progress

## Parent Ticket

TICKET-005-behavior-learning

## Wave

WAVE-006

## Objective

Add an optional built-in behavior detector implementing talon.behavior.signal.v1 for explicit correction, positive feedback, inferred pattern, missed action, noise, and tool failure.

## Scope

- Define strict behavior signal contracts.
- Add default detector manifest, prompt, schema, and tests.
- Require bounded source/confidence/proposed behavior and derive provenance from trusted lifecycle event data.
- Fence untrusted input and produce no side effects.
- Allow contract-compatible replacement.

## Non-Scope

No persistence, promotion, reduction, prompt editing, or implicit subscription.

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

- src/lifecycle/behavior/contracts.ts
- src/subagents/default/behavior-feedback-detector/**
- tests/unit/subagents/behavior-feedback-detector.test.ts
- tests/unit/lifecycle/behavior-contracts.test.ts

## Dependencies

- TASK-004-subagent-lifecycle-adapter
- TASK-010-behavior-ledger-persistence

## Conflict Domains

- src/lifecycle/behavior/contracts.ts
- src/subagents/default/behavior-feedback-detector/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-012-feedback-detector-subagent

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-006-feedback-detector-subagent

Allocated by the controller for WAVE-006. Do not create or use this worktree
until the reviewed activation checkpoint has been committed and pushed.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing fixtures for correction, praise, noise, inference, forged source identity, hostile input, overlong output, and invalid schema.

### GREEN

Implement the contract, manifest, prompt, schema, and deterministic fixtures.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
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

- [x] Objective and scoped behavior are complete.
- [x] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [ ] Required review has no unresolved P1/P2 findings.
- [ ] PR targets the epic branch and freshness is checked.
- [ ] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/subagents/behavior-feedback-detector.test.ts tests/unit/lifecycle/behavior-contracts.test.ts
- npm run build
- git diff --check

## Verification Evidence

- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/subagents/behavior-feedback-detector.test.ts tests/unit/lifecycle/behavior-contracts.test.ts` passed: 2 files, 17 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/subagents/behavior-feedback-detector.test.ts tests/unit/lifecycle/behavior-contracts.test.ts --reporter=dot` passed after tool-call source remediation: 2 files, 19 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin git diff --check` passed.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/lifecycle/behavior/contracts.ts src/subagents/default/behavior-feedback-detector/index.ts` passed.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/lifecycle/behavior/types.ts src/lifecycle/behavior/contracts.ts src/subagents/default/behavior-feedback-detector/index.ts tests/unit/lifecycle/behavior-contracts.test.ts tests/unit/subagents/behavior-feedback-detector.test.ts` passed with 0 errors and 2 test-file ignore warnings.
- 2026-07-26: final reviewGate/gpt-5.5 xhigh passed with 0 Critical / 0 High / 0 Medium / 0 Low after remediation. Reviewer re-ran `npx vitest run tests/unit/subagents/behavior-feedback-detector.test.ts tests/unit/lifecycle/behavior-contracts.test.ts` (17 tests), scoped ESLint, `npx tsc -p tsconfig.build.json --noEmit`, and `git diff --check origin/epic/durable-lifecycle-pipeline`.
- 2026-07-26: BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/1M/0L. Medium: lifecycle tool events emit trusted `tool_call` references while the behavior evidence source enum only allowed `tool`.
- 2026-07-26: REMEDIATION READY FOR REVIEW: behavior evidence now accepts `tool_call` source kind, detector JSON instructions include it, and contract/sub-agent tests cover trusted tool-call failure provenance.
- 2026-07-26: BLOCKER REVIEW: reviewGate/gpt-5.5 xhigh stream identified a follow-on Medium in the real behavior ledger SQL constraint: migration 018 still rejected persisted `tool_call` evidence even after the TypeScript contracts accepted it.
- 2026-07-26: REMEDIATION READY FOR REVIEW: migration 018 now includes `tool_call` in `behavior_evidence.source_kind`, and repository coverage persists tool-call evidence through the real SQLite CHECK.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/subagents/behavior-feedback-detector.test.ts tests/unit/lifecycle/behavior-contracts.test.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/migrations/runner.test.ts --reporter=dot` passed after ledger-constraint remediation: 4 files, 48 tests.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed after ledger-constraint remediation.
- 2026-07-26: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/lifecycle/behavior/types.ts src/lifecycle/behavior/contracts.ts src/subagents/default/behavior-feedback-detector/index.ts tests/unit/lifecycle/behavior-contracts.test.ts tests/unit/subagents/behavior-feedback-detector.test.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts` passed with 0 errors and 3 test-file ignore warnings.
- 2026-07-26: `git diff --check origin/epic/durable-lifecycle-pipeline` passed after ledger-constraint remediation.

## Review Feedback

### P1

- None.

### P2

- Fixed: reviewGate/gpt-5.5 xhigh found that model output controlled both source and provenance. The detector now derives event provenance from the trusted lifecycle envelope and validates source/supporting source IDs against trusted lifecycle references before emitting signals.
- Fixed: reviewGate/gpt-5.5 xhigh found `tool_failure` could not use the actual trusted `tool_call` lifecycle reference. The contract now accepts `tool_call` evidence sources and regression tests cover the conversion path.
- Fixed: reviewGate/gpt-5.5 xhigh found the behavior ledger SQL CHECK still rejected persisted `tool_call` evidence. Migration 018 and repository tests now cover that real persistence path.

### P3

- None.

## Completion Notes

- Added strict `talon.behavior.signal.v1` detector contracts with bounded source, confidence, summary, proposed behavior, no-NUL/well-formed Unicode validation, inferred-pattern distinct-source enforcement, trusted-source validation, and lifecycle signal envelope conversion.
- Added optional default `behavior-feedback-detector` lifecycle sub-agent manifest, prompt, and repository-free runtime. It parses only adapter-fenced lifecycle input, fences it again for the model, validates JSON output, emits causally linked `behavior.feedback.detected.v1` signals, and treats `noise` as a no-signal result.
- Added deterministic focused tests for contract acceptance/rejection, trusted source validation, prompt fencing, manifest lifecycle capability, explicit correction, positive feedback, inferred pattern, missed action, noise, tool failure, invalid output, and invalid input.
- Added regression coverage for tool failure signals sourced from trusted `tool_call` lifecycle references.
- Kept `tool_call` accepted consistently across detector output, signal metadata, and behavior evidence persistence.
