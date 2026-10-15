# TASK-004: Receive activation, provenance and bounded quarantine

## Objective

Implement pure source-conformant admission and bounded retry/quarantine actors without persistence of ignored account traffic.

## Deliverable

Pure receive normalization/policy, generation-scoped provenance registry, bounded buffers and metadata-free diagnostics with named R2/R3 regression tests.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: TASK-001.

Produces:
- Pure receive normalization/policy, generation-scoped provenance registry, bounded buffers and metadata-free diagnostics with named R2/R3 regression tests.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Parse ordinary data and unwrapped sync.sentMessage. Apply every control/disappearing/media-only/edit exclusion before activation/persistence. Personal NoteToSelf is prefix-free only for verified operator human devices; selected DMs/groups require exact trigger+sender allowlists; dedicated self never commands. Shared frozen human roster excludes newest bridge device and configured sibling bridge devices; unknown/missing sourceDevice drops and schedules coalesced refresh, never speculative self trust. Version/account/group/source identity stable dedup across wrapper forms.
Implement separate bounded unknown-account-alias quarantine (64/1MiB/30s), stale-proof-only quarantine (64/1MiB/10min), and receipt retry FIFO (64/1MiB/5min exponential250ms..10s), each revalidating current config/proof before release. Never quarantine unauthorized/control/exception/unknown-device events. Drop newest on overflow and report safe held/dropped counters + once/episode warning. Stop cancels; no acknowledgement claims. Inject clock/receipt/refresh dependencies for lifecycle task. Ignored diagnostics aggregate fixed reason counts once/minute; no per-event IDs/audits or unsafe parse paths/raw inputs.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then pipeline normalization, existing connector inbound mapping and source inventory inbound/device rows.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- src/channels/connectors/signal/signal-inbound-policy.ts
- src/channels/connectors/signal/signal-device-registry.ts
- src/channels/connectors/signal/signal-inbound-buffer.ts
- src/channels/connectors/signal/signal-diagnostics.ts
- tests/unit/channels/connectors/signal/signal-inbound-policy.test.ts
- tests/unit/channels/connectors/signal/signal-inbound-buffer.test.ts
- tests/unit/channels/connectors/signal/signal-diagnostics.test.ts

## Verification

```sh
npx vitest run tests/unit/channels/connectors/signal/signal-inbound-policy.test.ts tests/unit/channels/connectors/signal/signal-inbound-buffer.test.ts tests/unit/channels/connectors/signal/signal-diagnostics.test.ts
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
