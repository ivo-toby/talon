# Per-MCP request timeouts and tool-output caps

## Intent and evidence

Make MCP request latency and model-history size configurable per MCP server.
LLM-backed MCP tools such as Glean's `chat` can legitimately take longer than
the default request deadline, while different servers return very different
amounts of data. Talon currently applies both limits at the wrong scope:

- `src/providers/openai-compatible/agent-cli/index.ts` creates `MCPClient`
  without a timeout. `@mastra/mcp` therefore uses its 60,000 ms default for
  every server and every MCP operation, including `listTools` and tool calls.
- The same wrapper applies one provider-level `options.toolOutputCap` to every
  tool. When omitted, its internal default is 4,000 characters.
- The skill MCP definition already is the natural operator-owned boundary for
  server-specific behavior, but its schema and canonical runtime types do not
  carry either setting.
- Mastra supports a `timeout` on each server definition, and its client
  namespaces discovered tools as `serverName_toolName`. Those two existing
  boundaries allow Talon to implement per-server settings without changing the
  MCP protocol or provider APIs.

The motivating symptom is scheduled Heartbeat work reporting Glean timeouts
during an optional seven-day preparation scan. The outer Talon agent query
timeout remains a separate safety boundary (currently ten minutes by default)
and must continue to terminate runs that exceed it.

## Scope

Add two optional fields to each skill MCP definition and carry them through
skill loading, persona runtime assembly, provider serialization, and the
OpenAI-compatible Mastra wrapper:

- `timeoutMs`: per-server MCP operation timeout in milliseconds.
- `toolOutputCap`: maximum number of characters from one tool result that are
  placed into the model's message history. `0` disables excerpting for that
  server.

Update `talonctl add-mcp`, the bundled Glean definition, the main README, the
configuration example, and both Talon setup skills. Add focused tests for
schema validation, propagation, CLI output, timeout serialization, and
per-server output-cap selection.

Do not change the Heartbeat prompt in this feature. Once the runtime setting is
available, an operator can tune Glean or Atlassian independently of unrelated
MCPs.

## Goals

1. Let an operator configure a slow or LLM-backed MCP server without changing
   provider-wide settings or source code.
2. Preserve existing configurations and provider-level `toolOutputCap`
   behavior.
3. Keep the full MCP result available to the current run through the existing
   `fetch_tool_output` mechanism when excerpting is enabled.
4. Make unsupported-provider behavior explicit and safe: providers whose native
   CLI configuration cannot represent these fields ignore them, while the
   OpenAI-compatible/Mastra path honors them.
5. Keep the setting additive and free of database or token-store migrations.

## Non-goals

- Changing the MCP server's own response generation, server-side limits, or
  network transport semantics.
- Making the output cap a hard byte limit on the HTTP response. It only bounds
  content inserted into model history; the raw result is still received and
  retained in memory for the current run.
- Changing the fixed `fetch_tool_output` range limit (currently 8,000
  characters). A separate setting for that recovery slice is out of scope.
- Replacing or removing provider-level `options.toolOutputCap`.
- Adding a global Talon MCP timeout setting. The per-server field is the
  configuration boundary; omitted values retain current defaults.
- Teaching Gemini CLI, Claude Code, or Codex CLI to enforce settings their
  native MCP configuration cannot represent. Their generated configurations
  should simply omit the Talon-only metadata.

## Configuration contract

The skill MCP JSON shape is:

```json
{
  "name": "glean",
  "config": {
    "transport": "http",
    "url": "https://contentful-be.glean.com/mcp/default",
    "timeoutMs": 180000,
    "toolOutputCap": 12000,
    "auth": {
      "kind": "oauth2"
    }
  }
}
```

Both fields are optional and valid for `stdio`, `sse`, and `http` definitions.

### `timeoutMs`

- Type: positive integer, in milliseconds.
- Recommended lower validation bound: 1,000 ms.
- Omitted: preserve the current Mastra default of 60,000 ms.
- Set this high enough for the server's normal latency. A value longer than
  the persona's outer `queryTimeoutMinutes` does not keep a run alive forever;
  the outer query timeout remains authoritative.
- The OpenAI-compatible wrapper maps this field to Mastra's per-server
  `timeout`, which covers `listTools` and individual `callTool` operations.

### `toolOutputCap`

- Type: integer greater than or equal to zero, in characters.
- Omitted: use the provider-level `options.toolOutputCap` when configured;
  otherwise preserve the wrapper default of 4,000 characters.
- `0`: disable excerpting for this MCP server.
- A server value overrides the provider-level fallback for that server's
  namespaced tools. Native workspace tools and non-MCP tools continue to use
  the provider-level/default cap.
- The wrapper retains the full stringified result in its existing in-memory
  `ToolOutputStore`; only the excerpt enters message history.

The bundled Glean definition should set `timeoutMs: 180000` and
`toolOutputCap: 12000` as a concrete starting point for its LLM-backed search
and chat tools. Those values are defaults for the bundled skill, not global
requirements. Atlassian and other MCP definitions can choose their own values.

## Data flow and implementation design

### 1. Domain and loader schema

Extend `McpServerConfig` in `src/mcp/mcp-types.ts` with:

```ts
timeoutMs?: number;
toolOutputCap?: number;
```

Extend the private `McpServerConfigSchema` in `src/skills/skill-loader.ts` with
the same constraints (`z.number().int().min(1000).optional()` for
`timeoutMs`; `z.number().int().min(0).optional()` for `toolOutputCap`). Invalid
values fail while loading the skill, before a provider is started.

### 2. Canonical runtime context

Add the optional fields to `CanonicalMcpStdioServer` and
`CanonicalMcpHttpServer` in `src/providers/provider-types.ts`. In
`buildPersonaRuntimeContext`, copy defined values from the loaded MCP config
into both stdio and remote canonical entries. `resolveMcpServers()` must
preserve these metadata fields while it materializes OAuth headers.

Do not put these fields into the MCP request headers or auth object. They are
Talon runtime metadata, not server-facing protocol parameters.

### 3. OpenAI-compatible provider boundary

The provider's serializable MCP type and wrapper input validator must accept
the two optional fields and preserve them when constructing the child-process
payload. Existing provider-level `toolOutputCap` remains a separate payload
field and remains backward-compatible.

In `toMastraMcpServers()`:

- pass `timeoutMs` as Mastra server option `timeout` for stdio and HTTP/SSE
  server definitions;
- do not pass `toolOutputCap` to Mastra, because it is Talon-side history
  handling and not a transport option.

Mastra's global `MCPClient` timeout remains the fallback for entries without a
server-specific `timeout`. Do not set a new global constant in this change.

### 4. Per-server output-cap selection

Build a map of configured MCP server names to their optional output caps in the
wrapper. Mastra's `MCPClient.listTools()` returns namespaced tool keys of the
form `serverName_toolName`; select a server override when the tool name starts
with that exact `serverName + "_"` prefix. The selection must support server
names containing underscores; do not split on the first underscore and assume
the remainder is the server name. Prefer the longest matching configured
server-name prefix if multiple names could match.

Refactor `wrapToolsWithOutputCap()` to resolve a cap per tool:

1. use the matching MCP server's `toolOutputCap` when it is defined;
2. otherwise use the provider-level `toolOutputCap` when defined;
3. otherwise use `DEFAULT_TOOL_OUTPUT_CAP` (4,000).

If every effective cap is zero or excerpting is otherwise disabled, preserve
the current behavior of not registering `fetch_tool_output`. If at least one
tool has a positive cap, register the synthetic tool and wrap all tools; a
zero-cap tool passes its full result through while another server can still
use ranged recovery.

Keep existing error handling: error-flagged MCP results are never truncated,
and tool-output metadata emitted in `tool_event` remains accurate for the
effective per-tool cap.

### 5. CLI and documentation

Extend `AddMcpOptions`, validation, and `talonctl add-mcp` with:

- `--timeout-ms <ms>`
- `--tool-output-cap <chars>`

The CLI must reject non-integer values, timeout values below 1,000 ms, and
negative output caps. It should omit unset fields from the generated JSON and
write the numeric values under `config` when supplied.

Document the fields and precedence in:

- `README.md` MCP integration/configuration sections;
- `config/talond.example.yaml` if it contains MCP examples;
- `.agents/skills/talon-setup/SKILL.md`;
- `.agents/skills/talon-setup-docker/SKILL.md`.

Include examples for an LLM-backed remote server and explain that the output
cap bounds model-history injection, not the MCP network response.

## Compatibility and rollout

- Existing skill MCP JSON files remain valid because both fields are optional.
- Existing OpenAI-compatible provider configs with `options.toolOutputCap`
  retain their current behavior.
- Existing users who do not set either field see the current 60-second Mastra
  fallback and 4,000-character wrapper fallback.
- No SQLite migrations, OAuth changes, schedule changes, or daemon data
  migrations are needed.
- The bundled Glean values provide an immediate fix after the next Talon build.
  Existing Docker installations must rebuild or update the copied skill JSON
  to receive the bundled values.

## Testing and acceptance

### Schema and propagation

1. Skill-loader tests accept valid `timeoutMs` and `toolOutputCap` values and
   reject fractional, negative, and too-small values.
2. Persona runtime-context tests assert that both fields are copied for stdio
   and remote servers, and absent fields remain absent.
3. OAuth resolution tests assert that resolving a bearer token preserves both
   fields while replacing only auth/header data.

### CLI and provider payload

4. `add-mcp` tests assert that flags are written as numbers under `config`,
   unset values are omitted, and invalid values fail with actionable errors.
5. OpenAI-compatible provider tests assert that per-server fields survive the
   provider-to-wrapper JSON payload, while native provider serializers omit
   Talon-only fields from their generated CLI configs.

### Wrapper behavior

6. A pure helper test covers longest-prefix server matching, server override,
   provider fallback, default fallback, and a zero-cap override.
7. Existing output-excerpt tests continue to cover truncation, error passthrough,
   and `fetch_tool_output` storage. Add one test proving that a positive cap on
   one MCP server does not impose that cap on a zero-cap server.
8. Run targeted Vitest files, `npm run lint`, and `npm run build`. A full test
   suite is optional unless the implementation changes shared test fixtures.

### Manual sanity check

With a disposable OpenAI-compatible wrapper input containing two fake MCP
servers, verify that:

- the slow server receives its configured Mastra timeout;
- the two servers' tool results use their respective caps;
- an oversized result produces the existing truncation marker and remains
  recoverable with `fetch_tool_output`;
- a zero-cap server's result is passed through unchanged.

Do not claim that a live Glean or Atlassian request succeeded unless the
operator's authenticated runtime is available; the local tests validate the
configuration and wrapper boundaries only.

## Implementation checklist for the next agent

- [ ] Create an implementation branch from this spec branch.
- [ ] Update domain/schema/canonical types and runtime propagation.
- [ ] Add OpenAI-compatible timeout mapping and per-server cap selection.
- [ ] Extend `talonctl add-mcp` and documentation/setup skills.
- [ ] Update bundled Glean MCP settings.
- [ ] Add focused tests and run lint/build/targeted tests.
- [ ] Request an independent GPT-6-sol review before the implementation commit,
      per repository workflow.
- [ ] Re-check the Docker starter/release bundle includes the updated skill
      definition before publishing a release.
