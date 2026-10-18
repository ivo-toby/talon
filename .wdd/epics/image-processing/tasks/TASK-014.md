# TASK-014: Inspection daemon integration

## Objective

Make the built-in vision and canonical Finding service reachable through the real daemon, without granting capabilities implicitly.

Wave (b); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Bootstrap supplies Image/Finding services and validates the final loaded vision chain before channels start; a text-only foreground persona can request a deterministic Inspection.

## Interfaces

Consumes:

TASK-010 running ingestion and concrete ImageAccess adapter, TASK-011/012/013 Finding/validation/vision producers and existing built-in/custom loader merge behavior; inventory I7/I9 and approved persona/subagent capability gates.

Produces:

Working wave (b), with fail-closed boot validation and successful exact Finding persistence through real subagent_invoke.

## Scope

- Wire the two services into the existing SubAgentServices bundle and call complete-chain validation after built-in/cwd/data-dir overrides are merged, before channel work.
- Ensure normal built-in loading finds vision; invalid text-only custom vision fallbacks must fail startup rather than be silently ignored or cause text-only success.
- Retain existing persona assignment/subagent.invoke checks and explicit missing-setup/denied errors. Do not add image.read capability automatically.
- Use real pipeline/queue/repositories and a deterministic vision adapter in integration evidence; assert text-only foreground receives only textual Finding and saved record survives a subsequent failed foreground run.
- Update loader/bootstrap fixtures only where required; scheduled-run context behavior and other subagents stay compatible.

## Non-scope

No replay inventories, image_lookup exposure or persona documentation changes.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-010, TASK-011, TASK-012, TASK-013

## Conflict domains

- `src/daemon/daemon-bootstrap.ts`
- `src/daemon/daemon-types.ts`
- `src/subagents/subagent-loader.ts`
- `tests/unit/daemon/daemon-bootstrap.test.ts`
- `tests/unit/subagents/subagent-loader.test.ts`
- `tests/integration/vision-inspection-runtime.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/subagents/subagent-loader.test.ts tests/integration/vision-inspection-runtime.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Unchanged CLI/no-cost daemon smoke is the independent runtime oracle; boot-failure fixtures assert actual merged chain rather than testing only a standalone predicate.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
