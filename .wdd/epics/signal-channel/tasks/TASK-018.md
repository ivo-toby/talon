# TASK-018: Result-gated sender persistence repair and safe health

## Objective

Repair retained sender database obligations after a persistence outage without repeating network/provider work, and expose truthful safe health for lifecycle consumers.

## Deliverable

A narrow sender-owned, Result-gated retained-write handoff plus safe persistence-health API and real-SQLite regressions showing database repair permits a legitimate stopped-owner handoff while preserving observed outcomes, restrictions and no-replay boundaries.

## Interfaces

Consumes:
- Approved spec/design account gating, write-only retries, stop/reload and saved-delivery/purge invariants; confirmed review F1/F2 and independent evidence in research/sender-persistence-handoff.md.
- Actual merged TASK-007 coordinator and TASK-005/006/017 same-connection account/lease/queue Result producers, checkpoint codec and RPC/classification types. Trace actual APIs and all affected call paths; no speculative duplicate or raw-SQL workaround.

Produces:
- A narrow actual typed sender API allowing database-only repair and an authoritative successful handoff after every retained obligation has settled. A stopped/poisoned sender never reopens admissions. Existing drain remains fail closed on any unresolved error; expected error identity is preserved.
- Safe read/publication health sufficient for TASK-008 to distinguish actual persistence poisoning from ordinary non-poisoning preflight STATE_WRITE_FAILED results. Do not expose raw causes, identities, message contents or receipts in health.
- Existing delivery/text/protocol policies unchanged; B consumes the actual new API only after parent gates/integration and its own fresh review.

## Scope

Trace every poison/write-retry/settlement/finish/drain path, including failed metadata restriction persistence before reservation, classified send outcomes, ready terminalization, final invocation lease cleanup, saved/generic/prepared paths and multiple pending finish jobs. Retain the original sanitized classified result/restrictions/ownership/write obligation when bounded active work cannot persist, rather than reconstructing it by RPC or substituting generic startup UNKNOWN recovery. Subsequent repair performs only the retained database work through actual same-connection Result APIs with bounded retry rate. Successful handoff requires no active/pending/retained writes or unresolved authority. It must not clear failure merely because an external caller says recovered, because row counts are zero, or by bypassing strict CAS; non-DATABASE authority conflicts remain fail closed.

Preserve exact observed acceptance/counts, every independent rate/challenge/recovery hint, original detection time where policy depends on it, strict lease/reservation/checkpoint ownership, purge cancellation cleanup and physical-row versus read-error distinction. No provider, lookup or send is repeated to recover evidence. Do not revive purged rows/history, overwrite newer restrictions, renew saved TTL, resume an accepted/ambiguous chunk, release a foreign lease or silently discard retained obligations. Preserve actual committed-cleanup DeliveryCancelled semantics when composing Results; no accidental rollback/reapply corruption. Keep retained memory/operation lifetime bounded by the actual sender's existing admission/text limits; do not retain uncharged duplicate bodies or unbounded retry callbacks. The repair and drain must be concurrency-safe, idempotent and no-network after stop.

Use meaningful real migrated-SQLite RED/GREEN cases: complete accepted/explicitly refused/partial/unknown classifications, independent hints, saved reply/background and explicit/progress cleanup, metadata/preflight versus post-submission faults, stop deadline, ordinary-operation poison health, DB repair then successful Result handoff, repeated repairs/drains and no additional RPC/provider work. Cover purge/newer ownership/non-DATABASE conflict and multiple retained jobs. Keep all original138 sender assertions intact; append/tighten only new correction coverage. Existing adjacent tests are independent unchanged producer assertions. Do not require or edit TASK-008 candidate files; describe actual caller obligations/API in the handoff for retained B.

## Non-scope

No connector/verifier/actor/runner/IPC/factory/runtime/docs edits, generic repository/schema change, fresh-handle ownership bypass, unconditional map/error clearing, unchecked recovered boolean, protocol/config/text/chunk/checkpoint cap/version/TTL changes, replay/new network/test message, service/container/install/deletion/worktree release, full slow suite, push/PR/main merge or governance/model changes. Ivo explicitly approved this two-file TASK-018 repair/API addition; preserve all original sixteen plus TASK-017 definitions and completed TASK-007 history. Missing contracts beyond these two files go to the controller, not silent scope expansion.

## Files to read first

- AGENTS.md and /home/ivo/.agents/skills/ivo-code-style/SKILL.md.
- Complete immutable dispatch brief/spec/design/constraints/inventory/finding; actual coordinator, original tests, account/lease/queue Result producers/codec/transaction and adjacent tests.
- Read complete current TASK-008 A/B handoffs and whole-five F1/F2 review supplied by controller as read-only consumer evidence. Do not modify their candidate or invent their API needs.

## Conflict domains

- src/channels/connectors/signal/signal-send-coordinator.ts
- tests/unit/channels/connectors/signal/signal-send-coordinator.test.ts

## Verification

```sh
npx vitest run tests/unit/channels/connectors/signal/signal-send-coordinator.test.ts tests/unit/channels/connectors/signal/signal-send-result.test.ts tests/unit/channels/connectors/signal/signal-target.test.ts tests/unit/channels/connectors/signal/signal-text.test.ts
```

```sh
npm run build
```

```sh
node dist/cli/index.js --help
```

Run changed-source ESLint and targeted strict source/test compilation first. The unchanged send-result/target/text tests, existing TypeScript build and packaged CLI help are independent assertions this worker did not author. Controller independently repeats relevant actual repository/queue checks and the serialized existing fake-terminal startup smoke before/after exact commit. No fake fixture satisfies mandatory real-device AC-15. Only focused tests; no full npm test.

## Definition of done

- Only the two owned paths change; root cause and all relevant write/health/handoff paths verified; report exact RED/GREEN/check counts, retained-memory/concurrency/ownership constraints and EVERY numbered Decision.
- Before ANY staging/commit stop NEEDS_CONTEXT with standalone READY_FOR_REVIEW; fresh independent GPT-6.1-sol xhigh review required. Commit only exact reviewed bytes after explicit controller commit-only authority; fresh exact-commit review/parent exact-byte tests/build/help/smoke/freshness precede local integration.
- Never run WDD, launch agents, stage/commit without authority, push/merge, alter approved inputs or work in another assigned owner's cwd. Report genuinely missing contracts rather than broadening scope.
