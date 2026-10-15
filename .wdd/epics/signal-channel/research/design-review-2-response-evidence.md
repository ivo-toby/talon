# Round 2 coordinator evidence

Read while recording dispositions on 2026-10-14. Source remains at HEAD
dcb6462. This is additive review evidence, not a replacement intake research
record or an implementation/live-validation claim. The input to round 2 is
preserved byte-for-byte in research/design-review-2-input.md, SHA-256
c1133cfd5068012bf40db69c22a862ceb389eb2a2315c2835ca4d7c6588c3552.

`R/` means research/signal-cli-v0.14.9/ and `A/` means
research/review-1-source-additions/, relative to this epic. Both source sets
remain unchanged at upstream commit 3997429779095ff3a2d64c877126e84fce9852aa.

| Read source | Observed contract / coordinator consequence |
| --- | --- |
| src/core/config/config-schema.ts:190-194; src/queue/queue-manager.ts:202-241 | Default concurrency is 5, provider attempts 3; dispatches run in parallel. Busy output needs waiting/delivery-only deferral, not terminal rejection. |
| src/core/database/repositories/queue-repository.ts:71-83,119-122,207-226 | Claims select eligible rows; fail increments attempts. Saved-delivery defer must preserve payload/cursor, avoid provider-attempt consumption and prevent later ordinary thread work overtaking a delayed reply. |
| src/daemon/lifecycle.ts:30-41 | Crash recovery resets claimed/processing items to pending. Checkpoint classification must precede provider dispatch: ready resumes delivery, in_flight is unknown, delivered only finalizes. |
| src/daemon/agent-runner.ts:1061-1090 | Delivery precedes outbound-history insertion and context rotation. Delivery retries need stable text/run identity and idempotent finalization without re-querying the provider. |
| src/core/database/repositories/run-repository.ts:14-47 | Runs have fixed status values and no general metadata JSON column. The proposed delivery phase belongs to queue payload/status output; no fictional RunRow field or extra provider run is introduced. |
| src/daemon/agent-runner.ts:66-69,1525-1539 | Background notification bypasses normal provider setup, wraps send errors in plain Error, and stores outbound with run_id null. Use trusted queue identity, optional run ID and the same saved-delivery actor. |
| src/subagents/background/background-agent-manager.ts:722-738 | Producer queues notification content/task/status/persona separately from a normal message continuation. Notification retry cannot regenerate/re-run the background task or conflate the two queue items. |
| src/daemon/daemon.ts:432-445 | Reload stops/replaces all connectors. Bound active send drain, preserve unwritten delivery and re-resolve current registry at delivery time. |
| src/tools/host-tools/channel-send.ts:251-282 | Tool errors are returned to the provider, while accepted sends persist recipient context. Retain that explanation path and never call deferred explicit tool delivery success. |
| R/src/main/java/org/asamk/signal/json/JsonMessageEnvelope.java:34-45 | UntrustedIdentityException is a normal per-message source/device branch; it does not prove account unusability. Exclude the event without stopping other chats. |
| R/src/main/java/org/asamk/signal/json/JsonReceiveMessageHandler.java:24-35; A/src/main/java/org/asamk/signal/json/JsonError.java:6-9 | Exception and envelope are independent fields; exception text/class originates remotely. No text-based account-state inference or raw error logging. |
| R/lib/src/main/java/org/asamk/signal/manager/internal/ManagerImpl.java:483-505 | listDevices calls LinkDeviceApi.getDevices on Signal servers. Cache/budget verification separately; healthy-socket metadata errors do not require subscription teardown. |
| R/src/main/java/org/asamk/signal/commands/ListAccountsCommand.java:27-36; A/lib/src/main/java/org/asamk/signal/manager/Manager.java:97-106 | listAccounts reads manager number/ACI; receive identifiers prefer current number. Local alias refresh must work without reconnect and preserve the pinned ACI. |
| R/src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcCommandHandler.java:128-138 | Runtime account selection resolves the provided normalized selector to a manager. The recorded inventory supports ACI selectors; use the verified ACI instead of retaining an obsolete phone selector. |

FIFO bounds, saved reply/cursor/deadline, typed delivery-only retry, proof TTL,
reload drain and automatic uncertainty fence are proposed Talon policies.
They are not attributed to Signal or claimed to prove end-to-end exactly-once
delivery. Lost network outcomes remain terminal for their specific delivery;
upstream replay/acknowledgement internals remain NOT READ as recorded earlier.
