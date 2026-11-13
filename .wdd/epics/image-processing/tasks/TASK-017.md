# TASK-017: Lookup tool exposure and agent instructions

## Objective

Expose the lookup handler consistently through authenticated host-tool and MCP paths.

Wave (c); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

image.read / image.lookup / image_lookup naming is registered, filtered and dispatched; tool instructions explain vision input, stale descriptors and re-upload recovery.

## Interfaces

Consumes:

TASK-016 handler and existing tool registry/filter/approval/authentication conventions, inventory I11; TASK-013 Inspection input contract.

Produces:

Capability-gated MCP schema and bridge dispatch plus image.read/subagent.invoke instructions; TASK-019 supplies runtime services.

## Scope

- Register capability prefix image.read, internal name image.lookup and MCP name image_lookup using existing conventions. Preserve default-deny and requireApproval behavior; authenticated dispatch rechecks authorization.
- Define schema for the four operation-specific inputs and bounded pagination, with no untrusted thread/path/URL/provenance inputs. Export the handler and route bridge/MCP requests to it.
- Allow service injection with existing-caller compatibility until final wiring; missing service fails explicitly instead of fabricating empty success.
- Teach subagent_invoke(name=vision,input={imageIds,question}), saved Finding lookup without another Inspection, descriptors as stale snapshots/get_image as current state, and expired/unavailable Inspection errors requiring re-upload.
- Test denied/allowed/approval-required exposure and both request transports; no invocation bypass via internal tool name.

## Non-scope

No daemon bootstrap wiring, persona grant changes or fresh/resumed session context changes.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-016

## Conflict domains

- `src/tools/tool-filter.ts`
- `src/tools/host-tools-bridge.ts`
- `src/tools/host-tools-mcp-server.ts`
- `src/tools/host-tools/index.ts`
- `templates/tool-instructions/image.read.md`
- `templates/tool-instructions/subagent.invoke.md`
- `tests/unit/tools/tool-filter.test.ts`
- `tests/unit/tools/host-tools-bridge.test.ts`
- `tests/unit/tools/host-tools-mcp-server.test.ts`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/tools/tool-filter.test.ts tests/unit/tools/host-tools-bridge.test.ts tests/unit/tools/host-tools-mcp-server.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Existing tool-filter/authenticated bridge tests are independent capability oracles; unchanged startup smoke also runs. Assert schemas/dispatch against the approved operation table.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
