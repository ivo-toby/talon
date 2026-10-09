import { createServer } from 'node:http';
import { getDefaultResultOrder, setDefaultResultOrder } from 'node:dns';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadAllowedAttachment } from '../../../../src/tools/host-tools/attachment-download.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serverUrl(handler: Parameters<typeof createServer>[0]): Promise<URL> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return new URL(`http://127.0.0.1:${address.port}/file`);
}

describe('pinned attachment network transport', () => {
  it('rejects loopback addresses before making a request by default', async () => {
    await expect(downloadAllowedAttachment(new URL('http://127.0.0.1:9/file'), 1024, 1000))
      .rejects.toThrow('non-public address');
  });

  it('can reach a specifically allowed private origin', async () => {
    const url = await serverUrl((_req, res) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.end('sample');
    });
    const result = await downloadAllowedAttachment(url, 1024, 1000, true);
    expect(result.data.toString()).toBe('sample');
    expect(result.contentType).toBe('application/pdf');
  });

  it('downloads from a hostname when Node requests all DNS results', async () => {
    const url = await serverUrl((_req, res) => res.end('hostname-ok'));
    url.hostname = 'localhost';
    const previousOrder = getDefaultResultOrder();
    setDefaultResultOrder('ipv4first');
    try {
      const result = await downloadAllowedAttachment(url, 1024, 1000, true);
      expect(result.data.toString()).toBe('hostname-ok');
    } finally {
      setDefaultResultOrder(previousOrder);
    }
  });

  it('refuses redirects without accessing the destination', async () => {
    const url = await serverUrl((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/secret' });
      res.end();
    });
    await expect(downloadAllowedAttachment(url, 1024, 1000, true))
      .rejects.toThrow('redirects are not allowed');
  });

  it('rejects responses exceeding the cap without a Content-Length', async () => {
    const url = await serverUrl((_req, res) => {
      res.write('abc');
      res.end('defgh');
    });
    await expect(downloadAllowedAttachment(url, 5, 1000, true))
      .rejects.toThrow('byte limit');
  });
});
