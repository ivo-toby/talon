# TASK-012: Vision model-chain validation and trusted run context

## Objective

Reject text-only vision chains and propagate trusted run identity without changing other subagents.

Wave (b); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Config rejects forbidden vision overrides; effective-chain validation checks the actual manifest fallback, and invocation context carries trusted provenance.

## Interfaces

Consumes:

TASK-001 image/config contracts; inventory I7/I8, current model resolver classifications and existing host-tool ToolExecutionContext. No Finding types/repository or concrete Image service is consumed.

Produces:

Exported resolver classification predicates, vision-specific complete-chain validation, and compatible runId context contracts for TASK-013/014. TASK-013 owns adding Image/Finding service fields once their contracts exist; TASK-014 injects concrete services.

## Scope

- Export inference/subscription/sandbox classifications from model-resolver and reuse them; do not maintain a second provider allowlist. Vision permits only anthropic/openai/google/ollama adapters.
- Validate every configured vision override at config load. Provide startup validation of the actually merged loaded vision manifest and complete buildSubAgentModelChain result, including implicit manifest fallback and custom override.
- Keep claude-code/codex-sandbox text-only and their containment unchanged. Other subagent chains retain current behavior; individual models rejecting image parts remain ordinary request failures.
- Pass runId from trusted host-tool context through subagent invocation/runner/context; do not accept run identity in model-authored input or guess an active run.
- Update provenance fixtures/callers and preserve optional runId for existing subagents. Do not add Image/Finding service fields here: TASK-013 adds those against the available ports after TASK-011, and requires them for vision.
- Preserve per-attempt abort/provider options and do not introduce a pixel-dropping fallback. Runtime bootstrap calls the validator in TASK-014 before work.

## Non-scope

No Image/Finding service imports or type widening, Finding persistence, vision implementation, pixel generation or real bootstrap injection in this task.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-001

## Conflict domains

- `src/subagents/model-resolver.ts`
- `src/subagents/subagent-model-chain.ts`
- `src/subagents/subagent-types.ts`
- `src/subagents/subagent-runner.ts`
- `src/subagents/index.ts`
- `src/tools/host-tools/subagent-invoke.ts`
- `src/core/config/*.ts`
- `tests/unit/subagents/model-resolver.test.ts`
- `tests/unit/subagents/subagent-model-chain.test.ts`
- `tests/unit/subagents/subagent-runner.test.ts`
- `tests/unit/core/config/config-schema-subagents.test.ts`
- `tests/unit/tools/subagent-invoke.test.ts`
- `tests/integration/subagent-pipeline.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/subagents/model-resolver.test.ts tests/unit/subagents/subagent-model-chain.test.ts tests/unit/subagents/subagent-runner.test.ts tests/unit/core/config/config-schema-subagents.test.ts tests/unit/tools/subagent-invoke.test.ts tests/integration/subagent-pipeline.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing resolver/subagent tests and unchanged startup smoke; explicit override + custom manifest fallback fixtures must fail against the actual complete chain.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
