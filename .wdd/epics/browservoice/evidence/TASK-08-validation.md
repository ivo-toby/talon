# TASK-08 validation evidence

This evidence covers the offline browser voice composition and the operator
documentation. It deliberately separates repository checks from browser and
external-provider observations.

## Offline integration

Command:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npx vitest run tests/integration/voice/browser-voice-flow.test.ts --reporter=verbose
```

Result: **1 file, 4 tests passed** in 1.90 seconds.

The harness composes the actual `BrowserVoiceServer`, cookie/CSRF auth, SQLite
migrations and repositories, `DurableVoiceStore`,
`DurableVoiceSessionService`, `DurableVoiceBackendBridge`, `QueueManager`, and
`AgentRunner`. It uses fake live/provider transports and verifies:

- unauthenticated requests do not reach session creation, queue, or provider;
- HTTPS proxy headers produce secure login cookies and origin checks;
- login, session creation, provider events, queue admission, AgentRunner
  execution, SSE lifecycle events, provider acknowledgement, playback, and
  retained closed-session state work together;
- a claimed/running backend result remains retained after hangup and is visible
  after a new login;
- a generation policy change blocks admission before queue/runner execution;
- a second normalized `fake-sip` transport crosses the service seam without
  changing browser or AgentRunner code.

The fake provider reports backend cost only as a test value; no paid provider,
microphone, network call, or persistent service was used.

The complete voice-focused local run also passed:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npx vitest run tests/integration/voice tests/unit/voice tests/unit/core/database/voice --reporter=dot
```

Result: **12 files, 89 tests passed**.

The task's broader targeted command also passed:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npx vitest run tests/integration/voice tests/unit/voice tests/unit/core/database/voice \
  tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-assembler.test.ts \
  tests/unit/queue --reporter=dot
```

Result: **18 files, 262 tests passed** in 6.27 seconds. The controller later
observed the integrated release target's expanded 27-file, 556-test targeted
set pass as well; that observation includes the additional queue/repository,
daemon, config, and channel tests rerun by the controller.

## Repository checks

These checks passed after the documentation and evidence changes:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm exec tsc -- --noEmit
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm run build
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npx prettier --check \
  tests/integration/voice/browser-voice-flow.test.ts \
  .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs \
  docs/guides/voice.mdx .agents/skills/add-voice/SKILL.md
```

The example YAML also parsed successfully with the repository's `js-yaml`
dependency and retained the disabled voice default plus `webrtc` allowlist.

The approved lint baseline reproducer also passed:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs
```

Result: **96 diagnostics: 75 errors and 21 warnings**, matching the archived
pre-voice baseline;
all **28 changed source files** have zero diagnostics and unchanged source
diagnostic objects are identical. The known baseline lint failures remain
explicit rather than being hidden.

For clarity, the direct full lint command exits `1` with those same 75 errors
and 21 warnings; this is the expected repository baseline, not a suppressed
failure.

## Controller-observed browser checks

The controller reran the integrated build with real headless Chrome, mock media,
and HTTP fixtures using `/tmp/talon-voice-ui-check.cjs` and
`/tmp/talon-voice-ui-call-check.cjs`. This worker did not claim those as a live
browser run. The controller observed login, denied microphone handling with the
Dutch error, no hidden stray controls, a 390px viewport with `scrollWidth` 390,
no console errors, two calls, mute, hangup, restart, reload-retained closed
state, and USD cost display. The reviewed desktop screenshot was
`/tmp/talon-voice-active-desktop.png`.

This is controller-observed offline browser evidence against integrated build
assets. It does not prove a physical iPhone/Safari call or a paid authenticated
live-provider call. A prior Marin prototype probe exists outside this worker's
run and is not counted as current integrated live evidence.

## Storage, retention, and limits

Migration `014-voice-sessions.sql` stores `voice_sessions`,
`voice_delegations`, and `voice_outputs`; it deliberately has no raw-audio
column. Local bounded text, usage, policy, and lifecycle state is retained for
recovery and status reads. The current runtime has no automatic voice-row TTL
cleanup. Provider-side cloud audio/transcript retention remains controlled by
the provider account and API settings. Voice cost can be unavailable or
incomplete when provider pricing/usage is absent; backend run accounting stays
separate.

## Pending separate repairs and limits

Cross-component review identified three runtime findings that this worker did
not change because they are outside the assigned ownership:

- TASK10: service-running correction results must retain the result while
  suppressing stale commentary and clarifying the user-facing state;
- TASK11: a stale browser auth revision must not block a fresh login's terminal
  call reservation;
- TASK12: ordinary collaboration recovery must handle SQL `NULL` values.

Those findings remain pending their separate WDD repairs and final rerun. No
physical mobile acceptance, live paid call, SIP transport, or deployment proxy
was exercised here.
