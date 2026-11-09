# TASK-021: Sharp native packaging and image tool instructions

## Objective

Ensure production containers can load Sharp and actually package the new tool instructions.

Wave (c); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Each released amd64/arm64 production build loads Sharp and normalizes a tiny JPEG; builder receives templates before build and packaged image.read.md is checked by an active regression test.

## Interfaces

Consumes:

TASK-003 pinned dependencies and TASK-017 instruction files; inventory E14, actual node:24-slim release platforms and npm build template-copy script.

Produces:

Native load/normalization production build gate and package instructions proof for released container targets.

## Scope

- The current Docker builder copies src but not templates before npm run build. Add the required templates copy; relying on the build script alone silently omits instructions. Keep actual instruction packaging in dist/templates/tool-instructions.
- After production npm ci --omit=dev, run a tiny JPEG normalization using installed Sharp within each target image. Include target optional native dependencies; never treat a host probe as arm64 proof.
- Keep linux/amd64 and linux/arm64 glibc release-tag builds executing the check. The design accepts detection after merge; do not add an unsolicited PR-time multiarch workflow or claim musl is supported without the equivalent native test.
- Existing Docker test groups are skipped. Add an active image-specific group (outside describe.skip) checking copy order/native command/release targets and built dist/templates/tool-instructions/image.read.md; do not re-enable unrelated legacy deployment checks.
- Report host static/package checks separately from actual release target execution. If containers are not built locally, say so; release command guarantees are code evidence, not executed arm64 evidence.

## Non-scope

No new container architectures, unrelated Docker hardening or changes to deployment credentials.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-003, TASK-017

## Conflict domains

- `deploy/Dockerfile`
- `.github/workflows/release.yaml`
- `tests/unit/deploy/dockerfile.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/deploy/dockerfile.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Current release target matrix and E14 pinned Sharp optional packages are independent packaging contracts; existing build/startup smoke proves host behavior only. The production native RUN gate proves each built target.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
