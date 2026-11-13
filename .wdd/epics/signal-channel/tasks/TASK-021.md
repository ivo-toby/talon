# TASK-021: Preserve observed account restrictions on mixed send failures

## Objective

Keep a failed mixed-recipient send's original PARTIAL receipt while exposing its observed account restriction through the existing typed reason vocabulary, so the existing broadcast account-stop consumer can distinguish it from recipient-only partial acceptance.

## Deliverable

A minimal correction to the existing Signal result classifier and additive conformance regressions. Mixed SUCCESS plus a valid rate/challenge failure retains PARTIAL/current-partial/counts/cursor/retryScope:none, but carries the applicable existing safe restriction-specific reason. Recipient-only partials remain PARTIAL_ACCEPTANCE; simultaneous rate/challenge hints retain their independent persisted restrictions, deadline and existing challenge precedence. No new Error shape, field, reason, API, schema or retry/security policy is introduced.

## Interfaces

Consumes:
- Frozen spec AC-8/AC-12 and design invocation/result ownership/account send-gate rules, pinned inventory and v0.14.9 source contracts.
- Actual accepted `parseSignalRpcFrame`, `parseSignalSendEvidence`, `interpretSignalRestrictions`, `classifySignalSendResult`, SignalDeliveryError/SignalDeliveryFailure and SignalSendClassification contracts. Public source is authoritative.
- Actual sender settlement/retained-Result flow and checkpoint codec (read-only); current TASK-010 broadcast predicate (read-only) is a downstream consumer, not owned here.
- `research/mixed-result-restriction-reasons.md`, complete fresh whole review2 F6 and parent public-boundary evidence. Those diagnostics are not the required new owned behavioral regression.

Produces:
- Existing safe reason semantics reflecting actual independent restriction evidence without changing the delivery receipt or permitting replay. Use existing challenge-over-rate precedence; no deadline inference or blanket partial restriction.
- Original typed Result identities/shapes, count/cursor arithmetic, privacy, pause/longest-delay handling, normal/remote-envelope uncertainty and codec conformance remain compatible.

## Scope

Only two EXISTING paths:
- `src/channels/connectors/signal/signal-send-result.ts`
- `tests/unit/channels/connectors/signal/signal-send-result.test.ts`

Trace the actual parser -> sanitized evidence -> classifier -> sender persistence/Result -> guard/actor/tool consumer before edits. Read both full owned files, all original94 tests and real codec cross-product; inspect all affected consumer comparisons. Keep the source change local. Preserve every complete original test assertion/helper/hook body and every existing public shape; only additive imports/separate cases are authorized. No unrelated formatting/type cleanup.

First prove meaningful behavioral RED through actual pinned-shape wire parsing and the real classifier: mixed success+rate, success+challenge without a deadline and both restrictions must expose the applicable EXISTING safe reason without borrowing other operation counts. Include no-prefix and valid prior-prefix controls, relevant normal/error envelopes, recipient-only partial controls, unknown/malformed/network precedence, all-success receipts/hints and privacy. Record compiler/fixture/collection failures separately; never count them as behavioral RED. Then smallest source correction and GREEN.

Preserve all independent restrictions and max server delay, no cap shortening/clearance; valid all-success remains Ok even when independent hints exist. UNKNOWN/conservative malformed evidence retains its precedence. Do not use PARTIAL+notBefore as restriction-kind authority. Do not convert a partial accepted RPC into a proven-unsent retry, advance cursor/acceptedChunks, mutate shared Error/receipt objects or make recipient-only failures stop an entire account. Actual public checkpoint codec must still represent every classification branch.

## Non-scope

No new source/test/helper file, Error schema/field/reason/API, wire/parser, sender/coordinator, account/lease/queue/repository/migration, actor/guard/Runner/bridge/tool-registry, binding/persona/capability/confirmation, timing/quota/retry, codec/TTL, live device/account/key/provisioning, service/container/install, broad formatting, publication or worktree cleanup. Do not change TASK-010's eight dirty files or run its other worktree to fake a current producer result. Controller owns its later honest refresh and real consumer regressions.

Ivo explicitly approved adding this prerequisite and autonomously finishing this WDD scope without further questions. Workers still bring any actual missing public-contract/ownership/security ambiguity to the controller BEFORE broadening the two-path boundary. The controller exercises standing judgment; do not silently edit an unowned surface or weaken the frozen requirements.

Preserve original20 task definitions/history/settings/snapshots/spec/design and all previous failures/reports/native criteria. This additive task does not rewrite TASK-010's in-progress dependency or input snapshot. Controller holds TASK-010 until this prerequisite is independently reviewed and locally integrated.

## Files to read first

- Actual AGENTS.md and `/home/ivo/.agents/skills/ivo-code-style/SKILL.md`.
- Complete immutable dispatch brief/spec/design/inventory/contract constraints/research.
- Both owned files throughEOF, actual typed errors, sanitized wire, sender classification/settlement, actor failure policy, checkpoint codec and existing broadcaster predicate/read-only consumer.
- Parent current board/proofs/full review2/public diagnostic; upstream inventory citations, never moving/speculative interfaces.

## Verification

Run scoped source lint, then CLEAN all-source plus classifier/producer test strict compilation, then existing independent focused tests:

```sh
npx vitest run tests/unit/channels/connectors/signal/signal-send-result.test.ts tests/unit/channels/connectors/signal/signal-send-coordinator.test.ts tests/unit/channels/connectors/signal/signal-text.test.ts tests/unit/channels/connectors/signal/signal-target.test.ts tests/unit/queue/signal-delivery-checkpoint.test.ts tests/unit/core/errors/error-types.test.ts
```

```sh
npm run build
```

```sh
node dist/cli/index.js --help
```

Independent assertions NOT authored by this worker: original94 classifier tests, actual existing terminal/ready codec cross-product, unchanged sender/text/target/checkpoint/error suites, strict source compiler, real packaged build/help. Controller independently repeats relevant gates, full accepted focused integration suites, byte/mode/index/original-body/frozen guards and serialized disposable fake-terminal WebSocket/status/cleanup. Workers never run the daemon smoke, full slow npm suite or real Signal/provider. Existing global lint debt is not clean-global proof; any real new diagnostic blocks, never waive it or broaden fixtures.

## Definition of done

- Minimal two-path producer correction and actual wire/classifier RED/GREEN, every original test body preserved, adjacent independent checks passing, complete compatibility/error/receipt/uncertainty/privacy/codec reasoning and ALL numbered Decisions/supersessions/limitations recorded.
- Save complete stable managed parent-gate draft/proofs/all current hashes/raw failures; obtain actual bound parent `PARENT_TASK021_CURRENT_SOURCE_GATE_PASS` BEFORE any final handoff or reviewer launch. Hold exact code stable. A correction invalidates prior admission; preserve old version/evidence and seek a new barrier.
- Stop uncommitted/staged0 for fresh independent whole-task GPT-6.1-sol xhigh review. A NEW separate exact-content Git-only contract/exact-commit review/actual objects/repeated committed gates/truthful WDD local integration follow; no prior no-commit contract reused for Git.
- No whole TASK-010/Signal/runtime/AC15/publication claim. Controller owns WDD/notes/memory/acceptance/integration; workers never stage/commit/submit/merge/release, mutate inputs or spawn reviewers.
