# Provider Failover Design

Date: 2026-03-19
Status: Proposed
Scope: `agentRunner` and `backgroundAgent`

## Summary

Add a provider failover mechanism so Talon can retry work on a fallback provider
when the selected primary provider fails with classified transient errors such
as rate limits, quota exhaustion, or provider-side 5xx failures.

The design applies to both interactive `agentRunner` runs and background agent
execution. Failover is only allowed before any user-visible output or tool
side effects have been emitted.

## Problem

Today Talon selects a single provider for a run and does not switch providers
if that provider is temporarily unavailable. This is painful when:

- Claude Code subscription/API capacity is exhausted
- the provider returns HTTP 429 rate limits
- the provider returns transient 5xx errors

This causes avoidable failures even when another enabled provider, such as
Gemini, could complete the same work.

## Goals

- Support automatic provider failover for `agentRunner`
- Support automatic provider failover for `backgroundAgent`
- Keep configuration simple with one global ordered fallback list
- Fail over only for classified transient provider failures
- Prevent duplicate user output and duplicate tool side effects
- Preserve observability and persist the provider that actually succeeded

## Non-Goals

- Mid-stream failover after output has started
- Reusing a primary provider session on a fallback provider
- Per-provider failover chains in the first version
- Generic retry of all failures
- Cross-model prompt optimization or result reconciliation

## Configuration

Add a new top-level config block:

```yaml
providerFailover:
  enabled: true
  providers:
    - gemini-cli
  on:
    - rate_limit
    - quota_exhausted
    - server_error
```

### Semantics

- `enabled`
  - Turns failover on or off globally
- `providers`
  - Ordered fallback provider names
  - Tried in order after the selected primary fails
  - The failed primary provider is skipped if it also appears in the list
- `on`
  - Allowed classified failure kinds that may trigger failover

## Failure Classification

Introduce a provider-level error taxonomy used by both interactive and
background execution:

- `rate_limit`
  - HTTP 429 or provider-equivalent rate limit
- `quota_exhausted`
  - hard quota or subscription exhaustion
- `server_error`
  - transient provider-side 5xx failures
- `non_retryable`
  - all other failures; no failover

Providers should classify known failure responses instead of relying on
string-matching in `AgentRunner` or `BackgroundAgentManager`.

## Provider Selection

Primary provider selection remains unchanged:

1. thread affinity
2. persona provider override
3. configured default provider

Failover only begins after the selected primary fails with an allowed
classified failure.

The fallback order is:

1. configured global fallback list
2. skip any provider already attempted for the run
3. stop when a provider succeeds or the list is exhausted

## AgentRunner Behavior

### Allowed failover

Fail over only if the primary provider fails:

- with a classified failure in `providerFailover.on`
- before any text output is emitted
- before any tool events are emitted

### Disallowed failover

Do not fail over if:

- any assistant text has already been produced
- any provider tool event has been observed
- the failure is `non_retryable`
- the fallback list is exhausted

### Session behavior

- The fallback provider always starts as a fresh provider attempt
- It must not try to reuse the failed provider's session ID
- Existing assembled context may be reused because no output/side effects were
  emitted yet

### Persistence

- Persist the final successful `provider_name` to the run record
- If all attempts fail, the run remains failed and the error should include the
  providers attempted and the final classified reason

## Background Agent Behavior

### Allowed failover

Fail over only if the selected background provider fails:

- during startup
- during execution before a successful result is produced
- during result parsing
- with a classified failure in `providerFailover.on`

### Disallowed failover

Do not fail over if:

- the provider already produced a successful parsed result
- the failure is `non_retryable`
- the fallback list is exhausted

### Persistence

- Persist the final successful provider to the background task record
- Log all attempted providers and the final outcome

## Safety Rules

These rules are mandatory:

- Never fail over after partial user-visible output
- Never fail over after provider tool events may have caused side effects
- Never attempt to translate or merge partial outputs across providers
- Never hide failover; it must be visible in logs and traces

## Observability

Record the following metadata for both interactive and background execution:

- primary provider
- fallback provider
- attempt index
- failover reason/classification
- whether failover was skipped due to partial output/events

Expected logging examples:

- primary failed with `rate_limit`, trying fallback `gemini-cli`
- failover skipped because output already started
- fallback succeeded on attempt 2

## Testing

### AgentRunner

- fails over on classified 429 before first event
- fails over on classified 5xx before first event
- does not fail over after first text event
- does not fail over after first tool event
- persists successful fallback provider
- stops after fallback list exhaustion

### BackgroundAgentManager

- fails over on classified startup failure
- fails over on classified provider result failure
- does not fail over after a successful parsed result exists
- persists successful fallback provider
- reports attempted providers on final failure

### Provider Tests

- Claude provider classifies 429 as `rate_limit`
- Claude provider classifies quota exhaustion as `quota_exhausted`
- Claude provider classifies 5xx as `server_error`
- Gemini provider classifies equivalent failures consistently

### Config Tests

- parses `providerFailover` with valid provider names and trigger classes
- defaults to disabled when omitted
- rejects unknown failure kinds

## Implementation Notes

- Add provider error types/interfaces in the provider layer, not in
  `AgentRunner`
- Reuse a shared failover coordinator/helper for `agentRunner` and
  `backgroundAgent` to avoid duplicated orchestration logic
- Keep the first version global to minimize config complexity

## Trade-Offs

### Advantages

- Better uptime during provider throttling/outages
- Simpler operator experience than per-provider failover chains
- Works for both interactive and background execution

### Costs

- More runtime orchestration complexity
- Requires explicit failure classification per provider
- Conservative safety rules mean some failures still will not fail over

## Recommendation

Implement the global ordered failover list first, with transient classified
errors only and strict "before any output/events" safety gates.
