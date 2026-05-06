# Workflow Kernel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans before implementing this plan. Steps use checkbox syntax for execution tracking.

**Goal:** Implement the workflow kernel sidecar for Talon with durable workflow state, claim and evidence capture, watchdog evaluation, and one narrow authoritative rollout path for orchestrator-style delegated work.

**Architecture:** Add a new `src/workflow/` module with repositories, service APIs, policy evaluation, evidence adapters, and read models. Integrate it into existing execution paths such as `AgentRunner`, `persona.send`, background-agent flows, scheduler/watchdog loops, and A2A task handling without rewriting Talon's queue or persona systems.

**Tech Stack:** TypeScript, Node.js, SQLite, better-sqlite3, Zod, neverthrow, pino, vitest

**Spec:** `specs/2026-04-04-domain-agnostic-workflow-kernel.md`
**Design:** `specs/2026-04-04-workflow-kernel-technical-design.md`

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `src/workflow/workflow-types.ts` | Shared workflow item, claim, evidence, lease, intervention, and decision types |
| Create | `src/workflow/workflow-service.ts` | Main kernel service API and orchestration logic |
| Create | `src/workflow/workflow-policy-registry.ts` | Resolves policy packs from code, config, and plugins |
| Create | `src/workflow/workflow-evidence-adapter.ts` | Converts tool/background/A2A results into evidence records |
| Create | `src/workflow/workflow-watchdog.ts` | Deterministic stale-work and escalation evaluation |
| Create | `src/workflow/workflow-read-model.ts` | Operational and audit query surfaces |
| Create | `src/workflow/index.ts` | Public exports |
| Create | `src/workflow/packs/orchestrator-task-pack.ts` | First authoritative workflow pack |
| Create | `src/core/database/migrations/010-workflow-kernel.sql` | Workflow tables and indexes |
| Create | `src/core/database/repositories/workflow-item-repository.ts` | Workflow item persistence |
| Create | `src/core/database/repositories/workflow-claim-repository.ts` | Claim persistence |
| Create | `src/core/database/repositories/workflow-evidence-repository.ts` | Evidence persistence |
| Create | `src/core/database/repositories/workflow-event-repository.ts` | Append-only event persistence |
| Create | `src/core/database/repositories/workflow-lease-repository.ts` | Lease persistence |
| Create | `src/core/database/repositories/workflow-intervention-repository.ts` | Intervention persistence |
| Modify | `src/core/database/repositories/index.ts` | Export workflow repositories |
| Modify | `src/core/config/config-schema.ts` | Add workflow rollout and policy-pack config |
| Modify | `src/core/config/config-types.ts` | Export workflow config types |
| Modify | `src/daemon/daemon-context.ts` | Expose workflow service and read model |
| Modify | `src/daemon/daemon-bootstrap.ts` | Initialize workflow services and repositories |
| Modify | `src/daemon/daemon.ts` | Start and stop watchdog evaluation |
| Modify | `src/daemon/agent-runner.ts` | Emit claims, evidence, and transition requests |
| Modify | `src/daemon/watchdog.ts` | Run workflow watchdog checks |
| Modify | `src/tools/host-tools/persona-send.ts` | Create workflow items for orchestrator delegation and attach A2A evidence |
| Modify | `src/tools/host-tools/background-agent.ts` | Attach delegation, completion, timeout, and failure evidence |
| Modify | `src/tools/host-tools-bridge.ts` | Provide durable tool metadata for evidence capture |
| Modify | `src/a2a/a2a-task-mapper.ts` | Link A2A tasks to workflow items where appropriate |
| Modify | `src/a2a/a2a-types.ts` | Add workflow link metadata if needed |
| Modify | `src/subagents/background/background-agent-manager.ts` | Emit workflow-relevant completion and failure metadata |
| Modify | `src/cli/commands/status.ts` | Surface workflow operational summary |
| Create | `src/cli/commands/list-workflows.ts` | Inspect workflow items from CLI |
| Modify | `talond.yaml.example` | Document workflow config |
| Modify | `config/talond.yaml.example` | Mirror workflow config example if present |
| Modify | `README.md` | Describe workflow-kernel capability and rollout flags |
| Create | `tests/unit/workflow/workflow-service.test.ts` | Kernel service behavior |
| Create | `tests/unit/workflow/workflow-policy-registry.test.ts` | Policy pack binding and validation |
| Create | `tests/unit/workflow/workflow-evidence-adapter.test.ts` | Evidence normalization |
| Create | `tests/unit/workflow/workflow-watchdog.test.ts` | Deterministic intervention checks |
| Create | `tests/unit/workflow/workflow-read-model.test.ts` | Operational and audit query behavior |
| Modify | `tests/unit/core/config/config-schema.test.ts` | Workflow config defaults and validation |
| Modify | `tests/unit/daemon/agent-runner.test.ts` | Workflow claim/evidence hooks |
| Modify | `tests/unit/daemon/daemon-bootstrap.test.ts` | Bootstrap wiring |
| Modify | `tests/unit/daemon/daemon.test.ts` | Watchdog lifecycle |
| Modify | `tests/unit/tools/host-tools/persona-send.test.ts` | A2A to workflow integration |
| Modify | `tests/unit/tools/background-agent.test.ts` | Background-task evidence behavior |
| Modify | `tests/integration/a2a/a2a-task-flow.test.ts` | End-to-end authoritative orchestrator slice |
| Create | `tests/integration/workflow/workflow-kernel-sidecar.test.ts` | Sidecar observation path |

## Chunk 1: Schema, Config, and Kernel Service Boundary

### Task 1: Add durable workflow storage and bootstrap wiring

**Files:**
- Create workflow module and repositories
- Create `010-workflow-kernel.sql`
- Modify config and daemon bootstrap files
- Add unit tests for config and workflow service boundary

- [ ] **Step 1: Write the failing tests**

Cover:

- workflow config defaults to observational mode unless explicitly enabled
- workflow repositories initialize cleanly on a fresh database
- bootstrap wires `WorkflowKernelService` into `DaemonContext`
- workflow item creation emits an initial `workflow.created` event
- claim submission requires the core claim schema
- evidence attachment requires the core evidence schema

- [ ] **Step 2: Run the focused tests to confirm red**

Run:

```bash
npx vitest run \
  tests/unit/core/config/config-schema.test.ts \
  tests/unit/daemon/daemon-bootstrap.test.ts \
  tests/unit/workflow/workflow-service.test.ts
```

Expected:

- FAIL because workflow config and modules do not exist yet

- [ ] **Step 3: Implement the minimal production code**

Add:

- workflow tables and indexes
- repository layer
- workflow config types
- kernel service with create-item, submit-claim, attach-evidence, and event emission
- bootstrap wiring into daemon context

- [ ] **Step 4: Re-run the focused tests to green**

- [ ] **Step 5: Commit**

```bash
git add src/workflow src/core/database/migrations/010-workflow-kernel.sql src/core/database/repositories src/core/config/config-schema.ts src/core/config/config-types.ts src/daemon/daemon-context.ts src/daemon/daemon-bootstrap.ts tests/unit/workflow tests/unit/core/config/config-schema.test.ts tests/unit/daemon/daemon-bootstrap.test.ts
git commit -m "feat(workflow): add kernel schema and service boundary"
```

## Chunk 2: Claim, Evidence, and Transition Hooks

### Task 2: Integrate runtime claim and evidence capture

**Files:**
- Modify `src/daemon/agent-runner.ts`
- Modify `src/tools/host-tools-bridge.ts`
- Modify `src/tools/host-tools/background-agent.ts`
- Add evidence adapter tests

- [ ] **Step 1: Write the failing tests**

Cover:

- `AgentRunner` can attach a progress or blockage claim to an existing workflow item
- tool-call metadata can be normalized into evidence with provenance
- background-agent spawn, completion, timeout, and failure each produce distinct evidence records
- transition requests emit `workflow.transition_requested` events instead of mutating state implicitly

- [ ] **Step 2: Run the focused tests to confirm red**

Run:

```bash
npx vitest run \
  tests/unit/daemon/agent-runner.test.ts \
  tests/unit/tools/background-agent.test.ts \
  tests/unit/workflow/workflow-evidence-adapter.test.ts
```

- [ ] **Step 3: Implement the minimal production code**

Add:

- workflow helper calls in runtime paths
- evidence adapters for tool results and background tasks
- reason-coded transition decisions

- [ ] **Step 4: Re-run the focused tests to green**

- [ ] **Step 5: Commit**

```bash
git add src/daemon/agent-runner.ts src/tools/host-tools-bridge.ts src/tools/host-tools/background-agent.ts src/workflow tests/unit/daemon/agent-runner.test.ts tests/unit/tools/background-agent.test.ts tests/unit/workflow/workflow-evidence-adapter.test.ts
git commit -m "feat(workflow): record claims and evidence from runtime paths"
```

## Chunk 3: Watchdogs, Leases, and Read Models

### Task 3: Add deterministic stale-work evaluation and inspectable views

**Files:**
- Create `src/workflow/workflow-watchdog.ts`
- Create `src/workflow/workflow-read-model.ts`
- Modify daemon watchdog and CLI status surfaces

- [ ] **Step 1: Write the failing tests**

Cover:

- active leases expire deterministically and emit `workflow.lease_expired`
- repeated claim rejection produces an intervention request
- operational view returns current state, owner, blocker, and next expected transition
- audit feed returns append-only events in chronological order

- [ ] **Step 2: Run the focused tests to confirm red**

Run:

```bash
npx vitest run \
  tests/unit/workflow/workflow-watchdog.test.ts \
  tests/unit/workflow/workflow-read-model.test.ts \
  tests/unit/daemon/daemon.test.ts
```

- [ ] **Step 3: Implement the minimal production code**

Add:

- lease repository logic
- watchdog evaluator
- intervention records
- CLI or repository-level operational/audit views

- [ ] **Step 4: Re-run the focused tests to green**

- [ ] **Step 5: Commit**

```bash
git add src/workflow/workflow-watchdog.ts src/workflow/workflow-read-model.ts src/daemon/watchdog.ts src/daemon/daemon.ts src/cli/commands/status.ts src/cli/commands/list-workflows.ts tests/unit/workflow tests/unit/daemon/daemon.test.ts
git commit -m "feat(workflow): add watchdog evaluation and read models"
```

## Chunk 4: Authoritative Orchestrator Rollout

### Task 4: Bind one orchestrator-style delegated-task workflow to authoritative mode

**Files:**
- Create `src/workflow/packs/orchestrator-task-pack.ts`
- Modify `src/tools/host-tools/persona-send.ts`
- Modify `src/a2a/a2a-task-mapper.ts`
- Modify `tests/unit/tools/host-tools/persona-send.test.ts`
- Modify `tests/integration/a2a/a2a-task-flow.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:

- explicit orchestrator delegation through `persona.send` creates a workflow item
- A2A state changes map to workflow transitions correctly
- authoritative mode rejects completion without required evidence
- timeout or `input-required` states produce blocked or escalated workflow outcomes

- [ ] **Step 2: Run the focused tests to confirm red**

Run:

```bash
npx vitest run \
  tests/unit/tools/host-tools/persona-send.test.ts \
  tests/integration/a2a/a2a-task-flow.test.ts
```

- [ ] **Step 3: Implement the minimal production code**

Add:

- orchestrator policy pack
- A2A-to-workflow mapping
- authoritative completion gates for this one workflow type

- [ ] **Step 4: Re-run the focused tests to green**

- [ ] **Step 5: Commit**

```bash
git add src/workflow/packs/orchestrator-task-pack.ts src/tools/host-tools/persona-send.ts src/a2a/a2a-task-mapper.ts src/a2a/a2a-types.ts tests/unit/tools/host-tools/persona-send.test.ts tests/integration/a2a/a2a-task-flow.test.ts
git commit -m "feat(workflow): add authoritative orchestrator task rollout"
```

## Chunk 5: Docs, Config Examples, and Hardening

### Task 5: Document the workflow kernel and verify the integrated system

**Files:**
- Modify `README.md`
- Modify `talond.yaml.example`
- Modify `config/talond.yaml.example`
- Add or update integration coverage

- [ ] **Step 1: Write the failing or missing tests**

Cover:

- sidecar mode does not block normal execution when policy evaluation fails
- authoritative orchestrator mode blocks invalid completion transitions
- config examples load successfully if the repo validates example config in tests

- [ ] **Step 2: Run the focused tests to confirm red where applicable**

- [ ] **Step 3: Implement the minimal production code and docs**

Add:

- workflow config examples
- README documentation for rollout modes and workflow inspection
- any final integration assertions needed for sidecar vs authoritative behavior

- [ ] **Step 4: Run verification**

Run at minimum:

```bash
npx vitest run tests/unit/workflow tests/unit/daemon tests/unit/tools tests/integration/a2a tests/integration/workflow
```

Then run the broader repo verification appropriate to the changed surfaces.

- [ ] **Step 5: Request code review and address findings**

Run Codex review in read-only mode before the final commit or PR.

- [ ] **Step 6: Commit**

```bash
git add README.md talond.yaml.example config/talond.yaml.example tests
git commit -m "docs(workflow): document rollout and verification"
```

## Explicit Non-Goals For First Implementation

- Do not convert all queue items into workflow items.
- Do not auto-create workflow items from scheduler rules in the first slice.
- Do not make real-time dashboard transport a prerequisite for the kernel.
- Do not force the software-engineering workflow into authoritative mode before the orchestrator slice proves out.

## Exit Criteria

- workflow tables, repositories, and service exist
- claims and evidence are durable, structured, and auditable
- watchdog evaluation runs on durable workflow state
- operational and audit read paths exist
- one orchestrator-style delegated-task workflow runs in authoritative mode
- documentation and config examples are updated
- tests pass and code review has no unresolved critical or high-severity findings
