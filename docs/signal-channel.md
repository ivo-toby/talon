# Signal channel: operator reference

This is the operator reference for the `signal` channel type. It covers what Talon does with Signal, what you must run yourself, which numbers and commands are real, and what has and has not been proven.

Read the [status](#status-and-evidence) section first. The implementation is fixture-tested, and live-device acceptance (AC-15) was run once on 2026-11-13 with a fake provider. See [Live validation run, 2026-11-13](#live-validation-run-2026-11-13) for what was observed and what was not.

## Contents

- [Status and evidence](#status-and-evidence)
- [What the channel does and does not do](#what-the-channel-does-and-does-not-do)
- [Prerequisites](#prerequisites)
- [Operator-only steps](#operator-only-steps)
- [Account modes and personal entry points](#account-modes-and-personal-entry-points)
- [Identifiers](#identifiers)
- [Configuration](#configuration)
- [Authorization and activation](#authorization-and-activation)
- [Local bridge trust boundary](#local-bridge-trust-boundary)
- [Starting the bridge](#starting-the-bridge)
- [Device freshness and relinking](#device-freshness-and-relinking)
- [Alias and device-proof timing](#alias-and-device-proof-timing)
- [Replies, chunking and send outcomes](#replies-chunking-and-send-outcomes)
- [Saved replies, leases and the account gate](#saved-replies-leases-and-the-account-gate)
- [Rate limits, challenges and `signal-resume`](#rate-limits-challenges-and-signal-resume)
- [Reconnects, reload and startup](#reconnects-reload-and-startup)
- [Origin explanations and background agents](#origin-explanations-and-background-agents)
- [Receive errors are not account failures](#receive-errors-are-not-account-failures)
- [Retention and privacy](#retention-and-privacy)
- [Multiple Signal instances](#multiple-signal-instances)
- [Commands](#commands)
- [Status output](#status-output)
- [Limitations](#limitations)

## Status and evidence

Three different things are easy to confuse. Keep them apart.

| Gate | What it is | What it proves |
| --- | --- | --- |
| Unit and contract tests | Focused Vitest suites under `tests/unit/` for config, RPC framing, policy, send classification, queue, reload and CLI | Code behaves as the implementation says, against recorded fixtures |
| Fake-bridge deliverable gate | `bash .agents/skills/run-talon-smoke/scripts/verify-signal-deliverable.sh --no-build`, added by TASK-013. It runs the packaged daemon against a fake Unix-socket bridge and a no-cost fake provider. | The packaged daemon wires the channel end to end against a fake bridge. It is not live Signal evidence. |
| Live-device acceptance (AC-15) | Real linked-device runs with signal-cli v0.14.9 covering both account modes, personal entry points, DM and group replies, trigger and authorization exclusion, echo suppression, offline and reconnect behavior, and relinking across restarts | **Run on 2026-11-13** on a Debian 13 VM with signal-cli 0.14.9 (JVM build), with a fake provider. All listed scenarios passed. Long-reply chunking, relinking, attachments, disappearing messages and background-agent sends were not exercised. See [Live validation run, 2026-11-13](#live-validation-run-2026-11-13). |

Source inspection of the pinned signal-cli v0.14.9 tree is evidence for the field shapes Talon parses. It is not evidence of real-device behavior. The 2026-11-13 run did not settle these: delivery while the bridge is disconnected, unlink behavior, and replay representations. The source device of self-sent echoes is also not settled by that run, though echo suppression passed.

### Live validation run, 2026-11-13

AC-15 was run once on real phones. The results below come from Talon's database counts and content-free daemon logs. No message text, identifiers or tokens are recorded here.

- **Host:** Debian 13 VM (virtual CPU, x86-64-v2). signal-cli 0.14.9 JVM build on Eclipse Temurin JRE 25.
- **Bridge:** one multi-account `signal-cli daemon` with `--receive-mode=manual`, attachments, stories, avatars and stickers ignored.
- **Talon:** a fake `codex-cli` provider with a fixed reply. Two channels on the same bridge: a `personal` channel (the operator's account linked as a device) and a `dedicated` channel (a separately registered account).

Observed:

| Scenario | Mode | Result |
| --- | --- | --- |
| Note to Self, no trigger (3 inputs) | personal | 3 replies, 3 completed runs |
| Bridge's own replies in Note to Self | personal | no further runs (echo suppression) |
| Bridge restart | personal | reconnected in about 40 s, device re-verified, next input answered once |
| Talon restarts | personal, dedicated | link persisted, no relink needed |
| Input sent while Talon was stopped | personal | answered once after restart |
| Selected-chat `!talon` command | personal | 1 reply from the operator's account |
| Unauthorized sender's `!talon` in the same DM | personal | not admitted, no run |
| DM `!talon` command | dedicated | 1 reply |
| DM and group text without trigger | dedicated | not admitted |
| Group `!talon` command | dedicated | 1 reply (after the fix below) |
| Unauthorized sender's `!talon` in the group and as a DM | dedicated | not admitted, no run |
| Replies from the other account | both | seen as unselected DMs and ignored, no loops |
| Two `talonctl reload` runs | both | both channels back to ready and verified |
| One bridge serving both accounts | both | both channels ready and verified at the same time |

Totals: personal 4 inbound and 4 outbound; dedicated 4 inbound and 3 outbound; 7 completed runs. Error-level log lines were zero after the setup issues below were corrected.

**Defect found and fixed during the run.** After a group was added to the dedicated channel's `allowedGroups` and `talonctl reload` ran, the group reply was dead-lettered with `TARGET_REFUSED`. Stored channel config was not refreshed on reload, so allowlist expansions never reached the reply target check. Fixed in `4fd1449`. The same command was then answered once.

**Limits of the evidence:**

- Delivery means the bridge accepted the message. Recipient delivery and read state were seen on the phones, but Talon does not guarantee it.
- The fake provider means these results do not cover model behavior or cost.
- Not exercised: long replies and chunking, relinking after an unlink, attachments, disappearing messages, and background-agent sends.

**Operator notes:**

- On older or virtual CPUs, use the JVM build. The GraalVM native build refused to start on this VM with a "CPU ISA level is lower than required" error.
- A brand-new dedicated account may be rate-limit challenged on its first send. Solve it with a **challenge** CAPTCHA from `https://signalcaptchas.org/challenge/generate.html`. A registration CAPTCHA returns HTTP 400. Then follow [Rate limits, challenges and `signal-resume`](#rate-limits-challenges-and-signal-resume).
- The Unix socket path limit (about 108 bytes) also applies to Talon's own `dataDir` sockets, not only the bridge socket. A long worktree-based data path failed to bind with `EINVAL` during the run. Keep `dataDir` short.

## What the channel does and does not do

**Does:**

- Accepts text messages from a Signal account that you link (`personal`) or a separately registered or linked account (`dedicated`).
- Admits messages only from selected chats and authorized senders, and only when they start with the trigger (or, in Note to Self, need none).
- Replies in the originating Note to Self, DM, or group, as plain text. Long replies are split into ordered chunks.
- Records each admitted message in Talon's ordinary SQLite history, which means it reaches configured providers and memory like any other channel.

**Does not:**

- Install, launch, register, link, or supervise signal-cli. The operator runs the bridge. Talon connects to its socket.
- Read account keys, solve CAPTCHAs, provision phone numbers, or access the container engine.
- Handle attachments in either direction, voice, stickers, video, or view-once and disappearing messages.
- Create or manage groups, membership, contacts, reactions, edits, deletes, or receipts.
- Guarantee delivery to a recipient. A successful send means the bridge accepted the message, not that anyone read it.
- Replay events the bridge consumed before Talon accepted them locally. See [Reconnects, reload and startup](#reconnects-reload-and-startup).

## Prerequisites

- **signal-cli v0.14.9 only.** The bridge version is pinned. Talon reads the bridge `version` and refuses any other value (`UNSUPPORTED_VERSION`), including `unknown`, development suffixes, other patch versions, and newer minor versions. Upgrading signal-cli requires a later Talon change with new fixtures and live evidence.
- **Multi-account daemon mode.** The bridge must expose `listAccounts`. A bridge without it is refused (`UNSUPPORTED_BRIDGE_MODE`).
- **Java runtime.** The pinned signal-cli README requires at least JRE 25 and a native libsignal-client that matches your platform and architecture (the signal-cli v0.14.9 README, Requirements section).
- **Same Unix user.** The bridge and talond run as the same numeric UID. See [Local bridge trust boundary](#local-bridge-trust-boundary).
- **Linux or another Unix with Unix-domain sockets and `lstat` semantics.** Talon checks ownership and mode bits of the socket path and its ancestors.

Talon does not install any of these.

## Operator-only steps

These steps happen outside any agent or chat session, in your own terminal:

- `signal-cli link` (linking the bridge as a device). It shows a `sgnl://linkdevice` URI and a QR code. Treat both as secrets.
- Any `signal-cli register` or `verify` step, including verification codes.
- `submitRateLimitChallenge` and CAPTCHA solving, including challenge tokens.

Rules:

- An agent must never run these commands, and must never ask you to paste a link URI, QR content, verification code, CAPTCHA result, or challenge token into chat.
- Resolve a challenge with the bridge's own tooling, then run `talonctl signal-resume --channel <name> --external-challenge-resolved` yourself. See [Rate limits, challenges and `signal-resume`](#rate-limits-challenges-and-signal-resume).
- Talon never solves CAPTCHAs and never handles link, registration, or challenge secrets.

## Account modes and personal entry points

Each Signal channel instance selects one account and declares its mode.

### `personal` (your existing Signal account)

- The bridge is linked as an **additional device** on your existing account. Setup must never register that account again or replace your primary phone client.
- Replies come from your own Signal identity.
- Two entry points accept commands from you:
  1. **Note to Self.** Every nonempty text message you send to yourself is a command. No trigger is needed.
  2. **Selected DM or group.** Your own message in a selected chat is a command only when it starts with the trigger.
- Messages from your other linked devices are commands in the same way. Messages sent by Talon's own replies, scheduled sends, broadcasts, or chunks are recognized by device provenance and are not commands.
- Progress and tool-call notices are suppressed. `showToolCalls: true` is rejected at config load for personal mode (`Personal Signal mode forbids tool notices`).
- Because the bridge is a full client on your account, it has access to everything in the account before Talon's filters. See [Retention and privacy](#retention-and-privacy).

### `dedicated` (a separate agent account)

- The account is registered or linked separately. Replies come from that account's identity.
- Messages sent by the dedicated account itself, including synchronized echoes, never become commands, even if their text contains the trigger.
- Selected DMs and groups from other people activate on the trigger, subject to authorization.
- Best-effort progress and tool notices may appear in the chat. They are sent through the same guarded delivery as replies.
- Dedicated mode is an operator choice. It is not a prerequisite for the channel.

## Identifiers

- **Account and people: UUID (ACI).** Authorization compares canonical account UUIDs, never phone numbers or display names. UUIDs must be in 8-4-4-4-12 hexadecimal layout, with no braces or surrounding whitespace. Upper-case hexadecimal is normalized to lowercase.
- **Account selector.** `account` may be a phone number in E.164 form (`+` followed by 2 to 15 digits, first digit nonzero) or the same ACI. The number is only a bootstrap hint. If the number changes, the ACI keeps the channel working, and a stale phone number is reported as a stale hint, not as an identity.
- **Groups in config.** `allowedGroups` entries are standard Base64 group IDs with padding. They must decode to nonempty bytes and re-encode identically. URL-safe alphabet, missing padding, and whitespace are rejected at load.
- **Groups in thread IDs.** Internally, group IDs are stored as unpadded Base64url inside the thread identifier.
- **Thread identifiers** look like `signal:v1:<accountUuid>:self`, `signal:v1:<accountUuid>:dm:<peerUuid>`, or `signal:v1:<accountUuid>:group:<base64url-group-id>`. Group identity comes from the group ID, not its name, so a rename does not split history. Group senders stay individual participants.
- **Hidden phone numbers** are supported. A peer without a visible number is identified by its UUID alone.

## Configuration

### Fields

| Field | Required | Default | Constraint |
| --- | --- | --- | --- |
| `accountMode` | yes | — | `personal` or `dedicated` |
| `socketPath` | yes | — | Absolute path, no NUL bytes. Trust checks run at connect time (see below). |
| `account` | yes | — | E.164 number or the canonical ACI. An ACI must equal `accountUuid`. |
| `accountUuid` | yes | — | Canonical ACI in UUID form |
| `deviceId` | yes | — | Positive safe integer. Personal mode: must not be `1` (the primary device). |
| `deviceCreatedTimestamp` | personal: yes | — | Positive safe integer, milliseconds from `listDevices` for the bridge device. Dedicated: optional; if given, it must match. |
| `allowedDmPeers` | no | `[]` | UUIDs, lowercased, deduplicated |
| `allowedSenders` | no | `[]` | UUIDs, lowercased, deduplicated |
| `allowedGroups` | no | `[]` | Standard padded Base64 group IDs, deduplicated |
| `triggerPrefix` | no | `!talon` | Nonempty after trimming. Do not use leading or trailing whitespace (see [trigger rules](#trigger-rules)). |
| `requestTimeoutMs` | no | `30000` | Integer 1000 to 120000 |
| `reconnectBaseMs` | no | `1000` | Integer 100 to 60000 |
| `reconnectMaxMs` | no | `60000` | Integer 100 to 300000, must be at least `reconnectBaseMs` |

Source: `src/channels/connectors/signal/signal-config.ts`, and the channel-level checks in `src/core/config/config-schema.ts`. Channel-level `showToolCalls` is the common option described in the README. For personal mode, `true` is rejected.

Empty allowlists are the default and deny everything. An empty list means no chat or sender is selected or authorized.

### Validated example (empty allowlists)

Both blocks below are validated by the real config loader (`loadConfig`) against the current schema. The example config keeps the Signal entry commented out so it does not run by default. Uncomment it and replace the synthetic values.

Personal mode:

```yaml
channels:
  - name: signal-personal
    type: signal
    enabled: true
    config:
      accountMode: personal
      socketPath: /run/user/1000/talon-signal/signal.sock
      account: '+15555550100'
      accountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      deviceId: 2
      deviceCreatedTimestamp: 1767225600000
      allowedDmPeers: []
      allowedSenders: []
      allowedGroups: []
      triggerPrefix: '!talon'
      requestTimeoutMs: 30000
      reconnectBaseMs: 1000
      reconnectMaxMs: 60000
```

Dedicated mode:

```yaml
channels:
  - name: signal-agent
    type: signal
    enabled: true
    config:
      accountMode: dedicated
      socketPath: /run/user/1000/talon-signal/signal.sock
      account: '+15555550199'
      accountUuid: '11111111-2222-4333-8444-555555555555'
      deviceId: 1
      allowedDmPeers: []
      allowedSenders: []
      allowedGroups: []
      triggerPrefix: '!talon'
```

Quote `'!talon'`. An unquoted `!` starts a YAML tag and the file will not parse.

Add a channel from the CLI. The `--signal-config` JSON uses the same fields:

```bash
npx talonctl add-channel --name signal-personal --type signal \
  --signal-config '{"accountMode":"personal","socketPath":"/run/user/1000/talon-signal/signal.sock","account":"+15555550100","accountUuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","deviceId":2,"deviceCreatedTimestamp":1767225600000}'
```

`add-channel` validates the entry with the same schema as the daemon and writes it atomically. It does not verify anything against a live bridge.

Then select chats and senders. For a DM, the peer must be in **both** `allowedDmPeers` and `allowedSenders`. For a group, the group must be in `allowedGroups` and each participant in `allowedSenders`.

```yaml
    config:
      # ...as above...
      allowedDmPeers: ['cccccccc-dddd-4eee-8fff-000000000001']
      allowedSenders: ['cccccccc-dddd-4eee-8fff-000000000001']
      allowedGroups: ['AAAAAAAAAAAAAAAAAAAAAA==']
```

### Bindings

Signal instances route to personas like any other channel. A binding to a persona is not authorization. The allowlists above are the only authorization.

```yaml
bindings:
  - persona: assistant
    channel: signal-personal
    isDefault: true
```

## Authorization and activation

Every inbound event is checked in this order. The first failing rule excludes the event. Excluded events do not enter transcript or queue storage.

| Message | Selection and authorization | Activation |
| --- | --- | --- |
| Your text in Note to Self (personal mode) | Your account is verified | Every nonempty text message |
| Your text in a DM or group (personal mode) | The DM peer or group is in `allowedDmPeers` or `allowedGroups` | Trigger with a nonempty command |
| Text from a DM peer | Peer in `allowedDmPeers` **and** sender in `allowedSenders` | Trigger with a nonempty command |
| Text in a selected group | Group in `allowedGroups` **and** participant in `allowedSenders` | Trigger with a nonempty command |
| Anything the dedicated account sent, including echoes | — | Ignored, even if it contains the trigger |
| Text in an unselected chat, from an unauthorized or unknown sender, or from the wrong account | — | Ignored |
| Receipts, typing, reactions, group/profile/timer updates, stories, calls, edits, deletions | — | Ignored, no turn, no transcript change |
| Attachment-only message | — | Ignored |
| Attachment with ordinary text | Text rules apply | Text only. Attachment bytes are never fetched or stored. |
| Disappearing or view-once message | — | Excluded before storage |

### Trigger rules

Applies to every DM and group message. Not to Note to Self.

1. Leading whitespace is ignored.
2. The message must start with `triggerPrefix`, exact case.
3. The prefix must be followed by whitespace or end of text. `!talonx hi` does not match `!talon`.
4. The prefix and following whitespace are removed.
5. An empty remaining command does not start a turn. Whitespace-only text never starts a turn.

Examples with the default `!talon`:

| Message | Result |
| --- | --- |
| `!talon summarize today` | Command: `summarize today` |
| `   !talon   hi` | Command: `hi` |
| `!talon` | Ignored (empty command) |
| `!talonx hi` | Ignored |
| `hi there` | Ignored |

In Note to Self the entire text is the command, unchanged. A message such as `!talon hi` in Note to Self is passed through as written.

Note to Self activation does not use the trigger. Both rules still require nonempty text.

> **Warning: `triggerPrefix` whitespace.** Do not configure a trigger with leading or trailing whitespace. Activation ignores leading whitespace, so a leading-space trigger never matches. A trailing-space trigger such as `"!talon "` only matches when the command is preceded by more whitespace (for example `!talon  hi`). The schema accepts such values today, so check your config.

## Local bridge trust boundary

Talon connects to a Unix socket that you supervise. It treats the bridge as trusted only if the filesystem layout is what it expects.

Required layout:

- The **socket's parent directory** is owned by talond's numeric UID and has mode exactly `0700`.
- The **socket** is a Unix socket owned by talond's UID. Its mode is `0600` or `0700`. Talon refuses any socket with group or other permission bits.
- **Every ancestor** up to `/` is owned by talond's UID or by root, and has no group-write or world-write bit.
- **No symlinks** in the configured path, the socket, or any ancestor.

Talon checks these with `lstat` before each connection. It then repeats the checks and compares the socket's device and inode after connecting, before any identity request or subscription. A change closes the connection and puts the channel in `needs_setup` with `UNTRUSTED_SOCKET`.

Talon never repairs, unlinks, chmods, or replaces these paths. An unsafe path is a setup problem for you to fix.

**Do not use `/tmp`.** A socket directly in `/tmp`, or under any world-writable ancestor, is rejected even if the sticky bit is set.

Recommended native layout:

```bash
mkdir -p /run/user/$(id -u)/talon-signal
chmod 0700 /run/user/$(id -u)/talon-signal
```

The bridge creates the socket inside that directory when it starts under `umask 077` (see [Starting the bridge](#starting-the-bridge)). Check both modes and owners:

```bash
stat -c '%a %U' /run/user/$(id -u)/talon-signal               # expect: 700 <your user>
stat -c '%a %U' /run/user/$(id -u)/talon-signal/signal.sock   # expect: 700 or 600 <your user>
```

Talon does not use `SO_PEERCRED`, so there is no portable claim about which process connected. The boundary is path control: other UIDs cannot place or replace the socket because the directory is private. Root and any process running as talond's UID are trusted, since they already control talond's config and database.

Docker: mount that private directory into the talond container at the same absolute path, with the same numeric UID as the bridge. The container runtime's mount is trusted. Symlinks inside the mounted path still fail validation.

## Starting the bridge

You run the bridge. Talon does not start it. Use the same data directory for setup and for the service.

Start the bridge under `umask 077`. Linux creates a socket with mode `0777 & ~umask`, so this gives the socket mode `0700`. Do not chmod the socket afterwards.

```bash
umask 077
signal-cli --data-dir /var/lib/talon-signal daemon \
  --socket /run/user/1000/talon-signal/signal.sock \
  --receive-mode manual \
  --ignore-attachments --ignore-stories --ignore-avatars --ignore-stickers \
  --no-receive-stdout
```

What each flag is for:

- `--receive-mode manual` is required. Talon subscribes to receive explicitly, so messages are not consumed before the subscription exists. Without it the bridge can push messages Talon has not subscribed to.
- `--ignore-attachments` is required by this channel. It stops the bridge downloading attachment bytes. Talon never retrieves attachments.
- `--ignore-stories`, `--ignore-avatars`, `--ignore-stickers` skip categories Talon does not use. Keep them.
- `--no-receive-stdout` stops received messages being printed.

Source for the flags: the signal-cli v0.14.9 `daemon` section of the man page (`signal-cli.1.adoc`) and `DaemonCommand.java` in the same release. Do not pass `-a`. The daemon loads all local accounts, and Talon selects its account explicitly on every request.

Talon cannot verify these flags from the socket alone. A bridge started without them still works, but it consumes attachments and other categories that Talon ignores.

## Device freshness and relinking

Talon uses the bridge's linked-device list to check that the bridge is still the device you recorded. The JSON device list does not say which device is local, so Talon uses a conservative rule instead.

For personal mode, a verified account must satisfy all of these:

1. The configured `deviceId` is present, and its creation timestamp is nonzero and equals `deviceCreatedTimestamp`.
2. Every other non-primary linked device has a known, nonzero creation timestamp that is strictly earlier than the bridge device's.

If either fails, the channel enters `needs_setup` with `DEVICE_METADATA_INVALID`. This means **the bridge must be the most recently linked device.** When you link another phone or desktop, personal mode pauses until you relink the bridge last and refresh its metadata.

Relinking procedure (operator-only; see [Operator-only steps](#operator-only-steps)):

1. Stop the bridge.
2. Run `signal-cli --data-dir <dir> link` yourself and complete it on your primary device. Do not paste the link URI or QR code anywhere an agent can read it.
3. With the bridge still stopped, read the device metadata for the same data directory:
   - `signal-cli --data-dir <dir> -a <account> listDevices` prints `Device <id> (this device)`. Use that ID as `deviceId`.
   - `signal-cli --output=json --data-dir <dir> -a <account> listDevices` gives the creation timestamp for that ID. Use it as `deviceCreatedTimestamp`.
4. Start the bridge again under `umask 077`, with the same data directory.
5. Update the channel config and run `talonctl reload`.

If you point a service at a different existing account directory while reusing old `deviceId` and `deviceCreatedTimestamp` values, the metadata no longer matches. Run a fresh setup.

Talon does not read account keys to make this check. It only reads the device list and compares IDs and timestamps.

## Alias and device-proof timing

Two separate timing concerns apply here. The numbers below are the ones the implementation uses.

**Device proof (server request, 5 minutes).**

- A successful device check is valid for 5 minutes. Talon refreshes it about every 60 seconds.
- Talon makes at most one device check per account per 60 seconds, including startup, reconnect, and refreshes triggered by unknown devices. The check start time is persisted before the request, so a restart does not reset the budget.
- A send never triggers a device check. A new connection waits for a successful check before reaching `ready`.
- A proof is not reused across daemon restart.
- A transient device-check failure on a healthy socket keeps the subscription and the last good proof until its 5-minute expiry. Talon retries within the budget.
- When the proof expires and refresh stays unavailable, the subscription stays up, sends are deferred, and the channel reports `VERIFICATION_STALE`.

**Held events (10 minutes, bounded).**

- Selected, triggered messages that would otherwise be accepted, but whose only missing check is an expired personal-device proof, are held in memory. The hold holds at most **64 events and 1 MiB** total, for **10 minutes** from receipt.
- Renewal re-checks every held event against the current roster and config, then admits it once with its original identity. Held messages never grant authorization.
- Overflow drops the newest event. Expiry or stop drops the held events. Talon emits one safe warning per episode with counts only.
- **Bounded loss.** A held event that is dropped is not replayed by Talon. Resend the command after recovery if it still matters.

**Local alias refresh (local RPC, not a server device check).**

- Talon reads `listAccounts` at start, on reconnect, and every 60 seconds to refresh the number-to-ACI alias.
- A notification whose account alias is unknown triggers one refresh, coalesced to at most once per 5 seconds. Such notifications are held for up to 30 seconds, in at most 64 entries and 1 MiB.
- If the refreshed list does not map the unknown alias to the pinned ACI, the notification is ignored. Talon never infers ownership from the envelope sender.
- If the refreshed list proves the ACI is missing or ambiguous, the channel enters `needs_setup` with `ACCOUNT_MISMATCH`.

A number change on a numbered account does not require a reconnect. The next alias refresh picks up the new number.

## Replies, chunking and send outcomes

**Formatting.** Replies pass through Talon's Markdown-to-plain-text conversion. Signal receives plain text.

**Chunking.** Text is split into ordered chunks of at most **2,000 UTF-8 bytes**. Splits happen between Unicode code points, never inside one. Chunking is by code point, not grapheme cluster, so a multi-code-point emoji sequence can be split. The bridge promotes larger text into an attachment, so this limit is enforced by Talon before any RPC.

- Replies over the saved-reply text ceiling of 1 MiB are refused before any send, with `OUTPUT_TOO_LARGE`. Nothing is truncated.
- An outbound payload with attachments is refused with `UNSUPPORTED_ATTACHMENT` before any part is sent.

**Per-chunk checks.** Immediately before each chunk Talon re-reads the target from the bridge. A DM must have exactly one matching contact, unblocked, registered, with a disappearing timer of zero. A group must have exactly one matching group, with you as a member, not blocked, not terminated, with a timer of zero. A missing or ambiguous record is a permanent refusal (`TARGET_UNVERIFIABLE`). Talon does not assume safe defaults.

Setup note: a new peer UUID may not send on the first try if the bridge has no contact record for it. Establish the recipient state first (for example, send from the other side or add the contact on the bridge), then retry. The same applies to Note to Self, which needs a self-contact record with a zero timer.

**Outcomes.** A send is successful only when the bridge returns an ordinary success envelope and every per-recipient result is `SUCCESS` with a valid timestamp. Talon classifies everything else as one of three outcomes:

| Outcome | Meaning | Retry behavior |
| --- | --- | --- |
| `NOT_SENT` | Nothing was written to the socket for this chunk, or the bridge refused it before any recipient accepted it | Only the saved chunk may be retried, and only for saved replies. An explicit tool send returns an error and can be repeated by a later explicit call. |
| `PARTIAL` | Some chunks or some recipients were accepted | If the current chunk was unwritten or explicitly refused (`retryScope` `delivery_only`), the saved reply is **deferred** and resumes from its cursor. Accepted chunks are never resent. If the current chunk was partly accepted or its acceptance is unknown, the delivery is **terminal**. No automatic resend. |
| `UNKNOWN` | Bytes were written and the outcome is not known: timeout, socket loss after writing, missing or invalid response, empty result set, or any `NETWORK_FAILURE` | Terminal for that delivery. No automatic resend. |

Bridge acceptance does not prove that a recipient read or received the message.

The error type is `SignalDeliveryError` and carries the outcome, the count of accepted chunks, the current chunk's acceptance state, success and failure counts, and a retry scope. It does not carry recipient identifiers, bridge timestamps, raw remote causes, or challenge tokens.

## Saved replies, leases and the account gate

Replies are saved before they are sent, so a provider run is never repeated to recover a send.

**Checkpoint.** When the provider finishes, Talon writes a delivery checkpoint into the queue item's payload before any send. It holds the destination, the fixed chunks, the next-chunk cursor, the current chunk's state, and the counts. Limits:

- Original reply text: 1 MiB of UTF-8.
- Formatted chunk text: 1 MiB of UTF-8.
- Serialized checkpoint: 3 MiB.
- Lifetime: **24 hours** from preparation. Retries do not extend it. After expiry, an undelivered reply is terminal.

Source: `src/queue/signal-delivery-checkpoint.ts`.

**Cursor.** A chunk that is accepted advances the cursor in the same transaction that clears its in-flight marker. After a restart Talon resumes at the next unsent chunk. Accepted chunks are never resent.

**Restart rules.**

- A `ready` checkpoint resumes delivery only. No provider call, no tool call.
- An `in_flight` checkpoint (a write may have happened) becomes `UNKNOWN`, which is terminal for that delivery.
- A `delivered` checkpoint only finishes local history and status writes. No RPC.

**Deferral.** A `NOT_SENT` chunk that is only transiently refused is deferred. The queue retries it after a bounded delay of 1 to 60 seconds, or after the account's not-before time, and never past checkpoint expiry. Deferral does **not** consume the provider `maxAttempts` budget (default `3`, `queue.maxAttempts` in `config-schema.ts`). An older deferred reply blocks later work on the same thread until it is delivered or terminal. Other threads and channels keep going.

**Destination lease.** Before its first chunk, a delivery takes an exclusive lease on its (account, thread). The lease is held across all chunks and across deferrals, and released on delivered, terminal, or cancelled. Explicit tool sends and background sends to the same thread wait for it. Each complete message stays contiguous, while other threads make progress between chunks.

Leases live in `signal_destination_leases`. A lease is removed when its queue item is deleted (`ON DELETE CASCADE`).

**Account gate.** The gate limits send traffic per account.

- At most **one** chunk RPC is in flight per account.
- Chunks start at most **once per second**. The last start time is persisted before each RPC.
- Waiters queue FIFO: at most **64 waiters and 1 MiB** of waiting text in memory, each waiting at most **30 seconds**. A full queue or an expired wait returns `NOT_SENT`. A saved reply is deferred. An explicit tool call receives the error.
- Canceling a waiter removes only that waiter. It cannot cancel the active send.
- Sends from other clients of the same account are outside this gate.

**Reservation.** Before a chunk is written, Talon records a reservation (queue item, delivery, purpose) in the same transaction as the in-flight marker. A restart that finds an unresolved reservation marks only that delivery `UNKNOWN` and applies a 60-second recovery fence. The reservation is not an account failure.

## Rate limits, challenges and `signal-resume`

Restrictions from the bridge are persisted before the call returns, so a restart keeps them.

| Bridge signal | Account action |
| --- | --- |
| `RATE_LIMIT_FAILURE` in any result, or RPC error `-5` | Rate pause. The remaining chunks of the affected delivery stop. |
| A valid `retryAfterSeconds` | Not-before is the later of now plus **15 minutes** and the reported delay. No downward cap. |
| Rate failure with no delay | 15 minutes |
| Malformed or overflowing delay, RPC error `-6`, or a proof/challenge token | **Challenge pause.** Tokens are discarded. Receiving continues if the account is otherwise verified. |
| Unknown or interrupted reservation | That delivery is terminal, and a **60-second recovery fence** applies. A longer committed rate or challenge pause is kept. |

Sends during a rate or recovery pause wait within the call bound, then return `NOT_SENT` with a next-attempt hint. Saved replies defer. Sends during a challenge pause return `NOT_SENT` with a manual-recovery reason, without calling the bridge.

**Recovery fence vs challenge pause.** The recovery fence (60 seconds) expires on its own. It does not require you to do anything. The challenge pause does require you to do something, because the bridge needs a CAPTCHA solved.

**`talonctl signal-resume`** clears a **challenge** pause only, and only after you confirm the challenge was resolved outside Talon.

```bash
npx talonctl signal-resume --channel signal-personal --external-challenge-resolved
```

- The flag is required. Without it, the command is refused.
- The command verifies the account and device first. If verification fails, the pause stays.
- It does not send a message and does not replay anything.
- It does not clear rate pauses, recovery fences, or other `needs_setup` reasons. Unexpired rate delays block it.
- Where the connection is down, it returns an unavailable outcome rather than retrying.

To resolve a challenge, follow the bridge's own instructions (`submitRateLimitChallenge` in `signal-cli-jsonrpc.5.adoc`, or signal-cli's CAPTCHA flow). This is operator-only and happens outside any agent session. Challenge tokens never go into chat, logs, or agent context. Talon never solves CAPTCHAs.

## Reconnects, reload and startup

**Connection.** Talon connects to the socket, verifies the version, the bridge mode, the account, and the device, then creates one manual receive subscription. Start resolves after the first bounded attempt, whether the channel is `ready`, `reconnecting`, or `needs_setup`. A failed first connect keeps retrying without a daemon restart.

- Disconnects or refused connections move the channel to `reconnecting`, with the subscription and proof cleared. Reconnect delays grow exponentially from `reconnectBaseMs` to `reconnectMaxMs`, with jitter.
- Three framing or outer-protocol failures within five minutes move the channel to `needs_setup` with `PROTOCOL_FAILURE_LOOP`. Per-message exceptions do not count.
- The RPC layer caps a frame at 1 MiB and correlated pending requests at 64. A request beyond 64 is refused before writing.

**Receive is at-most-once on the Talon side.** Talon acknowledges nothing to Signal, because the protocol offers no durable consumer acknowledgement. An event the bridge consumed before Talon wrote it into its local queue cannot be replayed by Talon. The channel does not claim exactly-once or no-loss delivery for that window. Events are held in a bounded in-memory buffer and retried locally.

**Ingress buffer.** A normalized, authorized event is written to the transcript and queue in one transaction. If that write fails, the event is kept in a buffer of up to 64 entries and 1 MiB, and retried with jittered backoff for up to five minutes. The buffer survives socket reconnects but not a process restart. Overflow closes the subscription and reconnects without evicting buffered events. The overflowing event may be lost.

**Reload.** Reload serializes with other reloads (SIGHUP, IPC, and the automatic retry). In order:

1. The new config and skills are loaded. A failure here changes nothing.
2. Claims are quiesced. Providers already running may finish and save their replies.
3. Each Signal connector is stopped. Up to **3** attempts per connector repair state writes and stop again.
4. The new generation is registered and started.
5. Claims are resumed.

If a Signal connector cannot stop cleanly after those attempts, the reload is **pending**. Claims stay quiesced. The reload retries itself after **30 seconds**. The timer is cancelled on the next successful stop. A pending reload is logged by the daemon (`reload pending`); `talonctl status` does not show it yet.

A Signal stop waits up to **30 seconds** for an active send to finish before closing. A send still pending at the limit is marked `UNKNOWN`. Queued, definitely unwritten replies are retained. After a reload, new connectors verify and reach `ready` automatically, without `signal-resume`, within about 60 seconds.

**Bootstrap.** Startup recovery of the queue runs up to **5 attempts** (the first attempt plus 4 retries, with 250 ms doubling delays). If it still fails, bootstrap fails before the queue, channels, or bridge are created, and the process exits. The next start retries.

**Stop.** Stop cancels subscriptions, pending requests, reconnect timers, and retry timers. Nothing reconnects after an instance stops.

## Origin explanations and background agents

- **Explicit tool sends.** If a `channel_send` to Signal fails, the tool returns a structured error, and the provider can still explain the situation on the origin channel. A failure to one Signal account does not suppress replies on other channels or accounts.
- **Partial or unknown explicit sends.** The same operation is never resent with a new request ID. The exact (queue item, account, thread) target is latched for that run. Further explicit sends to that target are rejected. The origin reply is not forwarded to a latched target. It is recorded as a local terminal reason. Other targets are unaffected.
- **Final replies.** In both modes, ordinary Signal assistant text is held until the final reply and saved as one checkpoint. Nothing is streamed before tools finish.
- **Personal mode** suppresses thinking and tool notices. Dedicated mode may send best-effort progress and tool notices through guarded delivery. A failed notice is not replayed in the final reply.
- **Scheduled runs.** Scheduled final text is skipped as usual. Scheduled `channel_send` and broadcast follow the normal capability and recipient rules. Recipient context is preserved, and a successful scheduled send is stored on the live recipient thread.
- **Background agents.** Background-agent tasks have no Signal execution context registered. Their Signal `channel_send` and broadcast calls fail closed with `EXECUTION_UNAVAILABLE`. This is a known limitation. Background runs cannot send to Signal today. Their completion notifications to a Signal origin do use the saved-delivery path.

## Receive errors are not account failures

A receive notification carrying an exception is excluded alone. The exception and envelope are discarded, and Talon increments an aggregate `RECEIVE_EXCEPTION` counter. The channel stays `ready`, with the existing proof and subscription. Talon does not infer account state from exception text or type.

Invalid envelopes, control events, unknown source devices, and unselected chats are excluded per event with no state change. Repeated faults from strangers or unselected chats do not stop your selected chats from receiving.

Only confirmed account or device problems move the account to `needs_setup`: a missing or ambiguous ACI, a failed device freshness rule, an unsupported version or bridge mode, or an untrusted socket.

## Retention and privacy

Read this before enabling the channel.

**What the bridge holds.** signal-cli keeps its account state and keys in its data directory. Talon never reads them. Protect that directory like any account credential.

**Account-wide access (personal mode).** A linked device is a full client on your account. The bridge receives everything, including chats Talon never selects. Talon's filters run after receipt, so the bridge sees the traffic before Talon does.

**Ignored traffic.** Excluded events are not stored, not sent to providers, and not written to the transcript or audit log. Counters are aggregated by channel name and reason, at most once a minute, and contain counts only.

**Admitted text.** Admitted messages are stored in Talon's ordinary SQLite history, and reach configured model providers and memory like any other channel. Configured observability (for example Langfuse) also records them if enabled.

**Saved replies.** Outgoing reply text, chunks, and cursors are stored in the queue item's payload with ordinary queue retention until you purge them. This is an additional stored copy of your replies. A delivery that ends terminal (other partial sends, unknown sends, permanent refusal, or expiry) moves its queue item to `dead_letter`, and its saved text stays there until purged.

**Purge.** `talonctl queue-purge` deletes the selected queue items, including their saved reply text and cursors. The default statuses are `pending`, `failed`, and `completed`. They do **not** include `dead_letter`. To remove retained reply bodies of terminal Signal deliveries, purge that status explicitly with `talonctl queue-purge --statuses dead_letter`. `--all` covers every status, including items in flight.

Purge does not delete transcript rows already in the `messages` table. For a queue item that holds a Signal checkpoint, purge also cancels its pending or running provider run, with status `cancelled` and error `SIGNAL_DELIVERY_OPERATOR_PURGE`. Runs without a Signal checkpoint are not changed by this path, and completed runs keep their status. The command reports only the number of deleted queue items. It does not report how many runs were cancelled.

**Purge does not recall messages.** A chunk already accepted, or in flight to the bridge, may still arrive. The purged delivery stops before its next chunk, and no chunk is re-created from memory. If an in-flight send settles as unknown, the ordinary account recovery fence applies.

**Disappearing and view-once messages** are excluded before storage. Talon does not delete provider-side or transcript copies of anything already stored.

**Attachments** are never downloaded (`--ignore-attachments`) and never passed to providers.

## Multiple Signal instances

You can configure several Signal instances, each with its own name, account, and persona binding.

- **One owner per account.** Every enabled instance that resolves to the same account UUID is rejected, and all of them are skipped with a warning. Other accounts keep running. Disabled instances do not count.
- **Different accounts on one socket** are allowed.
- **Personal roster.** When a personal account's messages arrive in another local instance, the sender's device must be in that account's verified roster of human devices (its linked devices minus the bridge). Messages from unknown devices are ignored, and Talon requests re-verification.
- **Dedicated accounts** are excluded across local instances regardless of source device. Their messages are never commands elsewhere.
- Personal accounts are not treated as generic sibling bots.

Give instance names that do not contain private identifiers. Names appear in logs and status.

## Commands

All commands below were checked against `node dist/cli/index.js <command> --help`.

| Command | Use |
| --- | --- |
| `talonctl add-channel --name <name> --type signal --signal-config '<json>'` | Add a validated Signal entry to `talond.yaml`. Optional `--show-tool-calls true\|false` (personal forbids `true`). |
| `talonctl reload` | Apply config changes. Serialized, with the pending-retry behavior above. |
| `talonctl status` | Show the `signal` block: saved delivery counts and per-connector state. |
| `talonctl signal-resume --channel <name> --external-challenge-resolved` | Clear a challenge pause after an external resolution. Sends nothing. |
| `talonctl queue-purge [--statuses <list>] [--all]` | Delete queue items. Default statuses: `pending,failed,completed`. Terminal Signal deliveries are `dead_letter`; use `--statuses dead_letter` to remove their retained reply text. `--all` covers every status. |
| `talonctl list-channels` | List configured channels. |

`add-channel` validates locally only. It does not connect to the bridge.

## Status output

`talonctl status` prints a Signal section when a Signal channel is configured or saved deliveries exist.

```
Signal saved: pending=<n> terminal=<n>
  <REASON>=<count>
Signal <channel>: receive=<state> reason=<reason|none> outbound=<suspended|not-suspended (not send authority)>
  sender=<healthy|blocked> stopped=<bool> pending-writes=<n>
  verification=<state> reason=<reason|none> draining=<bool> persistence-blocked=<bool>
  proof: held=<n> dropped=<n>
  receipt: held=<n> dropped=<n>
  alias: held=<n> dropped=<n>
Signal: inspect partial/unknown deliveries; no automatic replay. ...
```

Read `outbound=not-suspended` as "not send authority." It does not mean sends will succeed. Counts are safe: they contain no identifiers, text, or raw errors.

If the saved-delivery summary cannot be read, the line reads `Signal saved: unavailable`, not zero.

## Limitations

- **Live evidence.** AC-15 was run once on 2026-11-13 on one Debian 13 VM with a fake provider. See [Live validation run, 2026-11-13](#live-validation-run-2026-11-13). Long-reply chunking, relinking, attachments, disappearing messages and background-agent sends have no live evidence. Other platforms and bridge builds are not validated.
- **Version.** Only signal-cli v0.14.9 is accepted.
- **Media.** No attachments, voice, stickers, video, or view-once in either direction.
- **Not offered.** Group creation and management, contact management, mentions, buttons, reactions, edits, deletes, and read receipts. Native replies and the `channel_react` tool are likewise unsupported on Signal, and the Telegram/WhatsApp `replyToTrigger` and `inboundReactions` options do not apply to `signal` connectors.
- **Delivery.** Acceptance by the bridge is the success boundary. Recipient delivery is not confirmed. Events the bridge consumed before Talon's local write can be lost. Talon does not replay bridge history.
- **No automatic resend.** A PARTIAL saved reply whose current chunk was unwritten or refused is deferred and resumes from its cursor, so do not resend it by hand. Other partial sends and every unknown send are terminal. Inspect the chat and issue a new command if you still want it.
- **Background agents** cannot send through Signal (`EXECUTION_UNAVAILABLE`).
- **Single bridge.** There is one transport: the local Unix socket. HTTP, SSE, D-Bus, and remote bridges are not supported.
- **Talon does not manage the bridge.** Registration, linking, CAPTCHA solving, process supervision, and container management are operator tasks.
