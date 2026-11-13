# TASK-019: Replay and lookup runtime integration and epic proof

## Objective

Wire the context/lookup producers into the daemon and prove the agreed image workflow end to end.

Wave (c); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

The approved deliverable command passes through real bootstrap/pipeline/SQLite/Sharp and deterministic providers, covering Inspection, rotation, lookup and expiry.

## Interfaces

Consumes:

TASK-014 working Inspection integration, TASK-017 lookup exposure and TASK-018 live/fresh/rotation context, all prior wave producers, inventory I9–I11 and the approved epic deliverable.

Produces:

Final ImageContextProjection/ImageLookup service injection and tests/integration/e2e/image-processing.test.ts usable as the recorded final-verification command.

## Scope

- Supply real Image/Finding/projection/lookup services to host-tools, AgentRunner, ContextAssembler and ContextRoller from shared bootstrap. Do not leave optional constructor paths unwired in the real daemon.
- Use mocked authorized channel uploads with real normalization/queue/repositories and deterministic vision generation. Text-only foreground calls the assigned gated vision and gets a persisted Finding; assert all pixels remain out of its payload/logs.
- Rotate/restart context and discover an uninspected Image; retrieve an exact Finding via scoped lookup; use controlled time to delete file while preserving text and deny new Inspection with uniform re-upload recovery.
- Prove denial/cross-thread scoping, retained Finding after failed main run, queue backlog expiry, and resumed Codex image turn followed by text-only turn without full projection reinjection.
- Run focused predecessor context/bootstrap tests when integration changes require them; preserve schedules and existing personas. No real channel/model access or OCR accuracy claim.

## Non-scope

No broad unrelated bootstrap refactor, live-model OCR evaluation or full-suite test run.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-014, TASK-017, TASK-018

## Conflict domains

- `src/daemon/daemon-bootstrap.ts`
- `src/daemon/daemon-types.ts`
- `tests/unit/daemon/daemon-bootstrap.test.ts`
- `tests/integration/e2e/image-processing.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/integration/e2e/image-processing.test.ts tests/unit/daemon/daemon-bootstrap.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: The pre-approved epic deliverable and unchanged daemon/terminal smoke are independent runtime obligations; use real infrastructure underneath mocks and explicit wire/file/row assertions.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
