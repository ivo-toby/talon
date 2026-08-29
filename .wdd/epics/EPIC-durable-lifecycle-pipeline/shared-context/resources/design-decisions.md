---
id: EPIC-durable-lifecycle-pipeline-RESOURCE-design-decisions
kind: shared_context_resource
epic: EPIC-durable-lifecycle-pipeline
resource: design-decisions
updated_at: 2026-07-15
---

# Shared Context Resource: Design Decisions

## Purpose

Resolve issue #256's open questions sufficiently for task planning. Amend these
only when implementation evidence shows a safer or simpler design.

## Summary

The first version favors explicit, native, recoverable behavior over a broad
plugin surface. It ships all four proposed interception boundaries, uses stable
configured identities, compacts completed history after an audit window, and
keeps self-improvement governed and reversible.

## Decisions

1. **Retention:** retain pending, failed, and dead-letter state operationally;
   compact completed payload/delivery detail after a configurable audit window.
   Keep minimal audit/provenance records only where policy requires them.
2. **Initial hooks:** implement `message.before_persist`, `run.before_execute`,
   `tool.before_execute`, and `message.before_send`; phase their integrations
   after the interceptor contract and budgets are proven.
3. **Attachment scope:** define handlers globally and attach explicitly to
   personas. Provider config owns context measurement. Validated filters may
   narrow by event type, item origin/type, channel, persona, or schedule/message
   source; no arbitrary expressions.
4. **Context rotation:** dispatch observer/projector work durably with high
   priority and per-thread ordering. A completed user response is not delayed,
   but the next ordinary item for that thread waits until the required context
   projection resolves or applies its explicit preserve-session failure policy.
5. **Contracts:** native contracts use built-in versioned TypeScript schemas.
   JSON Schema may describe additional configured sub-agent outputs, but a
   native projector only accepts contracts it explicitly supports.
6. **Prompt promotion:** default to operator approval. Auto-promotion is limited
   to explicitly pre-authorized narrow changes after provenance, conflict,
   evaluation, write, reload, and rollback gates all succeed.
7. **Behavior storage:** start with dedicated persona-scoped behavior signal and
   promotion/evaluation records. Generalization to a broader signal platform is
   deferred until at least one additional native consumer proves the need.
8. **Privacy deletion:** events contain minimal references. Thread/persona
   privacy deletion removes or tombstones associated live event payloads and
   delivery detail while preserving only non-content audit facts required by
   policy. Compaction and deletion behavior share one tested retention service.
9. **Handler identity:** idempotency uses a stable configured handler ID plus
   implementation/contract version captured on the delivery. Display names and
   hot-reloaded prompt/model choices do not rewrite existing delivery identity.
10. **Langfuse:** lifecycle handler execution uses existing correlation and
    observation facilities. Consuming historical trace evidence waits for issue
    #70 and remains optional.

## Planning Consequences

- Create a contract/config task before database and dispatcher tasks.
- Create migration/repository and dispatcher tasks before publishing events.
- Prove a minimal end-to-end run/message slice before broad instrumentation.
- Migrate observational memory only after contract validation, ordered durable
  projection, and compatibility translation exist.
- Separate behavior detection/storage from governed promotion/evaluation.
- Put retention/privacy, CLI operations, metrics, and hot reload into explicit
  tasks rather than treating them as cleanup.

## Durable Memory

### Issue 256 Initial Defaults

- Source task: epic definition for GitHub issue #256
- Source PR/branch: `epic/durable-lifecycle-pipeline`
- Status: confirmed initial decision
- Summary: Explicit persona attachment, built-in native contracts, durable
  ordered context projection, audit-window compaction, dedicated behavior
  ledger, operator-approved promotion, and optional issue #70 evidence.
- Why it matters: These defaults remove planning ambiguity and define task
  boundaries without expanding the first version to remote handlers or generic
  expression/plugin execution.
- Affected files or areas: config, lifecycle registry, database, context
  management, behavior projectors, CLI, retention, observability.
- Follow-up implications: Revisit only through a documented epic decision with
  migration and compatibility impact.
