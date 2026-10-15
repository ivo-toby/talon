# TASK-009: Saved reply delivery actor and invocation guard

## Objective

Provide the runner a durable delivery-only state machine and trusted per-execution Signal guard.

## Deliverable

A reusable saved Signal reply/background actor and trusted invocation guard with delivery-only recovery and exactly-once local finalization tests.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-006, TASK-008.

Produces:
- A reusable saved Signal reply/background actor and trusted invocation guard with delivery-only recovery and exactly-once local finalization tests.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Savedfinal/background textandfixedchunksdurable beforefirstsend; trustedqueueID/deliveryID optionalrealrunID, realpersona/thread/channel/account/target. Re-resolvecurrentconnectorregistryoneveryattempt, notcachedacrossproviderquery/reload. Resume ready atcursor, in_flight terminalunknown, delivered idempotentlocalfinalizationonly. Boundcheckpoint sizes/TTL, noRPCthroughDBtransitionuncertainty. Persist usage/session/providerresult once via phase-aware callbacks, outboundhistoryonce beforecontextrotation; originalrun staysrunningwhilependingdelivery, backgroundnorunfabrication.
Guard atRunner.run entry beforebackgroundearlybranch: markerbeforeanySignaldelivery blockswholeproviderreplay, crashclassificationpreservesexplicittoolsideeffects. Latch exact(queueItemId,ACI,canonicaltarget) acrosspurpose/requestIDs onPARTIAL/UNKNOWN; permithealthyotheroriginexplanation. Explicittoolwaiterrors notqueued/notfalse success. Implement actorswithinjectedrunnerfinalizationdependencies (TASK-010consumes), no alternateproviderruntime. Purgedrow cancels actorforever withnohistory/bodyresurrection; submittedRPCcanclassifyaccountwithoutdeletedrowwrites. Test concurrentgroups, shortdisconnect, >3deferrals/maxAttempts3, chunkscursor, bgUNKNOWNwithoutRunID, exacttargetlatchandexplicitNOT_SENTleasecleanup.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then agent-runner.ts entire foreground/background paths, queue producers/transitions, message/run/session repositories and connector preparedchunk contract.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- src/daemon/signal-reply-delivery.ts
- src/daemon/signal-invocation-guard.ts
- tests/unit/daemon/signal-reply-delivery.test.ts
- tests/unit/daemon/signal-invocation-guard.test.ts

## Verification

```sh
npx vitest run tests/unit/daemon/signal-reply-delivery.test.ts tests/unit/daemon/signal-invocation-guard.test.ts
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
