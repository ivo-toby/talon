# TASK-30 durable browservoice login evidence

## Scope

This task implements migration 015, durable voice authentication persistence,
indexed runtime hydration, bootstrap/reload authority handling, auth HTTP
routes, and focused repository/auth/server/daemon regression coverage. Browser
UI, restoration behavior, and documentation remain TASK-31 work.

Durable credentials use native salted scrypt (`N=16384`, `r=8`, `p=1`,
`maxmem=64 MiB`). Cookie and CSRF verification values are stored as SHA-256
base64url hashes. Remembered sessions have a fixed `365 days` TTL
(`31,536,000,000 ms`); omitted or false `rememberMe` uses `15 minutes`
(`900,000 ms`). The durable cap is `256` active grants. Expired and revoked
rows are pruned before capacity checks; active grants are never evicted and
expiry is never renewed. Runtime cleanup removes inactive durable sessions
from both base cookie/revision maps and the indexed owner map.

## Required checks

All commands below ran in the TASK-30 worktree with Node 24.15.0 on 2026-10-13.

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs
verify-lint-baseline: PASS (75 errors, 21 warnings; unchanged baseline diagnostics preserved and 36 changed source files checked; changed code clean)

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npx tsc --noEmit
PASS

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npx eslint src/core/database/repositories/voice-auth-repository.ts src/voice/voice-auth.ts src/voice/voice-session-service.ts src/voice/voice-types.ts src/voice/transports/browser/browser-server.ts src/daemon/daemon-bootstrap.ts src/daemon/daemon.ts
PASS (0 errors, 0 warnings)

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npx vitest run tests/unit/core/database/voice tests/unit/voice/browser-server tests/unit/voice/lifecycle/auth.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/daemon/daemon.test.ts
Test Files  8 passed (8)
Tests       124 passed (124)

PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH npm run build
PASS

git diff --check && git diff --cached --check
PASS
```

The changed source lint invocation also passed with zero errors. The required
baseline comparator intentionally preserves the existing 75-error/21-warning
diagnostic baseline while checking changed source files for new diagnostics.

## Offline upgrade and reopen evidence

A disposable SQLite database was prepared with migrations 001-014, then an
ordinary `voice_sessions` row with `login_revision=41` was written through
`VoiceRepository`. After close/reopen, migration 015 was applied, a durable
voice grant was created, the database was closed/reopened again, and both the
grant and ordinary voice row were read successfully:

```json
{"schemaVersion":15,"historicalRevision":41,"allocatedRevision":42,"allocatorNextRevision":43,"activeGrantAfterReopen":true,"ordinaryVoiceRowAfterReopen":true}
```

The allocator remains above every allocated revision after the grant is
revoked or expired, and migration 015 does not modify earlier migrations.
Focused tests cover salted/hash-only storage, normal restart hydration,
independent grants, fixed durations, cap/pruning, repeated revoke-cycle row
cleanup, runtime-map cleanup after expiry, revision non-reuse, credential
rotation and rotation-back invalidation, same-session and cross-session CSRF,
typed storage failures, logout failure propagation, minimal auth
status/no-store/origin enforcement, and reload ordering/failure handling for
indirect effective credentials.

## Limits

No live daemon, production database, real credential, paid provider, VM,
microphone, physical iPhone Safari, or release acceptance check was used.
The full test suite was not run per the task brief.
