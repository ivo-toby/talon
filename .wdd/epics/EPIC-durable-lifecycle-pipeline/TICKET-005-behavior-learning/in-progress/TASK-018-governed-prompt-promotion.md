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
worktree_status: implementation_complete_review_passed
pr: null
current_gate: commit_pending
branch_freshness: current_at_readiness_9c6e82e
verification:
  - "npx vitest run tests/unit/lifecycle/prompt-improvement-projector.test.ts tests/integration/lifecycle-prompt-promotion.test.ts tests/unit/daemon/reload.test.ts"
  - "npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/migrations/runner.test.ts"
  - "npm run build"
  - "npx eslint <touched source files>"
  - "npx prettier --check <touched TypeScript files>"
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

- [x] Objective and scoped behavior are complete.
- [x] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [x] Required review has no unresolved P1/P2 findings.
- [ ] PR targets the epic branch and freshness is checked.
- [x] Shared-context findings are proposed when needed.

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
- Worktree-readiness review `019f9d29-2367-74e3-943f-a795f6de8245`
  passed 0C/0H/0M/0L. Reviewed readiness commit
  `9c6e82e84a14a2d95056e7d414e8c067fcc9f20c` was committed and pushed on the
  epic branch, fast-forwarded into the task branch/worktree, and pushed.
- Implementation worker `019f9d2d-c40c-7e11-995b-59b63183cb4a` completed the
  first TASK-018 patch. The first pre-commit review
  `019f9d3e-cdbf-7b91-b7f5-3ef5b7f435e7` returned FAIL with 0C/3H/1M/0L.
- Remediation addressed the blocking findings by adding latest-active
  activation rollback gating at both service pre-mutation and repository
  transaction boundaries, runtime-base prompt path resolution, stronger
  outbound-channel auto-policy blocking, and durable `approved_by` activation
  provenance.
- Follow-up pre-commit review `019f9d4d-d056-7281-b541-8e6d55e71040` returned
  FAIL with 0C/1H/0M/1L. The blocking High identified overlapping
  same-persona prompt mutations under concurrent IPC command handling.
- Review attempt `019f9d56-9120-7443-84f2-a2ab73733b03` was interrupted after
  identifying that an instance-local lock did not close the concurrency issue
  because daemon IPC constructs a fresh projector per operator command.
- Remediation serialized prompt promotion and rollback mutations per persona
  across projector instances with a process-wide mutation queue, covering prompt
  reads, writes, reload verification, and activation/rollback ledger
  transitions. A concurrency regression launches two same-persona prompt
  promotions through separate projector instances with delayed prompt reads and
  verifies no prompt read overlap plus both final prompt changes.
- Post-remediation verification under Node `v24.15.0`:
  - `npx vitest run tests/unit/lifecycle/prompt-improvement-projector.test.ts tests/integration/lifecycle-prompt-promotion.test.ts tests/unit/daemon/reload.test.ts`
    passed: 3 files / 42 tests.
  - `npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/migrations/runner.test.ts`
    passed: 2 files / 33 tests.
  - `npm run build` passed.
  - `npx eslint` over touched source files passed.
  - `npx prettier --check` over touched TypeScript files passed.
  - `git diff --check` passed.
- Fresh pre-commit review `019f9d59-a303-7590-9179-077f65d8a1a3` passed
  0C/0H/0M/0L. Reviewer explicitly inspected tracked and untracked task changes
  from readiness base `9c6e82e84a14a2d95056e7d414e8c067fcc9f20c`, verified the
  process-wide projector mutation queue, latest-active rollback gating, runtime
  prompt path resolution, outbound-channel auto-policy blocking, durable
  `approved_by` provenance, and ran build, 75 focused tests, scoped ESLint,
  scoped Prettier, and `git diff --check`.

## Review Feedback

### P1

- 2026-07-26 review `019f9d3e-cdbf-7b91-b7f5-3ef5b7f435e7`: High - rollback
  could erase later active promotions while leaving their ledger rows active.
  Fixed with latest-active activation validation before any rollback file
  mutation.
- 2026-07-26 review `019f9d3e-cdbf-7b91-b7f5-3ef5b7f435e7`: High - prompt
  promotion resolved relative `systemPromptFile` paths from config directory
  instead of daemon runtime layout. Fixed by resolving from runtime working
  directory, with explicit test-only prompt base injection.
- 2026-07-26 review `019f9d3e-cdbf-7b91-b7f5-3ef5b7f435e7`: High - auto-policy
  missed concrete outbound notification/channel instructions. Fixed by blocking
  email/mail/Slack/Discord/Telegram/WhatsApp/Teams/SMS/post/publish/DM/alert
  language from auto-promotion.
- 2026-07-26 review `019f9d4d-d056-7281-b541-8e6d55e71040`: High -
  same-persona prompt promotion/rollback mutations could overlap under
  concurrent daemon IPC polling and leave prompt files inconsistent with active
  activation rows. Fixed by serializing projector mutations per persona across
  projector instances and adding a concurrent-promotion regression.
- 2026-07-26 interrupted review `019f9d56-9120-7443-84f2-a2ab73733b03`: High
  remained because the first serialization attempt was instance-local while the
  daemon creates one projector per IPC command. Fixed with a process-wide
  per-persona mutation queue and a two-projector concurrency regression.

### P2

- 2026-07-26 review `019f9d3e-cdbf-7b91-b7f5-3ef5b7f435e7`: Medium -
  operator-approved activations did not durably record the approver. Fixed with
  nullable `behavior_promotion_activations.approved_by`, repository validation,
  service propagation, audit details, and regression coverage.

### P3

- None.

## Completion Notes

- Implemented native governed prompt promotion modules with structured
  `talon.behavior.prompt_patch.v1` parsing, default approval, explicit narrow
  auto-policy, bounded evaluation, atomic prompt write, reload verification,
  failure restore, activation provenance, and explicit rollback.
- Added durable `approved_by` activation provenance and latest-active
  activation rollback gating so rollbacks cannot erase newer active prompt
  changes.
- Serialized same-persona prompt promotion/rollback mutations across projector
  instances with a process-wide mutation queue so overlapping daemon IPC
  commands cannot interleave prompt file writes with activation ledger
  transitions.
- Added lifecycle IPC/CLI actions for `promote` and `rollback-promotion`.
- Updated README, example config, AGENTS architecture notes, and affected
  Talon setup skills under `.agents/skills/`.
- Verification:
  - `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/prompt-improvement-projector.test.ts tests/integration/lifecycle-prompt-promotion.test.ts tests/unit/daemon/reload.test.ts`
    passed: 3 files / 42 tests.
  - `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/core/database/migrations/runner.test.ts`
    passed: 2 files / 33 tests.
  - `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build`
    passed.
  - Task-scoped `npx eslint` over touched source files passed.
  - `npx prettier --check` over touched TypeScript files passed.
  - `git diff --check` passed.
