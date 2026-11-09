# TASK-005: Atomic image Admission and queue completion

## Objective

Make image-bearing messages durable before processing and enqueue their final outcomes exactly once at the database boundary.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Pipeline callbacks await image processing, atomic admission rollback cannot strand an owning message, and enqueue/completion commits together with no rollback success log.

## Interfaces

Consumes:

TASK-002 repositories, TASK-003 store/normalizer and TASK-001 inbound outcomes; inventory I2–I5 and the ordered recovery table.

Produces:

An injected Ingestion coordinator used by MessagePipeline, recoverPending entrypoint for TASK-010, and a transactional enqueue API with post-commit success logging.

## Scope

- Retain the old text-only path. For image messages, resolve authoritative channel-scoped idempotency identity and persist message/route/Image/Ingestion in one synchronous transaction; insert message before Image rows.
- Translate internal repository Err to rollback by throwing only within the transaction adapter, catch at the public boundary and return Result. Never await in a SQLite transaction.
- Join one active owner per message on duplicate delivery. Reuse committed IDs/deadlines/outcomes, adopt usable redelivered source only for Processing work, and clean newly downloaded duplicate staging.
- Increment attempts before conversion; cap at three per Image and 60 seconds total from admission. Implement recovery precedence expiry → exhausted deadline/attempts → retained source → interrupted. Resolved states are never normalized again.
- Fence temporary-file publication by Processing state, attempt ownership, message deadline and Image expiry in a guarded synchronous rename/DB transaction. Reconcile rename/commit crash remnants; discard late work.
- After all outcomes resolve, refresh availability and conditionally enqueue plus mark complete on the same DB connection. Completed/unrouted duplicate delivery never queues, including after queue purge.
- Update channel-setup to await the Promise<Result> and all existing direct pipeline tests/callers named in domains. Database write failure returns a typed error and leaves recoverable committed state.
- Defer queue success logging until the outer transaction commits; keep ordinary autocommit behavior. Do not add a thread-wide admission barrier.

## Non-scope

No periodic daemon sweep or feature DI wiring; TASK-010 consumes the coordinator. No text-only crash-gap repair or cross-handoff ordering promise.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-002, TASK-003

## Conflict domains

- `src/pipeline/*.ts`
- `src/images/image-ingestion.ts`
- `src/queue/queue-manager.ts`
- `src/channels/channel-setup.ts`
- `tests/unit/pipeline/**`
- `tests/unit/images/image-ingestion.test.ts`
- `tests/unit/queue/queue-manager.test.ts`
- `tests/unit/channels/channel-setup.test.ts`
- `tests/integration/subagent-pipeline.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/pipeline/message-pipeline.test.ts tests/unit/pipeline/message-normalizer.test.ts tests/unit/images/image-ingestion.test.ts tests/unit/queue/queue-manager.test.ts tests/unit/channels/channel-setup.test.ts tests/integration/subagent-pipeline.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing queue/pipeline tests and unchanged startup smoke; crash/concurrency tests assert explicit SQLite row/queue counts at transaction boundaries rather than a mocked enqueue.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
