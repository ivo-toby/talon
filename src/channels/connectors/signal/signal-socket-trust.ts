import fs from 'node:fs';
import { posix } from 'node:path';
import { SignalDeliveryError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';

export interface SignalSocketPathEntry {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
}

/** Captures every ancestor, not just the final socket, for the post-connect check. */
export interface SignalSocketTrustSnapshot {
  readonly entries: readonly SignalSocketPathEntry[];
}

function trustError(missing = false): SignalDeliveryError {
  return new SignalDeliveryError({
    reason: missing ? 'DISCONNECTED' : 'UNTRUSTED_SOCKET',
    outcome: 'NOT_SENT',
    acceptedChunks: 0,
    currentChunkAcceptance: 'unwritten',
    successCount: 0,
    failureCount: 0,
    retryScope: missing ? 'delivery_only' : 'none',
  });
}

/** Read-only: never repair, resolve symlinks, create, or remove operator paths.
 * Same-UID processes/root remain trusted; this is not a portable peer-credential check.
 */
export function validateSignalSocket(
  socketPath: string,
  previous?: SignalSocketTrustSnapshot,
): Result<SignalSocketTrustSnapshot, SignalDeliveryError> {
  if (
    !process.geteuid ||
    !posix.isAbsolute(socketPath) ||
    socketPath.includes('\0') ||
    socketPath !== posix.normalize(socketPath) ||
    socketPath.split('/').some((part) => part === '.' || part === '..') ||
    socketPath === '/'
  ) {
    return err(trustError());
  }
  const uid = BigInt(process.geteuid());
  const parts = socketPath.slice(1).split('/');
  const paths = ['/', ...parts.map((_part, index) => `/${parts.slice(0, index + 1).join('/')}`)];
  const entries: SignalSocketPathEntry[] = [];
  for (const [index, path] of paths.entries()) {
    const isSocket = index === paths.length - 1;
    const isParent = index === paths.length - 2;
    try {
      const stats = fs.lstatSync(path, { bigint: true });
      const mode = stats.mode & 0o7777n;
      const valid =
        !stats.isSymbolicLink() &&
        (isSocket
          ? stats.isSocket() && stats.uid === uid && mode === 0o600n
          : stats.isDirectory() &&
            (isParent
              ? stats.uid === uid && mode === 0o700n
              : (stats.uid === uid || stats.uid === 0n) && (mode & 0o022n) === 0n));
      if (!valid) return err(trustError());
      const entry = Object.freeze({
        path,
        device: stats.dev,
        inode: stats.ino,
        uid: stats.uid,
        mode: stats.mode,
      });
      const before = previous?.entries[index];
      if (
        previous &&
        (!before ||
          before.path !== path ||
          before.device !== entry.device ||
          before.inode !== entry.inode ||
          before.uid !== entry.uid ||
          before.mode !== entry.mode)
      ) {
        return err(trustError());
      }
      entries.push(entry);
    } catch (error) {
      const missing =
        !previous &&
        isSocket &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT';
      return err(trustError(missing));
    }
  }
  if (previous && previous.entries.length !== entries.length) return err(trustError());
  return ok(Object.freeze({ entries: Object.freeze(entries) }));
}
