---
id: TASK-001-lifecycle-contracts-registry
kind: task
epic: EPIC-durable-lifecycle-pipeline
ticket: TICKET-001-extension-contracts
wave: WAVE-001
slug: lifecycle-contracts-registry
title: Define lifecycle contracts, configuration, and handler registry
status: in_progress
depends_on: []
conflict_domains:
  - "src/lifecycle/contracts/**"
  - "src/lifecycle/handler-registry.ts"
  - "src/core/config/config-schema.ts"
assigned_model_class: codexHigh
actual_model: gpt-5.4
feedback_fix_model: gpt-5.6-terra
feedback_fix_reasoning_effort: high
review_model_class: reviewGate
review_thread: 019f6800-bd99-7523-b542-55e884c482b8
feedback_fix_thread: 019f67fb-cc15-74b1-a730-486a4499b7c7
branch: task/TASK-001-lifecycle-contracts-registry
worker_worktree: /Users/ivo.toby/workspace/talon/.worktrees/WAVE-001-lifecycle-contracts-registry
worktree_status: active
pr: https://github.com/ivo-toby/talon/pull/257
current_gate: controller_checkpoint_review_pending
branch_freshness: behind_8b317e8_by_two_controller_artifact_commits
verification:
  - "npx vitest run tests/unit/lifecycle/handler-registry.test.ts tests/unit/core/config/config-schema.test.ts"
  - "npm run build"
  - "npm run lint"
  - "git diff --check"
---

# TASK-001-lifecycle-contracts-registry: Define lifecycle contracts, configuration, and handler registry

## Status

in_progress

## Parent Ticket

TICKET-001-extension-contracts

## Wave

WAVE-001

## Objective

Create versioned event, signal, interceptor, handler, subscription, identity, filter, budget, and failure-policy contracts plus deterministic registry/config validation.

## Scope

- Add lifecycle contract and registry modules.
- Add global handler definitions and explicit persona attachment to config validation.
- Reject duplicate IDs, incompatible contracts, unsafe policies, invalid filters, and missing handlers.
- Preserve configs with lifecycle omitted.

## Non-Scope

No persistence, dispatch, boundary wiring, remote handlers, or arbitrary filter expressions.

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

- src/lifecycle/contracts/**
- src/lifecycle/handler-registry.ts
- src/core/config/config-schema.ts
- src/personas/persona-loader.ts
- tests/unit/lifecycle/handler-registry.test.ts

## Dependencies

- None.

## Conflict Domains

- src/lifecycle/contracts/**
- src/lifecycle/handler-registry.ts
- src/core/config/config-schema.ts

## Assigned Model Class

codexHigh

## Branch

task/TASK-001-lifecycle-contracts-registry

## Worker Worktree

/Users/ivo.toby/workspace/talon/.worktrees/WAVE-001-lifecycle-contracts-registry (active on task/TASK-001-lifecycle-contracts-registry at implementation head d68929f; created from activation head e28d331 and currently two controller-artifact commits behind epic head 8b317e8).

## PR / Patch Reference

Draft PR #257 targets epic/durable-lifecycle-pipeline: https://github.com/ivo-toby/talon/pull/257

## RED-GREEN TDD Plan

### RED

Failing registry/config tests for priority, identity, explicit attachment, compatibility, validation, and legacy config acceptance.

### GREEN

Implement the smallest typed schemas and deterministic registry resolution API.

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

- npx vitest run tests/unit/lifecycle/handler-registry.test.ts tests/unit/core/config/config-schema.test.ts
- npm run build
- npm run lint
- git diff --check

## Verification Evidence

- Before controller feedback: 104 focused tests passed, `npm run build` passed, `git diff --check` passed, and the GitHub Verify PR job passed.
- Repo-wide lint retained unrelated baseline failures; no lifecycle-file lint failures were reported.
- Hardened feedback patch: 115 focused tests, build, scoped source lint, and diff check passed before Sol/high re-review.
- Sol/high re-review `019f675f-60c7-7361-9eaa-5c81e6cf592c` failed with four High, three Medium, and one Low finding. After the primary Terra/high remediation reached 119 focused passing tests, narrow Terra/high worker `019f676f-ea2c-7513-a806-e518ac56c786` was dispatched for subagent authority, multi-capability native registration, and bounded-JSON prevalidation gaps before another independent Sol/high review.
- The resulting patch passed 120 focused tests, build, TypeScript, scoped source lint, cumulative changed-file Prettier, and diff check. Sol/high review `019f677d-b296-79f1-b783-3e000db884f4` still failed with zero Critical, zero High, three Medium, and two Low findings after direct boundary probes; Terra/high remediation worker `019f6787-8124-70b3-8061-1b0880516303` is active.
- Terra/high remediation completed with 121 focused tests, build, TypeScript, cumulative task source lint/Prettier, and diff check passing. Controller probes independently confirmed all three prior exploits reject or isolate safely. Fresh Sol/high review `019f678f-2a77-7121-a206-c2a5de59bbea` is in progress; no commit is allowed until it reports zero Critical, High, and Medium findings.
- Sol/high review `019f678f-2a77-7121-a206-c2a5de59bbea` failed with zero Critical, zero High, one Medium, and one Low finding: hook correlation re-read the original proxy after normalized validation, and empty patch objects still passed. Terra/high worker `019f6799-3f23-7e32-8ea7-dfa154c40fec` is addressing both.
- Terra/high remediation completed with 121 focused tests and all cumulative gates passing. Exhaustive Sol/high review `019f679f-2288-7662-a5c2-9a52c332e859` confirmed both prior fixes, then failed with zero Critical, zero High, one Medium, and four Low findings. Terra/high worker `019f67af-5c18-77d2-bede-324dafcd5c48` is addressing all five before another fresh review.
- Terra/high worker `019f67af-5c18-77d2-bede-324dafcd5c48` completed all five findings. The patch passed 125 focused tests, build, TypeScript, cumulative source lint/Prettier, diff/no-WDD checks, and independent controller probes. Sol/high review `019f67b6-1c61-76c1-9b0f-e574b1a735ed` passed the commit gate with 0 Critical, 0 High, 0 Medium, and 2 Low findings.
- The same Terra/high worker resolved both Low findings: interceptor owner fields now match the root config domain, and the public registry factory structurally rejects malformed direct input. Controller verification passed 126 focused tests, build, TypeScript, cumulative source lint/Prettier, diff/no-WDD checks, and exact owner-domain/version probes.
- Final Sol/high review `019f67c2-c1ae-7b33-8363-b6e71bc66e99` failed with 0 Critical, 1 High, 2 Medium, and 2 Low findings after reproducing authority-catalog TOCTOU and forged causal signal context. Terra/high worker `019f67af-5c18-77d2-bede-324dafcd5c48` resumed for all code findings; the documentation Low remains assigned to TASK-020.
- Terra/high remediation completed all four code findings. Controller verification passed 128 focused tests, build, TypeScript, cumulative source lint/Prettier, diff/no-WDD checks, and direct authority-accessor, infinite-iterator, and signal-causality probes.
- Sol/high review `019f67d4-7470-75d0-8190-528b95926974` failed with 0 Critical, 0 High, 1 Medium, and 1 Low finding. The Medium reproduced authority-container getter/proxy execution before rejection; the Low found Unicode C1 controls accepted by runtime-name validation. Terra/high worker `019f67af-5c18-77d2-bede-324dafcd5c48` is resuming for both findings.
- Terra/high remediation completed both findings. Controller verification again passed 128 focused tests, build, TypeScript, cumulative source lint/Prettier, and diff/no-WDD checks. Direct probes confirmed top-level/catalog/iterator-step accessors and proxy traps reject with zero reads, rejected iterator cleanup runs once, ordinary generators remain accepted, and U+0080/U+0085/U+009F reject. Fresh Sol/high review `019f67e5-e3be-7dc1-bbb3-32e75efe636f` is active.
- Sol/high review `019f67e5-e3be-7dc1-bbb3-32e75efe636f` failed with 0 Critical, 0 High, 2 Medium, and 0 Low findings. Callable proxies still executed through iterator factory/next/return `Reflect.apply`, and a non-boolean truthy iterator `done` value could be accepted as a capability record. Terra/high worker `019f67af-5c18-77d2-bede-324dafcd5c48` is resuming for both.
- Terra/high remediation completed both findings. Controller verification again passed 128 focused tests, build, TypeScript, cumulative lint/Prettier, and diff/no-WDD checks. Direct probes confirmed iterator factory/next/return callable proxies reject with zero apply traps, malformed `done` rejects after one step, and ordinary arrays/generators remain accepted. Fresh Sol/high review `019f67f2-3e83-7253-afd9-8a51e8b5c9f1` is active.
- Sol/high review `019f67f2-3e83-7253-afd9-8a51e8b5c9f1` failed with 0 Critical, 0 High, 2 Medium, and 0 Low findings. Inherited iterator completion could register a terminal value as runtime authority, and lifecycle-omitted legacy configs received lifecycle-specific duplicate-name validation. Fresh Terra/high worker `019f67fb-cc15-74b1-a730-486a4499b7c7` is addressing both before another review.
- Terra/high worker `019f67fb-cc15-74b1-a730-486a4499b7c7` completed both findings. Controller verification passed 130 focused tests, build, TypeScript, cumulative source lint/Prettier, diff/no-WDD checks, and confirmed inherited completion, accessor/proxy non-execution, omitted/disabled compatibility, and enabled duplicate rejection. Fresh Sol/high review `019f6800-bd99-7523-b542-55e884c482b8` is active.
- Sol/high review `019f6800-bd99-7523-b542-55e884c482b8` passed the code commit gate with 0 Critical, 0 High, 0 Medium, and 1 Low finding after independently confirming both remediations. The Low records in-process proxy hardening for bounded interceptor JSON and does not block the repository commit gate.

## Review Feedback

### P1

- High: make bootstrap native registration capability-bearing so YAML cannot promote a benign implementation into enforcement.
- High: correlate interceptor result transforms with the actual invoked hook.
- High: support bounded recursive tool arguments and bounded run-context additions required by real runtime shapes.
- High: persist authoritative mode, contract, safety, and implementation identity for replay and hot reload.
- High: materialize runtime authority once so validation and construction consume the same canonical catalog snapshot, with no enabled-handler fallback.

### P2

- Medium: reject duplicate persona names before the name-keyed registry can silently replace an enforcing interceptor set.
- Medium: reject emitted signals that do not preserve aggregate/correlation, exact causation identity, and incremented recursion context.
- Medium: bound and close arbitrary runtime-catalog iterables before returning a typed registry result.
- Medium: reject accessor/proxy authority-catalog containers and iterator steps without executing their getters or traps.
- Medium: reject callable proxies in iterator factory, next, and cleanup return data properties before `Reflect.apply`.
- Medium: reject non-boolean iterator `done` values so terminal return values cannot become authority records.
- Medium: honor or safely reject inherited iterator completion without invoking accessors or proxy traps so terminal values cannot become authority records.
- Medium: preserve legacy schema compatibility by applying lifecycle-specific duplicate persona/channel validation only when lifecycle configuration is present under the task contract.

### P3

- Reject empty run context-addition and tool argument-patch transforms that would produce no-op audit records.
- Reject `interceptorSafety` on event and signal handlers.
- Format the cumulative task files that still fail Prettier.
- Documentation is intentionally deferred to TASK-020, the epic-owned documentation and adoption task.
- Make public safe parsing closures total for hostile top-level proxies.
- Bound all lifecycle filter collections.
- Let persona/channel filters represent the full owning config-schema name domain without weakening executable runtime refs.
- Deep-freeze detached normalized `parseInput` data.
- Let interceptor persona/channel fields represent every valid owner name while retaining strict provider/tool runtime names.
- Structurally validate and normalize direct public registry-factory input so unsupported handler versions return `LifecycleError`.
- Bound lifecycle handler, persona subscription, and subscription-target collections.
- Reject Unicode C1 control characters in runtime names.
- Reject proxy-valued bounded interceptor JSON before reflection, including nested arrays/objects, and assert zero proxy traps; this is a non-blocking in-process hardening follow-up.

## Completion Notes

Controller Sol/high review comments: https://github.com/ivo-toby/talon/pull/257#issuecomment-4984410897 and https://github.com/ivo-toby/talon/pull/257#issuecomment-4984865082. Terra/high worker `019f67fb-cc15-74b1-a730-486a4499b7c7` fixed both findings from Sol/high review `019f67f2-3e83-7253-afd9-8a51e8b5c9f1`; Sol/high review `019f6800-bd99-7523-b542-55e884c482b8` passed 0C/0H/0M/1L over the independently verified 130-test patch. Documentation remains deferred to TASK-020. The controller owns artifact reconciliation and merge.
