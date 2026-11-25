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
const COMMAND_RE = /^\/(approve|reject)(@[A-Za-z0-9_]{1,64})?[ \t]+([A-Za-z0-9]{8})[.!]?$/i;
const COMMAND_WORD_RE = /^\/(approve|reject)(@[A-Za-z0-9_]{1,64})?$/i;
/** Leak scan bounds: the first characters of a message, and the code-sized tokens in them. */
const SCAN_CHARS = 8000;
const SCAN_TOKENS = 400;

/**
 * What an inbound message is for the approvals of its chat.
 * - `none`: the chat has no open approval, or the message is not about one.
 * - `command`: an `/approve CODE` or `/reject CODE` command.
 * - `leak`: not a command, but the message holds a valid open code of this chat.
 * - `malformed`: not a command and no leak, but it starts with `/approve` or `/reject`.
 */
export type InboundKind = 'none' | 'command' | 'leak' | 'malformed';

export interface ChatMessage {
  channelName: string;
  externalThreadId: string;
  content: unknown;
}

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
  }): Result<Decision, ScriptError>;
  parseCommand(text: string): { decision: 'approved' | 'rejected'; code: string } | undefined;
  /**
   * Synchronous, never throws. A chat with no open approval costs one map
   * lookup: no hashing and no database.
   */
  classify(message: ChatMessage): InboundKind;
  /**
   * Expires the open approvals of the chat whose code the message holds, and
   * moves their versions back to `tested`. Returns the versions it cancelled.
   */
  cancelLeaked(message: ChatMessage): Result<CancelledApproval[], ScriptError>;
  /** Expires the open approvals of a version, in the database and in the index. */
  expireVersion(versionId: string): Result<void, ScriptError>;
}

export interface Decision {
  /** `blocked`: the chat is held by the attempt limiter; nothing was checked. */
  outcome: 'approved' | 'rejected' | 'refused' | 'blocked';
  scriptName?: string;
  version?: number;
  versionId?: string;
  personaId?: string;
  threadId?: string;
}

export interface CancelledApproval {
  versionId: string;
  personaId?: string;
  threadId?: string;
}

interface OpenCode {
  versionId: string;
  expiresAt: number;
}

const chatKey = (channelName: string, externalThreadId: string): string =>
  `${channelName}\0${externalThreadId}`;

function sha256Code(code: string): string {
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
  /** Test seam. Default: SHA-256 of the uppercased code, as hex. */
  hashCode?: (code: string) => string;
  logger?: Logger;
}): ApprovalService {
  const { repo, ttlMinutes } = options;
  const now = options.now ?? ((): number => Date.now());
  const randomBytes = options.randomBytes ?? ((n: number): Buffer => cryptoRandomBytes(n));
  const hashCode = options.hashCode ?? sha256Code;
  const logger = options.logger ?? createLogger({ level: 'info', pretty: false });

  /** chat key -> code hash -> open approval. Mirrors the undecided, unexpired rows. */
  const index = new Map<string, Map<string, OpenCode>>();

  function addOpen(key: string, hash: string, code: OpenCode): void {
    let codes = index.get(key);
    if (!codes) {
      codes = new Map();
      index.set(key, codes);
    }
    codes.set(hash, code);
  }

  function dropHash(key: string, hash: string): void {
    const codes = index.get(key);
    if (!codes) return;
    codes.delete(hash);
    if (codes.size === 0) index.delete(key);
  }

  function dropVersion(versionId: string): void {
    for (const [key, codes] of index) {
      for (const [hash, code] of codes) {
        if (code.versionId === versionId) codes.delete(hash);
      }
      if (codes.size === 0) index.delete(key);
    }
  }

  /** The open codes of a chat after the expired ones are pruned, or undefined. */
  function openCodes(key: string, at: number): Map<string, OpenCode> | undefined {
    const codes = index.get(key);
    if (!codes) return undefined;
    for (const [hash, code] of codes) {
      if (code.expiresAt <= at) codes.delete(hash);
    }
    if (codes.size === 0) {
      index.delete(key);
      return undefined;
    }
    return codes;
  }

  /** The open code hashes of the chat that the text holds. */
  function leakedHashes(text: string, codes: Map<string, OpenCode>): string[] {
    const found = new Set<string>();
    let tokens = 0;
    for (const token of text.slice(0, SCAN_CHARS).split(/[^A-Za-z0-9]/)) {
      if (token.length !== CODE_LENGTH) continue;
      if (++tokens > SCAN_TOKENS) break;
      const hash = hashCode(token.toUpperCase());
      if (codes.has(hash)) found.add(hash);
    }
    return [...found];
  }

  {
    const listed = repo.listOpenApprovals(now());
    if (listed.isErr()) {
      logger.error('scripts: the open approvals could not be read; their codes are not guarded');
    } else {
      for (const row of listed.value) {
        addOpen(chatKey(row.channel_name, row.external_thread_id), row.code_hash, {
          versionId: row.version_id,
          expiresAt: row.expires_at,
        });
      }
    }
  }

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
      dropVersion(input.versionId);
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
      const codeHash = hashCode(code);
      const expiresAt = at + ttlMinutes * 60_000;
      const inserted = repo.insertApproval({
        id: randomUUID(),
        versionId: input.versionId,
        codeHash,
        channelName: input.channelName,
        externalThreadId: input.externalThreadId,
        expiresAt,
      });
      if (inserted.isErr()) {
        if (version.state === 'tested') {
          repo.setVersionState(input.versionId, ['awaiting-approval'], 'tested');
        }
        return err(sandbox(inserted.error));
      }
      addOpen(chatKey(input.channelName, input.externalThreadId), codeHash, {
        versionId: input.versionId,
        expiresAt,
      });
      return ok({ code });
    },

    decide(input): Result<Decision, ScriptError> {
      const at = now();
      const key = chatKey(input.channelName, input.externalThreadId);
      const refuse = (): Result<Decision, ScriptError> => {
        recordRefusal(key, at);
        logger.info({ channel: input.channelName }, 'script approval attempt refused');
        return ok({ outcome: 'refused' });
      };
      if (blocked(key, at)) {
        return ok({ outcome: 'blocked' });
      }
      const codeHash = hashCode(input.code);
      const found = repo.findOpenApproval(codeHash);
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
        if (approval && approval.expires_at <= at) {
          dropHash(chatKey(approval.channel_name, approval.external_thread_id), codeHash);
        }
        return refuse();
      }
      const decided = repo.decideApproval(approval.id, input.decision, at);
      if (decided.isErr()) {
        return err(sandbox(decided.error));
      }
      dropHash(key, codeHash);
      if (!decided.value) {
        return refuse();
      }
      // The decision is committed: from here on, a failed read only loses detail.
      const versionRow = repo.getVersion(approval.version_id);
      const row = versionRow.isOk() ? versionRow.value : null;
      if (versionRow.isErr()) {
        logger.error('script approval: the decided version could not be read');
      }
      const scriptName = row ? scriptNameOf(row.manifest) : undefined;
      const scriptRow = row ? repo.getScript(row.script_id) : undefined;
      if (scriptRow?.isErr()) {
        logger.error('script approval: the script of the decided version could not be read');
      }
      const persona = scriptRow?.isOk() ? scriptRow.value?.persona_id : undefined;
      return ok({
        outcome: input.decision,
        ...(scriptName !== undefined ? { scriptName } : {}),
        ...(row ? { version: row.version, versionId: row.id, threadId: row.thread_id ?? '' } : {}),
        ...(persona !== undefined ? { personaId: persona } : {}),
      });
    },

    classify(message): InboundKind {
      try {
        const key = chatKey(message.channelName, message.externalThreadId);
        if (!index.has(key)) return 'none';
        const codes = openCodes(key, now());
        if (!codes || typeof message.content !== 'string') return 'none';
        const text = message.content.trim();
        if (COMMAND_RE.test(text)) return 'command';
        if (leakedHashes(message.content, codes).length > 0) return 'leak';
        const first = text.split(/\s+/, 1)[0] ?? '';
        return COMMAND_WORD_RE.test(first) ? 'malformed' : 'none';
      } catch (error) {
        logger.error(
          { errName: error instanceof Error ? error.name : 'unknown' },
          'script approval classify failed',
        );
        return 'none';
      }
    },

    cancelLeaked(message): Result<CancelledApproval[], ScriptError> {
      const at = now();
      const key = chatKey(message.channelName, message.externalThreadId);
      const codes = openCodes(key, at);
      if (!codes || typeof message.content !== 'string') return ok([]);
      const versions = new Set<string>();
      for (const hash of leakedHashes(message.content, codes)) {
        const code = codes.get(hash);
        if (code) versions.add(code.versionId);
      }
      const cancelled: CancelledApproval[] = [];
      for (const versionId of versions) {
        const expired = repo.expireOpenApprovals(versionId, at);
        if (expired.isErr()) return err(sandbox(expired.error));
        dropVersion(versionId);
        const back = repo.setVersionState(versionId, ['awaiting-approval'], 'tested');
        if (back.isErr()) return err(sandbox(back.error));
        const row = repo.getVersion(versionId);
        const version = row.isOk() ? row.value : null;
        const script = version ? repo.getScript(version.script_id) : undefined;
        const persona = script?.isOk() ? script.value?.persona_id : undefined;
        cancelled.push({
          versionId,
          ...(version ? { threadId: version.thread_id ?? '' } : {}),
          ...(persona !== undefined ? { personaId: persona } : {}),
        });
      }
      return ok(cancelled);
    },

    expireVersion(versionId): Result<void, ScriptError> {
      const expired = repo.expireOpenApprovals(versionId, now());
      dropVersion(versionId);
      return expired.isErr() ? err(sandbox(expired.error)) : ok(undefined);
    },

    parseCommand(text): { decision: 'approved' | 'rejected'; code: string } | undefined {
      const match = COMMAND_RE.exec(text.trim());
      if (!match) {
        return undefined;
      }
      return {
        decision: match[1].toLowerCase() === 'approve' ? 'approved' : 'rejected',
        code: match[3].toUpperCase(),
      };
    },
  };
}
