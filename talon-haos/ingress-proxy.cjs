'use strict';

// Raw TCP bridge for Home Assistant ingress -> loopback-only ttyd.
// Do not trust the entire Docker subnet: that would let other add-ons bypass
// Home Assistant's authenticated ingress and reach an interactive shell.
const net = require('node:net');
const { isIP } = net;

function trustedIngressPeers(value = process.env.TALON_INGRESS_GATEWAYS) {
  const peers = (value || '172.30.32.2').split(',').map(s => s.trim()).filter(Boolean);
  if (!peers.length || peers.some(peer => isIP(peer) === 0)) {
    throw new Error('TALON_INGRESS_GATEWAYS must contain valid comma-separated IP addresses');
  }
  return new Set(peers);
}

function normalizePeer(address) {
  return (address || '').replace(/^::ffff:/, '');
}

function createIngressProxy({ peers = trustedIngressPeers(), log = console } = {}) {
  return net.createServer(client => {
    const peer = normalizePeer(client.remoteAddress);
    if (!peers.has(peer)) {
      log.warn('[talon] ingress: rejected connection from ' + (peer || 'unknown'));
      client.destroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: 7682 });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
}

if (require.main === module) {
  const peers = trustedIngressPeers();
  const listener = createIngressProxy({ peers });
  listener.on('error', error => {
    console.error('[talon] ingress: failed to start: ' + error.message);
    process.exitCode = 1;
  });
  listener.listen(7681, '0.0.0.0', () => {
    console.info('[talon] ingress: listening on 7681; trusted gateway(s): ' + [...peers].join(', '));
  });
}

module.exports = { normalizePeer, trustedIngressPeers, createIngressProxy };
