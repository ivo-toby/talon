# Confirmed saved-delivery status producer gap

Ivo explicitly selected **Add TASK-019 and continue (recommended)** after the controller explained the missing public queue summary API and proposed exactly queue-repository.ts plus its tests. This approves the bounded read-only prerequisite through normal WDD review/verification/local-integration, not commit authority. Preserve all original eighteen task definitions/history, specification/design, model routes and concurrency.

## Finding and independent evidence

Whole TASK-011 A+B review c0ba3504-bf52-4152-bc78-985b06c8c37d, workflow73b18363-693b-42a1-b6b5-005b690636e8, BLOCK F1: the new local status DTO promises saved pending/terminal counts with safe terminal reasons, but accepted public QueueRepository exposes eligibility discovery, known-ID reads, generic status counts and dead letters—not complete saved-work enumeration/aggregation. TASK-012 cannot implement correct counts without an actual producer seam. Runtime raw SQL/private handles or guessed zero counts are not approved substitutes.

Parent read every actual public QueueRepository method and independently ran actual compiled accepted repository methods against migrated SQLite. Three valid saved checkpoints existed: deferred future retry, claimed active and ready work blocked behind the deferred head. findPending returned ZERO. Generic countByStatus returned claimed1/failed2/pending1, mixing an ordinary failed item with saved work. These counts cannot recover the saved total. Log dispatch/pi-validation/TASK-011-review1-independent-probes2.log, fully read.

Earlier independent probe log TASK-011-review1-independent-probes.log reproduced other CLI review findings before its separate fixture incorrectly reused the unique thread channel/external-ID pair. It was retained, corrected only with distinct valid fixture destinations, and F1/F3 rerun. No source/test/assertion changes to produce this evidence.

## Approved bounded repair

High-risk TASK-019 depends on completed TASK-006. Only:

- src/core/database/repositories/queue-repository.ts
- tests/unit/core/database/repositories/queue-repository.test.ts

Provide a narrow public Result-returning, read-only saved-delivery aggregate. Return safe bounded enum/count data structurally usable by the TASK-011 saved DTO: pending, terminal and terminal reason counts. Include deferred/future, active, behind-head and delivered-awaiting-local-finalization work; exclude already-completed successful work and ordinary messages/standalone invocation markers. Retained terminal checkpoints remain represented until purge. Use actual checkpoint/lifecycle definitions, not findPending eligibility or a raw phase field treated as validation. Define truthful failure/unavailable semantics for malformed reserved state; preserve legacy malformed/nonobject ordinary payload behavior.

No mutation/recovery/expiry terminalization, transaction authority change, schema/index change, queue retry/ordering/send/drain behavior, protocol/config/codec/cap/TTL change, new cache/outbox, identity/body/raw diagnostic output or other repository API. Keep retained aggregate memory bounded: do not materialize all saved bodies/history at once. Preserve actual Result/DB error identities and same-connection snapshot consistency. No unowned IPC or daemon edits: TASK-011 later proves actual aggregate-to-DTO compatibility; TASK-012 wires runtime status.

Tests must cover all actual durable phases/queue statuses relevant above, deferred and head-of-line cases, mixed ordinary work, safe reason grouping, purge, read-only snapshots, invalid reserved payload/legacy ordinary compatibility and real database failure. Existing89 repository assertions plus unchanged adjacent codec/transaction tests/build/help are independent baseline checks. Normal native Sol-high implementation, fresh whole-two Sol-xhigh precommit review, parent exact-byte/source/gates/fake terminal smoke, explicit local commit-only authority, fresh exact-commit review and truthful WDD local integration remain required.

## Other TASK-011 review dispositions (existing scope)

Parent independently reproduced F2: actual packaged CLI admits/persists names of64 AND65 ASCII characters, but current B-only management/status schema rejects65. Correct B to consume canonical admitted names; do not silently tighten protected A/canonical config or truncate names. Preserve name alphabet validation and other safe DTO bounds. Add actual64/65 admission-to-management/status regression.

F3 reproduced through actual privileged SignalConnector Result, real private synthetic Unix socket and migrated state: metadata TIMEOUT, live receive state ready/socket open/challenge retained, but projector reported DISCONNECTED. Inspect actual fixed transportCode; only actual disconnection may use DISCONNECTED. Keep timeout/capacity/cancellation truthful and non-success, without automatic assertion retry. Actual healthy-timeout/disconnect controls required.

F4 reproduced actual packaged CLI against timestamp and binary YAML scalar roots: CLI exited0/printed Added channel, yet no channels persisted. Date/Uint8Array passes object/nonarray guard; dumper represents scalar and discards attached channels. Retained A owner must require a plain mapping for Signal mutation, preserving existing empty-file and ordinary-channel compatibility. Safe ConfigError/original bytes/no false success controls required. No global YAML loader rewrite.

TASK-011's initial parent candidate gates passed1634tests/31files, eight-source lint/strict/build/three packaged helps/diffcheck/serialized fake-terminal WS/status/cleanup, with A4/B858/frozen5/base/index/14path hashes checked before/after. Those gates did not cover these defects and DO NOT override BLOCK or permit commit. Mandatory live AC15 remains unavailable.
