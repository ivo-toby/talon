# Public Node24 + installed Vitest contract pins

Official versioned reference: https://nodejs.org/download/release/v24.15.0/docs/api/module.html . Retrieved readable response mve80zivgonaqh; API presence independently checked on actual Node v24.15.0: typeof registerHooks === function. No SDK operation.

Exact documentation passages inspected:

> module.registerHooks(options)
> History: v24.13.1 Synchronous and in-thread hooks are now release candidate; v23.5.0, v22.15.0 Added.

> deregister(): Remove the registered hooks so that they are no longer called. Hooks are otherwise retained for the lifetime of the running process.

> The module.registerHooks() method accepts the following synchronous hook functions.
> function resolve(specifier, context, nextResolve) { /* Take an import or require specifier and resolve it to a URL. */ }
> function load(url, context, nextLoad) { /* Take a resolved URL and return the source code to be evaluated. */ }

> Synchronous hooks are run in the same thread and the same realm where the modules are loaded.

> Synchronous hooks are not inherited into child worker threads by default, though if the hooks are registered using a file preloaded by --import or --require, child worker threads can inherit the preloaded scripts via process.execArgv inheritance.

> Do not use static import statements to load modules that need to be customized in the same module that registers the hooks, because static import statements are evaluated before any code in the importer module is run, including the call to registerHooks().

Thus producer helper imports ONLY Node builtins/metadata and installs before subsequent module loading; TASK022 future setupFiles composition must precede test collection. Do NOT reject metadata resolution or assume arbitrary-child inheritance. Retain the SDK-specific load hook for the actual worker lifetime. No private Vitest API or broad network/process denial follows.

Installed API declarations are frozen separately from node_modules/@types/node/module.d.ts223-247,430-486. LoadHookSync takes(url,context,nextLoad) and returns LoadFnOutput; preserve nextLoad semantics for unrelated modules, no casts/fabricated fields.

Installed @vitest/runner/dist/index.js817-856: runSetupFiles imports config.setupFiles via runner.importFile(path,'setup'); collectTests awaits it BEFORE runner.importFile(testfile,'collect'). This is the supported future default integration, not a custom/private worker patch. Versioned configuration reference: https://v2.vitest.dev/config/#setupfiles . Public reference says setupFiles run before each test file; isolation/cache-reset behavior does not deregister Node process hooks, so installer idempotency matters.

Installed Vitest worker fast path frozen separately: execute.2pr0rHgK.js607-621 returns external targets for cached IDs or IDs containing actual distDir BEFORE RPC. ViteNode default importExternalModule uses native import(path). A server-only deps.inline/plugin regex cannot govern that earlier branch; the public Node LOAD hook is a different pre-source-evaluation boundary. This is not a promise to prevent external-target metadata from ever being generated; it refuses actual SDK loading.
