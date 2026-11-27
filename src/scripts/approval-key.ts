/**
 * The secret key of the approval-code hash.
 *
 * The key lives in the file `script-approval.key` next to the SQLite database
 * file. It never goes into the database, a log line, an audit entry or an error.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { ScriptError } from './types.js';

export const APPROVAL_KEY_FILE = 'script-approval.key';
const KEY_BYTES = 32;

const failed = (cause?: unknown): ScriptError =>
  new ScriptError(
    'SANDBOX',
    'the approval key could not be read',
    cause instanceof Error ? cause : undefined,
  );

/** Directory that holds the key file, or undefined for an in-memory or temporary database. */
export function approvalKeyDir(dbPath: string): string | undefined {
  if (dbPath === '' || dbPath === ':memory:') return undefined;
  return dirname(dbPath);
}

/**
 * Loads the key, or creates it (32 random bytes, mode 0600, never replaced).
 * An in-memory or temporary database gets a random key for this process only.
 */
export function loadApprovalKey(dbPath: string): Result<Buffer, ScriptError> {
  const dir = approvalKeyDir(dbPath);
  if (dir === undefined) return ok(randomBytes(KEY_BYTES));
  const file = join(dir, APPROVAL_KEY_FILE);
  try {
    let fd: number;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') return err(failed(cause));
      return readKey(file);
    }
    try {
      const key = randomBytes(KEY_BYTES);
      writeSync(fd, key);
      return ok(key);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    return err(failed(cause));
  }
}

function readKey(file: string): Result<Buffer, ScriptError> {
  const fd = openSync(file, 'r');
  try {
    if (!fstatSync(fd).isFile()) return err(failed());
  } finally {
    closeSync(fd);
  }
  const key = readFileSync(file);
  return key.length === KEY_BYTES ? ok(key) : err(failed());
}
