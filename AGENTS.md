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
| Tools     | `src/tools/`               | 11 host-tools + capability-based filtering via `tool-filter.ts`                                                            |
| MCP       | `src/mcp/`                 | MCP server registry and lifecycle                                                                                          |
| Personas  | `src/personas/`            | Persona config loading + capability merging                                                                                |
| Skills    | `src/skills/`              | Declarative skill bundles with lazy loading (metadata-only in system prompt, full content on demand via `skill_load` tool) |
| SubAgents | `src/subagents/`           | Loader, model resolver, runner with per-subagent model overrides and failover                                              |
| Config    | `src/core/config/`         | Zod-validated YAML config loader (`config-schema.ts` is the schema)                                                        |
| Database  | `src/core/database/`       | better-sqlite3 wrapper, 14 repositories, SQL migrations                                                                    |
| IPC       | `src/ipc/`                 | Unix socket daemon↔CLI communication                                                                                       |
| CLI       | `src/cli/`                 | 36 talonctl commands (Commander.js)                                                                                        |

### Key Architectural Decisions

- **neverthrow `Result<T, E>`** everywhere — expected errors are typed, no raw throws across module boundaries. All repository methods return `Result`.
- **SQLite (better-sqlite3)** with WAL mode — single-file, no external DB dependency. Repository pattern allows future migration.
- **Provider runtime runs on host** (not in container) — AgentRunner executes the configured provider strategy. Codex uses the SDK path with `sessionId` persistence; Gemini and Codex use CLI strategies. OpenAI-compatible is normally a stateless Mastra chat-completions wrapper; `options.apiMode: responses` switches that implementation to `/v1/responses`, and `options.sessionMode: previous_response_id` enables stateful response-id session resumption. Persisted resumable sessions are scoped by thread, provider, model, and configured reasoning effort; changing models or effort starts a fresh session and re-injects compressed context instead of resuming an old chain.
- **Provider names can alias implementation types** — provider config keys remain the names personas select and the names persisted in run history. Optional `providers.<name>.type` selects the implementation factory (for example `ollama-mac` with `type: openai-compatible`) so multiple OpenAI-compatible endpoints can coexist.
- **Capability-based security** — default-deny. Persona `capabilities.allow` lists what tools/channels are accessible. `requireApproval` triggers human confirmation.
- **Skills are declarative** — two formats: `skill.yaml` + `prompts/*.md` (legacy) or single `SKILL.md` with YAML frontmatter (preferred). No executable code in skills.
- **Lazy skill loading** — only skill name + description injected into system prompts. Full content loaded on demand via `skill_load` tool (in-process MCP server for Codex SDK, external MCP server for Gemini CLI, Codex CLI, and openai-compatible). Per-skill `eager: true` opt-in in frontmatter forces the body into the system prompt at startup (use for reflexive skills on small models). Background agents use eager loading.
- **Internal MCP server prefix** — `__talond_` prefix is reserved for internal MCP servers (`__talond_host_tools`, `__talond_skill_loader`). User-defined servers with this prefix are rejected.
- **Multi-connector** — Multiple connector instances of the same channel type are supported. Channels are keyed by `name` (unique), not `type`. Slack and Discord filter all bot messages at the platform level; Telegram filters sibling Talon bot IDs injected at startup; WhatsApp Baileys uses JID-based self-filtering. WhatsApp Business has no bot-self filtering.
- **Per-persona background-agent override** — personas may set `backgroundProvider` and `backgroundModel` to route their background runs through a different runtime than the foreground `provider`. Validated at config load: `backgroundProvider` must be enabled under `backgroundAgent.providers`. When unset, the persona's foreground `provider` is used iff it is enabled in the background registry; otherwise the daemon falls back to `backgroundAgent.defaultProvider`.
- **Lifecycle telemetry is correlated** — the lifecycle runtime emits bounded audit/metric evidence across publication, interceptor decisions, handler delivery, retry/dead-letter, and signal handoff; Langfuse observations are created for publication and handler delivery where trace context can be correlated. Handler traceparents must be propagated through native and sub-agent lifecycle execution; optional trace-evidence providers are advisory and validate W3C `traceparent` values before use.

### Database

Schema in `src/core/database/migrations/001-initial-schema.sql`. Key tables: `channels`, `personas`, `bindings` (channel↔persona routing), `threads`, `messages`, `queue_items`, `runs`, `schedules`, `memory_items`, `artifacts`, `audit_log`, `tool_results`.

Table names to know: `memory_items` (not `memory`), `schedules` (column `expression` not `cron_expression`).

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

- `selfdoc.md` — Architecture overview written as self-documentation
- `BOARD.md` — Project task tracking
- `config/talond.example.yaml` — Full config reference
- `templates/assistant/system.md` — Default persona system prompt template

## Workflow

### Branching

Always make sure you are in a feature or fix branch before getting to work

### Reviews

Before every commit you need to use the codex skill to ask `gpt-5.5` with xhigh reasoning for a review, address the issues, only if there are no critical, high, or medium issues can the work be committed. Do not use any GPT-5.6 model.
When dealing with PR reviews, always resolve a comment when it's fixed or deemed invalid, always add a comment what you fixed, which commit, or why the comment was invalid

### Documentation

When adding or changing a feature (new channel, new tool, new config option, changed behavior), you MUST update:

1. **README.md** — update the relevant section (channel list, feature list, config reference, etc.)
2. **Codex skills** (`.agents/skills/`) — update any affected setup/add skill so the guided walkthrough matches the current implementation
3. **AGENTS.md** — if the change affects architecture, module layout, or conventions documented here

Do not consider a feature complete until the docs match the code. PR reviewers should check for doc drift.

### Offload work

If you can, offload coding tasks to `gpt-5.5` with high reasoning using the codex skill; only do this for well-defined, tightly scoped tasks. Implementation and remediation agents must never use a model newer than GPT-5.5.
