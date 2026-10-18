# TASK-020: Image feature documentation in both agent trees

## Objective

Bring operator/persona guidance and both skill copies in line with the implemented image workflow.

Wave (c); mechanical formatting/documentation. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

README/config/architecture/persona guidance and both setup/channel skill trees describe the same supported behavior and explicit image.read:thread plus vision enablement.

## Interfaces

Consumes:

Approved spec/design/glossary/ADRs, implemented configuration/tool/subagent contracts, TASK-021 packaging behavior and existing agent-specific documentation.

Produces:

Current operator-facing instructions without contradictory retention, ordering, permissions or capability claims.

## Scope

- Update affected setup, profile, Telegram, WhatsApp and email skills in .agents and .claude; compare new image guidance in both while retaining unrelated agent-specific differences. Do not copy whole files blindly.
- Add vision assignment/subagent.invoke and image.read:thread together in persona examples/template; explain existing personas need explicit enablement. Document exact Inspection input and independent model-free lookup.
- Document defaults/closed errors, JPEG normalization, supported/excluded items, actual byte/count rules and lower practical email limit from whole-message base64 overhead.
- State file-only configurable retention: GPS/EXIF/Findings/OCR personal data persist until separately deleted; metadata can appear in authorized group replies; documents/email are best effort for EXIF photos may strip.
- Describe expiry-before-first-run/re-upload, at-most-three processing attempts/deadline and sequential connector delays up to roughly120 seconds; do not promise cross-handoff arrival ordering.
- Describe text-only main routing and fresh/rotation-only inventories versus live descriptors/resumed lookup, fixed display budgets and stale descriptor snapshots.
- Update Image/Finding/module/architecture sections in AGENTS and CLAUDE without changing repository workflow/model policy; keep ADR routing/context decisions intact.

## Non-scope

No runtime source changes, new capabilities for existing configured personas, timed metadata deletion or ADR rewrite.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-019, TASK-021

## Conflict domains

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `config/talond.example.yaml`
- `templates/assistant/system.md`
- `.agents/skills/*/SKILL.md`
- `.claude/skills/*/SKILL.md`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/deploy/dockerfile.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing config example schema tests plus unchanged build/CLI/daemon smoke; reviewer compares both trees directly against approved AC-17 and actual config/tool contracts. Pure prose has no meaningful red/green cycle.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
