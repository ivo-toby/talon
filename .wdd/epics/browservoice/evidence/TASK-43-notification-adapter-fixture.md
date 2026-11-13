# TASK-43 notification adapter fixture

## Scope delivered

- Updated `tests/unit/voice/lifecycle/notifications.test.ts` so the fake Live
  provider advertises the five default required voice capabilities.
- Negotiated one exact `BrowserVoiceTransport` and fake provider pair with
  `createVoiceAdapterSelection`, then passed that transport and selection into
  the shared `DurableVoiceSessionService` options.
- Preserved notification, post-hangup, expired-login, stale-output, identity,
  and bounded-text assertions without changing production code or capability
  requirements.

## Worker verification

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — PASS:
  75 errors and 21 warnings, unchanged baseline diagnostics, 53 changed
  source files checked, changed code clean.
- `npx tsc --noEmit` — PASS.
- `npx vitest run tests/unit/voice tests/integration/voice` — PASS: 212 tests
  in 26 files.
- `npm run build` — PASS.
- `git diff --check` — PASS.

Controller final verification and independent reviews remain pending.

## Boundaries

No provider credentials, live API calls, paid calls, services, microphones,
PBX/Asterisk, configuration, push, merge, or full repository test suite was
used. No commit was made.
