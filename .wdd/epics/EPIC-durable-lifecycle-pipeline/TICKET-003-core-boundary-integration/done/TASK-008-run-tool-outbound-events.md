---
id: TASK-008-run-tool-outbound-events
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-003-core-boundary-integration
wave: WAVE-005
slug: run-tool-outbound-events
title: Wire run, provider-tool, and outbound lifecycle boundaries
status: done
depends_on: ["TASK-007-daemon-message-queue-schedule-events"]
conflict_domains:
  - "src/daemon/agent-runner.ts"
  - "src/tools/host-tools-bridge.ts"
  - "src/tools/tool-filter.ts"
  - "src/tools/host-tools/channel-send.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-008-run-tool-outbound-events
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-005-run-tool-outbound-events
worktree_status: cleaned_up
pr: https://github.com/ivo-toby/talon/pull/268
current_gate: merged
branch_freshness: merged_current_at_6921a9e
verification:
  - "npx vitest run tests/unit/daemon/agent-runner.test.ts tests/unit/tools/host-tools-bridge.test.ts tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools/channel-send.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-008-run-tool-outbound-events: Wire run, provider-tool, and outbound lifecycle boundaries

## Status

done

## Parent Ticket

TICKET-003-core-boundary-integration

## Wave

WAVE-005

## Objective

Publish run/tool/outbound events and enforce run, tool, and send interceptors while preserving approvals, delivery idempotency, audit, and originating-run semantics.

## Scope

- Publish run started/completed/failed, tool started/completed, and message sent/send_failed.
- Run run.before_execute, tool.before_execute, and message.before_send.
- Keep default-deny tool approval authoritative.
- Bound/redact event material and preserve trace correlation.
- Prevent async replay from double-sending.

## Non-Scope

No context migration, behavior learning, or historical trace access.

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
- src/tools/host-tools-bridge.ts
- src/tools/host-tools-mcp-server.ts
- src/tools/tool-filter.ts
- src/tools/host-tools/channel-send.ts
- tests/unit/daemon/agent-runner.test.ts
- tests/unit/tools/**

## Dependencies

- TASK-007-daemon-message-queue-schedule-events

## Conflict Domains

- src/daemon/agent-runner.ts
- src/tools/host-tools-bridge.ts
- src/tools/tool-filter.ts
- src/tools/host-tools/channel-send.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-008-run-tool-outbound-events

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-005-run-tool-outbound-events

## PR / Patch Reference

PR #268: https://github.com/ivo-toby/talon/pull/268

Merged into `epic/durable-lifecycle-pipeline` at
`6921a9ec7a8c053ae7af616abfb832a7bf548c19` on 2026-07-25.

## RED-GREEN TDD Plan

### RED

Failing tests for event outcomes, deny/approval/transform, timeout policy, secret redaction, correlation, disabled behavior, and no double-send.

### GREEN

Add lifecycle calls at existing authoritative transitions.

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

- npx vitest run tests/unit/daemon/agent-runner.test.ts tests/unit/tools/host-tools-bridge.test.ts tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools/channel-send.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Focused tests passed after remediation and after rebase to the current epic
  head: `npx vitest run tests/unit/daemon/agent-runner.test.ts
  tests/unit/tools/host-tools-bridge.test.ts
  tests/unit/tools/host-tools/channel-send.test.ts
  tests/unit/core/database/repositories/message-repository.test.ts`
  (4 files, 164 tests).
- Scoped ESLint exited 0 with repo-standard ignored-test warnings only.
- `npm run build` passed.
- `git diff --check` passed.
- GitHub Verify PR passed on PR #268 after rebase to epic head `08c564a`.

## Review Feedback

### P1

- None.

### P2

- GPT-5.5/xhigh full review initially found one Medium blocker: streamed runs
  with no final text segment could duplicate already-flushed outbound text in
  the persisted transcript. Fixed by skipping the synthetic final fallback row
  when intermediate outbound reservations exist, with a regression test for
  `text -> tool_use -> tool_result -> empty result`.
- GPT-5.5/xhigh post-remediation review passed with no Critical, High, or
  Medium blockers.

### P3

- None.

## Completion Notes

- Publishes run started/completed/failed, provider tool started/completed, and
  outbound message sent/send_failed lifecycle events from the authoritative run
  and host-tool boundaries.
- Routes `run.before_execute`, `tool.before_execute`, and outbound
  `message.before_send` through existing run/tool/send paths while preserving
  default-deny capability checks.
- Outbound delivery uses stable queue-item-scoped idempotency keys for final,
  streamed, waiting, and tool-notice messages to prevent retry double-sends.
- Clean task worktree was removed and pruned during WAVE-005 reconciliation.
