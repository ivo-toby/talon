# TASK-37 incoming GPT-Live SIP

## Scope delivered

- Accepted the verified existing Live SIP session through the native `/accept`
  route with the configured model and voice, client delegation, and
  `store:false`; registration is recorded only after an exact `200` response
  with an empty body.
- Attached the same provider session through `/attach` without startup or
  audio messages. No new Live session is created, and ambiguous acceptance
  outcomes remain unknown without automatic retry.
- Split the short admission proof from the accepted call authority. Accepted
  calls remain valid until durable close/revocation or the configured session
  deadline, with owner and shared revision checks before provider setup and
  backend execution.
- Passed the composed persona instructions and history into the provider
  accept contract, then routed SIP transcript/delegation through the existing
  VoiceBackendBridge, durable queue, ordinary AgentRunner, and retained output
  path.
- Sent SIP hangup before waiting for provider finalization and retained the
  sideband through `session.closed` final usage or the bounded incomplete
  deadline. Setup-close races do not issue browser-style sideband close calls,
  and durable SIP closure is recorded only after confirmed provider
  finalization; failed or missing finalization remains accepted/unknown.
- Kept SIP-only daemon bootstrap, connector registration, admission reload,
  and browser voice regressions covered. The integration flow uses a real
  disposable Ed25519 assertion, `ConfiguredSipAuthorizationResolver`, mapped
  server principal, disposable SQLite state, fake Live provider, and fake
  backend. Provider unit tests use fake HTTP/WebSocket transports.

## Verification

Observed on the frozen worktree with Node 24:

- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — PASS:
  75 errors and 21 warnings preserved; 53 changed source files checked;
  changed code clean.
- `npx tsc --noEmit` — PASS.
- Approved focused Vitest command from the task brief — PASS: 15 files, 309
  tests. This includes the signed-ingress → AgentRunner → retained-output
  integration, exact accept-response failure matrix, accepted-call lifetime
  regression, delayed attach cleanup, final usage after local hangup, and
  SIP-only reload coverage.
- `npm run build` — PASS.
- `git diff --check` — PASS.

## Boundaries and unresolved live evidence

No live provider/API request, paid voice call, microphone, media bridge,
Asterisk/PBX, SIP trunk, production credential, service, or production data
was used. Actual project SIP enablement, trunk header/media preservation,
provider compatibility, billing, and deployment remain unverified live
concerns. No commit was made; parent review and integration remain pending.
