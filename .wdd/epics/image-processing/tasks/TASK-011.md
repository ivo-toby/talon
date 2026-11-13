# TASK-011: Canonical Finding persistence

## Objective

Persist exact Findings and Image associations independently of foreground success and replay.

Wave (b); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Dedicated Finding/finding_images storage records exact successful answers, trusted ownership/provenance/model/usage, and exposes thread-scoped exact/paginated retrieval.

## Interfaces

Consumes:

TASK-002 Image rows/ownership and migration/repository conventions, TASK-001 Image DTOs, existing runs table, inventory I3/I8/I9 and spec part (b)/(c). No running ingestion service is required.

Produces:

Finding DTO, typed Finding persistence port/repository, and forward migration used by vision and model-free lookup. This port is independent of the eventual daemon service wiring.

## Scope

- After TASK-002 merges, inspect all current migration filenames and choose the next free number greater than every existing prefix. The two historical 007 files must not be copied, reused or renumbered. The Finding migration has a distinct version later than the Image migration. Define globally unique Finding IDs and source associations; retain question, answer, extractedText, uncertainty, created time, winning model and actual reported usage.
- Require trusted run/thread provenance and same-thread source Image ownership at write boundary. Persist a successful Finding and its associations atomically before returning it.
- Return typed persistence errors. Findings survive failed main runs, image expiry and context rotation; never create synthetic messages or use tool_results as canonical replay storage.
- Support exact get by Finding ID and paginated chronological-key queries, including Image-filtered queries, independent of message cutoffs. No file access is needed for saved text.

## Non-scope

No model generation, pixels, summaries or host-tool permissions.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-002

## Conflict domains

- `src/images/finding-types.ts`
- `src/core/database/migrations/*`
- `src/core/database/repositories/*`
- `tests/unit/core/database/repositories/finding-repository.test.ts`
- `tests/unit/core/database/migrations/runner.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/core/database/repositories/finding-repository.test.ts tests/unit/core/database/migrations/runner.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing migration tests and unchanged startup smoke; direct SQLite rollback/ownership fixtures independently assert exact retained text and absence of partial associations.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
