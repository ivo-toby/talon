# Design review — round 2

- Document: `.wdd/epics/signal-channel/design.md`
  (SHA-256 `c1133cfd5068012bf40db69c22a862ceb389eb2a2315c2835ca4d7c6588c3552`, 522 lines)
- Author: Codex controller (round-1 revision; exact model unrecorded)
- Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), requested again by Ivo
- Profile: general + security (same as round 1)
- Grounding: `spec.md`, `shared-context/contract-inventory.md`,
  `research/contract-constraints.md`, `research/design-review-1-response-evidence.md`,
  pinned `research/signal-cli-v0.14.9/` and `research/review-1-source-additions/`,
  repository source at `dcb6462`

## Review of round-1 dispositions

| Finding | Reviewer view | Note |
| --- | --- | --- |
| F1 | Upheld, with residue | The terminal error, latch and durable marker close the agent-reply and tool paths. The background-notification path is not covered (R2-F5), and the remedy creates R2-F1 and R2-F6. |
| F2 | Upheld | Alias matching against the `{number, aci}` pair is specified. Refreshing aliases is R2-F7. |
| F3 | Upheld | `start()` owns the loop, and ENOENT under a trusted parent is transient. |
| F4 | Upheld as specified, but the remedy creates R2-F2 | Every outcome now has a target state, but sending every receive exception to Needs setup is itself a defect. |
| F5 | Upheld | The newest-linked-device rule fails closed on the stale-3/new-4 case. The cost (linking any new human device pauses personal mode) is disclosed. |
| F6 | Upheld | The correction that my provider example was wrong is accepted: `suppressCliWaitingMessage` already excludes gemini-cli, codex-cli and openai-compatible (`agent-runner.ts:508-511`). |
| F7 | Upheld as specified, but the remedy creates R2-F1 and R2-F3 | The pause, persistence and resume are specified. Busy rejection and the in-flight reservation introduce new failures. |
| F8 | Upheld | |
| F9 | Upheld | The per-target evidence table is decidable. |
| F10 | Upheld | |
| F11 | Upheld | |
| F12 | Upheld | |
| F13 | Upheld | Same UID, a 0700 parent and a 0600 socket close the other-UID spoofing case. The boundary that remains for same-UID processes is stated. |
| F14 | Upheld | |
| F15 | Upheld | |
| F16 | Upheld | The connector-owned FIFO is a concrete retry actor. |
| F17 | Upheld | |
| F18 | Upheld | |

## Findings (reviewer's words — immutable)

**R2-F1 — P1 — Busy rejection plus terminal NOT_SENT dead-letters ordinary concurrent replies.**
Anchor: design "Account send gate" ("Only one send call is active per
account; a competing call returns SEND_BUSY/NOT_SENT immediately"; "chunks
start at most once per second"), "Target preflight" ("Every Signal delivery
error is terminal for automatic turn retry, including definite NOT_SENT"),
"Terminal queue boundary" (the "Signal send fails at any stage" row);
`src/core/config/config-schema.ts:194` (`concurrencyLimit` default 5).
Scenario: the operator triggers Talon in two selected groups a few seconds
apart. Run A's 3-chunk reply holds the account gate for about 2–3 s because
of the one-chunk-per-second spacing. Run B finishes inside that window, gets
SEND_BUSY/NOT_SENT, latches, and returns NonRetryableRunError. The queue
dead-letters it, so group B never gets a reply and nobody on Signal is told.
Under the default concurrency of 5 this is a routine timing outcome, not an
edge case. The same terminal rule turns other transient local refusals into
permanent loss: Reconnecting during a 5-second bridge restart, a 65th pending
request, and a pre-send verification failure (R2-F8). In all of them nothing
left the socket and no Signal-side effect happened. The design's rationale
(rerunning the provider repeats tool effects) does not require rejecting
instead of waiting: a bounded wait on the gate needs no provider rerun. As
written, the busy and transient paths deterministically drop replies.

**R2-F2 — P1 — Any receive exception halts the account, and a remote party can trigger it.**
Anchor: design lifecycle row "Receive / nonnull exception with or without an
envelope → Needs setup: RECEIVE_EXCEPTION"; prose ("V1 conservatively
requires operator inspection for every receive exception, including one
caused by a per-message transient fault"); spec ("An event whose account or
authorship cannot be verified is not admitted; emit a diagnostic"; lifecycle
row "Verified unlink or unusable configured account → Needs setup");
`R/src/main/java/org/asamk/signal/json/JsonMessageEnvelope.java:36-43`;
`R/src/main/java/org/asamk/signal/json/JsonReceiveMessageHandler.java:27-29`.
Per-message exceptions are an expected part of signal-cli's receive output.
The source has a dedicated branch for `UntrustedIdentityException`, which
fires when any contact's safety number changes, and decryption or session
faults also arrive as exceptions. A personal-mode bridge sees every chat on
the account, including unselected ones and strangers. Scenario: a contact in
an unselected group reinstalls Signal and posts. signal-cli emits an
exception notification, the connector goes to Needs setup, and every selected
chat and Note to Self stops receiving until the operator manually restarts or
reloads. Any third party who can produce an undecryptable or untrusted-identity
envelope to the operator's number can repeat that at will. The spec
classifies an unverifiable event as excluded per event, and reserves Needs
setup for an unusable account. The design widens one stranger's bad message
into a halt of the whole account.

**R2-F3 — P2 — Every UNKNOWN outcome or interrupted send needs manual resume, including reloads.**
Anchor: design "Account send gate" ("Socket loss, unknown outcome or a
failed result-state write leaves that reservation intact and enters Needs
setup: SEND_STATE_UNCONFIRMED"; "Persisted in_flight reservation on
restart"); "Any active state / stop or replacement → … cancel …
requests"; `src/daemon/daemon.ts:432-445` (every hot reload stops all
connectors).
Scenario A: the operator runs `talonctl reload` to change an unrelated
persona while a Signal reply is in flight. `stopAll` cancels the pending send,
which becomes UNKNOWN with the reservation left in place. After the restart
the account is in Needs setup until someone runs `talonctl signal-resume`.
Scenario B: one send takes longer than `requestTimeoutMs` (default 30 s), for
example to a large group on a slow link, and has the same result. Scenario C:
the daemon is restarted by systemd or exits on OOM mid-send. The design
neither bounds how often this happens nor makes reload wait for in-flight
sends, and the deliverable has no test showing that a reload with an active
send leaves the channel usable.

**R2-F4 — P2 — The latch's "abort automatic reply delivery" silences replies on non-Signal channels.**
Anchor: design "Terminal queue boundary" (the "Signal send fails at any
stage" row: "abort automatic reply delivery"; the "Tool handles a Signal send
failure" row: "runner ultimately returns NonRetryableRunError even if the
provider emits a final result"; "This also covers explicit
channel_send/broadcast on a Signal channel from … a run originating on
another channel").
Scenario: a Telegram user asks the persona to "post the summary to my Signal
group". The account is rate-paused, so `channel_send` returns
RATE_LIMIT_PAUSED. The provider produces "I couldn't post to Signal: rate
limited for 15 more minutes". Read literally, the latch aborts that final
reply, so the Telegram user gets silence and a dead-lettered item. The same
happens on Signal itself when a send to a different Signal target fails. A
reader can build "abort all automatic replies" or "abort further Signal sends
only". The text says the first. That defeats the structured tool error the
design adds for the model to act on.

**R2-F5 — P2 — Background-task notifications bypass the delivery guard and are retried by the queue.**
Anchor: design "Terminal queue boundary" ("A run-scoped delivery guard maps
trusted run ID to the current queue item"; "Every agent reply, channel_send
and broadcast passes trusted run context"); `src/daemon/agent-runner.ts:65-69,1506-1530`.
`AgentRunner.run` sends background-task notification queue items through
`deliverBackgroundTaskNotification`. That path has no run ID and wraps a send
failure in a plain `Error`. Scenario: a background task finishes and its
notification send to a Signal DM times out (UNKNOWN). The path is not in the
guard's enumerated callers, so no marker is persisted and no
NonRetryableRunError is raised. QueueProcessor applies backoff and sends the
notification again, which is exactly the ambiguous resend F1 forbids.
Alternatively, if the guard demands a run ID, the background output is never
sent at all ("If persistence fails, no send is attempted"). The design does
not name this caller.

**R2-F6 — P2 — Pre-send device recheck is a server round-trip, and a failure kills the reply and the subscription.**
Anchor: design "Account and device verification" ("Recheck devices every 60
seconds and before outbound sends"); lifecycle row "IO_ERROR (-3) during
verification → Reconnecting"; "Every Signal delivery error is terminal";
`R/lib/src/main/java/org/asamk/signal/manager/internal/ManagerImpl.java:483-485`
(`listDevices` calls `LinkDeviceApi.getDevices` on the Signal server).
Device verification is not a local read. It is not stated whether "before
outbound sends" means per send call or per chunk. Scenario: a brief Signal
service error during the pre-send `listDevices` returns -3. The send is
NOT_SENT and therefore terminal (R2-F1), and verification failure moves the
connector to Reconnecting, tearing down the receive subscription for a
server-side blip that had nothing to do with the socket. Each reply also
costs an extra authenticated server request on top of the 60-second poll,
and neither has a stated budget against Signal's own rate limits, which the
rest of the design treats as a threat to the account.

**R2-F7 — P2 — Account aliases are refreshed only on reconnect, so a number change drops all inbound silently.**
Anchor: design "Account and device verification" ("Store that generation's
number/ACI aliases … Refresh aliases on every reconnect"; "A wrong/unknown
alias is ignored with an aggregate diagnostic"; the 60-second recheck covers
devices only); `A/lib/src/main/java/org/asamk/signal/manager/Manager.java:97-106`
(`getSelfIdentifier` prefers the current number).
Scenario: the operator changes the account's phone number on their primary
device. The bridge then labels every notification with the new number. The
connection stays healthy and never reconnects, so the connector keeps
discarding every message as "wrong alias" behind a debug-level aggregate
counter (F11 remedy), possibly indefinitely. A changed alias for a verified
ACI needs a defined transition: re-verify, or Needs setup.

## Attack log (sections tried, no break found)

- **Socket trust boundary**: tried replacing a socket from another UID, a
  symlinked ancestor, sticky `/tmp`, and a Docker mount. Each is rejected or
  explicitly trusted. A lstat/connect race needs write access to the 0700
  parent, so only the same UID can exploit it, and the design scopes that
  case out.
- **Freshness rule**: tried stale/new devices, tied timestamps, and a primary
  device included in the roster. The primary is excluded from the newest-device
  check and included in the human roster, which is correct given that
  `getLinkedDevices` returns every server device (`ManagerImpl.java:483-505`).
  `createdAt` falls back to 0 when it can't be decrypted
  (`ManagerImpl.java:499-502`), so personal mode may fail closed on a real
  account. The design already makes this a live gate rather than a silent
  pass. Not filed.
- **Canonical IDs**: tried URL-safe group IDs, missing padding, and uppercase
  UUIDs in config. All are rejected or normalised at load.
- **Send outcome table**: tried an empty result set, a mix of NETWORK_FAILURE
  and success, a non-success envelope carrying nested successes, and a valid
  failure-only set. Each maps to a single outcome.
- **Rate pause**: tried a malformed `retryAfterSeconds`, overflow, restart
  during a pause, and resume during an unexpired pause. All are covered.
- **Receipt FIFO**: tried a rollback followed by reconnect, a stop during
  retry, and overflow while retries are pending. Each is bounded, and the loss
  cases are labelled pre-acceptance.
- **Personal output policy**: Thinking, tool notices and pre-tool flushes are
  suppressed, and `showToolCalls=true` is rejected at load. Explicit sends
  stay intentional.
- **Version policy, diagnostics, evidence redaction**: the round-1 attacks
  were repeated against the new text, and no new break was found.
- **Integration surfaces / deliverable**: the new tables, IPC, CLI and
  migration are listed, and the verify script fails on missing test files.

## Dispositions

Recorded by Codex controller on 2026-10-14. All seven findings are accepted.
Original findings, severity and round-1 reviewer assessments above remain
unchanged. **Closed in design** means the active design names a concrete remedy
and its required evidence; it does not mean implemented, independently upheld
or approved. Neither P1 is accepted as a residual defect. Further independent
review and Ivo's convergence/design sign-off remain pending.

| Finding | Disposition | Revised design remedy and required evidence |
| --- | --- | --- |
| R2-F1 | Closed in design | **Saved replies and retry boundary** and **Account send gate** replace immediate busy rejection with a bounded FIFO shared by chunks. Completed final/background text and a chunk cursor are saved in the existing queue payload. Transient unwritten failure retries only delivery, with a 24-hour expiry, separate from provider maxAttempts. No accepted/uncertain chunk or provider/tool turn is replayed. Capacity/30-second wait exhaustion defers saved output rather than dropping it. Tests run two groups at default concurrency 5/maxAttempts 3, restart the bridge briefly, saturate RPC/wait capacity, and count one provider/tool execution per turn. Terminal/expired delivery is exposed locally with a safe warning/status. |
| R2-F2 | Closed in design | **Lifecycle and RPC recovery** now excludes each exception-bearing/unverifiable notification individually and keeps the subscription/proof. Untrusted identity, decryption/session, exception-only and unknown per-message faults cannot cause Needs setup, forced verification or the protocol-failure counter. Only account-level verification/trust/protocol evidence can stop the channel. Tests repeat faults from strangers/unselected chats while selected groups and Note to Self still work. |
| R2-F3 | Closed in design | **Lifecycle** quiesces new dispatch and drains the one active chunk RPC for its remaining deadline, capped at 30 seconds, before reload closes it. **Account recovery** separates the uncertain delivery from channel usability: that delivery remains terminal; account reconnect/verification plus a 60-second automatic recovery fence permits distinct later sends without signal-resume. Longer known rate/CAPTCHA restrictions remain enforced. Tests cover successful drain, forced cancellation, process crash, saved unwritten work and a later successful distinct send with no replay. |
| R2-F4 | Closed in design | **Invocation guard and origin replies** keys safeguards by trusted queue/delivery/purpose. A handled Signal tool error does not itself fail the provider run or blanket-suppress final replies. An explanation on Telegram, account Y or another healthy Signal target proceeds; account-wide restrictions still affect their own account. PARTIAL/UNKNOWN forbids repeating the failed explicit operation, including with a new tool request ID. Tests cover Telegram-to-Signal failure, same-account different-target refusal and mixed-account broadcast. |
| R2-F5 | Closed in design | **Saved replies** explicitly handles deliverBackgroundTaskNotification before its early return. Trusted context uses queueItemId/deliveryId with runId optional; the background checkpoint retains task/status/text and does not create a provider run/session. NOT_SENT retries only saved delivery; UNKNOWN/restart-in-flight is terminal for that notification. Tests exercise the actual background queue branch, nullable run ID, crash/timeout, no duplicate RPC and exactly-once outbound-history insertion after acceptance. |
| R2-F6 | Closed in design | **Account and device verification** removes listDevices from sends/chunks. One account verifier has one in-flight request and at most one attempt per 60 seconds across startup/reconnect/refresh, with the budget persisted across restart. Established-socket transient failure preserves subscription and cached proof for at most five minutes; expiry suspends only dependent work until refresh. Known proof violations still fail closed. Tests count calls under bursts, retain receiving through a short server blip, renew/expire proof and preserve the newest-device check. |
| R2-F7 | Closed in design | **Account aliases** refresh local listAccounts every 60 seconds and coalesce unknown-alias refresh at most once per five seconds. A bounded 30-second quarantine can replay a validated notification only after the pinned ACI proves its new number; runtime RPCs use ACI. An obsolete phone selector is a stale hint if it resolves nowhere and the ACI still exists; a selector resolving to another ACI fails closed. Test number change without socket reconnect and reject another account's alias. |

These changes retain round 1's goals while superseding its overly broad
all-error terminal handling, receive-exception halt and mandatory recovery for
every uncertain send. Delivery-only retry is explicitly distinct from provider
turn retry. Ordinary Signal text now buffers to a final saved reply in both
modes; dedicated progress notices remain optional/best effort, and personal
mode stays quiet. Existing tool/schedule success semantics are retained: a
transient explicit tool send is not silently queued or reported as delivered.

Supporting repository/source reads are in
`research/design-review-2-response-evidence.md`. The reviewed revision is frozen
as `research/design-review-2-input.md`. No implementation, runtime test or live
Signal operation was performed for these coordinator dispositions.
