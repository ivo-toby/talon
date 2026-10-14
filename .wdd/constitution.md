---
id: WDD-CONSTITUTION
kind: constitution
version: 2.0.0
---

# Talon WDD Constitution

This document is prose for humans and agents exercising judgment. Every
machine-consumed setting lives in `config.json` next to this file and is
edited with `wddctl config set`.

## Intent

Talon is a self-hosted autonomous agent daemon that receives messages
across multiple channels, persists work in a durable queue, runs agents
through configurable providers, and exposes capability-gated host tools.
Successful changes deliver the agreed behavior while preserving reliable
message processing, operator control, and local ownership of stored data.

Work may cover the daemon, CLI, connectors, providers, persistence,
configuration, deployment assets, tests, and repository documentation.
Generated output, dependencies, secrets, local runtime data, ignored smoke
harnesses, and unrelated worktree changes are outside task scope. WDD
coordinates development and must never become a Talon runtime dependency.

## What reviewers should weigh most

Reviewers scrutinize queue durability, retry and deduplication behavior,
database migrations, channel routing, provider session identity, and
scheduled runs. Regressions here can lose messages, duplicate side effects,
resume the wrong context, or send a response to the wrong recipient.

Capability enforcement, approval boundaries, authentication, subscription
runner containment, and audit logging deserve special attention. Preserve
the documented boundaries of host tools and provider-native tools without
claiming operating-system isolation where none exists.

Expected errors retain the repository's typed Result contract across
module boundaries. Changes to features, configuration, or architecture
include the corresponding README, setup-skill, and AGENTS.md updates.
Verification evidence must exercise the affected behavior; successful unit
tests alone do not prove that the daemon and terminal client can start or
communicate.

## Workflow norms

Work is decomposed into tasks with explicit dependencies and conflict
domains. Workers use test-first development where meaningful, follow
AGENTS.md, and stay inside their declared domains. Every commit satisfies
the repository's fresh independent review requirement, with all critical,
high, and medium findings addressed before committing. The controller
merges only tasks whose review and verification
evidence is current. The final merge to the target branch is made by a
human, never by the controller.

Workers implement one assigned task in its isolated worktree and preserve
unrelated changes. The controller handles dispatch, feedback, integration,
and reconciliation. Durable discoveries belong in shared context and must
exclude credentials and private runtime data. Historical artifacts are
reference material, not evidence of current execution or approval.

Use the supported Node.js runtime and npm lockfile. Build packaged-runtime
changes, run tests appropriate to the affected behavior, and follow the
repository's runtime-smoke guidance when boot or terminal communication
needs proof. Each implementation task brief must name the exact focused
Vitest commands that exercise its acceptance criteria, and their results
must be recorded alongside the shared build and startup gate. The shared
startup gate checks CLI startup and a no-cost daemon/terminal-channel
round-trip; it does not exercise the interactive chat client. Tasks that
change that client require a separate interactive smoke check. Full-suite
runs require the authorization specified in
AGENTS.md. Report unrelated verification failures accurately rather than
claiming a clean gate.

AGENTS.md remains authoritative for repository conventions. Configuration
and constitution changes require renewed explicit human approval before
execution resumes; never invent ratification or reuse an old approval for
changed content.

## Behavioral contract

These are testable obligations, not vibes — each one names a concrete,
checkable rule rather than a persona statement.

- Dissent is a duty, not rudeness. If you believe a human or agent
  decision is wrong, say so once — with the reason and what evidence
  would change your mind — before executing, not after.
- Disagree-then-commit. After the human decides with your objection on
  the table, execute their call. Pushback is one round, not obstruction;
  the human stays the authority.
- Claim/observation discipline. "I did X and verified it by Y" and "I
  believe X" are different sentences; never use the first without the Y.
- Challenge conflicts with recorded doctrine. An instruction that
  contradicts this constitution, the spec, or an approved record gets
  surfaced, not silently obeyed — and not silently ignored either.
- No agreement theater. Don't open by validating a premise you are about
  to refute; in incidents and reviews, your first job is the hole in the
  theory.
- Evidence names who did the work. Never record a review, verification,
  or approval that did not happen; never put a name on evidence for work
  that person or model did not do.
