# TASK44 security merge gaps evidence

Recorded 19 October 2026. This is local candidate evidence for the WDD task,
not merge, deployment, production, or live-call acceptance evidence.

## Candidate

- Baseline: `f2aeaae69c9a12ac3b0604df4f6cbe2c240dc062`.
- The worker candidate remains uncommitted and is reserved for the required
  fresh GPT-6-sol precommit and GPT-6.1-sol/xhigh security reviews.
- No WDD commands, push, merge, daemon, live provider, PBX, paid call, or
  production data were used.

## Verification

The parent controller reported the source candidate verification as follows:

- Node 24.15.0 focused verification: 10 test files, 244 passing tests.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed.
- Scoped ESLint: 0 errors and 3 existing warnings in
  `src/subagents/background/background-agent-manager.ts` (missing explicit
  return types at lines 149, 152, and 162).
- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs`: passed;
  approved baseline remained 75 errors and 21 warnings.
- `git diff --check`: passed.

The worker then ran the final SIP webhook unit file under Node 24: 16 tests
passed. It covers the 32-incomplete-body saturation path, where the 33rd
request receives 429, each timed-out request destroys its body stream and
releases capacity, and a correctly signed body is accepted through the same
request handler after recovery. It also uses a real local HTTP client to prove
an incomplete upload closes at the absolute deadline without a server error,
then accepts a correctly signed request normally.

The combined focused verification is therefore 10 parent test files with 244
passing tests plus the final SIP file's 2 added regressions: 246 passing tests
across the final candidate. The focused suites cover selected-profile voice
denial propagation, synchronous approval overlap, bridge rechecks, browser and
SIP authority expiry with durable result retention and suppressed speech,
stale/duplicate clarification guards, absolute SIP body timeout cleanup,
raw-byte HMAC verification, and trace privacy. The full test suite and
physical/provider SIP interoperability remain outside this task's verification.
