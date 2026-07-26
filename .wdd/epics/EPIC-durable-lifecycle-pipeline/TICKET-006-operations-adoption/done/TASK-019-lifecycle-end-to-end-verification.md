---
id: TASK-019-lifecycle-end-to-end-verification
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-006-operations-adoption
wave: WAVE-010
slug: lifecycle-end-to-end-verification
title: Add end-to-end lifecycle, restart, and security verification
status: done
depends_on: ["TASK-018-governed-prompt-promotion"]
conflict_domains:
  - "tests/integration/**"
  - "tests/fixtures/**"
  - "src/lifecycle/** (defect fixes only)"
  - "src/daemon/** (defect fixes only)"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-019-lifecycle-end-to-end-verification
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-010-lifecycle-end-to-end-verification
worktree_status: cleaned_up
pr: https://github.com/ivo-toby/talon/pull/277
current_gate: merged
branch_freshness: merged_current_at_0c30dcc
verification:
  - "npx vitest run tests/integration/lifecycle-*.test.ts tests/integration/rolling-context-window.test.ts"
  - "npm run build"
  - "npm run lint"
  - "npm test (controller obtains explicit user approval before running the slow full suite)"
  - "$run-talon-smoke -- no-cost daemon and terminal round trip, then verify no listeners remain"
  - "Sprites event-pipeline validation for the completed lifecycle pipeline"
  - "git diff --check"
---

# TASK-019-lifecycle-end-to-end-verification: Add end-to-end lifecycle, restart, and security verification

## Status

done

## Parent Ticket

TICKET-006-operations-adoption

## Wave

WAVE-010

## Objective

Prove inbound-to-outbound async analysis, context rotation, restart/replay,
retention, isolation, interceptors, governed behavior promotion, and the
completed event pipeline across real SQLite, daemon, e2e, and Sprites
validation boundaries.

## Scope

- Add black-box lifecycle and context integration scenarios.
- Explicitly prove threshold -> observer -> projector -> reducer -> rotation,
  including reducer atomic replacement and next-item/session ordering.
- Test restart/lease recovery, dead-letter, replay, reload, retention, privacy, and disablement.
- Test scope/capability isolation, prompt injection, schema rejection, secret redaction, timeouts, recursion, and side-effect dedup.
- Test migration from current schema and targeted runtime-smoke assertions.
- Add e2e tests for the completed lifecycle waves before documentation adoption.
- Validate the completed event pipeline using Sprites before the epic is
  considered complete.

## Non-Scope

No unrelated refactor, issue-70 implementation, or full suite without approval.

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

- tests/integration/lifecycle-*.test.ts
- tests/integration/rolling-context-window.test.ts
- tests/fixtures/**
- src/lifecycle/** (defect fixes only)
- src/daemon/** (defect fixes only)

## Dependencies

- TASK-018-governed-prompt-promotion

## Conflict Domains

- tests/integration/**
- tests/fixtures/**
- src/lifecycle/** (defect fixes only)
- src/daemon/** (defect fixes only)

## Assigned Model Class

codexHigh

## Branch

task/TASK-019-lifecycle-end-to-end-verification

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-010-lifecycle-end-to-end-verification

Allocated by the controller for WAVE-010 bundled execution. Branch/worktree were
created and pushed from activation-sync commit
`953f9c356520294ebc8b924e5a975ed62f8e1873` and verified clean with this task,
orchestration.json, and controller-state.md present. Readiness review
`019f9d94-aa22-7630-8e38-1ff04c881158` passed 0C/0H/0M/0L, readiness commit
`8507ecdc39a231be1c52200846636880e30d2042` was pushed, and the task
branch/worktree were fast-forwarded before worker dispatch. After PR #277
merged, the clean task worktree was removed and pruned.

## PR / Patch Reference

PR #277: https://github.com/ivo-toby/talon/pull/277

## RED-GREEN TDD Plan

### RED

Add end-to-end scenarios first and demonstrate missing behavior against the reconciled branch.

### GREEN

Make only focused fixes exposed by the scenarios.

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
- [x] Required review has no unresolved P1/P2 findings.
- [x] PR targets the epic branch and freshness is checked.
- [x] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/integration/lifecycle-*.test.ts tests/integration/rolling-context-window.test.ts
- npm run build
- npm run lint
- npm test (controller obtains explicit user approval before running the slow full suite)
- $run-talon-smoke -- no-cost daemon and terminal round trip, then verify no listeners remain
- Sprites event-pipeline validation for the completed lifecycle pipeline
- git diff --check

## Verification Evidence

- WAVE-010 activation started from exact pushed WAVE-009 reconciliation
  checkpoint `2618059965f0a379948d79b8f6bb415419025397`. Branch/worktree
  creation and implementation remain blocked until the reviewed activation,
  activation-sync, and worktree-readiness gates pass.
- WAVE-010 activation checkpoint review
  `019f9d87-e141-7180-846b-9cb0e2eef260` passed 0C/0H/0M/0L. Reviewed
  activation checkpoint `119da93374ed0eaf2ffe9f477c120f33543b1bba` is pushed
  and recorded for activation-sync review; no TASK-019 branch/worktree exists.
- WAVE-010 activation-sync review `019f9d8d-0bb8-7b82-8797-c8b5559a2c2a`
  passed 0C/0H/0M/0L. Reviewed sync marker
  `953f9c356520294ebc8b924e5a975ed62f8e1873` is pushed. TASK-019 branch/worktree
  were created and pushed from that exact commit and verified clean with current
  WDD artifacts.
- WAVE-010 worktree-readiness review
  `019f9d94-aa22-7630-8e38-1ff04c881158` passed 0C/0H/0M/0L. Reviewed
  readiness commit `8507ecdc39a231be1c52200846636880e30d2042` was pushed, then
  fast-forwarded into the TASK-019 branch/worktree before worker dispatch.
- TASK-019 worker `019f9d9a-3507-7fc1-bdd6-eb23dc4a65db` added
  `tests/integration/lifecycle-end-to-end.test.ts`. Local Node 24.15.0
  verification passed `npx vitest run tests/integration/lifecycle-end-to-end.test.ts`
  (3/3), the explicit lifecycle integration bundle (4 files / 17 tests),
  `npm run build`, scoped Prettier, and `git diff --check`.
- `npm run lint` was attempted and remains blocked by pre-existing `src/**/*.ts`
  lint debt; the new integration test is outside the current project-service
  ESLint scope. Full `npm test` was not run because it requires explicit user
  approval.
- GPT-5.5/xhigh task review `019f9da3-e9a8-7dc0-912c-fb694c19f46e` passed
  0C/0H/0M/1L. The Low/P3 restart-scenario wording follow-up is recorded below
  and was intentionally not remediated.
- PR #277 passed GitHub `Build, lint, and test` and `pr_agent_job`, then merged
  into the epic branch at merge commit
  `0c30dcca56d94553871412266cf5e492d9302677` on `2026-07-26T09:03:21Z`.
- Sprites validation used isolated Sprite `mcp-codex-pr-talon-277-0c30dcc`,
  checked out exact merged epic commit `0c30dcc`, installed dependencies with
  no secrets via `npm ci --allow-git=all`, approved/rebuilt only
  `better-sqlite3` inside the throwaway Sprite, and passed the explicit
  lifecycle integration bundle (4 files / 17 tests), `npm run build`, and
  `git diff --check`. Dependency checkpoint `v1` was created before test runs;
  the Sprite was destroyed afterward.

## Review Feedback

### P1

- None.

### P2

- None.

### P3

- The test's restart scenario models retryable post-handoff failure rather than
  a literal process-restart lease-claim recovery. This is a non-blocking
  follow-up and was left untouched per the Low/P3 policy.

## Completion Notes

- TASK-019 merged through PR #277 and the event pipeline was validated locally,
  in GitHub checks, and in Sprites. The clean task worktree was removed and
  pruned during WAVE-010 reconciliation.
