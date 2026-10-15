# Design review — round 1

- Document: `.wdd/epics/signal-channel/design.md`
  (SHA-256 `6aa8c00b82d39cdcacea75a9cd7ab7086c18ffadd1f7c7f70a0a208583cf2348`,
  identical to `research/design-review-1-input.md`)
- Author: Codex controller (per `design-review-1-brief.md`; exact model unrecorded)
- Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), requested by Ivo
- Profile: general + security
- Grounding: `spec.md`, `shared-context/contract-inventory.md`,
  `research/contract-constraints.md`, pinned `research/signal-cli-v0.14.9/`,
  repository source at `dcb6462`

## Findings (reviewer's words — immutable)

**F1 — P1 — Queue retry resends partial and ambiguous deliveries.**
Anchor: design "Connector.send" ("stop after a failed/unknown chunk. Never
resend an ambiguous outcome automatically"), "Generic delivery" ("Reuse the
current recipient resolution"); `src/daemon/agent-runner.ts:792-798,1063-1068`;
`src/queue/queue-processor.ts:247-282`.
The agent runner turns any `connector.send` Err into a thrown
`channel send failed`, which fails the queue item, and the queue processor
retries it with backoff. The retry re-runs the whole provider turn and sends
everything again. Scenario: a 5,000-byte reply is split into three chunks.
Chunk 1 returns SUCCESS, and chunk 2 times out (unknown outcome) or returns
NETWORK_FAILURE for one group member. The connector stops and returns Err, as
the design says. The queue item retries, the provider runs again (repeating any
tool side effects, including `channel_send`), and chunk 1, plus chunk 2 if it
was actually accepted, reaches the DM or group a second time. In personal mode
that duplicate comes from the operator's own identity. As written, "never
resend an ambiguous outcome automatically" holds only inside the connector;
the existing path around it breaks it. The design has to pick the boundary:
return a non-retryable error class the runner recognises, or document queue
retry as the accepted resend. The spec requires that this boundary be
documented, and the design names neither option.

**F2 — P2 — Format of the notification `account` field is unspecified, so a naive account check drops everything.**
Anchor: design "RPC client" ("Validate account…"), activation row "wrong
account"; `R/src/main/java/org/asamk/signal/json/JsonReceiveMessageHandler.java:26`;
`R/src/main/java/org/asamk/signal/commands/ListAccountsCommand.java:34-41`.
Receive notifications set `params.result.account` to `m.getSelfIdentifier()`.
That is the phone number when the account has one and the ACI only when it
doesn't. SignalConfig makes `accountUuid` canonical and lets `account` be
either a number or an ACI. Scenario: config `account: <ACI>`,
`accountUuid: <ACI>`, and the account has a number. Every notification carries
`+31…`, the mapper compares it with the ACI, and every inbound message falls
into "wrong account → Ignore". Source-derived fixtures written from the
inventory row `{account, envelope?…}` can encode either format and pass. The
design must state that the notification account is matched against the
`{number, aci}` pair from `listAccounts`, not against `accountUuid`.

**F3 — P2 — A bridge that is down at boot leaves Signal dead until reload.**
Anchor: design "Signal connector — lifecycle table" (inherits the spec's
`Stopped | Start → Ready or fail`); `src/daemon/daemon.ts:129-138`;
`src/channels/channel-registry.ts:95-111`.
If `start()` fails because the socket is not reachable yet, the daemon logs
"continuing without them" and never calls start again. Reconnect with backoff
only exists from Ready. Scenario: after a host reboot, systemd starts talond
before signal-cli has created its socket. Start fails and the channel stays
dead until an operator reloads, with no further diagnostic. The design does
not say whether a Start-time ECONNREFUSED/ENOENT means "fail" or "enter
Reconnecting". A worker could reasonably build either.

**F4 — P2 — Transitions on verification failure and on the `exception` field are unspecified.**
Anchor: design "RPC client" ("Validate account/version/device before
subscribing"), "Setup metadata" ("Runtime listDevices validates membership"),
spec lifecycle row "Verified unlink or unusable configured account";
`R/src/main/java/org/asamk/signal/json/JsonReceiveMessageHandler.java:27-29`.
Several verification outcomes have no target state: the account is missing
from `listAccounts`, `deviceId` is missing from `listDevices`, the version is
unexpected or `unknown`, or a verification RPC times out during Reconnecting.
Any of them could map to fail, Reconnecting or Needs setup. Nothing defines
what a "verified unlink" is, and the receive `exception` object (present with
or without an envelope) is never mentioned. Scenario A: a worker treats a
verification RPC timeout as Needs setup. A transient bridge stall then stops
the account permanently until an operator restarts it. Scenario B: a worker
ignores `exception`. A device unlinked from the primary keeps emitting
exception-only notifications, the connector stays Ready, and sends fail one by
one with generic errors. A decision table is needed, mapping each
verification or exception outcome to a state.

**F5 — P2 — Stale `deviceId` after relinking passes the membership check and breaks cross-instance echo filtering.**
Anchor: design "Setup metadata" ("Runtime listDevices validates membership
but cannot prove which entry is current"), "Generation policy".
Scenario: personal instance A (account X) is relinked into a fresh signal-cli
data directory before the old linked device is removed, so `listDevices`
returns both the old ID 3 and the new ID 4. The config still says 3. The
membership check passes and A goes Ready. Dedicated instance B (account Y)
shares a selected group with X and authorises X so the operator can command B
from their phone. B now treats A's replies, which are sent from device 4, as
operator commands. Any reply that starts with B's trigger starts a turn on B,
and if Y is authorised on A the two instances can loop. The design accepts
this indeterminacy but gives no compensating control, such as refusing when
devices exist that `createdTimestamp` shows were linked after the recorded
device, or refusing cross-instance authorisation of a personal account.

**F6 — P2 — In personal mode, the existing "Thinking…" and tool-call sends post as the operator.**
Anchor: design "Generic delivery" ("No scheduling-context or tool API
changes"); `src/daemon/agent-runner.ts:514-530,812-823`; `showToolCalls`
(`src/core/config/config-schema.ts:164`).
Scenario: a personal-mode persona that uses a CLI provider (gemini-cli,
codex-cli or openai-compatible) is triggered in a selected group. Before the
reply, the runner sends `Thinking...`, and with `showToolCalls` it also sends
tool descriptions. Both go out under the operator's personal identity and land
in a group that includes non-Talon participants. Interim messages already
exist on other channels, but personal mode makes them the operator's own
words, and the design treats delivery as "unchanged".

**F7 — P2 — Rate-limit and CAPTCHA outcomes have no backoff or circuit breaker.**
Anchor: design "Connector.send"; inventory "Per-recipient result"
(`RATE_LIMIT_FAILURE`, `retryAfterSeconds`), "Send error envelope" (-5, -6);
`R/src/main/java/org/asamk/signal/util/SendMessageResultUtils.java:57-66`.
The design turns -5 and -6 into typed errors and nothing more. Scenario: a
broadcast or scheduled job sends to 20 selected DMs on a personal account.
After the server rate-limits or demands a proof-of-work challenge, the
connector keeps sending the remaining items, and the queue retries (F1) add
more attempts. That escalates the server-side restrictions on the operator's
personal number. The send path has no stated bound and no state that pauses
sends until `retryAfterSeconds` has passed or the operator has solved the
challenge.

**F8 — P2 — Canonical encoding of config IDs is unspecified.**
Anchor: design SignalConfig (`allowedDmPeers`, `allowedGroups`,
`allowedSenders`: "Canonical UUID/group-ID arrays"), Mapper (base64url in
external IDs, "round-trip to canonical standard Base64").
Nothing says whether `allowedGroups` takes standard Base64 (what
`listGroups` prints, with `+`, `/` and `=`) or base64url (what external IDs
use), or whether UUIDs are compared case-insensitively. Scenario: an operator
copies a group ID out of a thread external ID in the logs, as base64url, into
`allowedGroups`. The mapper compares it with the standard-Base64 `groupId`
from the envelope, and the selected group is silently ignored. Uppercase UUIDs
pasted into `allowedSenders` fail the same way. Silent denial is
indistinguishable from "no trigger".

**F9 — P2 — "Unverifiable target" is undefined.**
Anchor: design "Connector.send" ("refuse blocked, unregistered, terminated,
disappearing or unverifiable targets").
`listContacts` with a recipient filter may return an empty array for a peer
the local store has never seen, while `send` by UUID still works (inventory:
"UUID addressing is accepted independently of a visible phone number").
Scenario: an operator adds a new peer UUID to `allowedDmPeers` and schedules a
first message. Whether that send succeeds or fails as "unverifiable" depends
on the implementer's reading. The result of a missing or empty contact needs
to be stated.

**F10 — P2 — Overflow and protocol-error recovery is unspecified.**
Anchor: design "RPC client" (the 1 MiB pre-response buffer, the 1 MiB frame
cap, the 64 pending RPCs; "overflow is a protocol/backpressure error").
Nothing says what the connector does next. Options include dropping the frame
and continuing, resynchronising to the next newline, tearing the connection
down into Reconnecting, or failing only the calling request. Scenario: one
oversized frame arrives mid-stream. If the reader only discards the bytes it
has buffered, it reads the rest of that frame as a fresh line and the parse
error repeats. If it tears down, every pending send gets an unknown outcome
(F1). When the 64-RPC cap is hit, nothing says whether the 65th
`connector.send` gets a definite not-sent error (which is safe to retry) or an
unknown outcome. The transitions need to be in the lifecycle table.

**F11 — P2 — Ignored events in personal mode are a metadata log of the operator's whole account.**
Anchor: design Mapper ("produces … ignored reason"), "Generation policy"
("content-free reason"); spec "A personal linked client has account-wide
access".
The design guarantees that ignored events are content-free but not that they
are free of metadata, and it gives no log level or rate limit. Scenario: in
personal mode, every message in every one of the operator's chats reaches the
mapper. An info-level "ignored: unselected chat" line containing the peer
UUID, group ID and timestamp writes the operator's full social graph and
messaging timeline into ordinary application logs and observability. The
design needs to say which identifiers may appear on ignored-event diagnostics,
and at what level.

**F12 — P2 — Frame-level error logging can leak message bodies.**
Anchor: design "RPC client" ("sanitized errors"), "Connector.send" ("Drop
challenge tokens and raw RPC errors").
"Sanitized" is not defined for parse or validation failures on inbound
frames. Scenario: a receive notification fails schema validation, for example
a new field type in a future signal-cli. The natural implementation logs the
offending line or a Zod issue whose `received` value is the message text, so a
private body from an unselected chat ends up in the logs. The design should
state that no frame payload, Zod `received` value or excerpt is logged, and
only field paths and codes are.

**F13 — P2 — A spoofed socket gets operator authority.**
Anchor: design SignalConfig (`socketPath`: "Required absolute local
Unix-socket path"); security profile, isolation.
talond trusts whatever is listening at `socketPath`. Scenario: an operator
follows a guide that uses `/tmp/signal-cli.sock`. Another local user creates
that path before the bridge starts and answers `version`, `listAccounts` and
`listDevices` with the expected values, which are all in the config and the
docs. That user then injects a Note to Self `dataMessage` from `accountUuid`
with a phone device ID, and talond admits it as a prefix-free operator
command. The design specifies no check on socket ownership or mode (for
example via `lstat`, owner equal to the expected UID, not world-writable), and
nothing rejects world-writable parent directories.

**F14 — P2 — Redaction rules for live evidence are undefined.**
Anchor: design "Epic deliverable" ("redacted real-device evidence"), AC-15.
Scenario: the live-evidence file committed to the repository contains the
operator's phone number, ACI, group IDs and device names, because "redacted"
was read as "no message bodies or credentials". Those are personal
identifiers with an enduring link to the operator. The design should list
what is masked: numbers, ACIs/UUIDs, group IDs, device names and timestamps.

**F15 — P2 — The bridge version policy is unspecified.**
Anchor: design "RPC client" ("Validate account/version/device"); inventory
"Bridge version" (`unknown` possible).
Nothing says which `version` strings are accepted: exactly `0.14.9`, a
semver range, or any value. A distro-packaged bridge reports `unknown`.
Scenario A: with an exact match, the operator's routine upgrade to 0.14.10
puts the channel into fail or Needs setup. Scenario B: with any value
accepted, a 0.15 bridge with a changed receive shape passes verification, and
F12 is how its failures show up.

**F16 — P2 — "Retryable" in AC-11 has no actor.**
Anchor: design "Ingress transaction"; spec "A failure between message
insertion and enqueueing remains retryable … replay completes one turn";
`src/channels/channel-setup.ts:103-111`.
With the atomic boundary, an Err rolls back the transcript, and the callback
only logs it. The bridge has already handed the event over, so nobody replays
it. Scenario: SQLITE_BUSY on enqueue for a real Note to Self command means the
command disappears with one log line, while the unit test passes by calling
`handleInboundEvent` twice. Either the connector holds and retries the event,
or the design states that a rollback is the spec's pre-acceptance loss
boundary and AC-11's replay exists only in tests. Today it says neither.

**F17 — P2 — CLAUDE.md is missing from the integration surfaces.**
Anchor: design "Integration surfaces" (docs row lists README, AGENTS.md,
example config and the setup guide); repository `CLAUDE.md` "Documentation"
rule.
CLAUDE.md lists the 7 channel adapters and the bot-filtering behaviour of each
connector under "Multi-connector". Both change. A worker following the
surfaces table leaves CLAUDE.md stale, and the repository's own rule treats
that as an incomplete feature.

**F18 — P2 — The deliverable command does not exercise AC-1 or AC-12.**
Anchor: design "Epic deliverable" command.
The command runs only the Signal connector, pipeline and transaction tests.
The config-schema, channel-factory, channel-setup, CLI and
channel-send/broadcast tests named in the surfaces table are left out.
Scenario: duplicate-account rejection (AC-1) or scheduled-recipient handling
(AC-12) regresses, and the deliverable command still passes.

## Attack log (sections tried, no break found)

- **Components**: checked that the attachment adapter is absent against AC-9;
  consistent.
- **Mapper identities**: tried merging threads through group renames, a second
  account and hidden numbers. The external ID includes `accountUuid` and the
  group ID, so they hold. `destinationUuid` can be null
  (`JsonSyncDataMessage.java:28`), which is covered by "Missing provenance is
  excluded".
- **Dedup key**: tried collisions between sync and data wrappers, and between
  edit and original. The key excludes wrapper and receipt time and
  edits are ignored, so they hold.
- **Own-send filtering within one instance**: signal-cli does not receive its
  own sends as sync, so a single instance cannot loop on its own replies. The
  only exposure is across instances (F5).
- **Chunking**: the ≤2,000-byte limit matches `ManagerImpl.java:946`
  (`>` promotes to an attachment). Splitting at code points can break grapheme
  clusters (ZWJ emoji), which is cosmetic and not filed.
- **Ingress transaction**: `handleInboundEvent` is synchronous
  (`channel-setup.ts:103`) and every repository uses the same DB
  (`daemon-bootstrap.ts:154-170`), so wrapping it in a better-sqlite3
  transaction is feasible. A thread row can be left behind on rollback, which
  is harmless.
- **Reload ordering**: `daemon.ts:432-445` stops all connectors before
  starting the new ones, so a reload does not race two subscriptions on one
  account.
- **Multi-account dispatch**: in single-account daemon mode `listAccounts` is
  `METHOD_NOT_FOUND`. Requiring multi-account mode is enforceable.
- **Injection**: outbound text travels as a JSON string param, and no shell,
  path or SQL concatenation is described. The runtime method allowlist blocks
  `startLink` and `updateAccount`.
- **Dependencies**: no new npm dependency is stated. Treated as none; F15
  covers bridge versioning.

## Dispositions

Recorded by Codex controller on 2026-10-14. All findings are accepted; their
priority and wording above remain unchanged. **Closed** below means that the
revised design specifies a concrete remedy and verification obligation. It does
not mean implemented, tested on Signal, independently upheld, or approved by
Ivo. Design sign-off and the human's convergence decision remain pending.

| Finding | Disposition | Remedy in revised design.md and required evidence |
| --- | --- | --- |
| F1 | Closed in design | **Terminal queue boundary and intentional output**: typed NonRetryableRunError survives stream/queue wrappers; every Signal failure, including handled tool errors, latches the run and dead-letters without rerunning it. A reserved durable queue-payload marker is written before Signal invocation and prevents crash redispatch. Tests count provider/tool calls after partial chunk, ambiguous send, tool failure and restart. Definite NOT_SENT also requires a new deliberate operator command. |
| F2 | Closed in design | **Account and device verification**: validate notification account against the discovered number/ACI pair. Add numbered-account/ACI-selector and numberless-account fixtures. Phone aliases do not become authorization keys. |
| F3 | Closed in design | **Lifecycle and RPC recovery**: start owns the retry loop and resolves in Reconnecting on transient first-connect failure. Fake-daemon proof starts the bridge later and observes Ready without reload. |
| F4 | Closed in design | **Lifecycle and RPC recovery** maps every verification failure, timeout and receive exception. Any nonnull receive exception discards its envelope and enters Needs setup; this conservative v1 policy includes per-message transient exceptions. RPC timeouts remain Reconnecting. Tests cover both exception-only and exception-with-envelope. |
| F5 | Closed in design | **Account and device verification** adds exact creation metadata and a strict newest-linked-device rule for personal bridges. Stale device 3 with newer 4 fails setup. Only verified frozen human-device rosters authorize local personal accounts across instances; unknown devices cannot trigger while verification is pending. New human links require relinking the bridge last. Test cross-instance triggered replies, ties/zero timestamps, relink and old-device replay; live provenance remains a gate. |
| F6 | Closed in design | **Terminal queue boundary and intentional output** suppresses personal Thinking/tool notices and intermediate text flushes; rejects personal showToolCalls=true. Explicit sends and completed background output remain intentional. The review's named provider example is broader than the code: suppressCliWaitingMessage already excludes gemini-cli/codex-cli/openai-compatible. The general progress/tool-message issue is accepted and addressed across actual CLI/SDK paths. |
| F7 | Closed in design | **Account send gate and recovery**: one active send and at most one chunk/second/account; persist rate/challenge pauses before releasing the call. Honor server delays with a 15-minute minimum; broadcast stops and restart preserves pauses. Challenge recovery is an explicit local operator resume after external resolution; no automatic failed-send replay. Fake-time and persisted-state tests cover tool/schedule/broadcast callers. |
| F8 | Closed in design | **SignalConfig and canonical identities** normalizes UUID case, requires strict padded standard Base64 in config, and validates separate unpadded Base64url external IDs with explicit conversion. Invalid encodings fail load; copied external-ID encodings never silently miss authorization. |
| F9 | Closed in design | **Target preflight, text and send outcomes** requires exactly one matching fresh peer/self/group record with explicit flags/timer. Empty/missing/ambiguous metadata is TARGET_UNVERIFIABLE. A new UUID alone does not guarantee a first send; missing recipient state requires operator repair, while a lookup that provides the required state permits sending without a prior Talon thread. Self-target evidence is a mandatory setup/live check, not an implicit exception. |
| F10 | Closed in design | **Lifecycle and RPC recovery** closes on frame/schema/receive-buffer failure and discards the complete parser buffer; never resynchronizes partial lines. Written sends become UNKNOWN, unwritten ones NOT_SENT. Request 65 is refused before writing; repeated protocol faults stop automatic recovery. Test pending requests, oversized remainder, overflow, cancellation and stop. |
| F11 | Closed in design | **Diagnostics, persistence and evidence privacy** replaces per-event ignored logs/audits with once/minute debug counters keyed only by configured channel and fixed reason; no social-graph IDs or message timing. Lifecycle diagnostics occur once per transition. Tests inspect logs/audit/observability for excluded-event metadata. |
| F12 | Closed in design | **Diagnostics, persistence and evidence privacy** permits only local enums, approved field paths and issue codes; forbids raw frames/excerpts/received values/remote messages/nested causes. Unknown schema paths are reduced to an approved parent. Signal pipeline error wrapping also excludes dedup-key metadata. Canary-body/error fixtures prove sanitization through shared callers. |
| F13 | Closed in design | **Local bridge trust boundary** requires same UID, private 0700 parent, 0600 socket, trusted nonwritable ancestors, no symlinks, and pre/post-connect identity checks. Direct /tmp and shared writable paths fail. Root/same-UID actors remain trusted; native and mounted-socket layouts are tested. |
| F14 | Closed in design | **Diagnostics, persistence and evidence privacy** masks numbers, all UUIDs, group IDs/names, device names, usernames, paths and exact timestamps with consistent synthetic identities/order. Strip secrets, raw stderr and capture metadata. Raw captures/mapping remain outside git; evidence staging receives a separate redaction review. |
| F15 | Closed in design | **Contract baseline and version policy** accepts exactly 0.14.9 initially; unknown/suffix/newer values enter Needs setup. Expansion requires reviewed contracts/fixtures/live evidence; no range or bypass is inferred. |
| F16 | Closed in design | **Atomic ingress and replay actor** adds an optional Result-aware receipt callback and connector-owned bounded FIFO/backoff. The connector retries a rollback for up to five minutes; a real fake-daemon test observes this actor without manual test replay. Stop/crash/overflow/deadline loss remains explicitly before acceptance. Existing void callbacks are preserved for other channels. |
| F17 | Closed in design | **Integration surfaces** explicitly includes CLAUDE.md channel/layout/filter documentation, alongside AGENTS.md, README, both skill trees and starter copies. |
| F18 | Closed in design | **Epic deliverable** uses a verification script that executes all listed focused test surfaces plus packaged CLI, baseline terminal and Signal smoke. Explicit AC-1 ownership/config and AC-12 scheduled/capability/context cases are required; missing files fail. New runner/queue/receipt/gate/IPC checks are included. Full slow suite is not implied. |

The source evidence for these dispositions is in
`research/design-review-1-response-evidence.md`. The main implementation scope
expands to the shared runner/queue error boundary, optional receive receipts,
account send-state persistence and local resume IPC. These are design remedies
for the approved reliability/security boundaries, not recorded spec amendments.
No implementation tests or live account operations were run for this revision.
