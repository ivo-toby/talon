/**
 * Approval codes for stored scripts.
 *
 * A code is a secret between Talon and the user. Only its SHA-256 is stored.
 * The code appears in no log line, no error and no return value except the
 * one return of `request`.
 */

import { hash as cryptoHash, randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { ok, err, type Result } from 'neverthrow';
import type { ScriptRepository } from '../core/database/repositories/script-repository.js';
import type { Logger } from 'pino';
import { createLogger } from '../core/logging/index.js';
import { ScriptError } from './types.js';

/** What an approval decides: one script version, one run or one schedule change. */
export type ApprovalPurpose = 'version' | 'run' | 'schedule';

/** A payload is at most this many characters. */
export const MAX_PAYLOAD_CHARS = 12_000;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_REFUSALS = 5;
const WINDOW_MS = 10 * 60_000;
const MAX_KEYS = 1000;
const COMMAND_RE = /^\/(approve|reject)(@[A-Za-z0-9_]{1,64})?[ \t]+([A-Za-z0-9]{8})[.!]?$/i;
const COMMAND_START_RE = /^\/(approve|reject)/i;
/** A message longer than this is scanned at both ends, this many characters each. */
const SCAN_CHARS = 16_000;
/** Unicode format characters, for example zero-width spaces and the byte order mark. */
const FORMAT_RE = /\p{Cf}/gu;
/** Only a window of code characters can be a code, so only such a window is hashed. */
const CODE_WINDOW_RE = /^[A-HJ-NP-Z2-9]{8}$/;
/** Two short runs with one of these characters between them are also tried as one code. */
const JOIN_CHARS = new Set(['-', '_', '.', ' ']);

/**
 * What an inbound message is for the open approvals.
 * - `none`: nothing to claim.
 * - `command`: an `/approve CODE` or `/reject CODE` command, in a chat with an open approval.
 * - `leak`: not a command, but the message holds a valid open code of its chat.
 * - `malformed`: not a command and no leak, but it starts with `/approve` or `/reject`.
 * - `wrong-chat`: a well-formed command, in a chat with no open approval, with the
 *   valid code of another chat.
 */
export type InboundKind = 'none' | 'command' | 'leak' | 'malformed' | 'wrong-chat';

export interface ChatMessage {
  channelName: string;
  externalThreadId: string;
  content: unknown;
}

export interface ApprovalService {
  /**
   * Purpose `version` (default): the version must be 'tested' (or 'awaiting-approval').
   * Purpose `run` or `schedule`: the version must be 'approved', and its state never changes.
   * A new request expires the open approvals of the same version and purpose only.
   * Returns the code one time.
   */
  request(input: {
    versionId: string;
    channelName: string;
    externalThreadId: string;
    purpose?: ApprovalPurpose;
    /** At most 12,000 characters, for example the JSON of a schedule change. */
    payload?: string;
  }): Result<{ code: string }, ScriptError>;
  decide(input: {
    code: string;
    decision: 'approved' | 'rejected';
    channelName: string;
    externalThreadId: string;
  }): Result<Decision, ScriptError>;
  parseCommand(text: string): { decision: 'approved' | 'rejected'; code: string } | undefined;
  /**
   * Synchronous, never throws. With no open approval anywhere, a message costs
   * two map lookups: no hashing and no database.
   */
  classify(message: ChatMessage): InboundKind;
  /**
   * Expires the open approvals of the chat whose code the message holds, and
   * moves their versions back to `tested` (only for purpose `version`). Returns the versions it cancelled.
   */
  cancelLeaked(message: ChatMessage): CancelOutcome;
  /** The same for a `wrong-chat` command: cancels the approval that its code belongs to. */
  cancelWrongChat(message: ChatMessage): CancelOutcome;
  /**
   * Counts a claimed message that was not a valid decision toward the attempt
   * limiter of its chat. Returns true, and counts nothing, if the chat is blocked.
   */
  noteAttempt(channelName: string, externalThreadId: string): boolean;
  /**
   * Expires the open approvals of a version, of every purpose or only of `purpose`, in the
   * database and in the index. If the database write fails, the index keeps the codes (fail closed).
   */
  expireVersion(versionId: string, purpose?: ApprovalPurpose): Result<void, ScriptError>;
}

export interface Decision {
  /** `blocked`: the chat is held by the attempt limiter; nothing was checked. */
  outcome: 'approved' | 'rejected' | 'refused' | 'blocked';
  scriptName?: string;
  version?: number;
  versionId?: string;
  personaId?: string;
  threadId?: string;
  /** Set on `approved` and `rejected`. */
  purpose?: ApprovalPurpose;
  /** The payload of the approval, if it had one. */
  payload?: string;
}

/** `failed`: an expire write failed. That code stays guarded in memory, and it is not in `cancelled`. */
export interface CancelOutcome {
  cancelled: CancelledApproval[];
  failed: boolean;
}

export interface CancelledApproval {
  versionId: string;
  purpose: ApprovalPurpose;
  personaId?: string;
  threadId?: string;
}

interface OpenCode {
  versionId: string;
  purpose: ApprovalPurpose;
  expiresAt: number;
}

/** A letter or digit of ASCII. */
function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** A character of the code alphabet, in either case. `I`, `O`, `0` and `1` are not in it. */
function isCodeChar(c: number): boolean {
  const upper = c >= 97 && c <= 122 ? c - 32 : c;
  return (
    (upper >= 50 && upper <= 57) || (upper >= 65 && upper <= 90 && upper !== 73 && upper !== 79)
  );
}

/**
 * The uppercase 8-character strings of a text that can be a code: each window of
 * 8 code-alphabet characters in a run of letters and digits, and two short runs
 * that a single `-`, `_`, `.` or space joins to 8 characters. The text is NFKC
 * normalized and its format characters are removed first. A long text is scanned
 * at its first and its last `SCAN_CHARS` characters. One pass, O(1) per position.
 */
export function candidateCodes(text: string): Set<string> {
  const clean = text.normalize('NFKC').replace(FORMAT_RE, '');
  const parts =
    clean.length <= SCAN_CHARS ? [clean] : [clean.slice(0, SCAN_CHARS), clean.slice(-SCAN_CHARS)];
  const found = new Set<string>();
  for (const part of parts) {
    let alphabet = 0;
    let runStart = -1;
    let previous: { start: number; end: number } | undefined;
    for (let i = 0; i <= part.length; i++) {
      const c = i < part.length ? part.charCodeAt(i) : -1;
      if (c >= 0 && isAlnum(c)) {
        if (runStart < 0) runStart = i;
        alphabet = isCodeChar(c) ? alphabet + 1 : 0;
        if (alphabet >= CODE_LENGTH)
          found.add(part.slice(i - CODE_LENGTH + 1, i + 1).toUpperCase());
        continue;
      }
      alphabet = 0;
      if (runStart < 0) continue;
      const run = { start: runStart, end: i };
      runStart = -1;
      if (
        previous &&
        run.start - previous.end === 1 &&
        JOIN_CHARS.has(part[previous.end]) &&
        previous.end - previous.start < CODE_LENGTH &&
        run.end - run.start < CODE_LENGTH &&
        previous.end - previous.start + run.end - run.start === CODE_LENGTH
      ) {
        const joined = (
          part.slice(previous.start, previous.end) + part.slice(run.start, run.end)
        ).toUpperCase();
        if (CODE_WINDOW_RE.test(joined)) found.add(joined);
      }
      previous = run;
    }
  }
  return found;
}

const chatKey = (channelName: string, externalThreadId: string): string =>
  `${channelName}\0${externalThreadId}`;

function sha256Code(code: string): string {
  return cryptoHash('sha256', code.toUpperCase(), 'hex');
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
}): Result<ApprovalService, ScriptError> {
  const { repo, ttlMinutes } = options;
  const now = options.now ?? ((): number => Date.now());
  const randomBytes = options.randomBytes ?? ((n: number): Buffer => cryptoRandomBytes(n));
  const hashCode = options.hashCode ?? sha256Code;
  const logger = options.logger ?? createLogger({ level: 'info', pretty: false });

  const invalid = (): ScriptError =>
    new ScriptError('INVALID_ARGUMENT', 'version cannot be put up for approval');
  const sandbox = (cause: Error): ScriptError =>
    new ScriptError('SANDBOX', 'approval storage failed', cause);

  /** chat key -> code hash -> open approval. Mirrors the undecided, unexpired rows. */
  const index = new Map<string, Map<string, OpenCode>>();
  /** code hash -> chat key, over all open approvals. */
  const byHash = new Map<string, string>();

  function addOpen(key: string, hash: string, code: OpenCode): void {
    let codes = index.get(key);
    if (!codes) {
      codes = new Map();
      index.set(key, codes);
    }
    codes.set(hash, code);
    byHash.set(hash, key);
  }

  function dropHash(key: string, hash: string): void {
    byHash.delete(hash);
    const codes = index.get(key);
    if (!codes) return;
    codes.delete(hash);
    if (codes.size === 0) index.delete(key);
  }

  function dropVersion(versionId: string, purpose?: ApprovalPurpose): void {
    for (const [key, codes] of index) {
      for (const [hash, code] of codes) {
        if (code.versionId === versionId && (purpose === undefined || code.purpose === purpose)) {
          codes.delete(hash);
          byHash.delete(hash);
        }
      }
      if (codes.size === 0) index.delete(key);
    }
  }

  /** The open codes of a chat after the expired ones are pruned, or undefined. */
  function openCodes(key: string, at: number): Map<string, OpenCode> | undefined {
    const codes = index.get(key);
    if (!codes) return undefined;
    for (const [hash, code] of codes) {
      if (code.expiresAt <= at) {
        codes.delete(hash);
        byHash.delete(hash);
      }
    }
    if (codes.size === 0) {
      index.delete(key);
      return undefined;
    }
    return codes;
  }

  /**
   * The hashes of the candidate codes of a message. The pipeline passes the same
   * event object to `matches` and to `handle`, so one message is scanned one time.
   */
  const scans = new WeakMap<object, { content: string; hashes: string[] }>();

  function candidateHashes(message: ChatMessage & { content: string }): string[] {
    const cached = scans.get(message);
    if (cached && cached.content === message.content) return cached.hashes;
    const hashes = [...candidateCodes(message.content)].map((candidate) => hashCode(candidate));
    scans.set(message, { content: message.content, hashes });
    return hashes;
  }

  /** The open code hashes of the chat that the message holds. */
  function leakedHashes(
    message: ChatMessage & { content: string },
    codes: Map<string, OpenCode>,
  ): string[] {
    return candidateHashes(message).filter((hash) => codes.has(hash));
  }

  /** The open approval that a well-formed command of another chat names, or undefined. */
  function wrongChatCode(text: string, at: number): { key: string; code: OpenCode } | undefined {
    if (byHash.size === 0) return undefined;
    const match = COMMAND_RE.exec(text.trim());
    if (!match) return undefined;
    const hash = hashCode(match[3].toUpperCase());
    const key = byHash.get(hash);
    if (key === undefined) return undefined;
    const code = openCodes(key, at)?.get(hash);
    return code ? { key, code } : undefined;
  }

  /**
   * Expires the approvals of one purpose of each version. Only purpose `version`
   * moves the version back to `tested`. A failed write keeps the codes.
   */
  function cancelApprovals(
    targets: Iterable<{ versionId: string; purpose: ApprovalPurpose }>,
    at: number,
  ): CancelOutcome {
    const cancelled: CancelledApproval[] = [];
    let failed = false;
    for (const { versionId, purpose } of targets) {
      const expired = repo.expireOpenApprovals(versionId, at, purpose);
      if (expired.isErr()) {
        logger.error('script approval: an approval could not be expired; its code stays guarded');
        failed = true;
        continue;
      }
      dropVersion(versionId, purpose);
      if (purpose === 'version') {
        const back = repo.setVersionState(versionId, ['awaiting-approval'], 'tested');
        if (back.isErr()) {
          logger.error('script approval: a cancelled version could not move back to tested');
        }
      }
      const row = repo.getVersion(versionId);
      const version = row.isOk() ? row.value : null;
      const script = version ? repo.getScript(version.script_id) : undefined;
      const persona = script?.isOk() ? script.value?.persona_id : undefined;
      cancelled.push({
        versionId,
        purpose,
        ...(version ? { threadId: version.thread_id ?? '' } : {}),
        ...(persona !== undefined ? { personaId: persona } : {}),
      });
    }
    return { cancelled, failed };
  }

  const listed = repo.listOpenApprovals(now());
  if (listed.isErr()) {
    return err(sandbox(listed.error));
  }
  for (const row of listed.value) {
    addOpen(chatKey(row.channel_name, row.external_thread_id), row.code_hash, {
      versionId: row.version_id,
      purpose: row.purpose,
      expiresAt: row.expires_at,
    });
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

  return ok({
    request(input): Result<{ code: string }, ScriptError> {
      const at = now();
      const found = repo.getVersion(input.versionId);
      if (found.isErr()) {
        return err(sandbox(found.error));
      }
      const version = found.value;
      const purpose = input.purpose ?? 'version';
      if (input.payload !== undefined && input.payload.length > MAX_PAYLOAD_CHARS) {
        return err(invalid());
      }
      const allowed =
        purpose === 'version'
          ? version?.state === 'tested' || version?.state === 'awaiting-approval'
          : version?.state === 'approved';
      if (!version || !allowed) {
        return err(invalid());
      }
      const expired = repo.expireOpenApprovals(
        input.versionId,
        at,
        purpose === 'version' ? undefined : purpose,
      );
      if (expired.isErr()) {
        return err(sandbox(expired.error));
      }
      dropVersion(input.versionId, purpose === 'version' ? undefined : purpose);
      if (purpose === 'version') {
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
        purpose,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      });
      if (inserted.isErr()) {
        if (purpose === 'version' && version.state === 'tested') {
          repo.setVersionState(input.versionId, ['awaiting-approval'], 'tested');
        }
        return err(sandbox(inserted.error));
      }
      addOpen(chatKey(input.channelName, input.externalThreadId), codeHash, {
        versionId: input.versionId,
        purpose,
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
        purpose: approval.purpose,
        ...(approval.payload !== null ? { payload: approval.payload } : {}),
      });
    },

    classify(message): InboundKind {
      try {
        if (typeof message.content !== 'string') return 'none';
        const key = chatKey(message.channelName, message.externalThreadId);
        const at = now();
        const codes = index.has(key) ? openCodes(key, at) : undefined;
        if (!codes) {
          return wrongChatCode(message.content, at) ? 'wrong-chat' : 'none';
        }
        const text = message.content.trim();
        if (COMMAND_RE.test(text)) return 'command';
        if (leakedHashes(message as ChatMessage & { content: string }, codes).length > 0) {
          return 'leak';
        }
        return COMMAND_START_RE.test(text) ? 'malformed' : 'none';
      } catch (error) {
        logger.error(
          { errName: error instanceof Error ? error.name : 'unknown' },
          'script approval classify failed',
        );
        return 'none';
      }
    },

    cancelLeaked(message): CancelOutcome {
      const at = now();
      const codes = openCodes(chatKey(message.channelName, message.externalThreadId), at);
      if (!codes || typeof message.content !== 'string') return { cancelled: [], failed: false };
      const targets = new Map<string, { versionId: string; purpose: ApprovalPurpose }>();
      for (const hash of leakedHashes(message as ChatMessage & { content: string }, codes)) {
        const code = codes.get(hash);
        if (code) {
          targets.set(`${code.versionId}\0${code.purpose}`, {
            versionId: code.versionId,
            purpose: code.purpose,
          });
        }
      }
      return cancelApprovals(targets.values(), at);
    },

    cancelWrongChat(message): CancelOutcome {
      const at = now();
      const found =
        typeof message.content === 'string' ? wrongChatCode(message.content, at) : undefined;
      return found
        ? cancelApprovals([{ versionId: found.code.versionId, purpose: found.code.purpose }], at)
        : { cancelled: [], failed: false };
    },

    noteAttempt(channelName, externalThreadId): boolean {
      const at = now();
      const key = chatKey(channelName, externalThreadId);
      if (blocked(key, at)) return true;
      recordRefusal(key, at);
      return false;
    },

    expireVersion(versionId, purpose): Result<void, ScriptError> {
      const expired = repo.expireOpenApprovals(versionId, now(), purpose);
      if (expired.isErr()) {
        logger.error('script approval: an approval could not be expired; its code stays guarded');
        return err(sandbox(expired.error));
      }
      dropVersion(versionId, purpose);
      return ok(undefined);
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
  });
}
