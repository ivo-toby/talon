# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Talon?

Talon (`talond`) is a self-hosted autonomous AI agent daemon (~22K lines TypeScript). It receives messages from humans across multiple channels (Telegram, Slack, Discord, WhatsApp, Email, Terminal), processes them through a durable queue, runs agents through a provider layer (Claude Code default, with Gemini CLI and Codex CLI supported), executes tools through capability-gated host-tools, and sends responses back. All data stays on the operator's hardware.

## Build & Development Commands

```bash
npm run build          # tsc + copy SQL migrations to dist/
npm run dev            # tsx watch src/index.ts
npm test               # vitest run (full suite — SLOW, ask before running)
npm run test:watch     # vitest watch mode
npx vitest run tests/unit/queue/queue-manager.test.ts  # single test file
npm run lint           # eslint src/**/*.ts
npm run format         # prettier src + tests
```

Entry points: `node dist/index.js` (daemon), `node dist/cli/index.js` (CLI/talonctl).

## Architecture Overview

### Message Flow

```
Channel Connector → MessagePipeline (normalize, dedup, route, persist)
  → Durable Queue (SQLite-backed FIFO per thread)
  → QueueProcessor (concurrency-limited dequeue)
  → AgentRunner (provider runtime with provider-specific session handling)
  → Host-Tools Bridge (Unix socket MCP server, capability-filtered)
  → Channel Connector (format + send response)
```

### Source Layout

| Module    | Path                       | Purpose                                                                                                                                                       |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon    | `src/daemon/`              | Lifecycle state machine, agent runner, bootstrap, watchdog                                                                                                    |
| Channels  | `src/channels/connectors/` | 7 adapters: telegram, slack, discord, whatsapp-business, whatsapp-baileys, email, terminal                                                                    |
| Pipeline  | `src/pipeline/`            | Inbound normalization, dedup, routing, persistence                                                                                                            |
| Queue     | `src/queue/`               | Durable SQLite queue, retry with exponential backoff, dead-letter                                                                                             |
| Scheduler | `src/scheduler/`           | Cron/interval/one-shot task execution                                                                                                                         |
| Voice     | `src/voice/`               | Optional browser voice: authentication, WebRTC transport, live provider, durable lifecycle, queue bridge (details in `AGENTS.md` and `docs/guides/voice.mdx`) |
| Memory    | `src/memory/`              | Per-thread fact/summary/note storage + context assembly                                                                                                       |
| Tools     | `src/tools/`               | 16 host-tools + capability-based filtering via `tool-filter.ts`                                                                                               |
| MCP       | `src/mcp/`                 | MCP server registry and lifecycle                                                                                                                             |
| Personas  | `src/personas/`            | Persona config loading + capability merging                                                                                                                   |
| Skills    | `src/skills/`              | Declarative skill bundles with lazy loading (metadata-only in system prompt, full content on demand via `skill_load` tool)                                    |
| SubAgents | `src/subagents/`           | Loader, model resolver, runner with per-subagent model overrides and failover                                                                                 |
| Images    | `src/images/`              | Attachment selection, bounded transport, Sharp normalization, EXIF metadata, ingestion/lifecycle, context projection                                          |
| Config    | `src/core/config/`         | Zod-validated YAML config loader (`config-schema.ts` is the schema)                                                                                           |
| Database  | `src/core/database/`       | better-sqlite3 wrapper, 21 repositories, SQL migrations                                                                                                       |
| IPC       | `src/ipc/`                 | Unix socket daemon↔CLI communication                                                                                                                          |
| CLI       | `src/cli/`                 | 37 talonctl commands (Commander.js)                                                                                                                           |

### Key Architectural Decisions

- **neverthrow `Result<T, E>`** everywhere — expected errors are typed, no raw throws across module boundaries. All repository methods return `Result`.
- **SQLite (better-sqlite3)** with WAL mode — single-file, no external DB dependency. Repository pattern allows future migration.
- **Provider runtime runs on host** (not in container) — AgentRunner executes the configured provider strategy. Claude uses the SDK path with `sessionId` persistence; Gemini and Codex use CLI strategies.
- **Capability-based security** — default-deny. Persona `capabilities.allow` lists what tools/channels are accessible. `requireApproval` triggers human confirmation.
- **Skills are declarative** — two formats: `skill.yaml` + `prompts/*.md` (legacy) or single `SKILL.md` with YAML frontmatter (preferred). No executable code in skills.
- **Lazy skill loading** — only skill name + description injected into system prompts. Full content loaded on demand via `skill_load` tool (in-process MCP server for Claude SDK, external MCP server for Gemini CLI, Codex CLI, and openai-compatible). Per-skill `eager: true` opt-in in frontmatter forces the body into the system prompt at startup (use for reflexive skills on small models). Background agents use eager loading.
- **Internal MCP server prefix** — `__talond_` prefix is reserved for internal MCP servers (`__talond_host_tools`, `__talond_skill_loader`). User-defined servers with this prefix are rejected.
- **Images are text-only to the main agent** — pixels go only to the `vision` sub-agent (`docs/adr/0001-vision-subagent.md`); the main agent gets Image descriptors and saved Findings, so text-only personas get the same interface and image tokens stay out of the main session. Pixels, base64 and download credentials never enter main-agent prompts, durable message/queue content, summaries, or logs. Vision chains may contain only `anthropic`/`openai`/`google`/`ollama`; config load rejects a text-only override rather than skipping it and startup revalidates the full effective chain including the implicit manifest fallback. Failover keeps every image part and never drops pixels for an answer; exhaustion creates no Finding. An Inspection validates all Image IDs before any model request and fails the whole call — never truncated, never accepting paths or URLs. Inspection also refuses, before any model request, a run that cannot record a Finding (`FindingPersistence.canRecordForRun`: the `runId` must have a `runs` row in this thread), so background agents — whose task ID has no `runs` row — cannot Inspect.
- **Image records outlive their files** — an `Image` is a durable row, not a file. `images.retentionHours` deletes only the normalized JPEG; Image rows, GPS/EXIF, Findings and conversation text persist until separately deleted. Expiry is never extended by access, retry or restart, so queue backlog can make the first run see `Unavailable/expired`; re-upload mints a new Image ID while Findings stay on the old one. States are `Processing`/`Available`/`Rejected`/`Unavailable` with closed vocabularies — eight rejection reasons and two unavailability reasons (`expired`, `file_missing`), no connector-specific values. Rejection is terminal; an Inspection failure never turns an Available Image into Rejected.
- **Image context placement** — current-message descriptors ride in live content for every provider; full inventories and Finding projections are reserved for fresh-session history and rotation (`docs/adr/0002-image-context-placement.md`). Resumed sessions use `image_lookup` for older Images/Findings and current availability. Fixed budgets shared across live and fresh sections: 20 descriptors (1,000 chars each / 8,000 aggregate) and 10 Findings (2,000 chars each / 8,000 aggregate), measured by JavaScript `string.length` including framing. `image_lookup` is named in notices only when exposed to the persona.
- **Image ingestion is durably admitted before processing** — connectors only select attachments and fetch bounded media (fixed 60 s per message); they never run Sharp or write Image rows. `MessagePipeline` owns Ingestion via an injected service: one transaction persists the authoritative message with ordered Images and pending Ingestion, processing resolves outcomes, then one transaction enqueues and marks completion on the same connection. Images are unique by ID and `(message_id, ordinal)`, and completion survives queue-item deletion. Normalization has its own 60 s deadline and at most 3 persisted attempts per Image, not reset by redelivery or restart; publish is fenced on Processing/attempt ownership and both deadlines so late results cannot overwrite terminal outcomes. Telegram polling is therefore sequential and can delay other chats up to roughly 120 s per image-bearing message (60 s fetch + 60 s normalization); WhatsApp is serialized per chat only (`KeyedSerialQueue` in `src/channels/keyed-serial-queue.ts` around concurrent Baileys handlers and Business webhooks), so a text sent after a photo waits for the photo's handoff while other chats continue; a download-based WhatsApp message still carries the same per-message 60 s fetch + 60 s normalization budgets; email does no remote fetch, so only the shared 60 s normalization deadline applies there. Recovered messages may enqueue in completion order. The `images` config is fixed for the process lifetime: hot reload keeps the running values (connectors included) and warns. Normalization refuses sources over `images.maxInputPixels` before decoding (decompression-bomb guard) and steps quality, then edge, down until the JPEG fits `images.maxNormalizedBytes`; both overflow to Rejected/`size_limit`. Startup recovery is awaited before channels start with a 90 s bound (above the 60 s normalization deadline); hitting it still aborts the boot.
- **A2A task lifecycle** — persona delegation (`persona_send`, `src/a2a/`) is in-process only and not wire-compatible A2A. Every `a2a_tasks` transition is guarded in SQL: `completed`/`failed`/`canceled` are never overwritten, and the runner skips (returns ok for) a collaboration item whose task is terminal or missing. Submission never rejects on concurrency: tasks stay `submitted` and `A2ATaskRepository.tryAdmit` admits them FIFO at dispatch, up to `a2a.maxConcurrentPerTarget`; a task that must wait returns a `QueueDeferral`, which re-queues the item without consuming an attempt. Submit rejects only on `a2a.maxQueuedPerTarget` or a delegation cycle. A task is marked `failed` only on the final queue attempt (`a2a.maxAttempts`, default 1). A2A runs get only the delegated message — no source-thread summary, recent messages, images or Findings. A run waiting in `persona_send`/`persona_task_status` releases its queue slot (`QueueManager.runWithSlotReleased`, keyed by run ID; background agents never release). `A2ATaskMapper.cancelTask` cancels the pending queue item and aborts an in-flight run (`persona_task_cancel`, limited to tasks the caller's persona submitted in its own thread; `talonctl a2a cancel` goes through the daemon's `a2a-cancel` IPC command so the abort hook runs, and falls back to a direct DB cancel only when the daemon does not answer); the reaper (startup + every 60 s) fails orphaned tasks and cancels tasks past `a2a.taskTtlMinutes`. Delegation targets are scoped per persona by `persona.send:<persona-name>` labels (`persona.send:*` or an unscoped `persona.send` = any; `src/personas/persona-delegation.ts`), enforced host-side in `persona_send` from the caller's own resolved capabilities and used to filter `persona_list` and the system-prompt roster; an unknown scoped name only warns at persona load. Hot reload rebuilds the agent-card registry in place; `a2a` limits used at submit time are fixed until restart.
- **Replies and reactions go through the message ledger** — `message_refs` (migration 019, `MessageRefRepository`) maps a provider message ID to its Talon thread, with direction, author and a 1,000-char excerpt. The pipeline records every accepted inbound message that carries `InboundEvent.externalMessageId`; `RunDelivery` (`src/daemon/run-delivery.ts`) and `channel.send` record outbound ones from the connector's `SendReceipt`. Refs are INSERT OR IGNORE and best-effort: a failed write never fails a message. The main agent stays text-only here too: a native reply or a reaction is one bracketed header line in the durable message content (`src/pipeline/message-context.ts`), carrying the provider ID as `(id …)`. A reaction event (`InboundEvent.reaction`) never creates a thread and is forwarded only when the ledger holds its target as an **outbound** message of that chat — other reactions, removals, and reactions without a ledger return `'ignored'`. The ledger, not the connector, decides whether a message is Talon's (a Baileys account is shared with its human owner). Outbound, `AgentOutput.replyTo` is a `MessageTarget`; the runner attaches the trigger message as an `implicit` target on the first text block of a run only, and each connector applies its `replyToTrigger` (`never`/`groups`/`always`, default `groups`) to implicit targets while always honouring explicit ones. `ChannelConnector.send` may return a `SendReceipt`, and `react?()` is optional — callers treat its absence as unsupported. A run block that is only `NO_REPLY` (`src/channels/no-reply.ts`) is not delivered. `channel.react` is its own capability (not implied by `channel.send`), acts only on the run's own conversation, and is refused for A2A runs. It never forwards an ID the ledger cannot place: an explicit `messageId` must be a ledger `external_id` of the conversation (or a stored `messages.id`), otherwise the tool returns the recent messages with their real IDs; `list: true` returns that listing on request. `messages.idempotency_key` is a delivery key (a Telegram `update_id`), never a message ID. A reply target the ledger does not know is recorded when its header is rendered, so every ID the agent is shown stays addressable. Telegram topics are separate threads keyed `<chat_id>:<topic_id>`; `MessageRefRepository.findInChat` resolves a chat-level reaction to the right topic thread. Telegram `getUpdates` always sends an explicit `allowed_updates`, because Telegram otherwise reuses the previous list and never delivers `message_reaction` unnamed.
- **Thread-scoped bindings and Telegram topic workspaces** — a `bindings[]` entry with `thread` (a channel-specific thread ID, e.g. a Telegram topic `<chat_id>:<topic_id>`) binds one conversation to a persona and wins over the channel default in `ChannelRouter`. `reconcileThreadBindings` (`src/channels/channel-setup.ts`) applies them at startup: it creates the thread row when the conversation has not spoken yet, and marks the binding `source = 'config'` (migration 020). Only config-owned bindings on configured channels are pruned when their YAML entry disappears; `runtime` bindings are never removed, and one the YAML now declares is taken over. `talonctl bind/unbind --thread` edit the YAML; a thread binding is never a channel default. Telegram per-chat overrides live in `config.chats`, keyed by `<chat_id>` or by `<chat_id>:<topic_id>` for one topic (`requireMention`, `replyToTrigger`; topic wins over chat, chat over connector-wide), and never admit a chat by themselves. With `requireMention: false` a bot still abstains from a message explicitly addressed to a different bot (an @mention of a username ending in "bot", `/cmd@other`, or a reply to another bot's message), so several bots can share a topic — `allowGroupChats` and `allowedChatIds` still gate. `/chatid` is answered by the connector before the group gates (it exists to reveal IDs of a chat that is not configured yet), never reaches the agent, and with `allowedChatIds` set only answers a listed sender or chat. `channel.send` logs `recipient` and `recipientSource` because an agent-supplied `externalChatId` overrides a schedule's origin (which includes the topic). A synthetic `schedule:…` thread ID is never a provider recipient: `resolveThreadRecipient` (`src/daemon/schedule-thread-utils.ts`) returns the origin chat, or null for a schedule thread without one (CLI-created), and the runner then sends nothing there, typing indicator included.
- **Moving a conversation's context** — `talonctl move-context` (`src/threads/thread-context-move.ts`) moves or copies memory items, messages and notebook files between threads in one transaction, directly on the database like `reset-provider-affinity`. It sets `providerAffinityResetAt` on the target (and on the source in move mode): the provider-side session still holds the old conversation, and only a fresh session re-assembles context from the database. Images and Findings are never carried over — they are owned by the thread they were received in — so a move leaves image-owning messages in the source and a copy copies their text only. `message_refs`, runs, schedules and bindings are not touched. It refuses while either thread has pending, claimed, processing or retryable queue items. Copies get new message IDs and a `context-copy:<target>:<original>` idempotency key, which makes a repeated copy a no-op.
- **Stateless providers observe on window overflow** — the usage threshold (`ContextRoller.checkAndRotate(OM)`) is effectively unreachable for strategies with `supportsSessionResumption: false`, because their per-run prompt is rebuilt small. With `summarizer: session-observer` the runner also calls `ContextRoller.observeRecentWindowOverflow` after such a run (not when the threshold already rotated, never for voice, A2A or schedule runs): at `≥ 2 × recentMessageCount` messages after the observation boundary it observes all but the newest `recentMessageCount`, writes the observation with `trigger: 'recent_window'` and `rotatedThroughTs` = last observed message, removes the pre-roll tail, rotates no session and implies no continuation. Those runs pass `2 × recentMessageCount` to `ContextAssembler.assemble`, so no message is outside both the observation log and the recent window. The legacy `session-summarizer` path is unchanged.
- **Multi-connector** — Multiple connector instances of the same channel type are supported. Channels are keyed by `name` (unique), not `type`. Slack and Discord filter all bot messages at the platform level; Telegram filters sibling Talon bot IDs injected at startup; WhatsApp Baileys uses JID-based self-filtering. WhatsApp Business has no bot-self filtering.
- **Per-persona background-agent override** — personas may set `backgroundProvider` and `backgroundModel` to route their background runs through a different runtime than the foreground `provider`. Validated at config load: `backgroundProvider` must be enabled under `backgroundAgent.providers`. When unset, the persona's foreground `provider` is used iff it is enabled in the background registry; otherwise the daemon falls back to `backgroundAgent.defaultProvider`.

### Database

Schema in `src/core/database/migrations/001-initial-schema.sql`. Key tables: `channels`, `personas`, `bindings` (channel↔persona routing), `threads`, `messages`, `queue_items`, `runs`, `schedules`, `memory_items`, `artifacts`, `audit_log`, `tool_results`. Later migrations in the same folder add more tables, among them `background_tasks` (003) and `a2a_tasks` (007).

Image tables (migrations `014-image-ledger.sql`, `015-finding-ledger.sql`, `016-image-ingestion-route.sql`): `images` (unique `id` and `(message_id, ordinal)`), `image_ingestions` (per owning message, no queue FK so completion survives queue-item deletion), `image_source_messages`, `image_admission_records`, `findings` + `finding_images`.

Binding ownership (migration `020-binding-source.sql`): `bindings.source` is `runtime` or `config`.

Message ledger (migration `019-message-refs.sql`): `message_refs`, primary key `(thread_id, external_id)`; one outbound `messages` row can have several refs (one per delivered block), and `message_id` is nullable.

Table names to know: `memory_items` (not `memory`), `schedules` (column `expression` not `cron_expression`).

Migration numbering uses a single `PRAGMA user_version`: take the next free number above every existing prefix. The duplicated `007-*.sql` files are frozen history, **not** a naming precedent — never renumber or reuse a prefix.

### Config

YAML config validated by Zod schema in `config-schema.ts`. Supports `${ENV_VAR}` substitution. Example at `config/talond.example.yaml`.

## Code Conventions

- **TypeScript strict mode**, ES2022 target, Node16 module resolution
- Path alias: `@talon/*` maps to `src/*`
- ESLint enforces: no floating promises, explicit return types (warn), no-console (warn, except CLI/tests)
- Unused args prefixed with `_`
- Structured logging via pino (`createLogger` from `src/core/logging/`)
- All side effects audit-logged to `audit_log` table
- Node.js 22+ required (uses native `process.loadEnvFile`)

## Testing

Tests in `tests/` using vitest. Coverage thresholds: 80% (branches, functions, lines, statements). Test structure mirrors source: `tests/unit/queue/`, `tests/unit/channels/`, etc.

## Documentation

- `selfdoc.md` — Architecture overview written as self-documentation
- `BOARD.md` — Project task tracking
- `config/talond.example.yaml` — Full config reference
- `templates/assistant/system.md` — Default persona system prompt template

## Workflow

### Branching

Always make sure you are in a feature or fix branch before getting to work

### Documentation

When adding or changing a feature (new channel, new tool, new config option, changed behavior), you MUST update:

1. **README.md** — update the relevant section (channel list, feature list, config reference, etc.)
2. **Claude skills** (`.claude/skills/`) — update any affected setup/add skill so the guided walkthrough matches the current implementation
3. **CLAUDE.md** — if the change affects architecture, module layout, or conventions documented here

Do not consider a feature complete until the docs match the code. PR reviewers should check for doc drift.

### Offload work

If you can, offload coding tasks to GPT-5.3-codex-high using the codex skill, only do this for well defined, tightly scoped tasks.
