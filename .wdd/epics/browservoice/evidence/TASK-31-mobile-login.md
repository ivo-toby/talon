# TASK-31 mobile login evidence

## Scope

This task adds the English, unchecked `Keep me signed in for one year` option
to the existing browser voice login page. `rememberMe: true` requests the
fixed 365-day durable grant; the omitted compatibility payload and explicit
false request keep the fixed 15-minute grant. Browser restore probes the
read-only cookie auth status endpoint before an optional retained-call lookup.
A valid cookie without a call reaches ready, a retained-call 404 clears only
the stale pointer, and transient auth or retained-call failures preserve the
pointer with an English recovery message. Restore never starts microphone,
peer, paid-session, provider, queue, or replay work. Credentials remain out of
Web Storage; only the retained session pointer may be stored there.

## Checks

All commands ran in the TASK-31 worktree with Node `v24.15.0` on 2026-10-13.

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs
verify-lint-baseline: PASS (75 errors, 21 warnings; unchanged baseline diagnostics preserved and 36 changed source files checked; changed code clean)

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npx tsc --noEmit --pretty false
PASS

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npx vitest run tests/integration/voice/browser-voice-flow.test.ts --reporter=dot
PASS: 1 file, 5 tests; the remembered-login case reopens a disposable migrated
SQLite file with a fresh `VoiceAuthRepository`, HTTP server, service, store and
fake provider. It preserves the cookie/CSRF grant and absolute expiry, reads
auth and retained call state after restart, proves an old CSRF close at the old
revision, then proves the new revision keeps retained reads while its close and
playback mutations are denied on that old-revision call. Restoration leaves
provider, queue and run counts unchanged before the explicit post-restart call.

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npx vitest run tests/unit/voice/browser-client tests/unit/voice/browser-server/voice-assets.test.ts tests/integration/voice --reporter=dot
PASS: 6 files, 42 tests

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm run build
PASS

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH node --check src/voice/web/app.js
PASS

git diff --check && git diff --cached --check
PASS
```

## Browser evidence

The frontend-testing-debugging skill classified the Browser plugin as
unavailable, so the supplied regular Playwright script used isolated system
Google Chrome with intercepted HTTPS and fake auth/media/provider routes:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH node /tmp/talon-voice-login-qa.mjs /Users/ivo.toby/workspace/talon/.worktrees/SCOPE-browservoice/TASK-31-mobile-login
PASS: 14 checks, 0 browser errors
```

The run covered English identity, unchecked and checked keyboard interaction,
both remember payloads, token clearing, fresh cookie restore without a call
pointer, no automatic mic/peer/paid-session work, stale retained-call 404,
credential absence from local/session storage, logout/reopen, auth 503 pointer
preservation and recovery, 320px and 390px mobile layout, 1440px desktop
layout, and console/page-error health. Screenshots and result JSON are outside
the repository at `/tmp/talon-voice-login-qa/` (`mobile-login.png`,
`mobile-restored.png`, `320-restored.png`, `desktop-restored.png`, and
`results.json`).

## Limits

No live daemon, production database, real credential, paid provider, VM,
microphone, physical iPhone/Safari, home-screen cookie-context retention, or
background/lock-screen audio was used. The full test suite was not run per the
task brief. The browser fixture used the existing built assets and did not
start a listener.
