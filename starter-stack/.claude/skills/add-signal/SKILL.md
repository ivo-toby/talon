---
name: add-signal
description: |
  Add Signal as a channel via an operator-owned signal-cli 0.14.9 bridge
  (JSON-RPC over a private Unix socket). Text only. Use when the user says
  "add signal", "connect signal", "set up signal", or "signal channel".
triggers:
  - "add signal"
  - "connect signal"
  - "signal channel"
  - "signal bridge"
  - "signal-cli"
---

# Add Signal Channel

Walk the user through adding a Signal channel to Talon. One question at a time.

Talon does not install, register, link, or supervise signal-cli. The operator
runs the bridge, owns its account state, and decides when it runs. Talon only
connects to the bridge's private Unix socket, verifies the account and device,
and then receives and sends text. Nothing in this walkthrough is provisioning
that Talon performs for you.

## Safety rules (read first)

- **No secrets in chat, captures, or logs.** Linking URIs and QR codes,
  verification codes, CAPTCHA and challenge tokens, account keys, and recovery
  keys stay in the operator's own terminal. Do not paste them into the
  conversation, a ticket, a commit, or evidence.
- **Agent rule: the agent does not run these itself.** The agent never runs
  `signal-cli link`, `register`, `verify`, `submitRateLimitChallenge`, or any
  CAPTCHA or challenge submission with its own shell tool. It also does not run
  other `signal-cli` commands against the operator's data directory. For each
  such step it gives the exact command to the operator, who runs it in their own
  terminal and reports only whether it finished. The agent never asks the
  operator to paste a URI, QR code, code, token, or CAPTCHA back.
- **Identifiers are sensitive too.** Phone numbers, UUIDs, group IDs, device
  names, and message text are private. Filter command output to the fields you
  need (`jq` and `grep` in the examples) and do not paste raw listings.
- **Never run `signal-cli` against a data directory that a running bridge is
  using.** Stop the bridge first for every standalone command in this skill,
  except the JSON-RPC challenge route in "How the channel behaves".
- **Never point the bridge at `/tmp`** or any world-writable directory, even
  with the sticky bit set.
- **Never run `register`, `unregister`, `updateAccount`, or `removeDevice` on
  the operator's primary account** as part of personal mode.
- **Text only.** Signal attachments, stickers, voice notes, and video are not
  supported. Do not promise them.

## Pre-flight

Check whether a Signal channel already exists:

```bash
npx talonctl list-channels
```

If one exists, ask whether to add another instance or reconfigure it. Each
instance selects one account. Two instances that resolve to the same account
are both rejected at runtime (duplicate account ownership), so do not create a
second instance for an account that already has one.

## Step 1: Choose the account mode

Ask: **"Will this channel use your own Signal account (personal), or a
separate account dedicated to the agent (dedicated)?"**

| | Personal | Dedicated |
|---|---|---|
| Account | Your existing Signal account | A separate number or account the operator registers or links |
| How the bridge joins | Linked as an extra device on your account. Never re-registered | Registered or linked as its own account |
| Replies come from | Your Signal identity | The dedicated account's identity |
| Commands come from | Note to Self, plus selected chats and senders | Selected DM peers and groups, from authorized senders |
| Your own messages to the bot | Operator commands (Note to Self, selected chats) | Never commands. Sent and synced events from the dedicated account are ignored |
| `showToolCalls` | Must be `false` or omitted | May be `true` |

Talon itself needs no extra account. You do not create a Talon-specific Signal
identity, and you do not need both modes.

Privacy, before you choose personal mode:

- A linked personal client has account-wide access to your conversations
  before Talon's filters run. Talon only admits what the filters select.
- Admitted text enters Talon's SQLite history and memory, and goes to the
  configured model providers and observability. Plan for that retention.
- Disappearing and view-once messages are excluded in v1.

## Step 2: Install signal-cli 0.14.9 (operator)

**Supported platform.** The code supports POSIX hosts with Unix domain sockets and an
effective numeric UID. talond checks `process.geteuid` and the socket's UID and
mode (`src/channels/connectors/signal/signal-socket-trust.ts:39,48,61`). This
guide covers Linux with systemd-style `/run/user/<uid>` paths. macOS and Windows
are not covered. The bridge version is exactly 0.14.9. Live validation on your
target platform is still pending (Step 12).

Install the pinned version yourself from the upstream project
(https://github.com/AsamK/signal-cli, release v0.14.9). Talon does not install
it.

- Check the version:

  ```bash
  signal-cli --version
  ```

  The output must report 0.14.9. Talon also checks the bridge's own `version`
  reply on connect. Any other version, including `unknown`, a development build,
  another patch, or a newer minor, enters **Needs setup** with
  `UNSUPPORTED_VERSION`. There is no bypass. Do not use a moving "latest" build.
- **Java:** the JVM distribution requires JRE 25 (upstream README). If you use a
  native build instead, follow its own runtime requirements. Install the JRE
  only where it applies.
- Verify the download with the checksum published by the release you use.

Talon never reads the bridge's data directory or key material.

## Step 3: Create a private socket directory

The socket must be private to your user. Talon connects only if the path meets
these rules:

- The socket's parent directory is owned by the same numeric UID as talond and
  has mode `0700`.
- The socket is a Unix socket owned by that UID, with no group or other
  permission bits. Mode `0600` or `0700` is accepted. Any group or other bit is
  refused.
- Every ancestor up to `/` is owned by that UID or by root, with no group or
  world write permission.
- No component of the path is a symlink.

Talon checks these before every connection. It never creates, chmods, unlinks,
or replaces these paths. An unsafe path enters **Needs setup** with
`UNTRUSTED_SOCKET`.

Native example (uses your runtime directory, which is `/run/user/<uid>` on
systemd hosts):

```bash
SIGNAL_SOCKET_DIR="/run/user/$(id -u)/talon-signal"
SIGNAL_SOCKET="$SIGNAL_SOCKET_DIR/signal.sock"
install -d -m 0700 "$SIGNAL_SOCKET_DIR"
stat -c '%a %u %n' "$SIGNAL_SOCKET_DIR"        # expect: 700 <your uid> <path>
```

`/run/user/<uid>` exists only while that user has a login session. If the bridge
must run without a login, enable lingering once:
`sudo loginctl enable-linger <user>`.

Talon and the bridge must run as the same numeric UID. Root and other processes
running as talond's UID can already control its config and database, so they are
trusted.

The bridge creates the socket when it starts. Start it with `umask 077`. Under
that umask the socket comes out as `0700`. Talon accepts any owner-only mode
(`0600` or `0700`) and refuses a socket with any group or other bits. Do not
chmod the socket. Verify it in Step 6.

## Step 4: Link the bridge LAST (personal mode)

Stop the bridge first if it is running. It must not hold the data directory
while you link. Use one data directory for every command in this skill and for
the bridge itself:

```bash
SIGNAL_DATA="$HOME/.local/share/signal-cli"    # your chosen data dir; keep it identical everywhere
```

This directory holds the account's cryptographic state. Do not copy it, mount
it, or share its contents.

Talon requires the bridge device to be the most recently linked device on the
account, and it checks this by creation timestamp. Link every other device
first, then link the bridge:

```bash
signal-cli --data-dir "$SIGNAL_DATA" link -n talon-bridge
```

**Agent: do not run this command yourself. Give it to the operator to run in
their own terminal.**

- Do not pass `-a` to `link`. It must not be given for linking.
- The command prints a `sgnl://linkdevice?...` URI, and a QR code when run in a
  terminal. In the phone's Signal app, open **Settings > Linked devices > Link
  new device** and scan the code. The URI and QR code are linking credentials.
  Keep them in the operator's terminal only.
- On success the command prints `Associated with: <number>`. Then continue with
  Step 5.

**Dedicated mode** uses upstream's registration or linking flow, run by the
operator. Talon does not automate it. Choose one path:

- **Register a new number.** Usually the upstream registration requires a
  CAPTCHA. The pinned man page documents `--captcha` ("required if registration
  failed with a captcha required error"). Run these yourself:

  ```bash
  signal-cli --data-dir "$SIGNAL_DATA" -a "<NUMBER>" register [--captcha "<signalcaptcha://...>"]
  signal-cli --data-dir "$SIGNAL_DATA" -a "<NUMBER>" verify "<CODE>"
  ```

  **Agent: do not run these yourself. Give them to the operator.** Keep the
  verification code and the CAPTCHA link out of chat.
- **Link to an existing account on another phone.** The pinned man page
  documents `link` for attaching to an existing account "instead of registering
  a new number." It is the same command and the same QR flow as personal mode.

Either way, continue with Step 5 to capture the device metadata.

## Step 5: Stop the bridge and read the current device

Stop the bridge if it is running. The standalone commands below must run while
the bridge is stopped.

1. **Discover the account.** The JSON output includes both the phone number and
   the ACI. Plain output prints only one of them.

   ```bash
   signal-cli --data-dir "$SIGNAL_DATA" -o json listAccounts | jq '.[] | {number, aci}'
   ```

   Record `aci` (the account UUID). Record `number` if the account has one.

2. **Read the current-device marker** (plain output only). The marker is printed
   only in plain-text mode. The JSON output does not carry it:

   ```bash
   signal-cli --data-dir "$SIGNAL_DATA" -a "<ACCOUNT>" listDevices | grep '(this device)'
   ```

   Expect one line such as `- Device <id> (this device):`. Record that integer
   as `deviceId`.

3. **Read the creation timestamp** for that same device ID from the JSON output:

   ```bash
   signal-cli --data-dir "$SIGNAL_DATA" -o json -a "<ACCOUNT>" listDevices \
     | jq '.[] | select(.id == <deviceId>) | .createdTimestamp'
   ```

   Record it as `deviceCreatedTimestamp`. It must be a nonzero integer. The
   `name` and `lastSeenTimestamp` fields are not used.

Personal mode requires a linked device, not primary device 1. If the marked
device is `1`, stop: you are looking at the primary device, so the bridge has
not been linked yet. Go back to Step 4.

Newest-device check (personal mode): the bridge's `createdTimestamp` must be
strictly newer than every other non-primary linked device's. Run this projection
and compare the values:

   ```bash
   signal-cli --data-dir "$SIGNAL_DATA" -o json -a "<ACCOUNT>" listDevices \
     | jq '.[] | {id, createdTimestamp}'
   ```

If another device is newer, relink the bridge as described in "Newest-device
rule" below.

Dedicated mode: record `deviceId` the same way. `deviceCreatedTimestamp` is
optional. If you supply it, Talon checks that it matches.

**Newest-device rule.** Talon fails closed unless:

- the configured device's creation timestamp exactly matches
  `deviceCreatedTimestamp`;
- every other non-primary linked device has a known, nonzero creation timestamp
  strictly earlier than the bridge's; and
- the bridge device is still present.

A tie, an unknown timestamp, or a newer device enters **Needs setup** with
`DEVICE_METADATA_INVALID`. The usual cause is that you linked another device
after the bridge, including linking your phone again. The fix: stop the bridge,
remove the old bridge entry from your phone's Linked devices list, link the
bridge again (Step 4) so it is the newest device, and capture the metadata again
here.

## Step 6: Start the bridge (operator-supervised)

Run the bridge as a long-lived process under your own supervisor (for example a
user systemd unit). Talon does not provide or manage the unit.

```bash
umask 077
signal-cli --data-dir "$SIGNAL_DATA" daemon \
  --socket="$SIGNAL_SOCKET" \
  --receive-mode=manual \
  --ignore-attachments --ignore-stories --ignore-avatars --ignore-stickers \
  --no-receive-stdout
```

What each part does:

- **No `-a`.** Talon requires multi-account daemon mode. A bridge that does not
  expose `listAccounts` enters **Needs setup** with `UNSUPPORTED_BRIDGE_MODE`.
- **`--receive-mode=manual`.** Talon subscribes to receive messages for its
  account. Do not let the bridge auto-receive.
- **`--ignore-attachments --ignore-stories --ignore-avatars --ignore-stickers`.**
  Text-only. The bridge does not download attachments, and Talon never
  retrieves attachment bytes.
- **`--no-receive-stdout`.** Received messages are not printed to the bridge's
  stdout, so they do not land in your service logs.
- Do not add `--send-read-receipts`. Talon does not use read receipts.

If a stale socket file from a previous run is left in place, the bridge may fail
to bind. Pinned `DaemonCommand.java:179-183` binds the socket path directly, so
remove the stale file yourself. Talon never removes it.

Verify the parent directory and the socket before you configure Talon:

```bash
stat -c '%a %U %n' "$SIGNAL_SOCKET_DIR"        # expect: 700 <your user> <path>
stat -c '%a %U %n' "$SIGNAL_SOCKET"            # expect: 700 or 600 <your user> <path>
```

The socket mode must be `700` or `600`, with no group or other bits. Anything
else is refused as `UNTRUSTED_SOCKET`.

## Step 7: Collect the account, peers, and groups

Gather these values. Stop the bridge before the standalone queries below, then
start it again afterwards. Alternatively, run the equivalent JSON-RPC calls over
the socket once the bridge is up.

- **`account`**: the selector. Use the E.164 phone number (`+` and digits) or
  the ACI. The ACI is the authority. A phone number that no longer matches is
  treated as a stale hint as long as the pinned ACI still exists. A selector
  that resolves to a different ACI enters **Needs setup** with
  `ACCOUNT_MISMATCH`. Using the ACI avoids depending on a phone number that
  may change.
- **`accountUuid`**: the ACI from Step 5 (`aci`). It is normalized to lowercase.
  Hidden phone numbers are supported.
- **`deviceId`** and **`deviceCreatedTimestamp`**: from Step 5.
- **`allowedDmPeers`**: canonical peer UUIDs (ACIs) of people whose direct
  messages may trigger the bot. Get them from your contacts. Choose the peer by
  name locally, and keep only the UUID:

  ```bash
  signal-cli --data-dir "$SIGNAL_DATA" -a "<ACCOUNT>" -o json listContacts --all-recipients \
    | jq -r '.[] | select(.isBlocked == false and .uuid != null) | "\(.uuid)  \(.name // .number // "-")"'
  ```

  Verify each entry is a UUID with the 8-4-4-4-12 layout. Do not use phone
  numbers, display names, usernames, or PNI values in config.
- **`allowedGroups`**: group IDs in strict padded standard Base64, as listed by
  `listGroups` (`id`). Get them with:

  ```bash
  signal-cli --data-dir "$SIGNAL_DATA" -a "<ACCOUNT>" -o json listGroups \
    | jq -r '.[] | select(.isMember == true) | "\(.id)  \(.name)"'
  ```

  The name is printed only so you can tell groups apart. Do not put it in
  config. Talon authorizes by ID, not by name. URL-safe Base64, missing padding,
  or whitespace is rejected at load.
- **`allowedSenders`**: the canonical UUIDs of individuals who may send commands
  in selected DMs and groups. In a group, the sender is the individual
  participant, not the group.

Lists default to empty. An empty `allowedDmPeers` or `allowedGroups` means
ordinary chats are denied. An empty `allowedSenders` denies everyone except the
operator's own messages in personal mode.

Note: a DM is selected by `allowedDmPeers`, and the peer must also be in
`allowedSenders`. A group needs `allowedGroups`, and the participant must be in
`allowedSenders`.

Ask about **`triggerPrefix`** (default `!talon`). It must be nonempty and
case-sensitive. In selected DMs and groups, leading whitespace is ignored. The
prefix must start the text and be followed by whitespace or the end of the
text. `!talonx` does not match `!talon`. The prefix and any following whitespace
are removed. An empty remaining command does nothing.

Activation rules, for the operator:

| Message | Activates when |
|---|---|
| Your Note to Self, personal mode | Any nonempty text. No prefix needed. Text is kept as written |
| Your message in a selected DM or group, personal mode | The trigger, with a nonempty command |
| Message from a selected peer or participant, either mode | The trigger, with a nonempty command, and the sender is in `allowedSenders` |
| Anything else (unselected chat, unknown or unauthorized sender, another account, the bot's own replies or echoes, receipts, typing, reactions, edits, deletions, stories, calls, attachment-only messages, disappearing or view-once messages) | Never |

Replies are not commands. Talon's own sends are recognized by the bridge
device's provenance, not by their text. A reply that happens to contain
`!talon` does not start another turn.

Timeouts and reconnects have defaults. Keep them unless you have a reason:

- `requestTimeoutMs`: default 30000 (1000 to 120000)
- `reconnectBaseMs`: default 1000 (100 to 60000)
- `reconnectMaxMs`: default 60000 (100 to 300000, and at least `reconnectBaseMs`)

## Step 8: Choose the persona and capabilities

```bash
npx talonctl list-personas
```

Ask which persona should answer on this channel. Different Signal instances
can use different personas. The binding routes messages. It does not authorize
them. The allowlists in Step 7 are the authorization.

```bash
npx talonctl bind --persona <persona> --channel <channel-name>
npx talonctl set-capabilities --persona <persona> --show
```

If the persona should send to other channels, that requires `channel.send:*`.
Ask before adding it.

## Step 9: Add the channel

Build the JSON from your answers. The placeholder values show the shape only.
Replace every value with yours:

Personal:

```json
{"accountMode":"personal","socketPath":"/run/user/1000/talon-signal/signal.sock","account":"+15555550123","accountUuid":"11111111-1111-4111-8111-111111111111","deviceId":2,"deviceCreatedTimestamp":1700000000000,"allowedDmPeers":[],"allowedSenders":[],"allowedGroups":[],"triggerPrefix":"!talon"}
```

Dedicated:

```json
{"accountMode":"dedicated","socketPath":"/run/user/1000/talon-signal/signal.sock","account":"11111111-1111-4111-8111-111111111111","accountUuid":"11111111-1111-4111-8111-111111111111","deviceId":1,"allowedDmPeers":[],"allowedSenders":[],"allowedGroups":[],"triggerPrefix":"!talon"}
```

Then add it:

```bash
npx talonctl add-channel --name <name> --type signal --signal-config '<json>' --show-tool-calls false
```

- `--show-tool-calls` is optional. Personal mode rejects `true`. Use `false` or
  omit it.
- The command validates the same schema the daemon uses. It does not contact
  the bridge. The output says runtime verification is still required.
- Command-line arguments are visible to other local users while the command
  runs, and the JSON is saved in your shell history. The JSON contains no
  secrets, but it does contain your identifiers. On a shared machine, add the
  entry to `talond.yaml` directly with the same keys, then validate it with
  `npx talonctl doctor`.
- An invalid Signal entry fails the whole configuration, not just that entry.
  `loadConfig` validates every channel against the schema and returns a
  `Configuration validation failed` error that names the path
  (`src/core/config/config-loader.ts:157-166`). Daemon startup stops, and reload
  is refused before anything is applied (`src/daemon/daemon.ts:378-385`). Fix the
  entry and retry.

The resulting YAML looks like this:

```yaml
channels:
  - name: my-signal
    type: signal
    showToolCalls: false          # personal mode: false or omitted
    config:
      accountMode: personal       # personal | dedicated
      socketPath: /run/user/1000/talon-signal/signal.sock
      account: '+15555550123'     # E.164 selector or ACI
      accountUuid: '11111111-1111-4111-8111-111111111111'
      deviceId: 2                 # personal: a linked device, never 1
      deviceCreatedTimestamp: 1700000000000   # personal: required; dedicated: optional
      allowedDmPeers: []          # peer ACIs
      allowedSenders: []          # sender ACIs
      allowedGroups: []           # padded standard Base64 group IDs
      triggerPrefix: '!talon'
      requestTimeoutMs: 30000     # 1000-120000
      reconnectBaseMs: 1000       # 100-60000
      reconnectMaxMs: 60000       # 100-300000, >= reconnectBaseMs
```

## Step 10: Apply and check status

Apply the change and read the Signal status:

```bash
npx talonctl reload
npx talonctl status
```

`status` prints one `Signal` block when a Signal channel is configured or
delivery work is saved. For each channel it shows:

- `receive=<state>`: `stopped`, `reconnecting`, `ready`, or `needs_setup`
- `reason=`: why it is not ready, if it is not
- `outbound=`: whether sends are suspended
- `verification=` and `draining=` / `persistence-blocked=`
- `held` and `dropped` counts for proof, receipt, and alias buffers
- saved delivery counts: `pending` and `terminal`, with reasons

Reasons and what to do:

| Reason | Meaning | Operator action |
|---|---|---|
| `UNSUPPORTED_VERSION` | Bridge is not exactly 0.14.9 | Install 0.14.9 (Step 2) |
| `UNSUPPORTED_BRIDGE_MODE` | Bridge lacks multi-account `listAccounts` | Start the bridge without `-a` (Step 6) |
| `UNTRUSTED_SOCKET` | Path, ownership, mode, or symlink check failed | Fix the directory and socket permissions (Step 3). Talon will not repair them |
| `ACCOUNT_MISMATCH` | Selector resolves to another ACI, or the account is missing or ambiguous | Correct `account` or `accountUuid` (Step 7) |
| `DEVICE_METADATA_INVALID` | Device missing, timestamp mismatch, or a newer device is linked | Relink the bridge last and capture the metadata again (Steps 4 and 5) |
| `VERIFICATION_PENDING` | Verification has not succeeded yet, or a transient error occurred | Wait. Check that the bridge is up and reachable |
| `VERIFICATION_STALE` | Device proof expired while refresh is unavailable | Sends are deferred. Receiving continues. Restore bridge reachability |
| `PROTOCOL_FAILURE_LOOP` | Three framing failures within five minutes | Check the bridge's version and logs |
| `DISCONNECTED` | Socket lost or not present | Start the bridge. Talon retries with capped backoff |

Duplicate ownership: if two instances resolve to the same account, the daemon
logs `duplicate Signal account ownership` and rejects each instance that shares
the account. Other accounts keep working.

## Step 11: Validate with fakes (now)

This checks the packaged build and the repo's Signal fake gate. It does not
contact Signal. It needs a checkout of this repository, because the scripts are
in the repo. Docker starter users without a checkout skip this step.

```bash
npm run build
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
bash .agents/skills/run-talon-smoke/scripts/verify-signal-deliverable.sh --no-build
```

- The `fake` smoke boots talond with a fake provider and round-trips a terminal
  message. It proves the daemon starts and the terminal channel works. It does
  not exercise the Signal bridge.
- `verify-signal-deliverable.sh` is the repo's Signal fake gate. It runs the
  Signal fake-bridge checks against a fake bridge, and it runs
  `node dist/cli/index.js --help` first. Use `npm run build && bash
  .agents/skills/run-talon-smoke/scripts/verify-signal-deliverable.sh --no-build`
  to run both checks in order.

Fake checks never count as proof of real-device behavior.

## Step 12: Live validation (separate, not performed)

Live validation needs a real account, a real linked device, and your phone. It is
a separate step, and it has not been run for this channel. Do not describe the
channel as verified on a real account until it has been done. When you do it:

- Use a disposable account or a disposable chat, and a fake provider persona.
- Exercise both account modes. In personal mode, exercise Note to Self and a
  selected chat. Exercise a DM and a group. Check the trigger and sender
  exclusions. Check that replies do not loop.
- Check reconnects and restarts. Check that the bridge link persists.
- Record only the bridge version, platform, account mode, scenario, and result
  order. Remove numbers, UUIDs, group IDs, names, message bodies, link URIs,
  tokens, and raw stderr from any evidence.

## How the channel behaves

Read these before you rely on the channel.

- **Pauses while proof is stale.** Sends wait until the device roster is
  re-verified. Receiving continues. Personal-mode messages that depend on a
  fresh device proof are held for up to 10 minutes from receipt, with at most 64
  held messages and 1 MiB. Overflow drops the newest held message. Expiry drops
  the held message. `talonctl status` shows held and dropped counts. Resend any
  expired command yourself after recovery.
- **Pre-acceptance loss boundary.** Talon retries local acceptance (transcript
  plus queue item) for up to 5 minutes, with a 64-event and 1 MiB buffer. A
  crash, a stop, an overflow, or an expired retry before acceptance can lose
  that input. Talon does not claim upstream replay. Once a message is accepted
  into the durable queue, normal Talon restart and retry behavior applies.
- **Destination leases.** A multi-chunk reply holds that chat's destination
  lease until every chunk is accepted or the delivery ends. Other replies to
  the same chat wait. Other chats keep moving.
- **Operating numbers.** These come from the code:
  - A device proof lasts 5 minutes (`src/channels/connectors/signal/signal-device-registry.ts:75`).
    Roster checks run at most once per account per 60 seconds
    (`signal-device-registry.ts:130`), and the regular refresh interval is also
    60 seconds (`src/channels/connectors/signal/signal-account-verifier.ts:242`).
    If refresh stays unavailable past the proof lifetime, sends defer as
    `VERIFICATION_STALE`.
  - Chunks start at most once per second per account
    (`src/channels/connectors/signal/signal-send-coordinator.ts:523`).
  - Waiting sends are capped at 64 waiters and 1 MiB of waiting text
    (`signal-send-coordinator.ts:389-390`). Each waits at most 30 seconds
    (`signal-send-coordinator.ts:418`). Expiry or capacity is a transient
    `NOT_SENT`, and a saved reply stays queued.
  - On stop or reload, the active send drains for up to 30 seconds
    (`signal-send-coordinator.ts:335,341`). At the limit that delivery is
    marked `UNKNOWN`.
  - After an `UNKNOWN` outcome, an automatic 60-second recovery fence applies
    (`src/channels/connectors/signal/signal-send-result.ts:121-127`). The fence
    clears by time and needs no `signal-resume`. Only challenge pauses need
    `signal-resume`. A rate pause lasts at least 15 minutes
    (`signal-send-result.ts:65`) and also clears by time.
- **Rate limits.** A rate limit pauses the account for at least 15 minutes, or
  longer if the server asks for more. The pause survives restarts. Talon
  reports the reason in `status`.
- **Challenges.** A challenge pauses sends until you resolve it outside Talon
  and assert that you did. Follow these steps in order:

  1. **Get the challenge token from a send you run yourself.** Talon does not
     keep the token, and it never appears in Talon's logs. Signal returns it only
     when a send is challenged. The operator runs one short test send to their own
     Note to Self, in their own terminal, and reads the token from that output.
     Do not repeat the send to retry, because each attempt is another send. If the
     send returns no token, no challenge was returned for that send. A challenge
     may apply only to sends to other recipients. Choose one:
     - **Standalone CLI, bridge stopped** (same data directory):

       ```bash
       signal-cli --data-dir "$SIGNAL_DATA" -a "<ACCOUNT>" send --note-to-self -m "challenge check"
       ```

       When challenged, the plain output contains `CAPTCHA proof required ... with
       challenge token "<TOKEN>"` (`src/main/java/org/asamk/signal/util/SendMessageResultUtils.java:92-96`).
     - **JSON-RPC on the running bridge**, for example with `socat` or `nc -U`.
       The request shape comes from the pinned JSON-RPC man page: method `send`,
       with params `account` and `noteToSelf`. The `noteToSelf` name is derived
       from the camelCase rule for the CLI flag `--note-to-self`
       (`man/signal-cli-jsonrpc.5.adoc:92-95`):

       ```bash
       printf '%s\n' '{"jsonrpc":"2.0","id":"chk","method":"send","params":{"account":"<ACI>","noteToSelf":true,"message":"challenge check"}}' \
         | socat - "UNIX-CONNECT:$SIGNAL_SOCKET" \
         | jq -r 'select(.id == "chk") | .error.data.response.results[]? | select(.token != null) | .token'
       ```

       When challenged, the error envelope is code -1 ("Failed to send message"),
       and `error.data.response.results[]` carries a non-null `token`
       (`src/main/java/org/asamk/signal/json/JsonSendMessageResult.java:38`,
       `src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcCommandHandler.java:289-290`,
       and the `UserErrorException` mapping at `:251`). Identify the result by
       its non-null `token`, not by `type`. A proof-required result reports
       `IDENTITY_FAILURE`, because the JSON enum has no proof value
       (`JsonSendMessageResult.java:26-37`).

     Print the token only into your own terminal. Never paste it into chat, a
     ticket, or logs. **This flow is not live-verified.** It has not been run
     against a challenged account. The pinned sources do not establish whether a
     second client can connect to the bridge socket while Talon holds its
     connection. Test it in live validation (Step 12).

     **Agent: do not run step 1 yourself. Give it to the operator.**
  2. **Solve the CAPTCHA** at https://signalcaptchas.org/challenge/generate.html.
     After solving it, right-click the "Open Signal" link and copy it. It starts
     with `signalcaptcha://`.
  3. **Submit the challenge.** Two forms, both from the pinned man page
     (`man/signal-cli.1.adoc:1168-1178`):
     - Via JSON-RPC against the running bridge. The pinned JSON-RPC man page
       says the commands available in JSON-RPC mode are the same as the CLI
       commands, except `register`, `verify`, and `link`
       (`man/signal-cli-jsonrpc.5.adoc:92`). The method is
       `submitRateLimitChallenge` with camelCase params `account`, `challenge`,
       and `captcha`. This form does not require stopping the bridge.
     - Via the standalone CLI, with the bridge stopped:

       ```bash
       signal-cli --data-dir "$SIGNAL_DATA" -a "<ACCOUNT>" submitRateLimitChallenge \
         --challenge <TOKEN> --captcha <signalcaptcha://...>
       ```

       The pinned sources do not document the standalone form while a daemon
       holds the data directory. Stop the bridge first, following the rule in the
       Safety rules.

     **Agent: do not run step 3 yourself. Give it to the operator.**
  4. **Clear the pause.** Run this in your terminal:

     ```bash
     npx talonctl signal-resume --channel <name> --external-challenge-resolved
     ```

     The command only verifies the account and device and clears the challenge
     pause. It sends nothing and replays nothing. It refuses if another Needs setup
     reason or an unexpired rate delay is still in force. If verification fails,
     the pause stays. Talon does not store the challenge token.
- **No replays.** After an unknown or partial outcome, Talon never resends that
  delivery. It never reruns the provider turn to resend a reply. A saved reply
  resumes only from a chunk that is proven not to have been written. Inspect the
  status and send a new explicit command if you still want the message.
- **Success means acceptance.** Bridge acceptance does not prove that the
  recipient read or received the message.
- **Text only, no attachments.** Long replies are split into ordered text
  messages at Unicode-safe boundaries, at most 2000 UTF-8 bytes per message. Long
  text is never sent as an attachment, and never silently truncated. An outbound
  payload with attachments is refused before anything is sent.
- **Retention.** Admitted text is stored in Talon's SQLite history and memory.
  Saved reply text and cursors are stored in the queue until you purge them.
  Purge is your decision:

  ```bash
  npx talonctl queue-purge                        # defaults: pending, failed, completed
  npx talonctl queue-purge --statuses <list>      # e.g. pending,failed
  npx talonctl queue-purge --all                  # every status, including in-flight
  ```

  A purge cancels the linked pending and running runs and removes the selected
  saved deliveries. It does not unsend anything. A chunk already handed to the
  bridge may still arrive.
- **Stale phone numbers.** If your phone number changes, Talon keeps working
  through the pinned ACI, and it does not learn aliases from other accounts.
  Update `account` when convenient, but `accountUuid` is the authority.
- **Duplicate and changed accounts.** Duplicate ownership is rejected at
  runtime. Destinations from an old account are never sent through a
  replacement account on the same instance.
- **Reloads.** A reload stops and restarts the Signal connectors. If a stop
  keeps failing, the reload stays pending and the claims stay quiesced while
  Talon retries automatically. Bootstrap fails closed after a bounded number of
  recovery attempts, so the next start retries.

## Docker bundle variant

Use this when Talon runs from the starter bundle. The bridge stays on the host.
The container only connects to the socket. Docker starter users run the
bridge-side steps (Steps 2 through 6) on the host, and the container needs no
checkout of this repository.

1. Run the bridge as the same numeric UID as the container's `talond` user. The
   image uses UID 1000. Check it:

   ```bash
   docker exec talond id -u                       # expect: 1000
   ```

   If the host uses rootless Docker or user-namespace remapping, the numeric
   UIDs differ. Adapt the host layout to the UID that the container sees. Do not
   widen permissions.

2. Create the private directory on the host and start the bridge there (Steps
   3 and 6), with `SIGNAL_SOCKET_DIR` set to that host path, for example
   `/run/user/1000/talon-signal`. Start the bridge with `umask 077`, which gives
   a `0700` socket. Talon accepts `0700` or `0600` and refuses any group or other
   bits.

3. Mount only that directory into the container. Add this to the `talond`
   service's `volumes` in `docker-compose.yaml`:

   ```yaml
       volumes:
         # ...existing volumes...
         - type: bind
           source: /run/user/1000/talon-signal
           target: /run/talon-signal
   ```

   Mount the directory, not the signal-cli data directory. Do not mount the key
   directory, `~/.local/share/signal-cli`, a container-runtime socket, or any
   other host path for Signal. A directory mount keeps working when the bridge
   restarts and recreates the socket. A single-file mount would not.

4. Point the channel at the container path. The config uses the in-container
   path, so set `socketPath: /run/talon-signal/signal.sock`. The
   `--signal-config` JSON in Step 9 uses the same path.

5. Recreate the container so the new mount takes effect:

   ```bash
   docker compose up -d talond
   ```

   A restart alone does not apply new mounts.

6. Verify inside the container. The directory should be `700` and the socket
   `700` or `600`, both owned by UID 1000:

   ```bash
   docker exec talond stat -c '%a %u %n' /run/talon-signal /run/talon-signal/signal.sock
   # expect: 700 1000 /run/talon-signal
   #         700 1000 /run/talon-signal/signal.sock   (or 600; any group/other bit is refused)
   ```

7. Run the rest of the steps through the wrapper: `talonctl status`,
   `talonctl reload`, and `talonctl signal-resume --channel <name>
   --external-challenge-resolved`. The challenge steps in "How the channel
   behaves" are operator-only. Run them on the host or in the operator's own
   terminal, never through the agent.

The container gets no signal-cli authority. Do not install signal-cli in the
image, do not give it the key directory, and do not run `signal-cli` from inside
it. The bridge's JRE, signal-cli, and supervision all stay on the host.

Read-only mounts are not recommended in this skill. Connecting to a socket on a
read-only bind mount is not verified by a live test. Use the read-write
directory mount above.

## Troubleshooting

| Problem | Fix |
|---|---|
| `UNSUPPORTED_VERSION` | Bridge is not 0.14.9. Install the pinned version. Do not use "latest" |
| `UNSUPPORTED_BRIDGE_MODE` | Bridge started with `-a`. Start it without `-a` |
| `UNTRUSTED_SOCKET` | The socket or its parent has group or other bits, the wrong owner, a symlink, or an ancestor that is group- or world-writable. Make the parent `700` and owned by your user, and start the bridge with `umask 077` so the socket is `0700`. Do not chmod the socket |
| Socket not found | Bridge not running, or started with a different `--socket` path |
| Bridge fails to start with a socket present | A stale socket file from a previous run is in the way. Remove it yourself. Talon never removes it |
| `ACCOUNT_MISMATCH` | Selector and `accountUuid` do not match the account. Re-run `listAccounts` |
| `DEVICE_METADATA_INVALID` after linking a device | The bridge is no longer the newest device. Relink it last and capture the metadata again |
| `signal-resume` refused | Check that `--external-challenge-resolved` is present. Check for another Needs setup reason or an unexpired rate delay. Check that the challenge step was done |
| Commands ignored in a selected chat | Check the trigger spelling and case, the allowlists, and that the sender is listed |
| Note to Self ignored | Check personal mode, that the message is nonempty text, and that the bridge is Ready |
| Replies look duplicated | Check `status` for pending or terminal saved deliveries before you send again |

## Config Reference

```yaml
channels:
  - name: my-signal
    type: signal
    showToolCalls: false          # optional; personal mode rejects true
    config:
      accountMode: personal       # required: personal | dedicated
      socketPath: /run/user/1000/talon-signal/signal.sock   # required, absolute
      account: '+15555550123'     # required: E.164 selector or ACI
      accountUuid: '11111111-1111-4111-8111-111111111111'   # required ACI
      deviceId: 2                 # required positive integer
      deviceCreatedTimestamp: 1700000000000   # personal: required; dedicated: optional
      allowedDmPeers: []          # optional peer ACIs (default empty)
      allowedSenders: []          # optional sender ACIs (default empty)
      allowedGroups: []           # optional padded standard Base64 group IDs
      triggerPrefix: '!talon'     # optional, nonempty (default !talon)
      requestTimeoutMs: 30000     # optional, 1000-120000
      reconnectBaseMs: 1000       # optional, 100-60000
      reconnectMaxMs: 60000       # optional, 100-300000, >= reconnectBaseMs
```
