# Documentation Gap Report

Generated from cross-referencing all merged PRs against current docs.

## Features with no docs at all

### 1. `.env` file loading (`--env-file` flag, `TALOND_ENV_FILE`)
**PR:** #1
**Gap:** The daemon supports `--env-file` flag and `TALOND_ENV_FILE` env var for custom `.env` paths. Docs mention `.env` loading but not the flag or env var.
**Should go in:** `getting-started/configuration.mdx` (env vars section), `reference/talonctl.mdx`

### 2. `talonctl init-persona` command
**PR:** #98
**Gap:** New CLI command that copies persona templates from `templates/` to `personas/`. Not documented anywhere.
**Should go in:** `reference/talonctl.mdx`

### 3. Persona `queryTimeoutMinutes` config
**PR:** #118
**Gap:** Per-persona query timeout (default 10 min, max 480 min). Not in config-schema or persona docs.
**Should go in:** `reference/config-schema.mdx`, `guides/personas.mdx`

### 4. Context rotation `enabled` flag
**PR:** #62
**Gap:** `context.enabled` flag to disable rotation entirely (useful for Claude Max subscribers). Not documented.
**Should go in:** `guides/context-management.mdx`, `reference/config-schema.mdx`

### 5. Named memory keys (distributed memory updates)
**PR:** #86
**Gap:** Memory updates from session summarizer are now written to properly namespaced keys (e.g. `work:agent-zero`) instead of UUID blobs. Docs describe old UUID-based approach.
**Should go in:** `guides/memory.mdx`

### 6. Agent time injection
**PR:** #47
**Gap:** Every agent run gets a current timestamp injected into context. Not documented.
**Should go in:** `guides/personas.mdx` or `reference/host-tools.mdx`

### 7. Sprites/execution environment foundations
**PR:** #119
**Gap:** New `sprites` config section, `executionEnv` per-persona config, execution environment MCP tool. Not documented.
**Should go in:** New page `guides/execution-environments.mdx`, `reference/config-schema.mdx`

### 8. A2A internal routing protocol
**PR:** #120
**Gap:** Internal persona-to-persona A2A routing, `a2a_tasks` table, collaboration queue priority. Only `persona_send` and `persona_list` tools are documented, but the underlying A2A architecture is not.
**Should go in:** New page `guides/a2a-protocol.mdx`

### 9. Observability / Langfuse improvements
**PRs:** #65, #72, #95, #97
**Gap:** Langfuse config documented, but practical usage, trace structure, `owner` field semantics, background agent tracing, and sub-agent span propagation are not covered.
**Should go in:** New page `guides/observability.mdx`

### 10. Prompt cache token tracking
**PR:** #11
**Gap:** Cache read/write tokens are extracted and persisted per run. Referenced in token-usage.mdx but extraction process not explained.
**Should go in:** `reference/token-usage.mdx`

### 11. `talonctl backup` includes config, personas, and skills
**PR:** #112
**Gap:** Backup now creates a full timestamped directory with DB + config + personas + skills. Current docs mention backup but don't describe the full scope.
**Should go in:** `reference/talonctl.mdx`

### 12. MCP `headers` support for HTTP/SSE servers
**PR:** #49
**Gap:** MCP servers can now have `headers` with env var resolution. Mentioned in skills.mdx config fields list but not explained.
**Should go in:** `guides/mcp-integration.mdx`, `guides/skills.mdx`

## Features with partial docs

### 1. Gemini CLI provider
**PR:** #61
**Gap:** Config schema and background agent docs show Gemini config, but there's no dedicated section explaining Gemini provider setup, limitations, thread-level provider affinity.
**Should go in:** `getting-started/configuration.mdx` or new section in providers

### 2. Slack Socket Mode
**PR:** #16
**Gap:** Channels doc mentions `appToken` for Socket Mode but doesn't explain the auto-reconnect behavior or setup steps.
**Should go in:** `guides/channels.mdx` (Slack section)

### 3. WhatsApp Business webhook server
**PR:** #99
**Gap:** Config fields documented but the embedded webhook server behavior (signature validation, two modes) needs more detail.
**Should go in:** `guides/channels.mdx` (WhatsApp Business section)

### 4. `showToolCalls` formatting details
**PR:** #109
**Gap:** Field documented but the emoji formatting, known server list, and internal `__talond_*` server suppression are not.
**Should go in:** `guides/channels.mdx`

### 5. Scheduler `delete` vs `cancel` distinction
**PR:** #64
**Gap:** Both actions listed in scheduling docs but the distinction could be clearer.
**Should go in:** `guides/scheduling.mdx`

### 6. Background agent `profile` and `provider` parameters
**PR:** #101
**Gap:** Documented in host-tools and background-agents but the model passthrough behavior is not mentioned.
**Should go in:** `guides/background-agents.mdx`

### 7. Personality folder prompt assembly order
**PR:** #9
**Gap:** Persona docs mention personality files but the exact assembly order is incomplete.
**Should go in:** `guides/personas.mdx`

### 8. Schedule `promptFile` resolution
**PR:** #55
**Gap:** Documented but the re-entry guard and daemon-reload behavior of prompt files are not mentioned.
**Should go in:** `guides/scheduling.mdx`

## No changes needed (already well-documented)

- Terminal channel (#5) — fully documented
- Per-persona tool restrictions (#3) — fully documented
- Schedule CLI commands (#10) — fully documented
- Sub-agent system (#12) — fully documented
- Rolling context window (#13) — fully documented
- Session resume across restarts (#7) — internal fix, no user-facing docs needed
- Compound PK fix (#6) — internal fix
- CLI cleanup (#8) — CLI reference is complete
- Zod v3→v4 (#15) — internal change
- Config name optional in MCP (#48) — internal fix
- Log level at bootstrap (#71) — `logLevel` config documented
- Provider-scoped context management (#73) — fully documented
- marked downgrade (#113) — internal dep fix
- Baileys dependency fix (#111) — internal dep fix
- Setup bugs (#110) — internal fix
- CLI flag fix (#105) — internal fix
- One message per text block (#107) — internal behavior
