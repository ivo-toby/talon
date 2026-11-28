'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { normalizePeer, trustedIngressPeers, createIngressProxy } = require('./ingress-proxy.cjs');

test('only configured ingress gateway addresses are trusted', () => {
  assert.deepEqual([...trustedIngressPeers('172.30.32.2, 10.10.10.1')], ['172.30.32.2', '10.10.10.1']);
  assert.deepEqual([...trustedIngressPeers('')], ['172.30.32.2']);
  assert.throws(() => trustedIngressPeers('172.30.0.0/16'), /valid comma-separated/);
  assert.equal(normalizePeer('::ffff:172.30.32.2'), '172.30.32.2');
});

test('untrusted TCP connections are rejected before reaching ttyd', async () => {
  const rejected = [];
  const server = createIngressProxy({ peers: new Set(['192.0.2.9']), log: { warn: message => rejected.push(message) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise(resolve => {
      const connection = net.connect(server.address().port, '127.0.0.1');
      connection.on('error', resolve);
      connection.on('close', resolve);
      connection.on('connect', () => connection.write('GET / HTTP/1.1\r\n\r\n'));
    });
    assert.match(rejected.join('\n'), /rejected connection from 127\.0\.0\.1/);
  } finally {
    server.close();
  }
});
