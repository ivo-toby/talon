# Wave-Driven Development

`.wdd/` is the durable source of truth for Talon WDD planning and execution.
External trackers, GitHub PRs, and review comments are adapters; they do not
replace the local text artifacts.

The `wddctl` development controller owns state transitions, task branches,
worktrees, verification records, and integration. Agents follow its next
action and use the WDD skills for decisions that require judgment. WDD is
not a runtime dependency of Talon.

Current artifacts:

- `config.json`: machine settings, updated through the controller.
- `constitution.md`: project intent and reviewer guidance; changes to either
  governance file require explicit human approval and ratification.
- `state.json`: controller-owned state; never edit by hand.
- `epics/<slug>/`: the active epic's spec, design, plan, task briefs, and
  research, created through the controller after setup.
- `shared-context/`: durable discoveries shared across epics.
- `archive/`: completed scopes retired through the controller.
- `dispatch/`: ignored scratch artifacts for external runners.

Typical phase order:

1. Resolve setup decisions and ratify the configuration and constitution.
2. Agree on the feature spec, research its contracts, and agree on a design.
3. Approve and apply a task plan with dependencies and conflict domains.
4. Dispatch eligible workers into isolated task worktrees.
5. Review, verify, integrate, and reconcile completed work.
6. Validate the completed scope and prepare the final human merge into `main`.

The older `templates/` and `work/` directories are retained as historical
reference. Their task statuses and approvals do not initialize or ratify
the current controller. `constitution.md.pre-config` preserves the
constitution from before the controller migration.
