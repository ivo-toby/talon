# TASK-019: Read-only saved Signal delivery summary

## Objective

Provide the missing public repository contract for truthful saved-delivery status without changing execution or storage behavior.

## Deliverable

A narrow Result-returning read-only QueueRepository aggregate covering all saved Signal delivery work, including ineligible/active/blocked rows, with safe counts/reason groups and real migrated-SQLite regressions.

## Interfaces

Consumes:
- Approved spec/design safe local saved pending/terminal status requirement and actual merged TASK-006 checkpoint/state/queue producers, with TASK-017 cleanup correction unchanged.
- Confirmed whole TASK-011 review F1 and parent actual SQLite evidence in research/saved-delivery-status-summary.md. Read actual producers, not an invented report API.

Produces:
- A public typed repository read API returning safe pending/terminal counts and actual fixed terminal-reason counts, structurally usable by TASK-011's optional saved DTO. Exact narrow export signature is implementation judgment after tracing the actual state codec; no dependency on IPC/CLI modules.
- Expected failures remain neverthrow Result with actual typed error identities. Invalid reserved state/database failure is unavailable/error, not fabricated healthy zeros. Legacy ordinary malformed/nonobject payload compatibility remains intact.

## Scope

Read a consistent current database snapshot through this repository's actual connection. Count saved ready/in_flight/delivered-awaiting-local-finalization as pending while unfinished, regardless claim status, future retry deadline, provider attempts or head-of-line eligibility. Retained terminal checkpoints count terminal and group only safe actual SignalDeliveryReason values until purge; successful completed delivered work is not pending. Ordinary work/standalone invocation markers are not saved replies. Trace actual valid lifecycle/status combinations and make any ambiguity explicit before implementing.

Use actual reserved-payload detection/checkpoint validation semantics. Do not silently count corrupt raw phase labels as valid work; define truthful safe failure when reserved state cannot be validated. Do not parse/coerce/repair legacy ordinary payloads or log them. Keep retained memory bounded while scanning; no all-body/history materialization, unbounded retained cache, new storage or quota increase. A read must NOT mutate status/checkpoint/run/reservation/lease/expiry/clock or invoke recovery; actual lifecycle transitions remain their current owners' authority.

Preserve every original repository assertion/body (89 cases) except necessary new imports; append meaningful coverage. Importable method skeleton before behavioral RED if needed, not collection/missing-export errors masquerading as RED. Prove actual deferred/future, claimed/processing, behind-head, delivered-finalization, terminal reasons, completed/purged work, ordinary mixed statuses, malformed reserved/ordinary compatibility, read-only state snapshots and genuine database failure. No literal fabricated DTO counts offered as proof. Parent independently verifies actual aggregate-to-CLI DTO compatibility when TASK-011 consumes the accepted producer.

## Non-scope

Only these two files. No schema/migration/index, codec/version/size/TTL, ordinary queue behavior, retry/attempt/ordering/purge/recovery/send/guard/actor/connector/IPC/CLI/runtime/docs changes; no new audit API/cache/outbox, private-handle/raw-SQL consumer workaround, external network contract, real Signal/accounts/keys, service/container/install/deletion/worktree release, full npm test, push/PR/main merge, model/governance change. Ivo approved this prerequisite; preserve all original18 task definitions/history. Missing additional scope goes to controller before edits.

## Files to read first

- Actual AGENTS.md and /home/ivo/.agents/skills/ivo-code-style/SKILL.md.
- Complete immutable dispatch inputs; actual QueueRepository entire source/tests, checkpoint codec/state/payload namespace, transaction/base helpers and TASK-006/017 producer semantics.
- Parent supplies complete TASK-011 B handoff/review and current IPC saved DTO as READ-ONLY consumer evidence, not ownership or permission to alter them.

## Conflict domains

- src/core/database/repositories/queue-repository.ts
- tests/unit/core/database/repositories/queue-repository.test.ts

## Verification

```sh
npx vitest run tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/queue/signal-delivery-checkpoint.test.ts tests/unit/core/database/transaction.test.ts
```

```sh
npm run build
```

```sh
node dist/cli/index.js --help
```

Run changed-source ESLint and supplied strict source/test compilation first. Existing89 repository assertions, unchanged codec/transaction suites and existing build/packaged help are independent checks the worker did not author. Parent additionally repeats actual queue/aggregate boundary checks and separately serialized existing fake-terminal direct WebSocket startup/status/cleanup before/after exact commit. No full slow suite or real-device AC15 claim.

## Definition of done

- Exactly two owned files changed; actual aggregate/API/errors/phase and corruption semantics/read-only memory/snapshot trade-offs, meaningful RED/GREEN and all numbered Decisions reported through EOF.
- Before ANY staging/commit stop with standalone READY_FOR_REVIEW then NEEDS_CONTEXT. Fresh independent GPT-6.1-sol xhigh whole-two review required; parent source/byte/gates/smoke and explicit exact-byte commit-only authority follow. Subsequent exact-commit review/freshness/WDD local integration remain separate.
- Never run WDD/agents, change approved inputs, stage/commit without authority, push/merge or work outside assigned cwd. No task/feature/runtime/live completion claim from component tests.
