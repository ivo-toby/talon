# Provider Affinity Reset Design

## Goal

Add a safe way to inspect channel threads and reset provider affinity for one specific conversation without rewriting run history.

## Problem

Foreground provider selection currently prefers the latest persisted `runs.provider_name` for a thread. That makes old conversations sticky even after switching `agentRunner.defaultProvider`.

Because affinity is inferred from run history rather than stored directly, deleting affinity by mutating `runs` would damage auditability and usage reporting.

## Design

### 1. Add thread inspection CLI

Add `talonctl list-threads --channel <name>` to print:

- `external_id`
- internal `thread_id`
- latest provider
- latest run status
- latest activity timestamp

This gives operators a reliable way to discover the `external_id` required for an affinity reset.

### 2. Add explicit affinity reset CLI

Add `talonctl reset-provider-affinity --channel <name> --external-id <id> [--yes]`.

Behavior:

- resolve the channel by name
- resolve the thread by `(channel_id, external_id)`
- print a warning summary
- prompt for confirmation unless `--yes` is passed
- store a reset marker in `threads.metadata`

The command must not rewrite or delete any `runs` rows.

### 3. Store reset state in thread metadata

Use `threads.metadata` to store a timestamp field such as `providerAffinityResetAt`.

This avoids schema changes and keeps the operation local to one thread.

### 4. Change provider resolution semantics

When choosing a foreground provider for a thread:

- read the thread metadata reset marker
- only treat run history after that timestamp as affinity
- if there is no post-reset provider, fall back to persona provider and then configured default

This preserves historical runs while making the next inbound message behave like a fresh provider choice.

## Non-Goals

- bulk reset for all threads in a channel
- destructive history rewrites
- background-agent affinity changes

## UX Notes

`reset-provider-affinity` help text should explicitly tell the user to run `list-threads --channel ...` first if they need to discover the external ID.
