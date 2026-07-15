---
id: TASK-008-run-tool-outbound-events
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-003-core-boundary-integration
wave: WAVE-005
slug: run-tool-outbound-events
title: Wire run, provider-tool, and outbound lifecycle boundaries
status: todo
depends_on: ["TASK-007-daemon-message-queue-schedule-events"]
conflict_domains:
  - "src/daemon/agent-runner.ts"
  - "src/tools/host-tools-bridge.ts"
  - "src/tools/tool-filter.ts"
  - "src/tools/host-tools/channel-send.ts"
assigned_model_class: codexHigh
review_model_class: reviewGate
branch: task/TASK-008-run-tool-outbound-events
worker_worktree: null
worktree_status: unassigned
pr: null
current_gate: not_started
branch_freshness: unknown
verification:
  - "npx vitest run tests/unit/daemon/agent-runner.test.ts tests/unit/tools/host-tools-bridge.test.ts tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools/channel-send.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-008-run-tool-outbound-events: Wire run, provider-tool, and outbound lifecycle boundaries

## Status

todo

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

None assigned. The controller must create or verify an isolated worktree before dispatch and provide its path.

## PR / Patch Reference

None. The task PR targets epic/durable-lifecycle-pipeline.

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
- Request reviewGate/`gpt-5.6-sol` review with high reasoning before commit; resolve all P1/P2 or Critical/High/Medium findings.

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

- npx vitest run tests/unit/daemon/agent-runner.test.ts tests/unit/tools/host-tools-bridge.test.ts tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools/channel-send.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Not run yet.

## Review Feedback

### P1

- None.

### P2

- None.

### P3

- None.

## Completion Notes

- None yet.
