---
id: TASK-020-lifecycle-documentation-adoption
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-006-operations-adoption
wave: WAVE-011
slug: lifecycle-documentation-adoption
title: Update lifecycle configuration, architecture, setup skills, and operator docs
status: in-progress
depends_on: ["TASK-019-lifecycle-end-to-end-verification"]
conflict_domains:
  - "README.md"
  - "selfdoc.md"
  - "AGENTS.md"
  - "config/talond.example.yaml"
  - "starter/**"
  - "starter-stack/**"
  - ".agents/skills/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-020-lifecycle-documentation-adoption
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-011-lifecycle-documentation-adoption
worktree_status: task_review_passed_uncommitted
pr: null
current_gate: commit_pending
branch_freshness: branch_current_at_readiness_8ee0b3f_with_reviewed_uncommitted_task_diff
verification:
  - "npx vitest run tests/unit/deploy/starter-bundle.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/cli/lifecycle-commands.test.ts"
  - "npm run build"
  - "git diff --check"
---

# TASK-020-lifecycle-documentation-adoption: Update lifecycle configuration, architecture, setup skills, and operator docs

## Status

in-progress

## Parent Ticket

TICKET-006-operations-adoption

## Wave

WAVE-011

## Objective

Synchronize README, architecture self-doc, config/starter examples, AGENTS, default sub-agent docs, and affected setup/profile/personality/schedule/smoke skills with the verified implementation.

## Scope

- Document the two-lane model, contracts, subscriptions, retention/privacy, delivery guarantees, and security boundaries.
- Document context migration/deprecation and behavior governance.
- Update config examples, starter bundles, CLI/health/replay guidance, and optional issue-70 evidence.
- Create or restore selfdoc.md if still absent.
- Update affected .agents/skills and drift tests.

## Non-Scope

No remote-handler design or runtime change beyond documentation-discovered drift fixes.

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

- README.md
- selfdoc.md
- AGENTS.md
- config/talond.example.yaml
- docs/reference/config-schema.mdx
- starter/**
- starter-stack/**
- .agents/skills/**
- tests/unit/deploy/starter-bundle.test.ts

## Dependencies

- TASK-019-lifecycle-end-to-end-verification

## Conflict Domains

- README.md
- selfdoc.md
- AGENTS.md
- config/talond.example.yaml
- starter/**
- starter-stack/**
- .agents/skills/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-020-lifecycle-documentation-adoption

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-011-lifecycle-documentation-adoption

Created clean from pushed activation-sync checkpoint
`0053209080b96c02c2d4fb7af02a24a1af0a477d` after GPT-5.5/xhigh
activation-sync review `019f9dd8-ead7-77f1-ab13-7fa6eae8132c` passed
0C/0H/0M/0L. Worktree-readiness review
`019f9de5-d632-7d30-9dec-69e552084d2d` passed 0C/0H/0M/0L after the prior
Medium stale-metadata finding was remediated. Reviewed readiness commit
`8ee0b3f819dbbe29354ee1cd046e80ae0ca6b438` was pushed, and this branch/worktree
was fast-forwarded to that exact commit before implementation. Current task
diff is uncommitted and awaits mandatory GPT-5.5/xhigh full-diff review.
Initial task review `019f9e01-d202-7150-a5c5-c8b921a1dcf1` failed
0C/0H/2M/2L. Medium findings were remediated by documenting the required
`personas[].subagents` authority for lifecycle sub-agent handlers and clarifying
that lifecycle `budget.maxConcurrency` is accepted by the contract but is not
currently dispatcher-enforced per handler/subscription. Low/P3 findings remain
non-blocking follow-ups and were not automatically edited.
Fresh task review `019f9e0a-eb3d-72e0-85b9-928f21d833a6` passed
0C/0H/0M/3L; commit is now authorized after recording this review evidence.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Add/update executable drift tests for example config, starter assets, and CLI help where possible.

### GREEN

Update every required artifact from final effective config and verified commands.

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

- [ ] Objective and scoped behavior are complete.
- [ ] Focused RED/GREEN, build/lint, and listed validation evidence are recorded.
- [ ] Required review has no unresolved P1/P2 findings.
- [ ] PR targets the epic branch and freshness is checked.
- [ ] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/deploy/starter-bundle.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/cli/lifecycle-commands.test.ts
- npm run build
- git diff --check

## Verification Evidence

- 2026-07-26T10:31:31Z:
  `npx vitest run tests/unit/deploy/starter-bundle.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/cli/lifecycle-commands.test.ts`
  passed 3 files / 121 tests.
- 2026-07-26T10:32:00Z: `npm run build` passed.
- 2026-07-26T10:32:16Z: `git diff --check` passed.
- 2026-07-26T10:43:44Z: GPT-5.5/xhigh task review
  `019f9e01-d202-7150-a5c5-c8b921a1dcf1` failed 0C/0H/2M/2L. Medium findings:
  missing persona `subagents` authority note for lifecycle sub-agent handlers
  and overstated `budget.maxConcurrency` runtime enforcement.
- 2026-07-26T10:45:54Z: Medium remediation complete.
  `npx vitest run tests/unit/deploy/starter-bundle.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/cli/lifecycle-commands.test.ts`
  passed 3 files / 121 tests; `npm run build`, `git diff --check`, and
  `jq empty .wdd/epics/EPIC-durable-lifecycle-pipeline/orchestration.json`
  passed. Current gate: fresh GPT-5.5/xhigh full-diff task review before commit.
- 2026-07-26T10:54:13Z: Fresh GPT-5.5/xhigh task review
  `019f9e0a-eb3d-72e0-85b9-928f21d833a6` passed 0C/0H/0M/3L. Low/P3 findings
  remain non-blocking follow-ups: nested `budget`/`failurePolicy` version rows,
  lifecycle disable tombstone wording, and AGENTS migration-location wording.
  Current gate: commit/push the reviewed task branch.

## Review Feedback

### P1

- None.

### P2

- Resolved: task review `019f9e01-d202-7150-a5c5-c8b921a1dcf1` found missing
  persona `subagents` authority documentation for lifecycle sub-agent handlers.
  Remediated in `docs/reference/config-schema.mdx`, `README.md`, `selfdoc.md`,
  and example config comments.
- Resolved: task review `019f9e01-d202-7150-a5c5-c8b921a1dcf1` found
  `budget.maxConcurrency` documented as a runtime-enforced handler cap even
  though current runtime enforces dispatcher policy plus `timeoutMs`. Remediated
  in `docs/reference/config-schema.mdx`.

### P3

- Non-blocking follow-up: lifecycle config tables omit required nested
  `version: v1` rows for `budget` and `failurePolicy`.
- Non-blocking follow-up: setup skill tables describe `talonctl lifecycle
  disable` as dead-lettering instead of handler-disabled tombstoning.
- Non-blocking follow-up: AGENTS.md lists lifecycle/behavior tables in a
  sentence anchored to `001-initial-schema.sql`, while those tables live in
  later migrations.

## Completion Notes

- Implemented documentation/adoption update in the TASK-020 worktree:
  lifecycle config reference, restored `selfdoc.md`, README/AGENTS pointers,
  disabled lifecycle examples in main/starter configs, starter README operator
  guidance, setup/profile/personality/schedule/smoke skill guidance, starter
  skill sync, and drift tests.
