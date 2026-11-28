# TASK-010: Ingestion runtime integration and retention recovery

## Objective

Wire all ingestion producers into the daemon and recover/expire owned image work across restart and shutdown.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

The real daemon injects image transport/pipeline services into scoped connectors, starts pending recovery before channel admission, and stops/drains image work before DB close.

## Interfaces

Consumes:

TASK-002/003/004/005 services and all four connector implementations; inventory I5/I6 and the recovery/retention tables.

Produces:

Running wave (a), a thread-scoped Image access/availability service for Inspection/lookup/projection, and startup/60-second recovery/retention lifecycle.

## Scope

- Construct shared settings, repositories, store, transport, normalizer, coordinator and lifecycle from real bootstrap dependencies. Supply transport to all scoped connectors through channel-factory; do not leave a producer unreachable.
- Recover pending admission at startup and at most every 60 seconds without competing with the active per-message owner. Reuse coordinator budgets/terminal handling; expiry counts from original durable Admission, including queue backlog.
- Implement the TASK-001 ImageAccess port with real Image repositories/store and inject it for later consumers. Expose thread-scoped file/record access that refreshes availability before consumers. Expiry establishes expired before file_missing; once recorded, preserve reason. Processing is inaccessible externally.
- Delete expired and orphaned owned sources/temp/final outputs at startup/sweep. Retry deletion failures with sanitized audit evidence; do not restore availability or delete retained Image/EXIF/conversation records.
- Drain/fence owned work and stop sweep before database closure. Test crash/restart without redelivery, missing source, active-owner exclusion, deadline exhaustion, late conversion, duplicate staging and deletion retry.
- Audit image mutations and cleanup using IDs/reasons, never pixels/download credentials. Existing text-only and scheduled behavior remains intact.

## Non-scope

No vision/Finding services, context projection or lookup tools; no text-only crash-gap repair.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-005, TASK-006, TASK-007, TASK-008, TASK-009

## Conflict domains

- `src/images/image-lifecycle.ts`
- `src/images/image-service.ts`
- `src/channels/channel-setup.ts`
- `src/channels/index.ts`
- `src/daemon/channel-factory.ts`
- `src/daemon/daemon*.ts`
- `tests/unit/images/image-lifecycle.test.ts`
- `tests/unit/images/image-service.test.ts`
- `tests/unit/daemon/daemon-bootstrap.test.ts`
- `tests/unit/daemon/channel-factory.test.ts`
- `tests/unit/daemon/daemon.test.ts`
- `tests/unit/channels/channel-setup.test.ts`
- `tests/integration/image-ingestion-runtime.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/images/image-lifecycle.test.ts tests/unit/images/image-service.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/daemon/channel-factory.test.ts tests/unit/daemon/daemon.test.ts tests/unit/channels/channel-setup.test.ts tests/integration/image-ingestion-runtime.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Unmodified no-cost daemon/terminal smoke exercises the real bootstrap and lifecycle. Focused tests use real SQLite plus controlled clocks and the approved recovery table, not a replacement daemon.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
