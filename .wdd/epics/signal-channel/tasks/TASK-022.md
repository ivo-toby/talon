# TASK-022: Fence authenticated SDK access in unit tests

## Objective

Make the default Vitest SDK module boundary fail closed: manual-mock bypass or an unmock must reach an inert refusal fixture, never the authenticated Claude SDK. Keep production provider behavior and original test assertions unchanged.

## Deliverable

Default test-runner resolution routes the exact Claude SDK name to a tiny denial fixture and rejects real SDK package loading/externalization through the governed loader. New safe regression tests demonstrate actual default resolver and public adapter behavior under synthetic mocks and denied fallback. README/AGENTS explain the testing boundary and its limits.

## Interfaces

Consumes:
- Existing `vitest.config.ts`, installed Vitest2.1.9/vite-node public resolver/loader behavior and exact source citations in `research/sdk-unit-test-isolation.md`.
- Actual `src/providers/claude-code-provider.ts` and `src/daemon/agent-runner.ts` SDK import surfaces, READ ONLY. No inferred/guessed SDK API or production interface change.
- Frozen parent-executed V5 inert SDK oracle source/config/guards/fixture/69-event trace/command/outcome under `research/sdk-test-isolation-oracle/`; no worker edits to that oracle.
- Approved Signal spec/design/inventory and task-specific standing autonomous-completion authority.

Produces:
- Default unit-test-only exact SDK resolve fence and fixed inert refusal exports appropriate to actual current imports.
- Safe new tests against the real default resolver/public SDK adapter; no real SDK negative execution or shadow adapter/repository/auth producer.
- Narrow testing documentation. This is not OS isolation or a production provider security policy.

## Scope

Only these five paths may change:
- `vitest.config.ts`
- `tests/fixtures/claude-agent-sdk-denied.ts`
- `tests/unit/providers/claude-code-sdk-isolation.test.ts`
- `README.md` (testing section only)
- `AGENTS.md` (testing boundary only; preserve all architecture/review/offload rules)

Read all actual source/import/test/config paths first. Preserve existing `@talon` resolution, test discovery, normal local fixture networking/IPC/CLI tests, coverage settings, package versions and runtime build behavior. Add an exact SDK alias plus rejecting real-package resolution/load/externalization behavior according to the installed loader contract; no broad module-name guessing. Fixture refusal functions are fixed, inert and dependency-free: never import SDK, inspect credentials/accounts, create tools or forward requests. Read actual SDK runtime imports to decide which exports require refusal; do not emulate SDK behavior.

Before any implementation, save actual route/base/index/byte baseline, full read-based plan and safe negative-RED design; request controller PLAN_APPROVED. No SDK-dependent execution before the default fence is statically and independently established. Negative RED must inspect actual public resolver/configuration metadata WITHOUT evaluating/calling real SDK. An in-process public resolver in non-listening/middleware mode may be used with actual awaited close; no daemon/service/listener. Compiler/collection/import/fixture errors are NOT product RED. A green special override is not a default-config safety proof.

Add only the new owned regression file/fixture. All existing tests/helpers/assertions/mock factories/generators remain byte-exact. Once the default fence is proved, existing synthetic SDK mocks must still work; fallback/unmock must throw the fixed denial without real module load. Test actual governed resolution for bare SDK and real package path attempts as appropriate; do not assert merely that a source-shaped config field exists. Programmatic assertions must use the actual installed public API, not private Vitest internals or fabricated import helpers. Keep explicit lifetime/cleanup proof for any actual test-runner resources. No generic child/network deny policy across the suite; the V5 diagnostic guards illustrate defense-in-depth but must not break normal local socket/CLI fixtures.

No production code/API, provider routing, capability framework, SDK/dependency installation/update, package/lockfile, timeout/pool/serial/coverage, test skips or existing-body weakening. Task010's partial code is held separately and unowned; preserve its all873 bytes/modes/index/proof before/after. Do not attribute original historical cancellation failures or V4 SDK binding from this task; those facts remain unknown. No original failed criteria/reports are reinterpreted.

## Non-scope

No real SDK/query/account/auth/key access, real Signal, signal-cli installation/provisioning, SDK model requests, service/container management, background CLI invocation, inherited work cleanup, root branch/main merge, publishing, npm installs, full npmtest or changes to any original task/spec/design/config settings. No edits in node_modules or production provider/Runner source. Missing contract or extra ownership goes to controller before any guess. Worker never runs WDD/Git mutations or smoke/services; parent owns lifecycle acceptance and serialized fake-terminal smoke.

## Files to read first

- Actual worktree AGENTS and actual ivo-code-style/debugging/TDD/WDD worker guidance.
- All immutable dispatch spec/design/inventory/research/oracle inputs.
- Actual default Vitest config, package/lock metadata, installed Vitest/vite-node loader citations, provider SDK strategy and Runner SDK imports, entire existing SDK provider/Runner test files, README testing and AGENTS testing conventions.
- Frozen original test/helper/body hashes and held010 identity supplied by controller. Public APIs only; installed internals are contract evidence, not an API to patch.

## Conflict domains

- vitest.config.ts
- tests/fixtures/claude-agent-sdk-denied.ts
- tests/unit/providers/claude-code-sdk-isolation.test.ts
- README.md
- AGENTS.md

## Verification

Mandatory order: scoped lint; clean strict check covering all source plus owned config/fixture/new test (controller supplies the exact project); owned safe resolver RED/GREEN; existing focused tests after fence verification; build/help; byte/scope/cleanup guards. Run no SDK suite before the fence is proved.

```sh
npx vitest run tests/unit/providers/claude-code-sdk-isolation.test.ts tests/unit/providers/claude-code-provider.test.ts tests/unit/daemon/agent-runner.test.ts
```

Then run the EXACT accepted33-file producer/CLI test manifest supplied by the controller under the DEFAULT configuration, plus the new regression as recorded; preserve all command arguments/counts/raw exits. These original assertions are an independent oracle the implementing worker did not author. The frozen V5 two-arm/public adapter/inert binding/awaited-cleanup oracle is another independent reference, NOT real SDK execution authority.

```sh
npm run build
```

```sh
node dist/cli/index.js --help
```

Parent additionally executes the already-ratified serialized no-cost fake terminal round-trip/status/exactreply/cleanup oracle. No real Signal, authenticated provider or AC-15 proof follows from it.

## Definition of done

- All owned behavior/tests/docs match the bounded deliverable, safe meaningful RED/GREEN is recorded, inherited test/setting/production bytes unchanged, no real SDK module executed by validation.
- Complete versioned report/proof/full current identity/raw evidence/ALL numbered Decisions and explicit source/SDK/lifetime/privacy/proof limits saved before requesting parent CURRENT_SOURCE_GATE_PASS. Hold code stable/alive; no successful final before actual hash-bound parent reply after independent checks/capture. Timeout/health/progress/nativeok is not acknowledgment. A failed/unknown gate is BLOCKED, not success.
- Scope/model/routing/original-task/history/held010 guards are verified. No original failed B criterion is certified retroactively; historical actual SDK/network occurrence remains unknown.
- Stop before commit with complete READY_FOR_REVIEW or truthful NEEDS_CONTEXT. Fresh independent GPT-6.1-sol xhigh whole-task review mandatory; all P1/P2 addressed. A separate NEW exact-content Git-only contract authorizes one normal local commit only after clean review; no stage/commit in this implementation phase.
- Fresh exact-commit review, actual objects/bytes/repeated parent gates/WDD CURRENT/local integration remain separate controller duties. No push/PR/main merge or live feature completion claim.
