# TASK-001: Signal configuration, identity and delivery contracts

## Objective

Publish the validated Signal configuration and narrow shared contracts needed by independently implemented transport, persistence and runner components.

## Deliverable

Typed exported config/identity/error/receipt/checkpoint contracts and focused boundary tests, compiling without factory wiring.

## Interfaces

Consumes:
- Approved spec/design and the repository/external rows of the contract inventory in the dispatch snapshot. Downstream task APIs must match the merged producer, not a speculative duplicate.
- Dependency tasks: baseline repository only.

Produces:
- Typed exported config/identity/error/receipt/checkpoint contracts and focused boundary tests, compiling without factory wiring.
- Keep shared exports narrow and typed. Expected failures cross boundaries as neverthrow Result; do not erase Signal error identity in wrappers.

## Scope

Implement every design config default/bound/cross-field rule, strict canonical UUID/base64 codecs and account-scoped external IDs. Reject personal showToolCalls=true and malformed selector/device metadata. Reuse generic named-channel validation without changing other channel defaults.
Define optional Result-aware inbound receipt plus internal trusted output metadata without changing ordinary connectors. SignalDeliveryError must preserve outcome, current-chunk acceptance, safe reason/counts, retry scope and notBefore; add distinguishable DeliveryDeferredError, DeliveryCancelled and NonRetryableRunError. No remote cause text.
Define versioned saved final/background checkpoint with body/chunk/serialized size bounds, delivery identity, optional real run ID, cursor/phases and 24h expiry. Parse persisted input fail-closed; marker and checkpoint types are separate from model inputs. Export small typed contracts for prepared text/chunk sending and account proof snapshots, using the design rather than imagined signal-cli fields.

Follow the design including its R2/R3 dispositions. No source-shaped assumption may be inferred from a mock: for each external field/method/result, read and cite the pinned v0.14.9 source named by the inventory. Do not consult moving upstream as a substitute. Inputs are untrusted; do not leak raw RPC errors, envelopes, identifiers, text, challenge tokens or dynamic parse paths into diagnostics.

## Non-scope

No real Signal accounts/messages, signal-cli installation/provisioning, service/container management, account-key reads, attachments, unrelated refactors, model/governance changes, target-branch merge or full npm test. Do not modify the approved spec/design/plan or another task's implementation; report missing contracts to the controller. Dormant components are wired by TASK-012 unless this brief explicitly owns wiring.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md (for code/test changes).
- All snapshot context above, then src/core/config/config-schema.ts, src/core/errors/*, src/channels/channel-types.ts, src/queue/queue-types.ts, src/tools/host-tools/channel-send.ts.
- Read dependency implementations and existing adjacent tests before choosing exported signatures.

## Conflict domains

- src/core/config/config-schema.ts
- src/core/errors/error-types.ts
- src/core/errors/error-codes.ts
- src/core/errors/index.ts
- src/channels/channel-types.ts
- src/channels/connectors/signal/signal-types.ts
- src/channels/connectors/signal/signal-config.ts
- src/channels/connectors/signal/signal-identities.ts
- src/queue/signal-delivery-checkpoint.ts
- tests/unit/core/config/config-schema.test.ts
- tests/unit/core/errors/error-types.test.ts
- tests/unit/channels/connectors/signal/signal-contracts.test.ts
- tests/unit/queue/signal-delivery-checkpoint.test.ts

## Verification

```sh
npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/core/errors/error-types.test.ts tests/unit/channels/connectors/signal/signal-contracts.test.ts tests/unit/queue/signal-delivery-checkpoint.test.ts
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
