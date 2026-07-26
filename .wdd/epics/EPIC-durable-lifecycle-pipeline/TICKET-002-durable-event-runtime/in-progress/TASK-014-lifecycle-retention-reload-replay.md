---
id: TASK-014-lifecycle-retention-reload-replay
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-002-durable-event-runtime
wave: WAVE-007
slug: lifecycle-retention-reload-replay
title: Implement retention, privacy deletion, reload identity, and safe replay
status: in-progress
depends_on: ["TASK-006-durable-event-dispatcher", "TASK-013-handler-telemetry-correlation"]
conflict_domains:
  - "src/lifecycle/retention-service.ts"
  - "src/lifecycle/lifecycle-admin-service.ts"
  - "src/core/database/repositories/lifecycle-*.ts"
  - "src/daemon/reload.ts"
  - "src/daemon/daemon.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-014-lifecycle-retention-reload-replay
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-007-lifecycle-retention-reload-replay
worktree_status: pre_commit_review_passed
pr: null
current_gate: pre_commit_review_passed
branch_freshness: task_branch_current_before_commit
verification:
  - "npx vitest run tests/unit/lifecycle/retention-service.test.ts tests/unit/lifecycle/lifecycle-admin-service.test.ts tests/unit/daemon/reload.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-014-lifecycle-retention-reload-replay: Implement retention, privacy deletion, reload identity, and safe replay

## Status

in-progress

## Parent Ticket

TICKET-002-durable-event-runtime

## Wave

WAVE-007

## Objective

Add configurable compaction, privacy-aware payload deletion/tombstoning, stable handler identity across reload, disablement, and exact one-handler replay without duplicated state/side effects.

## Scope

- Compact completed detail after an audit window.
- Integrate thread/persona privacy deletion.
- Snapshot handler/implementation/contract version for pending deliveries.
- Implement disable and exact replay services.
- Test restart/reload, compaction, deletion, replay, and dedup.
- Treat the existing pre-mutation restart-required guard for lifecycle and
  lifecycle-attached persona authority changes as the compatibility baseline;
  do not assume the lifecycle runtime is already rebuilt in place on reload.

## Non-Scope

No CLI, arbitrary bulk replay, remote upgrades, or permanent full history.

## Relevant Context

### Local Context

- Inspect the likely files and their focused tests before broad discovery.
- Follow the epic architecture and design decisions; preserve existing disabled and legacy behavior.
- Inspect TASK-007's merged reload guard and focused reload tests before
  designing stable handler identity across reload/restart.
- Treat untrusted content, capability scope, idempotency, ordering, audit, and privacy as explicit review concerns.

### Shared Context References

- ../../shared-context/index.md
- ../../shared-context/resources/architecture.md
- ../../shared-context/resources/design-decisions.md
- ../../shared-context/resources/testing-strategy.md
- ../../shared-context/resources/task-findings.md

## Likely Files / Areas

- src/lifecycle/retention-service.ts
- src/lifecycle/lifecycle-admin-service.ts
- src/core/database/repositories/lifecycle-*.ts
- src/daemon/reload.ts
- src/daemon/daemon.ts
- tests/unit/lifecycle/retention-service.test.ts
- tests/unit/lifecycle/lifecycle-admin-service.test.ts
- tests/unit/daemon/reload.test.ts

## Dependencies

- TASK-006-durable-event-dispatcher
- TASK-013-handler-telemetry-correlation

## Conflict Domains

- src/lifecycle/retention-service.ts
- src/lifecycle/lifecycle-admin-service.ts
- src/core/database/repositories/lifecycle-*.ts
- src/daemon/reload.ts
- src/daemon/daemon.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-014-lifecycle-retention-reload-replay

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-007-lifecycle-retention-reload-replay

Allocated by the controller for WAVE-007. Do not create or use this worktree
until the reviewed activation checkpoint has been committed and pushed.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for compaction windows, pending/dead-letter preservation, privacy
deletion, version-stable reload, the existing restart-required lifecycle-change
guard, missing/disabled handlers, exact replay, audit, and no duplicates.

### GREEN

Implement retention/admin services and persisted handler snapshots.

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

- npx vitest run tests/unit/lifecycle/retention-service.test.ts tests/unit/lifecycle/lifecycle-admin-service.test.ts tests/unit/daemon/reload.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/retention-service.test.ts tests/unit/lifecycle/lifecycle-admin-service.test.ts tests/unit/daemon/reload.test.ts` passed: 35 tests / 3 files.
- Adjacent lifecycle persistence/migration coverage also passed: `tests/unit/core/database/repositories/lifecycle-event-repository.test.ts` and `tests/unit/core/database/migrations/runner.test.ts`, 79 total tests across 5 files with the required suite.
- Remediation targeted suite passed after GPT-5.5/xhigh findings were addressed: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/retention-service.test.ts tests/unit/lifecycle/lifecycle-admin-service.test.ts tests/unit/core/database/migrations/runner.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/daemon/reload.test.ts` passed: 187 tests / 6 files.
- `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed.
- `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint` still fails on pre-existing unrelated repo-wide lint errors in WhatsApp/CLI/context/subagent/provider/tool files; no TASK-014-owned lint errors remain.
- Task-owned source ESLint passed for `src/core/database/lifecycle-sql-functions.ts`, `src/lifecycle/retention-service.ts`, `src/lifecycle/lifecycle-admin-service.ts`, `src/lifecycle/contracts/subscription-contract.ts`, `src/lifecycle/contracts/index.ts`, `src/core/database/repositories/lifecycle-event-repository.ts`, and `src/core/database/repositories/lifecycle-delivery-repository.ts`.
- Touched-file Prettier check passed.
- `git diff --check` passed.
- Remediation for direct SQL replay of tombstoned deliveries passed:
  `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/core/database/repositories/lifecycle-event-repository.test.ts` passed: 32 tests / 1 file.
- Migration-level replay bypass regression coverage passed:
  `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/core/database/migrations/runner.test.ts` passed: 12 tests / 1 file.
- TASK-014 focused remediation suite passed:
  `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/retention-service.test.ts tests/unit/lifecycle/lifecycle-admin-service.test.ts tests/unit/core/database/migrations/runner.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/daemon/reload.test.ts` passed: 188 tests / 6 files.
- `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` passed.
- Scoped ESLint passed:
  `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/database/repositories/lifecycle-delivery-repository.ts`.
- `git diff --check` passed after remediation.
- Blocking-review remediation for system-owned tombstone authority passed:
  `npx vitest run tests/unit/core/database/repositories/lifecycle-event-repository.test.ts tests/unit/core/database/migrations/runner.test.ts tests/unit/lifecycle/retention-service.test.ts tests/unit/lifecycle/lifecycle-admin-service.test.ts` passed: 57 tests / 4 files.
- `npm run build` passed after system-owned tombstone remediation.
- Scoped ESLint passed for remediation-touched source:
  `npx eslint src/core/database/repositories/lifecycle-event-repository.ts src/core/database/repositories/lifecycle-delivery-repository.ts`.
- `git diff --check` passed after system-owned tombstone remediation.
- Fresh full-diff GPT-5.5/xhigh review gate passed in Codex session
  `019f9c80-79e8-7770-bcf4-8ef4f8d2a5fb`: 0 Critical / 0 High /
  0 Medium / 0 Low. Reviewer re-ran the six-file focused suite
  (`190 tests`), `npm run build`, `git diff --check`, and scoped ESLint.

## Review Feedback

### GPT-5.5/xhigh Blocking Finding

- Resolved: migration 019 no longer permits unauthorised terminal-to-pending
  replay updates. The trigger now requires repository authorization for replay,
  and the repository `reopen()` path enters that authorization scope only after
  eligibility checks reject retention-compacted event tombstones,
  privacy-deleted event tombstones, handler-disabled deliveries, and
  privacy-deleted deliveries.
- Resolved: retention compaction no longer treats caller-owned payload metadata
  named `lifecycleRetention` as authoritative. Migration 019 adds a
  system-owned `retention_tombstone_reason` column, repository tombstone writes
  set it under SQLite authorization, and compaction skips only rows with that
  system marker. Focused coverage verifies an eligible completed event with
  caller metadata `lifecycleRetention` is still compacted.
- Resolved: replay eligibility no longer infers non-replayable tombstone state
  solely from handler-writable `last_error.code`. Migration 019 adds a
  system-owned `terminal_tombstone_reason` column for handler-disable/privacy
  delivery tombstones; repository replay blocks real delivery tombstones and
  event retention/privacy tombstones, while ordinary dead-letter failures using
  diagnostic codes `privacy-deleted` or `handler-disabled` reopen normally.

### P1

- None.

### P2

- None.

### P3

- None.

### Fresh Full-Diff Review

- Passed: GPT-5.5/xhigh review in Codex session
  `019f9c80-79e8-7770-bcf4-8ef4f8d2a5fb` found 0 Critical, 0 High,
  0 Medium, and 0 Low findings after reviewing tracked and untracked TASK-014
  files. All prior blockers were explicitly confirmed resolved.

## Completion Notes

- GPT-5.5/xhigh remediation tightened thread tombstone SQL to require `aggregate_type = 'thread'`, blocked replay of canonical retention/privacy tombstones and handler-disabled/privacy-deleted delivery tombstones, and preserved replay for ordinary terminal handler failures.
- GPT-5.5/xhigh blocking-review remediation made event and delivery tombstone
  authority system-owned via migration 019 columns, preserving replay for
  ordinary handler diagnostics that use tombstone-like strings and preserving
  blocked replay for real retention/privacy/disablement tombstones.
- Migration 019 now requires a repository-controlled SQLite authorization function for canonical event tombstones and privacy/disablement terminal delivery tombstones; direct SQL regression coverage was added.
- TASK-014 now exposes validated `lifecycle.retention.completedAuditWindowMs` config and documents the service-level retention/privacy primitives. Operator CLI invocation remains scoped to downstream TASK-016.
