# TASK-007: Text sender, account FIFO and target verification

## Objective

Send verified text chunks once through a persisted, fair and rate-aware account gate shared by every output path.

## Deliverable

Prepared text/chunk sender, exact result parser, fresh target verifier and shared persisted send gate with concurrency, chunk contiguity, rate and cancellation tests.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-001, TASK-003, TASK-005, TASK-006.

Produces:
- Prepared text/chunk sender, exact result parser, fresh target verifier and shared persisted send gate with concurrency, chunk contiguity, rate and cancellation tests.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Prepare stripMarkdown text into codepoint-safe chunks <=2000UTF8 bytes; reject attachments before any RPC, no double format/chunk. Enforce account-scoped destination IDs and fresh safe listContacts/listGroups metadata before every chunk; IO lookup failures unwritten transient, unsafe/missing/ambiguous/ephemeral targets permanent. No listDevices in send path.
All sends acquire destination lease and account FIFO gate max64waiters/1MiB/30s, one active chunk/account,1sec startspacing persisted. Saved replies defer safely for busy/reconnect/expiredproof; explicittools return error. Longreply retainsdestination lease but requeuesbetweenchunks soothergroupsadvance. Prepared chunk API uses trustedctx to coordinate durable checkpoint/reservation beforebytes; DBuncertainty refusesRPC. Explicit/progress releaselease allreturns, including pre-reservation failure; recoverorphans.
Classify ordinary success onlynonemptyallvalidSUCCESS. Inspect error.data.response, unknown/malformed/network as UNKNOWN, known mixed asPARTIAL and distinguish current acceptance from previouschunks. Persist rate/challenge/fence before nextdispatch; -5/retryAfter respectsmax(15min,serverdelay), malformedoverflowdelay/-6/tokenmanualchallenge, unknown60secautomaticfence. No mandatoryresume ordinaryunknown. Resume internalAPI clears challengeonly afterverification, preservingrate. Pure outcomeDTO safe; no rawremote data. Cancellation unwrittenwaiter only; activechunkdrains separately.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then formatters/strip-markdown, TASK-003 RPC client, TASK-005 repositories, TASK-006 transitions, inventory send/result/target rows.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- src/channels/connectors/signal/signal-send-coordinator.ts
- src/channels/connectors/signal/signal-send-result.ts
- src/channels/connectors/signal/signal-text.ts
- src/channels/connectors/signal/signal-target.ts
- tests/unit/channels/connectors/signal/signal-send-coordinator.test.ts
- tests/unit/channels/connectors/signal/signal-send-result.test.ts
- tests/unit/channels/connectors/signal/signal-target.test.ts
- tests/unit/channels/connectors/signal/signal-text.test.ts

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

The existing TypeScript build and existing packaged CLI help are independent baseline assertions this worker did not author. For protocol work, add exact conformance assertions against the inventory's pinned source; include source path/line citations in tests. Run only these focused tests. The controller additionally runs the ratified existing fake-terminal smoke in each task worktree; serialize its fixed port with `flock /tmp/talon-wdd-terminal-smoke.lock bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build`.

## Definition of done

- Deliverable and meaningful regression tests are complete; report RED/GREEN evidence for behavior changes and exact verification results, or a concrete blocker.
- No edits outside conflict domains. Every Decisions entry records actual implementation choices/limitations for the controller's living knowledge log.
- **Before any commit, stop and return NEEDS_CONTEXT with READY_FOR_REVIEW**, summary, diff paths and Decisions. AGENTS requires a fresh independent GPT-6.1-sol xhigh review before every commit. Do not commit until the controller supplies that review's disposition and tells you to commit the exact reviewed content. Never run wddctl or merge.
- After approval, commit only owned files and return DONE with commit SHA and Decisions. If review causes edits, request a fresh review before committing.
