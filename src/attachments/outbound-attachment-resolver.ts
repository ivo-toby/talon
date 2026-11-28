/**
 * Resolves agent-supplied outbound attachment requests into validated,
 * in-memory {@link OutboundAttachment}s.
 *
 * This is the security boundary of outbound attachments: agents have a host
 * shell in several providers, so the host — never the agent — decides which
 * files may leave the machine. Each item must name an absolute path that
 * lies inside a configured allowed root both lexically and after symlink
 * resolution, does not match the denylist, and is a non-empty regular file
 * within the size cap whose sniffed MIME type is allowed. The file is opened
 * with `O_NOFOLLOW` and re-checked by inode, so a swap between check and read
 * is refused rather than followed.
 *
 * Any refused item fails the whole request; refusals name items by index and
 * basename only. No full host path appears in a refusal or a log line.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ok, err, type Result } from '../core/types/result.js';
import { INLINE_IMAGE_MIME_TYPES, extensionForMime, sniffMimeType } from './mime-sniff.js';
import type {
  OutboundAttachment,
  OutboundAttachmentErrorCode,
  OutboundAttachmentRefusal,
  OutboundAttachmentRequest,
  OutboundAttachmentSupport,
} from './outbound-attachment-types.js';

/** Effective policy for one resolution (global config narrowed by the connector). */
export interface OutboundAttachmentPolicy {
  /** Absolute directories files may be sent from. Empty disables the feature. */
  allowedRoots: readonly string[];
  /** Extra absolute path prefixes that are never sent (Talon's data dir, config file, …). */
  deniedPaths: readonly string[];
  /** Global per-file size cap in bytes. */
  maxBytes: number;
  /** Global maximum number of attachments per message. */
  maxPerMessage: number;
  /** Sniffed MIME types that may be sent. */
  allowedMimeTypes: readonly string[];
  /**
   * Allowed roots that `deniedPaths` does not apply to — the run's own
   * thread artifacts directory, which lives inside the otherwise denied data
   * directory. The built-in denylist still applies inside them.
   */
  exemptRoots?: readonly string[];
}

/** Path prefixes that are never sent, whatever the roots say. */
const BUILTIN_DENIED_PREFIXES: readonly string[] = [
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/boot',
  '/run',
];

/** Directory names that are never sent from, at any depth. */
const DENIED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.git',
  '.password-store',
  '.config/gcloud',
]);

/** File basenames (exact, lowercase) that are never sent. */
const DENIED_BASENAMES: ReadonlySet<string> = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'known_hosts',
  'authorized_keys',
]);

/** Basename patterns that are never sent. */
const DENIED_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env\./i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i,
];

/** Longest human-visible filename we pass to a channel. */
const MAX_FILENAME_LENGTH = 128;

/** Longest caption we pass on; connectors may cut further to their own limit. */
export const MAX_CAPTION_LENGTH = 1024;

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * True when the absolute path matches the built-in or configured denylist.
 * `extraDenied` prefixes do not apply inside `exemptRoots`; the built-in
 * prefixes, directory names and filename patterns always do.
 */
export function isDeniedPath(
  absolutePath: string,
  extraDenied: readonly string[] = [],
  exemptRoots: readonly string[] = [],
): boolean {
  for (const prefix of BUILTIN_DENIED_PREFIXES) {
    if (isWithin(resolve(prefix), absolutePath)) return true;
  }
  const exempt = exemptRoots.some((root) => isWithin(resolve(root), absolutePath));
  for (const prefix of exempt ? [] : extraDenied) {
    if (isWithin(resolve(prefix), absolutePath)) return true;
  }
  const segments = absolutePath.split(sep).filter((s) => s !== '');
  for (let i = 0; i < segments.length - 1; i++) {
    const name = segments[i];
    if (DENIED_DIRECTORY_NAMES.has(name)) return true;
    const pair = `${name}/${segments[i + 1]}`;
    if (DENIED_DIRECTORY_NAMES.has(pair)) return true;
  }
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  if (DENIED_BASENAMES.has(base)) return true;
  return DENIED_BASENAME_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Makes a filename safe to show a human: no path separators, control
 * characters or leading dots, bounded length. Falls back to a generated
 * `attachment-<n><ext>` when nothing usable remains.
 */
export function sanitizeFilename(raw: string, index: number, mimeType: string): string {
  const cleaned = basename(raw.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  if (cleaned === '') {
    return `attachment-${index + 1}${extensionForMime(mimeType)}`;
  }
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  const ext = extname(cleaned).slice(0, 16);
  return cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

function refusal(
  index: number,
  code: OutboundAttachmentErrorCode,
  message: string,
): OutboundAttachmentRefusal {
  return { index, code, message };
}

/** Basename of an agent-supplied path, for refusal messages only. */
function displayName(path: string): string {
  const name = basename(path);
  return name === '' ? '(unnamed)' : name.slice(0, MAX_FILENAME_LENGTH);
}

async function realRoots(
  roots: readonly string[],
): Promise<Array<{ lexical: string; real: string }>> {
  const resolved: Array<{ lexical: string; real: string }> = [];
  for (const root of roots) {
    const lexical = resolve(root);
    try {
      resolved.push({ lexical, real: await realpath(lexical) });
    } catch {
      // A missing root grants nothing; it is reported once at startup.
    }
  }
  return resolved;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * Validates and reads every requested attachment.
 *
 * @param requests - Items as the agent sent them (validated here, not trusted).
 * @param policy   - Global policy from config.
 * @param support  - The target connector's declared limits.
 * @returns All attachments, in request order, or every refusal found.
 */
export async function resolveOutboundAttachments(
  requests: unknown,
  policy: OutboundAttachmentPolicy,
  support: OutboundAttachmentSupport,
): Promise<Result<OutboundAttachment[], OutboundAttachmentRefusal[]>> {
  if (!Array.isArray(requests)) {
    return err([
      refusal(
        -1,
        'invalid_request',
        '`attachments` must be an array of { path, filename?, mimeType?, caption? }.',
      ),
    ]);
  }
  if (policy.allowedRoots.length === 0) {
    return err([
      refusal(
        -1,
        'attachments_disabled',
        'Outbound attachments are not enabled on this Talon (no attachments.outbound.allowedRoots configured). Describe the file or give its location instead.',
      ),
    ]);
  }
  const maxFiles = Math.min(policy.maxPerMessage, support.maxFiles);
  if (requests.length > maxFiles) {
    return err([
      refusal(
        -1,
        'too_many_files',
        `At most ${maxFiles} attachments can be sent in one message on this channel; got ${requests.length}.`,
      ),
    ]);
  }

  const roots = await realRoots(policy.allowedRoots);
  const exempt = await realRoots(policy.exemptRoots ?? []);
  const maxBytes = Math.min(policy.maxBytes, support.maxBytes);
  const allowedMime = new Set(policy.allowedMimeTypes.map((m) => m.toLowerCase()));
  const refusals: OutboundAttachmentRefusal[] = [];
  const resolved: OutboundAttachment[] = [];

  for (let index = 0; index < requests.length; index++) {
    const outcome = await resolveOne(
      requests[index],
      index,
      roots,
      exempt,
      policy,
      maxBytes,
      allowedMime,
    );
    if (outcome.isErr()) {
      refusals.push(outcome.error);
    } else {
      resolved.push(outcome.value);
    }
  }

  return refusals.length > 0 ? err(refusals) : ok(resolved);
}

async function resolveOne(
  raw: unknown,
  index: number,
  roots: ReadonlyArray<{ lexical: string; real: string }>,
  exempt: ReadonlyArray<{ lexical: string; real: string }>,
  policy: OutboundAttachmentPolicy,
  maxBytes: number,
  allowedMime: ReadonlySet<string>,
): Promise<Result<OutboundAttachment, OutboundAttachmentRefusal>> {
  if (typeof raw !== 'object' || raw === null) {
    return err(
      refusal(index, 'invalid_request', `Attachment ${index}: expected an object with a \`path\`.`),
    );
  }
  const request = raw as Partial<Record<keyof OutboundAttachmentRequest, unknown>>;
  if (typeof request.path !== 'string' || request.path.trim() === '') {
    return err(
      refusal(
        index,
        'invalid_request',
        `Attachment ${index}: \`path\` must be a non-empty string.`,
      ),
    );
  }
  for (const field of ['filename', 'mimeType', 'caption'] as const) {
    if (request[field] !== undefined && typeof request[field] !== 'string') {
      return err(
        refusal(index, 'invalid_request', `Attachment ${index}: \`${field}\` must be a string.`),
      );
    }
  }
  const path = request.path.trim();
  const name = displayName(path);
  const exemptLexical = exempt.flatMap((root) => [root.lexical, root.real]);
  const exemptReal = exempt.map((root) => root.real);
  if (!isAbsolute(path)) {
    return err(
      refusal(
        index,
        'path_not_absolute',
        `Attachment ${index} (${name}): the path must be absolute.`,
      ),
    );
  }

  // Lexical check first, before touching the filesystem, so a path outside
  // the roots reveals nothing about whether it exists.
  const lexical = resolve(path);
  if (!roots.some((root) => isWithin(root.lexical, lexical) || isWithin(root.real, lexical))) {
    return err(
      refusal(
        index,
        'outside_allowed_roots',
        `Attachment ${index} (${name}) is outside the directories Talon may send files from.`,
      ),
    );
  }
  if (isDeniedPath(lexical, policy.deniedPaths, exemptLexical)) {
    return err(
      refusal(
        index,
        'denied_path',
        `Attachment ${index} (${name}) is in a location Talon never sends files from.`,
      ),
    );
  }

  let real: string;
  try {
    real = await realpath(lexical);
  } catch (error) {
    return err(
      refusal(
        index,
        isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') ? 'not_found' : 'read_failed',
        `Attachment ${index} (${name}) does not exist or cannot be resolved.`,
      ),
    );
  }
  if (!roots.some((root) => isWithin(root.real, real))) {
    return err(
      refusal(
        index,
        'symlink_escape',
        `Attachment ${index} (${name}) is a link that points outside the allowed directories.`,
      ),
    );
  }
  if (isDeniedPath(real, policy.deniedPaths, exemptReal)) {
    return err(
      refusal(
        index,
        'denied_path',
        `Attachment ${index} (${name}) is in a location Talon never sends files from.`,
      ),
    );
  }

  let info;
  try {
    info = await stat(real);
  } catch {
    return err(refusal(index, 'not_found', `Attachment ${index} (${name}) does not exist.`));
  }
  if (info.isDirectory()) {
    return err(
      refusal(index, 'is_directory', `Attachment ${index} (${name}) is a directory, not a file.`),
    );
  }
  if (!info.isFile()) {
    return err(
      refusal(index, 'special_file', `Attachment ${index} (${name}) is not a regular file.`),
    );
  }
  if (info.size === 0) {
    return err(refusal(index, 'empty_file', `Attachment ${index} (${name}) is empty.`));
  }
  if (info.size > maxBytes) {
    return err(
      refusal(
        index,
        'too_large',
        `Attachment ${index} (${name}) is ${info.size} bytes; the limit on this channel is ${maxBytes} bytes.`,
      ),
    );
  }

  const data = await readExactly(real, info.dev, info.ino, info.size);
  if (data === null) {
    return err(
      refusal(
        index,
        'read_failed',
        `Attachment ${index} (${name}) changed or could not be read; nothing was sent.`,
      ),
    );
  }

  const mimeType = sniffMimeType(
    data,
    typeof request.filename === 'string' ? request.filename : path,
    request.mimeType as string | undefined,
  );
  if (!allowedMime.has(mimeType)) {
    return err(
      refusal(
        index,
        'mime_not_allowed',
        `Attachment ${index} (${name}) is ${mimeType}, which is not an allowed attachment type.`,
      ),
    );
  }

  const filename = sanitizeFilename(
    typeof request.filename === 'string' && request.filename.trim() !== ''
      ? request.filename
      : path,
    index,
    mimeType,
  );
  const caption =
    typeof request.caption === 'string' ? request.caption.trim().slice(0, MAX_CAPTION_LENGTH) : '';

  return ok({
    filename,
    mimeType,
    kind: INLINE_IMAGE_MIME_TYPES.has(mimeType) ? 'image' : 'file',
    data,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    ...(caption !== '' ? { caption } : {}),
  });
}

/**
 * Reads a file that was just validated, refusing to follow a symlink swapped
 * in since, a different inode, a non-regular file, or a changed size.
 * `O_NONBLOCK` keeps a FIFO swapped in from hanging the open.
 */
async function readExactly(
  path: string,
  dev: number,
  ino: number,
  size: number,
): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== dev || opened.ino !== ino || opened.size !== size) {
      return null;
    }
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
