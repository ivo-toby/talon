# TASK-023: SDK-specific native test-loader guard primitive

## Objective

Provide a small developer-test-only Node native load guard that denies Claude SDK source evaluation, including URL-encoded identities and Vitest's pre-RPC native shortcut. Preserve production and all existing tests/settings. This is an additive prerequisite under Ivo's standing autonomous completion delegation3d350eb3, NOT fresh Ivo approval, a scope waiver or original native-failure revival.

## Deliverable

A private test helper and safe inert conformance tests exist. Importing `tests/fixtures/claude-agent-sdk-native-guard.ts` eagerly installs an idempotent worker-lifetime SDK-specific synchronous Node LOAD hook; it also exports `installSdkNativeGuard(): void`. Normal metadata resolution/unrelated dependencies remain usable. New owned tests exercise actual native loading AND actual Vitest worker governed dynamic import to only INERT SDK-shaped targets. The parent-authored frozen Node oracle independently verifies native loading refusal.

This producer DOES NOT change default Vitest configuration or claim the default suite is protected. TASK022 owns adding this accepted helper to supported test.setupFiles and the matching testing documentation after honest refresh. Its existing five paths stay unowned here; no active task definition rewrite is needed.

## Interfaces

Consumes:
- Node v24.15.0 public `node:module.registerHooks({load})`, LoadHookSync/nextLoad declarations, file URL/path normalization and public package metadata only, as cited/frozen in `research/sdk-native-loader-boundary.md` and oracle docs/extracts.
- Installed Vitest2.1.9 worker/native shortcut and runner setupFiles-before-collect source evidence; public Vitest/Node APIs for executable tests, NOT private worker/loader patch APIs.
- Frozen parent-authored `research/sdk-native-loader-oracle/native-loader-conformance.mjs` and F2/F3 source/public-metadata evidence. Oracle is independent and unowned by worker.
- Actual provider/Runner SDK import surfaces READ ONLY; fixed unit refusal message `Claude Agent SDK is disabled in unit tests; provide an explicit mock.` No SDK behavior emulation or production error/API.

Produces:
- `installSdkNativeGuard(): void`, eager call on helper import, process/worker-instance idempotence and lifetime retention. No deregistration at test afterAll while deferred/native loads may remain.
- SDK-specific LOAD rejection before nextLoad/evaluation, after URL decoding/path normalization, covering installed SDK metadata-root and SDK-identity-bearing inert paths. No rejecting resolve hook: existing createRequire.resolve SDK metadata MUST remain usable.
- Independent native-oracle results and actual Vitest-worker inert boundary tests. Neither implies real SDK execution, default integration, arbitrary-child inheritance or OS isolation.

## Scope

Only TWO new paths:
- `tests/fixtures/claude-agent-sdk-native-guard.ts`
- `tests/unit/providers/claude-code-sdk-native-guard.test.ts`

Both absent on integration base at dispatch. Keep original all872tracked and all existing tests/helpers/mocks/assertions/settings/docs/production bytes+modes exact. Preserve separate heldTASK022 all874/head/index/modes/current436017ba/test0a9c3c70/fullfed21181 and heldTASK010 all873/head/index/modes/87faf307/befdc041/full24e8. No default config/setupFiles/pool/timeouts/concurrency/coverage/discovery/package/lock/node_modules changes. No general process/network deny, tool capability/routing/data-store policy or production provider changes. TASK022 already owns config/testing docs; no consumer wiring here.

Use only supported synchronous Node LOAD hook. A load hook may throw fixed inert plain unit Error instead of nextLoad for decoded/normalized SDK file URLs. Unrelated Node builtins/modules/sibling package scopes/leaves must retain normal loader behavior. Do not privately overwrite Vitest/ViteNode functions or Node import machinery; no fictitious config predicate. Use actual Node/v24 declaration contracts with strict typing, no casts/suppressions/private handles. Helper may resolve public SDK package metadata without loading it; it never reads credentials/accounts/keys, imports SDK, instantiates tools, forwards query, invokes CLI/model/network or fabricates SDK module content.

Synchronous hooks apply to the Node instance/thread where installed; arbitrary child process/thread inheritance is NOT promised. Supported Vitest setupFiles composition later installs in each actual test worker before test collection. ESM module-cache timing and worker-lifetime registration/idempotency must be explicit. Do not claim protection retroactively for previously evaluated modules.

## Safe validation and authority

Before writes FIRST actualpwd/branch/head/tree/canonical RAW `git ls-files --stage -z | sha256sum`/status/currentownedabsent/wholebaseline bytes+modes. PHYSICAL binary .git/index is a DIFFERENT representation; never substitute its hash. Wrong route STOP; no cd/adoption/branch/index reset/refresh/newworktree/model/CLI/protocol fallback. Read complete immutable snapshot/public docs/types/SDK actual import source and existing configuration/tests before design. Sole fresh native Sol6.1high writer, no child fanout; controller handles all decisions, not Ivo.

Save complete versioned read-based plan and safe executable-negative design; actual `PARENT_TASK023_PLAN_APPROVED` before edits. Before ANY new executable loader negative or worker import test, save full source/target-generation/inert fixture/static-operation boundary and get actual `PARENT_TASK023_INERT_BOUNDARY_RUN_APPROVED`. Initial PLAN is not execution permission. Only then may selected owned inert tests/frozen oracle run. No SDK-dependent original provider/Runner/33/36/full-suite checks on this base: default composition belongs to TASK022 and remains unsafe until its later gates.

ALL executable negatives use only newly created tiny INERT sentinel files under unique disposable temp roots, regular known-content files with no imports/account/network/CLI behavior. Every native target must be independently resolved/realpath-checked to stay inside its generated temp root and differ from real SDK metadata. A sentinel can throw `INERT_SDK_SENTINEL_EVALUATED` to prove missing guard safely. Never negative-import/evaluate the real SDK—even when expecting guard rejection. Parent/inert oracle may resolve real SDK package metadata only. Refusal expectations are literal and parent-authored; worker cannot change them or special-case the oracle pathname.

Actual worker F3 test must use ordinary Vitest-governed dynamic import of a variable `/@fs/.../vitest/dist/.../../...` request targeting an INERT SDK-shaped temp file. Do not invoke/clone private worker functions, override dependencyRequest/fetchModule/importExternalModule, or call a shadow path and claim worker proof. F2 encoded scope/leaf variants similarly target INERT files. Canonical/dot URL native cases, unrelated controls, metadata resolution and repeated installation/module-reset lifetime also require proof. Worker should use public test framework APIs only. Missing contract/extra ownership/any realSDK path danger => controller BEFORE running/guessing.

Independent oracle baseline: when helper is absent, its import is skipped, but the SAME unconditional fixed-denial assertions run against inert sentinels and must fail because sentinel code executes instead. This is genuine missing-guard behavior, not module-not-found/compiler/collection RED. Once helper is implemented, same frozen oracle must pass. All oracle sentinel artifacts remain preserved; no destructive cleanup. Additional worker tests must have meaningful behavior RED/GREEN, not green-only config reflection. Record exact cwd/argv/exits/raw/source/lifetime and every failed authoring/diagnostic result separately.

## Verification

Order: actual scoped repository-rule lint covering both owned TS paths; CLEAN strict all-source+both-owned project; after separate inert-boundary permission, selected owned tests and frozen parent-native oracle; build/help; scope/held-source/lifetime guards. Controller supplies immutable exact typed-parser project metadata if default lint ignores tests; no rules disabled/suppressions/default ignored-as-pass. NO inherited72 waiver.

Owned test command:
```sh
npx --no-install vitest run tests/unit/providers/claude-code-sdk-native-guard.test.ts
```
Parent-authored independent Node oracle (absolute frozen snapshot oracle path, candidate assigned worktree):
```sh
node ABS_SNAPSHOT/research/sdk-native-loader-oracle/native-loader-conformance.mjs ABS_ASSIGNED_WORKTREE
```
Then:
```sh
npm run build
node dist/cli/index.js --help
```
Parent additionally owns the ratified serialized no-cost fake-terminal exactreply/status/cleanup oracle. Worker NEVER starts daemon/services/smoke. This only proves fakeCodex runtime; no SDK/live Signal/AC15 proof.

No `npm test` full slow suite, package installs/updates, original SDK suites, live/query/auth/account/key access, service/container/provisioning, model CLI, Root/main merge/publication or file deletion. Worker no Git/WDD mutation/stage/commit/refresh/rebase/stash/release/push/PR. Preserve all prior Task022 P1/P2 reviews/native failures/ACKs as historical, not current full-loader acceptance.

## Definition of done

- Two-file helper/test primitive meets actual public native-load and actual Vitest-worker inert boundary contracts; fixed refusal, metadata/unrelated modules preserved, no actual SDK evaluation. Default config/production/original bytes unchanged; no false integration claim.
- All scope/current objects/held022874/held010873/modes/index guards pass. ALL controller/new worker numbered Decisions and explicit supersessions/fullraw/proof/lifetime/privacy limits saved.
- Complete versioned pending draft/currentfull-index/identity/raw BEFORE actual `PARENT_TASK023_CURRENT_SOURCE_GATE_PASS` after parent independent checks+exclusive accepted capture. Hold alive/samecode; timeout/progress/nativeok notACK. Prefinal plain Markdown; reserved final acceptance marker only after actual finalACK. No source edits after bound gate.
- Fresh independent Sol6.1xhigh whole-two-path review; all P1/P2 block. Separate NEW exact-content Git-only/one normalcommit, fresh exact-commit review, actual objects/repeated parent gates/WDDCURRENT/local integration mandatory later. No push/PR/main merge or live certificate.
- TASK022 later imports this accepted helper via supported default setupFiles in its OWN config scope after honest backup/cleanrefresh/exactrestore/new guards and renewed composition/safety/source/review gates. Source helper alone is not default protection, old native failure revival or historical cause proof.
