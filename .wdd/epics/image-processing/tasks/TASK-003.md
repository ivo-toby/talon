# TASK-003: Owned image files and JPEG normalization

## Objective

Produce bounded, oriented, metadata-free JPEG outputs and selected typed EXIF from owned sources.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Sharp 0.34.5/exifr 7.1.3 are pinned; source/attempt file ownership and normalization APIs return typed outcomes. Real static and animated fixtures prove the approved conversion behavior.

## Interfaces

Consumes:

TASK-001 settings/metadata/reasons; inventory E6–E11/E14 and I6; executed normalization probe/result and pinned source manifest.

Produces:

ImageStore staging/temp/final path operations and byte loading, ImageNormalizer results with dimensions/selected EXIF, and cleanup helpers used by transport and Ingestion.

## Scope

- Use dataDir/image-staging/{deliveryUuid}/ for pre-admission sources and dataDir/threads/{threadId}/attachments/images/{imageId}.jpg for final files; user filenames are metadata, never path segments.
- Extract EXIF before conversion. Remove the Exif-zero-zero prefix when present, parse TIFF with translateValues:false/reviveValues:false, validate unknown output, retain raw capture time/offset, and interpret altitude reference. Never invent a timezone or location.
- Apply auto-orientation including mirroring, fit-inside/no enlargement/no crop, white flatten, requested JPEG quality and stripped metadata. Keep native decoder/input limits.
- Confirm decoded content belongs to the supported JPEG/PNG/WebP formats using the decoder metadata; do not add a separate signature/extension scanner.
- Explicitly inspect bounds-checked PNG chunks for acTL even for one frame; reject animated WebP using actual frame/animation information. Convertible first frames are not a static-image test.
- Write attempt-owned temporary output. Expose synchronous rename/delete helpers; TASK-005 owns the transaction guard that authorizes publishing. Native timeout supplements the outer persisted deadline; late output is cleanup-owned.
- Distinguish immediate malformed/decoder failure from operational retryable errors. Do not log source bytes or EXIF parser raw buffers.

## Non-scope

No records, receipt/deadline policy, queue coordination or autonomous sweep.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-001

## Conflict domains

- `package.json`
- `package-lock.json`
- `src/images/image-store.ts`
- `src/images/image-normalizer.ts`
- `src/images/image-metadata.ts`
- `src/memory/thread-workspace.ts`
- `tests/unit/images/image-store.test.ts`
- `tests/unit/images/image-normalizer.test.ts`
- `tests/unit/images/image-metadata.test.ts`
- `tests/fixtures/images/**`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/images/image-store.test.ts tests/unit/images/image-normalizer.test.ts tests/unit/images/image-metadata.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Research normalization-probe.mjs/result are pre-existing independent library evidence; new tests must reproduce its explicit oriented 8×16/no-EXIF and single-frame APNG expectations against Talon code. CLI/startup gates remain unchanged.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
