# Confirmed sender persistence handoff contract gap

Status: confirmed finding; Ivo explicitly selected “Add repair and continue (recommended)” after reviewing the two-file TASK-018 sender/API proposal and the preserved existing tasks/spec/design. Bounded implementation is approved through normal WDD admission/review/verification/local-integration gates, not automatic commit authority. TASK-008 remains an uncommitted five-file candidate. The original sixteen task definitions and approved TASK-017, specification/design and completed TASK-007 history remain unchanged.

## Independent review and parent evidence

Fresh whole-five TASK-008 review `4c5799ee-0cb3-4ae4-8ce9-e88cbbcbf5ed` (workflow `53db7c88-d49a-4dfc-9c6c-56fcd32728eb`) read the complete candidate and actual producer contracts. Verdict BLOCK:

- F1 P1/medium: real sender permanently poisons after exhausted settlement persistence; every later `drain()` returns its stored error. B retains repository/registry ownership until both producer Results are Ok. B's public repair delegates only to the verifier, and its contract forbids replacement/recovery on failed drain. No supported in-process repair/handoff exists even after database repair.
- F2 P2: ordinary sender poisoning is invisible to B's safe status. `stopFailure` is set only after explicit drain/stop; verifier may remain verified while status says ready and persistenceBlocked=false. Subsequent sends are refused. Not every STATE_WRITE_FAILED delivery error means the sender is poisoned, so inspecting that error code is not an adequate health API.

Actual producer anchors at accepted TASK-007 commit7990dae: `signal-send-coordinator.ts:248–266` drain; `:739–741` failed classified settlement; `:944–946` poison. `retryWrite` is bounded to six tries, then returns; classified result/writer is not retained for later repair. Poisoned state is never cleared by any exported method. Actual consumer anchors: `signal-connector.ts:270–302` stop/repair; `:327–354` status. The downstream TASK-009 and TASK-012 briefs do not own sender source/test and explicitly forbid outside-domain producer workarounds.

Parent independently executed actual compiled sender, actual wire/send-evidence parser and actual device proof against fully migrated in-memory SQLite, synthetic data, no network/provider:

1. Create real queue/destination ownership; send has one validated synthetic accepted recipient result.
2. Real SQLite trigger refuses reservation settlement until normal bounded write retries exhaust.
3. Return STATE_WRITE_FAILED with current acceptance COMPLETE/successCount1; first drain returns original DATABASE Err, reservation retained.
4. Remove the trigger (DB repaired); repeat public drain.
5. Same DATABASE error identity returned; exact reservation/state unchanged, only the original two RPC adapter calls (target metadata and send). No public producer operation can complete the retained classification/release B ownership.

Log `dispatch/pi-validation/TASK-008-review-F1-independent-probe2.log`. Earlier `...-probe.log` also confirmed permanent failure for UNKNOWN; that diagnostic returned a metadata-kind reply rather than the real send-evidence variant and is not complete-acceptance evidence. Refined probe uses actual `parseSignalSendEvidence`, matching actual RPC conversion, and explicitly asserts complete acceptance and count1. Both logs are retained; no source/test/assertion changed.

F2 is source-confirmed by actual poison path versus B status/readiness calculations; the current B tests cover explicit failed-stop ownership and verifier suspension, not ordinary sender poison publication.

## Proposed bounded remedy

Add high-risk TASK-018 depending on completed TASK-007, owning only:

- `src/channels/connectors/signal/signal-send-coordinator.ts`
- `tests/unit/channels/connectors/signal/signal-send-coordinator.test.ts`

Provide a narrow actual Result-gated retained-write handoff and safe persistence-health seam. Preserve classified acceptance/counts, every observed independent restriction, exact reservation/checkpoint/lease ownership, purge cancellation and no replay. Database repair retries only retained writes, never metadata/send/provider work. A successful handoff must prove all retained obligations settled; it must not reopen sender admission or unconditionally clear an error/owner. Non-DATABASE conflicts remain fail closed. No unchecked boolean `recovered`, fresh-handle workaround, broad startup recovery substituted for observed outcomes, schema or protocol change. Retained exact authority may need idempotent handling of genuinely committed cleanup Results; trace actual producers before choosing API.

After reviewed repair integration and safe verified backup/refresh/restore of TASK-008's five original candidate files, retained B owner may consume the actual new sender API in its existing three-path scope, add repair→successful handoff→replacement and ordinary-poison safe-status regressions, then fresh whole-five review and parent gates. Original A protected. Do not reopen completed TASK-007 or rewrite started TASK-008 dependencies/brief/history; hold its consumer gate until the prerequisite repair is accepted.

Ivo approved this new task/API boundary through the focused decision prompt, including normal consumer correction and autonomous continuation afterward. Apply/admit only this bounded task via WDD; preserve original seventeen task definitions and completed audit history. Staging/commit still require separate exact-byte authority after fresh independent review. Existing native Sol-high implementation/Sol-xhigh review, exact-byte commit-only, fresh exact-commit review, parent tests/build/help/serialized fake-terminal smoke and local-only WDD integration remain mandatory. No push/PR/main merge, real Signal/accounts/keys, production services/installations, full slow suite or destructive cleanup.
