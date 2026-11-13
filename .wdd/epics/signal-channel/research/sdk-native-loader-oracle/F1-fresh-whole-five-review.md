## Review

**Merge verdict: BLOCK — two P1 findings remain.** Original F1 is corrected for its separator/dot-segment routes. No P0, additional P2, or lesser findings identified.

Read-only review: no repository/evidence edits, commands, tests, SDK evaluation, services, or Git/WDD mutations performed. Supplied execution evidence is attributed below; green tests and acknowledgments are not substituted for source correctness.

Paths abbreviated below:
- **D:** `/home/ivo/workspace/talon.feat-signal/.wdd/dispatch/pi-validation/`
- **N:** `/home/ivo/workspace/talon.feat-signal/node_modules/`

### Finding F2 — P1: URL-encoded SDK identity bypasses the inline classifier

**Location:** `vitest.config.ts:7,41`; missing regression at `tests/unit/providers/claude-code-sdk-isolation.test.ts:197–229`.

A dynamically supplied governed-loader request can use:

```text
/@fs//home/ivo/workspace/talon.feat-signal/node_modules/%40anthropic-ai/claude-agent-sdk/sdk.mjs
```

The current classifier requires literal `@anthropic-ai`; it misses `%40anthropic-ai`.

**Source-supported reachable chain:**

1. Vite rewrites dynamic import expressions to its governed dynamic-import function (`N/vite/dist/node/chunks/dep-BK3b2jBa.js:52619–52623`).
2. `vite-node` applies `normalizeRequestId`, which preserves `%40`. Its `toFilePath` treats `/@fs/` requests as existing without checking filesystem existence (`N/vite-node/dist/utils.mjs:15–22,59–85`).
3. Consequently, client resolution skips `resolveId` (`N/vite-node/dist/client.mjs:217–225`). The encoded filesystem spelling need not itself exist.
4. Server normalization removes the prefix but does not decode `%40`. The new inline regex misses the resulting path; default `node_modules/*.mjs` handling returns a native target (`N/vite-node/dist/server.mjs:123–126,175–213,391–400,486–497`).
5. Vitest RPC returns externalized results unchanged (`N/vitest/dist/chunks/resolveConfig.rBxzbVsl.js:6616–6620`).
6. The default client passes that absolute target to native `import(path)` (`N/vite-node/dist/client.mjs:277–281,414–421`; Vitest forwarding at `execute.2pr0rHgK.js:785–789`). Native module URL interpretation decodes `%40` to `@`, reaching the installed SDK.

This is a URL spelling of the installed SDK through the governed dynamic-import path—not arbitrary native `require`, a renamed/copied SDK, or an OS/symlink alias.

**Impact:** real SDK evaluation remains reachable despite the new documented package-loading guarantee. Current canonical/file-URL and separator regressions do not cover encoded identity components.

**Smallest correction:** recognize the relevant URL-encoded SDK identity at the pre-native-externalization boundary, preserving unrelated dependency handling. Add safe public metadata regressions establishing decoded target identity and non-externalization. Do not evaluate/import the SDK as the negative control. Renew affected safety/source gates after correction.

This finding is source-derived; no SDK import or metadata experiment was executed by this reviewer.

### Finding F3 — P1: Vitest’s worker fast path bypasses all four configured protections

**Location:** `vitest.config.ts:16–41`; test boundary at `tests/unit/providers/claude-code-sdk-isolation.test.ts:17–48,248–255`.

A separate dynamically supplied request is:

```text
/@fs//home/ivo/workspace/talon.feat-signal/node_modules/vitest/dist/../../@anthropic-ai/claude-agent-sdk/sdk.mjs
```

It carries the **literal** SDK identity and resolves to the installed SDK. Expanding `realSdkId` does not close this route.

**Source-supported reachable chain:**

1. As above, `/@fs/` causes client resolution to skip `resolveId`, retaining interior dot segments (`client.mjs:217–225`; `utils.mjs:59–85`).
2. Installed Vitest defines `distDir` as its actual `vitest/dist` directory (`N/vitest/dist/path.js:1–9`).
3. Before calling RPC, Vitest’s worker checks `id.includes(distDir)` and immediately returns `pathToFileURL(toFilePath(...).path)` as an external target (`N/vitest/dist/chunks/execute.2pr0rHgK.js:607–615`). RPC is reached only at line 621.
4. `pathToFileURL` resolves the ordinary `dist/../..` path to the SDK target. The client then native-imports it.
5. Neither `deps.inline` nor the server’s load/transform hooks is consulted. The regex correctly identifying this string is therefore insufficient.

The new tests construct a **ViteNodeServer**, not Vitest’s worker fetch path (`…isolation.test.ts:46–48`). Their successful `fetchModule` rejection cannot establish protection against this earlier worker shortcut.

**Impact:** the current implementation does not satisfy the declared governed-loader boundary, even for an SDK-identifying ordinary filesystem path. This is not an arbitrary native-import operation authored outside Vitest: ordinary governed dynamic import reaches the shortcut.

**Smallest resolution:** establish a supported guard before this worker-native shortcut and test that actual boundary safely, or return to the controller for an explicit deliverable/scope decision. A classifier-only edit cannot repair it. No existing public configuration option is asserted here to provide that earlier guard; do not invent one or privately patch Vitest/node_modules. Any diagnostic must stop before native SDK import, using inert/sentinel interception under separately verified permission.

This also is source-derived, not an executed SDK repro.

### Correct: original F1 disposition

The previous separator finding is addressed at `vitest.config.ts:7`:

- Repeated separators, `./`, mixed separators/dots, and existing sibling `sdk/../` retain both exact identity components and now match the shared plain regex.
- That same classifier supplies resolve/load/transform rejection and server inlining.
- Append-only regressions at `…isolation.test.ts:197–255` establish same device/inode/realpath, cold/cached non-externalization, resolver rejection, and post-ACK fetch rejection.
- Unrelated scope/package-boundary controls remain externalizable (`:232–245`).
- Conservative identity-bearing overrejection is explicitly approved and disclosed.

**Original F1: corrected for its reported mechanism.** F2 and F3 independently prevent whole-task approval; they do not invalidate the recorded F1 RED/GREEN observations.

## Whole-five source assessment

| Path | Assessment |
|---|---|
| `vitest.config.ts:4–58` | Exact bare alias, inert-fixture `external:false`, public pre hooks and server inline ordering are coherent for covered routes. `@talon`, discovery, environment, coverage, pool and timeout settings are retained. F2/F3 prevent accepting the complete loader guarantee. |
| `tests/fixtures/claude-agent-sdk-denied.ts:1–6` | Fixed, dependency-free refusal; exactly three exports; no SDK forwarding, credential/account inspection, tools, SDK behavior clone, or runtime changes. |
| `tests/unit/providers/claude-code-sdk-isolation.test.ts:1–256` | Actual default config/public ViteNode APIs and actual provider strategy are exercised. No static SDK/Runner/provider-value import before the fence gate. Original six-case prefix retained; appended cases meaningfully fail on the former config. Missing encoded-identity and actual-worker boundaries correspond to F2/F3. |
| `README.md:2920–2929` | Testing-only addition preserves production and networking limits. Its governed package-loading guarantee remains too strong until F2/F3 are resolved. |
| `AGENTS.md:96–105` | Testing-only addition preserves architecture/review/offload rules and correctly disclaims concurrent-mock repair and OS isolation. Same loader qualification applies. |

Actual import surfaces justify the three refusal exports:

- `src/providers/claude-code-provider.ts:66,197,218,250,318`: public strategy, dynamic SDK import, query, result mapping and native return.
- `src/daemon/agent-runner.ts:2,584–587`: static MCP-helper imports and use.
- Provider line 54 is background command-resolution metadata, not foreground isolation.

Installed public contracts inspected include Vite **5.4.21**, Vitest/vite-node **2.1.9**, public server/utils declarations, actual loader/RPC/worker implementation, and the pinned source extracts. `DepsHandlingOptions.inline` accepts strings/RegExp/true—not a predicate. No fictional option, private patch, broad dependency inlining or production change was found.

### Lifetime, privacy and test independence

- `withResolver` (`…isolation.test.ts:17–60`) reads the shipped default SDK policy. Overrides disable resources/environment discovery rather than substitute SDK routing.
- Public Vite options and installed implementation support middleware HTTP-null, disabled WebSocket/watchers and disabled dependency discovery (`dep-BK3b2jBa.js:59355–59368,63040–63061,67012–67018`).
- The fail-before-original listener spy is installed before creation; actual `server.close()` is awaited in `finally`, followed by spy restoration. Vite close awaits resource/pending-request settlement (`:63174–63194`).
- Top-level package resolution is metadata only. Type-only provider imports erase; `-t` still collects all value imports, which do not statically import SDK/Runner.
- Unmock refusal and two sequential fresh-generator actual-provider calls (`:107–192`) are useful compatibility checks, not concurrent manual-mock repair or general SDK drain proof.
- Frozen V5 source/config/guards/fixture, full 69-event trace, logs, outcome, extracts and manifest were read, never run. They prove only the constructed shared-one-result/other-none versus fresh-two iterable-ownership class and bounded awaited obligations.
- No account/auth/key data, native SDK operations, blanket network policy, or production security claim was introduced.

## Gates, source identity and supplied execution

### Renewed acknowledgments are genuine and correctly ordered

Actual worker session tool-result records were inspected, not merely report assertions:

1. **PLAN:** session line 72, request `d88e9997…`, timestamp `2026-10-18T19:00:58.270Z`, binds plan-v2 `cd0a8196…`.
2. **SDK fence:** line 98, request `48c04632…`, timestamp `2026-10-18T19:07:06.561Z`, binds config `436017ba…`, test `0a9c3c70…` and unchanged fixture/docs.
3. The four SDK-dependent command starts follow that SDK reply: owned `1792350431.8478553`, focused `1792350437.3008106`, accepted33 `1792350453.301881`, combined36 `1792350564.7405865`.
4. **Final source gate:** line 125, request `efb71afe…`, timestamp `2026-10-18T19:20:16.739Z`, is the distinct `PARENT_TASK022_F1_CURRENT_SOURCE_GATE_PASS`, not the preceding pending response.

Capture records support:

- Plan: exclusive nine-artifact capture before approval.
- SDK fence: exclusive 39-artifact packet, identity `1db4a42b…`.
- Final: exclusive 79-artifact packet, **220,566 bytes / `8287fb4e…`**, plus separate four-artifact cleanup capture before PASS.
- Current874 frame: **`a529f006…`**.
- Complete cumulative true full-index proof: **15,504 bytes / `fed21181…`**, including both untracked additions.

The complete capture inventory/current874 records, full proof, correction final through acceptance EOF, plans, gate records, raw catalogs and execution logs were inspected. No missing/stale current acknowledgment or binding contradiction was identified. These procedural facts do **not** override F2/F3.

### Source protection

The watchdog delta contains only the declared five paths. Supplied layered audits preserve:

- Original **7,068-byte** six-case/helper/import/input prefix, hash `09a5f32e…`.
- Other **872** F1-unowned files and original **869** unowned files.
- Frozen **18** inputs and separate held010 **873** files.
- Filesystem modes, HEAD `16ef537c…`, tree `e031abcd…`, canonical raw-stage index `4390f0af…`, staged zero.

I inspected audit source and results; I did **not** independently execute hashing, mode checks or Git commands. Physical binary index `2f39…` and raw-stage mapping `4390…` are different representations, not evidence of index drift.

### Recorded results—not reviewer execution

| Supplied run | Complete result |
|---|---|
| F1 metadata RED | Five expected native-target assertion failures, one control PASS; seven bodies unselected; no SDK loading |
| F1 default metadata GREEN | Eight PASS; five SDK/fetch bodies unselected |
| F1 worker owned | 13 PASS |
| F1 worker focused | Three files / 130 PASS |
| F1 worker exact accepted33 | 33 files / 1,893 PASS; 105.90s |
| F1 worker exact combined36 | 36 files / 2,023 PASS; 93.45s |
| F1 parent independent exact36 | 36 files / 2,023 PASS; 89.38s |
| Worker/parent static gates | Exact repository-rule scoped lint CLEAN; all-source-plus-owned strict CLEAN; build/help/diff/guards PASS |
| Parent runtime | Native SQLite preflight; serialized fake-Codex terminal exact reply/status/cleanup PASS |

Manifest/path validation and complete exits are recorded; `passWithNoTests` is not credited as missing-file acceptance. F1’s two long suites ran separately with adequate outer budgets, without retries or unit/CLI timeout, pool, selector, assertion or coverage weakening.

Default ignored-file lint warnings are not credited as coverage. The supplied lint override changes typed-project selection only; no inherited72 strict waiver is used.

The historical outer120 combined36 interruption remains **incomplete/uncredited**, with one separately authorized outer300 exact-command repeat preserved. It is not rewritten as product RED or successful completion.

Parent fake-terminal evidence proves only the fake-Codex runtime round-trip—not live SDK, Signal or AC-15.

### Original native failure remains immutable

The complete original final **`1b9479b8…`** and native final assistant text **`6bc54cd5…`** genuinely report all three criteria satisfied after original source ACK/capture. Separately:

- Original c305/b7 workflow receipt remains terminal **FAILED/rejected**.
- Its selected child report matches the earlier pending-criterion3 prefinal.
- Failure packet **`1e88bd74…`** and original receipts remain unchanged.
- Harness selection internals remain untraced.
- Original `8f37…`/`09a5…` SDK/source ACKs are historical and were withdrawn as current authority after F1.

Neither the correction nor this review revives that native workflow or old010 criteria.

## ALL Decisions: dispositions and supersessions

Full texts are retained in correction sections 7/9 and `D/TASK-022-F1-worker-0fd78469-inherited-decisions-v1.txt`. Each decision is adjudicated below; none is superseded by omission.

| Decision | Disposition |
|---|---|
| **T22-P1** — independent prerequisite; preserve original21/state/history/settings/inputs/held010 | Scope and supplied protection audits agree. No old010 acceptance inferred. |
| **T22-P2** — standing task-specific delegation, not fresh Ivo byte approval | Provenance remains correctly qualified. |
| **T22-P3** — fail closed in shipped default test boundary | Bare fallback and covered server routes work; **objective remains incomplete under F2/F3**. |
| **T22-P4** — inert, fixed, dependency-free refusal fixture | Verified in all six fixture lines. |
| **T22-P5** — metadata-only RED; later inert/synthetic execution after fence | Recorded RED and gate ordering support this; no real SDK negative execution credited. |
| **T22-P6** — preserve old tests/mocks/helpers/timing/packages; controller for extra ownership | Reviewed delta and supplied audits comply. F3 requires controller adjudication before broader implementation. |
| **T22-P7** — old default2 cause/failed B criteria remain unresolved | Retained; no retrospective cause/absence certificate. |
| **T22-P8** — fresh whole source review, separate Git/exact-commit/object/gates/integration | This whole review is **BLOCK**. All later phases remain separate. |
| **T22-W1** — raw-stage index canonical; binary index diagnostic only | Correct representation distinction; no reset/adoption inferred. |
| **T22-W2** — public ViteNode metadata/default config oracle | Valid for its tested server boundary; **not complete worker-path proof**, as F3 demonstrates. |
| **T22-W3** — exactly three fixed refusal exports | Verified against current imports; no behavior clone. |
| **T22-W4** — exact alias + rejecting hooks + inline | Correct server-side architecture for covered paths; **insufficient under F2/F3**. |
| **T22-W5** — awaited close, pre-listen guard, fresh generators | Verified. Only its original concurrent-positive expectation was superseded by W6. |
| **T22-W6** — sequential actual-provider compatibility, not concurrent-mock repair/serialization | Explicit supersession preserved and implemented. No serial-suite waiver inferred. |
| **T22-W7** — preserve authoring diagnostics, genuine RED and incomplete36 separately | Records maintain these distinctions. |
| **T22-W8** — outer-only recovery under actual permission/cleanup; one exact repeat | Historical bounded recovery remains preserved; no test budget weakening credited. |
| **T22-W9** — actual provider451/correct call sites supersede uncertain count only | Actual source supports `66/197/218/250/318`; no wider supersession. |
| **R2-B31** — frozen outside-task inert fence/deny-original diagnostic | Historical bounded oracle only, not current default-loader authority. |
| **R2-B32** — shared-one/no-result versus fresh-two constructed class | Full trace supports that class, not historical cause or persisted zero-usage row. |
| **R2-B33** — actual pending-next/adapter/native returns awaited before next arm | Trace/source support bounded inert completion only, not general SDK/bridge drain. |
| **R2-B34** — preserve V4/default2 failures/blocked criteria and held code | Retained unchanged; no revival or causal certificate. |
| **T22-F1-W1** — rejected `/+`-only v1; approved conservative exact-scope/later-SDK regex | Explicit v1 supersession is sound and fixes reported separator/dot routes. Approved overmatch retained. **Does not close F2/F3.** |
| **T22-F1-W2** — five actual same-file metadata cases, boundary controls, post-ACK fetch | Implemented with meaningful RED/GREEN and correct gate ordering; coverage remains bounded to those routes. |
| **T22-F1-W3** — original prefix/872 frozen; unique evidence; retain diagnostics | Supported by audits/catalogs and cumulative delta. |
| **T22-F1-W4** — final marker only after actual final ACK; preserve old failure | Draft/final/session chronology supports this operational distinction. No harness-root-cause claim accepted. |
| **T22-F1-W5** — versioned bytecount erratum and parent schema-check recovery | Errors remain recorded as metadata/authoring errors, not product RED or waived tests; source hashes remain unchanged. |

## Declined/unverified boundaries

- No commands/tests, historical scripts, SDK evaluation, services, Git/WDD mutation or repository edits performed by this reviewer.
- No executable hash/mode recomputation, full-repository behavioral review or committed-range/object review.
- F2/F3 were source-traced, not executed. No claim that any prior validation actually exercised those escapes or accessed an account/network.
- Arbitrary native require, subprocesses, OS aliases, renamed/copied SDKs and general networking remain outside the stated boundary; these exclusions do not excuse the two governed routes above.
- No live SDK/provider/Signal/AC-15 proof, general SDK/bridge drain proof, historical default2/V4 diagnosis, or old010 readiness.
- Additional adversarial path/platform spellings were not exhaustively evaluated.
- WDD review recording was not executed because this dispatch expressly prohibits commands/mutation.

**Final merge verdict: BLOCK.** Resolve F2/F3 through controller-approved bounded work, renew affected gates and obtain fresh whole-five review. NEW Git-only/one-commit/exact-review/object/committed-gate/WDD-CURRENT/local-integration phases remain separate; no push, PR or main merge authority is granted.