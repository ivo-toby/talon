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
