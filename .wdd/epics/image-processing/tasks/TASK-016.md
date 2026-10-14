# TASK-016: Thread-scoped model-free image_lookup handler

## Objective

Implement exact saved-text retrieval and current Image discovery without model access.

Wave (c); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

The image.lookup handler implements four scoped operations with stable pagination/cursor checks and no pixels/paths/credentials.

## Interfaces

Consumes:

TASK-001 ImageAccess port, TASK-002 Image query/ownership contracts, TASK-011 Finding repository/port and TASK-015 descriptor rendering; inventory I11 and spec lookup request/result table.

Produces:

Handler returning {images,nextCursor}/{findings,nextCursor}/{image}/{finding}, registered by TASK-017 and injected by TASK-019.

## Scope

- Implement against typed injected ports/repositories with deterministic fixtures. Do not import TASK-010 runtime classes; final integration injects the actual availability adapter.
- Derive thread from trusted ToolExecutionContext and enforce image.read:thread through existing capability evaluation. No caller thread override and no vision assignment/invoke/model credentials are needed.
- Implement list_images, get_image, list_findings(optional imageId), get_finding with default limit20, integer range1–100, timestamp descending/ID ascending, opaque operation/filter/thread-bound cursor and null nextCursor at exhaustion.
- Refresh availability before Image output; unknown/cross-thread/Processing are indistinguishable not-found. Rejected/Unavailable allow text access. Lookup descriptors expose the complete public DTO rather than an automatically clipped context excerpt; get_finding returns exact canonical content; Image-filtered Finding queries verify owning thread.
- Do not load any image file merely for text lookup, call a model, trigger channel download or create a Finding. Exclude internal source/path/token fields from all responses.
- Reject malformed/mismatched cursor and invalid operation/fields; pin pagination around same-timestamp ties with actual SQLite records.

## Non-scope

No registry/MCP/bridge wiring, permission auto-grants or provider/context injection.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-015

## Conflict domains

- `src/tools/host-tools/image-lookup.ts`
- `tests/unit/tools/host-tools/image-lookup.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/tools/host-tools/image-lookup.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing capability conventions and explicit lookup table are independent oracles; denial/cross-thread fixtures assert zero model/file-download calls. Unchanged startup smoke also runs.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
