/**
 * Approval codes for stored scripts.
 *
 * A code is a secret between Talon and the user. Only its SHA-256 is stored.
 * The code appears in no log line, no error and no return value except the
 * one return of `request`.
 */

import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { ok, err, type Result } from 'neverthrow';
import type { ScriptRepository } from '../core/database/repositories/script-repository.js';
import type { Logger } from 'pino';
import { createLogger } from '../core/logging/index.js';
import { ScriptError } from './types.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_REFUSALS = 5;
const WINDOW_MS = 10 * 60_000;
const MAX_KEYS = 1000;
const COMMAND_RE = /^\/(approve|reject)[ \t]+([A-Za-z0-9]{8})$/;

export interface ApprovalService {
  /** Version must be 'tested' (or 'awaiting-approval'). Returns the code one time. */
  request(input: {
    versionId: string;
    channelName: string;
    externalThreadId: string;
  }): Result<{ code: string }, ScriptError>;
  decide(input: {
    code: string;
    decision: 'approved' | 'rejected';
    channelName: string;
    externalThreadId: string;
  }): Result<
    { outcome: 'approved' | 'rejected' | 'refused'; scriptName?: string; version?: number },
    ScriptError
  >;
  parseCommand(text: string): { decision: 'approved' | 'rejected'; code: string } | undefined;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase()).digest('hex');
}

function scriptNameOf(manifest: string): string | undefined {
  try {
    const parsed = JSON.parse(manifest) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export function createApprovalService(options: {
  repo: ScriptRepository;
  ttlMinutes: number;
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
  logger?: Logger;
}): ApprovalService {
  const { repo, ttlMinutes } = options;
  const now = options.now ?? ((): number => Date.now());
  const randomBytes = options.randomBytes ?? ((n: number): Buffer => cryptoRandomBytes(n));
  const logger = options.logger ?? createLogger({ level: 'info', pretty: false });

  /** key -> timestamps of the most recent refusals (at most MAX_REFUSALS). */
  const refusals = new Map<string, number[]>();

  function blocked(key: string, at: number): boolean {
    const list = refusals.get(key);
    if (!list || list.length < MAX_REFUSALS) {
      return false;
    }
    return at - list[list.length - 1] < WINDOW_MS;
  }

  function recordRefusal(key: string, at: number): void {
    const recent = (refusals.get(key) ?? []).filter((t) => at - t < WINDOW_MS);
    recent.push(at);
    refusals.delete(key);
    if (refusals.size >= MAX_KEYS) {
      const oldest = refusals.keys().next().value;
      if (oldest !== undefined) {
        refusals.delete(oldest);
      }
    }
    refusals.set(key, recent.slice(-MAX_REFUSALS));
  }

  function generateCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += ALPHABET[bytes[i] & 31];
    }
    return code;
  }

  const invalid = (): ScriptError =>
    new ScriptError('INVALID_ARGUMENT', 'version cannot be put up for approval');
  const sandbox = (cause: Error): ScriptError =>
    new ScriptError('SANDBOX', 'approval storage failed', cause);

  return {
    request(input): Result<{ code: string }, ScriptError> {
      const at = now();
      const found = repo.getVersion(input.versionId);
      if (found.isErr()) {
        return err(sandbox(found.error));
      }
      const version = found.value;
      if (!version || (version.state !== 'tested' && version.state !== 'awaiting-approval')) {
        return err(invalid());
      }
      const expired = repo.expireOpenApprovals(input.versionId, at);
      if (expired.isErr()) {
        return err(sandbox(expired.error));
      }
      const moved = repo.setVersionState(
        input.versionId,
        ['tested', 'awaiting-approval'],
        'awaiting-approval',
      );
      if (moved.isErr()) {
        return err(sandbox(moved.error));
      }
      if (!moved.value) {
        return err(invalid());
      }
      const code = generateCode();
      const inserted = repo.insertApproval({
        id: randomUUID(),
        versionId: input.versionId,
        codeHash: hashCode(code),
        channelName: input.channelName,
        externalThreadId: input.externalThreadId,
        expiresAt: at + ttlMinutes * 60_000,
      });
      if (inserted.isErr()) {
        if (version.state === 'tested') {
          repo.setVersionState(input.versionId, ['awaiting-approval'], 'tested');
        }
        return err(sandbox(inserted.error));
      }
      return ok({ code });
    },

    decide(
      input,
    ): Result<
      { outcome: 'approved' | 'rejected' | 'refused'; scriptName?: string; version?: number },
      ScriptError
    > {
      const at = now();
      const key = `${input.channelName}\0${input.externalThreadId}`;
      const refuse = (): Result<{ outcome: 'refused' }, ScriptError> => {
        recordRefusal(key, at);
        logger.info({ channel: input.channelName }, 'script approval attempt refused');
        return ok({ outcome: 'refused' });
      };
      if (blocked(key, at)) {
        return ok({ outcome: 'refused' });
      }
      const found = repo.findOpenApproval(hashCode(input.code));
      if (found.isErr()) {
        return err(sandbox(found.error));
      }
      const approval = found.value;
      if (
        !approval ||
        approval.expires_at <= at ||
        approval.channel_name !== input.channelName ||
        approval.external_thread_id !== input.externalThreadId
      ) {
        return refuse();
      }
      const decided = repo.decideApproval(approval.id, input.decision, at);
      if (decided.isErr()) {
        return err(sandbox(decided.error));
      }
      if (!decided.value) {
        return refuse();
      }
      const versionRow = repo.getVersion(approval.version_id);
      if (versionRow.isErr()) {
        return err(sandbox(versionRow.error));
      }
      const row = versionRow.value;
      const scriptName = row ? scriptNameOf(row.manifest) : undefined;
      return ok({
        outcome: input.decision,
        ...(scriptName !== undefined ? { scriptName } : {}),
        ...(row ? { version: row.version } : {}),
      });
    },

    parseCommand(text): { decision: 'approved' | 'rejected'; code: string } | undefined {
      const match = COMMAND_RE.exec(text.trim());
      if (!match) {
        return undefined;
      }
      return {
        decision: match[1] === 'approve' ? 'approved' : 'rejected',
        code: match[2].toUpperCase(),
      };
    },
  };
}
