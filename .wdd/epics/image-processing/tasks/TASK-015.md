# TASK-015: Bounded descriptor and Finding projections

## Objective

Format the already-defined Image/Finding data within fixed automatic context budgets.

Wave (c); mechanical formatting/documentation. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

A pure projection service produces source-order live descriptors, fresh inventories and chronological Finding excerpts with stable mandatory IDs/state/expiry and permission-aware omissions.

## Interfaces

Consumes:

TASK-002 Image row/public DTO types, TASK-011 Finding types and TASK-001 descriptor contract; spec projection table and inventory I10. Data is supplied by scoped callers; this formatter does not import the TASK-010 runtime service, query a repository, refresh availability or fetch pixels. Runtime callers supply refreshed data.

Produces:

Formatting/projection API consumed by foreground context and rotation, plus complete structured descriptor DTO rendering for lookup; automatic display budgets do not truncate lookup DTO fields. Budgets include JavaScript string.length framing/notices.

## Scope

- Use at most 20 descriptors, 1000 characters each and 8000 aggregate; at most 10 Finding projections, 2000 each and 8000 aggregate. Count framing/notices in every bound.
- For selection order, sort timestamp descending then ID ascending. Present selected Findings chronologically. Keep live descriptors in source order, exclude their IDs from inventory and share one live-first descriptor count/character budget.
- Include complete entries fitting the budget. Clip optional display text rather than Image IDs/state/expiry; preserve Finding IDs and mark excerpts or omitted source references. Exact canonical records are never changed.
- Treat all projected material as historical data. Unknown metadata stays unknown. Include omission notice; name image_lookup only when supplied actual tool-exposure flag is true.
- Implement table-driven boundary tests using literal limits: equal timestamps, long filenames/EXIF/text, Unicode JavaScript length, many live Images, old uninspected Images and excerpted Findings.

## Non-scope

No DB writes, authorization decisions, provider wiring, lookup cursors or summaries.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-002, TASK-011

## Conflict domains

- `src/images/image-context-projection.ts`
- `tests/unit/images/image-context-projection.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/images/image-context-projection.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Approved literal projection table is independent of formatter constants. Existing startup smoke remains unchanged. Assert explicit string lengths including framing and notices.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
