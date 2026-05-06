# Workflow Kernel Technical Design

**Status**: Draft
**Date**: 2026-04-04
**GitHub Issue**: https://github.com/ivo-toby/talon/issues/175
**Spec**: `specs/2026-04-04-domain-agnostic-workflow-kernel.md`

## 1. Purpose

This document narrows the workflow-kernel RFC into an implementable Talon design. It defines the concrete database model, internal service boundaries, claim and evidence capture APIs, rollout boundaries, and the path from an observational sidecar to authoritative workflow control.

## 2. Design Goals

- Add a durable workflow layer without rewriting Talon's queue, scheduler, persona, or background-agent model.
- Make claims and evidence first-class, structured records that can be attached to real Talon executions.
- Keep the kernel deterministic while letting domains evolve through policy packs.
- Start with explicit persona-created workflow items.
- Make the first authoritative rollout target narrow enough to prove the model before broad adoption.

## 3. Non-Goals

- No attempt to make all Talon work kernel-native in the first rollout.
- No requirement that every tool prompt or persona understand the full workflow schema.
- No full UI implementation in the first slice; this design defines the read model and event feed needed for one.
- No replacement of transcript history, memory, queue items, or A2A task records as independent runtime artifacts.

## 4. Recommended Architecture

Introduce a new `src/workflow/` module that owns workflow state and policy evaluation while integrating with existing runtime surfaces.

Core components:

- `WorkflowKernelService`
  - The main API for creating items, recording claims, attaching evidence, requesting transitions, and evaluating due policies.
- `WorkflowPolicyRegistry`
  - Resolves policy packs from code, config bindings, and plugin-provided extensions.
- `WorkflowEvidenceAdapter`
  - Normalizes tool results, background-task results, A2A task status, message references, and human approvals into workflow evidence records.
- `WorkflowWatchdog`
  - Runs deterministic stale-work, timeout, and escalation checks over durable workflow state.
- `WorkflowReadModel`
  - Provides operational and audit projections for dashboards, CLI, or host-tool inspection.

The kernel remains a sidecar at first:

- existing execution paths still run through `AgentRunner`, queue processing, `persona.send`, and background-agent flows
- those paths call workflow helpers to emit claims, evidence, and transition requests
- policy evaluation decides whether a requested transition is accepted, rejected, or left observational

## 5. Policy Placement Model

The RFC's hybrid model becomes concrete here:

- code owns:
  - workflow state machine primitives
  - lease acquisition and expiry rules
  - event emission
  - transition validation
  - watchdog scheduling
- config owns:
  - which policy pack is bound to which `workflow_type`
  - rollout mode per workflow type
  - thresholds, timeouts, and retry limits
- plugins own:
  - domain-specific claim/evidence extensions
  - prompt guidance
  - helper validators
  - custom transition predicates where needed

Policy definitions should not be authored primarily inside the database. The database should store the applied policy identifier and version for auditability, not act as the source authoring surface.

## 6. Concrete Data Model

### 6.1 Tables

#### `workflow_items`

Top-level durable workflow record.

Fields:

- `id`
- `workflow_type`
- `domain`
- `title`
- `goal_json`
- `state`
- `status_reason`
- `rollout_mode` (`observe`, `guided`, `authoritative`)
- `policy_pack`
- `policy_version`
- `owner_actor_id`
- `source_thread_id`
- `source_message_id`
- `source_run_id`
- `priority`
- `created_at`
- `updated_at`
- `completed_at`

Notes:

- `rollout_mode` allows the same kernel to operate as a passive observer for some workflow types and an authority for others.
- `source_*` fields give a stable bridge back to the originating Talon execution context.

#### `workflow_claims`

Structured actor assertions tied to workflow items.

Fields:

- `id`
- `workflow_item_id`
- `claim_type`
- `actor_id`
- `actor_kind` (`persona`, `human`, `system`, `background_agent`, `tool`)
- `action`
- `target`
- `asserted_outcome`
- `summary`
- `payload_json`
- `status` (`pending`, `accepted`, `rejected`, `superseded`)
- `policy_decision_json`
- `created_at`
- `resolved_at`

The kernel-level required fields are:

- `actor`
- `action`
- `target`
- `asserted_outcome`
- `timestamp`

Domain packs may require extra payload fields.

#### `workflow_evidence`

Durable evidence records tied to a claim or directly to a workflow item.

Fields:

- `id`
- `workflow_item_id`
- `claim_id`
- `evidence_type`
- `source`
- `locator`
- `captured_at`
- `provenance_json`
- `payload_json`
- `created_at`

The kernel-level required fields are:

- `type`
- `source`
- `locator`
- `captured_at`
- `provenance`

Examples:

- `source = tool_result`, `locator = tool_result:<id>`
- `source = background_task`, `locator = task:<task_id>`
- `source = channel_message`, `locator = message:<id>`
- `source = git`, `locator = sha:<commit>`

#### `workflow_events`

Append-only event log for audit and projection.

Fields:

- `id`
- `workflow_item_id`
- `event_type`
- `actor_id`
- `correlation_id`
- `payload_json`
- `created_at`

#### `workflow_leases`

Separate lease table instead of embedding mutable lease state into `workflow_items`.

Fields:

- `id`
- `workflow_item_id`
- `actor_id`
- `actor_kind`
- `lease_state` (`active`, `expired`, `released`)
- `acquired_at`
- `renewed_at`
- `expires_at`
- `released_at`

Rationale:

- preserves lease history
- allows repeated leases over one work item
- simplifies expiry auditing

#### `workflow_interventions`

Durable intervention and escalation records.

Fields:

- `id`
- `workflow_item_id`
- `intervention_type`
- `reason`
- `status` (`pending`, `applied`, `dismissed`)
- `payload_json`
- `created_at`
- `resolved_at`

### 6.2 Policy Definitions

Policy packs should load from code and plugin manifests, with config binding them to workflow types. Persist only the bound identity on the workflow item and in relevant events:

- `policy_pack`
- `policy_version`

If exact decision reproducibility becomes necessary, store a compact policy snapshot hash in event payloads rather than full JSON definitions in the database.

### 6.3 Initial Indexes

Recommended indexes:

- `workflow_items(workflow_type, state, updated_at)`
- `workflow_items(owner_actor_id, state)`
- `workflow_claims(workflow_item_id, status, created_at)`
- `workflow_evidence(workflow_item_id, created_at)`
- `workflow_events(workflow_item_id, created_at)`
- `workflow_leases(workflow_item_id, lease_state, expires_at)`
- `workflow_interventions(workflow_item_id, status, created_at)`

## 7. Internal Service Surface

### 7.1 Core TypeScript Interface

```ts
export interface WorkflowKernelService {
  createItem(input: CreateWorkflowItemInput): Result<WorkflowItem, WorkflowError>;
  submitClaim(input: SubmitWorkflowClaimInput): Result<WorkflowClaim, WorkflowError>;
  attachEvidence(input: AttachWorkflowEvidenceInput): Result<WorkflowEvidence, WorkflowError>;
  requestTransition(input: RequestWorkflowTransitionInput): Result<WorkflowDecision, WorkflowError>;
  acquireLease(input: AcquireWorkflowLeaseInput): Result<WorkflowLease, WorkflowError>;
  renewLease(input: RenewWorkflowLeaseInput): Result<WorkflowLease, WorkflowError>;
  releaseLease(input: ReleaseWorkflowLeaseInput): Result<void, WorkflowError>;
  evaluateDueWork(now?: number): Result<WorkflowEvaluationSummary, WorkflowError>;
}
```

### 7.2 Supporting Services

- `WorkflowPolicyRegistry.resolve(workflowType, domain)`
- `WorkflowReadModel.listOperationalView(filters)`
- `WorkflowReadModel.listAuditEvents(workflowItemId, cursor)`
- `WorkflowEvidenceAdapter.fromToolResult(...)`
- `WorkflowEvidenceAdapter.fromBackgroundTask(...)`
- `WorkflowEvidenceAdapter.fromPersonaTask(...)`
- `WorkflowEvidenceAdapter.fromApproval(...)`

### 7.3 Event Emission Contract

Every successful mutation emits one append-only event. Rejected transition requests also emit events so the audit log explains why work did not advance.

Initial event types:

- `workflow.created`
- `workflow.claim_submitted`
- `workflow.claim_accepted`
- `workflow.claim_rejected`
- `workflow.evidence_added`
- `workflow.transition_requested`
- `workflow.state_changed`
- `workflow.lease_acquired`
- `workflow.lease_renewed`
- `workflow.lease_expired`
- `workflow.lease_released`
- `workflow.intervention_requested`
- `workflow.intervention_applied`
- `workflow.completed`
- `workflow.failed`
- `workflow.cancelled`

## 8. Claim And Evidence Capture Integration

### 8.1 AgentRunner

`AgentRunner` should remain execution-first, but gain optional workflow hooks:

- create claims when a persona explicitly reports progress, blockage, completion, or scope change
- attach run-level evidence such as `run_id`, generated output references, and verification summaries
- request transitions instead of mutating workflow state directly

### 8.2 MCP Tools And Host Tools

The calling agent remains responsible for proving work. Tools should expose enough structured result data for the caller to attach evidence without re-parsing raw prose.

Useful integration points:

- `src/tools/host-tools-bridge.ts`
- `src/tools/host-tools/persona-send.ts`
- `src/tools/host-tools/background-agent.ts`
- `src/tools/host-tools/channel-send.ts`

Recommended behavior:

- tool results can be wrapped as evidence with provenance pointing to tool name, request ID, and any durable record ID
- helper functions should make this easy, but never auto-advance work without an explicit claim or transition request

### 8.3 Background Agents

Background-agent completion should not silently imply success.

Required workflow behavior:

- spawning may attach evidence that delegated work began
- completion may attach evidence to a pending claim
- timeout, failure, or missing result should create a blocked or failed claim path and trigger watchdog evaluation

### 8.4 Persona Delegation / A2A

`persona.send` and `a2a_tasks` are the best fit for the first authoritative slice because they already have:

- durable task IDs
- durable state transitions
- explicit source and target personas
- queue item linkage
- timeout and error surfaces

The kernel should not replace `a2a_tasks`. Instead:

- workflow items reference the originating A2A task
- A2A status changes produce claims and evidence
- the kernel decides whether the task lifecycle may be considered complete for higher-level workflow purposes

## 9. Transition And Policy Evaluation

Transitions are requested, not assumed.

Decision model:

- `observe`
  - record the request and emit events, but do not block the underlying runtime path
- `guided`
  - warn, intervene, or schedule follow-up when policy fails, but still leave the runtime path mostly intact
- `authoritative`
  - reject unsupported state transitions and require evidence gates to pass

Each policy evaluation should return:

- decision (`accepted`, `rejected`, `deferred`)
- reason codes
- missing evidence requirements
- intervention recommendation if applicable

This lets the watchdog, dashboard, and human operator see not just what happened, but why.

## 10. Watchdogs And Interventions

The watchdog loop should operate over durable workflow state, not transcript heuristics.

Initial deterministic checks:

- active lease expired
- no claim or state change after configured freshness threshold
- repeated claim rejection on the same item
- blocked state without new evidence or approval activity
- completed background task with no attached claim or transition request

Intervention outputs:

- enqueue a follow-up message
- request human approval
- mark item `blocked`
- escalate to another persona
- emit an audit event only in observational mode

## 11. Operational View And Audit Feed

### 11.1 Operational Read Model

The operational view should answer "what is happening right now?" with one row per workflow item.

Recommended fields:

- `workflow_item_id`
- `title`
- `workflow_type`
- `state`
- `owner_actor_id`
- `policy_pack`
- `rollout_mode`
- `latest_claim_summary`
- `latest_evidence_locator`
- `blocked_reason`
- `lease_expires_at`
- `next_expected_transition`
- `updated_at`

This can be implemented initially as a SQL view or a repository query rather than a separate projector.

### 11.2 Audit Feed Envelope

Recommended payload shape:

```ts
interface WorkflowEventEnvelope {
  id: string;
  workflowItemId: string;
  type: string;
  actorId?: string;
  correlationId?: string;
  createdAt: number;
  payload: Record<string, unknown>;
}
```

The dashboard or CLI can build:

- item timelines
- persona swimlanes
- policy decision cards
- blocker drill-down

### 11.3 Delivery Model

First delivery should support repository-internal consumers via:

- repository queries
- CLI inspection commands
- optional polling for a dashboard

Real-time push such as SSE or WebSocket should be deferred until the underlying event model is stable.

## 12. First Authoritative Rollout Boundary

The first authoritative rollout should target orchestrator-style delegated tasks, implemented on top of existing A2A and queue primitives.

Boundary:

- only explicit persona-created workflow items
- only one workflow type in authoritative mode
- only delegation/task-completion flows for orchestrator-owned work
- no automatic item creation by the scheduler in the initial rollout

Concrete starting point:

- create a workflow item when an orchestrator persona delegates durable work through `persona.send`
- map A2A task states into workflow transitions:
  - `submitted` -> `ready`
  - `working` -> `in_progress`
  - `input-required` -> `blocked`
  - `completed` -> `awaiting_validation` or `done`, depending on policy and evidence
  - `failed` -> `escalated` or `blocked`
  - `canceled` -> `cancelled`

This gives Talon a narrow but real proving ground for authoritative transitions without forcing the full software-engineering lifecycle into the first rollout.

## 13. Migration Strategy

### Phase 1: Schema And Observational Sidecar

- add workflow tables and repositories
- expose `WorkflowKernelService`
- create items explicitly from personas
- attach claims and evidence without enforcement

### Phase 2: Structured Runtime Hooks

- add helper APIs in `AgentRunner`, `persona.send`, and `background-agent`
- enable watchdog evaluation and intervention scheduling
- introduce operational and audit read paths

### Phase 3: Guided Policy Evaluation

- activate `guided` mode for selected workflow types
- surface missing evidence and stale-work interventions
- require explicit transition requests for important lifecycle changes

### Phase 4: Authoritative Orchestrator Workflow

- bind one orchestrator task workflow type to authoritative mode
- gate completion on policy evaluation and evidence
- make watchdog decisions operationally meaningful

### Phase 5: Broader Domain Packs

- expand to software delivery, PM, research, and support policy packs
- expose pack selection and thresholds through config and plugin extension points

## 14. Risks And Mitigations

- Risk: workflow capture becomes prompt boilerplate.
  - Mitigation: provide helper APIs and evidence adapters at the runtime/tool layer.
- Risk: policy packs become hardcoded core logic.
  - Mitigation: keep kernel generic and bind domain logic through registry/config/plugins.
- Risk: the first rollout is too broad.
  - Mitigation: constrain authoritative mode to one orchestrator delegation workflow.
- Risk: audit data becomes noisy but not useful.
  - Mitigation: require event reason codes and durable correlation IDs from the start.

## 15. Recommended Next Artifact

The next artifact after this technical design is the implementation plan in:

- `specs/plans/2026-04-04-workflow-kernel-implementation-plan.md`
