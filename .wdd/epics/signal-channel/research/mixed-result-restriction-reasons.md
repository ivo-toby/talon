# Mixed-result account restrictions: approved producer prerequisite

## Authority and scope

Ivo selected **Add TASK-021 (recommended)** after the controller described the two-path producer scope, existing-file consumer/Runner regressions, independent review, and local-only integration. He subsequently instructed: **“From now on; FINISH THIS WDD WORKFLOW WITHOUT ASKING ME, use your own judgetment”**. The controller may finish bounded corrections autonomously, preserving the frozen requirements, security-policy compatibility, original task definitions/history/snapshots and truthful acceptance. Workers still escalate ambiguities to the controller. No publication/final-main merge, production account/service/key work, fabricated AC-15, or review/test waiver follows.

TASK-021 changes only existing `src/channels/connectors/signal/signal-send-result.ts` and `tests/unit/channels/connectors/signal/signal-send-result.test.ts`. It is a producer prerequisite, not permission to edit uncommitted TASK-010, its tools/Runner/registry, a shared Error schema, sender/actor, or the runtime bridge. A controller decision is needed before crossing that boundary; the controller now exercises Ivo's standing autonomy rather than repeatedly asking him.

## Frozen requirement and actual public contracts

Approved design sections “Invocation guard and result ownership” and “Account send gate and recovery” require broadcast to stop visiting the affected account on observed rate/challenge/transport restrictions while independent accounts and healthy-origin explanations remain usable. The rate table explicitly covers RATE_LIMIT_FAILURE in any results or RPC -5. Receipt acceptance and account restrictions are distinct facts.

Pinned external reference is signal-cli v0.14.9, commit `3997429779095ff3a2d64c877126e84fce9852aa`. Relevant inventory sources: JsonSendMessageResult.java10–48, JsonRecipientAddress.java9–15, SendMessageResultUtils.java43–68, SignalJsonRpcCommandHandler.java229–290 and the existing sanitized wire evidence. Never infer missing contracts from a test-shaped replacement or moving upstream.

The actual classifier returns `SignalSendClassification { result, restrictions }`. `interpretSignalRestrictions` independently recognizes rate/challenge hints and retains every pause. The sender persists those hints before releasing actual ownership, but its public failure Result exposes only the existing SignalDeliveryError. The new TASK-010 broadcast predicate sees existing reasons, outcome and timing; it has no independent restriction-kind metadata. Current SignalConnector.status does not expose account pause kind. Private handles/status absence/deadline values are not authority to invent it.

## Confirmed defect and evidence limits

For complete valid same-RPC SUCCESS plus RATE_LIMIT_FAILURE, or SUCCESS plus a challenge-bearing valid failure, the classifier returns PARTIAL_ACCEPTANCE/PARTIAL/current-partial even though restrictions contain rate_limit/challenge. The existing broadcast predicate recognizes RATE_LIMITED/CHALLENGE_REQUIRED/UNKNOWN but not PARTIAL_ACCEPTANCE. Another affected-account binding may therefore be invoked before independent healthy accounts; the actual persisted sender gate still prevents sends during its pause. Do not claim an extra network RPC from this finding.

Parent actual public parser -> sanitized evidence -> classifier -> safe tool DTO/predicate diagnostic:
`.wdd/dispatch/pi-validation/TASK-010-parent-mixed-restriction-public-boundary.json`.
Recipient-only and challenge-only mixed PARTIAL DTOs are identical; challenge has no notBefore. Rate-only and rate+challenge mixed DTOs are also identical. All four return false from the existing account-stop predicate. This is boundary evidence, NOT a full Broadcast/connector/RPC regression. The complete fresh independent WHOLE review2 (31,611 bytes, SHA256 `3faef4dd31a0727ba33e5264eec7926c267b0d731fa9582c4ae5fe5762df0bff`) corroborates F6 P2.

## Minimal approved correction and invariants

Use actual recognized restriction evidence to select a safe EXISTING restriction-specific reason on a failed mixed-acceptance result, retaining the existing challenge-over-rate precedence. Recipient-only mixed results retain PARTIAL_ACCEPTANCE. Preserve the public Error shape and original PARTIAL outcome/current-partial acceptance/acceptedChunks/successCount/failureCount/retryScope:none. Preserve all independent restrictions, longest notBefore, conservative UNKNOWN precedence, all-success Ok receipts and their independently retained hints, codec representability, privacy and frozen count/cursor rules. This is not a reason to infer restriction kind from notBefore, blanket-stop every PARTIAL, or turn an accepted receipt into another outcome.

Read all actual downstream consumers before choosing the smallest code change. If the existing reason vocabulary cannot carry the required information without breaking an actual contract, stop for controller adjudication BEFORE changing any unowned API/schema/producer. No new fields/reasons/pause policy/quotas/timers/automatic retry or broad state query is approved by this brief.

Existing 94 tests, including the actual checkpoint-codec cross-product, remain untouched except additive imports/separate regressions. Cover normal result and relevant error envelopes; no prior prefix and real valid prior counts; mixed rate, challenge without a deadline, simultaneous hints, recipient-only partial, unknown/malformed/network precedence, all-success/hint behavior and privacy. Meaningful public wire/classifier RED precedes correction, then GREEN. Compilation/import/fixture errors are not product RED.

## Integration and remaining work

Original TASK-010 is held uncommitted on accepted base230c561a/tree50452717, with seven modified plus one new file. Its earlier F1–F4 corrections and parent barriers remain valid for their reported obligations; fresh whole review2 BLOCK found separate F5 completed-generation replay and F7 missing-runtime read-error admission. Parent actual Runner/QueueProcessor/SQLite diagnostics independently corroborated those two findings; they remain TASK-010 corrections, not this producer's scope.

After TASK-021 fresh source review, separate exact-content Git-only phase/exact-commit review/real committed gates/local integration, the controller honestly backs up/refreshes/restores all eight TASK-010 candidate files and creates new phase guards. TASK-010 then adds real Broadcast mixed-result consumer regressions and its F5/F7 corrections (plus a distinct actual thread-destination control for low note L1) under NEW contracts and parent pre-final barriers. Never edit or run a different worktree to manufacture an apparent producer pass. TASK-010's old 2,181/39 green tests, original failed evidence and 72 inherited fixture diagnostics are historical evidence, not whole acceptance.

TASK-012 actual same-DB composition/authenticated raw dispatch/generation drain/reload/IPC, TASK-014 feature documentation and unavailable live AC-15 remain separate obligations. This prerequisite is not whole Signal/AC-12/runtime/live acceptance.
