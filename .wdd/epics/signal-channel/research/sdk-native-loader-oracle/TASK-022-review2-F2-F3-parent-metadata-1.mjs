import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Server } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { ViteNodeServer } from 'vite-node/server';
import { normalizeRequestId, toFilePath } from 'vite-node/utils';
const root = '/home/ivo/workspace/talon.feat-signal/.worktrees/SCOPE-signal-channel/TASK-022';
const require = createRequire(import.meta.url);
const sdk = require.resolve('@anthropic-ai/claude-agent-sdk');
const sdkStat = statSync(sdk);
const dist = dirname(require.resolve('vitest/package.json')) + '/dist';
const encoded = sdk.replace('/@anthropic-ai/', '/%40anthropic-ai/');
const f2 = toFilePath(normalizeRequestId('/@fs/' + encoded), root);
assert.equal(f2.exists, true);
const f2NativeResolved = import.meta.resolve(f2.path);
assert.equal(statSync(fileURLToPath(f2NativeResolved)).ino, sdkStat.ino);
const rawFast = dist + '/../../@anthropic-ai/claude-agent-sdk/sdk.mjs';
const f3 = toFilePath(normalizeRequestId('/@fs/' + rawFast), root);
assert.equal(f3.exists, true);
assert.ok(('/@fs/' + rawFast).includes(dist));
const f3FastTarget = pathToFileURL(f3.path).href;
assert.equal(statSync(fileURLToPath(f3FastTarget)).ino, sdkStat.ino);
assert.equal(fileURLToPath(f3FastTarget), sdk);
let server;
const originalListen = Server.prototype.listen;
let listens = 0;
Server.prototype.listen = function () { listens += 1; throw new Error('SAFE_METADATA_LISTEN_DENIED'); };
try {
  server = await createServer({ root, configFile: resolve(root, 'vitest.config.ts'), mode: 'test', envFile: false, publicDir: false, server: { middlewareMode: true, ws: false, hmr: false, watch: null, preTransformRequests: false }, optimizeDeps: { noDiscovery: true, include: [] }, ssr: { optimizeDeps: { noDiscovery: true, include: [] } } });
  assert.equal(server.httpServer, null);
  const options = server.config.test?.server;
  const loader = new ViteNodeServer(server, { ...options, deps: { ...options?.deps } });
  const f2External = await loader.shouldExternalize(f2.path);
  assert.equal(f2External, f2.path);
  const serverWouldInlineF3 = await loader.shouldExternalize(f3.path);
  assert.equal(serverWouldInlineF3, false);
  assert.equal(server.moduleGraph.getModuleById(sdk), undefined);
  console.log(JSON.stringify({ sdk, f2: { encoded, publicFileMapping: f2, externalize: f2External, nativeResolveMetadata: f2NativeResolved, decodedSameSDKInode: true, limits: 'Node resolve METADATA only, no import/evaluation' }, f3: { installedVitestDist: dist, originalGovernedId: '/@fs/' + rawFast, idContainsActualDist: true, publicFileMapping: f3, publicPathToFileURL: f3FastTarget, sameSDKInode: true, serverWouldInlineF3, limits: 'source-confirmed worker dist fast path precedes RPC; no private worker function invoked or SDK imported' }, sdkCodeEvaluated: false }, null, 2));
  assert.equal(listens, 0);
} finally {
  try { if (server) { await server.close(); console.log('ACTUAL_VITE_CLOSE_AWAITED'); } }
  finally { Server.prototype.listen = originalListen; assert.equal(listens, 0); console.log('LISTENER_RESTORED_ZERO_CALLS'); }
}
