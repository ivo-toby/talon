# TASK-27 first delegation context evidence

This evidence covers the bounded first-turn delegation handoff and transcript
stability rules. It does not claim that a live provider audio session was
exercised.

## Implementation

The live sideband keeps the first delegation pending for one bounded one-second
settling window even when its captured user context initially appears safe. A
timed user transcript can complete or replace that provisional snapshot during
the window; publication then uses the latest safe snapshot and preserves the
provider delegation ID, offset, target, and event order. Timeout publishes at
most once through the existing service path; missing or unsafe context reaches
the normal clarification behavior. Later delegations require a fresh user
fragment and cannot reuse an earlier utterance after timeout. Close, provider
failure, deadline, replay conflict, duplicate, and late callbacks retire the
pending entry. The published-ID and blocked-signature guards are bounded by the
existing command limit, as is the published-user-signature guard that prevents
reusing any retained admitted turn. The provider offset is only a capture
boundary, not proof that the latest user turn is complete; if required
transcript text arrives after first publication, the existing late-change
clarification path fails closed.

Every pending notice rechecks the bounded published-user-signature set at
publication time. This also covers notices captured while an earlier first
notice is still settling; a distinct new user fragment may still make that
later notice safe.

Admitted context compares user fragment identity, order, semantic kind, and
text. It ignores assistant-only speech and timing metadata that keeps the
captured user membership safe, preserving the complete admitted snapshot for
short follow-up turns. User corrections, changed roles or IDs, boundary or
untimed user fragments, truncation, and provider replay conflicts remain
uncertain and fail closed.

The regression suite includes the actual `OpenAiLiveVoiceSideband`, a fake
socket, the real `DurableVoiceSessionService`, SQLite voice store, durable
bridge, and queue. It covers same-tick and 500 ms delayed first transcripts,
partial first fragments plus continuation, one-time admission, timeout
stickiness, overlapping first notices that reuse a published user turn,
a later delegation without a fresh user turn, assistant progress and
notification speech before and after terminal delivery, same-text timing
enrichment, real user correction, duplicate/replay handling, and close cleanup.

## Focused verification

All commands below used Node `v24.15.0` with the shared worktree dependency
symlink and no dependency installation:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npx vitest run tests/unit/voice/providers tests/unit/voice/lifecycle \
  tests/integration/voice/transcript-stability.test.ts
```

Result: **8 files, 57 tests passed**.

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npx tsc --noEmit
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npm run build
```

Both checks passed. The repository lint baseline verifier also passed:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs
```

Result: **75 errors and 21 warnings**, unchanged baseline diagnostics
preserved; changed code clean across **35 changed source files**.

## Boundaries and limitations

No live API, browser microphone, provider credentials, service start, VM, push,
full-suite run, merge, or remote operation was used. The fake socket verifies
provider-event ordering and the real local service/queue verifies durable
admission and delivery. It does not establish provider-specific live audio
timing, physical device behavior, network jitter, or causal attribution for
assistant speech.
