# Provider-Scoped Context Management Design

## Goal

Refactor Talon's context-rotation system so context management is configured per
`agentRunner` provider, optimized either for latency or cost through explicit
trigger settings, and documented clearly enough that operators can choose the
right policy without reading the code.

## Problem Summary

The current design mixes context settings across two places:

- Top-level `context`:
  - `enabled`
  - `thresholdTokens`
  - `recentMessageCount`
- Per-provider `agentRunner.providers.*`:
  - `contextWindowTokens`
  - `rotationThreshold`

That split creates ambiguity:

- The actual refresh trigger metric is provider-hardcoded rather than
  configurable.
- `recentMessageCount` is global even though context behavior should follow the
  selected provider.
- The session summarizer model is configurable in the subagent manifest, but the
  runtime call path still hardcodes `maxOutputTokens: 4096`.
- The documentation currently frames context rotation mainly as a cost-control
  feature, while the operational need has shifted to latency control as well.

## Non-Goals

- No context management changes for `backgroundAgent.providers`.
- No backwards-compatible loader shim for legacy top-level `context`.
- No dual-mode runtime that tries to optimize latency and cost simultaneously.

## Decision

Adopt provider-scoped context management under `agentRunner.providers.<name>`.

The top-level `context` block is removed entirely.

The runtime configuration is explicit. There is no `mode` enum in config. The
three supported strategies are documented operational profiles, not schema
values:

- `none`
- `latency optimization`
- `cost optimization`

## Proposed Config Shape

```yaml
agentRunner:
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 1000000
      contextManagement:
        enabled: true
        triggerMetric: cache_read_input_tokens
        thresholdRatio: 0.5
        recentMessageCount: 10
        summarizer: session-summarizer
```

### Semantics

- `enabled`
  - `false` disables automatic summarization/rotation for that provider.
- `triggerMetric`
  - Explicit metric used to decide whether to rotate.
  - Initial supported values:
    - `cache_read_input_tokens`
    - `input_tokens`
- `thresholdRatio`
  - Fraction of `contextWindowTokens` that triggers rotation.
- `recentMessageCount`
  - Number of recent messages injected verbatim into a fresh session for this
    provider.
- `summarizer`
  - Subagent name used for transcript summarization.
  - Initial value remains `session-summarizer`.

## Documented Strategy Profiles

These are docs concepts, not enum values in the config schema.

### 1. None

Disable context management entirely:

```yaml
contextManagement:
  enabled: false
```

### 2. Latency Optimization

Rotate earlier, based on resumed-context growth:

```yaml
contextManagement:
  enabled: true
  triggerMetric: cache_read_input_tokens
  thresholdRatio: 0.5
  recentMessageCount: 10
  summarizer: session-summarizer
```

### 3. Cost Optimization

Rotate based on fresh input growth rather than cached-context growth:

```yaml
contextManagement:
  enabled: true
  triggerMetric: input_tokens
  thresholdRatio: 0.5
  recentMessageCount: 10
  summarizer: session-summarizer
```

## Runtime Design

### AgentRunner

`AgentRunner` already selects the effective provider per run. That same selected
provider config becomes the source of truth for context behavior.

Required changes:

- Read `providerEntry.config.contextManagement` after provider selection.
- Skip `ContextRoller.checkAndRotate()` entirely when the provider has
  `contextManagement.enabled === false`.
- Pass the provider's `thresholdRatio` into the roller.
- Pass the provider's effective context settings into context assembly for fresh
  sessions.

### ContextAssembler

`recentMessageCount` can no longer be fixed at bootstrap time. It must be
selected from the active provider's `contextManagement` for the current run.

This requires refactoring the current bootstrap wiring so fresh-session
assembly can use a per-run value instead of a constructor-global value.

### ContextRoller

`ContextRoller` should become a generic summarize-and-rotate mechanism rather
than the owner of policy defaults.

The roller continues to receive normalized `ContextUsage` from the provider, but
the choice of metric to compare must be driven by config rather than hidden in
provider-specific assumptions.

Practical runtime rule:

- Providers expose whichever usage fields they know how to compute.
- `contextManagement.triggerMetric` chooses which one counts.
- If the configured metric is unavailable for the selected provider, fail
  clearly with an actionable error rather than silently falling back.

## Provider Usage Metric Handling

Keep provider normalization, but stop hardcoding policy in the provider itself.

Desired behavior:

- Claude-family providers can expose both:
  - `input_tokens`
  - `cache_read_input_tokens`
- Gemini-style providers can expose `input_tokens`

The policy decision belongs to config, not to `estimateContextUsage()` choosing
the only metric that matters.

One clean approach is to expand normalized context usage into a small metric map,
for example:

```ts
{
  input_tokens: 120000,
  cache_read_input_tokens: 450000,
}
```

Then the runner/roller selects the configured metric by key.

## Session Summarizer Design

The `session-summarizer` subagent remains the summarization implementation.

Required changes:

- Update the subagent manifest from Haiku to Sonnet 4.6.
- Stop hardcoding `maxOutputTokens: 4096` in the bootstrap path.
- Use the subagent manifest's configured `model.maxTokens` value when invoking
  the summarizer.

This restores the manifest as the single source of truth for summarizer model
and output budget.

## Config Validation and Migration

This is a hard break.

Legacy config with a top-level `context` block should fail validation with a
clear migration message that points the operator to `README.md`.

Expected message shape:

```text
Top-level `context` configuration has been removed. Migrate context management
to `agentRunner.providers.<name>.contextManagement`. See README.md.
```

No automatic rewrite or compatibility shim is required.

## Documentation Plan

Documentation needs to do two jobs:

1. Explain the new provider-scoped config shape.
2. Explain the three operational strategies: none, latency optimization, cost
   optimization.

Implementation should update:

- `README.md`
- `docs/setup-guide.md`
- `talond.yaml.example`
- `config/talond.example.yaml`

Implementation should also add a dedicated user-facing doc:

- `docs/context-management.md`

That dedicated doc should cover:

- Why context management exists
- The three supported strategies
- How to choose `triggerMetric`
- How to choose `thresholdRatio`
- Claude-specific guidance for latency vs cost
- Example configs
- Migration note from the removed top-level `context` block

## Testing Plan

### Config Schema and Loader

Add tests for:

- `contextManagement` defaults and validation
- Allowed `triggerMetric` values
- Legacy top-level `context` rejection
- Error message content referencing migration and `README.md`

### AgentRunner

Add tests for:

- Provider-scoped `contextManagement.enabled`
- Provider-scoped `thresholdRatio`
- Provider-scoped `recentMessageCount`
- Metric selection based on `triggerMetric`
- Clear failure when the configured metric is unavailable

### Context Roller and Bootstrap

Add tests for:

- Respecting subagent-configured summarizer output budget
- Using provider-selected context policy instead of bootstrap-global values
- Skipping rotation entirely when disabled

### Documentation

Add or update tests for example config snippets if the repo already validates
example config shapes.

## Trade-Offs

### Advantages

- One place to reason about context behavior: the selected provider config.
- Explicit trigger policy instead of provider-hardcoded assumptions.
- Cleaner mental model for operators.
- Latency and cost strategies are both supported without hidden coupling.
- Summarizer model/output settings come from the subagent manifest instead of
  split sources of truth.

### Costs

- Hard migration for existing installs.
- Small refactor in bootstrap/context assembly because `recentMessageCount`
  stops being global.
- Provider usage reporting likely needs a slightly richer normalized shape.

## Recommendation

Implement the full provider-scoped design with no legacy compatibility layer.

Use explicit config keys:

- `enabled`
- `triggerMetric`
- `thresholdRatio`
- `recentMessageCount`
- `summarizer`

Do not add `mode` to the schema. Keep `none`, `latency optimization`, and
`cost optimization` as documented strategies in `README.md` and
`docs/context-management.md`.
