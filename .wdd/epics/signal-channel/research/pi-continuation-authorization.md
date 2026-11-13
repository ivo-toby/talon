# Pi continuation authorization

Ivo reviewed the continuation proposal and replied: “Go ahead and make it so”.
This supplements the earlier implementation authorization; it does not replace
or weaken the approved Signal specification or design.

## Approved execution changes

- Pi remains the WDD controller and dispatches native Pi workers/reviewers,
  without launching Codex CLI.
- Preserve model tiers and reasoning effort using explicit Pi identifiers:
  normal implementation `openai/gpt-5.6-luna:max`, high-risk implementation
  `openai-codex/gpt-6.1-sol:high`, reviews and specification reviews
  `openai-codex/gpt-6.1-sol:xhigh`.
- Namespace task branches as `task/signal-{task-id}` to avoid branches owned by
  other epics, and place WDD worktrees under the checkout's ignored `.worktrees/`.
- Preserve concurrency three, review every task, reconcile every three merges,
  and retain the existing verification commands and human-owned final merge.
- Review/checkpoint the Signal handoff, apply its sixteen-task plan and execute
  the automated implementation, focused tests, integration and documentation.

Existing unrelated working-tree changes and deletions remain untouched. A native
child launch failure is a reported blocker, not permission to switch models,
reasoning effort or execution modes silently. No push, live Signal message,
account provisioning, production service action or final target-branch merge is
authorized. AC-15 remains pending until the required real-device evidence exists;
automated success cannot mark the epic delivered.

## Local-only integration correction

The first `wddctl submit` was run while `merge.surface` still selected `pr`.
That command pushed `task/signal-TASK-001` at
`0c2dc55b4d485aaa264e670ce8311fed1dba145a` before its PR creation failed. The
controller reported this unauthorized side effect and confirmed the remote
branch read-only; it did not delete or rewrite the remote branch. This record
is disclosure, not retroactive push approval.

When asked whether to switch WDD to local-only integration and continue, Ivo
selected “Continue locally (recommended)”. The controller changed
`merge.surface` to `local` through `wddctl`, amended governance, re-approved the
epic configuration and re-stamped the unchanged plan. No further push or PR
creation is authorized, and the existing remote branch remains untouched.
