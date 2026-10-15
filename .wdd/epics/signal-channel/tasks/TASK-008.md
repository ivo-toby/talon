# TASK-008: Signal connector and verification lifecycle

## Objective

Combine transport, policy, proof refresh and sender into a usable ChannelConnector with bounded startup/reconnect/stop.

## Deliverable

Exported SignalConnector with all lifecycle states, receipt retry/alias/proof wiring and fake-socket lifecycle regression tests.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-002, TASK-003, TASK-004, TASK-005, TASK-007.

Produces:
- Exported SignalConnector with all lifecycle states, receipt retry/alias/proof wiring and fake-socket lifecycle regression tests.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Expose constructor dependencies for shared DB gate/leases/generation registry/receipts and test clock, backward-compatible ordinary connector contract. start ownsreconnect loop even initialbridgeabsent, boundedfirstattempt resolves whileReconnecting. Exactversion0.14.9 and pinnedACI authoritative; obsoletephone selector missing okay ifACIpresent, wrongACI fails. RuntimecallsACI only. Subscribe selectedaccountmanualmode and validate subscription/accountaliases fromlistAccounts, ignore pereventexception withoutNeedsSetup.
Personal proof: bridge nonprimary ID+created exactconfig andstrictlynewestlinkeddevice, ties/missing/zero/newerNeedsSetup; dedicated selfexcluded. ServerlistDevices onepersistedstart/60sec/account, TTL5min, successfulproofrequirednewconnection. Transientrefresh preserveshealthysocket/subscriptionandcachedproof; afterexpiry holdonlyeligibledependentcommands, defersends, independentexternalcommandscontinue. No per-eventrefreshamplification; unknown device schedules budgetedrefresh. Localaliasrefresh60sec, unknownaliascoalescedmax1/5sec withseparateboundedquarantine; numberchangeworkswithoutreconnect.
Wire receiptFIFO and safe diagnostics, classify outerprotocol3failures/5minNeedsSetup but invalidper-eventshape dropsonlyevent. stop invalidatesgeneration/timers, quiescesnewdispatch anddrainsremainingrequestdeadlinecap30sec; persistunknownspecificdelivery andautomaticaccountfence onlyifneeded. Expose safe local status and privileged challenge-resume API; never networktestmessage/replay. Do not integrate factory/bootstrap (TASK-012).

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then channel-types, lifecycle patterns of terminal/whatsapp connectors and every producer implementation.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- src/channels/connectors/signal/signal-connector.ts
- src/channels/connectors/signal/signal-account-verifier.ts
- src/channels/connectors/signal/index.ts
- tests/unit/channels/connectors/signal/signal-connector.test.ts
- tests/unit/channels/connectors/signal/signal-account-verifier.test.ts

## Verification

```sh
npx vitest run tests/unit/channels/connectors/signal/signal-connector.test.ts tests/unit/channels/connectors/signal/signal-account-verifier.test.ts
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
