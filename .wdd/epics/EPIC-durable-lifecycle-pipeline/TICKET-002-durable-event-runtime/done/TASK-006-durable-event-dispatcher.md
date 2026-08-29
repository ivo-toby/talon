---
id: TASK-006-durable-event-dispatcher
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-002-durable-event-runtime
wave: WAVE-003
slug: durable-event-dispatcher
title: Implement the durable lifecycle dispatcher
status: done
depends_on: ["TASK-001-lifecycle-contracts-registry", "TASK-002-lifecycle-event-persistence", "TASK-003-interceptor-engine", "TASK-004-subagent-lifecycle-adapter"]
conflict_domains:
  - "src/lifecycle/lifecycle-dispatcher.ts"
  - "src/lifecycle/handler-executor.ts"
  - "src/core/database/repositories/lifecycle-delivery-repository.ts"
  - "src/core/database/migrations/014-lifecycle-events.sql"
  - "src/core/database/migrations/015-lifecycle-delivery-nonretryable.sql"
  - "tests/unit/core/database/migrations/runner.test.ts"
  - "tests/unit/core/database/repositories/lifecycle-event-repository.test.ts"
assigned_model_class: codexHigh
actual_model: gpt-5.6-terra
reasoning_effort: high
review_model_class: reviewGate
branch: task/TASK-006-durable-event-dispatcher
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-003-durable-event-dispatcher
worktree_status: cleaned_up
worker_thread_id: 019f69ee-81ce-7762-b3bb-7bd63de54a60
review_thread_id: 019f6a38-b01a-77e1-bcb5-9b6639de95b4
pr: https://github.com/ivo-toby/talon/pull/262
current_gate: merged
branch_freshness: merged_current_at_8f74740
verification:
  - "/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin/node ../../node_modules/vitest/vitest.mjs run tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-006-durable-event-dispatcher: Implement the durable lifecycle dispatcher

## Status

done

## Parent Ticket

TICKET-002-durable-event-runtime

## Wave

WAVE-003

## Objective

Implement independent at-least-once delivery with leases, per-aggregate ordering, bounded concurrency, retry/dead-letter, idempotency, backpressure, circuit state, and restart-safe shutdown.

## Scope

- Claim and recover eligible deliveries.
- Execute captured native/sub-agent handlers.
- Enforce ordering plus global/per-handler concurrency.
- Apply retry, dead-letter, circuit, backpressure, and idempotent completion.
- Expose a bounded dispatcher state snapshot.

## Non-Scope

No daemon bootstrap, CLI, retention, or user-queue coupling.

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

- src/lifecycle/lifecycle-dispatcher.ts
- src/lifecycle/dispatcher-policy.ts
- src/lifecycle/handler-executor.ts
- src/core/database/repositories/lifecycle-delivery-repository.ts
- src/core/database/migrations/014-lifecycle-events.sql
- tests/unit/core/database/migrations/runner.test.ts
- tests/unit/lifecycle/lifecycle-dispatcher.test.ts
- tests/unit/core/database/repositories/lifecycle-event-repository.test.ts

## Dependencies

- TASK-001-lifecycle-contracts-registry
- TASK-002-lifecycle-event-persistence
- TASK-003-interceptor-engine
- TASK-004-subagent-lifecycle-adapter

## Conflict Domains

- src/lifecycle/lifecycle-dispatcher.ts
- src/lifecycle/handler-executor.ts
- src/core/database/repositories/lifecycle-delivery-repository.ts
- src/core/database/migrations/014-lifecycle-events.sql
- tests/unit/core/database/repositories/lifecycle-event-repository.test.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-006-durable-event-dispatcher

## Worker Worktree

Terra/high worker `019f69ee-81ce-7762-b3bb-7bd63de54a60` completed reviewed
commit `d4fde6f` on `task/TASK-006-durable-event-dispatcher`. PR #262 merged at
epic commit `8f74740`; the clean task worktree was removed and pruned.

## PR / Patch Reference

[PR #262](https://github.com/ivo-toby/talon/pull/262) targets
`epic/durable-lifecycle-pipeline` from reviewed commit `d4fde6f`.

## RED-GREEN TDD Plan

### RED

Failing tests for leases, ordering, concurrency, retry/dead-letter, one-handler isolation, backpressure/circuit, idempotency, shutdown, and restart.

### GREEN

Implement a poll/wake dispatcher with injected repositories, executors, and policy.

### REFACTOR

Refactor only the new/touched boundary after green; do not broaden scope or change unrelated abstractions.

## Implementation Notes

- Start in the assigned task worktree and confirm this task plus current orchestration state exist.
- Do not switch branches in the controller checkout or start dependent work.
- Preserve unrelated user changes and use typed neverthrow results across module boundaries.
- Audit side effects and keep durable payloads bounded and secret-free.
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
- [x] Shared-context findings are proposed when needed.

## Validation Steps

- /Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin/node ../../node_modules/vitest/vitest.mjs run tests/unit/lifecycle/lifecycle-dispatcher.test.ts tests/unit/core/database/repositories/lifecycle-event-repository.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- 80/80 focused tests passed with the repository-pinned Node 24 runtime after
  the latest remediation: 22 dispatcher tests, 30 real-SQLite repository/
  migration tests, 17 transactional event-bus integration tests, and 11
  migration-runner tests.
- `npm run build` passed.
- Scoped ESLint and Prettier checks passed on changed source and test files;
  unrelated repository-wide lint failures remain outside this task.
- `git diff --check` passed.
- No dependency install or native rebuild was performed.
- Migration-runner coverage now validates v13-to-v15 application, v14-to-v15
  row preservation, recreated triggers/indexes, and foreign-key integrity.
- A pinned Node 24 process probe after the timer fix reported no active Timeout
  resources and exited in 0.04 seconds with a configured five-second shutdown
  window.

## Review Feedback

### P1

- High: handlers receive mutable lease authority and can corrupt completion.
- High: executor selection does not enforce complete captured runtime identity.
- High: successful handler signals are discarded before durable routing.
- High: hung handlers defeat leases and bounded graceful shutdown.
- High: timed-out handlers can continue outside global/per-handler concurrency
  accounting when they ignore cooperative cancellation.

Fresh full-diff review confirmed the success-signal and hung-handler findings
resolved, but reproduced two High blockers: caller mutation of retained options
could redirect a claim token to another repository, and the sub-agent catalog
could not authorize one global handler identity for multiple explicitly attached
personas. The same Terra/high integration owner remediated both, but fresh
full-diff Sol/high review found a new High: the timeout race releases active and
per-handler slots before an abort-ignoring execution actually settles. That
latest High is remediated by retaining the slot until the underlying execution
really settles while preserving bounded shutdown.

### P2

- Medium: retryable and captured failure-policy semantics are ignored.
- Medium: public dispatch bypasses global concurrency.
- Medium: wake notifications can be lost while draining.
- Medium: exclusion overflow can stall healthy claims.
- Medium: hostile policy input can execute and invalid policy throws.
- Medium: required dispatcher and real-SQLite coverage is incomplete.
- Medium: executor construction still collects all property descriptors before
  enforcing key-count bounds.
- Medium: migration 015 leaves the existing migration-runner version/count test
  stale and failing.
- Medium: `dispatchOnce()` can throw across its Result boundary when a captured
  claim dependency throws or returns a malformed value.
- Medium: `stop()` leaves its losing shutdown-timeout timer referenced after
  active work has already settled, delaying natural process termination.

Fresh review confirmed the concurrency, wake, exclusion, and broad coverage
findings resolved. The same Terra/high owner remediated the remaining Mediums
by making public construction descriptor-safe and typed for hostile/non-callable
dependencies and restoring migration 014 while adding a v14-to-v15 migration
015. Fresh full-diff Sol/high review confirmed most of that closure but found
the executor descriptor collection remains unbounded, independently reproduced
the migration-runner regression, and found an unguarded claim Result boundary.
All three are remediated: own keys are bounded before descriptor reads, the
migration runner covers versions 13 through 15, and claim invocation/result
inspection is contained at the typed Result boundary.
Fresh Sol/high review confirmed those three resolved but reproduced the new
shutdown-timer blocker: even an otherwise immediate stop keeps the Node event
loop alive for the complete configured shutdown window because the losing timer
is never cleared.

### P3

- Low: the v14 upgrade test invokes `git show fbe4f08`, which can fail in a
  shallow clone or source archive. Recorded as a follow-up and intentionally
  left untouched under the blocker-only remediation policy.

## Completion Notes

- Initial Sol/high review `019f69e5-5c3d-7471-8041-641d23307bbf` failed
  0C/4H/6M/0L. Terra/high integration owner
  `019f69ee-81ce-7762-b3bb-7bd63de54a60` completed the first remediation pass
  with 42 focused tests, disclosed the remaining multi-attempt non-retryable
  transition gap, then closed that Medium with the narrow migration/trigger
  change. Controller verification passed 42 focused tests, build, scoped lint/
  format, diff, exact scope, and hash gates. Fresh full-diff Sol/high review
  `019f6a01-c53f-7843-a393-c2581696bc16` failed 0C/2H/2M/0L on retained mutable
  dependency authority, multi-persona sub-agent authority, non-total hostile
  construction, and the missing forward migration. All four blockers are
  routed to the same Terra/high owner. The remediation completed with migration
  014 restored byte-for-byte, additive migration 015, immutable captured
  dispatcher authority, exact identity-plus-persona sub-agent authority, and
  total hostile construction. The unchanged seven-file patch was refreshed to
  epic head `d3357fb`; controller verification passed 64 focused tests, build,
  scoped lint/format, diff, and SHA-256 integrity gates. The patch remains
  uncommitted. Fresh full-diff Sol/high review
  `019f6a18-baec-72c3-9ab3-2e3eae5aee04` failed 0C/1H/3M/1L on timeout-slot
  accounting, bounded executor descriptor collection, stale migration-runner
  assertions, and the unguarded claim Result boundary. The Low historical-Git
  fixture dependency is recorded without remediation. Controller reproduction
  confirmed the runner file at 10 passed/1 failed while exact patch hashes and
  status remained unchanged. The same Terra/high owner remediated only those
  four blockers. Independent controller verification now passes 79/79 focused
  tests, build, scoped source lint, Prettier, diff, byte-identical migration
  014, exact eight-file scope, and SHA-256 integrity gates. The Low remains
  untouched. Fresh full-diff Sol/high review
  `019f6a2d-6e14-7de0-aa47-65b6f4da01bb` failed 0C/0H/1M/1L after a bounded
  runtime probe showed a 5-second policy holding the process for 5.05 seconds
  even with no active work. Only that Medium is routed to Terra/high; the known
  Low remains untouched. Another fresh full-diff Sol/high review is required
  before commit. The same Terra/high owner then fixed only that Medium by
  retaining and clearing the losing shutdown timer in `finally`; a focused
  fake-timer regression plus independent controller verification now pass
  80/80 tests and reproduce natural process exit in 0.04 seconds with no active
  Timeout resource. Fresh full-diff Sol/high review
  `019f6a38-b01a-77e1-bcb5-9b6639de95b4` passed the commit gate 0C/0H/0M/1L,
  independently reran all 80 focused tests and the process probe, and preserved
  exact status and hashes. The known Low remains untouched.
- Reviewed commit `d4fde6f0082fa0a79825734c0d9a5d249e39f981` passed Verify PR
  run `29487277395` and PR Agent run `29487277478` with zero review threads.
  PR #262 merged into the epic branch at
  `8f74740fe2d7591cf41995cf77e1887012e5b2b0`; the clean worktree was removed
  and pruned. The PR Agent's system comment that it could not generate code
  suggestions was non-actionable and did not change the successful check gate.
