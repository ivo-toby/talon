# TASK-34 voice browser metrics evidence

## Implementation

The browser voice client now records bounded RTC, audio play-promise,
visibility, and interruption proxies using its local `performance.now()` clock.
It batches at most 16 samples, retains at most 256 pending samples, permits one
two-second-aborted request at a time, keeps a bounded per-call unknown/drop
counter for failed or saturated batches, and exposes that local diagnostic for
the current or most recent call even after disposal. A new call resets the
snapshot; pending data is still discarded during lifecycle cleanup. The
in-flight latch remains until the fetch settles, so cleanup cannot cause a
concurrent telemetry request or resend a failed batch. Existing aggregate
unknown markers in a failed piggyback batch are consumed as accounting metadata;
only newly failed physical samples are counted again. It never calls semantic
playback reporting and does not attach an output ID to a generic remote audio
stream.

`POST /voice/sessions/:id/telemetry` requires the current origin, active cookie
login, CSRF, and the exact owner/login-revision binding retained by the running
server. The server validates the strict fixed-enum payload, 16 KiB body, output
membership, cumulative 256-sample call cap, six-batch/minute grant/call cap,
and bounded rate-key map before passing samples to the shared TASK33
`VoiceTelemetry` facade. Minute-window rollover resets only the batch counter;
terminal rate keys are reclaimed at saturation without evicting live authority
or cumulative counts, and facade drops are surfaced as telemetry failures.
Browser exports use a separate observation name and counters; aggregate unknown
markers contribute their bounded logical count to the browser summary while the
physical per-call sample quota remains separate. They do not alter durable
semantic output playback or call execution.

## Offline verification

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs`: the initial invocation could not parse npm lint JSON because its subprocess emitted package-manager text before JSON (`Unexpected token '>', "\n> talon@0."...`). The parent’s final invocation with `npm_config_loglevel=silent` completed successfully: 75 errors, 21 warnings, unchanged 45, and source clean. Scoped ESLint also completed successfully for all changed source files.
- `npx tsc --noEmit`: PASS.
- `npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/voice/browser-client/voice-client.test.ts tests/unit/voice/browser-server/browser-server.test.ts tests/unit/voice/voice-telemetry.test.ts tests/integration/voice/observability.test.ts`: PASS, 5 files and 100 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS.

The checks are offline and use fakes/disposable test-owned state. No paid
provider, live microphone, service, credentials, deployment, or physical
iPhone/Safari playback was used; those remain outside this task's evidence.
