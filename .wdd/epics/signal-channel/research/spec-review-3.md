# Design review — round 3

- Document: `.wdd/epics/signal-channel/design.md`
  (SHA-256 `7f2b73db9115dfa3608e3593d67647e2f1457faf435822fd35cd29a7a3761a41`, 696 lines)
- Author: Codex controller (round-2 revision; exact model unrecorded)
- Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), requested again by Ivo
- Profile: general + security (unchanged)
- Grounding: `spec.md`, the contract inventory and constraints, both
  review-response evidence files, the pinned signal-cli sources, and
  repository source at `dcb6462`

## Review of round-2 dispositions

| Finding | Reviewer view | Note |
| --- | --- | --- |
| R2-F1 | Upheld | Busy now waits in a FIFO. Deferral is delivery-only, with a saved cursor and its own deadline, and does not consume provider attempts. |
| R2-F2 | Upheld | Receive exceptions are excluded per event, and only account-level evidence reaches Needs setup. |
| R2-F3 | Upheld | A bounded drain, a 60-second automatic fence and no mandatory resume. |
| R2-F4 | Upheld, with residue | Origin replies are preserved. The latch scope wording is inconsistent (R3-F4). |
| R2-F5 | Upheld, with residue | The background branch is guarded. Its collaboration-queue bypass creates R3-F2. |
| R2-F6 | Upheld, with residue | Sends no longer call listDevices, and receiving survives a refresh blip. What "suspended admission" means is open (R3-F1). |
| R2-F7 | Upheld | Aliases refresh on the healthy socket, and RPCs use the ACI. |

## Findings (reviewer's words — immutable)

**R3-F1 — P2 — "Suspend admission" on stale proof doesn't say hold or drop, so operator commands can be lost silently.**
Anchor: design "Established-connection device refresh" row "Proof expires
while refresh remains unavailable → Keep receive subscription; suspend sends
and local-personal-account/device-dependent admission until renewed"; spec
pre-acceptance boundary.
Messages are still being received, so the bridge has already consumed them.
Nothing says whether a suspended event goes into a bounded hold (like the
alias quarantine), is retried through the receipt FIFO, or is excluded.
Scenario: Signal rate-limits or fails `listDevices` for 6 minutes while
message delivery keeps working. The operator sends three Note to Self
commands. A worker that reads "suspend" as "exclude" drops all three with a
debug-level aggregate count only. The operator never gets an answer, and
nothing tells them to resend. A different worker holds them without a stated
bound. Either is a defensible reading.

**R3-F2 — P2 — Per-chunk FIFO rejoin plus the collaboration bypass interleaves messages in one chat.**
Anchor: design "Account send gate" ("Long replies rejoin the FIFO for each
chunk so another target can make progress"); "existing collaboration bypass
rules remain explicit"; `src/core/database/repositories/queue-repository.ts:85-100`
(collaboration items are claimed while a regular item on the same thread is
in flight); `src/subagents/background/background-agent-manager.ts:722`
(background notifications are enqueued as `collaboration`).
Ordering is only guaranteed per account FIFO slot, not per destination.
Scenario: a 4-chunk reply is being delivered to group G. A background task
finishes on the same thread, and its notification (a collaboration item that
bypasses the per-thread in-flight rule) prepares one chunk and enters the
account FIFO between chunks 2 and 3. G sees chunk 1, chunk 2, the
notification, chunk 3, chunk 4. A `channel_send` from another thread aimed
at G interleaves the same way. Each chunk is accepted in order within its own
delivery, but the conversation reads as corrupted. The design guarantees
neither per-destination contiguity nor rules out mixing.

**R3-F3 — P2 — `talonctl queue-purge` is unaccounted for against saved checkpoints.**
Anchor: design "Saved replies" ("Saved outgoing text/cursors use ordinary
Talon queue retention, including terminal items, until operator purge"; "Run
status stays running while reply delivery is pending"; "Failed database
transitions are retried only as state writes with capped backoff");
`src/cli/commands/queue-purge.ts:33-35` (default statuses
`pending, failed, completed`; `--all` includes claimed/processing);
`src/core/database/repositories/queue-repository.ts:316-327`.
Scenario A: a reply is deferred (pending with a future `next_retry_at`) during
a challenge pause. The operator runs the default `talonctl queue-purge` to
clear a backlog, which deletes the checkpoint. Its run row stays `running`
forever, because only checkpoint delivery or failure completes it, and the
account's `signal_account_state` keeps nothing pointing at it. Scenario B:
`--all` during an active chunk deletes the claimed row. The design's
cursor/state transition then "requires the expected current state/cursor",
fails every time, and is retried indefinitely as a state write while holding
the concurrency slot (the round-1 text says it retains its slot until the
write succeeds or stop cancels it). Nothing defines what purging a
checkpointed or in-flight item does.

**R3-F4 — P2 — The scope of the explicit-tool latch is inconsistent.**
Anchor: design "Invocation guard" row 2 ("reject further explicit sends to
that failed account/target in this queue execution") against row 3 ("a
latched PARTIAL/UNKNOWN target") and the paragraph "If the origin Signal
target is itself latched".
"account/target" can be read as the whole account or the single target.
Scenario: a run's `channel_send` to group G on account X returns UNKNOWN.
The model then calls `channel_send` to Note to Self on the same account X
(after the 60-second fence) to report the problem. Under the account reading
it is refused for the rest of the execution. Under the target reading it is
sent. The tests ("same-account different-target refusal") imply the account
reading, while row 3 and the origin-reply text imply the target reading.

## Attack log (sections tried, no break found)

- **Checkpoint forgery**: tried injecting the reserved checkpoint or marker
  key into a queue payload from untrusted sources. The schedule tool payload
  is allow-listed to label/prompt/promptFile
  (`schedule-manage.ts:634-669`). `db_query` is read-only and cannot read
  `queue_items` (`db-query.ts:48-52`). A2A payloads are built by host code.
  No path found.
- **Head-of-line blocking**: the existing claim SQL skips future-dated items
  (`queue-repository.ts:71-83`), so a newer item would overtake a deferred
  one. The design names the needed defer operation and head-ordering tests.
  Holds as a requirement.
- **Crash recovery**: `recoverFromCrash` resets claimed/processing items to
  pending and keeps the payload (`lifecycle.ts:30-41`). Classifying the
  checkpoint (ready / in_flight / delivered) at dispatch covers every reset
  item.
- **Alias quarantine**: notifications on a per-account subscription only come
  from that manager, so a changed alias can only mean a number change. The
  ACI pin prevents learning another account's alias.
- **Device check budget**: tried burst unknown-device events, reload and
  restart. The persisted check-start time and coalescing hold the budget.
- **Receive exceptions**: tried untrusted-identity and exception-only floods
  from strangers. They are excluded per event and don't increment the
  protocol counter.
- **Send gate**: tried 5 concurrent multi-chunk runs, 64-waiter saturation and
  broadcast beyond 30 s. Transient NOT_SENT values are deferred or reported
  per target, with one provider execution each.
- **Reload drain**: covered by the bounded drain, quiesced claims and
  re-resolving the registry per attempt.
- **Retention**: saved bodies are a second stored copy of outbound text,
  disclosed in setup/README, and `queue-purge` exists. Its interaction is
  R3-F3.

## Assessment

Every finding this round is a boundary or bookkeeping clarification. None is a
doctrine hole, and there is no P1. The yield has fallen from 1 P1 + 17 P2,
to 2 P1 + 5 P2, to 0 P1 + 4 P2. The reviewer recommends converging once these
four have dispositions. Further full rounds on this document are unlikely to
justify their cost compared with catching the rest in implementation review.

## Dispositions

Recorded by Codex controller on 2026-10-15. Findings and reviewer assessments
above are unchanged. All four are accepted and closed in the revised design;
implementation/review/verification still must prove the remedies.

| Finding | Disposition | Design remedy / required evidence |
| --- | --- | --- |
| R3-F1 | Closed in design | Device-proof quarantine holds otherwise eligible commands for ten minutes, 64 events/1 MiB; revalidates on renewal and then hands off once. Explicit overflow/expiry/stop loss, warn counters/status and resend guidance; test a six-minute outage with three Note to Self commands. |
| R3-F2 | Closed in design | Exclusive durable (accountUuid, destination) lease covers an entire logical delivery across chunks/deferral and all reply/background/explicit paths. Account FIFO shares time among different destinations. Test same-group background/cross-thread send contiguity and other-group progress. |
| R3-F3 | Closed in design | Purge transaction cancels live linked runs and cascades leases before deleting selected rows. Missing checkpoint is permanent cancellation, never retried/recreated; in-flight RPC can settle but no further chunk/history/body resurrection. Test default deferred purge and active --all with no slot/run leak. |
| R3-F4 | Closed in design | One exact latch key: (queueItemId, accountUuid, canonical externalThreadId), shared across purposes/request IDs. Account rate/challenge/recovery fence is separate; another target is permitted after that fence expires. Tests explicitly distinguish both scopes. |

Ivo's 2026-10-15 instruction to start implementation and finish all tasks is
recorded as authorization to close these clarifications, proceed with this
design and apply the concrete task plan. No residual P1/P2 acceptance is
claimed; the coordinator adopts the reviewer's convergence recommendation.
The original reviewed design is frozen in research/design-review-3-input.md.
