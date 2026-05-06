# Domain-Agnostic Workflow Kernel Sidecar

**RFC** | 2026-04-04 | Talon Project
**Status**: Draft v1
**GitHub Issue**: https://github.com/ivo-toby/talon/issues/175
**Last updated**: 2026-04-04

---

## 1. Problem Statement

Talon can already drive long-running work with scheduled prompts and heartbeat-style reviews, but those prompts are advisory. They can ask an agent or persona to inspect work, summarize progress, or check alignment, yet they do not provide a durable control plane.

This creates a reliability gap:

- a prompt can be missed, misread, or interpreted incorrectly
- the system cannot prove that required checkpoints were met
- state transitions are implicit in conversation rather than explicit in data
- stale or drifting work is hard to detect without re-reading transcripts
- retries and escalations are probabilistic instead of policy-driven

The result is that Talon has useful supervision, but not a workflow kernel.

This spec proposes a **domain-agnostic workflow kernel sidecar** that bolts onto Talon's current execution model. The kernel provides durable state, event logging, claims, evidence, leases, and watchdog rules. Personas continue to do the work they do today; the new layer decides what is allowed to advance, what is stale, and what intervention is required.

## 2. Goals

1. Add a generic control layer for autonomous work that is not specific to software engineering.
2. Keep the first phase bolt-on and compatible with Talon's current personas, scheduler, and queue model.
3. Make progress depend on explicit claims plus durable evidence, not only on conversational assertions.
4. Support domain-specific policy packs without forcing domain logic into the core kernel.
5. Make heartbeats more useful by grounding them in structured state instead of free-form transcript review.

## 3. Non-Goals

- Replace the current persona model in the first iteration.
- Rewrite the queue, scheduler, or background-agent architecture before the sidecar proves value.
- Force all work types into one rigid lifecycle.
- Solve multi-agent planning quality through schema alone.
- Implement this design as part of this spec branch review cycle; implementation is expected later, after the spec is reviewed and approved.

## 4. Design Principles

### 4.1 Deterministic control, probabilistic reasoning

LLMs remain responsible for interpretation, diagnosis, planning, and proposal. The kernel is responsible for durable state, lifecycle guards, retries, leases, and intervention triggers.

### 4.2 Claims do not advance work by themselves

An agent saying "this is done" is a claim, not a state transition. Advancement requires policy evaluation against available evidence.

### 4.3 Domain semantics live in policy packs

The kernel only understands generic concepts such as states, claims, evidence, interventions, and role permissions. Software delivery, research, PM planning, or support triage semantics live outside the kernel in domain policy packs.

### 4.4 Sidecar first

The first implementation should observe and guide the current system before becoming authoritative. This keeps the migration bounded and lowers integration risk.

## 5. Core Abstractions

### 5.1 WorkItem

The unit of work being progressed. A work item has:

- a stable ID
- a domain type
- an objective
- current state
- declared deliverables
- actors and ownership metadata
- deadlines or freshness constraints

### 5.2 Goal

The success condition for a work item. This should be explicit and machine-readable enough to support policy checks, even if some evaluation still requires model judgment.

### 5.3 State

The current lifecycle position. The kernel does not mandate one universal workflow, but it does require explicit states and allowed transitions per workflow type.

Example generic states:

- `intake`
- `ready`
- `in_progress`
- `awaiting_validation`
- `blocked`
- `escalated`
- `done`
- `cancelled`

### 5.4 Claim

A structured assertion by an actor about progress, findings, completion, blockage, or changed scope.

Examples:

- "I produced a draft spec"
- "I am blocked on a missing credential"
- "The deliverable appears complete"
- "Scope changed and needs approval"

### 5.5 Evidence

Durable artifacts or observations attached to a claim.

Examples:

- file paths
- test outputs
- URLs
- message IDs
- issue or PR numbers
- approval records
- metrics or timestamps

### 5.6 Policy

Rules that determine:

- who may act
- which transitions are allowed
- what evidence is required
- when retries are valid
- when work is stale
- when escalation is mandatory

### 5.7 Intervention

A structured action triggered by policy or a watchdog when work becomes stale, inconsistent, or uncertain.

Examples:

- request status audit
- renew or revoke lease
- ask for missing evidence
- requeue work
- escalate to another persona
- escalate to a human

### 5.8 Role

A permission boundary for who may create claims, validate evidence, approve scope changes, or close work.

## 6. Why Heartbeat Alone Is Not Enough

Heartbeat prompts are still useful, but they are not sufficient as the primary loop because they are:

- advisory rather than authoritative
- hard to make idempotent
- weak at exactly-once transitions
- poor at enforcing machine-checkable checkpoints
- vulnerable to silent drift when the model fails to notice a required detail

Heartbeat becomes much stronger once it is reduced to a specific intervention over structured state:

- "audit stale work item `W-123`"
- "evaluate whether evidence satisfies the goal"
- "summarize risks before escalation"

That is a better fit than asking the model to infer the entire workflow state from transcript alone.

## 7. Proposed Architecture

```text
Scheduler / Trigger / External Event
  -> WorkflowKernel
       -> loads WorkItem + current state + lease + evidence summary
       -> evaluates policy
       -> chooses next action
            - continue
            - request claim
            - validate
            - wait
            - retry
            - escalate
            - finish
       -> emits durable workflow events
  -> Existing Talon execution paths
       - AgentRunner
       - background_agent
       - persona_send
       - scheduler
  -> Actor returns claim + evidence
  -> WorkflowKernel validates transition
```

The important point is that the kernel does not replace Talon's execution engines. It sits beside them and decides how work should progress.

## 8. Data Model

### 8.1 Tables

Suggested initial tables:

#### `workflow_items`

Top-level work item record.

Fields:

- `id`
- `workflow_type`
- `domain`
- `title`
- `goal_json`
- `state`
- `owner_actor_id`
- `lease_expires_at`
- `priority`
- `created_at`
- `updated_at`
- `completed_at`

#### `workflow_events`

Append-only event log.

Fields:

- `id`
- `workflow_item_id`
- `event_type`
- `actor_id`
- `payload_json`
- `created_at`

#### `workflow_claims`

Structured claims made by actors.

Fields:

- `id`
- `workflow_item_id`
- `claim_type`
- `actor_id`
- `summary`
- `payload_json`
- `status` (`pending`, `accepted`, `rejected`, `superseded`)
- `created_at`
- `resolved_at`

#### `workflow_evidence`

Durable evidence records linked to claims or directly to work items.

Fields:

- `id`
- `workflow_item_id`
- `claim_id`
- `evidence_type`
- `uri`
- `payload_json`
- `created_at`

#### `workflow_policies`

Versioned workflow and domain policy definitions.

Fields:

- `id`
- `workflow_type`
- `domain`
- `version`
- `definition_json`
- `active`
- `created_at`

### 8.2 Event Types

Initial event set:

- `workflow.created`
- `workflow.state_changed`
- `workflow.lease_acquired`
- `workflow.lease_expired`
- `workflow.claim_submitted`
- `workflow.claim_accepted`
- `workflow.claim_rejected`
- `workflow.evidence_added`
- `workflow.intervention_requested`
- `workflow.escalated`
- `workflow.completed`
- `workflow.cancelled`

This event log becomes the durable source of truth for supervision and audit.

## 9. Transition Model

Each workflow type defines:

- allowed states
- allowed transitions
- required evidence for specific transitions
- which roles may approve which transitions
- timeout thresholds and retry limits

Example:

- `ready -> in_progress` may require lease acquisition
- `in_progress -> awaiting_validation` may require at least one claim with attached evidence
- `awaiting_validation -> done` may require policy approval and zero unresolved blockers
- `blocked -> escalated` may occur automatically after a timeout

This allows Talon to stay generic while still supporting strict workflows where needed.

## 10. Leases And Watchdogs

### 10.1 Leases

Every active worker can hold a lease on a work item. The lease records:

- current actor
- acquired timestamp
- expiry timestamp
- last renewal timestamp

If the lease expires without renewal, the kernel does not assume success or failure. It emits `workflow.lease_expired` and evaluates the configured intervention policy.

### 10.2 Watchdogs

Watchdogs are deterministic checks over durable state, not conversational guesses.

Examples:

- no state change for 30 minutes while `in_progress`
- repeated claim rejection without policy change
- work item in `awaiting_validation` without validator activity
- scope changed but no approval claim recorded
- repeated `blocked -> in_progress -> blocked` oscillation

Watchdogs can schedule interventions without guessing what happened in the transcript.

## 11. Domain Policy Packs

The workflow kernel is generic, but policies are not.

Examples:

### 11.1 Software Delivery

Evidence examples:

- failing test first
- green test run
- commit SHA
- PR URL
- code review status

Policy examples:

- cannot enter `done` without verification evidence
- cannot close review feedback without a reply or a justified rejection

### 11.2 Project Management

Evidence examples:

- approved spec
- dependency resolution notes
- stakeholder approval

Policy examples:

- scope changes require explicit approval
- planning cannot complete while dependencies remain unresolved

### 11.3 Research

Evidence examples:

- source links
- synthesized notes
- confidence score
- open questions

Policy examples:

- high-impact recommendations require cited evidence
- low-confidence findings trigger review instead of completion

The kernel remains stable while domain packs evolve independently.

## 12. Integration With Existing Talon Features

### 12.1 Scheduler

The scheduler should trigger policy evaluation, lease expiry checks, and interventions. It should stop issuing generic "check on this" prompts when a more specific intervention can be derived from workflow state.

### 12.2 AgentRunner And Background Agents

Current execution paths remain unchanged at first. They receive more structured assignments and should emit claims and evidence back into the kernel.

### 12.3 Memory And Conversation History

Conversation remains useful for context, but it is no longer the authoritative store for work progress. Memory can summarize state; the kernel owns state transitions.

### 12.4 Personas

Personas do not need a rewrite in phase 1. They keep producing outputs, but Talon starts asking for structured claims and evidence at key checkpoints.

## 13. Migration Plan

### Phase 1: Observing Sidecar

- add workflow tables and event logging
- create workflow items for selected task types
- mirror current state transitions without enforcing them
- emit lease and watchdog diagnostics only

Success criteria:

- durable visibility into stale work and missing checkpoints
- no behavior change required for existing personas

### Phase 2: Guided Interventions

- route heartbeat prompts through workflow state
- replace generic nudges with explicit interventions
- require claims and evidence for selected transitions

Success criteria:

- fewer silent stalls
- better auditability for progress and blockage

### Phase 3: Evidence-Gated Workflows

- make policy authoritative for selected workflow types
- reject unsupported transitions
- enforce lease expiry and escalation rules

Success criteria:

- completion depends on evidence, not conversational confidence
- workflow status is reconstructable without transcript review

### Phase 4: Policy-Pack Expansion

- add first-class domain packs for software delivery, PM, research, and support
- expose policy configuration in Talon config or plugin extension points

## 14. Benefits

- better reliability for autonomous loops
- better auditability and postmortem quality
- clearer separation between facts and judgment
- safer retries and escalations
- reusable workflow control across domains

## 15. Risks

- over-modeling simple tasks with unnecessary workflow overhead
- creating two competing sources of truth during migration
- adding too much schema complexity before one workflow proves out
- requiring agents to emit structured claims without good UX or helper tooling

The mitigation is to start narrow, keep the kernel sidecar-only at first, and introduce authoritative transitions only after the observed model is stable.

## 16. Review Decisions

### 16.1 Workflow item creation

Initially, workflow items should be created explicitly by personas, not implicitly by scheduler rules. The personas are the domain experts when prompted correctly, and they are in the best position to decide when work should become a first-class tracked item.

Scheduler-created workflow items may be introduced later for narrowly defined system concerns such as stale-work intervention, automatic retries, or lease-based escalation, but they should not be the starting point for the model.

### 16.2 Smallest useful claim and evidence schema

The smallest useful schema is not fixed by domain semantics alone. Simple tasks such as creating a calendar appointment have a much smaller claim and evidence surface than complex workflows such as shipping a software feature.

The kernel should therefore require a minimal core schema and allow domain packs to extend it:

- claim core: `actor`, `action`, `target`, `asserted_outcome`, `timestamp`
- evidence core: `type`, `source`, `locator`, `captured_at`, `provenance`

This keeps the kernel generic while allowing policy packs to demand richer structured evidence where the domain requires it.

### 16.3 Policy-pack placement

Policy packs should use a hybrid placement model:

- code owns the kernel contract, state machine enforcement, leases, watchdog rules, and transition validation
- config owns pack selection, thresholds, rollout flags, and default bindings
- plugins own domain-specific schemas, prompts, helper logic, and extension points

This keeps the control plane deterministic without forcing every domain-specific behavior into Talon's core.

### 16.4 MCP tools and background agents

Claim and evidence capture should remain the responsibility of the agent that invokes MCP tools or spawns background agents. That agent is responsible for proving that the work is complete and for attaching the relevant evidence to the workflow item.

If a background agent cannot complete the work, or if the calling agent lacks the tools or permissions to complete or verify the task itself, the kernel should record that as failed or blocked work. The watchdog layer should treat that as an intervention condition rather than allowing the work to remain in an ambiguous state.

### 16.5 First authoritative rollout candidate

The first authoritative rollout should be the orchestrator task lifecycle rather than the software engineering workflow.

The orchestrator path already has the right shape:

- explicit tasks
- ownership
- blocked and failed states
- human review and approval
- clear transitions between draft, ready, in progress, review, and done

That makes it a better proving ground for authoritative workflow state than software delivery, which has a larger and more failure-prone surface area.

## 17. Deeper Integration

The workflow kernel starts as a sidecar. Deeper integration begins when Talon stops treating workflow state as an observational layer and starts using it as the canonical substrate for coordination.

At that point:

- personas emit claims against workflow items rather than only sending conversational status updates
- MCP calls and background-agent runs produce evidence records with provenance that can be attached to claims
- scheduler and heartbeat logic evaluate workflow state and policy rather than inferring progress from transcript text alone
- human approvals, rejections, and escalations operate on workflow items directly
- queueing, retries, and watchdog interventions become visible consequences of workflow state instead of separate hidden mechanisms

The important boundary is that deeper integration should not require every tool or persona to understand the full kernel model. Helper APIs or host tools should make it easy to create claims, attach evidence, and transition state without forcing repeated boilerplate into prompts.

## 18. End-User Visibility

If this system becomes a real control plane, its state and transitions must be visible to the user without requiring transcript archaeology.

Two visibility surfaces are required:

### 18.1 Real-time operational view

This view should show:

- active workflow items
- current state
- assigned persona or owner
- latest claim
- latest evidence
- current blocker or failure reason
- lease expiry or stale-work deadline
- next expected transition

This is the view that answers, "What is happening right now?"

### 18.2 Audit view

This view should be append-only and reconstructable. It should show:

- workflow item creation
- every claim
- every evidence attachment
- every accepted or rejected transition
- policy decisions
- watchdog interventions
- human approvals and rejections

This is the view that answers, "Why did the system believe this work advanced, stall, or finish?"

The dashboard should eventually expose both views in a way that supports drill-down from high-level company operations into a single item's full history.

## 19. Relationship To Force

This workflow kernel is a foundational building block for the Force concept.

If Force is a digital representation of a company running on agents, then it needs more than message routing and persona prompts. It needs:

- durable goals and work items
- delegated ownership
- explicit claims of progress
- evidence attached to those claims
- policy-based approval and escalation
- end-user visibility into state, flow, and history

Without those pieces, Force risks becoming an impressive chat surface without a reliable operating model. With them, it can evolve into a company-level control plane where goals, work, agents, approvals, and outcomes are all durable and inspectable.

## 20. Recommendation

Build this as a bolt-on sidecar, not as a rewrite. The smallest useful version is:

- `workflow_items`
- `workflow_events`
- `workflow_claims`
- `workflow_evidence`
- lease expiry checks
- one watchdog loop
- heartbeat prompts driven by workflow state

That is enough to prove the architecture before Talon makes the kernel authoritative.

The next artifact after this spec should be a technical design, not an implementation plan.

That follow-on work now exists in:

- `specs/2026-04-04-workflow-kernel-technical-design.md`
- `specs/plans/2026-04-04-workflow-kernel-implementation-plan.md`

The spec now defines the problem, the concepts, and the product direction. A technical design should narrow that into:

- concrete database changes
- host-tool or API surfaces for claim and evidence capture
- dashboard data model and event stream shape
- rollout boundaries for the first authoritative orchestrator workflow
- migration strategy from observational sidecar to authoritative control

After that design exists, an implementation plan can break the work into phases, tasks, and checkpoints. If you intend to implement this yourself in Claude Code to build intuition, that is the right sequence. It gives you a stronger mental model before you start making irreversible schema and orchestration decisions.
