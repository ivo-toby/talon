# TASK-018: Live image descriptors and fresh-session context

## Objective

Deliver current Image IDs once with live content and rebuild bounded history only for fresh sessions/rotation.

Wave (c); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Foreground queries for every provider append current-message descriptors to live content; resumed text-only queries add no full inventory/Finding projection, while fresh/rotated contexts discover older Images.

## Interfaces

Consumes:

TASK-015 projection, TASK-017 registered/filtered lookup exposure, TASK-001 ImageAccess port and TASK-011 Finding records; inventory I10, actual trusted message/thread and current tool exposure; ADR-0002.

Produces:

Image-aware AgentRunner/ContextAssembler/ContextRoller inputs with preserved existing session and schedule behavior; TASK-019 supplies projection services.

## Scope

- Resolve current Images using trusted current message ID and thread and refresh availability. Preserve stored message and queue text; reconstruct descriptor associations on retries.
- Append current descriptors to live provider content for all foreground providers; history then contains that message's descriptors naturally. Do not append full inventory/Findings on resumed turns or change Codex stdin composition.
- Inject full inventory/Findings only when foreground history is injected into a fresh session and for rotation. Deduplicate live Image IDs and share live-first descriptor budgets; Finding budget remains separate and counts toward outer context limits.
- Query canonical Images/Findings independent of message cutoff, including late Findings after summarizer starts and Findings from failed runs. Rotated summaries may paraphrase while exact lookup remains available.
- Use the actual registry/filter entry delivered by TASK-017 for lookup hint exposure, rather than predicting availability from a hardcoded capability string; unpermitted personas get neutral omissions. Preserve scheduled-run context isolation. Explicitly accept existing provider/queue live retry semantics without claiming exactly-once provider history.
- Capture resumed Codex requests: first image turn has live IDs, later text-only stdin has no injected repeated inventories/Findings. Check fresh sessions and other provider strategies receive their expected descriptors.

## Non-scope

No provider-native multimodal payloads, lookup wiring or provider session-policy redesign.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-015, TASK-017

## Conflict domains

- `src/daemon/agent-runner.ts`
- `src/daemon/context-assembler.ts`
- `src/daemon/context-roller.ts`
- `tests/unit/daemon/agent-runner.test.ts`
- `tests/unit/daemon/context-assembler.test.ts`
- `tests/unit/daemon/context-roller.test.ts`
- `tests/unit/providers/codex-cli-provider.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-assembler.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/providers/codex-cli-provider.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing session/scheduled-run tests and unchanged startup smoke are independent behavior oracles; captured Codex stdin verifies the actual resumed-provider boundary, not just formatter output.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
