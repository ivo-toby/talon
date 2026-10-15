# TASK-015: User and architecture documentation

## Objective

Bring feature/config/architecture docs into agreement with the shipped Signal behavior and operational limits.

## Deliverable

Updated README/config/setup/AGENTS/CLAUDE and Signal operations reference consistent with implemented behavior.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-012.

Produces:
- Updated README/config/setup/AGENTS/CLAUDE and Signal operations reference consistent with implemented behavior.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Updatealllistedexistingdocsrelevantchannellistsandnewdocs/signal-channel.md ascompleteoperatorreference. Twoaccountmodesandpersonalentrypoints; UUID/base64IDs,concretevalidatedconfigwithemptyallowlists,triggerboundary, noattachments/disappearing. Version0.14.9only,sockettrust/UID/no/tmp,bridge-lastdevicefreshness/relink, minimalmanualreceiveignoreflags/JREprereqs noTalonauthority. Explainlocalaliasvsserverdevicebudget5minproofhold10minboundedloss, durablefinal/backgrounddeliverycursor/maxattemptindependence, pertargetcontiguousleasesfairaccountgate1/sec,partialunknownterminalnoreplay,knownunsentretry, accountfencevsmanualchallengepause, originexplanations,normalreceiveerrorsnotaccountfailure. Retentiondisclosure:ignoredtrafficnone, selectedtext/queuecheckpointordinarySQLite/providerretention; purgeremovestextbut submittedchunkmayarrive/cancelsrun. Multi-instancepersonalrosterstrictconstraintanddedicatedselfexcluded. CommandsmatchactualCLI,actualfakegateandlivependingdistinction. Do notclaimliveAC15success. PreserveexistingAGENTSreview/offloadconstraintsandunrelatedfeaturedocs.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then actualSignalconfig/lifecycle/send/queue/CLIimplementations, README/AGENTS/CLAUDE/configexample/setupguide.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- README.md
- AGENTS.md
- CLAUDE.md
- config/talond.example.yaml
- docs/setup-guide.md
- docs/signal-channel.md

## Verification

```sh
npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/cli/add-channel.test.ts
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
