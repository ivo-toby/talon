# Signal channel knowledge draft

## Root causes

- The pipeline persists a transcript before enqueueing, then treats an existing
  idempotency key as a completed duplicate. Enqueue failure can therefore leave
  a recorded message without a retryable turn. The draft spec includes a focused
  handoff repair (`src/pipeline/message-pipeline.ts:140`,
  `src/pipeline/message-pipeline.ts:212`).

## Quirks

- The connector callback currently returns no typed pipeline outcome; the
  shared interface accepts a void-returning handler
  (`src/channels/channel-types.ts:143`). Durable receive acknowledgement cannot
  be inferred from completion of that callback.
- The source-based Signal research is in `research_notes/Signal channel
  feasibility/`. No live account or device test was performed during that
  research. Personal-account operator commands and agent echoes still require
  live provenance verification.

## Decisions

- Ivo agreed to the immutable epic name `signal-channel` and to use the existing
  draft spec as the intake source.
- Ivo approved retaining the current WDD constitution/configuration and
  inheriting all settings for this epic on 2026-10-14. Those approvals were
  recorded through wddctl; no epic overrides were added.
- Ivo chose both personal-linked and dedicated Signal account modes, DMs and
  groups, and deferred attachments while cross-channel attachment work proceeds
  separately.
- Ivo chose both Note to Self and selected chats as personal-account entry
  points: Note to Self activates without a prefix; selected chats require an
  explicit trigger. Agent output never activates another turn.
- The canonical spec is `.wdd/epics/signal-channel/spec.md`, copied byte-for-byte
  from `docs/superpowers/specs/2026-10-14-signal-channel-spec.md`. Ivo explicitly
  signed off on that text on 2026-10-14; wddctl recorded all 15 acceptance
  criteria, including Unix-socket transport, disappearing-message exclusion,
  and focused handoff repair. No adversarial review was requested first.

## Review catches
