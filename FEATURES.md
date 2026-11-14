# Talon Features

Comprehensive feature inventory as of 2026-03-14.

---

## Communication Channels

Talon connects to multiple messaging platforms simultaneously. Each channel has its own connector, formatting pipeline, and idempotency handling.

| Channel    | Transport              | Inbound            | Outbound           | Status           |
| ---------- | ---------------------- | ------------------ | ------------------ | ---------------- |
| Telegram   | Long polling           | `getUpdates`       | MarkdownV2         | Production       |
| Slack      | Socket Mode            | Events API         | mrkdwn             | Production       |
| Terminal   | WebSocket              | `talonctl chat`    | Raw markdown       | Production       |
| Discord    | Gateway + REST         | `feedEvent()`      | Discord markdown   | Send only        |
| WhatsApp   | Cloud API + webhook    | `feedWebhook()`    | WhatsApp markdown  | Send only        |
| Email      | IMAP polling + SMTP    | IMAP fetch         | HTML               | Untested         |

### Channel features

- Per-channel idempotency keys prevent duplicate message processing
- Thread mapping preserves conversation continuity across messages
- Markdown output auto-converted to each platform's native format
- Channel-scoped capability labels (`channel.send:<name>`) control which personas can send where
- Terminal channel supports `--persona` flag for runtime persona switching, persistent threads via `clientId`, and rendered markdown output with typing indicators

---

## Persona System

Personas are independent AI agent profiles, each with their own identity, model, tools, and security policy.

- **System prompt** from `personas/<name>/system.md`
- **Personality fragments** from `personas/<name>/personality/*.md`, concatenated in sort order
- **Task prompt files** from `personas/<name>/prompts/*.md`, loaded on demand for scheduled tasks
- **Model selection** per persona (e.g., `claude-sonnet-5-5`)
- **Skill attachment** with capability intersection at runtime
- **Sub-agent assignment** with explicit persona-level grants
- **MCP server binding** per persona via `talonctl add-mcp`
- **Channel bindings** managed separately via `talonctl bind` with default persona per channel
- **Concurrency limits** per persona (`maxConcurrent`)
- **Hot reload** without daemon restart

---

## Security

### Capability-based access control

Default-deny policy engine. Every tool call is checked against the persona's capability grants before execution.

| Capability               | Controls                                |
| ------------------------ | --------------------------------------- |
| `channel.send:<channel>` | Send messages to a specific channel     |
| `schedule.manage`        | Create/modify/delete scheduled tasks    |
| `memory.access`          | Read/write per-thread structured memory |
| `net.http`               | Fetch external URLs                     |
| `db.query`               | Execute read-only database queries      |
| `subagent.invoke`        | Invoke sub-agents for delegated tasks   |
| `subagent.background`    | Launch and manage background workers    |
| `fs.read`                | Read files from the filesystem          |
| `fs.write`               | Write files to the filesystem           |

### Approval gates

Capabilities listed under `requireApproval` prompt the user in-channel for confirmation before the tool executes. Configurable timeout.

### Audit logging

Every side-effecting operation is recorded in the `audit_log` table with full provenance: tool name, persona, thread, result, timestamp.

### Database query isolation

Agents can query SQLite via `db.query`, constrained by five independent layers:

1. Regex pre-check (SELECT only, no write keywords)
2. Table whitelist (4 approved tables)
3. Thread/persona scoping (auto-injected WHERE clauses)
4. Row limit (1,000 max)
5. Read-only connection (`{ readonly: true }`)

Complex SQL patterns (UNION, subqueries, CTEs) are rejected.

### Secrets management

- `${ENV_VAR}` substitution in `talond.yaml`
- `.env` file loaded at startup
- `talonctl config-show` masks secrets
- `talonctl env-check` audits for missing variables

---

## Durable Message Queue

SQLite-backed FIFO queue with crash recovery.

- **FIFO per thread** with cross-thread parallelism
- **Crash recovery** on restart (in-flight items reset to pending)
- **Exponential backoff** with jitter (base 1s, max 60s, configurable)
- **Dead-letter queue** after max attempts (default 3)
- **Concurrency limits** configurable globally and per-persona
- **Queue purge** via `talonctl queue-purge` (by status or all)

---

## Scheduling

Agent-managed scheduling via the `schedule.manage` host tool. The daemon ticks every 5s (configurable) and fires due schedules.

| Type     | Expression    | Behavior                  |
| -------- | ------------- | ------------------------- |
| Cron     | `0 9 * * *`  | Standard cron expressions |
| Interval | `30000`      | Recurring at fixed ms     |
| One-shot | (future time) | Single execution          |

### Task prompt files

Schedules can reference reusable markdown files from `personas/<name>/prompts/` via the `promptFile` parameter instead of embedding inline prompts.

- Files indexed by basename (without `.md`) at persona load time
- Contents read on demand when the schedule fires
- Edits take effect on next execution without restart
- `prompt` and `promptFile` are mutually exclusive
- `talonctl add-persona` scaffolds an empty `prompts/` directory

---

## Sub-Agent System

Offloads mechanical LLM tasks to cheap models. The main agent delegates via `subagent_invoke`, and the daemon handles model resolution, capability validation, and execution with timeout.

### Built-in sub-agents

| Sub-Agent            | Model      | Purpose                                            |
| -------------------- | ---------- | -------------------------------------------------- |
| `session-summarizer` | Sonnet 5.5 | Compress transcripts into structured summaries     |
| `memory-groomer`     | Haiku 5.5  | Consolidate/prune stale memory items               |
| `memory-retriever`   | Haiku 5.5  | Find relevant memories via keyword + LLM reranking |
| `file-searcher`      | Haiku 5.5  | Search files with rg/grep/node cascade + LLM rank  |

### Sub-agent features

- Three load locations (built-in, project-level, data directory) with override precedence
- Multi-provider model resolution (Anthropic, OpenAI, Google, Ollama) via Vercel AI SDK
- Capability-gated: sub-agents declare `requiredCapabilities`, validated against persona grants
- Persona-scoped: personas declare which sub-agents they can invoke
- CLI testing: `talonctl run-subagent` runs any sub-agent without a running daemon
- Custom sub-agents via `subagent.yaml` manifest + `index.ts` entry point

---

## Background Agent Workers

Long-running Claude Code CLI workers for tasks that should not block the foreground conversation.

- Foreground agent starts a worker via `background_agent` tool, gets a task ID immediately
- Workers inherit persona prompt and external MCP servers from assigned skills
- Workers do not get Talon's host-tools MCP server (no recursive spawning, no direct messaging)
- Durable lifecycle tracked in SQLite: completion, failure, timeout, cancellation
- Completion messages flow back through the queue to the originating thread
- Configurable concurrency limit and wall-clock timeout
- Requires `subagent.background` capability

---

## Rolling Context Window

Automatic session rotation when the Agent SDK's context window fills up.

- Monitors `cacheReadTokens` after each agent run
- Triggers by provider rotation ratio, with legacy fallback via `context.thresholdTokens`
- Calls `session-summarizer` to compress the transcript
- Stores summary as a `memory_items` entry (type `summary`)
- Clears session; next run starts fresh with injected context:
  - Latest session summary
  - Last N messages verbatim (configurable via `context.recentMessageCount`)
- Daemon-side: the agent never knows its session was rotated
- Summaries are subject to `memory-groomer` consolidation over time

---

## Memory System

Per-thread persistent storage across four layers.

| Layer             | Storage              | Description                                     |
| ----------------- | -------------------- | ----------------------------------------------- |
| Transcript        | `messages` table     | Canonical message log, append-only              |
| Working memory    | In-prompt context    | Recent message window included in agent prompts |
| Thread notebook   | Filesystem           | Human-editable per-thread notes                 |
| Structured memory | `memory_items` table | Extracted facts and summaries, agent-managed    |

- Memory writes gated by `memory.access` capability
- Thread workspaces persist at `data/threads/<thread_id>/`
- Structured memory supports types: `fact`, `summary`, `note`

---

## Skills

Declarative capability bundles that snap onto personas. No executable code.

```
skills/<skill_name>/
  skill.yaml          # metadata, required capabilities, config schema
  prompts/*.md        # prompt fragments injected into the persona
  tools/*.yaml        # tool manifests with capability labels
  mcp/*.json          # MCP server definitions
  migrations/*.sql    # database migrations
```

- Capability intersection: `granted = persona.capabilities ∩ skill.requiredCapabilities`
- Skills with unmet capabilities produce a warning at startup and are skipped
- Scaffold via `talonctl add-skill --name <n> --persona <p>`

---

## MCP Integration

External tool servers connected to personas via the Model Context Protocol.

- Per-persona MCP server binding
- Stdio transport
- Rate limiting (token bucket) per server
- Policy-checked before forwarding tool calls
- Added via `talonctl add-mcp`

---

## Host-Tools MCP Bridge

Seven built-in tools exposed to agents over a Unix socket. The daemon mediates all side effects.

| Tool                | Capability            | Description                                     |
| ------------------- | --------------------- | ----------------------------------------------- |
| `schedule_manage`   | `schedule.manage`     | CRUD + list schedules, supports `promptFile`    |
| `channel_send`      | `channel.send:<ch>`   | Send messages to channel connectors             |
| `memory_access`     | `memory.access`       | Read/write/delete per-thread structured memory  |
| `net_http`          | `net.http`            | Fetch external URLs with domain allowlist       |
| `db_query`          | `db.query`            | Read-only database queries with 5-layer safety  |
| `subagent_invoke`   | `subagent.invoke`     | Invoke sub-agents by name with structured input |
| `background_agent`  | `subagent.background` | Launch long-running Claude Code workers         |

---

## Token Usage Tracking

- Records input/output/cache tokens per agent run in the `runs` table
- `total_cost_usd` from Agent SDK results
- Per-persona budget limits planned

---

## CLI (`talonctl`)

25 commands for daemon management, configuration, and operations.

### Daemon

| Command              | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `status`             | Daemon health, active channels, queue depth, token usage      |
| `reload`             | Hot-reload config without restart                             |
| `chat`               | Connect to a persona via the terminal channel                 |

### Setup and configuration

| Command              | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `setup`              | First-time interactive setup                                  |
| `add-channel`        | Add a channel connector to config                             |
| `add-persona`        | Scaffold persona directory (system.md, personality/, prompts/) |
| `add-skill`          | Scaffold a skill and attach to a persona                      |
| `add-mcp`            | Add an MCP server to a persona                                |

### Management

| Command              | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `list-channels`      | List all configured channels                                  |
| `list-personas`      | List all configured personas                                  |
| `list-skills`        | List all skills across personas                               |
| `bind`               | Bind a persona to a channel                                   |
| `unbind`             | Remove a persona-channel binding                              |
| `remove-channel`     | Remove a channel and its bindings                             |
| `remove-persona`     | Remove a persona, its directory, and bindings                 |
| `env-check`          | Audit config for missing `${ENV_VAR}` placeholders            |
| `config-show`        | Display resolved config with secrets masked                   |

### Operations

| Command              | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `migrate`            | Apply pending database migrations                             |
| `backup`             | Snapshot SQLite database and data directory                    |
| `doctor`             | Diagnostic checks (OS, Node, Docker, dirs, config, DB, refs)  |
| `queue-purge`        | Purge queue items by status                                   |
| `run-subagent`       | Test a sub-agent without a running daemon                     |

---

## Database

SQLite with WAL mode and foreign keys. Repository pattern for future Postgres portability.

| Table          | Purpose                                          |
| -------------- | ------------------------------------------------ |
| `channels`     | Channel connector configs                        |
| `personas`     | Agent profiles                                   |
| `bindings`     | Channel/thread to persona routing                |
| `threads`      | Conversation threads                             |
| `messages`     | Full message history                             |
| `queue_items`  | Durable work queue                               |
| `runs`         | Agent execution records with token usage         |
| `schedules`    | Cron/interval/one-shot job definitions           |
| `memory_items` | Structured per-thread memory                     |
| `artifacts`    | Agent output files                               |
| `audit_log`    | Append-only audit trail                          |
| `tool_results` | Idempotent tool result cache                     |

- Versioned SQL migrations in `src/core/database/migrations/`
- 12 repository classes with typed `Result<T, E>` returns
- `talonctl migrate` applies pending migrations

---

## Deployment

### Native daemon (systemd)

- systemd service unit with security hardening (NoNewPrivileges, PrivateTmp, SystemCallFilter, etc.)
- Auto-restart on failure, auto-start on boot
- Watchdog heartbeat integration
- Graceful shutdown on SIGTERM/SIGINT
- Install script: `deploy/install-service.sh`

### Wake-only mode (timer)

- systemd timer wakes the daemon periodically (default 5 min)
- Processes queue, then exits
- For low-traffic deployments

### Docker (planned)

- Dockerfiles for daemon and agent sandbox exist in `deploy/`
- Goal: blast-radius isolation for Agent SDK execution
- Host-mode path remains as fallback

---

## Developer experience

- TypeScript strict mode, ES2022 target, Node16 module resolution
- Path alias `@talon/*` maps to `src/*`
- ESLint with no-floating-promises, explicit return types
- Prettier formatting
- `neverthrow` Result types across all module boundaries
- Structured logging via pino
- `tsx` watch mode for development (`npm run dev`)
- Test suite (vitest) with 80% coverage thresholds
- Zod-validated YAML configuration with `${ENV_VAR}` substitution

---

## Error handling

- 16 typed error classes in `src/core/errors/`
- `neverthrow` Result<T, E> throughout: no raw throws across module boundaries
- Every repository method returns a Result
- Structured error logging with pino context
