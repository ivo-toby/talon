# Full ordinary-thread dispatch ownership prerequisite (proposal)

## Confirmed defect and boundary

On accepted producer base `c7645b7a0b19f1fad434443d79e5bcb9f07e5955`, QueueManager tracks active dispatch count, but ordinary-thread exclusion is delegated to QueueProcessor's database check. QueueRepository.hasInflightItem checks only `claimed`/`processing` rows. SignalReplyDelivery.finalize commits original history, run and queue completion before its caller's remaining postcommit work returns. Live Runner rotation can await a summarizer after that commit.

The second ordinary item can therefore start on the same thread while the first full dispatch remains alive. Releasing the first rotation then clears the second turn's newer session. This is not a mere comment, counter or missing durable-metric issue. Cold/deferred rotation omission (supervisor S5) remains correct and does not fix the live race.

Actual source paths:
- `src/queue/queue-manager.ts`: startProcessing/tick/dispatchOne and full-dispatch drain.
- `src/queue/queue-processor.ts`: processNext, ordinary SQL inflight checks, collaboration bypass, state-write retry and final return.
- `src/core/database/repositories/queue-repository.ts`: hasInflightItem SQL, public completion/finalize APIs (READ ONLY).
- `src/daemon/signal-reply-delivery.ts`: atomic finalization before optional best-effort hook (READ ONLY).
- TASK-010 current B `src/daemon/agent-runner.ts`: live rotation after actor commit (consumer evidence, NOT prerequisite ownership).

Approved design says history precedes rotation/next ordinary turn and rotation stays best effort. Existing queue code documents noninterleaved ordinary dispatch with a deliberate collaboration exception. Preserve both contracts; do not remove live rotation or bypass actor atomic completion to conceal the race.

## Actual bounded consumer regression

Current B test title: `keeps the next same-thread provider behind an unfinished live Signal rotation` in `tests/unit/daemon/agent-runner.test.ts` (at capture lines6237–6282). The fixture uses actual QueueManager(concurrencyLimit2), QueueProcessor, Runner, migrated SQLite, SessionTracker and ContextRoller, with a private synthetic Signal bridge and controlled provider/summarizer.

1. Enqueue two ordinary same-thread messages.
2. First actual Signal reply commits history/run/queue; hold its real summarizer promise.
3. Let actual500ms QueueManager polls run.
4. Observe the second provider and session.
5. Release old summary and inspect actual SessionTracker.

Expected: first row completed, provider turns1, second row pending, newerSessionClobbered false.
Actual: first row completed, provider turns2, second row completed, newerSessionClobbered true.

Worker corrected a separate first probe that incorrectly assumed the fixture faked setInterval; that harness failure is retained and is NOT the behavioral RED. Corrected actual-poll log independently shows the meaningful failure, without production/timeout/quota changes.

Worker logs:
- `/home/ivo/.config/pi/agent/sessions/--home-ivo-workspace-talon.feat-signal--/subagent-artifacts/outputs/7077c1f5-8b0c-4a75-905f-6e578bb92830/TASK-010/B-followup-live-rotation-ordering.log` (harness-only first probe).
- Same directory `B-followup-live-rotation-ordering-repro.log` (actual behavioral RED).

Parent independently EXECUTED the existing targeted regression and read complete output:
`.wdd/dispatch/pi-validation/TASK-010-B-S6-parent-ordering-repro.log`.
It failed for the same actual provider2/completed second row/session-clobber assertions, not a fixture wait. Parent changed no production/test content. B partial source is preserved under `TASK-010-B-S6-blocked-preserved/`; B-only full-index patch126786 bytes SHA256 `37f52ba7a872f0167d19b6765e89f838b6236ec025053aae56d814e535db73c5`; actual HEAD/index/A4/protected869/frozen5 remained unchanged.

## Proposed narrow ownership

Add TASK-020 for full ordinary-thread exclusion through the actual dispatch promise AND its state-transition obligations, even if the durable row completed/purged earlier. Potential source/test domain only:
- `src/queue/queue-processor.ts`
- `src/queue/queue-manager.ts`
- `tests/unit/queue/queue-processor.test.ts`
- `tests/unit/queue/queue-manager.test.ts`

Choose the minimal implementation after tracing actual producer contracts; permission to touch a file is not a requirement. Preserve the existing collaboration bypass (including collaboration behind a pending ordinary item), unrelated-thread concurrency, current maxAttempts/backoff, cancellation, saved reentry, full dispatch drain and Result identity. No schema/repository/actor/Runner/rotation-policy change, new cross-process guarantee, global quiesce, fake claimed state, body-retaining wait queue or generic permission framework.

Task depends on accepted006+009 producers. All original nineteen task definitions/history/settings/dispatch snapshots remain unchanged; controller explicitly withholds TASK-010 acceptance until the prerequisite is integrated. Do not mutate the already-started TASK-010 dependency graph or rewrite its frozen inputs. Keep its blocked source/failing regression, honestly refresh its worktree after the accepted fix, and validate the actual consumer regression again before any whole-task review/commit.

## Approval status

Ivo explicitly selected **Add TASK-020 (recommended)** after the parent independently reproduced the failure and presented the four queue source/test paths, high risk, preserved collaboration/live-rotation semantics, unchanged nineteen definitions and local-only review/integration sequence. This authorizes the narrow prerequisite and its scoped regressions, not additional source/API/rotation policy or production activity. The earlier unapproved dry-run correctly refused scope change; that failed diagnostic and exact pre-approval proposal are preserved. The controller must now run the genuinely approved dry-run/apply and assign an isolated correct-cwd worker before implementation. Current B readiness remains withdrawn until the reviewed producer correction is integrated and the preserved consumer regression passes on an honest new-base phase. No drop-live-rotation workaround, main merge/publication or change to S5 is approved.
