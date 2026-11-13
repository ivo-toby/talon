// Worker-local fail-closed supplement; NEVER forwards a denied operation.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const trace = '/home/ivo/workspace/talon.feat-signal/.wdd/dispatch/pi-validation/TASK-010-review2-B-counterexample-v5-trace.jsonl';
const deny = boundary => function () {
  appendFileSync(trace, JSON.stringify({ process: process.pid, stage: 'operation-denied-before-original', boundary }) + '\n');
  throw new Error('Diagnostic prohibited operation: ' + boundary);
};
const child = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[name] = deny('child_process.' + name);
const net = require('node:net');
net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
net.Socket.prototype.connect = deny('Socket.prototype.connect');
const tls = require('node:tls'); tls.connect = deny('tls.connect');
for (const name of ['node:http', 'node:https']) {
  const module = require(name); module.request = deny(name + '.request'); module.get = deny(name + '.get');
}
const dgram = require('node:dgram'); dgram.createSocket = deny('dgram.createSocket');
globalThis.fetch = deny('global.fetch');
if ('WebSocket' in globalThis) globalThis.WebSocket = deny('global.WebSocket');
syncBuiltinESMExports();
appendFileSync(trace, JSON.stringify({ process: process.pid, stage: 'deny-original-guards-installed' }) + '\n');
