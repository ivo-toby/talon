/**
 * ContextRoller — manages automatic session rotation when context usage
 * approaches the threshold.
 *
 * After each agent run, the caller passes the cacheReadTokens count.
 * If it exceeds the configured threshold, the roller:
 *   1. Reconstructs the transcript from the messages table
 *   2. Calls the session-summarizer sub-agent directly
 *   3. Stores the summary as memory items (type: 'summary')
 *   4. Clears the session so the next run starts fresh
 *
 * The fresh session then picks up the summary via ContextAssembler.
 */

import { randomUUID } from 'node:crypto';
import type { Result } from 'neverthrow';
import type pino from 'pino';
import type { MessageRepository, MessageRow } from '../core/database/repositories/message-repository.js';
import type { MemoryRepository, MemoryType } from '../core/database/repositories/memory-repository.js';
import type { SessionTracker } from '../sandbox/session-tracker.js';
import type { SubAgentResult } from '../subagents/subagent-types.js';
import type { SubAgentError } from '../core/errors/index.js';
import type { ResolvedContextUsage } from '../providers/provider-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum character budget for the transcript sent to the summarizer.
 * ~100K chars ≈ ~25K tokens — well within most model context windows.
 * We take the newest messages first, so recent context is always preserved.
 */
const MAX_TRANSCRIPT_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Simplified summarizer function signature for the context roller.
 *
 * The caller (bootstrap) pre-binds the model, system prompt, and services
 * so the roller only needs to provide threadId, personaId, and the transcript.
 */
export type SummarizerRunFn = (
  threadId: string,
  personaId: string,
  input: { transcript: string },
) => Promise<Result<SubAgentResult, SubAgentError>>;

/** Result of a successful context rotation. */
export interface ContextRotationResult {
  /** Whether the session was actually rotated. */
  rotated: boolean;
  /** Whether the summarizer found unfinished work (open threads). */
  hasOpenThreads: boolean;
}

export interface ContextRollerDeps {
  messageRepo: Pick<MessageRepository, 'findLatestByThread'>;
  memoryRepo: Pick<MemoryRepository, 'insert' | 'findById' | 'upsertByKey' | 'delete' | 'runInTransaction'>;
  sessionTracker: Pick<SessionTracker, 'rotateSession'>;
  /** Pre-bound summarizer function. Model, prompt, and services are captured at bootstrap. */
  summarizerRun: SummarizerRunFn;
  /** Optional resolver for provider-selected summarizer names. */
  resolveSummarizerRun?: (name: string) => SummarizerRunFn | null;
  logger: pino.Logger;
  /** Optional fallback context ratio threshold. */
  thresholdRatio?: number;
}

// ---------------------------------------------------------------------------
// ContextRoller
// ---------------------------------------------------------------------------

export class ContextRoller {
  private readonly deps: ContextRollerDeps;

  constructor(deps: ContextRollerDeps) {
    this.deps = deps;
  }

  /**
   * Check if context usage exceeds the threshold and rotate if needed.
   *
   * Call this after every successful agent run with provider-normalized
   * context usage metrics from the run result.
   */
  async checkAndRotate(
    threadId: string,
    personaId: string,
    contextUsage: ResolvedContextUsage,
    overrideThreshold?: number,
    summarizerName: string = 'session-summarizer',
  ): Promise<ContextRotationResult> {
    const noRotation: ContextRotationResult = { rotated: false, hasOpenThreads: false };
    const threshold = overrideThreshold ?? this.deps.thresholdRatio ?? 0.4;
    if (contextUsage.ratio < threshold) {
      return noRotation;
    }

    this.deps.logger.info(
      { threadId, contextUsage, thresholdRatio: threshold },
      'context-roller: threshold exceeded, rotating session based on provider usage',
    );

    // 1. Reconstruct transcript from the most recent messages.
    const messagesResult = this.deps.messageRepo.findLatestByThread(threadId, 10_000);
    if (messagesResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: messagesResult.error.message },
        'context-roller: failed to read messages, skipping rotation',
      );
      return noRotation;
    }

    const messages = messagesResult.value;
    if (messages.length === 0) {
      this.deps.logger.warn({ threadId }, 'context-roller: no messages found, skipping rotation');
      return noRotation;
    }

    const transcript = this.buildTranscript(messages, MAX_TRANSCRIPT_CHARS);
    const summarizerRun = this.deps.resolveSummarizerRun
      ? this.deps.resolveSummarizerRun(summarizerName)
      : this.deps.summarizerRun;
    if (!summarizerRun) {
      this.deps.logger.error(
        { threadId, summarizer: summarizerName },
        'context-roller: summarizer not available, keeping current session',
      );
      return noRotation;
    }

    // 2. Call pre-bound summarizer (model, prompt, and services captured at bootstrap).
    const summaryResult = await summarizerRun(
      threadId,
      personaId,
      { transcript },
    );

    if (summaryResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: summaryResult.error.message },
        'context-roller: summarization failed, keeping current session',
      );
      return noRotation;
    }

    const summary = summaryResult.value;
    const data = summary.data as {
      keyFacts?: string[];
      openThreads?: string[];
      memoryUpdates?: Array<{ key: string; value: string; mode: 'append' | 'replace' }>;
      summary?: string;
    } | undefined;

    // 3. Prepare memory updates — resolve append content against DB and
    // in-batch accumulator so duplicate keys within the same batch are correct.
    const pendingUpdates: Array<{ key: string; content: string; type: MemoryType }> = [];
    const accumulatedContent = new Map<string, string>();
    let preparationFailed = false;

    if (data?.memoryUpdates && data.memoryUpdates.length > 0) {
      for (const update of data.memoryUpdates) {
        if (!update.key || !update.value) continue;

        if (update.mode === 'append') {
          // Check in-batch accumulator first, then fall back to DB.
          let existingContent = accumulatedContent.get(update.key);
          if (existingContent === undefined) {
            const existingResult = this.deps.memoryRepo.findById(threadId, update.key);
            if (existingResult.isErr()) {
              // A read failure means we can't safely append — we might
              // silently truncate existing content. Abort the whole rotation.
              this.deps.logger.error(
                { key: update.key, error: existingResult.error.message },
                'context-roller: findById failed in append mode, aborting rotation to prevent data loss',
              );
              preparationFailed = true;
              break;
            }
            existingContent = existingResult.value?.content ?? '';
          }
          const newContent = existingContent
            ? `${existingContent}\n${update.value}`
            : update.value;
          accumulatedContent.set(update.key, newContent);
          const existingIdx = pendingUpdates.findIndex((p) => p.key === update.key);
          if (existingIdx !== -1) pendingUpdates.splice(existingIdx, 1);
          pendingUpdates.push({ key: update.key, content: newContent, type: 'note' });
        } else {
          accumulatedContent.set(update.key, update.value);
          const existingIdx = pendingUpdates.findIndex((p) => p.key === update.key);
          if (existingIdx !== -1) pendingUpdates.splice(existingIdx, 1);
          pendingUpdates.push({ key: update.key, content: update.value, type: 'note' });
        }
      }
    }

    if (preparationFailed) {
      return noRotation;
    }

    // 4. Build summary content. Always include keyFacts as a safety net —
    // named keys are authoritative but keyFacts in the blob ensure continuity.
    const summaryParts = [data?.summary ?? summary.summary, ''];

    if (data?.keyFacts && data.keyFacts.length > 0) {
      summaryParts.push('Key facts:', ...data.keyFacts.map((f) => `- ${f}`), '');
    }

    summaryParts.push('Open threads:', ...(data?.openThreads ?? []).map((t) => `- ${t}`));
    const summaryContent = summaryParts.join('\n');

    // 5. Persist summary + all memory updates in a single transaction.
    // If any write fails, the entire batch is rolled back atomically.
    const summaryId = randomUUID();
    const txResult = this.deps.memoryRepo.runInTransaction(() => {
      const insertResult = this.deps.memoryRepo.insert({
        id: summaryId,
        thread_id: threadId,
        type: 'summary',
        content: summaryContent,
        embedding_ref: null,
        metadata: JSON.stringify({
          source: 'context-roller',
          messageCount: messages.length,
          contextUsage,
          ...(contextUsage.rawMetricName === 'cache_read_input_tokens'
            ? { cacheReadTokens: contextUsage.rawMetric }
            : {}),
          createdAt: new Date().toISOString(),
        }),
      });
      if (insertResult.isErr()) {
        throw new Error(`summary insert: ${insertResult.error.message}`);
      }

      for (const update of pendingUpdates) {
        const upsertResult = this.deps.memoryRepo.upsertByKey(threadId, update.key, {
          type: update.type,
          content: update.content,
        });
        if (upsertResult.isErr()) {
          throw new Error(`upsert ${update.key}: ${upsertResult.error.message}`);
        }
      }

      return pendingUpdates.length;
    });

    if (txResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: txResult.error.message },
        'context-roller: rotation transaction failed — all writes rolled back, keeping current session',
      );
      return noRotation;
    }

    if (pendingUpdates.length > 0) {
      this.deps.logger.info(
        { threadId, applied: pendingUpdates.length, total: pendingUpdates.length },
        'context-roller: distributed memory updates to named keys',
      );
    }

    // 6. Clear session — next run starts fresh.
    this.deps.sessionTracker.rotateSession(threadId);

    this.deps.logger.info(
      { threadId, messageCount: messages.length, summaryLength: summaryContent.length },
      'context-roller: session rotated successfully',
    );

    const hasOpenThreads = (data?.openThreads ?? []).length > 0;
    return { rotated: true, hasOpenThreads };
  }

  /**
   * Reconstruct a human-readable transcript from stored messages,
   * capped at `maxChars` characters. Takes the newest messages first
   * so recent context is always preserved.
   */
  private buildTranscript(messages: MessageRow[], maxChars: number): string {
    // Build lines from newest to oldest, stop when budget is exhausted.
    const lines: string[] = [];
    let totalChars = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const line = formatMessageForTranscript(messages[i]);

      if (totalChars + line.length > maxChars && lines.length > 0) {
        break;
      }
      lines.push(line);
      totalChars += line.length + 1; // +1 for newline
    }

    // Reverse back to chronological order.
    return lines.reverse().join('\n');
  }
}

// ---------------------------------------------------------------------------
// Message formatting (shared with context-assembler)
// ---------------------------------------------------------------------------

interface ToolActivityEntry {
  tool: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

/**
 * Format a single message row into a human-readable transcript line.
 *
 * Includes tool activity (calls + results) when present so the summarizer
 * and the fresh-session context both capture what the agent actually did,
 * not just the text it produced.
 */
export function formatMessageForTranscript(msg: MessageRow): string {
  const role = msg.direction === 'inbound' ? 'User' : 'Assistant';
  let body: string;
  let toolActivity: ToolActivityEntry[] | undefined;

  try {
    const parsed = JSON.parse(msg.content);
    body = typeof parsed.body === 'string' ? parsed.body : msg.content;
    if (Array.isArray(parsed.toolActivity)) {
      toolActivity = parsed.toolActivity;
    }
  } catch {
    body = msg.content;
  }

  if (!toolActivity || toolActivity.length === 0) {
    return `${role}: ${body}`;
  }

  // Build a compact tool activity section.
  const toolLines = toolActivity.map((t) => {
    const inputStr = t.input !== undefined ? ` input=${summarizeValue(t.input)}` : '';
    const outputStr = t.output !== undefined ? ` → ${summarizeValue(t.output)}` : '';
    const errorStr = t.isError ? ' [ERROR]' : '';
    return `  [tool] ${t.tool}${inputStr}${outputStr}${errorStr}`;
  });

  return `${role}: ${body}\n${toolLines.join('\n')}`;
}

/** Truncate a value to a compact string for transcript inclusion. */
function summarizeValue(value: unknown, maxLen = 200): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}…`;
}
