# TASK-36 SIP ingress

## Scope delivered

- Added a disabled-by-default signed SIP receiver that verifies bounded raw
  request bytes and the Standard Webhooks signature before parsing JSON.
- Accepted only the documented `live.transport.incoming` / `sip` event shape,
  preserving SIP header order and repeats while keeping provider delivery
  authentication separate from caller authority.
- Added the server-verified Ed25519 SIP authorization envelope and the
  dependency-light Asterisk AGI signer/reference dialplan. Caller ID, From/To,
  and ordinary SIP headers do not select an owner, persona, or capability.
- Added SQLite-backed delivery receipts, call decisions, authority grants,
  shared revisions, attempt markers, duplicate handling, bounded capacity,
  safe terminal cleanup, and interrupted-attempt `unknown` classification.
  Accepted calls remain active until an explicit close; expired or revoked
  reserved grants cannot start an external attempt, and nested transaction
  failures roll back rows and revision allocation. Attempt freshness is
  sampled after the SQLite writer transaction is acquired, and cleanup keeps
  Unix-second event/grant timestamps separate from millisecond row timestamps.
- Bounded the HTTP receiver's pending raw-body work at 32 before verification
  or parsing, and retained the 50,000-receipt saturation behavior.
- Wired admission lifecycle and reload revocation into the daemon. The
  acceptance callback remains the small TASK-37 seam; this task does not place
  or accept a provider call.

## Verification

Observed on the frozen worktree with Node 24:

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — PASS:
  75 errors and 21 warnings preserved; 52 changed source files checked;
  changed code clean.
- `npx tsc --noEmit` — PASS.
- `node --check scripts/voice/asterisk-sign-call.mjs` — PASS.
- Approved focused Vitest command from the task brief — PASS: 9 files, 210
  tests.
- `npm run build` — PASS.
- `git diff --check` — PASS.

## Boundaries and unresolved live evidence

No Asterisk/PBX or SIP trunk was installed, started, configured, or contacted.
No live provider/API call, paid voice call, media path, microphone, production
credential, or production data was used. Offline tests use disposable keys and
SQLite data only. Actual endpoint authentication, trunk header preservation,
media compatibility, routing/project enablement, and provider acceptance remain
live/deployment concerns. TASK-37 owns the actual accept/attach implementation.

No commit was made; parent review and integration remain pending.
