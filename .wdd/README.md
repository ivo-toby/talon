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

## Controller compatibility

Checked with `wddctl 0.4.2` on 2026-10-14. The current controller accepts
the existing schema-7 state, governance, epic configuration, and approved
image-processing spec and design. No state migration or renewed approval
is needed for unchanged artifacts. CLI version and state schema version
are separate values.

The controller's new default stops automatic fix/review dispatch after
three blocking review rounds for a task. It asks for a human decision;
it does not waive findings or authorize a merge. Changing the limit requires
the controller's configuration and approval workflow. Existing model choices,
review-on-every-task policy, GitHub PRs, and verification gates still apply.

`templates/plan.json` and `templates/task.md` now match `wddctl plan template`
and `wddctl plan template --brief`. `templates/spec.md` and
`templates/design.md` use the current four-section intake formats. Generate
planning skeletons through the CLI; these checked-in copies are reference
examples. The previous task template is preserved in
`templates/legacy/task.md`.

Plan references use `tasks/<ID>.md`, `spec.md#AC-N`, `design.md`,
`research/...`, or `shared-context/...`; they never include an `epics/`
prefix. Workers and reviewers read immutable dispatch snapshots. Workers
commit their assigned changes and report evidence and Decisions to the
controller; only the controller runs state-changing `wddctl` commands.

Ivo approved the corrected image-processing design and revised 21-task plan.
The plan is applied; implementation is pending the requested planning commit
and push. Design approval and plan approval are separate recorded decisions.

Other older files in `templates/` and the `work/` directory are historical
reference. Their task statuses and approvals do not initialize or ratify
the current controller. `constitution.md.pre-config` preserves the
constitution from before the controller migration.
