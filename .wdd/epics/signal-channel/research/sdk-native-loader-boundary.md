# Native SDK test-loader prerequisite (TASK-023)

## Authority and current state

Ivo's standing task-specific instruction is to finish this WDD autonomously without more questions, using controller judgment (3d350eb3). This is an additive bounded corrective prerequisite under that delegation, NOT a fresh Ivo review of this design. No original22 definitions, state/history, scope settings, original inputs or held source may be rewritten. TASK022 remains five-file owned composition; the new task owns only a separate test helper and its new tests. TASK022/010 stay held until reviewed local integration of this prerequisite. No false dependency rewrite is necessary: controller holds the existing integration consumer explicitly, as with the earlier SDK prerequisite.

Actual WHOLE2 reviewer b9c31efa/0fd BLOCKED two P1s after genuine F1 correction/native checked source acceptance. F1 repeated separators/dot paths are fixed in current code. F2 percent-encoded scope and F3 Vitest worker-native shortcut remain. Parent source-only/public-metadata diagnosis confirms both; no actual SDK evaluation, native SDK import/query/account/network operation was attempted. ALL old successful scoped gates and failed receipts remain historical, never reinterpreted as these escapes being covered or exercised.

## Confirmed installed boundaries

Installed Node v24.15.0 exposes `node:module.registerHooks` as a function. Public Node v24.15.0 docs: https://nodejs.org/download/release/v24.15.0/docs/api/module.html . Synchronous hooks introduced v23.5.0/v22.15.0, release-candidate in v24.13.1. `registerHooks({ load(url, context, nextLoad) { ... } })` returns a handle with `deregister()`, otherwise hooks persist for the Node instance lifetime. A synchronous load hook receives a resolved URL before module source/evaluation and can throw instead of calling nextLoad. It affects subsequent native import/require in that thread. It is not inherited automatically by arbitrary child worker threads; this is NOT process/OS isolation.

Use a LOAD-only hook, not a rejecting resolve hook: existing independent SDK tests deliberately call createRequire.resolve for public package metadata. Metadata resolution MUST remain usable without executing the SDK. Native URL resolution/fileURLToPath/path normalization provides actual percent-decoding and ordinary dot normalization before evaluating candidate identity. Preserve normal unrelated native modules and Node builtins. Do not privately replace Vitest/ViteNode functions, edit dependencies or implement a predicate option the installed API does not expose.

Installed @types/node/module.d.ts223-247 declares RegisterHooksOptions.load/resolve and ModuleHooks.deregister; use actual typed LoadHookSync/nextLoad contract, no casts/private handles/suppressions. Read complete relevant declaration/official sections before implementation.

Vitest2.1.9 worker execute.2pr0rHgK.js607-621 checks cached externalization and `id.includes(distDir)` BEFORE RPC. Its dist-containing path is converted via public toFilePath/pathToFileURL and returned as native target; server deps.inline and load/transform cannot intercept that earlier shortcut. Public Node load hook runs at the later native-loading boundary BEFORE SDK body evaluation, closing this bypass without patching the worker. This is a different enforcement seam, not another regex adjustment.

Installed @vitest/runner/dist/index.js817-856 awaits setupFiles before `runner.importFile(filepath, 'collect')`. TASK022 will own adding the new accepted helper to DEFAULT test.setupFiles in its existing config file and updating its testing paragraphs. TASK023 produces the helper primitive and safe tests ONLY; it must not claim the default suite is protected until TASK022 composes it. No pool, concurrency, timeout, coverage, discovery or original test-body changes.

## F2/F3 evidence and exact qualifications

Parent `.wdd/dispatch/pi-validation/TASK-022-review2-F2-F3-parent-metadata-1.mjs/.log`:
- F2 /@fs/.../node_modules/%40anthropic-ai/claude-agent-sdk/sdk.mjs is marked exists by public mapping, externalized by current server, and Node import.meta.resolve METADATA resolves to the actual SDK URL/inode. Do not falsely claim the literal %-encoded filesystem name exists.
- F3 /@fs/.../node_modules/vitest/dist/../../@anthropic-ai/claude-agent-sdk/sdk.mjs contains actual installed Vitest dist; public pathToFileURL maps it to SDK URL/inode. Current server would inline it, but source-confirmed worker shortcut precedes that server. Parent did NOT invoke private worker functions or perform native SDK import.
- Vite metadata server was nonlistening/no optimizer discovery/env file, listener guard zero calls, actual close awaited.

Whole2 report is immutable. Original c305/b7 FAILED stale-prefinal acceptance remains failed; genuine old final/source gates are separate. F1 d10 native complete/review-required/final56966B abb68446 and current code436017/test0a9/a529/fullfed21181 remain preserved. Current SDK-dependent suites/imports are WITHDRAWN until default composition plus renewed safety gates. Old010 default2/V4 realSDK occurrence remain UNKNOWN, original failed criteria immutable; V5 only bounded inert constructed iterable-ownership proof. No original live AC15 proof.

## Bounded producer design

Own ONLY:
- tests/fixtures/claude-agent-sdk-native-guard.ts
- tests/unit/providers/claude-code-sdk-native-guard.test.ts

The helper exports `installSdkNativeGuard(): void` and eagerly calls it when imported so TASK022 can use this SAME file as a supported setupFiles entry. Installation must be idempotent per actual Node worker instance, including Vitest module-cache resets/setup reloads. Use owned, narrowly namespaced registration state, not private Vitest state or mutation of unrelated globals. Explain the lifetime/idempotency constraint. Keep the hook for the test worker lifetime; do not deregister at file afterAll while admitted/deferred native loads might remain. No general SDK-drain or arbitrary-child inheritance claim.

Use public synchronous Node LOAD hook only. Before nextLoad, normalize/decode file URLs and reject actual SDK package loads with fixed plain Error message `Claude Agent SDK is disabled in unit tests; provide an explicit mock.` Do not return a fabricated module/SDK behavior, import SDK, read auth/account/key files, execute model/CLI/network, or expose path/token data in refusal. Preserve metadata createRequire.resolve. Recognize canonical installed SDK package root by metadata if needed and decoded canonical SDK-identity components for inert same-name sentinels; public Node path/URL/metadata primitives only. Consider platform/URL errors conservatively without breaking unrelated URLs/modules. ESM caching/registration timing must be stated honestly; no retroactive exclusion of already evaluated modules.

No code in production, existing config/tests/fixtures/docs, packages/locks/node_modules, generic process/network deny or default suite setting changes in this producer. TASK022 owns eventual default composition/testing docs. Original22 definitions/source and existing six-case/13-case prefixes stay unowned and exact. Adding this helper is not default integration completion.

## Safe test/oracle contract

NEVER negative-import the real installed SDK, even to check expected rejection. All executable import negatives use fresh tiny INERT sentinels under unique disposable temp paths with SDK-shaped package names. Body is fixed, dependency-free and visibly throws an INERT sentinel error if evaluated, never auth/CLI/network/SDK behavior. SDK metadata resolution may read public package paths only. Assert every imported sentinel canonical target belongs to its own generated temp root; preserve artifacts instead of destructive cleanup if ownership is uncertain.

Cover actual native load closure: canonical SDK-shaped URL; percent-encoded scope/leaf URLs; ordinary separator/dot spellings; actual Vitest worker fast-path governed dynamic import ID carrying installed vitest/dist plus a relative traversal to an inert SDK-shaped temp target. Exercise actual default worker dynamic import with variables (not a cloned executor/private function), while targets are INERT. Unrelated scope/sibling and builtins stay usable; metadata require.resolve remains usable; repeated installer/reset/setup invocations preserve denial without unbounded duplicate registration. All original assertions/mocks/settings untouched.

Independent parent-authored `sdk-native-loader-oracle/native-loader-conformance.mjs` has literal refusal expectations and independently verifies Node native-boundary behavior, including decoded identities and same-file target constraints. Worker MUST NOT edit it or substitute its own oracle. Read actual Node/Vitest sources and pinned excerpts as separate contracts. This oracle tests the helper's native boundary, not default setup composition or real SDK execution. Worker test additionally exercises actual Vitest worker fast path against INERT targets. Parent independently runs both after source/static/inert-target safety checks.

Safe behavioral RED may run this independent oracle with helper absent (no import attempted for missing helper) and then import only inert sentinels, observing sentinel execution instead of fixed refusal. That is a behavioral missing-guard assertion, not collection/module-not-found/compiler failure. After helper implementation, exact same independent oracle must pass. No live SDK control. Every sentinel negative is bounded/no network/children/secrets. No full SDK/provider/Runner/accepted33/36 suites on this producer's unfenced base config; those wait for TASK022 default composition. Scoped lint/clean allsource+owned strict, build/help and parent fake terminal remain applicable.

## Mandatory authority gates

1. Fresh actual assigned route/base/rawstage index/initial bytes/modes/status before writes. Read immutable brief/context/public APIs, then complete versioned PLAN; actual PARENT_TASK023_PLAN_APPROVED before edits.
2. Before any new executable loader negative/worker import, save complete source/inert fixture/target construction and operation boundary, request PARENT_TASK023_INERT_BOUNDARY_RUN_APPROVED. This can authorize ONLY proved inert tests/oracle, not real SDK module import. No actual SDK-dependent suite permission follows.
3. Complete stable source/current identity/full-index/raw evidence/ALL inherited/new Decisions and supersessions, then PARENT_TASK023_CURRENT_SOURCE_GATE_PASS only AFTER parent independent checks/exclusive accepted capture. Same-code final after actual reply; pending prefinal plain Markdown, reserved final acceptance marker only at final. Timeout/progress/nativeok not ACK.
4. Fresh Sol6.1xhigh whole source review, NEW exact-content Git-only/normal onecommit, fresh exact-commit review, actual objects/repeated gates/WDDCURRENT/local integration. NO push/PR/main merge, native failed-criteria revival or live certificate.

## Controller decisions

T23-P1: add a separate two-file SDK-specific native-loader test-helper prerequisite; keep all original22 definitions/states/history/settings/inputs/held source unchanged, no active-task scope rewrite.
T23-P2: use public Node24 synchronous LOAD hook to reject SDK source before evaluation despite Vitest worker-native shortcut; preserve SDK metadata resolution and unrelated dependencies.
T23-P3: helper auto-installs for future supported setupFiles composition; explicit idempotent install export, worker-lifetime registration, no arbitrary-child/OS isolation promise.
T23-P4: every executable negative uses only bounded inert SDK-shaped sentinels with independently checked temp-root identity; never import real SDK as a failing control.
T23-P5: parent-authored native conformance oracle plus actual Vitest-worker inert tests are distinct proof seams; source/private-framework evidence is not permission to patch it.
T23-P6: TASK022 retains default config/testing-doc composition ownership after accepted helper integration and honest refresh; helper-only acceptance does not certify default protection or old failures.
T23-P7: exercise Ivo's standing autonomous corrective-prerequisite delegation transparently, not fresh design approval; preserve all numbered Decisions and immutable failed/currently blocked outcomes.
