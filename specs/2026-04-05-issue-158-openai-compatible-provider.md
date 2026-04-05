# Issue 158: OpenAI-Compatible Mastra Provider

## Summary

Add a fourth first-class Talon provider named `openai-compatible` for both:

- foreground/main agent runs via `agentRunner`
- background agent runs via `backgroundAgent`

The provider should preserve the existing provider architecture and allow local or remote OpenAI-compatible endpoints such as Ollama to participate without changing the existing Claude Code, Codex CLI, or Gemini CLI paths.

## Deliverables

- Register `openai-compatible` in both provider registries
- Support `agentRunner.defaultProvider` and `backgroundAgent.defaultProvider` selection
- Add config-driven `options.baseUrl`, `options.defaultModel`, and optional `options.providerId`
- Implement a bundled Mastra-backed wrapper for file tools, bash, and MCP host-tool access
- Add tests for:
  - provider registration
  - config acceptance
  - foreground execution path
  - background execution path
  - provider invocation contract
- Update example configuration and README snippets

## Out Of Scope

- Making `openai-compatible` the default provider
- Replacing existing providers
- General provider-architecture refactors not required by this issue
- Repo-wide lint cleanup unrelated to this change

## Design

### Provider shape

Implement `src/providers/openai-compatible-provider.ts` as a stateless CLI-style provider:

- foreground path uses `createExecutionStrategy()` with `supportsSessionResumption: false`
- background path uses the same invocation preparation logic
- provider output is normalized to Talon `ProviderResult`

This keeps the change aligned with the current provider contract and avoids introducing special-case runner logic.

### Wrapper

Implement a bundled wrapper at `src/providers/openai-compatible/agent-cli/index.ts`.

Responsibilities:

- read stdin JSON payload from the provider
- instantiate a Mastra `Workspace` using local filesystem and local sandbox rooted at the requested cwd
- connect to serialized MCP servers via `@mastra/mcp`
- create a Mastra `Agent` with:
  - workspace tools
  - MCP tools
  - OpenAI-compatible model config
- run a one-shot generation
- emit normalized JSON to stdout

### Config

Use provider-local config for the runtime endpoint and model defaults:

- `providers.<name>.options.baseUrl`
- `providers.<name>.options.defaultModel`
- `providers.<name>.options.providerId`

Also allow fallback to `auth.providers.openai.baseURL` and `auth.providers.openai.apiKey` when present.

### Invocation model

Use `command: node` in config and have the provider resolve either:

- built output: `dist/providers/openai-compatible/agent-cli/index.js`
- source fallback for dev: `node --import tsx/esm src/providers/openai-compatible/agent-cli/index.ts`

This preserves local development ergonomics while keeping production runtime self-contained after build.

## Test Plan

### Red phase

- Add failing tests for:
  - registry/bootstrap support
  - config acceptance
  - provider invocation payload
  - foreground provider path
  - background provider path

### Verification

- Focused provider slice:
  - `npm test -- --run tests/unit/providers/openai-compatible-provider.test.ts tests/unit/providers/provider-registry.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/subagents/background/background-agent-manager.test.ts tests/unit/core/config/config-schema.test.ts`
- Full suite:
  - `npm test`
- Build:
  - `npm run build`
- Lint:
  - targeted provider files clean
  - repo-wide lint currently has unrelated pre-existing failures outside this issue

## Risks

- Mastra wrapper is one-shot and stateless, so it does not provide session resumption parity with Claude/Codex
- Runtime success still depends on real endpoint compatibility and real MCP server behavior outside unit coverage
- Repo-wide lint is not clean on `main`, so lint cannot be used as a branch-only pass/fail gate for this issue
