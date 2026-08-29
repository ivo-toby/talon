---
id: TASK-011-context-lifecycle-migration
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-004-context-migration
wave: WAVE-006
slug: context-lifecycle-migration
title: Migrate observational memory to configured lifecycle handlers
status: done
depends_on: ["TASK-008-run-tool-outbound-events", "TASK-009-context-contracts-projector"]
conflict_domains:
  - "src/daemon/agent-runner.ts"
  - "src/daemon/context-roller.ts"
  - "src/daemon/daemon-bootstrap.ts"
  - "src/core/config/config-schema.ts"
  - "src/queue/**"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-011-context-lifecycle-migration
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-006-context-lifecycle-migration
worktree_status: cleaned_up
pr: https://github.com/ivo-toby/talon/pull/271
current_gate: merged
branch_freshness: merged_into_epic_at_3bba6a0a8d2537b6d6aea39d2a916e08b8fb9a2d
verification:
- "npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts"
- "npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/queue/queue-manager.test.ts"
- "npm run build"
- "npm run lint"
- "git diff --check"
---

# TASK-011-context-lifecycle-migration: Migrate observational memory to configured lifecycle handlers

## Status

done

## Parent Ticket

TICKET-004-context-migration

## Wave

WAVE-006

## Objective

Route context thresholds through configured contracts/projector, remove observer/reflector name checks and auto-binding, and translate legacy summarizer config with clear deprecation.

## Scope

- Publish threshold/reduction/rotation lifecycle events.
- Validate configured context handlers/contracts.
- Translate existing contextManagement summarizer/reflection config.
- Remove session-observer and session-reflector core name checks.
- Preserve context, rotation, continuation, and provider-session behavior.
- Start required projection only after the user-visible response is persisted/sent, then keep the current queue item claimed until projection settles so ordering remains durable through queue lease/recovery while collaboration bypass remains available.

## Non-Scope

No behavior learning or removal of legacy summarizer support before deprecation.

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

- src/daemon/agent-runner.ts
- src/daemon/context-roller.ts
- src/daemon/daemon-bootstrap.ts
- src/core/config/config-schema.ts
- src/queue/**
- src/lifecycle/context/**
- tests/unit/daemon/**
- tests/integration/rolling-context-window.test.ts

## Dependencies

- TASK-008-run-tool-outbound-events
- TASK-009-context-contracts-projector

## Conflict Domains

- src/daemon/agent-runner.ts
- src/daemon/context-roller.ts
- src/daemon/daemon-bootstrap.ts
- src/core/config/config-schema.ts
- src/queue/**

## Assigned Model Class

codexHigh

## Branch

task/TASK-011-context-lifecycle-migration

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-006-context-lifecycle-migration

Allocated by the controller for WAVE-006. Do not create or use this worktree
until the reviewed activation checkpoint has been committed and pushed.

## PR / Patch Reference

PR #271: https://github.com/ivo-toby/talon/pull/271

Merged into `epic/durable-lifecycle-pipeline` at `3bba6a0a8d2537b6d6aea39d2a916e08b8fb9a2d` on 2026-07-26.

## RED-GREEN TDD Plan

### RED

Failing tests for contract config, missing handler failure, legacy translation, durable projection, next-item ordering, preserve-session failure, continuation, reduction, and no name checks.

### GREEN

Switch orchestration to native policy plus configured lifecycle contracts/projector.

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

- npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts` — 7 files, 368 tests passed.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts --reporter=dot` — 8 files, 395 tests passed after blocker remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts --reporter=dot` — 8 files, 396 tests passed after disabled-provider context-validation remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build`.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/core/config/config-schema.ts src/core/config/config-loader.ts src/queue/queue-manager.ts src/queue/queue-processor.ts` — 0 errors, 4 explicit-return-type warnings in pre-existing functions.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/queue/queue-manager.ts src/queue/queue-processor.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts` — 0 errors, 8 warnings.
- KNOWN REPO BASELINE: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint -- --quiet` still fails on 74 existing errors outside the TASK-011 touched source files.
- PASS: `git diff --check`.
- BLOCKER REVIEW: final reviewGate/gpt-5.5 xhigh reported 0C/1H/2M/1L. High: projection gate was in-memory/background rather than durable queue-ordered. Medium: shutdown could close resources before projection settled. Medium: missing configured context handlers only warned/skipped. Low: task metadata stale. Remediation is in progress.
- REMEDIATION READY FOR REVIEW: projection ordering, shutdown drain semantics, fail-fast context handler validation, and task metadata were updated. Awaiting fresh reviewGate/gpt-5.5 xhigh before commit.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/1M/0L. Medium: bootstrap fail-fast validation included disabled providers even though ProviderRegistry skips disabled providers.
- REMEDIATION READY FOR REVIEW: disabled providers are now excluded from context-management handler/model validation, matching provider registry behavior; bootstrap regression coverage confirms missing handlers on disabled providers do not fail startup.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/1M/0L. Medium: reduced-observation replay returned `hasOpenThreads: false`, so recovery after a reducer commit but before continuation enqueue could suppress the required stateless-provider continuation.
- REMEDIATION READY FOR REVIEW: reduced-observation tombstones now preserve the original incomplete-task continuation metadata and replay derives `hasOpenThreads` from that tombstone; projector regression coverage asserts replay stays idempotent while preserving the open-thread continuation signal.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts --reporter=dot` — 9 files, 405 tests passed after reduced-observation replay remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after reduced-observation replay remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/lifecycle/context/context-projector.ts src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/queue/queue-manager.ts src/queue/queue-processor.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts` — 0 errors, 9 warnings after reduced-observation replay remediation.
- PASS: `git diff --check origin/epic/durable-lifecycle-pipeline` after reduced-observation replay remediation.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/1M/0L. Medium: disabled providers were ignored by bootstrap handler validation but not by Zod config validation, so stale disabled-provider `contextManagement.enabled: true` blocks could still fail `loadConfig`.
- REMEDIATION READY FOR REVIEW: enabled context-management required-field validation moved to provider-aware schema refinement; disabled providers now skip context-management required-field checks while enabled providers keep the same validation. Config-schema regression coverage asserts the disabled-provider case.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts --reporter=dot` — 9 files, 406 tests passed after provider-aware context-management validation remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after provider-aware context-management validation remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/lifecycle/context/context-projector.ts src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/queue/queue-manager.ts src/queue/queue-processor.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts` — 0 errors, 9 warnings after provider-aware context-management validation remediation.
- PASS: `git diff --check origin/epic/durable-lifecycle-pipeline` after provider-aware context-management validation remediation.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/1H/1M/0L. High: real retry flow bypassed reduced-observation tombstone replay when there were no messages newer than the reduction boundary. Medium: continuation idempotency was scoped to retry-local `runId`, allowing duplicate `continue` work after crash/retry.
- REMEDIATION READY FOR REVIEW: OM no-new-message retry now replays the stable reduced-observation tombstone before returning no-rotation, preserving `hasOpenThreads`; context continuation persistence now uses a stable queue-item-derived id/idempotency key with `insertIfAbsent` and skips duplicate enqueue when the continuation already exists.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts --reporter=dot` — 9 files, 409 tests passed after crash/retry remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after crash/retry remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/lifecycle/context/context-projector.ts src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/queue/queue-manager.ts src/queue/queue-processor.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/daemon-bootstrap.test.ts` — 0 errors, 10 warnings after crash/retry remediation.
- PASS: `git diff --check origin/epic/durable-lifecycle-pipeline` after crash/retry remediation.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/1H/1M/0L. High: no-new-messages tombstone replay could call the projector with empty observations against an unreduced existing observation, blanking durable context. Medium: message persistence and queue enqueue for continuation were not recoverably idempotent if a crash or enqueue failure happened between the two writes.
- REMEDIATION READY FOR REVIEW: no-new-messages replay now first verifies the exact existing observation is a reduced tombstone, and the projector rejects empty fresh observation sets on normal paths. Context continuation queue work now uses a stable queue item id through `QueueManager.enqueueWithId`, so retries recover when the continuation message exists but the queue item is missing while still publishing lifecycle enqueue events on fresh inserts.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/queue/queue-manager.test.ts --reporter=dot` — 5 files, 218 tests passed after tombstone/continuation idempotency remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/core/database/repositories/queue-repository.test.ts --reporter=dot` — 10 files, 433 tests passed after tombstone/continuation idempotency remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after tombstone/continuation idempotency remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/lifecycle/context/context-projector.ts src/queue/queue-manager.ts src/queue/queue-processor.ts src/core/database/repositories/queue-repository.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts` — 0 errors, 13 warnings after tombstone/continuation idempotency remediation.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/1M/0L. Medium: no-new-messages replay recovered reduced tombstones but not already-projected unreduced observations, and replay returned without re-rotating the provider session.
- REMEDIATION READY FOR REVIEW: no-new-messages replay now reads the exact existing observation metadata for both normal and reduced observation projections, derives `hasOpenThreads`, calls `sessionTracker.rotateSession(threadId)`, and returns `rotated:true` without invoking the projector or writing empty observations.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/queue/queue-manager.test.ts --reporter=dot` — 5 files, 218 tests passed after existing-observation replay/session-rotation remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/core/database/repositories/queue-repository.test.ts --reporter=dot` — 10 files, 433 tests passed after existing-observation replay/session-rotation remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after existing-observation replay/session-rotation remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/lifecycle/context/context-projector.ts src/queue/queue-manager.ts src/queue/queue-processor.ts src/core/database/repositories/queue-repository.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts` — 0 errors, 13 warnings after existing-observation replay/session-rotation remediation.
- PASS: `git diff --check origin/epic/durable-lifecycle-pipeline` after existing-observation replay/session-rotation remediation.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/1H/0M/0L. High: DB session restoration after daemon restart only checked the in-memory session rotation marker, so a crash after context projection persistence but before queue completion could restore a stale provider session before replay rotation ran.
- REMEDIATION READY FOR REVIEW: DB session restoration now derives a durable context-rotation boundary from persisted context observation metadata and observation persistence time before querying resumable sessions, preventing restart retries from restoring sessions created before the latest durable context projection. Regression coverage asserts stale DB sessions are not resumed after a persisted context observation exists.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/daemon/agent-runner.test.ts --reporter=dot` — 109 tests passed after durable context-rotation session-boundary remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/core/database/repositories/queue-repository.test.ts --reporter=dot` — 10 files, 434 tests passed after durable context-rotation session-boundary remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after durable context-rotation session-boundary remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/lifecycle/context/context-projector.ts src/queue/queue-manager.ts src/queue/queue-processor.ts src/core/database/repositories/queue-repository.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts` — 0 errors, 13 warnings after durable context-rotation session-boundary remediation.
- PASS: `git diff --check origin/epic/durable-lifecycle-pipeline` after durable context-rotation session-boundary remediation.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/1M/0L. Medium: continuation message persistence and deterministic queue-item ensure failures were still logged/swallowed, so a non-crash enqueue failure could leave a persisted `continue` message with no pending queue work and no retry path.
- REMEDIATION READY FOR REVIEW: `enqueueContextContinuation` now returns `Result<void, Error>` for both message-persistence and queue-ensure failures, and required continuation repair failure now fails the current run/queue item so the idempotent retry path can repair the missing continuation work. Regression coverage asserts both persistence failure and enqueue failure are surfaced.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/daemon/agent-runner.test.ts --reporter=dot` — 111 tests passed after required-continuation retry remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/core/database/repositories/queue-repository.test.ts --reporter=dot` — 10 files, 436 tests passed after required-continuation retry remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after required-continuation retry remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/lifecycle/context/context-projector.ts src/queue/queue-manager.ts src/queue/queue-processor.ts src/core/database/repositories/queue-repository.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts` — 0 errors, 13 warnings after required-continuation retry remediation.
- PASS: `git diff --check origin/epic/durable-lifecycle-pipeline` after required-continuation retry remediation.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/0H/1M/1L. Medium: durable restart session-boundary lookup only inspected observation-mode memory, so default summary-mode rotations could still restore stale DB sessions after restart. Low: stale CLI-ordering test wording; left as non-blocking follow-up per WDD policy.
- REMEDIATION READY FOR REVIEW: restart DB session restoration now derives the durable context-rotation boundary from both observation-mode context projection rows and summary-mode `context-roller` rows, using the later of `rotatedThroughTs` and memory persistence time before DB session lookup. Regression coverage asserts stale DB sessions are not resumed after a persisted summary-mode rotation exists.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/daemon/agent-runner.test.ts --reporter=dot` — 112 tests passed after summary-mode durable context-rotation session-boundary remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/core/database/repositories/queue-repository.test.ts --reporter=dot` — 10 files, 437 tests passed after summary-mode durable context-rotation session-boundary remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after summary-mode durable context-rotation session-boundary remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/lifecycle/context/context-projector.ts src/queue/queue-manager.ts src/queue/queue-processor.ts src/core/database/repositories/queue-repository.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts` — 0 errors, 13 warnings after summary-mode durable context-rotation session-boundary remediation.
- PASS: `git diff --check origin/epic/durable-lifecycle-pipeline` after summary-mode durable context-rotation session-boundary remediation.
- BLOCKER REVIEW: fresh reviewGate/gpt-5.5 xhigh reported 0C/1H/0M/1L. High: required continuation recovery was still threshold-gated on retry, so a retry after rotation persistence plus continuation enqueue failure could complete below the threshold without repairing missing continuation work. Low: stale CLI-ordering test wording remains a non-blocking follow-up.
- REMEDIATION READY FOR REVIEW: rotation metadata now records the originating queue item id; required post-rotation continuation repair now runs outside the threshold branch and reuses the stable continuation id when either the continuation message already exists or the latest durable open-thread rotation marker belongs to the same queue item. This repairs both persisted-message/missing-queue and rotation-persisted/message-missing retry windows without creating unrelated continuations for later turns.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/daemon/agent-runner.test.ts --reporter=dot` — 114 tests passed after threshold-independent continuation repair remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/context/context-projector.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/rolling-context-window.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/core/database/repositories/queue-repository.test.ts --reporter=dot` — 10 files, 439 tests passed after threshold-independent continuation repair remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build` after threshold-independent continuation repair remediation.
- PASS: `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/core/config/config-loader.ts src/core/config/config-schema.ts src/daemon/agent-runner.ts src/daemon/context-roller.ts src/daemon/daemon-bootstrap.ts src/lifecycle/context/context-projector.ts src/queue/queue-manager.ts src/queue/queue-processor.ts src/core/database/repositories/queue-repository.ts src/providers/provider-types.ts tests/unit/core/config/config-loader.test.ts tests/unit/core/config/config-schema.test.ts tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/lifecycle/context/context-projector.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/queue-processor.test.ts` — 0 errors, 13 warnings after threshold-independent continuation repair remediation.
- PASS: `git diff --check origin/epic/durable-lifecycle-pipeline` after threshold-independent continuation repair remediation.
- REVIEW PASS: final reviewGate/`gpt-5.5` xhigh reviewed the full working-tree diff against `origin/epic/durable-lifecycle-pipeline` plus `git diff --check`; result 0 Critical / 0 High / 0 Medium / 0 Low. Prior High was verified fixed: threshold-independent continuation repair now uses stable queue-item-derived continuation ids and durable same-queue-item rotation markers before ensuring continuation queue work.
- MERGED: PR #271 merged into `epic/durable-lifecycle-pipeline` at `3bba6a0a8d2537b6d6aea39d2a916e08b8fb9a2d` after GitHub PR Agent and Verify PR checks passed.
- WAVE-006 INTEGRATED VERIFICATION: after PR #271, #270, and #269 merged, the epic branch passed the combined Wave 6 targeted suite: 19 files / 647 tests, `npm run build`, scoped ESLint with 0 errors and known warnings only, and `git diff --check`.

## Review Feedback

### P1

- Fixed in remediation: direct background projection was removed. Required projection now runs after outbound send while the same queue item remains claimed, so per-thread ordering is durable through queue lease/recovery rather than an in-memory promise.

### P2

- Fixed in remediation: `stopProcessing()` now waits through projection because projection is part of active queue work.
- Fixed in remediation: bootstrap now fails enabled context management when a configured handler is missing or no model in its configured chain resolves.
- Fixed in remediation: bootstrap context-management validation now ignores disabled providers, matching runtime provider registry behavior.
- Fixed in remediation: reduced-observation replay now preserves open-thread continuation state instead of returning `hasOpenThreads: false` unconditionally.
- Fixed in remediation: config-schema context-management required-field checks now run only for enabled providers, so disabled providers are consistently ignored at schema and bootstrap validation layers.
- Fixed in remediation: reduced-observation tombstone replay is now reached in the real no-new-messages retry path, preserving crash-recovery continuation state after reducer commit.
- Fixed in remediation: context continuation persistence now uses a stable queue-item-derived continuation id/idempotency key and skips duplicate enqueue when retry sees the continuation already persisted.
- Fixed in remediation: no-new-messages retry now replays only an exact reduced-observation tombstone; empty fresh observation sets are rejected before any normal observation upsert.
- Fixed in remediation: continuation queue work now has a stable queue item id and is ensured even when the idempotent continuation message already exists, closing the message-persisted/queue-missing crash window.
- Fixed in remediation: no-new-messages retry now replays exact existing observation metadata for both unreduced and reduced observations, re-rotates the provider session, and preserves open-thread continuation state without writing.
- Fixed in remediation: restart DB session restoration now applies the latest durable context observation boundary before looking up a resumable provider session, so crash/retry recovery cannot revive a stale pre-projection session.
- Fixed in remediation: required post-rotation continuation repair failures now fail the current queue item instead of being logged and swallowed, preserving an idempotent retry path when the continuation message exists but queue work could not be ensured.
- Fixed in remediation: restart DB session restoration now also applies default summary-mode rotation boundaries, so crash/retry recovery cannot revive stale sessions after either legacy summary rotation or observation-mode projection.
- Fixed in remediation: required continuation repair now runs independently from the current retry's threshold calculation by using stable continuation ids plus durable queue-item rotation markers.

### P3

- None.

## Completion Notes

- Implemented explicit context-management modes: `summarizer` and `observation`. Observation mode requires configured `observer` and `reducer` handlers plus pinned context contract constants.
- Added compatibility translation for legacy `contextManagement.summarizer: session-observer` to explicit observation mode with `observer: session-observer`, `reducer: session-reflector`, and a deprecation flag logged at bootstrap.
- Removed AgentRunner/bootstrap runtime branching and auto-binding based on `session-observer` / `session-reflector` names. Bootstrap now binds exactly configured summarizer/observer/reducer handler names.
- AgentRunner now publishes context threshold, rotation, and observation-log threshold lifecycle events with bounded scalar metadata and references only.
- Required projection now starts after outbound response persistence/delivery while the current queue item remains claimed until projection settles. This preserves durable same-thread ordering through the queue lease/recovery path, allows the existing collaboration bypass for await-reply deadlock avoidance, and keeps projection failure from invalidating the completed provider response.
- Updated README and `config/talond.example.yaml` for explicit observation-mode configuration and legacy deprecation.
