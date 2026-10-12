# TASK28 voice interface evidence

- Base source head: `1847334409cb93cdc5093282f9990cc75087de30` (`1847334`).
- Runtime: Node `v24.15.0`, shared `node_modules` symlink to `../TASK-01-contracts/node_modules`.
- Scope: mobile-first dark red lens interface, original Talon logo overlay, English fixed browser copy, phase-safe call/mute/end-call controls, PNG build/MIME support.

## Checks

- Lint comparator: PASS. Baseline remains exactly **75 errors and 21 warnings**; changed source is clean. The comparator checked 35 changed source files against the ratified baseline.
- TypeScript: `npx tsc --noEmit` PASS.
- Focused tests: `npx vitest run tests/unit/voice/browser-client tests/unit/voice/browser-server/voice-assets.test.ts` PASS: **2 files, 20 tests** (18 client, 2 static-asset tests).
- Build: `npm run build` PASS.
- Built assets: `dist/voice/web/assets/hal-lens.png` (1254×1254 RGBA PNG) and `talon-logo.png` (659×610 RGB PNG). The browser asset mapping returns `image/png` for both.
- Fixed UI copy scan: no non-English fixed strings remain in `index.html`, `app.js`, or `voice-client.ts`; dynamic task, result, notification and persona text remains unmodified.
- Offline rendered browser fixture: PASS, **24 checks**, against the built page through intercepted HTTPS with fake REST, SSE, WebRTC, audio and media APIs; one session creation, one close, two logout cycles, zero console errors. The fixture covered login/error recovery, asset loading, keyboard focus, start/readiness, mute, autoplay recovery, dynamic Dutch text, status-stream loss with usable mute, retained work, repeated logout, microphone denial, reduced motion, truthful incomplete/unknown/error output states, primary-control fit at 320×740 and horizontal fit at 390×844, 320×740 and 1440×1000. No listener or provider was used.

## Intentional concept differences

- The central lens remains an accessible semantic button, but it is disabled while connecting, connected, ending, or while an active `network_lost` session still exists. End call is a separate explicit action so a stale session cannot be replaced by a parallel call.
- The supplied unbranded lens PNG is layered with the preserved original Talon logo without a filter-generated square. The ready view hides the reference's bright End call affordance until a real session exists; active controls use circular icon hit areas with separate labels.
- Activity, messages and usage follow the reference order as open sections. Ready copy is reduced to one status row; active/recovery copy remains dynamic and is visually capped at two lines while full backend text stays in Messages. Incomplete/unknown/error cost and playback states remain explicit. No waveform or synthetic usage statistic was added.

## Limitations

The fixture inspected rendered screenshots at the three target sizes. Compared with the supplied reference, the implementation keeps the dark warm-black palette, red lens, Talon mark, centered status, compact circular controls, open Activity/Messages/Voice usage sections, and English copy; it intentionally keeps End call hidden until a session exists, keeps sign out in the authenticated top bar, dims the lens without obscuring it during active or lost sessions, and adds truthful result/cost/recovery rows. This worker did not start a listener, request a real microphone, use credentials, contact a provider, run a VM, or claim physical iPhone audio, screen-lock reliability, background operation or live-audio quality. The full test suite was intentionally not run.
