# TASK-002: Atomic inbound acceptance and connector receipts

## Objective

Eliminate the persisted-message-without-queue gap and expose typed acceptance for Signal retry actors.

## Deliverable

An atomic Result transaction helper and typed pipeline receipt path with real SQLite rollback/duplicate/drop regressions.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-001.

Produces:
- An atomic Result transaction helper and typed pipeline receipt path with real SQLite rollback/duplicate/drop regressions.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Use a synchronous same-connection SQLite transaction for selected inbound transcript + routing + queue enqueue. A private rollback sentinel converts a returned Err into rollback and preserves its typed error; exceptions still rollback. Do not use async transactions. Preserve intentional no-persona drop, historical duplicate behavior, accepted duplicate classification and ordinary connectors. Expose pipeline Result acceptance/duplicate/drop via an API TASK-012 can wire to onMessageWithReceipt; retain compatible existing process callers. Add safe Signal failure logging that excludes body/remote IDs/idempotency keys. Prove real DB rollback after message insert when queue enqueue returns Err; retry once yields one message and one queue row.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then src/pipeline/message-pipeline.ts, src/core/database/connection.ts, repositories/{base,message,queue,thread,binding}-repository.ts and daemon-bootstrap.ts.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- src/core/database/transaction.ts
- src/core/database/index.ts
- src/pipeline/message-pipeline.ts
- tests/unit/core/database/transaction.test.ts
- tests/unit/pipeline/message-pipeline.test.ts

## Verification

```sh
npx vitest run tests/unit/core/database/transaction.test.ts tests/unit/pipeline/message-pipeline.test.ts
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
