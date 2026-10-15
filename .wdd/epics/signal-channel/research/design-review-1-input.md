# Design: Signal channel

## Components

- **Signal RPC client** — one Unix-socket connection per configured account;
  newline framing, request correlation, validated responses, manual receive
  subscription, timeout/backpressure limits, cancellation and sanitized errors.
- **Signal policy and event mapper** — canonical account/conversation identities;
  device provenance, chat/sender authorization, the approved activation table,
  ignored-event classification and stable idempotency keys.
- **Signal connector** — lifecycle table, account verification, reconnect,
  plain-text formatting, UTF-8 chunking, destination checks, per-recipient send
  outcomes and audit integration. No attachment adapter or account-key access.
- **Inbound transaction boundary** — Result-returning SQLite unit of work shared
  with existing repositories; transcript/dedup/routing/enqueue decisions commit
  together or roll back on typed errors. Existing connector callback is retained.
- **Operator setup and proof harness** — personal linking or dedicated setup,
  current-device metadata, native/mounted-socket guidance, capability/binding
  setup, deterministic packaged-daemon smoke and redacted live-device evidence.

## Interfaces

- **Contract baseline** — consumes:
  `shared-context/contract-inventory.md` and the pinned v0.14.9 reference;
  produces: source-derived fixtures plus separately identified live fixtures.
  Research constraints in `research/contract-constraints.md` apply; no worker
  substitutes HTTP notification shapes or invents an RPC current-device field.
- **SignalConfig** — consumes: `channels[].config`; produces: one normalized,
  validated config used by loader, connector and CLI guidance. Fields:

  | Field | Constraint or default |
  | --- | --- |
  | `accountMode` | Required `personal` or `dedicated` |
  | `socketPath` | Required absolute local Unix-socket path |
  | `account` | Required bridge selector; numbered account or ACI |
  | `accountUuid` | Required canonical ACI, verified against listAccounts |
  | `deviceId` | Required positive integer, recorded from setup's current-device marker |
  | `allowedDmPeers`, `allowedGroups`, `allowedSenders` | Canonical UUID/group-ID arrays; default empty |
  | `triggerPrefix` | Nonempty; default `!talon`; parsing follows spec |
  | `requestTimeoutMs` | Integer 1,000–120,000; default 30,000 |
  | `reconnectBaseMs`, `reconnectMaxMs` | Integers 100–60,000 and 100–300,000; max ≥ base; defaults 1,000/60,000 |

- **Setup metadata** — consumes: operator-owned account setup and standalone
  `listDevices` plain output while the bridge is stopped; produces: selected
  account UUID and current device ID. Runtime listDevices validates membership
  but cannot prove which entry is current. Relinking requires fresh metadata.
  talond never opens the cryptographic account directory. Multi-account daemon
  mode is required for account discovery; every account-specific RPC includes
  its selector. Runtime methods are version, listAccounts, listDevices,
  subscribeReceive, unsubscribeReceive, listGroups, listContacts and send;
  registration/linking remain operator actions.
- **Generation policy** — consumes: normalized configs before subscriptions;
  produces: unique account ownership and immutable known `(accountUuid,
  deviceId)` pairs for local Talon bridge devices. Reject duplicate account
  ownership. Ignore a matching generated-send device across instances; allow
  personal-owner commands from other linked devices. Personal account UUIDs
  are not published as generic sibling bot IDs. Missing provenance is excluded,
  with a content-free reason. Live fixtures must prove this classification.
- **RPC client** — consumes: typed calls/validated frames; produces:
  `Result<response, ChannelError>` and receive records tied to connection
  generation/subscription. Validate account/version/device before subscribing.
  Buffer pre-response subscription notifications within a 1 MiB total budget;
  discard stale-generation frames. Cap each frame at 1 MiB and pending RPCs at
  64; overflow is a protocol/backpressure error, never unbounded accumulation.
  Manual receive mode, ignored media and suppressed receive stdout are operator
  service prerequisites. Stop cancels pending requests and timers.
- **Mapper** — consumes: validated ordinary data or unwrapped sent data;
  produces: an InboundEvent or ignored reason, never the raw Signal envelope.
  External IDs are `signal:v1:<accountUuid>:self`,
  `signal:v1:<accountUuid>:dm:<peerUuid>` or
  `signal:v1:<accountUuid>:group:<base64url-id>`; group IDs round-trip to canonical
  standard Base64 for RPC. Group authors remain participants. Dedup key encodes
  version/account/conversation/author/original device/data timestamp, excluding
  wrapper kind and local receipt time. Real fixtures must verify cross-wrapper
  normalization; unresolved provenance cannot silently use a guessed key.
- **Connector.send** — consumes: account-scoped destination and AgentOutput;
  produces: bridge-accepted success or sanitized typed failure. Reject stale
  account/unselected destination and attachment payloads before sending. Read
  bridge-known peer/group state; refuse blocked, unregistered, terminated,
  disappearing or unverifiable targets. For Note to Self, query the local peer
  state and send with noteToSelf. Format using existing stripMarkdown, then
  chunk at ≤2,000 UTF-8 bytes without splitting code points. Inspect results
  both under result and error.data.response; stop after a failed/unknown chunk.
  Never resend an ambiguous outcome automatically. Drop challenge tokens and
  raw RPC errors from model-visible errors/logs.
- **Ingress transaction** — consumes: existing synchronous pipeline operations
  using the same SQLite connection; produces: committed enqueued, duplicate or
  intentional no-persona outcome, or rolled-back Result error. Introduce a
  typed transaction runner in the database layer; a private rollback sentinel
  converts returned Err values into rollback and never escapes the boundary.
  Perform duplicate check, insert, routing and enqueue inside the transaction.
  Intentional no-persona transcript/drop auditing stays a committed outcome;
  historical duplicate policy is retained. No new SQLite schema is needed.
- **Generic delivery** — consumes: existing persona binding and channel
  capability checks; produces: foreground/scheduled/broadcast delivery through
  the same connector.send guard. No scheduling-context or tool API changes.
  Reuse the current recipient resolution and concrete-thread broadcast policy.

## Integration surfaces

| Surface | Owned by responsibility |
| --- | --- |
| `src/channels/connectors/signal/**` | RPC, config types, event policy, mapping, lifecycle, sending and diagnostics |
| `src/core/config/config-schema.ts` | Signal type admission and one canonical SignalConfig schema |
| `src/daemon/channel-factory.ts`, `src/channels/channel-setup.ts` | Connector construction and per-generation Signal device/ownership policy |
| `src/core/database/transaction.ts`, `src/pipeline/message-pipeline.ts`, `src/daemon/daemon-bootstrap.ts` | Typed transaction runner, atomic ingress and injection on the shared DB |
| `src/cli/config-utils.ts`, `src/cli/commands/add-channel.ts` | Signal CLI admission and configuration guidance |
| `tests/unit/channels/connectors/signal/**` | Contract parsing, policy, identities, byte chunking, send errors and lifecycle |
| `tests/unit/core/database/transaction.test.ts`, `tests/unit/pipeline/message-pipeline.test.ts` | Err rollback, interruption/replay and intentional-drop/duplicate regression coverage |
| `tests/unit/core/config/config-schema.test.ts`, `tests/unit/daemon/channel-factory.test.ts`, `tests/unit/channels/channel-setup.test.ts` | Validation, construction, multiple accounts, reload and policy injection |
| `tests/unit/cli/add-channel.test.ts`, `tests/unit/cli/config-utils.test.ts`, `tests/unit/tools/host-tools/channel-send.test.ts`, `tests/unit/tools/host-tools/channel-broadcast.test.ts` | CLI entry, selected/stale destinations and scheduled/broadcast compatibility |
| `.agents/skills/run-talon-smoke/**`, `tests/smoke/signal-channel-smoke.mjs` | Fake Unix bridge and packaged-daemon proof; live recipe with cleanup |
| `README.md`, `AGENTS.md`, `config/talond.example.yaml`, `docs/setup-guide.md` | Channel/setup/config, account permissions, text-only/retention/delivery boundaries |
| `.agents/skills/add-signal/**`, `.agents/skills/talon-setup/**`, `.agents/skills/talon-setup-docker/**` | Codex operator setup and safe device metadata collection |
| `.claude/skills/add-signal/**`, `.claude/skills/talon-setup/**`, `.claude/skills/talon-setup-docker/**` | Matching distributed operator walkthroughs |
| `starter/.claude/skills/**`, `starter-stack/.claude/skills/**`, `tests/unit/deploy/starter-bundle.test.ts` | Add-signal allowlists and synchronized starter walkthroughs |

Reused unchanged contracts: ChannelConnector/InboundEvent, channel registry,
thread/message/queue schemas, channel tools, capability labels, stripMarkdown
and the starter sync script. Repository anchors and the earlier handoff finding
are recorded in `shared-context/knowledge/signal-channel.md` and the inventory.

## Epic deliverable

The built daemon admits authorized text from Note to Self, selected DMs and
groups; a no-cost fake provider answers through the Signal bridge, while own
reply echoes and excluded messages produce no additional run. Atomic-ingress
failure/replay, account isolation, stop/reload and typed send errors are proven.
The deterministic harness creates disposable state and shuts down every child
process/socket on success or failure.

Deliverable command, implemented by this epic:

```sh
npm run build && npx vitest run tests/unit/channels/connectors/signal tests/unit/pipeline/message-pipeline.test.ts tests/unit/core/database/transaction.test.ts && bash .agents/skills/run-talon-smoke/scripts/run-signal-smoke.sh fake --no-build
```

The ratified build/CLI/startup checks still apply. AC-15 additionally requires
redacted real-device evidence for both account modes, personal entry points,
DM/group activation, own-device filtering, relinking/restart and offline limits.
The live setup remains operator-authorized; a fake harness is not live proof.
Source research establishes request/response shapes, while those delivery and
provenance observations remain implementation gates. No live success is claimed.
