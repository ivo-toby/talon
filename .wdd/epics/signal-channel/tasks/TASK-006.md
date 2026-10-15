# TASK-006: Queue delivery-only retry, cancellation and crash recovery

## Objective

Support saved Signal delivery cursors without rerunning providers, consuming provider retry attempts or resurrecting purged work.

## Deliverable

Checkpoint-aware queue repository/processor/manager and recovery paths, delivery-only retry and cancellation semantics with maxAttempts3/concurrency5 regression cases.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-001, TASK-005.

Produces:
- Checkpoint-aware queue repository/processor/manager and recovery paths, delivery-only retry and cancellation semantics with maxAttempts3/concurrency5 regression cases.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Implement latest-row merge + checkpoint phase CAS in real Result transactions, including atomic checkpoint in_flight/account reservation commit and accepted cursor advancement/reservation clear. If row missing return permanent DeliveryCancelled; never recreate. Add delivery-only defer with 24h deadline/backoff1..60s or known later pause; release processor slot without incrementing attempts/maxAttempts. Preserve typed deferred/nonretryable/cancelled errors through catch wrappers; explicit invocation marker makes crashes/provider failures terminal unless valid saved delivery can resume safely. ready resumes delivery only, in_flight unknown terminal, delivered local finalization only.
Deferred earlier ordinary reply blocks later same-thread ordinary work; preserve collaboration bypass and destination lease ordering. Add queue claim quiesce/resume for reload; integration task will call it. Purge keeps existing selectors including --all: in same transaction cancel linked pending/running Signal checkpoint runs with safe ended_at/reason, detach/delete rows/cascade leases, leave completed/background task states unchanged. Test defaultpurge deferred and --all active; late callback must stop body/history/finalization/tail without stuckrun/slot/cursor loop. Recovery handles orphan reservations/leases without provider replay. Preserve unrelated queues and baseline retry/deadletter behavior.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then queue modules, QueueRepository, RunRepository, lifecycle crash recovery and producer contracts from TASK-005.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- src/queue/**
- src/core/database/repositories/queue-repository.ts
- src/daemon/lifecycle.ts
- tests/unit/core/database/repositories/queue-repository.test.ts
- tests/unit/queue/queue-processor.test.ts
- tests/unit/queue/queue-manager.test.ts
- tests/unit/queue/dead-letter.test.ts
- tests/unit/daemon/lifecycle.test.ts

## Verification

```sh
npx vitest run tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/queue/queue-processor.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/queue/dead-letter.test.ts tests/unit/daemon/lifecycle.test.ts
```

```sh
npm run build
```

```sh
node dist/cli/index.js --help
```

The existing TypeScript build and existing packaged CLI help are independent baseline assertions this worker did not author. For protocol work, add exact conformance assertions against the inventory's pinned source; include source path/line citations in tests. Run only these focused tests. The controller additionally runs the ratified existing fake-terminal smoke in each task worktree; serialize its fixed port with `flock /tmp/talon-wdd-terminal-smoke.lock bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build`.

## Definition of done

- Deliverable and meaningful regression tests are complete; report RED/GREEN evidence for behavior changes and exact verification results, or a concrete blocker.
- No edits outside conflict domains. Every Decisions entry records actual implementation choices/limitations for the controller's living knowledge log.
- **Before any commit, stop and return NEEDS_CONTEXT with READY_FOR_REVIEW**, summary, diff paths and Decisions. AGENTS requires a fresh independent GPT-6.1-sol xhigh review before every commit. Do not commit until the controller supplies that review's disposition and tells you to commit the exact reviewed content. Never run wddctl or merge.
- After approval, commit only owned files and return DONE with commit SHA and Decisions. If review causes edits, request a fresh review before committing.
