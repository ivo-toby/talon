# Round 1 coordinator evidence

Read while recording dispositions on 2026-10-14. Repository code is unchanged
at HEAD dcb6462. This is supporting review evidence; it does not replace the
fingerprinted intake research or claim implementation/live validation.

`R/` means `research/signal-cli-v0.14.9/`; `A/` means
`research/review-1-source-additions/`, relative to this epic. Both are upstream
v0.14.9 at commit 3997429779095ff3a2d64c877126e84fce9852aa. A's provenance file
records individual SHA-256 hashes and upstream URLs; R remains unchanged.

| Read source | Observed boundary and coordinator consequence |
| --- | --- |
| src/daemon/agent-runner.ts:792-798,1061-1068 | Intermediate/final send errors become plain thrown errors. Preserve terminal typed identity and latch rather than accepting full-turn resend. |
| src/daemon/agent-runner.ts:894-895 | AgentQueryAttemptError currently discards the original error identity. A fix only at the outer runner/queue boundary would miss this wrapper. |
| src/queue/queue-processor.ts:169-185,247-282 | Thrown handler errors become plain Error, then failure applies backoff. Both conversion and terminal dispatch must change. |
| src/core/database/repositories/queue-repository.ts:103-113 | Existing completed/dead_letter states can represent success/terminal failure. A reserved payload marker needs a Result-returning update; no new queue status. |
| src/queue/dead-letter.ts:17-21 | Built-in dead-letter replay is described as future work. Recovery guidance must not invent a replay CLI. |
| src/daemon/agent-runner.ts:508-530,790-819 | Some CLI types already suppress Thinking; tool notices and pre-tool text flush are separate sends. Personal output policy must cover all three. |
| src/channels/channel-types.ts:139-152; src/channels/channel-setup.ts:103-111 | Void callback discards pipeline Result. Optional receipt installation provides an explicit retry actor without altering other connectors' callbacks. |
| src/daemon/daemon.ts:129-138; src/channels/channel-registry.ts:95-111 | A rejected first start is not retried by the daemon/registry. Signal start must own transient reconnect. |
| R/src/main/java/org/asamk/signal/json/JsonReceiveMessageHandler.java:24-35 | Account comes from getSelfIdentifier; exception/envelope can appear independently. Alias verification and exception-with-envelope tests are required. |
| A/lib/src/main/java/org/asamk/signal/manager/Manager.java:97-106 | getSelfIdentifier chooses nonnull number, otherwise ACI. Receive account must use listAccounts aliases even with an ACI selector. |
| R/src/main/java/org/asamk/signal/commands/ListAccountsCommand.java:30-47 | JSON response supplies number/aci pair; neither display name nor phone becomes an authorization key. |
| A/src/main/java/org/asamk/signal/json/JsonError.java:6-9 | Exception payload has message and simple class-name type. Remote message is not safe to log; no unverified unlink classifier is invented. |
| R/src/main/java/org/asamk/signal/commands/ListDevicesCommand.java:47-67; R/lib/src/main/java/org/asamk/signal/manager/internal/ManagerImpl.java:483-504 | Plain output marks the local device; JSON omits that marker, exposing id/name/createdTimestamp/lastSeenTimestamp. Creation can be zero. Newest-device comparison is a compensating fail-closed policy with a live gate, not an RPC current-device proof. |
| R/src/main/java/org/asamk/signal/json/JsonContact.java:23-27; R/src/main/java/org/asamk/signal/commands/ListContactsCommand.java:30-65 | Target metadata exposes block/expiration/unregistered flags and recipient/allRecipients selection. Missing metadata is refused rather than assigned permissive defaults. |
| R/src/main/java/org/asamk/signal/json/JsonSendMessageResult.java:15-43; R/src/main/java/org/asamk/signal/util/SendMessageResultUtils.java:57-66 | Per-recipient rate failures, retry delay and challenge tokens need account-wide send control. Tokens are discarded; delays control a persisted local pause. |
| R/src/main/java/org/asamk/signal/commands/VersionCommand.java:60-66 | RPC version may be unknown. Exact accepted version is an explicit policy, not upstream compatibility evidence. |
| CLAUDE.md:41,65,112-116 | Channel layout, filtering and required documentation change with Signal. Include CLAUDE.md in implementation surfaces. |

Socket trust rules, terminal queue handling, buffer deadlines and account rate
bounds are proposed Talon policies. They are not attributed to signal-cli.
Signal server acknowledgement/replay internals remain NOT READ as in the
original inventory. All source-derived behavior still requires the approved
real-device evidence where specified.
