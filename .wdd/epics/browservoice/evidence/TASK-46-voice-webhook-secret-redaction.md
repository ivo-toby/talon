# TASK-46 voice webhook secret redaction

Validated in the assigned task worktree with Node `v24.15.0`. Fixtures use synthetic values only; no production config, provider, network, or service was accessed.

## Regression proof

After adding the focused regression tests but before changing production code:

```text
npx vitest run tests/unit/cli/config-show.test.ts
10 tests: 2 failed, 8 passed
```

The two failures showed that literal and environment-substituted `voice.sip.standardWebhookSecret` values were emitted by normal `config-show` output. The nested-array fixture also remained unmasked on the baseline.

After adding `standardWebhookSecret` to the existing `SECRET_KEYS` set:

```text
npx vitest run tests/unit/cli/config-show.test.ts
10 tests passed
```

The focused coverage checks literal and environment-substituted SIP secrets, recursive masking through an array object, preservation of `standardWebhookSecretRef`, issuer, audience, public-key and revocation metadata, and the explicit `showSecrets: true` opt-in.

## Checks

All commands ran in this task worktree with the Node 24.15.0 executable path:

- `npx --no-install eslint src/cli/commands/config-show.ts` — passed.
- `npx --no-install tsc --noEmit` — passed.
- `npx --no-install vitest run tests/unit/cli/config-show.test.ts` — passed, 10 tests.
- `node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs` — passed; baseline remained 75 errors and 21 warnings, with changed code clean.
- `npm run build` — passed.
- `git diff --check` — passed.

The test checkout used the permitted ignored dependency symlink to the existing browservoice integration dependencies. No full test suite, service, live API, or secret access was used.
