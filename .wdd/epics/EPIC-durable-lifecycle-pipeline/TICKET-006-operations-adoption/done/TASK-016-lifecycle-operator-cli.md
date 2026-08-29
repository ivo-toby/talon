---
id: TASK-016-lifecycle-operator-cli
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-006-operations-adoption
wave: WAVE-008
slug: lifecycle-operator-cli
title: Add lifecycle operator CLI, IPC, health, and backlog controls
status: done
depends_on: ['TASK-014-lifecycle-retention-reload-replay', 'TASK-015-behavior-signal-projector']
conflict_domains:
  - 'src/cli/index.ts'
  - 'src/ipc/**'
  - 'src/daemon/daemon.ts'
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-016-lifecycle-operator-cli
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-008-lifecycle-operator-cli
worktree_status: cleaned_up
pr: https://github.com/ivo-toby/talon/pull/275
current_gate: merged
branch_freshness: merged_clean_after_green_github_checks
verification:
  - "npx vitest run tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc"
  - "npm run build"
  - "scoped eslint/prettier for touched files"
  - "git diff --check"
---

# TASK-016-lifecycle-operator-cli: Add lifecycle operator CLI, IPC, health, and backlog controls

## Status

done

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
- src/cli/commands/lifecycle\*.ts
- src/ipc/\*\*
- src/daemon/daemon.ts
- tests/unit/cli/lifecycle-commands.test.ts
- tests/unit/ipc/\*\*

## Dependencies

- TASK-014-lifecycle-retention-reload-replay
- TASK-015-behavior-signal-projector

## Conflict Domains

- src/cli/index.ts
- src/ipc/\*\*
- src/daemon/daemon.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-016-lifecycle-operator-cli

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-008-lifecycle-operator-cli

Created clean by the controller from reviewed activation-sync commit
`723b07444b53adc4dc310d036f30e998ff1b0f99` on branch
`task/TASK-016-lifecycle-operator-cli`, then fast-forwarded to reviewed
readiness checkpoint `c8057fa9ebba53c5b1ddcafe280389519510b04b`. Worker
session `019f9cbd-8878-7f91-8243-b5a56236233f` produced reviewed commit
`1c1e650`, pushed to `task/TASK-016-lifecycle-operator-cli`. After PR #274
merged, this branch was refreshed onto epic commit `a7ac0cd`; the single
behavior repository conflict was resolved and reviewed in integration commit
`e26385d`.

## PR / Patch Reference

https://github.com/ivo-toby/talon/pull/275 targets epic/durable-lifecycle-pipeline.

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
- Implementation began after the controller confirmed the reviewed readiness
  commit was pushed, fast-forwarded into this branch/worktree, and verified
  clean with current WDD state.
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
- [ ] Shared-context findings are proposed when needed.

## Validation Steps

- npx vitest run tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc tests/unit/daemon/daemon.test.ts
- npm run build
- scoped eslint/prettier for touched files
- git diff --check

## Verification Evidence

- RED: `npx vitest run tests/unit/cli/lifecycle-commands.test.ts` failed before implementation because `src/cli/commands/lifecycle.js` did not exist.
- GREEN: `npx vitest run tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc` passed 4 files / 34 tests.
- `npm run build` passed.
- `npm run lint` was attempted and failed on pre-existing unrelated source lint debt outside the TASK-016 touched files (for example WhatsApp connector/auth, run-subagent, context-assembler, provider/subagent utilities); no errors were reported for TASK-016 files in that run.
- Scoped lint passed: `npx eslint src/cli/commands/daemon-control.ts src/cli/commands/lifecycle.ts src/cli/index.ts src/ipc/daemon-ipc.ts src/core/database/repositories/lifecycle-delivery-repository.ts src/core/database/repositories/index.ts src/daemon/daemon.ts`.
- Prettier check passed for touched source and test files: `npx prettier --check src/cli/commands/daemon-control.ts src/cli/commands/lifecycle.ts src/cli/index.ts src/ipc/daemon-ipc.ts src/core/database/repositories/lifecycle-delivery-repository.ts src/core/database/repositories/index.ts src/daemon/daemon.ts tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc/lifecycle-daemon-ipc.test.ts`.
- `git diff --check` passed.
- Remediation type check passed: `npx tsc --noEmit --pretty false`.
- Remediation focused tests passed: `npx vitest run tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc tests/unit/daemon/daemon.test.ts` passed 5 files / 88 tests.
- Remediation build passed: `npm run build`.
- Remediation scoped lint passed: `npx eslint --no-warn-ignored src/cli/commands/daemon-control.ts src/cli/commands/lifecycle.ts src/cli/commands/queue-purge.ts src/cli/index.ts src/ipc/daemon-ipc.ts src/ipc/daemon-ipc-client.ts src/ipc/daemon-ipc-server.ts src/core/database/repositories/lifecycle-delivery-repository.ts src/core/database/repositories/behavior-signal-repository.ts src/core/database/repositories/index.ts src/daemon/daemon.ts tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc/lifecycle-daemon-ipc.test.ts tests/unit/ipc/daemon-ipc-server.test.ts tests/unit/daemon/daemon.test.ts`.
- Remediation Prettier check passed: `npx prettier --check .wdd/epics/EPIC-durable-lifecycle-pipeline/TICKET-006-operations-adoption/in-progress/TASK-016-lifecycle-operator-cli.md README.md src/cli/commands/daemon-control.ts src/cli/commands/lifecycle.ts src/cli/commands/queue-purge.ts src/cli/index.ts src/ipc/daemon-ipc.ts src/ipc/daemon-ipc-client.ts src/ipc/daemon-ipc-server.ts src/core/database/repositories/lifecycle-delivery-repository.ts src/core/database/repositories/behavior-signal-repository.ts src/core/database/repositories/index.ts src/daemon/daemon.ts tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc/lifecycle-daemon-ipc.test.ts tests/unit/ipc/daemon-ipc-server.test.ts tests/unit/daemon/daemon.test.ts`.
- Remediation whitespace check passed: `git diff --check`.
- Fresh GPT-5.5/xhigh review `019f9ce5-400e-7430-860a-3f7ad042d99d` passed 0C/0H/0M/1L. The sole Low/P3 secondary `statusTiming` aggregation finding remains non-blocking per policy.
- Post-PR274 integration tests passed under Node 24.15.0: `mise exec node@24.15.0 -- npm run test -- tests/unit/cli/lifecycle-commands.test.ts tests/unit/ipc tests/unit/daemon/daemon.test.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/lifecycle/behavior-review-service.test.ts tests/unit/scheduler/scheduler.test.ts tests/unit/subagents/behavior-reviewer.test.ts` passed 9 files / 155 tests.
- Post-PR274 integration build passed: `mise exec node@24.15.0 -- npm run build`.
- Post-PR274 integration scoped ESLint passed for changed TypeScript files.
- Post-PR274 integration scoped Prettier and diff checks passed.
- Fresh post-integration GPT-5.5/xhigh review `019f9cf0-fdb6-7d62-b306-953b03bdb399` passed 0C/0H/0M/0L.
- GitHub Verify PR passed on PR #275 commit `e26385d`; PR #275 merged into `epic/durable-lifecycle-pipeline` at `3854e86e922b784d574b98bbe054b7b357b6a0b5`.

## Review Feedback

### P1

- None.

### P2

- None.

### P3

- Low/P3: secondary daemon `statusTiming` aggregation can overwrite timing per grouped persona row. The main handler `timing` used by `talonctl lifecycle handlers` is merged correctly, so this is non-blocking and intentionally left as a follow-up.

### GPT-5.5/xhigh Medium Remediation

- Fixed handler backlog summaries by selecting displayed handler IDs before querying backlog and using a handler-ID scoped aggregation without SQL row truncation.
- Fixed candidate output bounds by adding a repository-level limited candidate summary/provenance read and using it from daemon candidates.
- Replaced generic lifecycle IPC payload acceptance with strict per-command Zod discriminated-union payload schemas; malformed lifecycle list/mutation payloads are rejected by IPC schema validation before daemon handlers run.
- Added daemon/IPCs regressions for lifecycle handlers, inspect, replay, disable/audit, candidates, invalid payloads, repository errors, and limit behavior.

## Completion Notes

- Added `talonctl lifecycle` subcommands for handler/backlog health, delivery inspection, exact replay, handler disablement, and behavior-candidate provenance.
- Added typed daemon IPC command variants for lifecycle operator actions and daemon handlers that use repository read models plus `LifecycleAdminService` for replay/disable mutations.
- Added bounded lifecycle delivery status/handler summary repository methods and bounded behavior-candidate summary/provenance repository methods.
- Updated README for the public `talonctl lifecycle` CLI. No guided `.agents/skills` update was made because existing Talon skills cover setup/channel/persona workflows, not lifecycle operator administration.
- Commit `1c1e650` was pushed to `task/TASK-016-lifecycle-operator-cli`; PR #275 opened against `epic/durable-lifecycle-pipeline`.
- Integration commit `e26385d` refreshed PR #275 after PR #274 merged into the epic branch at `a7ac0cd`; PR #275 merged into the epic branch at `3854e86e922b784d574b98bbe054b7b357b6a0b5`.
