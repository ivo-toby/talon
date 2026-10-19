# TASK-35 voice adapter seam

## Implemented

- Added discriminated WebRTC, verified SIP-reference, and audio-stream offer/answer descriptors. Generic client descriptors no longer require SDP or an engine-private provider session ID.
- Added trusted transport/engine selection with supported, unsupported, and unknown capability states. Required unsupported or unknown capabilities fail before adapter construction/provider setup.
- Added shared synchronous call admission reservations covering pending setup, per-owner creation budgets, and exact transport-neutral grant resolution/revocation.
- Enforced the selected transport/engine object pair at the service boundary, kept reservations through pending setup teardown, and cleaned up late provider sessions after a closed setup.
- Moved GPT-Live browser data-channel readiness parsing into `openai-live-events.ts`; the browser reports ready only after actual RTC connectivity and normalized engine readiness.
- Kept the production bootstrap on BrowserVoiceTransport plus OpenAiLiveVoiceProvider. Browser HTTP input cannot self-attest a verified SIP reference.
- Added actual service regressions for a no-SDP audio-stream client descriptor without a provider session ID and for a close/new-create race while provider setup is pending.

## Verification

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — PASS: 75 errors and 21 warnings preserved; 48 changed source files checked; changed code clean.
- `npx tsc --noEmit` — PASS.
- Approved focused Vitest command — PASS: 9 files, 242 tests.
- `npm run build` — PASS. Built browser output imports `./openai-live-events.js` and binds `isOpenAiLiveReadyEvent` from the emitted helper.
- `git diff --check` — PASS.

## Boundaries

No live provider, paid API, SIP/Gemini/STT-TTS/media bridge, service, credentials, microphone, full suite, push, merge, or WDD controller command was used. A fresh GPT-6-sol precommit review and focused conventional commit remain for the parent controller to arrange.

The requested focused probe in the unowned `tests/integration/voice/browser-voice-flow.test.ts` fails at line 1311 because its fake-SIP service omits the now-required trusted adapter selection; that fixture was intentionally left unchanged.
