# Context Management

Talon supports provider-scoped context management for `agentRunner` providers.
This is the mechanism that decides when to rotate a long-running session, write
a compressed summary, and start the next run with a fresh session plus selected
history.

## Config Shape

Context management lives under `agentRunner.providers.<name>.contextManagement`.

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

Fields:

- `enabled`: turns automatic summarize-and-rotate on or off for that provider
- `mode`: `summarizer` for single-summary rotation, or `observation` for
  observer/reducer-based long-term context
- `triggerMetric`: the metric used to decide when to rotate
- `thresholdRatio`: fraction of `contextWindowTokens` that triggers rotation
- `recentMessageCount`: recent verbatim messages injected into a fresh session
- `summarizer`: subagent name used to summarize the transcript in
  `mode: summarizer`
- `observer` / `reducer`: subagent names used by `mode: observation`

## Strategies

### None

Disable context management completely:

```yaml
contextManagement:
  enabled: false
```

Use this when you want uninterrupted session resumption and are willing to
accept higher latency or larger resumed sessions.

### Latency Optimization

Rotate based on resumed-context growth:

```yaml
contextManagement:
  enabled: true
  triggerMetric: cache_read_input_tokens
  thresholdRatio: 0.5
  recentMessageCount: 10
  summarizer: session-summarizer
```

This is the recommended Claude Code profile when resumed sessions start getting
slow. It rotates before the cached session grows too large.

### Cost Optimization

Rotate based on fresh input growth instead of cache reads:

```yaml
contextManagement:
  enabled: true
  triggerMetric: input_tokens
  thresholdRatio: 0.5
  recentMessageCount: 10
  summarizer: session-summarizer
```

Use this when you care more about token cost behavior than latency, especially
for providers where cached-context cost is low or unavailable.

### Codex Latency Optimization

Rotate based on Codex cached prompt reuse:

```yaml
contextManagement:
  enabled: true
  triggerMetric: cache_read_input_tokens
  thresholdRatio: 0.8
  recentMessageCount: 10
  summarizer: session-summarizer
```

Codex CLI reports cached prompt reuse as `cached_input_tokens`. Talon
normalizes that into `cache_read_input_tokens`, which makes it the best signal
when you want to rotate before resumed Codex requests get slow.

## Choosing `triggerMetric`

- `cache_read_input_tokens`:
  Best for latency control on Claude Code. It tracks resumed-session growth.
  Codex CLI also exposes this metric via its `cached_input_tokens` usage field,
  normalized by Talon as `cache_read_input_tokens`.
- `cache_creation_input_tokens`:
  Tracks the new cache written by the current Claude run.
- `cache_total_input_tokens`:
  Tracks total Claude cached context after the run (`cache_read_input_tokens` +
  `cache_creation_input_tokens`). This is the best signal when you want
  rotation to follow total cached session footprint.
- `input_tokens`:
  Best when you want the policy tied to fresh prompt size instead of cached
  context size. This also works for providers that do not report cache-read
  metrics.

If you configure a metric the selected provider does not expose, Talon logs an
error and skips rotation for that run instead of silently falling back.

## Choosing `thresholdRatio`

- Lower values rotate earlier.
- Higher values keep sessions longer.
- `0.5` is a good starting point for latency-oriented Claude sessions.
- `0.8` is a more conservative starting point when you want fewer rotations.

The effective threshold is:

```text
selected_metric / contextWindowTokens >= thresholdRatio
```

## Summarizer

The default summarizer is `session-summarizer`. Its manifest now uses
`claude-sonnet-4-6`, and Talon respects the manifest's `model.maxTokens` value
when invoking it.

## Migration

The old top-level `context` block has been removed.

This no longer works:

```yaml
context:
  thresholdTokens: 80000
  recentMessageCount: 10
```

Existing configs with a top-level `context` block fail validation and must be
migrated to `agentRunner.providers.<name>.contextManagement`. See
[README.md](../README.md) for updated examples.

If an existing observational-memory config uses the old shorthand:

```yaml
contextManagement:
  enabled: true
  summarizer: session-observer
```

Talon still translates it at load time to explicit observation mode for
compatibility. New configs should spell out the handlers:

```yaml
contextManagement:
  enabled: true
  mode: observation
  triggerMetric: input_tokens
  thresholdRatio: 0.75
  recentMessageCount: 10
  observer: session-observer
  reducer: session-reflector
```
