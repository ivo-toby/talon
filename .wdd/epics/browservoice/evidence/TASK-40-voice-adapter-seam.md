# TASK-40 voice adapter seam

## Implemented

- Preserved the TASK35 transport and engine seam, including discriminated WebRTC, verified SIP-reference, and audio-stream descriptors, trusted capability negotiation, shared pending-setup admission, exact grants, and provider-neutral browser readiness.
- Migrated the owned browser voice integration fakes to explicit trusted adapter selection. Its normalized SIP path now uses a verified reference without SDP and omits the engine-private provider session ID from the generic client descriptor.
- Kept shared per-owner creation admission across transports and restored the browser contract for typed creation-budget denial: HTTP 429 with `RATE_LIMITED` and `Too many session creations`.
- Added the browser-server regression for that 429 mapping and retained the emitted browser helper binding check.

## Verification

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — PASS: 75 errors and 21 warnings preserved; 48 changed source files checked; changed code clean.
- `npx tsc --noEmit` — PASS.
- Approved focused Vitest command — PASS: 10 files, 248 tests.
- `npm run build` — PASS. Built browser output imports `./openai-live-events.js` and binds `isOpenAiLiveReadyEvent` from the emitted helper.
- `git diff --check` — PASS.

## Boundaries

No live provider, paid API, SIP/Gemini/STT-TTS/media bridge, service, credentials, microphone, full suite, push, merge, or WDD controller command was used. Fresh GPT-6-sol precommit review and the focused conventional commit remain for the parent controller to arrange.
