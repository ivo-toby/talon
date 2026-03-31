# codex provider

## Summary

Add a new `codex-cli` provider that works in both Talon execution paths:

- `agentRunner` for normal foreground thread execution
- `backgroundAgent` for detached background tasks

Foreground Codex runs must persist and resume conversation state across turns. Background Codex runs remain one-shot and ephemeral.

The provider should follow the existing provider architecture instead of introducing Codex-specific branches throughout the daemon. The main new work is a provider adapter, a small generalization of CLI session handling, Codex-aware provider testing, and documentation updates.

## Goals

- Support `codex-cli` in both `agentRunner.providers` and `backgroundAgent.providers`
- Persist and resume Codex foreground sessions across thread turns
- Keep Talon in control of trust and isolation
- Keep Codex state separate from the operator's normal `~/.codex` home
- Translate Talon's canonical MCP server definitions into Codex-native config
- Reuse the existing provider registry, run persistence, and background task plumbing

## Non-goals

- No live foreground streaming of Codex tool/command events in v1
- No new database schema changes
- No arbitrary custom HTTP header support for Codex MCP servers
- No provider-specific UI beyond the existing CLI-provider waiting message flow

## Current context

Talon already has two provider implementations:

- `claude-code` via the Claude Agent SDK for foreground, plus CLI invocation for background tasks
- `gemini-cli` via CLI invocation for both foreground and background tasks

The core provider seam already exists:

- `AgentProvider` defines execution strategy creation, background invocation preparation, background result parsing, and normalized context usage estimation
- `ProviderRegistry` wires configured provider names to provider factories
- `AgentRunner` resolves the effective provider per thread and persists `provider_name` plus `session_id` on runs
- `BackgroundAgentManager` resolves the effective provider and delegates process preparation to the provider adapter

The current `AgentRunner` assumes only SDK providers support session resumption. Codex changes that assumption because it is a CLI provider with resumable sessions.

## Verified Codex CLI behavior

The design is based on local verification against the installed Codex CLI on March 31, 2026.

### Non-interactive execution

`codex exec --json` emits JSONL events. A minimal successful run produced:

- `thread.started` with `thread_id`
- `turn.started`
- one or more `item.*` events
- `turn.completed` with usage

`-o/--output-last-message` writes the final assistant message to a file and is the most reliable source for the final text response.

### Session resume

`codex exec resume <thread_id> ... --json` accepts the `thread_id` from a previous `thread.started` event and continues the same conversation. The resumed run emits the same `thread_id`.

This makes Codex compatible with Talon's existing persisted `session_id` column.

### Codex home isolation

Running Codex with `HOME=<temp-dir>` causes it to keep its `.codex` state under that home directory. Copying only `auth.json` into the isolated `.codex` home is sufficient for successful authenticated runs.

This means Talon can safely isolate provider-managed Codex state from the operator's real `~/.codex`.

### MCP config shape

Codex stores MCP configuration in `.codex/config.toml`.

Verified stdio shape:

```toml
[mcp_servers.demo]
command = "node"
args = ["demo-server.js", "--port", "7777"]

[mcp_servers.demo.env]
TOKEN = "abc"
```

Verified remote shape:

```toml
[mcp_servers.remote]
url = "https://example.test/mcp"
bearer_token_env_var = "DEMO_TOKEN"
```

## Design

### 1. Provider model

Add `CodexCliProvider` at `src/providers/codex-cli-provider.ts`.

It remains a CLI-based provider, but unlike Gemini it must support session persistence for foreground runs.

The provider should expose:

- foreground execution through `codex exec` and `codex exec resume`
- background process preparation through `codex exec --ephemeral`
- JSONL parsing for:
  - final text
  - `thread_id`
  - usage
- normalized context usage based on `input_tokens`

### 2. Execution strategy generalization

Generalize the provider execution strategy types so a CLI strategy may optionally support session resumption.

Current state:

- SDK strategies support session resumption
- CLI strategies do not

Target state:

- session support depends on `supportsSessionResumption`, not on strategy type

This keeps the change local and avoids teaching the rest of the daemon that Codex is a special case.

### 3. Foreground execution

Foreground provider resolution remains unchanged:

1. latest persisted `runs.provider_name` for the thread
2. persona `provider`
3. `agentRunner.defaultProvider`

Codex foreground behavior:

- first turn:
  - run `codex exec`
  - persist returned `thread_id` as `session_id`
- later turns:
  - restore the latest persisted `session_id`
  - run `codex exec resume <thread_id>`
  - persist the returned `thread_id` again

Talon should keep the existing CLI-provider UX:

- send a one-shot `Thinking...` message
- send the final assistant text when the run completes

No live forwarding of `item.started` or `item.completed` events is included in v1.

### 4. Background execution

Background Codex runs stay stateless and ephemeral.

Background invocation behavior:

- use `codex exec`
- pass `--ephemeral`
- do not resume prior sessions
- do not persist a session id for the task

This keeps background tasks isolated and avoids long-lived background Codex state.

### 5. Trust and sandboxing

Codex should run with full trust, matching the other Talon provider integrations and the approved design choice.

Use:

- `--dangerously-bypass-approvals-and-sandbox`
- `--skip-git-repo-check`

Reasoning:

- Talon already controls workspace boundaries and tool exposure
- Talon personas and capability filtering are the primary security boundary
- Talon thread workspaces are not guaranteed to be git repositories

No separate Codex approval flow should be introduced.

### 6. Provider-owned Codex home

Codex must not run against the operator's live `~/.codex` state.

#### Foreground

Use a stable Talon-owned home per thread, for example:

`<dataDir>/providers/codex-cli/threads/<threadId>/home`

That home contains:

- `.codex/auth.json`
- `.codex/config.toml`
- Codex-managed session/state files

This preserves per-thread Codex continuity across daemon restarts and Talon process restarts.

#### Background

Use a temporary home directory created per task and delete it after completion.

#### Seeding

On first use of a provider-owned home:

- create `.codex/`
- copy `~/.codex/auth.json`
- write generated `config.toml`

If the source `auth.json` is missing, fail fast with a clear setup error.

### 7. Generated Codex config

The provider generates `.codex/config.toml` for each Talon-owned Codex home.

The generated config should include:

- `model` when an explicit model or provider default model is available
- workspace trust for the active working directory using the real Codex config shape:
  - `[projects."<cwd>"]`
  - `trust_level = "trusted"`
- translated MCP server definitions

The provider should isolate Codex by setting the spawned process `HOME` to the Talon-owned home root. Codex then reads and writes `.codex/*` underneath that directory.

The provider may preserve only provider-owned settings and should rewrite the generated file on each run rather than attempting to merge arbitrary operator config.

### 8. MCP translation

Talon uses canonical MCP server definitions internally. `CodexCliProvider` translates them into Codex TOML.

#### Stdio

Canonical stdio servers become:

```toml
[mcp_servers.name]
command = "..."
args = ["..."]

[mcp_servers.name.env]
KEY = "VALUE"
```

#### HTTP and SSE

Codex only supports URL plus optional bearer-token indirection in native config.

Supported mapping:

- canonical `http` or `sse` server with no headers:
  - write `url = "..."`
- canonical server with exactly `Authorization: Bearer <token>`:
  - synthesize a provider-owned environment variable
  - write `bearer_token_env_var = "<generated-name>"`

Unsupported mapping:

- custom non-bearer headers
- multiple headers that cannot be represented as bearer-token auth

For unsupported remote MCP definitions, fail fast with a clear provider error. Do not silently drop headers.

#### SDK MCP servers

In-process SDK servers are not usable from Codex CLI and should be skipped, matching Gemini behavior.

### 9. Final output parsing

For foreground and background Codex results:

- final assistant text should come from `--output-last-message` and the provider should always request it
- JSONL should be parsed for metadata:
  - `thread.started.thread_id`
  - `turn.completed.usage`

If the JSONL stream is malformed but the command exits successfully and the last-message file exists, the provider should still return the last message and surface a parsing warning where appropriate.

If both JSONL and last-message extraction fail, return a provider error.

### 10. Context usage normalization

Codex should normalize context usage like Gemini:

- use total `input_tokens` as the available trigger metric
- expose `input_tokens` in `ContextUsage.metrics`

This makes Codex compatible with provider-scoped context management using `triggerMetric: input_tokens`.

### 11. Config surface

No new schema is required.

Codex uses the existing provider config shape:

```yaml
agentRunner:
  defaultProvider: codex-cli
  providers:
    codex-cli:
      enabled: true
      command: codex
      contextWindowTokens: 400000
      options:
        defaultModel: gpt-5.4
      contextManagement:
        enabled: true
        triggerMetric: input_tokens
        thresholdRatio: 0.8
        recentMessageCount: 10
        summarizer: session-summarizer

backgroundAgent:
  defaultProvider: codex-cli
  providers:
    codex-cli:
      enabled: true
      command: codex
      contextWindowTokens: 400000
      options:
        defaultModel: gpt-5.4
```

`options.defaultModel` is provider-specific and should be used when Talon does not pass an explicit model.

### 12. `test-provider` behavior

Extend `talonctl test-provider` with a Codex branch.

Codex provider test steps:

1. run `codex --version`
2. run a minimal `codex exec ... --json -o <temp-file>`
3. parse JSONL for `thread.started` and `turn.completed`
4. confirm the last-message file contains a non-empty response

Treat the provider as working when:

- the binary is reachable
- the command exits successfully
- JSONL is parseable enough to confirm a thread and completed turn
- the last-message file is non-empty

### 13. Code touch points

Expected code changes:

- `src/providers/provider.ts`
- `src/providers/codex-cli-provider.ts`
- `src/providers/index.ts`
- `src/daemon/daemon-bootstrap.ts`
- `src/daemon/agent-runner.ts`
- `src/cli/commands/test-provider.ts`

Likely supporting utility extraction:

- provider-owned Codex home path helpers
- Codex JSONL parsing helpers
- MCP-to-TOML rendering helpers

### 14. Error handling

Fail fast with clear messages for:

- missing `codex` binary
- missing source `~/.codex/auth.json`
- unsupported MCP server header combinations
- invalid or missing final output
- resume requested but prior `session_id` no longer exists in the provider-owned Codex home

Resume failures should behave like other provider failures: the run fails visibly instead of silently switching to a fresh session.

### 15. Testing

Add unit coverage for:

- invocation generation for:
  - fresh foreground Codex runs
  - resumed foreground Codex runs
  - background ephemeral Codex runs
- generated Codex config contents
- MCP TOML translation
- JSONL parsing for:
  - `thread_id`
  - usage
  - final output
- `AgentRunner` session restore/persist behavior for a resumable CLI provider
- bootstrap registration and provider-registry visibility
- `test-provider` Codex smoke behavior

### 16. Documentation

Update docs anywhere Talon currently lists Claude and Gemini as the supported providers.

Required updates:

- `README.md`
- `CLAUDE.md`
- setup/install docs
- configuration reference and examples
- `talonctl` provider-management docs

## Recommended implementation order

1. Add provider adapter tests for `CodexCliProvider`
2. Generalize execution strategy session support
3. Implement `CodexCliProvider`
4. Register `codex-cli` in bootstrap and exports
5. Extend `test-provider`
6. Update docs

## Risks

- Codex JSONL event shapes may change over time
- Codex MCP remote configuration is less expressive than Talon's canonical server shape
- provider-owned Codex homes must be kept deterministic so resume works reliably across restarts

## Decision

Implement `codex-cli` as a resumable CLI provider for foreground runs and an ephemeral CLI provider for background runs, with Talon-owned Codex homes, fail-fast MCP translation, and no v1 streaming UI.
