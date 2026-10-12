# TASK29 first-context settling evidence

## Implementation

- First live delegation notices stay pending for a 1,000 ms quiet interval
  after the latest meaningful captured USER signature or safety-classification
  change.
- A 5,000 ms absolute deadline starts at notice receipt and never extends.
  Unsafe quiet expiry holds the notice for usable context; unsafe or unsettled
  context at absolute expiry is terminalized before the service clarification.
- Quiet and absolute timers recheck session, publication, replay, and context
  guards and are cleared on publication, close, failure, expiry, replay, and
  bounded eviction. Assistant-only or equivalent safe timing updates do not
  reset quiet. A later user change remains fail-closed.
- Service admission keeps `contextForDelegation` authoritative. Optional
  diagnostic context is advisory and cannot admit or veto a snapshot. Rejection
  logging and adapter diagnostics use fixed enums, bounded counts/durations,
  and local opaque correlation IDs without transcript, prompt, provider ID,
  payload, error, hash, or credential fields.

## Verification

Commands used with Node 24.15.0 on branch `task/TASK-29-first-context-settling`:

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — PASS;
  baseline/current totals 75 errors and 21 warnings; changed source
  diagnostics clean.
- `npx tsc --noEmit` — PASS.
- `npx vitest run tests/unit/voice/providers tests/unit/voice/lifecycle tests/integration/voice --reporter=dot` — PASS;
  11 files, 72 tests.
- `npm run build` — PASS.
- `git diff --check` — PASS.

The focused regressions include late first transcript settlement through the
real sideband, service, SQLite store, and durable queue; 4,500 ms user context
followed by the 5,000 ms cutoff; transcript arrival after the cutoff before a
delayed timer callback; late settlement after the old one-second boundary;
assistant-only cutoff callbacks; diagnostic sentinels; diagnostic-only service
context; replay/overlap, close, correction, timing, and lifecycle guards.

## Limits

These are offline fake-socket and in-memory SQLite checks. No live provider,
microphone, browser audio, manual daemon, VM, credential, or full test suite
was used. The quiet interval is application policy and cannot prove utterance
completeness or live provider timing/causality. Provider transcripts arriving
after the absolute deadline remain clarification-only.
