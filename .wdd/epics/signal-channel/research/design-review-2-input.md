# Design: Signal channel

## Components

- **Signal RPC client** — one permission-restricted Unix-socket connection
  per account; newline framing, request correlation, manual receive subscription,
  validated responses, bounded buffers/timeouts, cancellation and safe errors.
- **Signal policy and event mapper** — canonical account/conversation identities;
  verified device policy, chat/sender authorization, the approved activation
  table, ignored-event counters and stable idempotency keys.
- **Signal connector** — lifecycle and recovery tables, account verification,
  plain-text formatting, UTF-8 chunking, fresh destination checks and serialized
  account sends. No attachment adapter or cryptographic account-directory access.
- **Delivery guard and account send gate** — terminal queue handling for Signal
  delivery attempts; persistent rate-limit/challenge pauses across every caller,
  including tools, schedules, broadcasts and restart.
- **Inbound acceptance boundary** — Result-returning SQLite transaction plus a
  bounded connector-owned retry buffer. Transcript/dedup/routing/enqueue commit
  together; rollback has an explicit retry actor.
- **Operator setup and proof harness** — both account modes, device metadata,
  native/mounted-socket guidance, capabilities/bindings, deterministic packaged
  smoke, targeted regression checks and redacted live-device evidence.

## Interfaces

**Contract baseline and version policy (F2, F4, F15)**

Consume `shared-context/contract-inventory.md`,
`research/contract-constraints.md` and the pinned v0.14.9 reference. Round-1
clarifications below refine those constraints; the original research snapshot
and approved spec remain immutable. Supporting source reads are recorded in
`research/design-review-1-response-evidence.md`. Fixtures distinguish source
contracts from observed live behavior.

The initial accepted `version` value is exactly `0.14.9`. `unknown`, development
suffixes, other patch versions and newer minor versions enter **Needs setup**
with `UNSUPPORTED_VERSION`. No configurable bypass or inferred semver
compatibility. A new accepted version requires contract review, updated fixtures
and live evidence in a later change. Setup pins this version and explains the
upgrade boundary. Multi-account daemon mode is mandatory: a missing
`listAccounts` method is `UNSUPPORTED_BRIDGE_MODE`, also Needs setup.

Runtime RPC methods are version, listAccounts, listDevices, subscribeReceive,
unsubscribeReceive, listGroups, listContacts and send. All account-specific calls
include the configured selector. Registration, linking, CAPTCHA solving and
container supervision remain operator actions.

**SignalConfig and canonical identities (F8)**

One normalized schema is shared by config load, connector and CLI guidance.

| Field | Constraint or default |
| --- | --- |
| `accountMode` | Required `personal` or `dedicated` |
| `socketPath` | Required absolute path satisfying the socket trust boundary below |
| `account` | Required E.164 selector or canonical ACI; selector must resolve to `accountUuid` |
| `accountUuid` | Required ACI in UUID form; normalize hexadecimal letters to lowercase |
| `deviceId` | Required positive safe integer from standalone CLI's current-device marker; personal mode requires a linked device, not primary device 1 |
| `deviceCreatedTimestamp` | Personal mode: required positive safe integer, taken from JSON listDevices for the marked device; dedicated mode: optional, verify equality when supplied |
| `allowedDmPeers`, `allowedSenders` | UUID arrays, normalized to lowercase; default empty; no phone numbers, names, PNI prefixes or usernames |
| `allowedGroups` | Strict canonical padded standard Base64 group IDs; default empty |
| `triggerPrefix` | Nonempty; default `!talon`; parsing follows the approved spec |
| `requestTimeoutMs` | Integer 1,000–120,000; default 30,000 |
| `reconnectBaseMs`, `reconnectMaxMs` | Integers 100–60,000 and 100–300,000; max ≥ base; defaults 1,000/60,000 |

UUIDs must have the 8-4-4-4-12 hexadecimal layout; no braces or surrounding
whitespace. Standard Base64 config values must decode to nonempty bytes and
re-encode identically with padding; reject URL-safe alphabet, missing required
padding, whitespace and invalid encodings at load with a field-path error.
External group IDs use unpadded Base64url; validate their round trip separately
and explicitly convert to standard Base64 for RPC/config. Setup displays the
config form. Duplicates are removed after normalization. Wire UUIDs undergo the
same UUID normalization; wire group IDs require strict standard Base64 decoding.

External IDs are `signal:v1:<accountUuid>:self`,
`signal:v1:<accountUuid>:dm:<peerUuid>` and
`signal:v1:<accountUuid>:group:<base64url-id>`. Authorization compares canonical
identities. Group authors remain participants. Dedup encodes version, account,
conversation, author, original source device and data timestamp, excluding
wrapper kind and local receive time. Unresolved provenance is excluded before
persistence. `raw` is absent on Signal InboundEvent; the original envelope is
never handed to the shared pipeline.

**Local bridge trust boundary (F13)**

V1 requires the bridge and talond to run as the same effective numeric Unix UID.
The socket's immediate parent is owned by that UID and has mode 0700; the socket
is owned by that UID, is a Unix socket and has mode 0600. Every ancestor up to
root must be owned by that UID or root and have no group/world write permission.
Reject symlinks in the configured path, socket or ancestors. Check with lstat
before every connection and repeat the checks and socket device/inode comparison
immediately after connecting, before any identity RPC or subscription. Changes
close the connection and enter Needs setup. ENOENT under an otherwise trusted
parent is transient; an unsafe existing path is a trust failure. Never unlink,
chmod or replace operator-owned paths from talond.

A socket directly in /tmp, or below a world-writable ancestor, is rejected even
when a sticky bit is set. Native guidance uses a private directory under a
trusted /run path; Docker guidance mounts that private directory with matching
numeric UID and permissions. Container-runtime-managed mount resolution is
trusted; filesystem symlinks in the mounted path still fail validation. No
portable SO_PEERCRED claim is made. Restricting path replacement provides the
other-UID boundary; root and processes sharing talond's UID remain trusted, as
they already control its config and database. Fixtures cover unsafe parents,
wrong UID, symlinks, replaced sockets and valid native/mounted layouts.

**Account and device verification (F2, F5)**

Resolve the selector to exactly one listAccounts `{number, aci}` record whose
normalized ACI equals accountUuid. Store that generation's number/ACI aliases.
Receive `params.result.account` must match that record's number or normalized
ACI; it is not compared only with accountUuid. Numbered accounts normally emit
the number even when selected by ACI; numberless accounts emit the ACI. These
are transport aliases only; account/peer authorization remains UUID-based. A
wrong/unknown alias is ignored with an aggregate diagnostic. Refresh aliases on
every reconnect; never infer an unknown account from an envelope sender.

Setup stops the bridge and uses the same account/data-directory selection as
its supervised service. Standalone plain listDevices establishes the current
marker; JSON listDevices supplies exact device ID/creation-time metadata. Setup
emits them together. Talond never reads the account keys. Runtime checks
membership and, in personal mode, the following conservative freshness rule:

- The configured device's creation timestamp is nonzero and exactly matches
  deviceCreatedTimestamp.
- Among non-primary linked devices, every other device has a known, nonzero
  creation timestamp strictly earlier than the configured bridge device.
- An equal/newer timestamp, unknown timestamp, changed creation timestamp or
  missing configured device enters Needs setup. This requires the personal
  bridge to be the most recently linked device. Linking another human device
  subsequently pauses personal mode until the operator relinks the bridge last
  and refreshes metadata. Timestamp ties require repair, not a guessed ordering.

This is a fail-closed compensating rule; RPC still cannot identify the current
local device. It blocks the reviewed stale-3/new-4 relink scenario even if both
IDs remain members. A service must not be pointed at a different existing
account directory while reusing old setup metadata. That operator-controlled
change requires a fresh setup. Live evidence must validate nonzero creation
metadata and the freshness rule; if the bridge cannot expose that evidence,
personal mode remains incomplete rather than weakening the check.

Construct an immutable generation registry before any receive subscription:
all configured Signal account UUIDs and modes, their generated-device IDs and
verification status. Reject duplicate resolved receive ownership. A verified
personal account additionally publishes its frozen human-device roster (the
verified device list minus the bridge). Own personal commands and personal
account senders in another local instance require a device in that roster;
missing/unknown devices are ignored and request re-verification. Messages from
a configured dedicated account are excluded across local instances regardless
of source device. A configured personal account without verified provenance is
excluded across instances, including during initial start and reconnect.
Personal account UUIDs are not generic sibling bot IDs.

Recheck devices every 60 seconds and before outbound sends. Roster changes
invalidate the published personal proof and cause full verification. An unknown
source device cannot be admitted while waiting for this check. A replay with a
data timestamp earlier than the applicable device's creation is excluded, so a
reused device ID does not authorize old sends. Removed/unknown devices remain
excluded across restart. Tests cover stale 3/new 4, tied/zero times, new human
devices, failed verification in a sibling, early echoes and restart replay.
Live fixtures must prove source-device attribution and both personal entry
points; no source-only fixture is presented as that proof.

**Lifecycle and RPC recovery (F3, F4, F10)**

start() owns one connection/reconnect loop and resolves after the first bounded
attempt, whether Ready, Reconnecting or Needs setup. It does not throw a
transient first-connect error and depend on the daemon to call start again.
Repeated start while active is a no-op. Reconnect uses capped exponential
backoff with jitter; each reconnect performs trust/version/account/device
verification before establishing one manual receive subscription.

| State/event | Target state and action |
| --- | --- |
| Stopped / start, valid verification | Ready; publish proof and one subscription |
| Start or Ready / absent socket under trusted parent, refused connection, disconnect or RPC timeout | Reconnecting; invalidate proof, clear subscription and schedule reconnect |
| Reconnecting / successful verification and subscription | Ready |
| Reconnecting / repeated transport or verification timeout, or IO_ERROR (-3) during verification | Reconnecting with capped backoff; no sends while unverified |
| Any verification / missing or ambiguous account, selector/ACI mismatch | Needs setup: ACCOUNT_MISMATCH |
| Any verification / missing device or failed personal freshness rule | Needs setup: DEVICE_METADATA_INVALID |
| Any verification / unknown/unsupported version or listAccounts unavailable | Needs setup: UNSUPPORTED_VERSION or UNSUPPORTED_BRIDGE_MODE |
| Any verification / other application refusal or missing required method | Needs setup: VERIFICATION_REFUSED; raw error text is discarded |
| Any active state / unsafe or replaced socket path | Needs setup: UNTRUSTED_SOCKET |
| Receive / nonnull exception with or without an envelope | Needs setup: RECEIVE_EXCEPTION; discard the entire notification, invalidate proof and close subscription |
| Receive / no exception and valid envelope/account/subscription | Apply mapper and activation table |
| Receive / no exception and no envelope | Ignore as empty/control notification; no transcript |
| Any active state / stop or replacement | Stopped; cancel subscription, verification, requests and all timers; no later reconnect |
| Needs setup / operator repairs and restarts/reloads | New verification attempt; challenge pause additionally requires explicit resume below |
| Stopped, Reconnecting or Needs setup / send | Typed definite NOT_SENT unavailable/setup error; no send RPC |

A successful account/device response proving absence is a confirmed unusable
account/device. Exception text is never parsed to infer unlink. V1 conservatively
requires operator inspection for every receive exception, including one caused
by a per-message transient fault; verification RPC timeouts remain automatic
reconnect cases. This tradeoff keeps incomplete receive data from attaining
operator authority. Test exception-only and envelope-plus-exception separately.

RPC frames are limited to 1 MiB before newline, buffered pre-subscription-response
notifications to 1 MiB total, and correlated pending requests to 64. Subscription
and connection generation must match before policy evaluation. Stop cancels
pending promises/timers and discards stale-generation notifications.

| RPC fault | Recovery and send outcome |
| --- | --- |
| Oversized line, invalid JSON or invalid required frame/schema | Close the socket immediately; discard the entire parser buffer; Reconnecting, with no newline resynchronization |
| Pre-response notification buffer overflow | Close socket, discard that unaccepted buffer; Reconnecting |
| Third framing/schema/overflow failure within five minutes | Needs setup: PROTOCOL_FAILURE_LOOP; no infinite hot reconnect |
| Request 65 when 64 are pending | Reject request before writing, definite NOT_SENT; connection remains active |
| Timeout/disconnect/protocol failure before a send was submitted to the socket | NOT_SENT |
| Timeout/disconnect/protocol failure after any send bytes were handed to the socket | UNKNOWN, even if socket write completion was not observed |
| Stale subscription, generation, response ID or unrelated account | Ignore/count; never resolve another request or admit an event |

Closing a connection settles all pending requests exactly once. Unwritten sends
are NOT_SENT; potentially written sends are UNKNOWN. Discarded subscription
buffers are outside local durable acceptance; upstream replay is unverified and
never claimed. Protocol counters are low-cardinality diagnostics below.

**Target preflight, text and send outcomes (F9)**

Connector.send returns `Result<void, ChannelError>`; Signal failures use a typed
SignalDeliveryError carrying an enumerated reason, `NOT_SENT | PARTIAL | UNKNOWN`
outcome, accepted-chunk count and success/failure counts. No raw remote cause,
recipient identifiers, bridge timestamps or challenge values are retained in
that error. Every Signal delivery error is terminal for automatic turn retry,
including definite NOT_SENT: retrying a provider turn can repeat earlier tool
side effects even when this particular send never left the socket.

Reject attachments, malformed/stale-account IDs and unselected destinations
before any send. For each chunk, fetch fresh target state; there is no timer-
state cache across chunks. `listContacts` uses recipient UUID plus
allRecipients=true. Configuring a UUID alone does not establish safe target state.

| Target | Required evidence immediately before each chunk |
| --- | --- |
| Selected DM | Exactly one matching normalized contact; isBlocked=false, unregistered=false, messageExpirationTime=0 |
| Personal Note to Self | Verified own account plus exactly one matching self contact with the same flags/timer; send via noteToSelf |
| Selected group | Exactly one matching group; isMember=true, isBlocked=false, isTerminated=false, messageExpirationTime=0; required member/provenance fields parse |
| Missing/empty/ambiguous record, missing required fields or failed lookup | TARGET_UNVERIFIABLE, NOT_SENT if no previous chunk; otherwise PARTIAL |
| Known blocked/unregistered/expired/terminated/nonmember state | TARGET_REFUSED, NOT_SENT if no previous chunk; otherwise PARTIAL |

Setup explains that adding a new peer UUID does not guarantee a first send:
if the lookup returns no matching safe state, the operator establishes recipient
state before retrying. A lookup that supplies the required record permits the
send without a prior Talon thread. The same missing-state rule applies to Note
to Self; setup verifies its
self-contact record and zero timer, and live evidence must prove this path.
No failed lookup silently defaults a disappearing timer to zero. A timer change
racing after the final local query is a network boundary, not an atomic policy
claim.

Format using stripMarkdown and split ordered chunks at at most 2,000 UTF-8
bytes without splitting code points. Inspect result and error.data.response;
require a valid timestamp and complete parseable result set with no failures for
success. Stop on the first failed, incomplete or unknown chunk. Earlier chunk
successes and per-recipient partial results are counted in the typed failure;
never send remaining chunks or replay successful chunks automatically. Bridge
acceptance does not prove recipient delivery/read. Generic tools expose the
outcome/counts with `retryable: false` and an operator-inspection instruction.

An empty result set, malformed/missing response or any NETWORK_FAILURE gives
UNKNOWN, with known success counts retained. An entirely valid nonempty set of
explicit non-network failures is NOT_SENT if no earlier success exists; known
success mixed with such failures is PARTIAL. A non-success RPC envelope remains
an error even when its nested response reports successes. Only an ordinary
success envelope and complete successful recipient results yield Ok.

**Terminal queue boundary and intentional output (F1, F6)**

Add a NonRetryableRunError recognized by QueueProcessor through typed identity,
not message-string matching. Preserve it through stream unwinding,
AgentQueryAttemptError, the runner's outer Result and QueueProcessor's thrown-
error catch. It bypasses fresh-session retry and moves the item directly to
existing dead_letter state, regardless of attempts remaining. Other channels'
error/retry behavior remains unchanged.

A run-scoped delivery guard maps trusted run ID to the current queue item.
Immediately before the first Signal delivery invocation, persist a reserved
`signalDeliveryStarted` marker in that queue item's payload. If persistence
fails, no send is attempted. This also covers explicit channel_send/broadcast
on a Signal channel from a scheduled run or a run originating on another channel.
The marker is set by host code, never accepted from model/tool arguments.

| Run/queue event | Required behavior |
| --- | --- |
| Signal send fails at any stage | Latch the safe failure for that run; reject later Signal sends from it; abort automatic reply delivery and return NonRetryableRunError |
| Tool handles a Signal send failure as a tool error | Return safe structured tool error, retain the run latch; runner ultimately returns NonRetryableRunError even if the provider emits a final result |
| Provider/other execution error after a Signal delivery invocation | NonRetryableRunError; do not rerun earlier sends/tools |
| Queue sees NonRetryableRunError or the delivery marker after failed execution | Direct dead-letter with a safe reason; no backoff retry |
| Queue is about to redispatch a marked incomplete item after crash/recovery | Dead-letter before invoking a provider; crash outcome requires operator inspection |
| Marked run finishes successfully | Complete the queue item normally |
| Provider fails before any Signal invocation | Existing provider/queue retry policy applies |

Every agent reply, channel_send and broadcast passes trusted run context to the
guard. Broadcast stops further Signal recipients for that run after its first
Signal failure; other callers observe the shared account pause as well. Failure
latches and durable markers prevent a handled tool failure, another later
exception, crash recovery or error wrapping from bypassing the boundary. A
failed dead-letter database write is retried as a state write, without invoking
the provider again: QueueProcessor retains the claimed terminal item and retries
only that transition with 250 ms–10 s capped backoff, retaining its concurrency
slot until the write succeeds or stop cancels it. Restart uses the durable marker
before dispatch. No schema change to queue_items is required. This is not
exactly-once execution of arbitrary tools: provider failures before Signal use,
operator-created replays and upstream duplicate commands retain their ordinary
boundaries.

Recovery does not resend the old item. Operators inspect the local run and
recipient chat and, if desired, issue a new explicit command/send. Documentation
must not advertise a built-in dead-letter replay command that does not exist.
Already delivered chunks cannot be recalled. Structured run/queue error fields
carry safe outcome/counts; partial/unknown delivery is never stored as a complete
successful outbound message.

A connector output policy is consulted by AgentRunner. Personal Signal mode
suppresses Thinking messages, tool-call descriptions and text flushes before
tool events; accumulated ordinary agent text is sent once at the end. Explicit
channel_send/broadcast and completed background-task output remain intentional
messages. Personal Signal config rejects showToolCalls=true with a field-path
error. Dedicated Signal keeps the existing stream/progress policy. Add internal
output-purpose/run context metadata to AgentOutput; it is not serialized into
Signal RPC or exposed as model-controlled tool fields. Verify actual CLI/SDK
branches rather than relying on the review's provider example: the current
suppressCliWaitingMessage already excludes several CLI types.

**Account send gate and recovery (F7)**

All Signal sends share one account-keyed gate. Only one send call is active per
account; a competing call returns SEND_BUSY/NOT_SENT immediately instead of
building an outbound buffer. Within the active call, chunks start at most once
per second (burst one). Persist the last-start time before each RPC so restart
cannot grant another burst. Capability/selection checks still precede any send.

Add a small `signal_account_state` table/repository with account UUID key,
last-send-start timestamp, pause kind (`none | in_flight | rate_limit | challenge`),
not-before timestamp and update timestamp. This holds send policy state, not
message content or tokens. Reads/writes return Result. Failure to persist gate
state refuses the send. State belongs to account UUID, so rename/reload cannot
clear it. One Talon owner and externally supervised bridge per account remain
prerequisites; independent external senders are outside this local rate bound.

Additionally persist an `in_flight` pause reservation immediately before each
send RPC. A validated result replaces it with none/rate_limit/challenge. Socket
loss, unknown outcome or a failed result-state write leaves that reservation
intact and enters Needs setup: SEND_STATE_UNCONFIRMED. Startup restores the same
manual pause. Thus a failure to persist a server restriction cannot silently
permit later callers or a restart to continue sending. Operator resume requires
inspection of the prior send; it never resends it. A known NOT_SENT outcome can
clear the reservation if the state write succeeds. Gate-state-write failure
returns a safe terminal error with the known accepted counts; it cannot report
complete successful operation or authorize another chunk.

| Send gate event | Action |
| --- | --- |
| RATE_LIMIT_FAILURE anywhere in results or RPC -5 | Persist account pause before releasing the active call; stop chunks/broadcast Signal recipients; return terminal partial/not-sent error |
| Valid nonnegative safe retryAfterSeconds | Pause until the later of now + 15 minutes and every reported server retry time; never cap a server delay downward |
| Rate limit with absent retry time | Pause for 15 minutes; no resend of the failed call when the pause expires |
| Malformed/overflowing retry time | Persist challenge/manual pause rather than guess a shorter wait |
| RPC -6 or proof/challenge token in any recipient result | Persist manual challenge pause, enter Needs setup; discard token without logging or forwarding |
| Send during rate pause | RATE_LIMIT_PAUSED/NOT_SENT with remaining duration; no RPC |
| Send during challenge pause | CHALLENGE_REQUIRED/NOT_SENT; no RPC |
| Rate pause expires | Permit a new caller after normal verification/rate spacing; old work stays terminal |
| Restart/reload/reconnect | Restore persisted gate; never clear challenge pause automatically |
| Persisted in_flight reservation on restart or uncertain result | Needs setup: SEND_STATE_UNCONFIRMED; no further send until local operator inspection/resume |
| Operator solves challenge externally or inspects an unconfirmed send, then invokes talonctl signal-resume --channel NAME | Privileged local IPC re-verifies identity/device and clears only that manual pause; establish one verified subscription and return to Ready; send/replay nothing |

The resume command requires an explicit operator assertion that the bridge-side
challenge was resolved or the unconfirmed prior send was inspected; it cannot
prove challenge resolution without a send and does not
attempt one. A new challenge immediately reinstates the pause. It cannot clear
an unexpired server rate-limit delay or bypass another Needs setup reason. Failed
verification leaves the pause intact. Audit resume and pauses using safe enums,
counts and channel name. No challenge solving or credential handling is added
to talond. Tests use fake time and prove all tools/schedules share the pause,
broadcast stops, and a process restart preserves it.

**Atomic ingress and replay actor (F16)**

A synchronous Result-returning transaction runner on the shared SQLite connection
wraps duplicate check, transcript insert, routing and enqueue. A private rollback
sentinel converts returned Err into rollback and never escapes the transaction
module. Return committed accepted, duplicate or intentional no-persona drop, or
a typed rolled-back error. Preserve historical duplicates and intentional
no-persona transcript/drop auditing. No ingress schema migration or new spool.

Add optional ChannelConnector.onMessageWithReceipt with a handler returning
`Result<accepted | duplicate | dropped, PipelineError>` (sync or async).
channel-setup installs it when implemented and otherwise retains existing void
onMessage handling. Signal requires a receipt handler before start. The receipt
reports local transaction completion; it does not acknowledge durable acceptance
back to Signal. Existing connectors' callback behavior is preserved.

The Signal connector owns a FIFO of normalized, authorized events (maximum 64
entries and 1 MiB encoded total). It invokes the receipt handler sequentially.
On rollback/error it retains that exact event/key and retries with jittered
250 ms–10 s backoff for at most five minutes from initial handoff. Retries
continue across socket reconnect; authorization/account proof is checked again
before handoff, with no text/key regeneration. While proof is unavailable,
attempts wait within that same deadline. A successful accepted/duplicate/dropped
receipt releases the event. Later events remain FIFO; no parallel callback
attempts or hot retry loop.

Overflow closes the subscription/socket and enters Reconnecting without evicting
already buffered entries. The overflowing event is unaccepted and may be lost;
no upstream replay claim. Permanent policy invalidation excludes buffered events;
deadline expiry emits an aggregate failure and releases the unaccepted event.
stop/replacement cancels retry timers and clears the buffer. A process crash,
stop, expired retry deadline or overflow before acceptance can lose unaccepted
input; these are the spec's explicit pre-acceptance boundary. Already committed
queue work retains durable recovery. A fake-daemon test injects one enqueue
failure and observes connector-driven retry yielding one transcript/turn, without
the test manually replaying the event. Additional tests cover repeated failure,
buffer limits, stop, reconnect, duplicate receipts and intentional drop.

**Diagnostics, persistence and evidence privacy (F11, F12, F14)**

Ignored events never produce per-event log/audit/observability records. Aggregate
counters by configured channel name and fixed reason enum emit at debug level
at most once per minute, with counts only. Lifecycle/trust failures emit one
safe info/warn diagnostic per state transition; repeated causes use the same
aggregate rule. Omit sender/peer/account UUIDs, numbers, group IDs, device names,
message timestamps, subscription IDs, dedup keys, text, attachment metadata and
raw exceptions from ignored/error diagnostic payloads. A configured channel
name is operator-controlled; setup cautions against putting private identifiers
in it. Aggregate emission time remains normal logging metadata.

JSON parse/schema errors expose only a stable error enum, approved schema field
paths and issue codes. Never log raw bytes/lines, parsed frames, excerpts, Zod
received values, arbitrary unknown-field names, remote message strings or nested
raw causes. Paths for unknown input fields are reduced to an allowlisted parent
path. JSONRPC errors and receive exceptions are reduced to local enums before
any shared caller, pino serializer, audit logger or provider receives them.
Signal pipeline error wrapping excludes raw idempotency keys/envelope metadata
from logs while preserving typed rollback behavior. Admitted transcript/provider
retention remains the approved spec's disclosed behavior; ignored events never
enter it.

For committed live evidence and fixtures, replace phone numbers, all ACI/PNI/
peer UUIDs, group IDs/names, device names, usernames and identifying socket/home
paths with consistent valid synthetic values or stable labels. Replace exact
message/device creation/last-seen timestamps with synthetic ordered values or
relative deltas preserving comparisons; remove wall-clock headers and original
capture filenames containing identifiers. Record real bridge version, generic
platform/account mode, scenario/results and relative event order. Use disposable
test message text; replace other bodies without changing trigger/control
classification. Remove QR/link URIs, keys, verification secrets, challenge tokens,
raw stderr and credentials entirely. Keep pseudonym mapping/raw captures outside
the repo; never stage them. Before any evidence commit, inspect git diff/candidate
files for originals and review redaction independently. Mock evidence never
satisfies AC-15.

## Integration surfaces

| Surface | Owned responsibility |
| --- | --- |
| src/channels/connectors/signal/** | RPC/config types, trust, mapping, lifecycle, devices, receipt buffer, sending and safe diagnostics |
| src/core/config/config-schema.ts | Signal schema/canonicalization and personal showToolCalls constraint |
| src/daemon/channel-factory.ts, src/channels/channel-setup.ts, src/channels/channel-types.ts | Construction, generation registry, optional receipts, output policy and trusted delivery metadata |
| src/core/errors/error-types.ts, src/core/errors/index.ts | Typed Signal delivery and non-retryable run errors, preserved across wrappers |
| src/daemon/agent-runner.ts, src/daemon/daemon-context.ts, src/daemon/daemon-bootstrap.ts | Delivery guard, final-only personal output, receipt/gate/transaction injection and run error propagation |
| src/queue/queue-processor.ts, src/queue/dead-letter.ts, src/core/database/repositories/queue-repository.ts | Direct terminal handling, durable payload marker and safe crash redispatch/state-write behavior |
| src/core/database/transaction.ts, src/pipeline/message-pipeline.ts | Result rollback and atomic acceptance; Signal-safe failure logging |
| `src/core/database/migrations/<next>-signal-account-state.sql`, src/core/database/repositories/signal-account-state-repository.ts | Persistent account send gate, wired into shared repository construction |
| src/tools/host-tools/channel-send.ts, src/tools/host-tools/channel-broadcast.ts | Trusted run context, delivery outcome DTOs, failure latch and broadcast stop |
| src/cli/config-utils.ts, src/cli/commands/add-channel.ts, src/cli/commands/signal-resume.ts, src/ipc/** | Signal admission/guidance and privileged pause-resume without sending |
| tests/unit/channels/connectors/signal/** | Contract/alias parsing, trust, policy/provenance, send/target/rate tables, framing and lifecycle |
| tests/unit/core/database/transaction.test.ts, tests/unit/pipeline/message-pipeline.test.ts | Real Err rollback and intentional-drop/duplicate regressions |
| tests/unit/core/database/repositories/signal-account-state-repository.test.ts, tests/unit/core/database/repositories/queue-repository.test.ts | Gate persistence and reserved delivery marker |
| tests/unit/core/config/config-schema.test.ts, tests/unit/daemon/channel-factory.test.ts, tests/unit/channels/channel-setup.test.ts | Validation, named accounts/duplicate rejection, proof injection and receipts |
| tests/unit/core/errors/error-types.test.ts, tests/unit/daemon/agent-runner.test.ts, tests/unit/queue/queue-processor.test.ts, tests/unit/queue/dead-letter.test.ts, tests/unit/daemon/reload.test.ts | Error identity, real stream/final/tool failure, no provider/tool rerun, personal output and stop/reload |
| tests/unit/cli/add-channel.test.ts, tests/unit/cli/config-utils.test.ts, tests/unit/cli/signal-resume.test.ts, tests/unit/tools/host-tools/channel-send.test.ts, tests/unit/tools/host-tools/channel-broadcast.test.ts, tests/unit/tools/host-tools/channel-list.test.ts | CLI/resume, capability/bindings, stale destinations and scheduled/broadcast recipient/context regressions |
| tests/unit/ipc/signal-resume.test.ts | Privileged local recovery, verification refusal, preserved rate pause and no replay |
| .agents/skills/run-talon-smoke/**, tests/smoke/signal-channel-smoke.mjs | Packaged daemon/fake bridge, actual rollback retry, crash marker, startup/reconnect and cleanup |
| README.md, AGENTS.md, CLAUDE.md, config/talond.example.yaml, docs/setup-guide.md | Channel/config/architecture, personal output, socket/version/device constraints, rate/replay/retention boundaries |
| .agents/skills/add-signal/**, .agents/skills/talon-setup/**, .agents/skills/talon-setup-docker/** | Codex walkthroughs, both modes, freshness and challenge recovery |
| .claude/skills/add-signal/**, .claude/skills/talon-setup/**, .claude/skills/talon-setup-docker/** | Matching distributed operator walkthroughs |
| starter/.claude/skills/**, starter-stack/.claude/skills/**, tests/unit/deploy/starter-bundle.test.ts | Add-signal allowlists and synchronized starter documentation |

Reuse existing thread/message/queue status schemas, channel registry, capability
labels, recipient resolution, scheduled context isolation, stripMarkdown and
starter sync script. The optional receipt/output metadata and terminal error
classification are explicit narrow shared-contract changes. The only new table
is Signal account send policy state. No new npm dependency or generic channel
transport redesign. Repository anchors are recorded in the review-response
evidence and shared Signal knowledge.

Documentation coverage includes both AGENTS.md and CLAUDE.md (F17).

## Epic deliverable

The built daemon admits authorized text from personal Note to Self, selected
DMs and groups in both modes. The fake provider answers through the fake Unix
bridge. Own replies/excluded events cause no extra run. Partial/ambiguous sends
and handled tool errors cannot retry a provider turn; personal progress text is
absent; startup recovers without reload; stale device setup is refused; account
send pauses survive restart; connector-driven rollback retry yields one turn.
The harness uses disposable state and stops every child/socket on success/failure.

Verification coverage (F18) uses this deliverable command, implemented by the epic:

```sh
npm run build && bash .agents/skills/run-talon-smoke/scripts/verify-signal-deliverable.sh --no-build
```

The verification script runs node dist/cli/index.js --help, the existing fake
terminal startup smoke and the Signal fake smoke. Its focused Vitest invocation
includes every test path in the Integration surfaces table: Signal connectors;
transaction/pipeline; Signal account-state and queue repositories; config,
factory, setup; errors, agent-runner, queue processor/dead-letter/reload; CLI
add-channel/config-utils/signal-resume; channel-send/list/broadcast; and starter
bundle, plus local resume IPC. Missing test files fail the script. Tests specifically cover AC-1 named
instances/duplicate ownership and AC-12 scheduled target resolution, capabilities,
recipient-thread persistence and broadcast skipping default bindings. The script
prints each stage and an AC-to-test/evidence map; it does not invoke the full slow
suite. Build and ratified checks remain required.

AC-15 additionally requires redacted real-device evidence for both account
modes, both personal entry points, DM/group activation, send/chunk behavior,
source-device/echo filtering, relink/restart and offline/reconnect limits. Include
the freshness-rule and self-target metadata observations above. No live access
or success is claimed. Missing live accounts/evidence blocks completion; the
fake harness cannot waive that criterion. Design sign-off and any further
independent review remain pending.
