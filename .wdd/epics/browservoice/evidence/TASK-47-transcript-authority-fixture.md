# TASK-47 transcript authority fixture

Validated in the assigned task worktree with Node `v24.15.0`. The test-only fixture uses synthetic in-memory values; no source changes, providers, network, services, production data, or secrets were used.

## Regression proof

Before the fixture repair:

```text
npx vitest run tests/integration/voice/transcript-stability.test.ts
1 failed, 2 passed
```

The existing correction test reached `sendAuthorizedSideband` and failed because the partial `Object.create` fixture had no `store.findSession` method.

After the repair:

```text
npx vitest run tests/integration/voice/transcript-stability.test.ts
4 tests passed

npx vitest run tests/integration/voice
7 test files passed, 24 tests passed
```

The fixture now supplies a connected, future-deadline session with owner and provider session identity, a complete running delegation including `sessionId`, `store.findSession`, a fixed clock, an exact runtime map entry, and an active owner authority callback. The original correction still marks the delegation stale and emits the expected interruption clarification. The added negative case flips the authority inactive, keeps stale marking, and verifies no sideband clarification is emitted.

## Checks

- `npx --no-install vitest run tests/integration/voice/transcript-stability.test.ts` — passed, 4 tests.
- `npx --no-install vitest run tests/integration/voice` — passed, 24 tests across 7 files.
- `npx --no-install tsc --noEmit` — passed.
- `git diff --check` — passed.

The checkout used the permitted ignored dependency symlink to the existing browservoice integration dependencies. Parent-owned build and lint gates remain separate.
