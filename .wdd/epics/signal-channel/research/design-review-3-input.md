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
- **Delivery guard, saved replies and account gate** — durable delivery-only
  checkpoints for completed replies/background notifications; bounded FIFO send
  waits; terminal handling of partial/ambiguous sends; persistent account pauses.
  Provider execution is never replayed to recover a completed Signal reply.
- **Inbound acceptance boundary** — Result-returning SQLite transaction plus a
  bounded connector-owned retry buffer. Transcript/dedup/routing/enqueue commit
  together; rollback has an explicit retry actor.
- **Operator setup and proof harness** — both account modes, device metadata,
  native/mounted-socket guidance, capabilities/bindings, deterministic packaged
  smoke, targeted regression checks and redacted live-device evidence.

## Interfaces

**Contract baseline and version policy (F2, F4, F15)**

Consume `shared-context/contract-inventory.md`,
`research/contract-constraints.md` and the pinned v0.14.9 reference. Review
clarifications below refine those constraints; the original research snapshot
and approved spec remain immutable. Supporting reads are recorded in
`research/design-review-1-response-evidence.md` and
`research/design-review-2-response-evidence.md`. Fixtures distinguish source
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

**Account and device verification (F2, F5; R2-F6, R2-F7)**

Resolve accountUuid to exactly one listAccounts `{number, aci}` record and
validate the configured bootstrap selector. The ACI remains authoritative. A
selector resolving to a different ACI is ACCOUNT_MISMATCH; an obsolete phone
selector with no match is a stale hint if the pinned ACI still exists. All
account-specific runtime RPCs use the verified ACI, so a number change cannot
break sends or subscriptions through an old phone selector. Aliases never
become peer/account authorization keys.

Receive `params.result.account` must match that verified record's number or
normalized ACI. Numbered accounts normally emit the number even when selected
by ACI; numberless accounts emit ACI. The following alias policy covers R2-F7:

| Alias event | Action |
| --- | --- |
| Start/reconnect or regular 60-second refresh | Read local listAccounts and update the pair by pinned ACI; no listDevices call solely for alias refresh |
| Unknown alias on this connection's verified subscription | Coalesce one immediate listAccounts refresh, at most once per five seconds; hold validated ordinary notifications within the quarantine below |
| Refresh confirms the same ACI with a changed number | Replace aliases, retry held notifications through the mapper exactly once; keep socket/subscription/device proof |
| Unknown alias still does not belong to the pinned ACI | Ignore that notification; never infer ownership from envelope sender |
| Alias refresh RPC timeout/IO error with healthy socket | Retain previous aliases and subscription; retry within the bounded local refresh schedule |
| Successful refresh proves missing/ambiguous ACI | Needs setup: ACCOUNT_MISMATCH |

Unknown-alias quarantine holds at most 64 notifications and 1 MiB total for at
most 30 seconds. Overflow discards the newest unverified notification; deadline
expiry discards that notification, with aggregate diagnostics only. Exceptions,
control/media-only and ephemeral events are excluded before quarantine. No
quarantine data reaches transcripts/audits/providers. Periodic refresh is the
fallback if notifications cannot be retained. An alias refresh timeout never
admits an unverified alias. Tests change a numbered account's number on a healthy
socket with an old phone selector and show subsequent commands/sends working
without reconnect; they also prove that another account's alias is not learned.

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

Construct a generation registry before any receive subscription:
all configured Signal account UUIDs and modes, their generated-device IDs and
verification status. Reject duplicate resolved receive ownership. A verified
personal account additionally publishes its frozen human-device roster (the
verified device list minus the bridge). Own personal commands and personal
account senders in another local instance require a device in that roster;
missing/unknown devices are ignored and request re-verification. Messages from
a configured dedicated account are excluded across local instances regardless
of source device. A configured personal account without verified provenance is
excluded across instances, including during initial start and reconnect.
Personal account UUIDs are not generic sibling bot IDs. Publish immutable proof
snapshots atomically when verification renews or invalidates them; all instances
use the same owner and refresh budget for each configured local account.

Device verification is a server request, not local metadata (R2-F6).
Its scheduler permits at most one in-flight listDevices and one attempt per
account per 60 seconds, including startup/reconnect/unknown-device refreshes.
Persist the last-check-start timestamp before the call so reload/restart cannot
reset that budget. No server check starts if its state write fails.
A send never calls listDevices itself. A new connection requires a successful
check before Ready and waits for that scheduler's next slot if necessary.
An established connection uses its last successful device proof for at most
five minutes, with normal 60-second refresh. No persisted proof is reused
across daemon restart. Known server rate/challenge pauses also delay these
server checks; account alias refresh is a separate local RPC budget.

| Established-connection device refresh | Proof/subscription behavior |
| --- | --- |
| Valid unchanged roster | Renew proof age; continue Ready |
| Verified roster change | Invalidate published proof and apply full freshness validation; publish only a valid replacement |
| Valid response proves configured device absent or fails freshness | Needs setup: DEVICE_METADATA_INVALID |
| IO_ERROR (-3), timeout or transient server refusal | Keep socket/subscription and last good proof until its five-minute expiry; retry within scheduler budget |
| Proof expires while refresh remains unavailable | Keep receive subscription; suspend sends and local-personal-account/device-dependent admission until renewed; report VERIFICATION_STALE |
| New/unknown source device | Exclude that event; request a coalesced scheduled refresh; no extra server call and no exception-based channel halt |

Other independently verifiable selected inbound senders remain eligible while
personal-device proof is stale; local personal accounts never gain authorization
from stale/new devices. Deferred replies wait for proof renewal. Unknown source
devices are excluded even while a cached proof is fresh. A replay whose data
timestamp predates the applicable device's creation is excluded. Tests retain
receiving through a transient refresh failure, count server calls under bursts,
and prove proof-expiry suspension/recovery plus the stale-3/new-4 rule. Live
fixtures remain required for source-device attribution and both personal entry
points; no source-only fixture is presented as that proof.

**Lifecycle and RPC recovery (F3, F4, F10; R2-F2, R2-F3, R2-F6)**

start() owns one connection/reconnect loop and resolves after the first bounded
attempt, whether Ready, Reconnecting or Needs setup. Transient first-connect
failure enters the loop rather than relying on the daemon to call start again.
Repeated start while active is a no-op. Socket reconnect uses capped exponential
backoff/jitter and trust/version/account/device verification before one manual
receive subscription. Metadata IO errors on a healthy established connection
use their own refresh scheduler; they do not tear down that connection.

| State/event | Target state and action |
| --- | --- |
| Stopped / start, valid verification | Ready; publish proof and one subscription |
| Start or Ready / absent socket under trusted parent, refused connection or socket disconnect | Reconnecting; clear subscription/proof and schedule reconnect |
| Reconnecting / successful verification and subscription | Ready |
| Initial/reconnect verification / timeout or IO_ERROR (-3) | Remain Reconnecting; retry within transport and metadata budgets; no send while unverified |
| Initial/reconnect verification / other application error without verified account/device/protocol failure | Remain Reconnecting: VERIFICATION_PENDING; retry within budgets; never infer unlink from text |
| Established connection / metadata timeout or transient IO error | Keep Ready/socket/subscription; apply proof/alias age policy above |
| Any verification / successful response proves missing/ambiguous ACI or selector resolves to another ACI | Needs setup: ACCOUNT_MISMATCH |
| Any verification / confirmed device absence or failed freshness | Needs setup: DEVICE_METADATA_INVALID |
| Any verification / unknown/unsupported version or required method unavailable | Needs setup: UNSUPPORTED_VERSION or UNSUPPORTED_BRIDGE_MODE |
| Any active state / unsafe or replaced socket path | Needs setup: UNTRUSTED_SOCKET |
| Metadata/gate state write fails | Suspend affected verification/sends and retry state write only; keep healthy subscription; initial unverified start stays Reconnecting |
| Receive / nonnull exception, with or without an envelope | Exclude that notification only; aggregate RECEIVE_EXCEPTION count; remain Ready with existing proof/subscription |
| Receive / valid ordinary envelope and verified account/subscription | Mapper/activation table |
| Receive / invalid/unverifiable event payload, missing provenance, no envelope or control event | Exclude that event only; no lifecycle transition |
| Needs setup / operator repairs and restarts/reloads | New verification; persisted send restrictions still apply |
| Stop or reload replacement | Quiesce, bounded drain below, then Stopped; no old-instance reconnect/timer |
| Stopped/Reconnecting/stale proof / send | Bounded wait or typed delivery-only deferral if no bytes submitted; no provider rerun |
| Needs setup / send | Typed permanent NOT_SENT setup error; no send RPC |

A receive exception is not evidence that the account is unusable. Never classify
account state from remote exception text or from a per-message exception type.
UntrustedIdentityException, decryption/session faults, exception-only records and
unknown exception types all exclude only the notification. They cannot trigger
metadata refresh amplification or PROTOCOL_FAILURE_LOOP. Confirmed account/device
absence comes from account-level verification. Unknown application errors during
metadata refresh preserve/suspend proof under its age policy, without inventing
an unlink classifier. Tests submit repeated faults from unselected chats and
strangers while Note to Self and another selected group continue receiving.

RPC frames are limited to 1 MiB before newline, pre-subscription-response buffers
to 1 MiB total and correlated pending requests to 64. Connection/subscription
must match before policy evaluation. Frame schema validation concerns JSONRPC
framing/correlation; malformed receive-envelope fields are event exclusions,
not connection protocol violations. Stale frames cannot resolve another request.

| RPC fault | Recovery and send outcome |
| --- | --- |
| Oversized line, invalid JSON or invalid outer JSONRPC framing/correlation schema | Close socket and discard parser buffer; Reconnecting; no partial-line resynchronization |
| Pre-response subscription buffer overflow | Close socket, discard unaccepted buffer; Reconnecting |
| Third genuine framing/outer-protocol failure within five minutes | Needs setup: PROTOCOL_FAILURE_LOOP; per-message exceptions/validation do not increment it |
| Request 65 when 64 are pending | Refuse before writing with transient NOT_SENT; caller waits/defers delivery, not the provider |
| Timeout/disconnect/cancellation before any send bytes are handed to socket | Current chunk NOT_SENT; delivery-only recovery if transient |
| Timeout/disconnect after any send bytes are handed to socket | Current chunk UNKNOWN; terminal for that delivery |
| Stale subscription/generation/response ID or unrelated account | Ignore/count; never admit or resolve another request |

Closing settles pending requests exactly once. Unwritten sends remain safe to
defer; potentially written sends never resend automatically. Unaccepted receive
buffers remain outside durable acceptance; upstream replay is not claimed.

On stop/reload, stop new account dispatch and wake unwritten send waiters with a
deferral. Drain the single active send RPC for its remaining request deadline,
capped at 30 seconds, and persist its result/cursor before closing. At the drain
limit, mark that delivery UNKNOWN; retain definite-unwritten queued replies.
The daemon suspends new queue claims while replacing the registry, then resumes
them. Active providers may finish and save their reply during this interval;
delivery resolves the current registry instance each attempt rather than a
connector cached before the provider query. Old instances cannot dispatch again.
Reload with a responding active RPC must let the new connector reach Ready
through automatic verification, without manual resume. The shared verification
budget can delay a new connection by at most 60 seconds before its next request
deadline; saved replies remain queued. Forced timeout/crash follows the account
fence below, not a
mandatory signal-resume. Test both drain success and forced cancellation.

**Target preflight, text and send outcomes (F9; R2-F1, R2-F6)**

Connector.send returns `Result<void, ChannelError>`; Signal failures use a typed
SignalDeliveryError carrying an enumerated reason, `NOT_SENT | PARTIAL | UNKNOWN`
outcome, accepted-chunk count, current-chunk acceptance classification
(`unwritten | refused | complete | partial | unknown`) and success/failure counts.
No raw remote cause,
recipient identifiers, bridge timestamps or challenge values are retained in
that error. Add `retryScope: delivery_only | none` and a safe next-attempt hint.
The provider turn is never rerun to retry delivery. Definite-unwritten transient
failures may retry only a saved current chunk; partial/unknown acceptance is
terminal for that delivery. A failure of another Signal tool operation does not
cancel the origin channel's explanatory reply.

The Signal-only prepared-delivery interface separates formatting from sending:
`prepare(destination, output)` returns validated fixed plain-text chunks;
`sendPreparedChunk(destination, chunk, trustedContext)` returns a typed chunk
receipt through the common account gate and preflight. The latter neither
reformats nor splits the saved text. Generic send prepares once and uses the
same chunk method. The queue delivery actor never resubmits the whole original
body after advancing its cursor. These are internal Signal interfaces; other
connectors keep their send contract.

Reject attachments, malformed/stale-account IDs and unselected destinations
before any send. For each chunk, fetch fresh target state; there is no timer-
state cache across chunks. `listContacts` uses recipient UUID plus
allRecipients=true. Configuring a UUID alone does not establish safe target state.

| Target | Required evidence immediately before each chunk |
| --- | --- |
| Selected DM | Exactly one matching normalized contact; isBlocked=false, unregistered=false, messageExpirationTime=0 |
| Personal Note to Self | Verified own account plus exactly one matching self contact with the same flags/timer; send via noteToSelf |
| Selected group | Exactly one matching group; isMember=true, isBlocked=false, isTerminated=false, messageExpirationTime=0; required member/provenance fields parse |
| Missing/empty/ambiguous record or missing required fields | Permanent TARGET_UNVERIFIABLE; no permissive defaults |
| Transient target lookup timeout/IO error on a healthy socket | Current chunk NOT_SENT, delivery-only deferral; keep subscription |
| Known target lookup rate limit | Apply account rate pause; current chunk is unwritten and can defer |
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
never replay an accepted/partly accepted/unknown chunk. A transient refusal
before writing the current chunk can resume only that saved chunk and its unsent
tail. Bridge acceptance does not prove recipient delivery/read. Tool results
report outcome/counts and `providerRetryable: false`; transient NOT_SENT says
that the explicit tool send was not queued and a later explicit call is possible.
PARTIAL/UNKNOWN instruct inspection and forbid repeating that operation.

An empty result set, malformed/missing response or any NETWORK_FAILURE gives
UNKNOWN, with known success counts retained. An entirely valid nonempty set of
explicit non-network failures is NOT_SENT if no earlier success exists; known
success mixed with such failures is PARTIAL. A non-success RPC envelope remains
an error even when its nested response reports successes. Only an ordinary
success envelope and complete successful recipient results yield Ok.

**Saved replies and retry boundary (F1, F6; R2-F1, R2-F4, R2-F5)**

Separate provider execution from delivery using a reserved, versioned Signal
reply checkpoint in queue_items.payload. This applies to the final ordinary
reply and the background-task-notification branch before its early return.
The checkpoint is persisted before any send and contains trusted queue item ID,
stable delivery ID, optional real run ID, kind (`reply | background`), persona/
thread IDs, channel name and pinned account UUID, destination, original body,
fixed UTF-8 chunks, next-chunk cursor, current-chunk state, known counts and
created/expires timestamps. Original body and formatted chunk text are each
limited to 1 MiB of UTF-8, and the serialized checkpoint to 3 MiB. Oversize fails
explicitly before a send, never truncates. Lifetime is 24 hours
from preparation, not renewed by retries. No keys/config secrets are saved.
Saved outgoing text/cursors use ordinary Talon queue retention, including terminal
items, until operator purge; setup/README document that additional stored copy.
Initial checkpoint-write errors retain the generated text in the active handler
and retry only the state write; they never start a second provider turn. Crash
before that first commit retains the existing pre-checkpoint execution boundary;
no chunk of that saved reply may be sent before its checkpoint is durable.
Earlier explicit/progress sends use their own invocation guard/reservation.
Checkpoint/guard writes merge the latest row inside the shared Result transaction
and require the expected current state/cursor; a stale payload snapshot or late
callback cannot erase another marker or overwrite a terminal decision.

On queue dispatch, a valid checkpoint takes precedence over provider execution
and the generic no-rerun marker. AgentRunner invokes delivery/finalization only:
no provider query, tool execution, notification reconstruction or fresh session.
Use the current connector registry and recheck account/selection plus applicable
existing binding/capability rules. Invalid checkpoint or account replacement
fails closed; it never falls back to re-running the provider.

| Checkpoint/event | Durable transition and queue behavior |
| --- | --- |
| Provider finished / background notification parsed | Persist ready checkpoint with exact text; background identity uses queue item ID and task/status, with run ID absent |
| Account busy/reconnecting, stale verification, RPC pool full or retryable preflight refusal | Keep current chunk ready; bounded FIFO wait, then DeliveryDeferredError if still unavailable |
| Before current chunk may be written | Commit in_flight marker and account reservation in one Result transaction; no RPC if it rolls back |
| Valid complete acceptance of current chunk | Atomically advance cursor and clear in_flight; only the next unsent chunk can proceed |
| Current chunk explicitly not sent due transient resource/rate refusal, with zero recipient successes in that chunk | Clear in_flight to ready; defer that chunk only; earlier accepted chunks stay skipped |
| Current chunk partly accepted, NETWORK_FAILURE, missing/invalid outcome or socket loss after possible write | Mark terminal PARTIAL/UNKNOWN; NonRetryableRunError/dead-letter; no automatic resend or continuation |
| Permanent target/setup refusal or 24-hour expiry while not delivered | Mark terminal and dead-letter with safe visible reason/counts; retain saved body for operator inspection |
| All chunks accepted | Mark delivered; idempotently persist full outbound history under original run/task identity, finalize original run and complete queue item |
| Restart sees ready checkpoint | Resume delivery only; no provider/tool replay |
| Restart sees in_flight checkpoint | Terminal UNKNOWN for that delivery; account recovery is separate below |
| Restart sees delivered checkpoint / finalization failed | Finish local history/status writes only; no RPC or provider query |

DeliveryDeferredError preserves typed identity through runner/queue wrappers.
QueueProcessor writes a deferred retry with bounded 1–60 second backoff or the
account's later not-before hint, never later than checkpoint expiry. This path
has its own deadline and does not consume provider maxAttempts (default 3).
It releases the concurrency slot; QueueRepository needs a defer operation that
does not call its existing attempt-incrementing fail method. An older deferred
Signal reply blocks later ordinary work on that thread until delivery or terminal
failure; existing collaboration bypass rules remain explicit. Other threads
and connectors continue. Saved body/cursor survives reset-to-pending crash
recovery. Run status stays running while reply delivery is pending and completes
or fails with delivery; provider usage/session/result observation is recorded
once and never fabricated on delivery retries. Background delivery creates no
provider run/session. History precedes context rotation/next ordinary thread
turn; idempotent finalization cannot resend output. Rotation remains best-effort.

Transient retry never repeats a partially accepted RPC. A reply-level PARTIAL
count caused by earlier whole accepted chunks does not itself forbid resuming a
proven-unwritten current chunk; current-chunk acceptance and cursor decide.
In particular, known
successes in the current group chunk forbid retrying that chunk as a group send.
A queued retry is allowed only when the current chunk is proven unwritten or
explicitly wholly refused without network uncertainty. Tests assert provider
and tool call counts of one across busy wait, short bridge restart, rate pause,
RPC-capacity pressure, background retry and crash, and assert cursor/recipient
behavior for partial/unknown outcomes.

**Invocation guard and origin replies (R2-F4, R2-F5)**

Trusted delivery context is keyed by queueItemId and deliveryId, with runId
optional. Register it at AgentRunner.run entry before the background branch;
real provider runs add their run ID later. Host tools obtain it from authenticated
host context, never model arguments. Persist signalDeliveryStarted before every
Signal invocation to prevent replay of provider/tool execution after a crash
without a finished reply checkpoint. Preserve NonRetryableRunError and
DeliveryDeferredError through AgentQueryAttemptError and the queue catch.

| Execution/operation event | Required behavior |
| --- | --- |
| Explicit Signal tool send fails | Return structured error; provider can finish and explain on its origin channel |
| Tool operation has PARTIAL/UNKNOWN acceptance | Latch that operation and reject further explicit sends to that failed account/target in this queue execution; no same-operation resend with a new request ID |
| Final explanatory reply | Allowed on a healthy origin channel/Signal target; account restrictions still apply; a latched PARTIAL/UNKNOWN target cannot receive the original content again by changing purpose/ID |
| Failure to Signal account X | Never blanket-suppress Telegram/other-channel or account Y replies/sends |
| Provider execution fails/crashes after any Signal invocation without a completed checkpoint | Terminal for provider replay; no rerunning earlier tools |
| Provider completes after a handled tool error | Deliver origin reply normally; handled error alone does not force NonRetryableRunError |
| Final/background delivery is ambiguous/partial/permanently refused | Terminal for that saved delivery, with local operator-visible status |

An explicit channel_send/broadcast waits within the send gate's 30-second bound.
If the origin Signal target is itself latched for PARTIAL/UNKNOWN explicit
delivery, do not forward provider final content to that target; record the local
terminal reason. This is a target guard, not a message-text comparison. Other
origin channels/targets retain their explanation path.
A transient NOT_SENT from the tool call remains an error, not queued/successful
network delivery; the provider can explain or make a later deliberate tool
call. It must not replay unrelated tools. Scheduled final text remains skipped;
schedule tools retain their error/success and recipient-context semantics.
Broadcast stops the affected account on rate/challenge/transport restrictions,
but does not cancel unrelated accounts or origin replies. Per-target failures
are reported separately. A retry of the whole queued provider turn is forbidden
after Signal use; saved final/background delivery is the narrow safe exception.

All ordinary Signal assistant text is buffered to the final reply checkpoint,
in both modes, so pre-tool text flushing cannot create an unstored intermediate
reply. Personal mode additionally suppresses Thinking/tool notices and rejects
showToolCalls=true. Dedicated mode may retain best-effort progress/tool notices;
those use purpose-specific guarded delivery and never trigger provider reruns.
A failed notice is not replayed as part of the final reply. Explicit sends and
completed background output remain intentional. AgentOutput carries trusted
purpose/queue/delivery metadata internally, never in Signal RPC or model fields.

Local queue/status output exposes saved-delivery pending/terminal counts and
safe reasons; delayed delivery is not reported as success. Permanent failure or
expiry emits one safe operator warning/audit with internal delivery ID and
counts, without Signal identifiers/body. Failed database transitions are retried
only as state writes with capped backoff; no provider/RPC can run through an
uncertain checkpoint. Operators inspect partial/unknown deliveries and issue a
new explicit command if desired; no built-in dead-letter replay is invented.

**Account send gate and recovery (F7; R2-F1, R2-F3)**

Only one chunk send RPC is active per account; competing chunks wait FIFO, never
fail immediately merely because another reply is active. At most 64 waiters/1 MiB
of waiting text are retained in memory, each for at most 30 seconds. Capacity or
wait expiry produces transient NOT_SENT. Saved final/background replies remain
in the durable queue and defer delivery only; explicit tools receive the error.
Long replies rejoin the FIFO for each chunk so another target can make progress.
Chunks begin at most once per second (burst one). Persist last-start before each
RPC; restart does not create another burst. Revalidate target/proof before each
chunk without adding a listDevices call. Canceling an unwritten waiter removes
only that waiter; it cannot cancel the active account send.

signal_account_state retains account UUID key, last-send-start, last-device-check
start, reservation
identity/start time, pause kind (`none | rate_limit | challenge | recovery`),
not-before and update timestamp. The reservation describes one potentially
written delivery; it is not itself an account setup failure. Commit it before
writing, clear/replace it after classified result. Result errors refuse network
work. Account keys survive rename/reload. Same-account external senders remain
outside this local gate. Known server pauses are persisted before the active
call is released; persistence failure holds the gate and retries state writes.
Reservation identity includes trusted queueItemId, deliveryId and purpose.
Recovery updates a saved final/background checkpoint if present; an explicit/
progress reservation produces a terminal operation audit and never rewrites an
already completed queue item or a delivered origin reply.

| Gate event | Account action / failed delivery action |
| --- | --- |
| RATE_LIMIT_FAILURE in any results or RPC -5 | Persist account rate pause and stop remaining chunks/affected broadcast account |
| Valid nonnegative safe retryAfterSeconds | Not-before is the later of now + 15 minutes and every reported server delay; no downward cap |
| Rate failure with absent retry delay | Pause 15 minutes |
| Malformed/overflowing delay, RPC -6 or proof/challenge token | Persist manual challenge pause; discard tokens; receiving stays active if otherwise verified |
| Send during rate/recovery pause | Wait within call bound, then NOT_SENT with next-attempt hint; final/background checkpoint defers |
| Send during challenge pause | NOT_SENT with manual-recovery reason; no send RPC; saved final/background work remains bounded by expiry |
| UNKNOWN or interrupted reservation | That delivery is terminal; apply an automatic 60-second recovery fence from detection, preserving any longer committed server rate delay or challenge pause |
| Restart/reload with unresolved reservation | Mark only that delivery UNKNOWN and apply recovery fence; reconnect/verify automatically; no mandatory signal-resume for mere uncertainty |
| Recovery/rate fence expires | Permit a distinct new delivery, or a saved proven-unsent checkpoint; never resend the unknown delivery |
| Operator resolves challenge externally then talonctl signal-resume --channel NAME | Verify account/device and clear challenge pause only; send/replay nothing in the command |

The automatic recovery fence can expire without operator input; receipt of a
later real rate/challenge outcome establishes the corresponding account pause.
An unseen server restriction cannot be inferred from UNKNOWN; no claim is made
that a lost response proves absence of one. Distinct sends still obey spacing
and immediately honor any restriction observed. Known committed rate/challenge
pauses survive restart and cannot be cleared by a generic reload/resume.
The resume command requires an explicit assertion of external challenge
resolution, cannot bypass another Needs setup reason or unexpired rate delay,
and sends nothing to test resolution. Failed verification leaves the pause.
New challenge reinstates it. Audit safe enums/counts/channel only.

Test two default-concurrency group runs with multi-chunk replies, 30-second
wait exhaustion/durable deferral, bridge downtime, default maxAttempts=3,
rate/CAPTCHA persistence and paused-account isolation. Reload tests cover an
active success drained before stop and a forced UNKNOWN followed by automatic
account recovery and a distinct successful message, with zero replay of the
interrupted delivery. Fake-time crash tests cover reservation/cursor boundaries.

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
| src/daemon/agent-runner.ts, src/daemon/signal-reply-delivery.ts, src/daemon/daemon-context.ts, src/daemon/daemon-bootstrap.ts | Trusted queue/delivery identity including background notifications, saved reply preparation/finalization, final text buffering and guard/receipt/gate injection |
| src/daemon/daemon.ts, src/daemon/lifecycle.ts, src/queue/queue-manager.ts | Quiesced reload/claim resumption, bounded send drain and checkpoint-aware crash recovery |
| src/queue/queue-processor.ts, src/queue/dead-letter.ts, src/core/database/repositories/queue-repository.ts | Delivery-only deferral without provider attempts, reserved checkpoints/cursors, per-thread ordering and terminal handling |
| src/core/database/transaction.ts, src/pipeline/message-pipeline.ts | Result rollback and atomic acceptance; Signal-safe failure logging |
| `src/core/database/migrations/<next>-signal-account-state.sql`, src/core/database/repositories/signal-account-state-repository.ts | Persistent account send gate, wired into shared repository construction |
| src/tools/host-tools/channel-send.ts, src/tools/host-tools/channel-broadcast.ts | Trusted execution/delivery context, outcome DTOs, operation-scoped latch, account-scoped broadcast stop and origin reply preservation |
| src/cli/config-utils.ts, src/cli/commands/add-channel.ts, src/cli/commands/signal-resume.ts, src/cli/commands/status.ts, src/ipc/** | Signal admission, pending/terminal delivery status and privileged challenge recovery without sending |
| tests/unit/channels/connectors/signal/** | Contract/alias parsing, trust, policy/provenance, send/target/rate tables, framing and lifecycle |
| tests/unit/core/database/transaction.test.ts, tests/unit/pipeline/message-pipeline.test.ts | Real Err rollback and intentional-drop/duplicate regressions |
| tests/unit/core/database/repositories/signal-account-state-repository.test.ts, tests/unit/core/database/repositories/queue-repository.test.ts | Gate/check-budget persistence, atomic checkpoint/reservation, deferred cursor and head ordering |
| tests/unit/core/config/config-schema.test.ts, tests/unit/daemon/channel-factory.test.ts, tests/unit/channels/channel-setup.test.ts | Validation, named accounts/duplicate rejection, proof injection and receipts |
| tests/unit/core/errors/error-types.test.ts, tests/unit/daemon/agent-runner.test.ts, tests/unit/daemon/signal-reply-delivery.test.ts, tests/unit/queue/queue-processor.test.ts, tests/unit/queue/dead-letter.test.ts, tests/unit/daemon/reload.test.ts, tests/unit/daemon/lifecycle.test.ts | Error identity, concurrent/deferred delivery, background guard, healthy-origin explanations, crash cursors, maxAttempts isolation and active-send reload |
| tests/unit/cli/add-channel.test.ts, tests/unit/cli/config-utils.test.ts, tests/unit/cli/signal-resume.test.ts, tests/unit/tools/host-tools/channel-send.test.ts, tests/unit/tools/host-tools/channel-broadcast.test.ts, tests/unit/tools/host-tools/channel-list.test.ts | CLI/resume, capability/bindings, stale destinations and scheduled/broadcast recipient/context regressions |
| tests/unit/ipc/signal-resume.test.ts | Privileged local recovery, verification refusal, preserved rate pause and no replay |
| tests/unit/cli/status.test.ts, tests/unit/subagents/background/background-agent-manager.test.ts | Pending/terminal counts and background producer/notification identity |
| .agents/skills/run-talon-smoke/**, tests/smoke/signal-channel-smoke.mjs | Packaged daemon/fake bridge, actual rollback retry, crash marker, startup/reconnect and cleanup |
| README.md, AGENTS.md, CLAUDE.md, config/talond.example.yaml, docs/setup-guide.md | Channel/config/architecture, personal output, socket/version/device constraints, rate/replay/retention boundaries |
| .agents/skills/add-signal/**, .agents/skills/talon-setup/**, .agents/skills/talon-setup-docker/** | Codex walkthroughs, both modes, freshness and challenge recovery |
| .claude/skills/add-signal/**, .claude/skills/talon-setup/**, .claude/skills/talon-setup-docker/** | Matching distributed operator walkthroughs |
| starter/.claude/skills/**, starter-stack/.claude/skills/**, tests/unit/deploy/starter-bundle.test.ts | Add-signal allowlists and synchronized starter documentation |

Reuse existing thread/message/queue status schemas, channel registry, capability
labels, recipient resolution, scheduled context isolation, stripMarkdown and
starter sync script. The optional receipt/output metadata, delivery-phase queue
checkpoint and typed retry-scope classification are explicit shared-contract
changes. The only new table
is Signal account send policy state. No new npm dependency or generic channel
transport redesign. Repository anchors are recorded in the review-response
evidence and shared Signal knowledge.

Documentation coverage includes both AGENTS.md and CLAUDE.md (F17).

## Epic deliverable

The built daemon admits authorized text from personal Note to Self, selected
DMs and groups in both modes. The fake provider answers through the fake Unix
bridge. Own replies/excluded events cause no extra run. Two concurrent group
replies both arrive once, including after a short bridge restart, with one
provider/tool execution each. Deferred chunks resume from saved cursors, never
from the provider. Partial/ambiguous sends are terminal for that delivery;
background notifications receive the same protection without a fabricated run ID.
Per-message receive faults leave other chats working. A failed Signal tool send
can produce an explanatory Telegram/healthy-Signal reply. Device refresh failure
does not close a healthy subscription, and number changes refresh aliases without
reconnect. Personal progress text is absent; startup recovers without reload;
stale device setup is refused; account pauses survive restart; active-send reload
drains or automatically recovers without resending an uncertain chunk. Ingress
rollback retry yields one accepted turn.
The harness uses disposable state and stops every child/socket on success/failure.

Verification coverage (F18) uses this deliverable command, implemented by the epic:

```sh
npm run build && bash .agents/skills/run-talon-smoke/scripts/verify-signal-deliverable.sh --no-build
```

The verification script runs node dist/cli/index.js --help, the existing fake
terminal startup smoke and the Signal fake smoke. Its focused Vitest invocation
includes every test path in the Integration surfaces table: Signal connectors;
transaction/pipeline; Signal account-state and queue repositories; config,
factory, setup; errors, agent-runner/saved-delivery, queue processor/dead-letter,
reload/lifecycle/background producer; CLI
add-channel/config-utils/signal-resume; channel-send/list/broadcast; and starter
bundle, local resume IPC and pending/terminal status. Missing test files fail the
script. Tests specifically cover AC-1 named
instances/duplicate ownership and AC-12 scheduled target resolution, capabilities,
recipient-thread persistence and broadcast skipping default bindings. The script
prints each stage and an AC-to-test/evidence map; it does not invoke the full slow
suite. The R2-F1–R2-F7 scenarios above are mandatory named cases, including
maxAttempts=3/concurrencyLimit=5, expiry/backpressure, proof-refresh call budgets,
unselected-stranger faults, phone change, background UNKNOWN and active reload.
Build and ratified checks remain required.

AC-15 additionally requires redacted real-device evidence for both account
modes, both personal entry points, DM/group activation, send/chunk behavior,
source-device/echo filtering, relink/restart and offline/reconnect limits. Include
the freshness-rule and self-target metadata observations above. No live access
or success is claimed. Missing live accounts/evidence blocks completion; the
fake harness cannot waive that criterion. Design sign-off and any further
independent review remain pending.
