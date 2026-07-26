---
id: TASK-015-behavior-signal-projector
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-005-behavior-learning
wave: WAVE-007
slug: behavior-signal-projector
title: Implement feedback projection and evidence deduplication
status: in-progress
depends_on: ["TASK-007-daemon-message-queue-schedule-events", "TASK-010-behavior-ledger-persistence", "TASK-012-feedback-detector-subagent"]
conflict_domains:
  - "src/lifecycle/behavior/**"
  - "src/core/config/config-schema.ts"
  - "tests/integration/lifecycle-behavior-feedback.test.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-015-behavior-signal-projector
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-007-behavior-signal-projector
worktree_status: allocated_pending_creation
pr: null
current_gate: activation_checkpoint_pending
branch_freshness: pending_activation_checkpoint
verification:
  - "npx vitest run tests/unit/lifecycle/behavior tests/integration/lifecycle-behavior-feedback.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-015-behavior-signal-projector: Implement feedback projection and evidence deduplication

## Status

in-progress

## Parent Ticket

TICKET-005-behavior-learning

## Wave

WAVE-007

## Objective

Project validated signals into the persona ledger with provenance, deterministic source fingerprints, schedule/direct copy suppression, distinct-source thresholds, scope enforcement, and notes-only behavior.

## Scope

- Implement native BehaviorSignalProjector.
- Fingerprint source evidence and collapse copies/summaries.
- Store explicit correction candidates; require three independent inferred sources.
- Wire explicit persona subscriptions to bounded lifecycle events.
- Audit suppression and candidate creation.

## Non-Scope

No daily/weekly reduction, promotion, reload, or routine chat output.

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

- src/lifecycle/behavior/behavior-signal-projector.ts
- src/lifecycle/behavior/evidence-fingerprint.ts
- src/lifecycle/behavior/behavior-handler.ts
- src/core/config/config-schema.ts
- tests/unit/lifecycle/behavior/**
- tests/integration/lifecycle-behavior-feedback.test.ts

## Dependencies

- TASK-007-daemon-message-queue-schedule-events
- TASK-010-behavior-ledger-persistence
- TASK-012-feedback-detector-subagent

## Conflict Domains

- src/lifecycle/behavior/**
- src/core/config/config-schema.ts
- tests/integration/lifecycle-behavior-feedback.test.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-015-behavior-signal-projector

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-007-behavior-signal-projector

Allocated by the controller for WAVE-007. Do not create or use this worktree
until the reviewed activation checkpoint has been committed and pushed.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

## RED-GREEN TDD Plan

### RED

Failing tests for correction candidates, three-source inference, copy/summary suppression, isolation, capability denial, provenance, audit, and notes-only output.

### GREEN

Implement deterministic fingerprinting, projector, and explicit subscription glue.

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

- npx vitest run tests/unit/lifecycle/behavior tests/integration/lifecycle-behavior-feedback.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- 2026-07-26: RED observed before implementation:
  `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/behavior tests/integration/lifecycle-behavior-feedback.test.ts --reporter=dot`
  failed because `src/lifecycle/behavior/index.js` and projector entry points
  did not exist.
- 2026-07-26: Focused behavior verification passed:
  `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run tests/unit/lifecycle/behavior tests/integration/lifecycle-behavior-feedback.test.ts`
  - 3 files, 12 tests passed.
- 2026-07-26: Build passed:
  `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build`.
- 2026-07-26: Full lint command was run but remains blocked by pre-existing
  unrelated lint errors outside the task scope, including WhatsApp connector,
  CLI command, context-assembler, provider, file-searcher, session-observer,
  and host-tools files. Scoped ESLint over touched source files passed with 0
  errors:
  `env PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/lifecycle/behavior/evidence-fingerprint.ts src/lifecycle/behavior/behavior-signal-projector.ts src/lifecycle/behavior/index.ts src/core/database/repositories/behavior-signal-repository.ts src/daemon/daemon-bootstrap.ts`.
- 2026-07-26: `git diff --check` passed; untracked new source/test files were
  also checked with `git diff --no-index --check` and produced no whitespace
  warnings.
- 2026-07-26: Remediated GPT-5.5/xhigh High finding by requiring
  `behavior.feedback.detected.v1` projection to come from the configured
  `behavior-feedback-detector` event handler, with signal provenance event and
  handler IDs matching the trusted durable handoff producer. Added integration
  coverage for non-detector producers and mismatched claimed provenance.
- 2026-07-26: Remediated GPT-5.5/xhigh Medium finding by adding idempotent
  append-only candidate evidence linking and changing inferred-pattern
  projection to preserve collecting lineage across handoffs, then ready the
  candidate only after three persisted distinct evidence sources. Added
  repository and projector coverage for cross-handoff accumulation.
- 2026-07-26: Remediation focused tests passed:
  `npx vitest run tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/lifecycle/behavior/behavior-signal-projector.test.ts tests/integration/lifecycle-behavior-feedback.test.ts`
  - 3 files, 25 tests passed.
- 2026-07-26: Remediation build passed: `npm run build`.
- 2026-07-26: Full lint remains blocked by pre-existing unrelated lint errors
  outside this task scope. Remediation scoped source lint passed:
  `npx eslint src/lifecycle/behavior/behavior-signal-projector.ts src/core/database/repositories/behavior-signal-repository.ts --no-warn-ignored`.
- 2026-07-26: Remediation whitespace check passed: `git diff --check`.
- 2026-07-26: Remediated blocking GPT-5.5/xhigh finding by making
  `LifecycleSignalRepository.handoff()` reject same-key replays whose persisted
  signal IDs or JSON-normalized envelope content differ from the incoming
  parsed envelopes. This fails the handoff before
  `createBehaviorSignalRouter()` can project caller-provided retry signals.
- 2026-07-26: Added focused regression coverage:
  `tests/unit/core/database/repositories/lifecycle-signal-repository.test.ts`
  rejects same-key signal ID/content changes, and
  `tests/integration/lifecycle-behavior-feedback.test.ts` proves a durable
  non-behavior handoff cannot be retried as a forged trusted behavior signal.
- 2026-07-26: Remediation focused repository/behavior tests passed:
  `npx vitest run tests/unit/core/database/repositories/lifecycle-signal-repository.test.ts tests/unit/core/database/repositories/behavior-signal-repository.test.ts tests/unit/lifecycle/behavior tests/integration/lifecycle-behavior-feedback.test.ts`
  - 5 files, 37 tests passed.
- 2026-07-26: Remediation build passed: `npm run build`.
- 2026-07-26: Remediation scoped lint passed:
  `npx eslint src/core/database/repositories/lifecycle-signal-repository.ts src/lifecycle/behavior/behavior-signal-projector.ts tests/unit/core/database/repositories/lifecycle-signal-repository.test.ts tests/integration/lifecycle-behavior-feedback.test.ts --no-warn-ignored`.
- 2026-07-26: Daemon bootstrap test was not run because this remediation did
  not edit `src/daemon/daemon-bootstrap.ts`.
- 2026-07-26: Remediation whitespace checks passed: `git diff --check`; the
  untracked integration test was also checked with
  `git diff --no-index --check /dev/null tests/integration/lifecycle-behavior-feedback.test.ts`
  and produced no whitespace warnings.

## Review Feedback

### P1

- None.

### P2

- Remediated blocking GPT-5.5/xhigh finding: same-key lifecycle signal handoff
  retries can no longer substitute different signal IDs/content and reach the
  behavior projector. Repository replay validation now rejects the mismatch
  before router projection, with unit and integration regression coverage.

### P3

- None.

## Blockers

- 2026-07-26: Required GPT-5.5/xhigh review could not complete in this
  sandbox. First attempt failed because `codex exec --sandbox read-only` could
  not write its state DB under `/Users/ivo.toby/.codex`. Retrying with
  `CODEX_HOME=/private/tmp/codex-review-home` initialized session
  `019f9c51-ecb7-72f1-9bc4-83e8398e6201`, then failed on network/DNS while
  connecting to `api.openai.com`: `stream disconnected before completion:
  error sending request for url (https://api.openai.com/v1/responses)`.
- 2026-07-26: Commit/PR handoff is blocked by Git metadata write restrictions:
  `git add ...` failed with `fatal: Unable to create
  '/Users/ivo.toby/workspace/talon/.git/worktrees/WAVE-007-behavior-signal-projector/index.lock':
  Operation not permitted`.

## Completion Notes

- None yet.
