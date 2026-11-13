# Spec: Signal channel

## Goal

Add Signal as a named Talon channel for text conversations in DMs and groups.
Operators can link their existing personal Signal account or provision a
dedicated agent account. Personal-account mode accepts commands in Note to Self
and selected chats, while agent replies never activate another turn. Talon uses
an externally supervised signal-cli service and retains its existing persona,
capability, queue, and scheduled-delivery model.

## In scope

**Account modes, transport, and setup**

- Add channel type `signal` with independently named instances. Each instance
  selects one Signal account and declares `personal` or `dedicated` mode.
  Different accounts can use different personas and authorization policies.
- In personal mode, setup links signal-cli as an additional device on the
  existing account. It never registers that account again or replaces its
  primary client. Replies use the operator's Signal identity.
- In dedicated mode, setup supports a separately registered or linked account;
  replies use that account's identity. The dedicated identity is an operator
  choice, not a prerequisite for the channel.
- The proposed v1 transport is direct signal-cli JSON-RPC over a local Unix
  socket. The operator supervises the service and owns its persistent account
  state. Talon connects to it; talond does not install or launch signal-cli,
  register accounts, or receive container-management authority.
- Guided setup covers prerequisites, personal-device linking, dedicated-account
  provisioning, socket permissions, persistent state, account identification,
  chat/sender selection, persona binding, reconnects, and relinking. QR links and
  verification secrets are displayed only in the operator's setup flow, never
  in agent context or ordinary logs.
- Native setup is the baseline. Docker setup documents how a separately
  supervised bridge exposes a permission-restricted socket to talond. This
  scope does not ship another maintained Signal container image or an HTTP
  wrapper. Supported signal-cli version and platform prerequisites are recorded
  from the contract verification, not inferred from a moving latest tag.

**Authorization, selection, and activation**

- Configuration includes account selection, account mode, socket path, allowed
  DM peers, allowed groups, allowed senders, and a nonempty trigger prefix.
  Chat/sender lists default empty. Phone numbers and display names are not
  authorization keys: use canonical account UUIDs and canonical group IDs.
- Note to Self is available in personal mode for operator-authored messages.
  The operator is authorized as self. In other chats, personal-mode
  operator-authored commands still require explicit chat selection; other
  senders require explicit authorization. Dedicated-account self/sent events
  never become operator commands.
- The proposed default prefix is `!talon`, configurable per instance. In
  selected DMs/groups, ignore leading whitespace, require a case-sensitive
  prefix at the start followed by whitespace or end of text, remove that prefix
  and following whitespace, and ignore an empty remaining command. `!talonx`
  does not match `!talon`. Note to Self requires no prefix and preserves its
  message text. Empty or whitespace-only messages never start a turn.
- Apply the following table before ordinary message persistence or enqueueing.
  A channel/persona binding routes admitted messages; it is not authorization.

| Message | Selection and authorization | Activation |
| --- | --- | --- |
| Operator-authored Note to Self text in personal mode | Local account identity verified | Every nonempty text message |
| Operator-authored text in a personal-mode DM/group | DM peer or group explicitly selected | Explicit trigger with a nonempty command |
| Incoming DM text in either mode | Peer selected and sender authorized | Explicit trigger with a nonempty command |
| Incoming group text in either mode | Group selected and participant authorized | Explicit trigger with a nonempty command |
| Agent-authored message, including a synchronized echo | Any chat or account mode | Ignore, even if its text contains the trigger |
| Unselected chat, unauthorized/unknown sender, or wrong account | Any text | Ignore |
| Receipt, typing, reaction, group/profile/timer update, story, call, edit, or deletion event | Any chat | Ignore; no new turn or transcript modification |
| Attachment-only message | Any chat | Ignore |
| Attachment with ordinary accompanying text | Apply the text's selection/authorization rules | Evaluate the text only; ignore attachment bytes |
| Disappearing or view-once message | Any chat | Exclude in v1 before text persistence |

**Identity, conversation routing, and reply-loop prevention**

- Stable conversation keys distinguish Note to Self, DM peer, and group and
  include the selected account's canonical identity. Group identity comes from
  the group ID, not its name or most recent participant. Group sender identity
  remains the individual participant. Hidden phone numbers remain supported.
- Deduplication uses original message identity from the Signal contract, scoped
  by connector/account and conversation. Replayed copies and alternate
  representations of the same self-sent message produce one admitted turn.
  Local receive time and display names are not deduplication identities.
- Personal mode consumes the sent synchronization needed for operator-authored
  Note to Self and selected-chat commands. It distinguishes those commands from
  Talon's own sends using verified message/device provenance. Blanket rejection
  of every self-sent event is not an implementation of personal mode.
- Own-send filtering covers normal replies, `channel_send`, broadcasts, chunked
  replies, echoes arriving before an RPC response, and replay after restart.
  Persisted provenance or verified device identity survives the relevant
  restart cases. Message text alone is not an echo filter.
- An event whose account or authorship cannot be verified is not admitted; emit
  a diagnostic with its reason and no message body. Personal mode cannot be
  declared complete until real linked-device fixtures prove both entry points
  and own-send suppression.
- Replies return to the originating Note to Self, DM, or group. Explicit
  scheduled sends and broadcasts reuse Talon's capability and binding checks.
  A queued destination tied to an old account cannot be sent through a newly
  selected account on the same named instance.

**Text delivery and attachments**

- Send text replies with Unicode preserved. Long replies are split into ordered
  messages at Unicode-safe boundaries within the verified bridge limit; text
  is never silently truncated. Success means bridge acceptance, not proof that
  every recipient read or received the message.
- Evaluate JSON-RPC errors and per-recipient send results. Partial group or
  chunk delivery is reported as an error with diagnostic status; it is never
  reported as complete success. Timeouts after possible bridge acceptance have
  an explicit unknown-outcome error and are not blindly retried by the
  connector. Existing queue/provider retry boundaries are documented.
- No inbound or outbound attachment support is added. Configure the bridge to
  skip attachment downloads; Talon never calls attachment retrieval or passes
  media bytes to providers. An outbound payload containing attachments returns
  an unsupported-attachment error before sending any part of that payload.
- Cross-channel attachment work remains a separate change. Signal neither
  depends on its completion nor introduces another attachment-processing path.

**Lifecycle and durable handoff**

| Connector state | Event | Result |
| --- | --- | --- |
| Stopped | Start | Connect and verify selected account/protocol; become Ready or fail with a diagnostic |
| Ready | Transient socket loss | Become Reconnecting; clear stale subscription and outstanding RPCs |
| Reconnecting | Bridge becomes reachable | Verify account again and establish one subscription; become Ready |
| Reconnecting | Bridge remains unavailable | Retry with capped backoff; do not block unrelated connectors |
| Ready/Reconnecting | Verified unlink or unusable configured account | Become Needs setup; stop automatic work for that account and report recovery instructions |
| Needs setup | Operator repairs setup and restarts/reloads | Connect and verify again |
| Any active state | Stop or replacement on reload | Become Stopped; cancel subscriptions, pending requests, and reconnect timers |
| Stopped or Needs setup | Send request | Return an explicit unavailable/setup error |

- Request timeouts and reconnect delays are bounded and configuration-validated.
  Startup, repeated start/stop, and reload never leave duplicate receive
  listeners. No reconnect occurs after an instance has stopped.
- Each account has one Talon receive owner. Two named instances resolving to the
  same account are rejected rather than racing to consume it. Setup prevents a
  competing scheduled/polling receiver from silently draining messages.
- For an admitted message with a valid persona binding, successful local
  acceptance requires both its transcript and durable queue item. A failure
  between message insertion and enqueueing remains retryable; deduplication
  cannot permanently discard the turn on replay. Include the narrow shared
  pipeline changes and failure tests required to meet this condition.
- Once accepted into the durable queue, Talon's existing restart/retry behavior
  applies. No end-to-end no-loss or exactly-once claim is made for events the
  external bridge consumed before durable local acceptance. Socket reconnect
  does not manufacture a durable upstream replay log. Diagnostics and setup
  documentation state that boundary.

**Privacy, integration, and verification**

- Signal encryption ends at the local client. Setup explains that admitted text
  enters Talon's ordinary SQLite history, memory, configured model providers,
  and configured observability. A personal linked client has account-wide
  access before Talon's ingestion filters. Disappearing/view-once content is
  excluded because this scope adds no matching history/provider deletion policy.
- Bridge cryptographic state, provisioning tokens, verification secrets, and
  attachment bytes do not enter agent prompts or application logs. Connector
  diagnostics use structured logging, and sends/setup side effects use existing
  audit conventions.
- Integrate config validation, channel construction/registry, CLI add-channel,
  persona bindings, generic channel capabilities/tools, and startup diagnostics.
  Expected failures use the repository's typed Result/error conventions.
- Update README, example config, AGENTS architecture guidance, native/Docker
  setup skills, and a new add-signal skill. Update distributed starter guidance
  and its skill synchronization where those entry points describe the channel.
- Verification includes focused contract/connector/config/CLI/pipeline/tool
  tests, build and existing no-cost daemon startup smoke, and a real-device
  Signal smoke with a no-cost fake provider. Live evidence identifies bridge
  version, deployment target, account mode and exercised scenarios, excluding
  credentials and private message bodies. Missing live account access is a
  reported verification limitation; fixture tests are not labeled live proof.

## Out of scope

- Signal attachments, image inspection, file processing, voice messages,
  transcription, stickers, video, and changes to other channels' media paths.
- Implementing Signal's cryptographic/client protocol, an official bot API,
  hosting Signal, or maintaining a new signal-cli distribution/container image.
- HTTP/SSE, REST wrappers, D-Bus, remote bridge access, and multiple selectable
  bridge transports in v1.
- talond-managed account registration, CAPTCHA solving, phone provisioning,
  bridge installation/supervision, or container-engine access.
- Group creation, membership/admin management, contact synchronization UI,
  Signal-native mentions/buttons, reactions, edits/deletes, and receipt tracking.
- Automatic ingestion of every personal-account conversation, prefix-free
  activation outside Note to Self, or bypassing persona/capability checks.
- Disappearing/view-once conversations, coordinated deletion from provider
  records, historical-chat import, and long text represented only as an
  attachment rather than an ordinary message body.
- Guaranteed upstream replay, exactly-once network delivery, blind resend after
  an ambiguous outcome, or a general redesign of all channel transports.

## Acceptance criteria

- [ ] AC-1: Config and CLI admit named Signal instances with validated account
  mode, socket/account selection, explicit chat/sender lists, nonempty trigger,
  and bounded timeout/reconnect settings. Empty lists deny ordinary chats;
  duplicate resolved receive ownership of one account is rejected.
- [ ] AC-2: Guided setup supports personal-account linking without primary
  re-registration and dedicated-account provisioning. Both modes use the same
  connector and their selected identity for replies; neither requires a Talon
  service account or the other account mode.
- [ ] AC-3: Note to Self in personal mode admits nonempty operator text without a
  trigger. Dedicated-account self events and whitespace-only text create no turn.
- [ ] AC-4: Selected DMs and groups enforce account/chat/sender authorization and
  the explicit trigger. Tests cover exact prefix, whitespace, empty command,
  nonmatching prefix, unauthorized participants, unselected groups, and unknown
  identity. Excluded messages do not enter ordinary transcript or queue storage.
- [ ] AC-5: Operator-authored commands from another linked device work in both
  personal-account entry points. Normal replies, triggered-looking agent text,
  scheduled sends, broadcasts, chunks, early echoes, and restart replay create
  no agent-output loop. The same command observed through two representations
  produces one turn.
- [ ] AC-6: Canonical account/peer/group identities route DMs, Note to Self, and
  groups into separate threads; hidden phone numbers work. Group name changes,
  different participants, or a second account do not merge or misroute history.
  Destinations from a previous account cannot be sent through its replacement.
- [ ] AC-7: Control events, attachment-only messages, disappearing/view-once
  messages, and edits/deletes create no turn. Accompanying ordinary text follows
  the activation table without retrieving or persisting attachment bytes.
- [ ] AC-8: Text replies and long Unicode replies reach the originating DM/group
  or Note to Self without truncation. RPC, per-recipient, partial-chunk/group,
  timeout and disconnected outcomes return typed errors; unknown acceptance is
  identified and causes no automatic connector resend.
- [ ] AC-9: Outbound attachment payloads fail before sending text or media, and
  setup disables inbound attachment download. No new Signal media-processing
  path, provider image input, or dependency on cross-channel media work exists.
- [ ] AC-10: Start/stop/reload and account verification follow the lifecycle
  table. Disconnect/reconnect, unavailable bridge, unlink, timeouts, pending
  reconnect during stop, and replacement instances are tested. One active
  subscription exists per account, and unrelated channels can continue.
- [ ] AC-11: Local acceptance stores both transcript and queue work. Injected
  enqueue failure or interruption after transcript insertion remains retryable;
  replay completes one turn rather than being permanently marked duplicate.
  Already accepted work survives daemon restart using the durable queue.
- [ ] AC-12: Generic channel_send/list/broadcast, persona binding, channel
  capabilities, and scheduled recipient semantics work with Signal DMs/groups.
  Unauthorized sends fail and successful scheduled sends retain recipient-thread
  context without enabling scheduled transcript replay.
- [ ] AC-13: Docs explain both account modes, group selection, sender controls,
  activation, text-only scope, bridge supervision, supported platform/version,
  reconnect/relink recovery, account-wide client access, ordinary Talon/provider
  retention, and the pre-acceptance delivery-loss boundary. README, example
  config, AGENTS, add-signal and affected native/Docker/starter skills match.
- [ ] AC-14: Focused tests cover the activation and lifecycle tables, routing,
  hidden-number identities, own-send provenance, deduplication, failure handoff,
  transport framing, send errors, and multiple accounts. Build and existing
  no-cost startup smoke pass; the full slow suite runs only with authorization.
- [ ] AC-15: Real-device evidence covers both account modes, personal Note to
  Self and selected-chat commands, DM and group replies, trigger/authorization
  exclusion, echo suppression, offline/reconnect behavior, and persistent linking
  after bridge/Talon restart with a fake provider. Evidence distinguishes
  observed limits from guaranteed delivery and excludes credentials/private text.
