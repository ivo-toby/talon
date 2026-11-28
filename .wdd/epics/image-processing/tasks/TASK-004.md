# TASK-004: Shared image selection and bounded media staging

## Objective

Give connectors one selection and download/staging contract that preserves source-order slots and limits actual bytes.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Connectors can submit payloads or closed metadata-only rejections with one shared 60-second fetch deadline per message and owned staging cleanup.

## Interfaces

Consumes:

TASK-001 inbound contract/settings/reasons and TASK-003 ImageStore; selection/rejection tables, inventory I1 and channel-specific E1–E5 consumed by later mappers.

Produces:

Selection results, message fetch budget, bounded Buffer/stream consumption and staging operations for the four scoped connectors.

## Scope

- Silently exclude non-image/absent-MIME documents, inline/related email content, stickers and duplicate photo representations before slots. Match MIME case-insensitively without parameters.
- Consume slots in source order. Overflow yields count_limit without download; an earlier failure still consumes its slot and never backfills another candidate. Apply supported-MIME and declared/actual-size checks only after slot assignment.
- Accept inbound legacy Buffer/path payloads as well as the new outcomes. Reject oversized email buffers before writing them. Cap stream bytes during consumption, not after concatenating an unbounded stream.
- Use one fixed 60-second deadline across media lookups, retries and alternate downloads in that message. Abort/destroy sources at overflow/deadline; clean late results and partial staging.
- Transport errors map only to the closed reasons; preserve sanitized filenames/MIME/source order without retaining credentials or download URLs in durable outputs. No Sharp invocation here.

## Non-scope

No platform-specific mapper, sender policy, database writes or processing retry budget.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-001, TASK-003

## Conflict domains

- `src/images/image-selection.ts`
- `src/images/image-transport.ts`
- `tests/unit/images/image-selection.test.ts`
- `tests/unit/images/image-transport.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/images/image-selection.test.ts tests/unit/images/image-transport.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Approved selection and reason tables are the conformance oracle; explicitly assert no download for excluded/overflow items and actual byte counting. Unchanged startup smoke is independent of the worker.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
