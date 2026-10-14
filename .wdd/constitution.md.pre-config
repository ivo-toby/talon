---
id: WDD-CONSTITUTION
kind: constitution
version: 1.0.0
status: active
ratified: 2026-07-10
last_amended: 2026-07-10
---

# Talon WDD Constitution

## Project Scope

- Owned areas: Talon daemon, CLI, connectors, pipeline, queue, scheduler, memory, tools, MCP integration, personas, skills, subagents, config, database migrations, deployment assets, starter bundles, tests, and repo documentation.
- Out-of-scope areas: `node_modules/`, `dist/`, secrets, local `.env` files, local runtime data, ignored smoke-test harnesses under `.codex/talon-smoke/`, and unrelated worktree changes.
- External systems treated as adapters: GitHub, GitHub Actions, GHCR, Docker, channel platforms, provider CLIs and SDKs, Langfuse, Sprites, MCP servers, and operator-hosted runtime environments.
- WDD artifacts are text-only project coordination artifacts. They must not become a runtime dependency of Talon.

## Setup Configuration

- Storage mode: local Markdown is the source of truth; GitHub PRs, GitHub reviews, and issue/project trackers are adapters when available.
- Target branch: `main`.
- Epic branch convention: `epic/[epic-slug]`.
- Task branch convention: `task/[task-id]-[task-slug]`.
- Task PRs required: yes when repository and GitHub access are available.
- Local patches allowed when PRs are unavailable: yes, with review notes stored in WDD task artifacts.
- WDD profile default: `standard`.
- Allowed profiles: `micro`, `lite`, `standard`, and `full`.
- Review mode default: `risk_based`.
- Monitoring default: `adaptive`.
- Review comments go to PRs when PRs exist; otherwise they go to local review notes or task files.
- Feedback fixes use the original worker for narrow, low-risk corrections and a fresh worker for unclear, high-risk, security-sensitive, or repeated feedback.
- P2 findings block merge.
- P3 findings do not block merge, but unresolved P3 findings should become follow-up tasks when they are still relevant.

## Model Usage

Use model aliases in WDD artifacts. If an alias is unavailable in the current environment, the controller must record the substitution in the task or epic evidence before continuing.

```json
{
  "availableAliases": {
    "controllerCurrent": "active Codex session for controller, planning, and local edits",
    "codexHigh": "GPT-5.3-codex-high for well-defined, tightly scoped offloaded coding tasks when available",
    "reviewGate": "GPT-5.4 for required pre-commit review when available"
  },
  "models": {
    "epicDefinition": "controllerCurrent",
    "planning": "controllerCurrent",
    "implementationSimple": "controllerCurrent",
    "implementationComplex": "codexHigh",
    "review": "reviewGate",
    "feedbackFix": "controllerCurrent",
    "epicValidation": "reviewGate",
    "prDescription": "controllerCurrent"
  }
}
```

## WDD Profile Defaults

- Default profile: `standard`.
- Allowed profiles: `micro`, `lite`, `standard`, and `full`.
- Default review mode: `risk_based`.
- Default monitoring mode: `adaptive`.
- Use `micro` for one bounded ticket-sized request under `.wdd/work/`.
- Use `lite` for small epics with few dependencies and low cross-module risk.
- Use `standard` for normal feature, migration, or bug-cluster epics.
- Use `full` for high-risk epics involving security, persistence, provider session behavior, multi-channel routing, deployment, or broad shared abstractions.

## Branching Policy

- WDD work must start from a feature or fix branch, consistent with repo agent instructions.
- The controller creates or verifies the epic branch from `main` before any worker starts.
- The controller syncs activation artifact changes to the epic branch before task branches or task worktrees are created.
- Task branches branch from the epic branch.
- The controller creates or verifies one isolated worktree per repository-writing task from the synced epic branch before dispatch.
- Workers start in their assigned task worktree and must not switch branches in the controller checkout.
- Task PRs target the epic branch.
- Task work must not merge directly to `main`.
- The controller checks branch freshness before merging or marking merge-ready.
- The final epic PR targets `main`.
- Destructive Git operations are forbidden unless the user explicitly requests them.

## Review Policy

- Before every commit, the controller must request a GPT-5.4 review when that model is available.
- Critical, high, and medium review issues block commit and merge until addressed or explicitly deemed invalid with written rationale.
- P1 findings block merge.
- P2 findings block merge.
- P3 findings do not block merge by default.
- Review comments are written to PRs when available, otherwise to task files or local review notes.
- PR review comments must be resolved when fixed or deemed invalid, and the resolution must state what changed, which commit fixed it, or why the comment was invalid.
- Feedback fixes may use the original worker or a fresh worker, whichever is safer.

## Verification Policy

- Implementation tasks follow RED/GREEN TDD unless the task is explicitly test-inapplicable.
- Node.js 24 or newer is the supported local and CI runtime.
- Package-manager operations use npm and `package-lock.json`; CI installs with `npm ci`.
- `npm run build` is the default build verification for TypeScript or packaged-runtime changes.
- `npm run lint` should run for source changes when practical; CI treats it as advisory.
- Targeted Vitest runs such as `npx vitest run tests/unit/queue/queue-manager.test.ts` are preferred for focused changes.
- `npm test` is reserved for broad or high-risk changes, explicit full-suite validation, or user-approved slow verification.
- `npm run format` may be used for intentional formatting of touched TypeScript test or source files.
- `git diff --check` is allowed as an optional whitespace sanity check.
- Runtime smoke testing is required for changes that need proof that `talond` boots and `talonctl chat` can communicate with it. Use the repo's `$run-talon-smoke` guidance for daemon, terminal channel, provider runtime, CLI/IPC, config, SQLite native binding, or queue/runtime boot changes.
- Documentation must be updated with code changes that add or change features, config, channels, tools, setup walkthroughs, architecture, or conventions.
- The WDD framework itself must not require a CLI, generated validator, package installation, or executable script.

## Agent Roles

- Controller: plans, activates waves, creates or verifies epic branches and task worktrees, dispatches workers, starts reviewers, routes feedback, merges or marks merge-ready, updates orchestration state, and reconciles waves.
- Worker: executes exactly one task file at a time, preserves unrelated user changes, follows repo conventions, and does not merge its own PR.
- Reviewer: reviews one task PR or patch, focuses on bugs, regressions, security, missing tests, and contract drift, and classifies findings as P1, P2, or P3.
- Feedback-fix worker: addresses routed feedback without broadening scope.
- Epic validator: validates the completed epic branch after all waves, with special attention to build, targeted tests, documentation, and unresolved review findings.
- Human reviewer: reviews the final epic PR into `main`.

## Planning Rules

- Epics must have concrete deliverables and a testable definition of done before planning.
- Tickets group related tasks.
- Tasks are independently executable worker units.
- Waves schedule tasks, not tickets.
- `orchestration.json` must include `schemaVersion: 1`.
- Plans must identify conflict domains before parallel work begins.
- Planning must call out persistence, auth, capability, provider-session, runtime-smoke, and documentation impacts when present.
- Coding tasks may be offloaded to `codexHigh` only when the task is well-defined, tightly scoped, and safe to execute independently.

## Task Rules

- Task files are the implementation briefs.
- Task files move through `todo/`, `in-progress/`, `review/`, `done/`, `blocked/`, and `cancelled/`.
- Workers inspect named files and shared context before broad discovery.
- Workers stay within scope and do not start dependent tasks.
- Workers must not revert changes they did not make.
- Workers use `rg` or `rg --files` for search when available.
- Expected application errors must use the repo's `neverthrow` `Result<T, E>` pattern across module boundaries.
- Side-effecting behavior must preserve audit-log expectations.
- Workers write durable shared-context memory when discoveries matter to later work.

## Wave Rules

- A wave is activated as a batch of concurrently eligible tasks.
- A task is eligible only when dependencies are resolved, conflict-domain blockers are clear, prerequisites are fresh, and status is not blocked.
- Do not start the next wave before reconciliation.
- Prefer safe parallelism over maximum parallelism when conflict risk is unclear.
- Changes touching shared contracts, database schema, provider runtime behavior, or channel routing should run in smaller waves unless dependencies are proven independent.

## Shared Context Rules

- `shared-context/index.md` is an index, not a dump.
- Resource files should be focused and scannable.
- Workers may propose shared-context updates in task branches.
- The controller reconciles shared-context changes into the epic branch.
- Shared context must not include secrets, access tokens, private environment values, or local runtime data.

## Governance

- Amend this constitution before changing the workflow contract.
- Repo instructions in `AGENTS.md` remain authoritative for code conventions and review gates. If a WDD artifact conflicts with `AGENTS.md`, amend the artifact or this constitution before proceeding.
- Version changes use semantic versioning:
  - MAJOR: role, artifact, or gate changes that break existing epics.
  - MINOR: new required sections, checks, or gates.
  - PATCH: clarifications that do not change behavior.
- Constitution amendments must update `last_amended`.
- Ratification date remains the first adoption date.

## Open Setup Questions

- Confirm whether `controllerCurrent` should be replaced by a named model alias for controller, planning, simple implementation, feedback fixes, and PR descriptions.
- Confirm whether task PRs are mandatory even for local-only or offline WDD work; until amended, local patches remain an allowed fallback when PRs are unavailable.
