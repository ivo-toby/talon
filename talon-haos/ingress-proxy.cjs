'use strict';

// TCP gate in front of ttyd. Home Assistant ingress uses 172.30.32.2.
// Forward raw bytes, including WebSocket upgrades, without parsing requests.
const net = require('node:net');
const gateway = '172.30.32.2';
const listener = net.createServer((client) => {
  const peer = client.remoteAddress?.replace(/^::ffff:/, '');
  if (peer !== gateway) {
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
listener.listen(7681, '0.0.0.0');
