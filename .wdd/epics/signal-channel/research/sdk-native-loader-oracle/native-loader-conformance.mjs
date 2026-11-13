import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const candidate = resolve(process.argv[2] ?? '.');
const helper = join(candidate, 'tests/fixtures/claude-agent-sdk-native-guard.ts');
const require = createRequire(pathToFileURL(join(candidate, 'package.json')));
const sdkEntryMetadataBefore = require.resolve('@anthropic-ai/claude-agent-sdk');
const vitestDist = join(dirname(require.resolve('vitest/package.json')), 'dist');
const denial = 'Claude Agent SDK is disabled in unit tests; provide an explicit mock.';
const inertBody = "throw new Error('INERT_SDK_SENTINEL_EVALUATED');\n";
const sandbox = mkdtempSync(join(tmpdir(), 'talon-native-sdk-oracle-'));
const sdk = join(sandbox, 'node_modules/@anthropic-ai/claude-agent-sdk/oracle.mjs');
const sibling = join(sandbox, 'node_modules/@anthropic-ai/sdk/control.mjs');
const otherScope = join(sandbox, 'node_modules/@other-scope/claude-agent-sdk/control.mjs');
for (const path of [sdk, sibling, otherScope]) mkdirSync(dirname(path), { recursive: true });
writeFileSync(sdk, inertBody, { flag: 'wx' });
for (const path of [sibling, otherScope]) writeFileSync(path, "export const value = 'INERT_UNRELATED_CONTROL_OK';\n", { flag: 'wx' });

const helperExists = existsSync(helper);
if (helperExists) {
  const guard = await import(pathToFileURL(helper).href);
  assert.equal(typeof guard.installSdkNativeGuard, 'function');
  guard.installSdkNativeGuard();
  guard.installSdkNativeGuard();
}
assert.equal(require.resolve('@anthropic-ai/claude-agent-sdk'), sdkEntryMetadataBefore);

const fastRaw = vitestDist + '/' + relative(vitestDist, sdk);
assert.ok(fastRaw.includes(vitestDist));
const cases = [
  ['canonical', pathToFileURL(sdk).href],
  ['encoded-scope', pathToFileURL(sdk).href.replace('/@anthropic-ai/', '/%40anthropic-ai/')],
  ['encoded-leaf', pathToFileURL(sdk).href.replace('/claude-agent-sdk/', '/cl%61ude-agent-sdk/')],
  ['dot-and-separators', 'file://' + sdk.replace('/@anthropic-ai/claude-agent-sdk/', '/@anthropic-ai//./claude-agent-sdk/')],
  ['worker-fastpath-native-target', pathToFileURL(fastRaw).href],
];
const results = [];
for (const [label, request] of cases) {
  const target = realpathSync(fileURLToPath(request));
  assert.equal(target, realpathSync(sdk));
  assert.ok(target.startsWith(realpathSync(sandbox) + '/'));
  assert.notEqual(target, sdkEntryMetadataBefore);
  let actual;
  try { await import(request + '?native-oracle=' + label); actual = 'UNEXPECTED_MODULE_SUCCESS'; }
  catch (error) { actual = error instanceof Error ? error.message : 'NON_ERROR_THROW'; }
  results.push({ label, request, target, expected: denial, actual, passed: actual === denial });
}
for (const [label, path] of [['sibling', sibling], ['other-scope', otherScope]]) {
  const module = await import(pathToFileURL(path).href);
  assert.equal(module.value, 'INERT_UNRELATED_CONTROL_OK');
  results.push({ label, passed: true, actual: module.value });
}
const passed = results.every((row) => row.passed);
console.log(JSON.stringify({ oracle: 'parent-authored Node native load conformance, not a Vitest worker clone', candidate, helperExists, sandboxPreserved: sandbox, realSDKImported: false, metadataResolutionStillUsable: true, helperRepeatedInstallExercised: helperExists, actualWorkerExecutionClaimed: false, results, passed, limits: 'Only INERT generated modules imported; no actual SDK/module/query/account/network/CLI. Actual Vitest worker path is a separate required owned test. No destructive cleanup; temp artifacts retained.' }, null, 2));
if (!passed) process.exitCode = 1;
