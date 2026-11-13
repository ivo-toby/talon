# TASK-002: Durable Images and pending Ingestion repositories

## Objective

Store Images and their image-only admission/completion ledger with stable ownership and recoverable processing budgets.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

A forward migration and Result-returning Image/Ingestion repositories support authoritative message ownership, ordered Images, pending recovery and terminal completion.

## Interfaces

Consumes:

TASK-001 DTOs; inventory I2/I3/I4; existing messages, threads, queue_items and database migration/repository conventions.

Produces:

Images unique by globally unique ID and (message_id, ordinal), thread-owned recovery records, persisted receipt/expiry/deadline/attempt/source references, and repository exports for the coordinator.

## Scope

- Inspect the current migration directory and use the next free number greater than every existing numeric prefix; do not edit already-applied SQL migrations. The two existing 007 files are historical duplication, not a naming precedent. Do not renumber or reuse either; the Finding migration must receive its own later free number in TASK-011. Add ownership foreign keys, uniqueness and thread/time lookup indexes. Sources are internal recovery data, excluded from public DTOs.
- Persist one terminal admission record for intentionally unrouted image-bearing messages; only routed image messages receive Images/pending Ingestion. Text-only messages have no new ledger.
- Provide queries for pending Ingestion and terminal Images independent of message cutoffs. Enforce stable IDs and original deadlines on repeated admission.
- Repository expected errors return Result. Exercise real SQLite transactions and constraints rather than mocked inserts. Completion survives queue-item deletion; it must not be inferred from queue existence.

## Non-scope

No async normalization, pipeline handoff, queue wiring or Finding tables.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-001

## Conflict domains

- `src/core/database/migrations/*`
- `src/core/database/repositories/*`
- `tests/unit/core/database/repositories/image*.test.ts`
- `tests/unit/core/database/migrations/runner.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/core/database/repositories/image-repository.test.ts tests/unit/core/database/repositories/image-ingestion-repository.test.ts tests/unit/core/database/migrations/runner.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing migration runner tests and unchanged startup smoke; SQL uniqueness/foreign-key checks use independent explicit duplicate/cross-owner fixtures.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
