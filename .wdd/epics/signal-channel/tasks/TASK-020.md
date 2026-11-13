# TASK-020: Ordinary-thread ownership through full queue dispatch

## Objective

Prevent a later ordinary same-thread provider execution from starting while the previous full dispatch still owns postcommit work, preserving the deliberate collaboration bypass and unrelated-thread concurrency.

## Deliverable

A minimal queue lifecycle correction enforcing ordinary-thread exclusion until the complete admitted dispatch and state-transition obligations settle, even after early durable queue completion/purge, with real SQLite/public-queue regressions. It unblocks the preserved TASK-010 live-rotation/session-clobber regression without changing rotation policy or actor atomic finalization.

## Interfaces

Consumes:
- Approved spec/design (notably delivery/history/finalization/next-thread-turn ordering and best-effort rotation), actual accepted TASK-006 QueueProcessor/QueueManager and TASK-009 actor/public finalization contracts.
- `research/full-dispatch-thread-ordering.md` and the complete worker and parent actual regression logs. The current uncommitted TASK-010 B consumer is evidence, not producer ownership.

Produces:
- Ordinary-thread dispatch lifetime ownership inside the existing queue execution layer. Choose minimal private bookkeeping after tracing actual claim/inspection/handler/state-write/return paths. Bound retained bookkeeping to actual active ordinary dispatches; no new payload/body wait queue or timer.
- Existing typed Result/error APIs, queue selectors/statuses/attempt counters/backoff and collaboration escape path remain intact. Do not claim cross-process or independent-processor-instance exclusion beyond the actual daemon's single queue ownership.

## Scope

Trace the entire actual QueueManager -> QueueProcessor -> handler/saved handler -> state transition -> finally/drain path before changes. The durable row status alone is not ownership once the handler can atomically complete it and then await postcommit work. Establish and release ordinary-thread exclusion around the FULL admitted dispatch, including inspection/local Result retries, handler success/expected Err/unexpected throw, saved finalization and final state-transition obligations. Never release early based on completion/count0/health, fake row state or an unrelated callback.

Keep actual collaboration semantics: a collaboration item may bypass an active ordinary thread to avoid persona_send await_reply deadlock, including when it sits behind a pending ordinary item. Never let a pending ordinary item use that bypass. Preserve FIFO among ordinary work, progress of other threads/accounts, actual concurrencyLimit, quiesceAndDrainClaims behavior and explicit resume authority. All paths must clean up owned bookkeeping correctly without erasing another dispatch's ownership or leaving a stuck thread. Do not broaden the fix to general scheduler/collaboration policy.

New meaningful regressions must use actual migrated SQLite/public QueueRepository/QueueProcessor/QueueManager contracts and controlled real handler promises, not fabricated inflight booleans or a cloned producer. Cover early completed row with held handler, next ordinary still unclaimed/unexecuted, later progress after release, concurrent unrelated thread, collaboration bypass both head/behind ordinary, success/Err/throw/purge/cancellation and pending local state transition/drain. Include maxAttempts3 and concurrency2 plus5 controls without changing quotas/timeouts. Existing producer actor demonstrates early atomic completion; a generic public-handler early-commit control must model that actual contract, not change the actor. Preserve all original test assertion bodies except necessary new imports; append task-specific helpers/cases only. No unrelated legacy type cleanup.

The implementing worker must show behavioral RED before source correction and GREEN after. Compilation/import/fixture synchronization failures are not product RED. Parent separately verifies the preserved actual TASK-010 Runner/SessionTracker/ContextRoller consumer regression after honest integration/base refresh; that unchanged failing control must turn green without weakening its assertions or dropping live rotation.

## Non-scope

Only the four listed paths, and only those needed. No repository/schema/migration, checkpoint codec/version/limits/TTL, sender/lease/recovery, guard/actor/Runner/B source, HostToolsBridge/runtime/auth, persona/capability, rotation/metric persistence or cold-provider behavior changes. No global claim quiesce workaround, fake claimed row, Runner-local mutex, body-retaining queue, private-handle cast/shadow producer, new public API without controller decision, new cross-process lock/claim guarantee, service/container/install/key/account/real Signal access, file deletion/worktree release, full npm test, publication or model/governance change.

Ivo explicitly approved adding TASK-020 and this four-path source/test boundary. Implementation begins only after the controller runs the approved dry-run/apply/start. Preserve all original nineteen task definitions/history/settings and immutable snapshots. TASK-010 is checkpointed/withheld by controller until this prerequisite is reviewed and integrated; its already-started dependency definition/snapshot is not rewritten. Workers never edit its in-progress state or code.

## Files to read first

- Actual AGENTS.md and `/home/ivo/.agents/skills/ivo-code-style/SKILL.md`.
- Complete immutable snapshot brief/context/spec/design, research/full-dispatch-thread-ordering.md, actual entire four owned files and adjacent dead-letter/retry/public repository/actor caller contracts READ ONLY.
- Parent/worker complete repro logs and preserved actual TASK-010 failing regression. Do not infer API or permission from a fixture/report without actual source.

## Conflict domains

- src/queue/queue-processor.ts
- src/queue/queue-manager.ts
- tests/unit/queue/queue-processor.test.ts
- tests/unit/queue/queue-manager.test.ts

## Verification

```sh
npx vitest run tests/unit/queue/queue-processor.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/dead-letter.test.ts
```

```sh
npm run build
```

```sh
node dist/cli/index.js --help
```

Run changed-source ESLint and relevant strict source/test compilation first; disclose existing unrelated baseline errors without broad cleanup/waiver. Existing unchanged ordinary/collaboration/drain assertions, dead-letter suite, actual build and packaged help are independent assertions this worker did not author. Parent additionally runs accepted focused integration suites and the ratified serialized disposable fake-terminal direct WebSocket/status/cleanup, then the preserved whole Runner consumer regression after honest refresh. No full slow suite/liveAC15 claim.

## Definition of done

- Minimal owned producer correction, every original assertion preserved, meaningful actual boundary RED/GREEN, complete source/error/ownership/cleanup/concurrency/collaboration/drain reasoning and every numbered Decision/limit reported.
- Before ANY staging/commit stop READY_FOR_REVIEW then NEEDS_CONTEXT. Fresh independent GPT-6.1-sol xhigh whole-task review plus parent actual byte/source/gates required. A NEW separate exact-content Git-only contract and exact-commit review/repeated committed gates/WDD freshness/local integration follow.
- No WDD/subagents, baseline/evidence rewrite, unowned changes, source-shaped mocks, staging/commit without explicit authority, push/PR/main merge or task/feature/runtime completion claim from component tests.
