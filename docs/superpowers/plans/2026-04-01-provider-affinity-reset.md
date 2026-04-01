# Provider Affinity Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `list-threads` and `reset-provider-affinity` CLI commands plus non-destructive thread-level provider affinity reset behavior.

**Architecture:** Represent affinity reset as thread metadata instead of mutating run history. Expose one read-only CLI command for discovering channel thread IDs and one mutating CLI command for resetting a single thread after a confirmation prompt. Update foreground provider selection to ignore pre-reset run history.

**Tech Stack:** TypeScript, Commander, better-sqlite3, Vitest, existing repositories and CLI command patterns.

---

### Task 1: Affinity Reset Metadata And Provider Resolution

**Files:**
- Modify: `src/daemon/agent-runner.ts`
- Modify: `src/core/database/repositories/run-repository.ts`
- Modify: `src/core/database/repositories/thread-repository.ts`
- Test: `tests/unit/daemon/agent-runner.test.ts`
- Test: `tests/unit/core/database/repositories/run-repository.test.ts`

- [ ] Write failing tests for provider selection after a thread affinity reset marker.
- [ ] Run the focused tests and verify they fail for missing reset-aware logic.
- [ ] Add metadata parsing helpers plus a reset-aware latest-provider lookup path.
- [ ] Re-run the focused tests and verify they pass.

### Task 2: Thread Listing CLI

**Files:**
- Create: `src/cli/commands/list-threads.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/unit/cli/list-threads.test.ts`

- [ ] Write failing tests for `list-threads --channel <name>` output and error cases.
- [ ] Run the tests and verify they fail.
- [ ] Implement channel lookup, thread listing, latest-run summary formatting, and CLI wiring.
- [ ] Re-run the tests and verify they pass.

### Task 3: Reset Provider Affinity CLI

**Files:**
- Create: `src/cli/commands/reset-provider-affinity.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/unit/cli/reset-provider-affinity.test.ts`

- [ ] Write failing tests for confirmation prompt behavior, `--yes`, missing thread/channel handling, and metadata update.
- [ ] Run the tests and verify they fail.
- [ ] Implement the command, warning prompt, metadata write, and usage/help text that points users to `list-threads`.
- [ ] Re-run the tests and verify they pass.

### Task 4: Focused Verification

**Files:**
- Test: `tests/unit/daemon/agent-runner.test.ts`
- Test: `tests/unit/core/database/repositories/run-repository.test.ts`
- Test: `tests/unit/cli/list-threads.test.ts`
- Test: `tests/unit/cli/reset-provider-affinity.test.ts`

- [ ] Run the focused CLI and provider-affinity test suite.
- [ ] Confirm all tests pass and there are no regressions in touched behavior.
