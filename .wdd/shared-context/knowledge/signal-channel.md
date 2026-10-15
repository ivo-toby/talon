# Signal channel knowledge draft

## Root causes

- The pipeline persists a transcript before enqueueing, then treats an existing
  idempotency key as a completed duplicate. Enqueue failure can therefore leave
  a recorded message without a retryable turn. The draft spec includes a focused
  handoff repair (`src/pipeline/message-pipeline.ts:140`,
  `src/pipeline/message-pipeline.ts:212`).

## Quirks

- A direct availability probe successfully invoked `gpt-5.6-luna` with `max`
  reasoning and returned `GPT-5.6-Luna probe OK`. It is usable in this session
  despite its absence from the advertised model list. The approved WDD worker
  configuration remains unchanged; this probe is not implementation or review
  evidence.
- The connector callback currently returns no typed pipeline outcome; the
  shared interface accepts a void-returning handler
  (`src/channels/channel-types.ts:143`). Durable receive acknowledgement cannot
  be inferred from completion of that callback.
- The source-based Signal research is in `research_notes/Signal channel
  feasibility/`. No live account or device test was performed during that
  research. Personal-account operator commands and agent echoes still require
  live provenance verification.
- Pinned v0.14.9 listDevices JSON omits the current-device marker that its
  standalone CLI prints. Setup must establish device metadata explicitly;
  runtime must not invent isThisDevice in the RPC response
  (`research/signal-cli-v0.14.9/src/main/java/org/asamk/signal/commands/ListDevicesCommand.java:47-67`).
- The bridge uploads a long-text attachment above 2,000 UTF-8 bytes. Signal
  text-only replies must be chunked by bytes, not JavaScript string length
  (`research/signal-cli-v0.14.9/lib/src/main/java/org/asamk/signal/manager/config/ServiceConfig.java:24`,
  `research/signal-cli-v0.14.9/lib/src/main/java/org/asamk/signal/manager/internal/ManagerImpl.java:947-954`).
- Send failures can preserve timestamp/results under error.data.response;
  challenge tokens in those results must not reach logs or agent errors
  (`research/signal-cli-v0.14.9/src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcCommandHandler.java:249-290`).

## Decisions

- Ivo agreed to the immutable epic name `signal-channel` and to use the existing
  draft spec as the intake source.
- Ivo approved retaining the current WDD constitution/configuration and
  inheriting all settings for this epic on 2026-10-14. Those approvals were
  recorded through wddctl; no epic overrides were added.
- Ivo chose both personal-linked and dedicated Signal account modes, DMs and
  groups, and deferred attachments while cross-channel attachment work proceeds
  separately.
- Ivo chose both Note to Self and selected chats as personal-account entry
  points: Note to Self activates without a prefix; selected chats require an
  explicit trigger. Agent output never activates another turn.
- The canonical spec is `.wdd/epics/signal-channel/spec.md`, copied byte-for-byte
  from `docs/superpowers/specs/2026-10-14-signal-channel-spec.md`. Ivo explicitly
  signed off on that text on 2026-10-14; wddctl recorded all 15 acceptance
  criteria, including Unix-socket transport, disappearing-message exclusion,
  and focused handoff repair. No adversarial review was requested first.
- Contract research was recorded by Codex using the v0.14.9 source snapshot,
  contract inventory and immutable knowledge input. Design approval was subsequently recorded following Ivo's implementation
  instruction on 2026-10-15. No live validation is recorded.

## Review catches

- Claude Opus 5.5's externally requested general+security review found one P1
  and seventeen P2s; original findings are immutable in
  research/spec-review-1.md. Coordinator dispositions accept every finding.
  Closure means a specified design remedy, pending independent confirmation
  and human sign-off; no implementation or live evidence is implied.
- F1: agent-runner send failures retry the entire queue turn, including earlier
  sends/tools. Stream and queue catches also erase typed errors
  (src/daemon/agent-runner.ts:895; src/queue/queue-processor.ts:173).
  Revised design uses a terminal run error, tool failure latch and a durable
  queue-payload marker before Signal use, so wrapping/crash recovery cannot
  redispatch that provider turn. Recovery requires an explicit new command.
- F2/F3/F4/F15: receive account aliases come from listAccounts' number/ACI pair;
  first-connect retry belongs to the connector. The draft now defines every
  verification/receive-exception transition and exactly supported v0.14.9.
- F5: membership does not establish the current bridge device after relinking.
  The draft requires personal bridge creation metadata and a strictly newest
  linked-device rule, plus verified frozen human-device rosters across instances.
  Newer/tied/unknown device creation fails closed. This operational constraint
  remains a proposal and a mandatory live-evidence gate.
- F6/F7: personal output becomes final-only except intentional tool/completion
  messages; showToolCalls=true is refused. An account gate serializes sends,
  persists rate/challenge pauses and needs explicit local challenge recovery.
- F8–F14: the revised design specifies config/wire encodings, missing-target
  refusal, bounded framing/buffer recovery, metadata-free aggregate ignored
  diagnostics, strict parse-error sanitization, private same-UID socket trust
  and synthetic identity/timestamp rules for evidence.
- F16: transactional rollback alone does not replay input. The draft adds an
  optional Result-aware receipt and a bounded connector FIFO/backoff actor.
  Stop/crash/overflow/deadline losses remain before durable acceptance.
- F17/F18: CLAUDE.md joins required documentation; the deliverable script must
  execute all listed focused surfaces, including AC-1/AC-12 and new runner,
  queue, receipt, account-state and local recovery checks.

- Round 2: Claude Opus 5.5's second external general+security review upholds all
  eighteen original findings/dispositions and reports R2-F1/R2-F2 as P1 plus
  five P2s. The immutable report is research/spec-review-2.md. The coordinator
  accepts all seven; closure is in the revised design, awaiting independent
  confirmation and human convergence. The following refinements supersede
  round 1's broad terminal-send/receive-exception/recovery policies.
- R2-F1: default queue concurrency is five. Rejecting a busy account while
  making every NOT_SENT terminal loses ordinary replies. Revised design uses
  a bounded FIFO and saved final/background text/chunk cursors in queue payload,
  with delivery-only defer distinct from provider maxAttempts. A delivery retry
  never queries the provider or repeats earlier tools. Partial/unknown current
  chunks stay terminal. No new queue status or generic transport redesign.
- R2-F2: JsonMessageEnvelope has a normal UntrustedIdentityException branch;
  a remote contact's per-message error is not account-level failure evidence
  (pinned JsonMessageEnvelope.java:34-45). Exclude that notification only,
  including invalid event fields; keep other receiving active. No raw error
  classifier, verification amplification or protocol-loop counter for it.
- R2-F3/R2-F4: drain active send on reload, then separate an unknown delivery
  from account recovery using an automatic fence. Only real server challenges
  require explicit resume. A handled Signal tool error permits an explanation
  on its origin channel; operation/account safeguards do not silence Telegram
  or a healthy Signal destination.
- R2-F5: background notification delivery branches before provider setup
  (src/daemon/agent-runner.ts:66-69) and has no run ID. Guard/checkpoint identity
  must use queue item/delivery ID, with real run ID optional. Notification text,
  task/status and nullable outbound run ID survive delivery-only recovery; no
  fabricated provider execution/session.
- R2-F6/R2-F7: listDevices is a server call, so refresh gets one persisted
  account budget and cached proof rather than per-send calls. Transient refresh
  failure preserves the healthy subscription. Local listAccounts separately
  refreshes number/ACI aliases; unknown aliases have bounded quarantine and
  cannot be trusted from sender text. Runtime selection uses pinned ACI.

- Round 3 upheld the round-1/2 remedies and accepted convergence after four
  P2 clarifications: bounded stale-proof quarantine; durable per-destination
  leases for contiguous chunks; purge cancellation with no late resurrection;
  and a target-specific rather than account-wide invocation latch.
- Pre-commit independent review caught explicit/progress leases without a
  durable retry actor. Such leases now release on every invocation return, and
  startup removes pre-reservation orphan leases after reservation classification.
- Ivo instructed implementation and completion of all tasks on 2026-10-15.
  This authorizes in-scope planning/execution; target-branch merge remains
  human-owned and AC-15 still requires real-device evidence.
