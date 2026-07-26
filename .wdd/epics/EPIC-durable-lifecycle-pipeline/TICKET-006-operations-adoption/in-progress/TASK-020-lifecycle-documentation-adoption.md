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
worktree_status: allocated_metadata_only
pr: null
current_gate: activation_sync_review_pending
branch_freshness: branch_not_created_activation_sync_review_pending
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

Allocated in controller metadata only. GPT-5.5/xhigh activation checkpoint
review `019f9dc8-87c5-76f3-8724-e178beced852` passed 0C/0H/0M/0L. The
reviewed activation checkpoint
`4c72c9de10cd0b2439929d0a7d20a4616579da9f` is committed, pushed, and recorded.
The controller must not create this branch/worktree until the activation-sync
checkpoint has passed GPT-5.5/xhigh review and been committed/pushed.

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
