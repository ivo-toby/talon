# Talon self-documentation

This document is the compact architectural map for maintainers and operators.
It intentionally describes the current daemon shape rather than a future design.

## What Talon is

Talon (`talond`) is a self-hosted autonomous agent daemon. It receives human
messages from channel connectors, stores them durably, routes work through a
SQLite-backed queue, runs an agent provider, exposes capability-filtered host
tools, and sends responses back through the originating channel. The default
posture is local-first: runtime state, audit evidence, queues, memory, and
artifacts stay on the operator's machine.

## Runtime flow

```text
Channel connector
  -> MessagePipeline
  -> Durable queue
  -> QueueProcessor
  -> AgentRunner provider runtime
  -> Host-tools MCP bridge
  -> Channel connector response
```

The queue is the durability seam. Incoming messages are normalized,
deduplicated, persisted, and enqueued before provider execution. Provider runs
record usage and session identity, host-tool calls are capability filtered, and
channel sends are audited.

## Durable lifecycle pipeline

The lifecycle pipeline is Talon's extension spine for events that cross core
boundaries. It solves a specific problem: features such as context rotation,
behavior learning, telemetry, replay, and governed prompt promotion need to
observe the same daemon facts without each feature patching the message queue,
agent runner, scheduler, tools, and channels independently.

The lifecycle runtime publishes bounded, versioned envelopes for key daemon
events:

- inbound and outbound messages;
- queue enqueue, completion, failure, and dead-letter transitions;
- provider run start/completion/failure;
- provider tool start/completion;
- context threshold and rotation events;
- schedule firing.

Each event contains stable ids, causal context, recursion metadata, references,
and bounded scalar metadata. It deliberately does not persist raw unbounded
transcripts or arbitrary object graphs.

## Handler model

Lifecycle handlers use two lanes:

- Native handlers are trusted code shipped in Talon. They may enforce
  interceptors or mutate governed internal state when their contracts allow it.
- Sub-agent handlers are model-backed observers. They receive fenced lifecycle
  input and can return bounded lifecycle signals, but they cannot directly
  write prompts, memory, tools, config, or databases. A persona must both
  subscribe the lifecycle handler and list the handler's sub-agent name in
  `personas[].subagents`; subscription alone does not load or authorize the
  model-backed runtime.

Personas subscribe explicitly to handlers. A globally declared handler is inert
until a persona attaches an event, signal, or interceptor subscription. This
keeps behavior scoped by persona, channel, source, and schedule filters instead
of creating implicit global hooks.

## Context management

Provider context management now lives under
`agentRunner.providers.<name>.contextManagement`.

The legacy single-summary mode uses `session-summarizer` to compress a thread
when a configured usage metric crosses a threshold. Observation mode uses
`session-observer` to write dated observations and `session-reflector` to
consolidate long observation logs. Legacy configs that use
`summarizer: session-observer` are translated at load time to explicit
observation mode, but new configs should use `mode: observation`,
`observer: session-observer`, and `reducer: session-reflector`.

Lifecycle context signals are proposals. Native context handlers own durable
context mutation so model output cannot silently rewrite session state.

## Behavior learning and prompt promotion

Behavior learning is intentionally governed. The
`behavior-feedback-detector` sub-agent can inspect fenced lifecycle events and
emit `behavior.feedback.detected.v1` signals. The native behavior projector
validates source ids, fingerprints evidence, enforces persona scope, stores
ledger evidence, and creates bounded candidates.

Prompt promotion is native-only. Talon resolves the persona-owned
`systemPromptFile`, validates a bounded prompt patch emitted by behavior review,
defaults to operator approval, allows only explicit narrow auto-policy for
append-only style, preference, or context changes, evaluates the candidate,
writes through an atomic same-file rename, verifies daemon reload, records
provenance, and keeps rollback evidence. Candidates that cannot be represented
as small bounded prompt patches remain notes-only and are not applicable through
`talonctl lifecycle promote`. Safety, capability, tool, integration, or
notification expansions require explicit operator approval.

Operators inspect and control this surface with:

```bash
talonctl lifecycle handlers
talonctl lifecycle inspect <event-id> --handler <handler-id>
talonctl lifecycle replay <event-id> <handler-id>
talonctl lifecycle disable <handler-id>
talonctl lifecycle candidates <persona> --limit 25
talonctl lifecycle promote <persona> <promotion-id> --approved-by operator
talonctl lifecycle rollback-promotion <persona> <activation-id> --reason operator-rejected
```

## Persistence, retention, and privacy

SQLite is the durable store. Lifecycle events and handler deliveries are
persisted separately so the dispatcher can retry, dead-letter, replay terminal
failures, and preserve handler snapshots even if configuration changes later.

Retention compaction may remove completed/no-subscriber event payload and
provenance detail after the configured audit window. Pending, claimed, failed,
dead-letter, handler-disabled, and privacy-deleted rows retain their safety
semantics. Thread/persona privacy deletion tombstones matching lifecycle event
detail and dead-letters outstanding matching deliveries.

## Security boundaries

The important security rule is that model output is advisory unless trusted
native code decides otherwise. Talon enforces that with:

- strict Zod contracts at lifecycle boundaries;
- bounded references and scalar metadata for durable events/signals;
- fenced prompts for sub-agent lifecycle input;
- explicit persona subscriptions and filters;
- native-only enforcing interceptors;
- native-only lifecycle interceptors;
- native-only governed prompt promotion;
- capability-filtered host tools;
- audit records for lifecycle publication, delivery, retries, decisions,
  prompt promotion, rollback, and retention.

## Operator-facing docs

Use `README.md` for the broad user guide, `docs/reference/config-schema.mdx`
for exact config fields, `config/talond.example.yaml` for a commented template,
and `.agents/skills/` plus `.claude/skills/` for guided local setup flows.
