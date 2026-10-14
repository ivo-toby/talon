# TASK-001: Image configuration and inbound contracts

## Objective

Define the shared image vocabulary and validate image settings without changing outbound Attachment requirements.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Typed closed Image outcomes and inbound payload-or-rejection Attachments exist; configuration supplies the six approved defaults and rejects invalid overrides.

## Interfaces

Consumes:

Spec part (a), glossary CONTEXT.md, and inventory I1. Existing config schema/type inference and inbound/outbound Attachment consumers.

Produces:

Image state/reason and metadata/descriptor DTOs in image-types.ts, the backward-compatible inbound union, and typed images configuration used by all later tasks. Define a thread-scoped ImageAccess port in image-types.ts with typed record/availability/Inspection-byte outcomes; its concrete adapter is implemented in TASK-010.

## Scope

- Use maxInputBytes=10485760, maxPerMessage=5, maxPerInspection=5, maxEdge=4096, jpegQuality=85, retentionHours=24; byte/count/edge values are positive integers, quality is integer 1–100, retention is positive.
- Keep Attachment as the existing payload; only InboundEvent.attachments gains metadata-only closed rejection outcomes. Array position represents source order. Do not add durable IDs or a state machine to outbound Attachment.
- Define Processing/Available/Rejected/Unavailable and the exact eight rejection/two unavailability reasons from the approved tables. Do not add connector-specific reasons.
- Establish the injected ImageAccess contract without importing a future runtime service or Finding repository. Resolve current-thread metadata/availability and normalized bytes through this port; consumers can use deterministic fakes until TASK-010 supplies the real implementation.
- Keep parser output unknown until validated. Descriptor DTOs carry selected metadata and ownership information, never bytes, local paths or credentials. Export shared constants rather than duplicating lists.

## Non-scope

No downloads, normalization, database tables, vision chain validation or persona enablement.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

None. This is the first implementation task.

## Conflict domains

- `src/images/image-types.ts`
- `src/channels/channel-types.ts`
- `src/core/config/*.ts`
- `tests/unit/core/config/config-schema*.test.ts`
- `tests/unit/images/image-types.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/core/config/config-schema-subagents.test.ts tests/unit/images/image-types.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing configuration tests plus the unchanged CLI and no-cost startup smoke; focused assertions must pin the values and closed lists above, not derive expectations from exported constants.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
