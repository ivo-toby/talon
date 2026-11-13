# TASK-33 voice server metrics evidence

## Implementation

- Added the no-op-default `VoiceTelemetry` facade with one injected monotonic
  clock, fixed lifecycle stage/status vocabularies, and bounded call,
  milestone, delegation, output, identifier, summary, and completed-call
  retention limits.
- Connected call creation, provider setup, validated transport connection,
  adapter delegation receipt, sideband publication, admission, enqueue, claim,
  actual backend-provider start, verified durable result, offered output,
  provider acknowledgement, and closure. Receipt and publication are separate;
  publication is captured in `publishDelegation` immediately before delivery.
- Exported stage observations and a final summary through the existing
  traceparent-aware observability service. Export metadata is technical and
  content-free, runtime-validated against the fixed allowlists, and checked by
  final UTF-8 serialized size before any SDK call. Export failures and caps only
  drop telemetry and never await or alter execution.
- Preserved observed outcomes when a predecessor is missing. Such timing is
  omitted from p50/p95 denominators and counted as unassociated duration;
  restarted context remains unknown. Late results retain bounded call,
  delegation, and output correlation during the retention window.

## Checks

All commands ran in the TASK-33 worktree with Node `v24.15.0` on 2026-10-13.

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm_config_loglevel=silent node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs
PASS: 75 errors and 21 warnings are unchanged baseline diagnostics; changed code clean; 45 changed source files checked

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm_config_loglevel=silent npx tsc --noEmit
PASS

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm_config_loglevel=silent npx vitest run tests/unit/voice/voice-telemetry.test.ts tests/unit/voice/lifecycle/composition.test.ts tests/unit/voice/backend/voice-backend-bridge.test.ts tests/unit/voice/providers/openai-live-provider.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/integration/voice/observability.test.ts
PASS before the narrow output-correlation review fix: 7 files, 208 tests

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm_config_loglevel=silent npm run build
PASS

git diff --check
PASS
```

After the independent review's output-correlation fix, the focused final
checks were:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm_config_loglevel=silent npx tsc --noEmit
PASS

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm_config_loglevel=silent npx vitest run tests/unit/voice/voice-telemetry.test.ts tests/integration/voice/observability.test.ts
PASS: 2 files, 8 tests; two outputs under one delegation keep acknowledgement durations at [5, 5]

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm_config_loglevel=silent npx eslint src/voice/voice-telemetry.ts tests/unit/voice/voice-telemetry.test.ts
PASS: source file clean; repository ESLint ignore rules skip the test file

git diff --check
PASS
```

The focused tests cover deterministic receipt/publication and known-duration
percentiles, late/reordered results, restart-without-parent unknown context,
rejected/duplicate/capped entries, runtime allowlist validation, exporter
failure isolation, UTF-8 export overflow, captured stage/summary metadata,
traceparent-safe closure, and unchanged execution counts in the existing voice
lifecycle composition path. The post-review regression also proves output offer
and acknowledgement durations stay correlated by output ID when one delegation
produces multiple outputs.

## Limits

No full suite, live daemon, provider/API, microphone, production data,
credentials, paid voice session, VM, push, merge, or WDD controller command was
used. Offline tests use existing fakes and disposable test resources; they do
not establish live provider timing or Langfuse availability.
