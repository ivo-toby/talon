# TASK-013: Packaged fake bridge and complete deliverable gate

## Objective

Prove the built daemon receives and replies through a source-conformant fake Signal socket and provide the complete focused deliverable command.

## Deliverable

A runnable fake Signal packaged-daemon smoke and complete focused deliverable verifier, preserving baseline terminal smoke.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-012.

Produces:
- A runnable fake Signal packaged-daemon smoke and complete focused deliverable verifier, preserving baseline terminal smoke.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Add isolatedprivateUnixfakebridge+fakeprovidernocostharnessbootingdist/index.js, notdirectclassonly. Exactv0.14.9wirefixtureswithsourcecitations; bothmodes/entrypoints, DM/group,excluded/ownoutput,noextraproviderrun,2groupconcurrency5, shortrestart/reconnect, >=4deliverydeferralsmaxAttempts3, chunkcursor/contiguityandothergroupfairness, BGunknownwithoutRunID, activeReload, actualreceiptErrrollback/retry, proofbudget/expiryquarantineandnumberaliaschange. Observefakeproviderinvocation/toolsideeffectcounts ratherthanassertimplementationprivatefields. Stopallchildren/timers/socketsonsuccess/failure. Node24SQLiteproof,privatepathnot/tmp socketancestry.
Createverify-signal-deliverable.sh--no-buildthatfailsmissingtestfilesandrunsexactfocusedpathscoveringALLdesignIntegrationtabletests (inclAC1config/factory/setup,AC12send/list/broadcast/schedule,IPC/status/purge/background/starter), existingCLIhelp, serializedexistingfaketerminalsmokeandnewpackagedSignalfake. No fullsuite, printstages+ACmap. Extendrun-talon-smokeSKILLwithfakereal distinction and liveprocedurelink, do notweakenbaseline assertions orfixedportcleanup. Independentoracleisexistingterminalsmoke+frozenupstreamwirefixtureconformance; citeexactpinnedsources, notself-definedfakeAPI. Documentlivecheckrecipewithoutclaimingexecution.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then design Epic deliverable/Integration surfaces, existing run-talon-smoke skill/script and all merged testpaths.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- tests/smoke/signal-channel-smoke.mjs
- .agents/skills/run-talon-smoke/**
- tests/unit/channels/connectors/signal/signal-deliverable-conformance.test.ts

## Verification

```sh
npx vitest run tests/unit/channels/connectors/signal/signal-deliverable-conformance.test.ts
```

```sh
npm run build && bash .agents/skills/run-talon-smoke/scripts/verify-signal-deliverable.sh --no-build
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
