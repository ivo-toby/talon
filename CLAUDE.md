# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Talon?

Talon (`talond`) is a self-hosted autonomous AI agent daemon (~22K lines TypeScript). It receives messages from humans across multiple channels (Telegram, Slack, Discord, WhatsApp, Email, Terminal), processes them through a durable queue, runs Claude via the Agent SDK, executes tools through capability-gated host-tools, and sends responses back. All data stays on the operator's hardware.

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
  → AgentRunner (Agent SDK with session persistence)
  → Host-Tools Bridge (Unix socket MCP server, capability-filtered)
  → Channel Connector (format + send response)
```

### Source Layout

| Module    | Path                       | Purpose                                                             |
| --------- | -------------------------- | ------------------------------------------------------------------- |
| Daemon    | `src/daemon/`              | Lifecycle state machine, agent runner, bootstrap, watchdog          |
| Channels  | `src/channels/connectors/` | 6 adapters: telegram, slack, discord, whatsapp, email, terminal     |
| Pipeline  | `src/pipeline/`            | Inbound normalization, dedup, routing, persistence                  |
| Queue     | `src/queue/`               | Durable SQLite queue, retry with exponential backoff, dead-letter   |
| Scheduler | `src/scheduler/`           | Cron/interval/one-shot task execution                               |
| Memory    | `src/memory/`              | Per-thread fact/summary/note storage + context assembly             |
| Tools     | `src/tools/`               | 6 host-tools + capability-based filtering via `tool-filter.ts`      |
| MCP       | `src/mcp/`                 | MCP server registry and lifecycle                                   |
| Personas  | `src/personas/`            | Persona config loading + capability merging                         |
| Skills    | `src/skills/`              | Declarative skill bundles with lazy loading (metadata-only in system prompt, full content on demand via `skill_load` tool) |
| SubAgents | `src/subagents/`           | Loader, model resolver, runner for cheap-model sub-agent tasks      |
| Config    | `src/core/config/`         | Zod-validated YAML config loader (`config-schema.ts` is the schema) |
| Database  | `src/core/database/`       | better-sqlite3 wrapper, 14 repositories, SQL migrations             |
| IPC       | `src/ipc/`                 | Unix socket daemon↔CLI communication                                |
| CLI       | `src/cli/`                 | 25 talonctl commands (Commander.js)                                 |

### Key Architectural Decisions

- **neverthrow `Result<T, E>`** everywhere — expected errors are typed, no raw throws across module boundaries. All repository methods return `Result`.
- **SQLite (better-sqlite3)** with WAL mode — single-file, no external DB dependency. Repository pattern allows future migration.
- **Agent SDK runs on host** (not in container) — session persistence via `sessionId` tracked in DB + in-memory cache.
- **Capability-based security** — default-deny. Persona `capabilities.allow` lists what tools/channels are accessible. `requireApproval` triggers human confirmation.
- **Skills are declarative** — two formats: `skill.yaml` + `prompts/*.md` (legacy) or single `SKILL.md` with YAML frontmatter (preferred). No executable code in skills.
- **Lazy skill loading** — only skill name + description injected into system prompts. Full content loaded on demand via `skill_load` tool (in-process MCP server for Claude SDK, external MCP server for Gemini CLI). Background agents use eager loading.
- **Internal MCP server prefix** — `__talond_` prefix is reserved for internal MCP servers (`__talond_host_tools`, `__talond_skill_loader`). User-defined servers with this prefix are rejected.

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
- Node.js 22+ required (uses native `process.loadEnvFile`)

## Testing

Tests in `tests/` using vitest. Coverage thresholds: 80% (branches, functions, lines, statements). Test structure mirrors source: `tests/unit/queue/`, `tests/unit/channels/`, etc.

## Documentation

- `selfdoc.md` — Architecture overview written as self-documentation
- `BOARD.md` — Project task tracking
- `config/talond.example.yaml` — Full config reference
- `personas/assistant/system.md` — Active persona system prompt

## Workflow

### Branching

Always make sure you are in a feature or fix branch before getting to work

### Reviews

Before every commit you need to use the codex skill to ask Gpt-5.4 for a review, address the issues, only if there a no critical, high or medium issues are found the work can be committed.
When dealing with PR reviews, always resolve a comment when it's fixed or deemed invalid, always add a comment what you fixed, which commit, or why the comment was invalid

### Offload work

If you can, offload coding tasks to GPT-5.3-codex-high using the codex skill, only do this for well defined, tightly scoped tasks.
