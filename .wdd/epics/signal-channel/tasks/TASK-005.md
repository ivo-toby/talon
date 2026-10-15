# TASK-005: Persistent account state and destination leases

## Objective

Persist account send/check budgets, reservations, pauses and per-conversation logical-message ownership.

## Deliverable

Account-state and destination-lease Result repositories plus migration with durable budgeting, ownership and rollback tests.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-001.

Produces:
- Account-state and destination-lease Result repositories plus migration with durable budgeting, ownership and rollback tests.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Add next migration014, following migration runner conventions. Account table keyed canonical ACI stores lastSendStart/lastDeviceCheckStart, trusted reservation IDs/kind/start, pause kind/notBefore and timestamps. Repository Result methods use expected-state compare-and-set and atomic multi-write transactions where needed; no network inside DB transactions. Preserve later/stronger pauses, challenge manual semantics and monotonic one/60sec device check budget across process restart.
Destination leases keyed ACI+canonical externalThreadId include trusted queueItemId FK ON DELETE CASCADE, deliveryId/kind/times. Acquire/validate/release with owner CAS; no hijack by account display names. Saved final/background owners retain through deferral. Explicit/progress owners release every return (including success/transient NOT_SENT), and orphan pre-reservation leases can be recovered after account reservation classification. Design transaction-friendly methods so TASK-006 atomically checkpoints+reserves and purge cascades safely. Tests restart/migration persistence, competing targets/owners, stronger pauses, FK deletion and orphan recovery.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then existing migration runner, repository base/queue/run patterns, database schema/FKs and design account/destination sections.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- src/core/database/migrations/014-signal-state.sql
- src/core/database/repositories/signal-account-state-repository.ts
- src/core/database/repositories/signal-destination-lease-repository.ts
- src/core/database/repositories/index.ts
- tests/unit/core/database/repositories/signal-account-state-repository.test.ts
- tests/unit/core/database/repositories/signal-destination-lease-repository.test.ts
- tests/unit/core/database/migrations/runner.test.ts

## Verification

```sh
npx vitest run tests/unit/core/database/repositories/signal-account-state-repository.test.ts tests/unit/core/database/repositories/signal-destination-lease-repository.test.ts tests/unit/core/database/migrations/runner.test.ts
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
