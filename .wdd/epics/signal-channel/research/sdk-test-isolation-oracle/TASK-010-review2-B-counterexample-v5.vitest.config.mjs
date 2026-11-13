import { defineConfig } from 'vitest/config';
import { appendFileSync } from 'node:fs';
import base from '/home/ivo/workspace/talon.feat-signal/.worktrees/SCOPE-signal-channel/TASK-010/vitest.config.ts';
const out = '/home/ivo/workspace/talon.feat-signal/.wdd/dispatch/pi-validation/';
const sdk = out + 'TASK-010-review2-B-counterexample-v5-sdk.fixture.mjs';
const trace = out + 'TASK-010-review2-B-counterexample-v5-trace.jsonl';
const realSdk = /(?:^|\/)@anthropic-ai\/claude-agent-sdk(?:\/|$)/;
function rejectRealSdk(id) {
  if (realSdk.test(id)) {
    appendFileSync(trace, JSON.stringify({ stage: 'real-sdk-route-refused', id }) + '\n');
    throw new Error('Real SDK resolution/loading is forbidden in diagnostic');
  }
}
export default defineConfig({
  ...base,
  root: '/home/ivo/workspace/talon.feat-signal/.worktrees/SCOPE-signal-channel/TASK-010',
  resolve: { ...base.resolve, alias: [
    { find: /^@anthropic-ai\/claude-agent-sdk$/, replacement: sdk },
    ...Object.entries(base.resolve?.alias ?? {}).map(([find, replacement]) => ({ find, replacement })),
  ] },
  plugins: [{
    name: 'diagnostic-inert-sdk-fence', enforce: 'pre',
    resolveId(id, importer) {
      if (id === sdk) {
        appendFileSync(trace, JSON.stringify({ stage: 'fenced-sdk-resolution', id, importer, external: false }) + '\n');
        return { id: sdk, external: false };
      }
      rejectRealSdk(id);
      return null;
    },
    load(id) { rejectRealSdk(id); return null; },
    transform(_code, id) { rejectRealSdk(id); return null; },
  }],
  test: {
    ...base.test,
    include: [out + 'TASK-010-review2-B-counterexample-v5.test.ts'],
    setupFiles: [out + 'TASK-010-review2-B-counterexample-v5-deny-operations.setup.mjs'],
    // vite-node/server.mjs185-203 checks inline BEFORE externalization. Any accidentally
    // resolved real SDK path must reach the rejecting load/transform fence, never native import.
    server: { deps: { inline: [/\/@anthropic-ai\/claude-agent-sdk\//], inlineFiles: [sdk] } },
  },
});
