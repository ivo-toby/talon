/**
 * Durable browservoice login authority.
 *
 * Session and CSRF values are supplied as one-way hashes by the auth layer.
 * The configured access token is bound through a salted native scrypt verifier
 * and is never written to SQLite.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import { BaseRepository } from './base-repository.js';

const CREDENTIAL_SALT_BYTES = 16;
const CREDENTIAL_KEY_BYTES = 32;
const CREDENTIAL_SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

export interface VoiceAuthBindingRow {
  id: 1;
  owner_id: string;
  credential_salt: string;
  credential_verifier: string;
  binding_revision: number;
  created_at: number;
  updated_at: number;
}

export interface VoiceAuthSessionRow {
  id: string;
  session_token_hash: string;
  csrf_token_hash: string;
  owner_id: string;
  login_revision: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface VoiceAuthSessionInsert {
  readonly id: string;
  readonly sessionTokenHash: string;
  readonly csrfTokenHash: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface VoiceAuthBindingResult {
  readonly ownerId: string;
  readonly bindingRevision: number;
  readonly changed: boolean;
}

/** Repository for browservoice login grants and their credential binding. */
export class VoiceAuthRepository extends BaseRepository {
  public get database(): Database.Database {
    return this.db;
  }

  /**
   * Create or atomically rotate the configured credential/owner binding.
   * Rotation revokes all extant grants while leaving the revision allocator
   * untouched, so a token changing back cannot revive an old grant.
   */
  bindCredential(
    ownerId: string,
    accessToken: string,
    now = Date.now(),
  ): Result<VoiceAuthBindingResult, DbError> {
    try {
      if (ownerId.length === 0 || accessToken.length === 0) {
        return err(new DbError('Failed to bind voice authentication credential'));
      }
      const result = this.runTransaction(() => {
        const existing = this.db.prepare('SELECT * FROM voice_auth_binding WHERE id = 1').get() as
          | VoiceAuthBindingRow
          | undefined;
        if (
          existing &&
          existing.owner_id === ownerId &&
          verifyScrypt(accessToken, existing.credential_salt, existing.credential_verifier)
        ) {
          return {
            ownerId,
            bindingRevision: existing.binding_revision,
            changed: false,
          } satisfies VoiceAuthBindingResult;
        }

        const salt = randomBytes(CREDENTIAL_SALT_BYTES).toString('base64url');
        const verifier = deriveCredentialVerifier(accessToken, salt);
        const bindingRevision = existing ? existing.binding_revision + 1 : 1;
        if (existing) {
          this.db
            .prepare(
              `UPDATE voice_auth_binding
                SET owner_id = ?, credential_salt = ?, credential_verifier = ?,
                    binding_revision = ?, updated_at = ?
              WHERE id = 1`,
            )
            .run(ownerId, salt, verifier, bindingRevision, now);
          this.db
            .prepare(
              `UPDATE voice_auth_sessions
                  SET revoked_at = ?
                WHERE revoked_at IS NULL`,
            )
            .run(now);
        } else {
          this.db
            .prepare(
              `INSERT INTO voice_auth_binding
                 (id, owner_id, credential_salt, credential_verifier,
                  binding_revision, created_at, updated_at)
               VALUES (1, ?, ?, ?, ?, ?, ?)`,
            )
            .run(ownerId, salt, verifier, bindingRevision, now, now);
        }
        return { ownerId, bindingRevision, changed: true } satisfies VoiceAuthBindingResult;
      });
      return ok(result);
    } catch (cause) {
      return err(this.dbError('bind voice authentication credential', cause));
    }
  }

  /** Verify a login token against the current owner-bound credential. */
  verifyCredential(ownerId: string, accessToken: string): Result<boolean, DbError> {
    try {
      const binding = this.db.prepare('SELECT * FROM voice_auth_binding WHERE id = 1').get() as
        | VoiceAuthBindingRow
        | undefined;
      if (!binding || binding.owner_id !== ownerId) return ok(false);
      return ok(verifyScrypt(accessToken, binding.credential_salt, binding.credential_verifier));
    } catch (cause) {
      return err(this.dbError('verify voice authentication credential', cause));
    }
  }

  /** Remove expired grants before enforcing the bounded active-session cap. */
  pruneExpired(now: number): Result<number, DbError> {
    try {
      const result = this.db
        .prepare(
          `DELETE FROM voice_auth_sessions
            WHERE expires_at <= ?`,
        )
        .run(now);
      return ok(result.changes);
    } catch (cause) {
      return err(this.dbError('prune expired voice authentication sessions', cause));
    }
  }

  countActive(now: number): Result<number, DbError> {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM voice_auth_sessions
            WHERE revoked_at IS NULL AND expires_at > ?`,
        )
        .get(now) as { count: number };
      return ok(row.count);
    } catch (cause) {
      return err(this.dbError('count active voice authentication sessions', cause));
    }
  }

  /** Insert a grant and allocate its revision without reusing a prior value. */
  createSession(input: VoiceAuthSessionInsert): Result<VoiceAuthSessionRow, DbError> {
    try {
      const row = this.runTransaction(() => {
        let allocator = this.db
          .prepare('SELECT next_revision FROM voice_auth_revision_allocator WHERE id = 1')
          .get() as { next_revision: number } | undefined;
        const historical = this.db
          .prepare('SELECT COALESCE(MAX(login_revision), 0) AS max_revision FROM voice_sessions')
          .get() as { max_revision: number };
        const minimumNext = historical.max_revision + 1;
        if (!allocator) {
          this.db
            .prepare(
              `INSERT INTO voice_auth_revision_allocator (id, next_revision)
               VALUES (1, ?)`,
            )
            .run(minimumNext);
          allocator = { next_revision: minimumNext };
        }
        const loginRevision = Math.max(allocator.next_revision, minimumNext);
        this.db
          .prepare(
            `UPDATE voice_auth_revision_allocator
                SET next_revision = ?
              WHERE id = 1`,
          )
          .run(loginRevision + 1);
        const persisted: VoiceAuthSessionRow = {
          id: input.id,
          session_token_hash: input.sessionTokenHash,
          csrf_token_hash: input.csrfTokenHash,
          owner_id: input.ownerId,
          login_revision: loginRevision,
          created_at: input.createdAt,
          expires_at: input.expiresAt,
          revoked_at: null,
        };
        this.db
          .prepare(
            `INSERT INTO voice_auth_sessions
               (id, session_token_hash, csrf_token_hash, owner_id,
                login_revision, created_at, expires_at, revoked_at)
             VALUES (@id, @session_token_hash, @csrf_token_hash, @owner_id,
                     @login_revision, @created_at, @expires_at, @revoked_at)`,
          )
          .run(persisted);
        return persisted;
      });
      return ok(row);
    } catch (cause) {
      return err(this.dbError('create voice authentication session', cause));
    }
  }

  findActiveByTokenHash(
    sessionTokenHash: string,
    now: number,
  ): Result<VoiceAuthSessionRow | null, DbError> {
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM voice_auth_sessions
            WHERE session_token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(sessionTokenHash, now) as VoiceAuthSessionRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.dbError('find voice authentication session', cause));
    }
  }

  findActiveByOwnerRevision(
    ownerId: string,
    loginRevision: number,
    now: number,
  ): Result<VoiceAuthSessionRow | null, DbError> {
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM voice_auth_sessions
            WHERE owner_id = ? AND login_revision = ?
              AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(ownerId, loginRevision, now) as VoiceAuthSessionRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(this.dbError('find voice authentication owner session', cause));
    }
  }

  listActive(now: number, ownerId?: string): Result<VoiceAuthSessionRow[], DbError> {
    try {
      const ownerClause = ownerId === undefined ? '' : ' AND owner_id = ?';
      const params = ownerId === undefined ? [now] : [now, ownerId];
      const rows = this.db
        .prepare(
          `SELECT * FROM voice_auth_sessions
            WHERE revoked_at IS NULL AND expires_at > ?${ownerClause}
            ORDER BY login_revision ASC`,
        )
        .all(...params) as VoiceAuthSessionRow[];
      return ok(rows);
    } catch (cause) {
      return err(this.dbError('list active voice authentication sessions', cause));
    }
  }

  /** Verify both double-submit values against the same active session row. */
  verifyCsrf(
    sessionId: string,
    ownerId: string,
    loginRevision: number,
    csrfCookieHash: string,
    csrfHeaderHash: string,
    now: number,
  ): Result<boolean, DbError> {
    try {
      const row = this.db
        .prepare(
          `SELECT csrf_token_hash FROM voice_auth_sessions
            WHERE id = ? AND owner_id = ? AND login_revision = ?
              AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(sessionId, ownerId, loginRevision, now) as { csrf_token_hash: string } | undefined;
      if (!row) return ok(false);
      return ok(
        constantTimeTextEquals(row.csrf_token_hash, csrfCookieHash) &&
          constantTimeTextEquals(row.csrf_token_hash, csrfHeaderHash),
      );
    } catch (cause) {
      return err(this.dbError('verify voice authentication csrf token', cause));
    }
  }

  revokeSession(sessionId: string, now: number): Result<void, DbError> {
    try {
      this.db
        .prepare(
          `UPDATE voice_auth_sessions
              SET revoked_at = ?
            WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(now, sessionId);
      return ok(undefined);
    } catch (cause) {
      return err(this.dbError('revoke voice authentication session', cause));
    }
  }

  revokeAll(now: number): Result<number, DbError> {
    try {
      const result = this.db
        .prepare(
          `UPDATE voice_auth_sessions
              SET revoked_at = ?
            WHERE revoked_at IS NULL`,
        )
        .run(now);
      return ok(result.changes);
    } catch (cause) {
      return err(this.dbError('revoke browser voice authentication sessions', cause));
    }
  }

  private runTransaction<T>(operation: () => T): T {
    const database = this.db as Database.Database & {
      transaction?: <Value>(fn: () => Value) => () => Value;
    };
    if (typeof database.transaction === 'function') return database.transaction(operation)();
    return operation();
  }

  private dbError(operation: string, cause: unknown): DbError {
    return new DbError(`Failed to ${operation}`, cause instanceof Error ? cause : undefined);
  }
}

/** Hash a transient cookie/header value for durable lookup. */
export function hashVoiceAuthToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** Derive the stored native scrypt verifier for a configured access token. */
export function deriveCredentialVerifier(accessToken: string, salt: string): string {
  return scryptSync(accessToken, salt, CREDENTIAL_KEY_BYTES, CREDENTIAL_SCRYPT_OPTIONS).toString(
    'base64url',
  );
}

function verifyScrypt(accessToken: string, salt: string, expected: string): boolean {
  try {
    const actual = Buffer.from(deriveCredentialVerifier(accessToken, salt), 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
  } catch {
    return false;
  }
}

function constantTimeTextEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
