/**
 * Unit tests for outbound attachment path safety, limits and MIME checks.
 *
 * Runs against a real temporary directory so realpath, symlink, directory
 * and special-file behaviour is the operating system's, not a mock's.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDeniedPath,
  resolveOutboundAttachments,
  sanitizeFilename,
  type OutboundAttachmentPolicy,
} from '../../../src/attachments/outbound-attachment-resolver.js';
import type {
  OutboundAttachmentErrorCode,
  OutboundAttachmentRefusal,
  OutboundAttachmentSupport,
} from '../../../src/attachments/outbound-attachment-types.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);
const SUPPORT: OutboundAttachmentSupport = { maxBytes: 1_000_000, maxFiles: 10 };

let base: string;
let root: string;
let outside: string;

function policy(overrides: Partial<OutboundAttachmentPolicy> = {}): OutboundAttachmentPolicy {
  return {
    allowedRoots: [root],
    deniedPaths: [],
    maxBytes: 1_000_000,
    maxPerMessage: 5,
    allowedMimeTypes: ['image/png', 'text/plain', 'text/csv', 'application/pdf'],
    ...overrides,
  };
}

async function refusalCodes(
  requests: unknown,
  p: OutboundAttachmentPolicy = policy(),
  support: OutboundAttachmentSupport = SUPPORT,
): Promise<OutboundAttachmentErrorCode[]> {
  const result = await resolveOutboundAttachments(requests, p, support);
  expect(result.isErr()).toBe(true);
  return result.isErr() ? result.error.map((r) => r.code) : [];
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'talon-attach-')));
  root = join(base, 'artifacts');
  outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveOutboundAttachments', () => {
  it('reads a PNG inside an allowed root and types it from its bytes', async () => {
    writeFileSync(join(root, 'shot.data'), PNG);
    const result = await resolveOutboundAttachments(
      [{ path: join(root, 'shot.data'), caption: ' Look ', filename: 'screen.png' }],
      policy(),
      SUPPORT,
    );
    expect(result.isOk()).toBe(true);
    const [attachment] = result._unsafeUnwrap();
    expect(attachment).toMatchObject({
      filename: 'screen.png',
      mimeType: 'image/png',
      kind: 'image',
      size: PNG.length,
      caption: 'Look',
    });
    expect(attachment!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attachment!.data.equals(PNG)).toBe(true);
  });

  it('refuses each unsafe or invalid item with a distinct code before reading', async () => {
    writeFileSync(join(outside, 'secret.png'), PNG);
    symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'));
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'empty.txt'), '');
    writeFileSync(join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(2_000)]));
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));

    const cases: Array<[unknown, OutboundAttachmentErrorCode]> = [
      [{ path: join(outside, 'secret.png') }, 'outside_allowed_roots'],
      [{ path: `${root}/../outside/secret.png` }, 'outside_allowed_roots'],
      [{ path: join(root, 'link.png') }, 'symlink_escape'],
      [{ path: join(root, 'dir') }, 'is_directory'],
      [{ path: join(root, 'missing.png') }, 'not_found'],
      [{ path: join(root, 'empty.txt') }, 'empty_file'],
      [{ path: join(root, 'blob.bin') }, 'mime_not_allowed'],
      [{ path: 'artifacts/shot.png' }, 'path_not_absolute'],
      [{ path: 42 }, 'invalid_request'],
    ];
    for (const [request, code] of cases) {
      expect(await refusalCodes([request])).toEqual([code]);
    }
    expect(
      await refusalCodes([{ path: join(root, 'big.png') }], policy(), {
        maxBytes: 1_000,
        maxFiles: 10,
      }),
    ).toEqual(['too_large']);
    expect(
      await refusalCodes([{ path: join(root, 'big.png') }], policy({ maxBytes: 1_000 })),
    ).toEqual(['too_large']);
  });

  it('refuses a FIFO as a special file without blocking', async () => {
    const fifo = join(root, 'pipe');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // mkfifo unavailable on this platform
    }
    expect(await refusalCodes([{ path: fifo }])).toEqual(['special_file']);
  });

  it('refuses denied locations even inside an allowed root', async () => {
    mkdirSync(join(root, '.ssh'));
    writeFileSync(join(root, '.ssh', 'notes.txt'), 'x');
    writeFileSync(join(root, '.env'), 'TOKEN=1');
    writeFileSync(join(root, 'server.pem'), 'x');
    for (const path of [
      join(root, '.ssh', 'notes.txt'),
      join(root, '.env'),
      join(root, 'server.pem'),
    ]) {
      expect(await refusalCodes([{ path }])).toEqual(['denied_path']);
    }
    writeFileSync(join(root, 'ok.txt'), 'hello');
    expect(
      await refusalCodes([{ path: join(root, 'ok.txt') }], policy({ deniedPaths: [root] })),
    ).toEqual(['denied_path']);
  });

  it('lets an exempt root through configured deniedPaths but not the built-in list', async () => {
    writeFileSync(join(root, 'ok.txt'), 'hello');
    writeFileSync(join(root, '.env'), 'TOKEN=1');
    const p = policy({ deniedPaths: [base], exemptRoots: [root] });
    expect(
      (await resolveOutboundAttachments([{ path: join(root, 'ok.txt') }], p, SUPPORT)).isOk(),
    ).toBe(true);
    expect(await refusalCodes([{ path: join(root, '.env') }], p)).toEqual(['denied_path']);
  });

  it('refuses the whole call when attachments are disabled or too many are asked for', async () => {
    writeFileSync(join(root, 'a.txt'), 'a');
    const one = { path: join(root, 'a.txt') };
    expect(await refusalCodes([one], policy({ allowedRoots: [] }))).toEqual([
      'attachments_disabled',
    ]);
    expect(await refusalCodes([one, one, one], policy({ maxPerMessage: 2 }))).toEqual([
      'too_many_files',
    ]);
    expect(await refusalCodes([one, one, one], policy(), { maxBytes: 100, maxFiles: 2 })).toEqual([
      'too_many_files',
    ]);
    expect(await refusalCodes('not-an-array')).toEqual(['invalid_request']);
  });

  it('reports every refused item and never echoes a full host path', async () => {
    writeFileSync(join(root, 'ok.txt'), 'hello');
    const result = await resolveOutboundAttachments(
      [
        { path: join(root, 'ok.txt') },
        { path: join(outside, 'x.png') },
        { path: join(root, 'nope.png') },
      ],
      policy(),
      SUPPORT,
    );
    const refusals: OutboundAttachmentRefusal[] = result._unsafeUnwrapErr();
    expect(refusals.map((r) => [r.index, r.code])).toEqual([
      [1, 'outside_allowed_roots'],
      [2, 'not_found'],
    ]);
    for (const r of refusals) {
      expect(r.message).not.toContain(base);
    }
  });

  it('follows a symlink that stays inside the root, and a root that is itself a link', async () => {
    writeFileSync(join(root, 'real.csv'), 'a,b\n1,2\n');
    symlinkSync(join(root, 'real.csv'), join(root, 'alias.csv'));
    symlinkSync(root, join(base, 'root-link'));
    const result = await resolveOutboundAttachments(
      [{ path: join(root, 'alias.csv') }, { path: join(base, 'root-link', 'real.csv') }],
      policy({ allowedRoots: [join(base, 'root-link')] }),
      SUPPORT,
    );
    expect(result._unsafeUnwrap().map((a) => a.mimeType)).toEqual(['text/csv', 'text/csv']);
  });
});

describe('isDeniedPath', () => {
  it('denies system prefixes, key files and credential directories', () => {
    expect(isDeniedPath('/etc/passwd')).toBe(true);
    expect(isDeniedPath('/proc/self/environ')).toBe(true);
    expect(isDeniedPath('/home/u/.aws/config')).toBe(true);
    expect(isDeniedPath('/home/u/project/.git/config')).toBe(true);
    expect(isDeniedPath('/home/u/.ssh/id_ed25519')).toBe(true);
    expect(isDeniedPath('/srv/out/id_rsa.pub')).toBe(true);
    expect(isDeniedPath('/srv/out/.env.production')).toBe(true);
    expect(isDeniedPath('/srv/out/report.pdf')).toBe(false);
    expect(isDeniedPath('/srv/etcetera/report.pdf')).toBe(false);
  });
});

describe('sanitizeFilename', () => {
  it('strips paths, control characters and leading dots', () => {
    expect(sanitizeFilename('/tmp/../a/b/report.pdf', 0, 'application/pdf')).toBe('report.pdf');
    expect(sanitizeFilename('..\\..\\evil.png', 0, 'image/png')).toBe('evil.png');
    expect(sanitizeFilename('.hidden\u0007.txt', 0, 'text/plain')).toBe('hidden.txt');
    expect(sanitizeFilename('...', 2, 'image/png')).toBe('attachment-3.png');
    const long = `${'x'.repeat(300)}.png`;
    const cut = sanitizeFilename(long, 0, 'image/png');
    expect(cut.length).toBe(128);
    expect(cut.endsWith('.png')).toBe(true);
  });
});
