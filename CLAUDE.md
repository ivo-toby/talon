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

| Module    | Path                       | Purpose                                                             |
| --------- | -------------------------- | ------------------------------------------------------------------- |
| Daemon    | `src/daemon/`              | Lifecycle state machine, agent runner, bootstrap, watchdog          |
| Channels  | `src/channels/connectors/` | 7 adapters: telegram, slack, discord, whatsapp-business, whatsapp-baileys, email, terminal |
| Pipeline  | `src/pipeline/`            | Inbound normalization, dedup, routing, persistence                  |
| Queue     | `src/queue/`               | Durable SQLite queue, retry with exponential backoff, dead-letter   |
| Scheduler | `src/scheduler/`           | Cron/interval/one-shot task execution                               |
| Memory    | `src/memory/`              | Per-thread fact/summary/note storage + context assembly             |
| Tools     | `src/tools/`               | 14 host-tools + capability-based filtering via `tool-filter.ts`     |
| MCP       | `src/mcp/`                 | MCP server registry and lifecycle                                   |
| Personas  | `src/personas/`            | Persona config loading + capability merging                         |
| Skills    | `src/skills/`              | Declarative skill bundles with lazy loading (metadata-only in system prompt, full content on demand via `skill_load` tool) |
| SubAgents | `src/subagents/`           | Loader, model resolver, runner with per-subagent model overrides and failover |
| Images    | `src/images/`              | Attachment selection, bounded transport, Sharp normalization, EXIF metadata, ingestion/lifecycle, context projection |
| Config    | `src/core/config/`         | Zod-validated YAML config loader (`config-schema.ts` is the schema) |
| Database  | `src/core/database/`       | better-sqlite3 wrapper, 20 repositories, SQL migrations             |
| IPC       | `src/ipc/`                 | Unix socket daemon↔CLI communication                                |
| CLI       | `src/cli/`                 | 36 talonctl commands (Commander.js)                                 |

### Key Architectural Decisions

- **neverthrow `Result<T, E>`** everywhere — expected errors are typed, no raw throws across module boundaries. All repository methods return `Result`.
- **SQLite (better-sqlite3)** with WAL mode — single-file, no external DB dependency. Repository pattern allows future migration.
- **Provider runtime runs on host** (not in container) — AgentRunner executes the configured provider strategy. Claude uses the SDK path with `sessionId` persistence; Gemini and Codex use CLI strategies.
- **Capability-based security** — default-deny. Persona `capabilities.allow` lists what tools/channels are accessible. `requireApproval` triggers human confirmation.
- **Skills are declarative** — two formats: `skill.yaml` + `prompts/*.md` (legacy) or single `SKILL.md` with YAML frontmatter (preferred). No executable code in skills.
- **Lazy skill loading** — only skill name + description injected into system prompts. Full content loaded on demand via `skill_load` tool (in-process MCP server for Claude SDK, external MCP server for Gemini CLI, Codex CLI, and openai-compatible). Per-skill `eager: true` opt-in in frontmatter forces the body into the system prompt at startup (use for reflexive skills on small models). Background agents use eager loading.
- **Internal MCP server prefix** — `__talond_` prefix is reserved for internal MCP servers (`__talond_host_tools`, `__talond_skill_loader`). User-defined servers with this prefix are rejected.
- **Images are text-only to the main agent** — pixels go only to the `vision` sub-agent (`docs/adr/0001-vision-subagent.md`); the main agent gets Image descriptors and saved Findings, so text-only personas get the same interface and image tokens stay out of the main session. Pixels, base64 and download credentials never enter main-agent prompts, durable message/queue content, summaries, or logs. Vision chains may contain only `anthropic`/`openai`/`google`/`ollama`; config load rejects a text-only override rather than skipping it and startup revalidates the full effective chain including the implicit manifest fallback. Failover keeps every image part and never drops pixels for an answer; exhaustion creates no Finding. An Inspection validates all Image IDs before any model request and fails the whole call — never truncated, never accepting paths or URLs.
- **Image records outlive their files** — an `Image` is a durable row, not a file. `images.retentionHours` deletes only the normalized JPEG; Image rows, GPS/EXIF, Findings and conversation text persist until separately deleted. Expiry is never extended by access, retry or restart, so queue backlog can make the first run see `Unavailable/expired`; re-upload mints a new Image ID while Findings stay on the old one. States are `Processing`/`Available`/`Rejected`/`Unavailable` with closed vocabularies — eight rejection reasons and two unavailability reasons (`expired`, `file_missing`), no connector-specific values. Rejection is terminal; an Inspection failure never turns an Available Image into Rejected.
- **Image context placement** — current-message descriptors ride in live content for every provider; full inventories and Finding projections are reserved for fresh-session history and rotation (`docs/adr/0002-image-context-placement.md`). Resumed sessions use `image_lookup` for older Images/Findings and current availability. Fixed budgets shared across live and fresh sections: 20 descriptors (1,000 chars each / 8,000 aggregate) and 10 Findings (2,000 chars each / 8,000 aggregate), measured by JavaScript `string.length` including framing. `image_lookup` is named in notices only when exposed to the persona.
- **Image ingestion is durably admitted before processing** — connectors only select attachments and fetch bounded media (fixed 60 s per message); they never run Sharp or write Image rows. `MessagePipeline` owns Ingestion via an injected service: one transaction persists the authoritative message with ordered Images and pending Ingestion, processing resolves outcomes, then one transaction enqueues and marks completion on the same connection. Images are unique by ID and `(message_id, ordinal)`, and completion survives queue-item deletion. Normalization has its own 60 s deadline and at most 3 persisted attempts per Image, not reset by redelivery or restart; publish is fenced on Processing/attempt ownership and both deadlines so late results cannot overwrite terminal outcomes. Telegram polling is therefore sequential and can delay other chats up to roughly 120 s per image-bearing message (60 s fetch + 60 s normalization); WhatsApp is not sequential (concurrent Baileys handlers, concurrent Business webhooks) so it does not block its connector, though a download-based WhatsApp message still carries the same per-message 60 s fetch + 60 s normalization budgets; email does no remote fetch, so only the shared 60 s normalization deadline applies there. No cross-handoff arrival ordering is promised.
- **Multi-connector** — Multiple connector instances of the same channel type are supported. Channels are keyed by `name` (unique), not `type`. Slack and Discord filter all bot messages at the platform level; Telegram filters sibling Talon bot IDs injected at startup; WhatsApp Baileys uses JID-based self-filtering. WhatsApp Business has no bot-self filtering.
- **Per-persona background-agent override** — personas may set `backgroundProvider` and `backgroundModel` to route their background runs through a different runtime than the foreground `provider`. Validated at config load: `backgroundProvider` must be enabled under `backgroundAgent.providers`. When unset, the persona's foreground `provider` is used iff it is enabled in the background registry; otherwise the daemon falls back to `backgroundAgent.defaultProvider`.

### Database

Schema in `src/core/database/migrations/001-initial-schema.sql`. Key tables: `channels`, `personas`, `bindings` (channel↔persona routing), `threads`, `messages`, `queue_items`, `runs`, `schedules`, `memory_items`, `artifacts`, `audit_log`, `tool_results`.

Image tables (migrations `014-image-ledger.sql`, `015-finding-ledger.sql`, `016-image-ingestion-route.sql`): `images` (unique `id` and `(message_id, ordinal)`), `image_ingestions` (per owning message, no queue FK so completion survives queue-item deletion), `image_source_messages`, `image_admission_records`, `findings` + `finding_images`.

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

### Reviews

Before every commit you need to use the codex skill to ask Gpt-5.4 for a review, address the issues, only if there a no critical, high or medium issues are found the work can be committed.
When dealing with PR reviews, always resolve a comment when it's fixed or deemed invalid, always add a comment what you fixed, which commit, or why the comment was invalid

### Documentation

When adding or changing a feature (new channel, new tool, new config option, changed behavior), you MUST update:

1. **README.md** — update the relevant section (channel list, feature list, config reference, etc.)
2. **Claude skills** (`.claude/skills/`) — update any affected setup/add skill so the guided walkthrough matches the current implementation
3. **CLAUDE.md** — if the change affects architecture, module layout, or conventions documented here

Do not consider a feature complete until the docs match the code. PR reviewers should check for doc drift.

### Offload work

If you can, offload coding tasks to GPT-5.3-codex-high using the codex skill, only do this for well defined, tightly scoped tasks.
