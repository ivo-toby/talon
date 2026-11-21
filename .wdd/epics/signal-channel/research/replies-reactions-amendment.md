# Replies and reactions: proposed amendment

Status: **proposal, not ratified.** The approved spec, design and plan are
unchanged. This note records what arrived on this branch from outside the
epic and what the controller has to decide before Signal can use it.

## What changed underneath the epic

The merge of `claude/determined-cray-sz2p2e` brought in two things:

1. `main` as of `abf6c71` (62 commits, including the image-processing epic).
2. A channel-level feature: native replies, emoji reactions and a message
   ledger, implemented for Telegram, WhatsApp Baileys and WhatsApp Business.

The feature is channel-agnostic at the core. The parts a Signal connector
would plug into:

| Piece | Where | Signal needs |
| --- | --- | --- |
| `InboundEvent.externalMessageId` | `src/channels/channel-types.ts` | The data message `timestamp`, as a decimal string |
| `InboundEvent.replyTo` | same | Quote target: timestamp, author ACI, quoted text |
| `InboundEvent.reaction` | same | Reaction target timestamp and emoji |
| `AgentOutput.replyTo` (`MessageTarget`) | same | `quoteTimestamp` / `quoteAuthor` / `quoteMessage` on `send` |
| `ChannelConnector.react?()` | same | `sendReaction` |
| `SendReceipt.externalMessageId` | same | The send result `timestamp` |
| `message_refs` ledger (migration 019) | `src/core/database/repositories/message-ref-repository.ts` | Nothing: the pipeline and runner write it |
| Reply/reaction rendering | `src/pipeline/message-context.ts` | Nothing: text-only headers |

The pipeline forwards a reaction only when the ledger holds its target as a
message Talon sent, and renders replies and reactions as one header line in
the message text. That matches this epic's text-only inbound posture
(`SignalInboundEvent` has no `raw` and no `attachments`).

## What this branch adds for Signal

`src/channels/connectors/signal/signal-replies.ts`, with tests in
`tests/unit/channels/connectors/signal/signal-replies.test.ts`. Pure mapping,
no I/O, not wired into anything:

- `signalMessageIdFromTimestamp` / `parseSignalMessageId` / `signalSendReceipt`
- `resolveSignalMessageAddress`: a `MessageTarget` to (author ACI, timestamp);
  a message Talon sent is authored by the bridge account
- `buildSignalQuoteParams`: `quoteTimestamp`, `quoteAuthor`, `quoteMessage`
- `buildSignalReactionParams`: `emoji`, `targetAuthor`, `targetTimestamp`,
  `remove: false`

Each wire name is cited against the pinned v0.14.9 snapshot in the module
header and the tests.

## What it deliberately does not add

Three contracts cannot be cited from the pinned snapshot, so they are not
implemented:

1. **Inbound reaction fields.** `JsonDataMessage.java:23` shows a
   `JsonReaction reaction`, but `JsonReaction.java` is not pinned.
2. **Inbound quote fields.** `JsonDataMessage.java:24` shows a
   `JsonQuote quote`, but `JsonQuote.java` is not pinned.
3. **Removing a reaction.** `signal-cli.1.adoc:643-644` documents `--remove`,
   but `SendReactionCommand.java` is not pinned, so whether `--emoji` is still
   required with it is unknown. `buildSignalReactionParams` returns
   `REMOVE_UNSUPPORTED` for an empty emoji.

Pinning those three files (with provenance) unblocks all three.

## Conflicts with the approved spec

Adopting replies and reactions for Signal contradicts the spec in two places:

- The admission table row "Receipt, typing, **reaction**, group/profile/timer
  update, story, call, edit, or deletion event → Ignore; no new turn or
  transcript modification".
- Out of scope: "Signal-native mentions/buttons, **reactions**, edits/deletes,
  and receipt tracking".

Quotes are not named in either list, but the outbound design sends prepared
text chunks through `sendPreparedChunk(destination, chunk, trustedContext)`,
which has no parameter for a quote target.

## Decisions for the controller

1. Whether reactions and quotes enter this epic's scope, or stay a follow-up
   epic after TASK-016.
2. If they enter: which chunk of a multi-chunk reply carries the quote (the
   other channels quote on the first text block of a run only), and how a
   quote interacts with the delivery checkpoint, since the checkpoint schema
   is `.strict()` and has no quote field.
3. Whether `sendReaction` needs its own delivery checkpoint or is best-effort
   like the other channels (a failed reaction is a tool error, never retried).
4. Inbound reactions in personal mode: the operator's own reactions arrive as
   sync messages. The other channels forward any reaction on a Talon message;
   Signal has to decide whether a synchronized reaction counts, given the
   reply-loop rules for agent-authored messages.

## Merge notes

- `.wdd/state.json` and `.wdd/shared-context/contract-inventory.md` conflicted
  (both sides hold a single active epic). The Signal epic's versions were
  kept; `main`'s image-processing state is not on this branch.
- `src/channels/channel-types.ts` conflicted and now carries both
  `AgentOutput.trustedDelivery` and `AgentOutput.replyTo`.
- `src/core/config/config-schema.ts` and its test merged without conflict.
  No other file this epic added or changed was touched by the merge.
