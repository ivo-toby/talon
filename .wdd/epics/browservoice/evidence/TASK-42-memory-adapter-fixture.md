# TASK-42 conversation-memory adapter fixture

## Scope delivered

- Updated `tests/integration/voice/conversation-memory.test.ts` so the fake
  Live provider advertises the default required voice capabilities.
- Negotiated one exact `BrowserVoiceTransport` and fake provider pair with
  `createVoiceAdapterSelection`, then passed that selection into the shared
  `DurableVoiceSessionService` options.
- Preserved the existing conversation history, restart, backend, and retained
  output assertions without changing production code or guard behavior.

## Verification

Controller verification observed:

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — PASS:
  75 errors and 21 warnings, unchanged baseline diagnostics, 53 changed
  source files checked, changed code clean.
- `npx tsc --noEmit` — PASS.
- `npx vitest run tests/integration/voice` — PASS: 23 tests in 7 files.
- `npm run build` — PASS.
- `git diff --check` — PASS.

No new production behavior or tests beyond the restored fixture coverage were
added.

## Boundaries

No provider credentials, live API calls, paid calls, services, microphones,
PBX/Asterisk, configuration, push, merge, or full test suite was used. No
commit was made. Fresh GPT-6 precommit and Sol WDD reviews both passed.
