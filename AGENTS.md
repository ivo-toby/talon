# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What is Talon?

Talon (`talond`) is a self-hosted autonomous AI agent daemon (~22K lines TypeScript). It receives messages from humans across multiple channels (Telegram, Slack, Discord, WhatsApp, Email, Terminal), processes them through a durable queue, runs agents through a provider layer (Codex default, with Gemini CLI and Codex CLI supported), executes tools through capability-gated host-tools, and sends responses back. All data stays on the operator's hardware.

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

| Module    | Path                       | Purpose                                                                                                                    |
| --------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Daemon    | `src/daemon/`              | Lifecycle state machine, agent runner, bootstrap, watchdog                                                                 |
| Channels  | `src/channels/connectors/` | 7 adapters: telegram, slack, discord, whatsapp-business, whatsapp-baileys, email, terminal                                 |
| Pipeline  | `src/pipeline/`            | Inbound normalization, dedup, routing, persistence                                                                         |
| Queue     | `src/queue/`               | Durable SQLite queue, retry with exponential backoff, dead-letter                                                          |
| Scheduler | `src/scheduler/`           | Cron/interval/one-shot task execution                                                                                      |
| Memory    | `src/memory/`              | Per-thread fact/summary/note storage + context assembly                                                                    |
| Tools     | `src/tools/`               | 14 host-tools + capability-based filtering via `tool-filter.ts`                                                            |
| MCP       | `src/mcp/`                 | MCP server registry and lifecycle                                                                                          |
| Personas  | `src/personas/`            | Persona config loading + capability merging                                                                                |
| Skills    | `src/skills/`              | Declarative skill bundles with lazy loading (metadata-only in system prompt, full content on demand via `skill_load` tool) |
| SubAgents | `src/subagents/`           | Loader, API/isolated CLI model resolver, runner with per-subagent overrides and failover                                  |
| Images    | `src/images/`              | Attachment selection, bounded transport, Sharp normalization, EXIF metadata, ingestion/lifecycle, context projection       |
| Config    | `src/core/config/`         | Zod-validated YAML config loader (`config-schema.ts` is the schema)                                                        |
| Database  | `src/core/database/`       | better-sqlite3 wrapper, 20 repositories, SQL migrations                                                                    |
| IPC       | `src/ipc/`                 | Unix socket daemon↔CLI communication                                                                                       |
| CLI       | `src/cli/`                 | 36 talonctl commands (Commander.js)                                                                                        |

### Key Architectural Decisions

- **neverthrow `Result<T, E>`** everywhere — expected errors are typed, no raw throws across module boundaries. All repository methods return `Result`.
- **SQLite (better-sqlite3)** with WAL mode — single-file, no external DB dependency. Repository pattern allows future migration.
- **Provider runtime runs on host** (not in container) — AgentRunner executes the configured provider strategy. Codex uses the SDK path with `sessionId` persistence; Gemini and Codex use CLI strategies. OpenAI-compatible is normally a stateless Mastra chat-completions wrapper; `options.apiMode: responses` switches that implementation to `/v1/responses`, and `options.sessionMode: previous_response_id` enables stateful response-id session resumption. Persisted resumable sessions are scoped by thread, provider, model, and configured reasoning effort; changing models or effort starts a fresh session and re-injects compressed context instead of resuming an old chain. Runs with OAuth-authenticated HTTP/SSE MCP servers disable provider-native shell and filesystem tools while retaining Talon's capability-gated tools and configured MCP servers; Codex CLI cannot enforce this and is rejected. This is a tool boundary, not OS isolation from processes running as the daemon's Unix user.
- **Subscription sub-agents are one-shot model adapters** — opt-in `subagentCli.claudeCode` runs bounded Claude Code generations through the daemon user's existing CLI login, without registering an `AgentProvider`. `subagentSandbox.codex` instead calls the separate externally supervised `codex-runner` container; Codex never runs in the daemon, receives no Talon host tools/MCP/persona data/host mounts, starts a fresh ephemeral App Server turn with a sterile home/workspace, rejects non-ChatGPT auth, and fails closed on built-in tool activity. `talond` checks the runner's token-authenticated readiness endpoint before accepting work, but never receives Docker/Podman authority to start it. The runner's dedicated Codex account state remains sensitive and is never exposed to Talon. Subscription cost is not fabricated as an API-dollar estimate. Do not add direct Codex CLI here without external containment that enforces filesystem-read and network boundaries.
- **Scheduled runs are one-shot** — scheduled queue items do not use thread provider affinity, do not restore or persist provider session IDs, do not inject schedule-thread transcript via ContextAssembler, do not run context rotation / observational memory, and do not persist skipped final assistant wrap-up text as outbound messages. Agents must call `channel_send` explicitly to notify users; successful `channel_send` deliveries are stored on the live recipient thread so replies have context. For schedules without an `originExternalId` (CLI-created via `talonctl add-schedule`), the agent must pass `externalChatId` explicitly, call `channel_list` to discover targets, or call `channel_broadcast` to fan out to every bound chat; broadcasts skip channel-default bindings (no `thread_id`) with a warning included in the `{ delivered, skipped, failed }` result.
- **Provider names can alias implementation types** — provider config keys remain the names personas select and the names persisted in run history. Optional `providers.<name>.type` selects the implementation factory (for example `ollama-mac` with `type: openai-compatible`) so multiple OpenAI-compatible endpoints can coexist.
- **Capability-based security** — default-deny. Persona `capabilities.allow` lists what tools/channels are accessible. `requireApproval` triggers human confirmation.
- **Skills are declarative** — two formats: `skill.yaml` + `prompts/*.md` (legacy) or single `SKILL.md` with YAML frontmatter (preferred). No executable code in skills.
- **Lazy skill loading** — only skill name + description injected into system prompts. Full content loaded on demand via `skill_load` tool (in-process MCP server for Codex SDK, external MCP server for Gemini CLI, Codex CLI, and openai-compatible). Per-skill `eager: true` opt-in in frontmatter forces the body into the system prompt at startup (use for reflexive skills on small models). Background agents use eager loading.
- **Internal MCP server prefix** — `__talond_` prefix is reserved for internal MCP servers (`__talond_host_tools`, `__talond_skill_loader`). User-defined servers with this prefix are rejected.
- **Per-server MCP request timeout and tool-output cap** — each MCP server entry in `skills/<skill>/mcp/<server>.json` may carry `timeoutMs` (integer ≥ 1000; omitted → Mastra 60 000 ms default; the outer query timeout still wins) and `toolOutputCap` (integer ≥ 0; `0` disables excerpting for that server only; omitted → provider-level `toolOutputCap` fallback → 4 000; provider-level `0` disables only the fallback, explicit positive per-server caps still apply). These are run-local model-history metadata, not network-byte or full-output memory bounds: when any effective MCP cap is positive, MCP results (including zero-cap servers) are stored in a shared run-local in-memory store, retrievable via `fetch_tool_output` in up to 8 000 content-character slices (framing additional) when available; with all effective caps at `0` no wrapper/recovery is injected; if a discovered MCP tool already owns the reserved `fetch_tool_output` name, Talon skips the synthetic recovery (delegating to the MCP tool and logging a warning) instead of overwriting it. Only the Mastra / OpenAI-compatible path (both chat-completions and Responses modes) honors the metadata; native CLI serializers (Claude, Gemini, Codex CLI) omit it. Built-in workspace file/shell tools are unaffected. `talonctl add-mcp` accepts `--timeout-ms` / `--tool-output-cap` with strict decimal safe-integer validation; `add-mcp` rejects duplicate server names, so existing servers are edited in place in the skill JSON.
- **Images are text-only to the main agent** — pixel bytes go exclusively to the `vision` sub-agent (`docs/adr/0001-vision-subagent.md`). The main agent receives Image descriptors and saved Findings, so image support is identical for text-only personas and image tokens never enter the main session. Pixels, base64 payloads and download credentials must never appear in main-agent prompts, durable message/queue content, summaries, or logs. Only `anthropic`/`openai`/`google`/`ollama` may appear in a vision chain; config load rejects a text-only override (`claude-code`, `codex-sandbox`) rather than skipping it, and startup revalidates the whole effective chain including the implicit manifest fallback. Failover keeps every image part and never drops pixels to obtain an answer; exhaustion creates no Finding. An Inspection validates all Image IDs before any model request and fails the whole call — never truncating, never accepting paths or URLs.
- **Image records outlive their files** — an `Image` is a durable row, not a file. `images.retentionHours` deletes only the normalized JPEG (`data/threads/{threadId}/attachments/images/{imageId}.jpg`); Image rows, GPS/EXIF, Findings and conversation text persist until separately deleted, and provider-side retention is out of scope. Expiry is never extended by access, retry, or restart, so queue backlog can make the first run already see `Unavailable/expired`; re-upload mints a new Image ID while Findings stay on the old one. State is `Processing`/`Available`/`Rejected`/`Unavailable` with closed vocabularies — eight rejection reasons (`unsupported_mime`, `count_limit`, `size_limit`, `animated`, `download_failed`, `conversion_failed`, `processing_interrupted`, `processing_failed`) and two unavailability reasons (`expired`, `file_missing`). No connector-specific reasons. Rejection is terminal and an Inspection failure never turns an Available Image into Rejected.
- **Image context placement** — current-message descriptors are appended to live content for every provider; the full descriptor inventory and Finding projections are reserved for fresh-session history injection and context rotation (`docs/adr/0002-image-context-placement.md`), because Codex appends resumed-turn input to its session log and repeating projections would accumulate duplicate text. Resumed sessions use `image_lookup` for older Images/Findings and current availability. Budgets are fixed and shared between live and fresh sections: 20 descriptors (1,000 chars each / 8,000 aggregate) and 10 Findings (2,000 chars each / 8,000 aggregate), measured by JavaScript `string.length` and including framing and omission notices. `image_lookup` is named in notices only when that tool is actually exposed to the persona.
- **Image ingestion is durably admitted before it is processed** — connectors only select attachments and fetch bounded media (fixed 60 s per message); they never run Sharp or write Image rows. `MessagePipeline` owns Ingestion through an injected service: one SQLite transaction persists/loads the authoritative message and, for routed messages, ordered Images plus pending Ingestion with recovery references; processing then resolves outcomes; a second transaction enqueues and marks Ingestion complete on the same connection. Images are unique by globally unique ID and `(message_id, ordinal)` so redelivery reuses a slot, and completion survives queue-item deletion. Normalization has its own 60 s deadline with at most 3 attempts per Image, persisted and not reset by redelivery or restart; publish is fenced on Processing/attempt ownership and both deadlines so late results cannot overwrite terminal outcomes. Startup, redelivery and a ≤ 60 s sweep recover pending work without displacing an active owner. Consequence to preserve: Telegram polling is sequential, so it waits up to roughly 120 s per image-bearing message (60 s remote fetch + 60 s normalization) before delivering anything else on that connector. WhatsApp is NOT sequential — Baileys launches each inbound handler concurrently and Business accepts concurrent webhook requests — so it does not block its connector, but a download-based WhatsApp message still carries the same per-message budgets (60 s fetch + 60 s normalization). Email has no remote-fetch budget — its bytes already arrived with the message within the input cap — so only the shared 60 s normalization deadline applies there. No cross-handoff arrival ordering is promised.
- **Multi-connector** — Multiple connector instances of the same channel type are supported. Channels are keyed by `name` (unique), not `type`. Slack and Discord filter all bot messages at the platform level; Telegram filters sibling Talon bot IDs injected at startup; WhatsApp Baileys uses JID-based self-filtering. WhatsApp Business has no bot-self filtering.
- **Per-persona background-agent override** — personas may set `backgroundProvider` and `backgroundModel` to route their background runs through a different runtime than the foreground `provider`. Validated at config load: `backgroundProvider` must be enabled under `backgroundAgent.providers`. When unset, the persona's foreground `provider` is used iff it is enabled in the background registry; otherwise the daemon falls back to `backgroundAgent.defaultProvider`.

### Database

Schema in `src/core/database/migrations/001-initial-schema.sql`. Key tables: `channels`, `personas`, `bindings` (channel↔persona routing), `threads`, `messages`, `queue_items`, `runs`, `schedules`, `memory_items`, `artifacts`, `audit_log`, `tool_results`.

Image tables (migrations `014-image-ledger.sql`, `015-finding-ledger.sql`, `016-image-ingestion-route.sql`): `images` (one row per accepted/rejected attachment; unique `id` and `(message_id, ordinal)`), `image_ingestions` (per owning message, `pending` → `completed`, no queue FK so completion survives queue-item deletion), `image_source_messages` and `image_admission_records` (recovery source references and terminal records for intentionally unrouted image messages), `findings` + `finding_images` (canonical Inspection answers and their Image associations).

Table names to know: `memory_items` (not `memory`), `schedules` (column `expression` not `cron_expression`).

Migration numbering: the runner tracks a single `PRAGMA user_version`, so each migration takes the next free number greater than every existing numeric prefix. The two `007-*.sql` files are frozen historical duplication, **not** a naming precedent — never renumber or reuse a prefix.

### Config

YAML config validated by Zod schema in `config-schema.ts`. Supports `${ENV_VAR}` substitution. Example at `config/talond.example.yaml`.

## Code Conventions

- **TypeScript strict mode**, ES2022 target, Node16 module resolution
- Path alias: `@talon/*` maps to `src/*`
- ESLint enforces: no floating promises, explicit return types (warn), no-console (warn, except CLI/tests)
- Unused args prefixed with `_`
- Structured logging via pino (`createLogger` from `src/core/logging/`)
- All side effects audit-logged to `audit_log` table
- Node.js 24+ required (uses native `process.loadEnvFile`)

## Testing

Tests in `tests/` using vitest. Coverage thresholds: 80% (branches, functions, lines, statements). Test structure mirrors source: `tests/unit/queue/`, `tests/unit/channels/`, etc.

### Local Runtime Smoke Testing

Use this when a task needs proof that `talond` actually boots and the terminal
client can communicate with it. A durable Postgram memory also exists for this
environment; before asking Ivo to restate it, search Postgram for
`talon runtime-validation terminal-channel codex-cli better-sqlite3`.

Manual trigger: use `$run-talon-smoke` from `.agents/skills/run-talon-smoke`
for a guided real-life terminal smoke test.

Baseline environment:

- Node 24+ is required. This workspace was verified with Node `v24.15.0`.
- Run `rtk npm ci` on a fresh checkout.
- Run `rtk npm run build` before daemon smoke tests.
- If SQLite fails with a missing native binding for Node 24, run
  `rtk npm run rebuild:sqlite`, then rerun `doctor`.

Ignored local smoke harness:

- `.codex/talon-smoke/talond-smoke.yaml` — no-cost fake `codex-cli` provider.
- `.codex/talon-smoke/talond-live-codex.yaml` — live authenticated `codex-cli`.
- `.codex/talon-smoke/fake-codex.mjs` — emits Codex JSONL and final output.
- These files are ignored by git. Recreate them if missing, or recover the
  details from Postgram using the query above.

No-cost terminal round-trip:

```bash
rtk npm run talonctl -- doctor --config .codex/talon-smoke/talond-smoke.yaml
rtk npm run talond -- --config .codex/talon-smoke/talond-smoke.yaml --env-file .codex/talon-smoke/empty.env
rtk proxy npm run talonctl -- chat --host 127.0.0.1 --port 17700 --token smoke-terminal-token --client-id codex-smoke --persona smoke
```

Expected response after sending a message:

```text
Talon smoke OK: terminal round-trip reached fake codex provider.
```

Live `codex-cli` terminal round-trip:

```bash
rtk npm run talonctl -- doctor --config .codex/talon-smoke/talond-live-codex.yaml
rtk npm run talond -- --config .codex/talon-smoke/talond-live-codex.yaml --env-file .codex/talon-smoke/empty.env
rtk proxy npm run talonctl -- chat --host 127.0.0.1 --port 17701 --token live-terminal-token --client-id codex-live-smoke --persona live
```

Expected response after sending `Reply exactly: TALON LIVE OK`:

```text
TALON LIVE OK
```

Always stop chat clients and daemon processes with Ctrl+C after smoke testing.
Verify no listeners remain with:

```bash
rtk lsof -nP -iTCP:17700 -sTCP:LISTEN
rtk lsof -nP -iTCP:17701 -sTCP:LISTEN
```

## Documentation

- `CONTEXT.md` — Domain glossary; use its Image, Attachment, Inspection, and Finding terminology
- `docs/adr/` — Architectural decisions and their tradeoffs
- `selfdoc.md` — Architecture overview written as self-documentation
- `BOARD.md` — Project task tracking
- `config/talond.example.yaml` — Full config reference
- `templates/assistant/system.md` — Default persona system prompt template

## Workflow

### Branching

Always make sure you are in a feature or fix branch before getting to work

### Reviews

Before every commit, request a fresh independent code review from GPT-6.1-sol at xhigh reasoning effort. Address all critical, high, and medium findings; commit only when none remain.
When dealing with PR reviews, always resolve a comment when it's fixed or deemed invalid, always add a comment what you fixed, which commit, or why the comment was invalid

### Documentation

When adding or changing a feature (new channel, new tool, new config option, changed behavior), you MUST update:

1. **README.md** — update the relevant section (channel list, feature list, config reference, etc.)
2. **Codex skills** (`.agents/skills/`) — update any affected setup/add skill so the guided walkthrough matches the current implementation
3. **AGENTS.md** — if the change affects architecture, module layout, or conventions documented here

Do not consider a feature complete until the docs match the code. PR reviewers should check for doc drift.

### Offload work

For WDD work, use the implementation models configured in `.wdd/config.json`. For other well-defined, tightly scoped tasks, offload coding to GPT-5.3-codex-high using the codex skill when available.
