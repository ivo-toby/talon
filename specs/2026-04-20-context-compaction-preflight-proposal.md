# Context Compaction Preflight Proposal

## Problem

Context rotation currently triggers only after a provider run completes. That is intentional for UX reasons, but it creates an avoidable failure mode for stateless providers:

- the next turn can start with a very large assembled prompt
- Langfuse correctly records that oversized input
- only after the run completes does Talon learn that it should have rotated earlier

This means the first overshoot is paid in full before the system reacts.

## Goals

- Preserve the current UX model: do not interrupt an in-flight provider invocation for compaction.
- Reduce or eliminate first-run overshoot for stateless providers.
- Keep the design provider-agnostic where possible.
- Avoid introducing a second, more complicated scheduler inside a single agent invocation.

## Proposal

### 1. Add a preflight compaction gate before provider invocation

Before `executeAgentQuery()` starts, Talon should estimate the size of the prompt that is about to be sent.

Inputs to the estimate:

- assembled previous context length
- user message length
- system prompt scaffolding length
- optional provider-specific token estimator when available
- fallback character-based heuristic when no tokenizer is available

If the predicted prompt size exceeds a configured preflight threshold, Talon should rotate first and then re-assemble context before invoking the provider.

Important constraints:

- this happens only between turns, never during an in-flight run
- if rotation fails, Talon should continue with the original prompt rather than deadlocking the thread
- the preflight decision should be logged in observability metadata

### 2. Replace unbounded pre-summary replay with a bounded growth policy

`ContextAssembler` currently replays the full thread before the first summary exists. That is useful for continuity, but for stateless providers it also guarantees that prompt size can grow unchecked until the first post-run rotation.

Instead, add a bounded growth policy for the pre-summary path:

- cap replay to a configured maximum message count and/or character budget
- prefer newest messages
- optionally include a short synthetic note such as "earlier messages omitted until first rotation" in observability only, not necessarily in prompt text

This keeps continuity acceptable while preventing pathological growth before the first summary/observation is written.

### 3. Use a dual-trigger policy instead of post-run usage alone

Rotation should not depend solely on observed usage from the previous run.

Adopt two complementary triggers:

- predictive trigger: estimated next-run prompt size before invocation
- observed trigger: actual provider-reported usage after invocation

This creates a practical hysteresis model:

- preflight trigger prevents obvious overshoot
- post-run trigger still reacts to provider-reported reality and cache behavior

This is especially important because current trigger metrics can differ from what Langfuse shows as total prompt input. Provider-normalized metrics remain useful, but they should no longer be the only basis for rotation.

## Suggested config shape

```yaml
contextManagement:
  enabled: true
  thresholdRatio: 0.8
  triggerMetric: cache_total_input_tokens
  recentMessageCount: 10
  summarizer: session-observer
  preflight:
    enabled: true
    thresholdRatio: 0.6
    charFallbackRatio: 0.6
    maxPreSummaryMessages: 50
    maxPreSummaryChars: 40000
```

This is illustrative, not final. The key point is separating:

- post-run observed threshold
- preflight predicted threshold
- bounded pre-summary replay limits

## Implementation sketch

### AgentRunner

- build the would-be prompt once before provider invocation
- estimate prompt size
- if above preflight threshold, invoke context rotation before `executeAgentQuery()`
- re-assemble context after rotation and proceed normally
- record preflight decision metadata in observability

### ContextAssembler

- add bounded replay limits for the no-summary path
- return metadata describing truncation or capping

### ContextRoller

- no change to the core contract that rotation happens between turns
- continue post-run checks based on provider-reported usage

### Provider layer

- optionally expose token estimation helpers in the future
- keep initial implementation heuristic if needed

## Non-goals

- no mid-invocation compaction
- no interruption of active tool loops
- no attempt to perfectly predict provider tokenization on day one

## Acceptance criteria

- a stateless provider thread no longer requires one oversized run before first rotation can happen
- Langfuse shows materially fewer extreme input spikes on long-running threads
- normal short conversations do not compact earlier than necessary
- failed preflight compaction does not block the user response path
- post-run rotation continues to work as today

## Open questions

- whether preflight estimation should live in providers or in a generic helper
- whether bounded pre-summary replay should be global or provider-specific
- what default threshold ratios make sense for cached vs non-cached providers
