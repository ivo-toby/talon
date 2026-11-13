# SDK unit-test isolation prerequisite

## Purpose and delegated authority

Ivo explicitly instructed: “From now on; FINISH THIS WDD WORKFLOW WITHOUT ASKING ME, use your own judgetment”. Task-specific standing delegation is recorded by memory3d350eb3 and `.wdd/dispatch/pi-validation/TASK-021-autonomous-completion-authorization-memory.txt`. The controller exercises that delegation for this bounded corrective prerequisite, not for new product behavior, credential access, publication, waived reviews or invented live acceptance. Ivo did NOT separately review this specific new brief; approval provenance must say delegated autonomous completion, not pretend a fresh conversation happened.

TASK-010's current Runner corrections remain held at source87faf307/testbefdc041/full25784524e8; native run27fc2e3f/workflow1f5559f8 truthfully FAILED requiredcriterion2, original historical two cancellation failures remain unrecorded/unknown. No SourceGate/A seal/consumer successor or whole review was accepted. Preserve failed receipts; do not resume old criteria to make a different phase pass.

## Confirmed source contract and observed evidence

Installed Vitest2.1.9/vite-node sources, independently read by controller and worker:

- `node_modules/vite-node/dist/client.mjs:262–271`: one mutable callstack captured in the loaded module's dependency request closure;365–366 uses that request for static and dynamic imports.
- `node_modules/vitest/dist/chunks/execute.2pr0rHgK.js:492–519`: manual mock guarded by absence of a callstack marker, then pushes and awaits async `callFunctionMock`;373–377 remains async even on a cached return. A concurrent request can observe the marker and skip the manual mock.
- Same file791–799: an undefined mocked result falls through to the actual dependency loader.
- Actual `src/providers/claude-code-provider.ts` public SDK strategy dynamically imports local `query`. Its configured background CLI command is NOT a foreground SDK execution boundary.
- Both diagnostic and provider `createRequire.resolve` paths resolve the same installed physical SDK. Duplicate package resolution is not the observed explanation.

This establishes a CONDITIONAL mock-bypass mechanism. It does NOT establish that the failed V4 diagnostic or historic default failures actually used the real SDK/CLI/account/network. V4 recorded insufficient local-binding/process evidence; do not claim either occurrence or historical absence. No auth/account/key data was inspected. A later SDK-script process scan matched none at that later time, which is not retrospective proof.

The V5 diagnostic used an exact inert SDK resolve alias/fence and worker-local deny-original child/network guards, not a manual SDK mock. Its actual69-event trace binds the provider importer to the inert module, records four actual synthetic query entries, and no denied/refused operation. Actual public SDK adapter consumers of ONE native AsyncGenerator split one123/45/session result and one done-without-result; the SAME factory fresh-per-call yields two results. Both actual canonical/native return obligations settled before moving arms. This proves only a constructed iterable-ownership class, not an observed persisted zero-usage Runner row or original historical cause. Do not manufacture a causal diagnosis from it.

## Bounded design and alternatives

Existing flow: default `vitest.config.ts` resolves unit-test modules; SDK-dependent tests provide synthetic `query`/MCP helpers through manual mocks. We need a fail-closed fallback behind those mocks so the loader's fall-through cannot initialize the authenticated SDK.

Chosen: exact default test-runner SDK alias to a tiny inert denial fixture, plus rejecting resolve/load/externalization handling for real SDK package paths, following the installed loader's actual inline/externalization ordering. Existing mocks remain unchanged and normally win; a bypass or unmock reaches a fixed denial instead of a real SDK. Prove actual default resolver outcomes and actual public adapter behavior under mocks/fallback, without ever executing an unfenced real SDK as a negative control.

Rejected: relying only on test-file `query===mock` (not both adapter bindings); keeping the fence only in a diagnostic override (leaves required default gates unsafe); changing production provider interfaces or runtime behavior (unowned/unnecessary); updating/installing dependencies (not authorized); globally denying all child processes/network for every unit test (would break legitimate local IPC/socket/CLI fixtures and exceeds this task).

The boundary is Vitest's governed module resolution, NOT OS isolation or a general guarantee against arbitrary direct `require`, executable launches or unrelated test networking. Runtime provider SDK/CLI behavior stays unchanged. No package, lockfile, SDK source or installed module edits.

## Scope and validation

Five owned paths only: `vitest.config.ts`, `tests/fixtures/claude-agent-sdk-denied.ts`, `tests/unit/providers/claude-code-sdk-isolation.test.ts`, `README.md`, `AGENTS.md`. Preserve every original test/helper/mock/assertion body and all unrelated documentation/review/offload instructions. Read actual SDK import surfaces before deciding the fixture's exported refusal functions; do not clone the SDK.

Safe RED must use actual public loader resolution/configuration metadata and fail before loading/calling the real SDK. For example, public Vite resolver metadata from the unchanged default configuration can demonstrate that an SDK request resolves to the real package rather than the required inert module, without module evaluation; use an in-process non-listening/middleware-mode server and always close its actual resources. Do not make a live SDK call to prove that the fence is initially missing. A collection/compiler/fixture error is not product RED.

After the fence is independently checked, run existing SDK provider/Runner tests and the accepted33-file Signal set unchanged, plus new safety regression. No full npmtest, no production accounts, no package installs, no test-timeout/pool changes or old-body weakening. The fixed existing build/help/fake-terminal oracle remains required, with parent-only serialized smoke. Parent validation must bind actual default configuration, not pass a special override and call it default.

## Independent oracle

Freeze the already executed V5 source/config/guards/fixture/full69-event trace/log/static checks/outcome under `research/sdk-test-isolation-oracle/`; a TASK-022 worker must not author or edit those assertions/artifacts. The actual installed loader citations and exact package/file hashes are captured with them. Existing SDK provider/Runner assertions and accepted producer/CLI tests are separate worker-unowned assertions. Neither source review nor these synthetic fixtures prove real SDK drain, real Signal or AC-15.

## Controller decisions

T22-P1: add an independent high-risk prerequisite; preserve all21 existing task definitions/state/history, settings, frozen inputs and held010 code.
T22-P2: use Ivo's standing task-specific delegation transparently; do not claim he newly reviewed these bytes.
T22-P3: fail closed in the default unit-test SDK module boundary, not production SDK or a special-gate-only override.
T22-P4: refusal fixture is inert, fixed, dependency-free and never imports SDK/auth/account paths or forwards query/helper calls.
T22-P5: resolve-only negative RED must not evaluate a real SDK; later SDK execution tests use only the proved inert fallback/synthetic mocks.
T22-P6: no old test/mock/helper/timer/pool/assertion/package changes; any missing contract or needed extra ownership returns to controller first.
T22-P7: original historical default2 cause and failed B criteria remain unresolved/immutable; this prerequisite does not retroactively satisfy them.
T22-P8: fresh whole source review, new exact-content Git-only phase, fresh exact-commit review, parent object/gate checks and local integration remain mandatory. No push/PR/main merge/live fabrication.
