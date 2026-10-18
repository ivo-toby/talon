# TASK-013: One-shot vision Inspection implementation

## Objective

Answer image questions with one-shot multimodal requests and a persisted textual Finding.

Wave (b); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

A built-in vision manifest/prompt/run function receives all normalized JPEG parts, validates output, saves exactly one successful Finding, and returns its ID and text/usage.

## Interfaces

Consumes:

TASK-012 trusted run context/validated chain, TASK-001 ImageAccess contract, TASK-003 normalized file/byte conventions and TASK-011 Finding persistence port; inventory E12/E13 and I7/I8.

Produces:

subagent_invoke(name=vision,input={imageIds,question}) result {findingId,imageIds,answer,extractedText,uncertainty,model,usage}; failures create no Finding.

## Scope

- Add typed ImageAccess/Finding persistence fields to SubAgentServices and exports using TASK-001/TASK-011 ports. Keep other subagents compatible; vision rejects missing services or trusted provenance. Use injected port fakes in focused tests; import no TASK-010 concrete adapter. TASK-014 supplies the real ports after ingestion integration.
- Require nonempty question and 1..maxPerInspection distinct current-thread Image IDs. Reject duplicates/excess/unknown/cross-thread/Processing/Rejected/Unavailable and paths/URLs before any request; never truncate.
- For each attempt re-resolve all files and refresh availability. Build an independent SDK request containing the question and every Buffer ImagePart with mediaType image/jpeg; never send image URLs or remove pixels on failover.
- Use a documented vision-capable inference model in the built-in manifest; record the primary source supporting that default choice. Missing credentials remain explicit invocation errors. No model-name capability registry.
- Forward existing abort/timeout/provider options; an attempt loaded before expiry may complete within timeout, but no new attempt starts after expiry. Disable SDK input recording with experimental_telemetry recordInputs:false.
- Validate textual answer/extractedText/uncertainty DTO; after generation recheck abort before saving. Timed-out/late attempts and failed writes cannot return an unrecorded success. Use trusted winning model/run/usage, not model-authored provenance.
- Keep runner observations/logs text-only IDs/question/Finding. No pixels/base64/credentials enter main prompts, queue/messages or application logs.

## Non-scope

No direct foreground multimodal support, native subscription adapter changes or lookup/replay.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-003, TASK-011, TASK-012

## Conflict domains

- `src/subagents/default/vision/**`
- `tests/unit/subagents/vision.test.ts`
- `src/subagents/subagent-types.ts`
- `src/subagents/index.ts`
- `tests/unit/subagents/subagent-runner.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/subagents/vision.test.ts tests/unit/subagents/subagent-runner.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: E12/E13 pinned SDK contracts fix ImagePart and telemetry expectations; deterministic adapters assert explicit received JPEG bytes and independent request contents. Existing daemon smoke also runs.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
