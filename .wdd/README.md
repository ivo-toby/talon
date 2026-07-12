# Wave-Driven Development

`.wdd/` is the durable source of truth for Talon WDD planning and execution.
External trackers, GitHub PRs, and review comments are adapters; they do not
replace the local text artifacts.

Typical phase order:

1. Constitution: maintain `.wdd/constitution.md`.
2. Start a micro-wave for bounded ticket-sized work, or start an epic for
   larger feature, migration, refactor, hardening, or bug-cluster work.
3. Plan tickets, tasks, dependencies, conflict domains, and shared context.
4. Execute eligible waves in task branches or local patches.
5. Reconcile each wave before starting the next one.
6. Validate completed epics when applicable.
7. Prepare the final handoff or final PR.

WDD itself is text-only. It does not require a CLI, scripts, package
installation, generated validators, or runtime integration with Talon.
