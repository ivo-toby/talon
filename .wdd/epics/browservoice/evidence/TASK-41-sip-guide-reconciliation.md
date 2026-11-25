# TASK-41 Asterisk guide reconciliation

## Scope delivered

- Updated `docs/guides/voice-asterisk.mdx` to describe the implemented
  durable SIP admission → existing GPT-Live `/accept` → `/attach` sideband →
  ordinary Talon queue and `AgentRunner` path.
- Preserved the distinction between the 60-second admission proof and the
  accepted-call authority/session lifetime, including ambiguous acceptance and
  missing finalization behavior.
- Replaced the stale TASK-37 future-tense wording while keeping Asterisk,
  keys, project/trunk routing, real header/media compatibility, billing, and
  paid-call validation explicitly outside offline evidence.

## Verification

Controller verification observed:

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — PASS:
  75 errors and 21 warnings, unchanged baseline diagnostics, 53 changed
  source files checked, changed code clean.
- `npx tsc --noEmit` — PASS.
- `npm run build` — PASS.
- `git diff --check` — PASS.

No new tests were added; this is a prose-only correction.

## Boundaries

No Asterisk/PBX, keys, provider credentials, services, live API calls, paid
calls, trunk, media path, push, or merge was used. Fresh GPT-6 precommit review
passed; Sol WDD review remains pending. No commit was made.
