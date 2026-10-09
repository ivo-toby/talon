import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/** Reject non-public addresses even when DNS points at them. */
const blocked = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) blocked.addSubnet(subnet, prefix, 'ipv6');

function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (family === 6 && !address.toLowerCase().startsWith('2') &&
      !address.toLowerCase().startsWith('3')) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Resolve all addresses, fail closed if any is private, and pin the chosen
 * address in the request's lookup callback. The URL hostname remains intact
 * for HTTPS SNI and certificate verification.
 */
export async function downloadAllowedAttachment(
  url: URL,
  maxBytes: number,
  timeoutMs: number,
  allowPrivate = false,
): Promise<{ data: Buffer; contentType: string | undefined }> {
  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('attachment hostname did not resolve');
  if (!allowPrivate && addresses.some(({ address, family }) =>
    !isPublicAddress(address, family as 4 | 6))) {
    throw new Error('attachment hostname resolves to a non-public address');
  }
  const pinned = addresses[0];
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const req = transport(url, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { accept: '*/*' },
      lookup: (_hostname, options, cb) => {
        if (options.all) {
          cb(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          cb(null, pinned.address, pinned.family);
        }
      },
    }, (res) => {
      void (async () => {
      try {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          throw new Error('attachment redirects are not allowed');
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          throw new Error(`attachment download returned HTTP ${status}`);
        }
        const headerLength = Number(res.headers['content-length'] ?? '0');
        if (Number.isFinite(headerLength) && headerLength > maxBytes) {
          res.destroy();
          throw new Error(`attachment exceeds ${maxBytes} byte limit`);
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const part of res) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            throw new Error(`attachment exceeds ${maxBytes} byte limit`);
          }
          chunks.push(Uint8Array.from(chunk));
        }
        const contentType = res.headers['content-type'];
        resolve({ data: Buffer.concat(chunks, total), contentType: typeof contentType === 'string' ? contentType : undefined });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      })();
    });
    req.on('timeout', () => req.destroy(new Error('attachment download timed out')));
    req.on('error', reject);
    req.end();
  });
}
