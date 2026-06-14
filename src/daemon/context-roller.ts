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
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { SessionTracker } from '../sandbox/session-tracker.js';
import type { SubAgentResult } from '../subagents/subagent-types.js';
import type { SubAgentError } from '../core/errors/index.js';
import type { ResolvedContextUsage } from '../providers/provider-types.js';
import { readScheduleOriginExternalId } from './schedule-thread-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum character budget for the transcript sent to the summarizer.
 * ~100K chars ≈ ~25K tokens — well within most model context windows.
 * We take the newest messages first, so recent context is always preserved.
 */
const MAX_TRANSCRIPT_CHARS = 100_000;
const SCHEDULE_CONTEXT_MESSAGE_LIMIT = 500;
const SCHEDULE_CONTEXT_WINDOW_MS = 48 * 60 * 60 * 1000;
const DIRECT_CONVERSATION_SECTION_HEADER = '[Direct conversation context last 48h]';
const SCHEDULE_HISTORY_SECTION_HEADER = '[Schedule thread history]';

/**
 * Extracts rotatedThroughTs from the most recent observation's metadata.
 * Returns null if no valid boundary is found (first-ever roll, or malformed metadata).
 */
function extractPreviousRotationBoundary(
  observations: Array<{ metadata: string; created_at: number }>,
): number | null {
  if (observations.length === 0) return null;
  // Observations are ordered DESC by created_at — [0] is newest.
  const meta = observations[0].metadata;
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    const ts = Number(parsed.rotatedThroughTs);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  } catch {
    return null;
  }
}
const DIRECT_CONTEXT_BUDGET_RATIO = 0.25;

/**
 * Number of messages to preserve as a pre-roll tail so the agent retains
 * conversational continuity after a context rotation. Stored as a separate
 * memory item and injected by the ContextAssembler with explicit
 * "already processed — do NOT re-execute" framing.
 */
const PRE_ROLL_TAIL_SIZE = 10;


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
  input: Record<string, unknown>,
) => Promise<Result<SubAgentResult, SubAgentError>>;

/** Result of a successful context rotation. */
export interface ContextRotationResult {
  /** Whether the session was actually rotated. */
  rotated: boolean;
  /** Whether the summarizer found unfinished work (open threads). */
  hasOpenThreads: boolean;
}

/**
 * Reflector function signature — receives the accumulated observation log.
 * Uses the same base signature as SummarizerRunFn since both are pre-bound
 * sub-agent runners; the input shape differs but the runner passes it through.
 */
export type ReflectorRunFn = SummarizerRunFn;

/**
 * Default character budget for the accumulated observation log before the
 * reflector is triggered to consolidate observations. ~40K chars ≈ ~10K
 * tokens — keeps observations manageable. Operators can override via
 * `agentRunner.providers.<name>.contextManagement.reflectionThresholdChars`.
 */
export const DEFAULT_MAX_OBSERVATION_CHARS = 40_000;

export interface ContextRollerDeps {
  messageRepo: Pick<MessageRepository, 'findLatestByThread' | 'findLatestByThreadSince'>;
  threadRepo?: Pick<ThreadRepository, 'findByExternalId'>;
  memoryRepo: Pick<MemoryRepository, 'insert' | 'findById' | 'findByThread' | 'upsertByKey' | 'delete' | 'runInTransaction'>;
  sessionTracker: Pick<SessionTracker, 'rotateSession'>;
  /** Pre-bound summarizer function. Model, prompt, and services are captured at bootstrap. */
  summarizerRun: SummarizerRunFn;
  /** Optional resolver for provider-selected summarizer names. */
  resolveSummarizerRun?: (name: string) => SummarizerRunFn | null;
  /** Optional pre-bound reflector function for observation consolidation. */
  reflectorRun?: ReflectorRunFn;
  /** Optional resolver for named reflector sub-agents. */
  resolveReflectorRun?: (name: string) => ReflectorRunFn | null;
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

    // Snapshot boundary: created_at of the newest message INCLUDED in the
    // transcript. ContextAssembler uses this to scope "Recent Messages" to
    // turns that arrived AFTER this point — not the summary's own write time,
    // which can trail the snapshot by seconds (summarizer latency) and would
    // incorrectly drop messages that arrived in between.
    const rotatedThroughTs = messages[messages.length - 1].created_at;

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
          rotatedThroughTs,
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

    // 6. Persist pre-roll tail so the next session retains conversational
    //    continuity. The ContextAssembler injects this with explicit
    //    "already processed — do NOT re-execute" framing so the agent
    //    understands what was just being discussed without replaying instructions.
    this.savePreRollTail(threadId, messages, rotatedThroughTs);

    // 7. Clear session — next run starts fresh.
    this.deps.sessionTracker.rotateSession(threadId);

    this.deps.logger.info(
      { threadId, messageCount: messages.length, summaryLength: summaryContent.length },
      'context-roller: session rotated successfully',
    );

    const hasOpenThreads = (data?.openThreads ?? []).length > 0;
    return { rotated: true, hasOpenThreads };
  }

  /**
   * Observational memory rotation — appends observations instead of
   * overwriting summaries.
   *
   * Called when the configured summarizer is `session-observer`. Instead of
   * producing a single summary blob, the observer generates dated, prioritized
   * observations that are appended to an observation log in memory_items.
   *
   * When the accumulated observation log exceeds MAX_OBSERVATION_CHARS, the
   * reflector is triggered to consolidate observations.
   */
  async checkAndRotateOM(
    threadId: string,
    personaId: string,
    contextUsage: ResolvedContextUsage,
    overrideThreshold?: number,
    observerName: string = 'session-observer',
    reflectorName: string = 'session-reflector',
    reflectionThresholdChars: number = DEFAULT_MAX_OBSERVATION_CHARS,
    threadMetadata?: string | null,
    channelId?: string,
  ): Promise<ContextRotationResult> {
    const noRotation: ContextRotationResult = { rotated: false, hasOpenThreads: false };
    const threshold = overrideThreshold ?? this.deps.thresholdRatio ?? 0.4;
    if (contextUsage.ratio < threshold) {
      return noRotation;
    }

    this.deps.logger.info(
      { threadId, contextUsage, thresholdRatio: threshold },
      'context-roller-om: threshold exceeded, creating observations',
    );

    // 1. Reconstruct transcript — only messages since the previous rotation so
    //    the observer sees new content rather than re-observing the full thread
    //    history on every roll. Duplicate observations across rolls bloat the
    //    observation log and force the reflector to consolidate the same events
    //    repeatedly.
    const prevObservations = this.deps.memoryRepo.findByThread(threadId, 'observation');
    const prevBoundary = prevObservations.isOk()
      ? extractPreviousRotationBoundary(prevObservations.value)
      : null;

    const messagesResult = prevBoundary !== null
      ? this.deps.messageRepo.findLatestByThreadSince(threadId, prevBoundary, 10_000)
      : this.deps.messageRepo.findLatestByThread(threadId, 10_000);

    if (messagesResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: messagesResult.error.message },
        'context-roller-om: failed to read messages, skipping rotation',
      );
      return noRotation;
    }

    const messages = messagesResult.value;
    if (messages.length === 0) {
      this.deps.logger.warn({ threadId }, 'context-roller-om: no messages found, skipping rotation');
      return noRotation;
    }

    // Snapshot boundary — see comment in checkAndRotate above.
    const rotatedThroughTs = messages[messages.length - 1].created_at;

    const transcript = await this.buildObservationTranscript(
      threadId,
      messages,
      threadMetadata,
      channelId,
    );

    // 2. Resolve and call the observer.
    const observerRun = this.deps.resolveSummarizerRun
      ? this.deps.resolveSummarizerRun(observerName)
      : null;
    if (!observerRun) {
      this.deps.logger.error(
        { threadId, observer: observerName },
        'context-roller-om: observer not available, skipping rotation',
      );
      return noRotation;
    }

    const observerResult = await observerRun(threadId, personaId, { transcript });
    if (observerResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: observerResult.error.message },
        'context-roller-om: observation failed, skipping rotation',
      );
      return noRotation;
    }

    const observerData = observerResult.value.data as {
      observations?: Array<{ date: string; time: string; priority: string; text: string }>;
      taskComplete?: boolean;
      currentTask?: string;
      suggestedContinuation?: string;
      memoryUpdates?: Array<{ key: string; value: string; mode: 'append' | 'replace' }>;
    } | undefined;

    const observations = observerData?.observations ?? [];
    if (observations.length === 0) {
      this.deps.logger.warn({ threadId }, 'context-roller-om: observer produced no observations');
      return noRotation;
    }

    // Log compression metrics and priority breakdown.
    const priorityCounts = { high: 0, medium: 0, low: 0 };
    for (const obs of observations) {
      if (obs.priority in priorityCounts) {
        priorityCounts[obs.priority as keyof typeof priorityCounts]++;
      }
    }
    const observerUsage = observerResult.value.usage;
    this.deps.logger.info(
      {
        threadId,
        transcriptChars: transcript.length,
        messageCount: messages.length,
        observationCount: observations.length,
        priorities: priorityCounts,
        currentTask: observerData?.currentTask ?? null,
        suggestedContinuation: observerData?.suggestedContinuation ?? null,
        memoryUpdateCount: observerData?.memoryUpdates?.length ?? 0,
        observerTokens: observerUsage
          ? { input: observerUsage.inputTokens, output: observerUsage.outputTokens }
          : null,
      },
      'context-roller-om: observer completed',
    );

    // Log individual observations at debug level for operator inspection.
    for (const obs of observations) {
      this.deps.logger.debug(
        { threadId, date: obs.date, time: obs.time, priority: obs.priority },
        `context-roller-om: [${obs.priority}] ${obs.text}`,
      );
    }

    // 3. Format observations into the observation log format.
    const priorityEmoji: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };
    const grouped = new Map<string, string[]>();
    for (const obs of observations) {
      const lines = grouped.get(obs.date) ?? [];
      const emoji = priorityEmoji[obs.priority] ?? '🟢';
      lines.push(`- ${emoji} ${obs.time} ${obs.text}`);
      grouped.set(obs.date, lines);
    }
    const newObservationBlock = [...grouped.entries()]
      .map(([date, lines]) => `Date: ${date}\n${lines.join('\n')}`)
      .join('\n\n');

    // 4. Build metadata.
    // `taskComplete` is ALWAYS persisted so downstream consumers can reason
    // about completion state without re-running the observer. Hints
    // (currentTask / suggestedContinuation) are persisted only when the
    // observer flagged the task as incomplete — otherwise a downstream
    // ContextAssembler would surface "Current task:" / "Next step:" lines
    // in the fresh-session prompt even though the prior turn completed
    // (issue #197).
    const taskComplete = observerData?.taskComplete !== false;
    const metadata: Record<string, unknown> = {
      source: 'context-roller-om',
      messageCount: messages.length,
      rotatedThroughTs,
      taskComplete,
      contextUsage,
      createdAt: new Date().toISOString(),
    };
    if (!taskComplete && observerData?.currentTask) {
      metadata.currentTask = observerData.currentTask;
    }
    if (!taskComplete && observerData?.suggestedContinuation) {
      metadata.suggestedContinuation = observerData.suggestedContinuation;
    }

    // 5. Persist: append new observations + process memory updates in a transaction.
    // Use an in-batch accumulator to handle duplicate keys correctly — multiple
    // append entries for the same key in one run should accumulate, not overwrite.
    const pendingUpdates: Array<{ key: string; content: string; type: 'note' }> = [];
    const accumulatedContent = new Map<string, string>();
    if (observerData?.memoryUpdates) {
      for (const update of observerData.memoryUpdates) {
        if (!update.key || !update.value) continue;
        if (update.mode === 'append') {
          // Check in-batch accumulator first, then fall back to DB.
          let existingContent = accumulatedContent.get(update.key);
          if (existingContent === undefined) {
            const existingResult = this.deps.memoryRepo.findById(threadId, update.key);
            existingContent = existingResult.isOk() ? (existingResult.value?.content ?? '') : '';
          }
          const newContent = existingContent ? `${existingContent}\n${update.value}` : update.value;
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

    const observationId = randomUUID();
    const txResult = this.deps.memoryRepo.runInTransaction(() => {
      const insertResult = this.deps.memoryRepo.insert({
        id: observationId,
        thread_id: threadId,
        type: 'observation',
        content: newObservationBlock,
        embedding_ref: null,
        metadata: JSON.stringify(metadata),
      });
      if (insertResult.isErr()) {
        throw new Error(`observation insert: ${insertResult.error.message}`);
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
        'context-roller-om: observation transaction failed',
      );
      return noRotation;
    }

    // 6. Persist pre-roll tail — same as legacy path above.
    this.savePreRollTail(threadId, messages, rotatedThroughTs);

    // 7. Rotate session.
    this.deps.sessionTracker.rotateSession(threadId);

    const compressionRatio = transcript.length > 0
      ? (transcript.length / newObservationBlock.length).toFixed(1)
      : '0';
    this.deps.logger.info(
      {
        threadId,
        observationCount: observations.length,
        transcriptChars: transcript.length,
        observationChars: newObservationBlock.length,
        compressionRatio: `${compressionRatio}x`,
        memoryUpdatesApplied: pendingUpdates.length,
      },
      'context-roller-om: observations appended, session rotated',
    );

    // 7. Check if accumulated observations need reflection (consolidation).
    await this.maybeReflect(threadId, personaId, reflectorName, reflectionThresholdChars);

    // hasOpenThreads gates the stateless-provider auto-"continue" in agent-runner.
    // Fire it only when the observer explicitly flags unfinished work — i.e.
    // taskComplete === false AND a non-empty suggestedContinuation. The
    // `taskComplete` local declared earlier (persisted to metadata) carries
    // the same semantics — reuse it here.
    const suggestedContinuation = (observerData?.suggestedContinuation ?? '').trim();
    const hasOpenThreads = !taskComplete && suggestedContinuation.length > 0;
    return { rotated: true, hasOpenThreads };
  }

  /**
   * Trigger the reflector if accumulated observations exceed the threshold.
   */
  private async maybeReflect(
    threadId: string,
    personaId: string,
    reflectorName: string,
    reflectionThresholdChars: number,
  ): Promise<void> {
    const observationsResult = this.deps.memoryRepo.findByThread(threadId, 'observation');
    if (observationsResult.isErr() || observationsResult.value.length === 0) {
      return;
    }

    const allObservations = observationsResult.value;
    const fullLog = allObservations.map((o) => o.content).join('\n\n');

    if (fullLog.length < reflectionThresholdChars) {
      return;
    }

    this.deps.logger.info(
      { threadId, observationChars: fullLog.length, threshold: reflectionThresholdChars },
      'context-roller-om: observation log exceeds threshold, triggering reflector',
    );

    // Resolve the reflector sub-agent. Try the dedicated reflector resolver
    // first, then fall back to the shared summarizer resolver (all sub-agents
    // are registered in the same resolver in bootstrap).
    const reflectorRun = (this.deps.resolveReflectorRun
      ? this.deps.resolveReflectorRun(reflectorName)
      : null)
      ?? (this.deps.resolveSummarizerRun
        ? this.deps.resolveSummarizerRun(reflectorName)
        : null)
      ?? this.deps.reflectorRun
      ?? null;
    if (!reflectorRun) {
      this.deps.logger.warn(
        { threadId, reflector: reflectorName },
        'context-roller-om: reflector not available, skipping consolidation',
      );
      return;
    }

    const reflectorResult = await reflectorRun(threadId, personaId, { observationLog: fullLog });
    if (reflectorResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: reflectorResult.error.message },
        'context-roller-om: reflection failed, keeping current observations',
      );
      return;
    }

    const consolidated = (reflectorResult.value.data as { consolidatedLog?: string })?.consolidatedLog;
    if (!consolidated || consolidated.trim().length === 0) {
      this.deps.logger.warn({ threadId }, 'context-roller-om: reflector returned empty output');
      return;
    }

    // Carry forward the rotation boundary and continuation hints from the
    // pre-consolidation observations. Without this, the ContextAssembler
    // would fall back to the consolidated observation's own created_at —
    // which is the reflector's write time, not the actual transcript cutoff
    // — and would drop any messages that arrived during reflector latency.
    // Hints come from the newest observation's metadata because that one
    // reflects the most recent rotation state.
    const maxRotatedThroughTs = allObservations.reduce<number | null>((acc, obs) => {
      try {
        const meta = JSON.parse(obs.metadata);
        const ts = Number(meta.rotatedThroughTs);
        if (Number.isFinite(ts)) return acc === null ? ts : Math.max(acc, ts);
      } catch { /* ignore */ }
      return acc;
    }, null);

    // allObservations is DESC by created_at → [0] is newest. Carry forward
    // the newest observation's `taskComplete` flag too so the consolidated
    // observation inherits the current completion state; without it the
    // ContextAssembler would lose the signal after consolidation and
    // could re-surface stale hints.
    let carriedCurrentTask: string | undefined;
    let carriedSuggestedContinuation: string | undefined;
    let carriedTaskComplete: boolean | undefined;
    try {
      const newestMeta = JSON.parse(allObservations[0].metadata);
      if (typeof newestMeta.taskComplete === 'boolean') {
        carriedTaskComplete = newestMeta.taskComplete;
      }
      if (typeof newestMeta.currentTask === 'string' && newestMeta.currentTask.length > 0) {
        carriedCurrentTask = newestMeta.currentTask;
      }
      if (typeof newestMeta.suggestedContinuation === 'string' && newestMeta.suggestedContinuation.length > 0) {
        carriedSuggestedContinuation = newestMeta.suggestedContinuation;
      }
    } catch { /* ignore */ }

    // Replace all existing observations with a single consolidated entry.
    const consolidatedId = randomUUID();
    const txResult = this.deps.memoryRepo.runInTransaction(() => {
      // Delete all existing observations.
      for (const obs of allObservations) {
        const delResult = this.deps.memoryRepo.delete(threadId, obs.id);
        if (delResult.isErr()) {
          throw new Error(`delete observation ${obs.id}: ${delResult.error.message}`);
        }
      }

      const consolidatedMetadata: Record<string, unknown> = {
        source: 'context-roller-om-reflector',
        consolidatedFrom: allObservations.length,
        originalChars: fullLog.length,
        consolidatedChars: consolidated.length,
        createdAt: new Date().toISOString(),
      };
      if (maxRotatedThroughTs !== null) {
        consolidatedMetadata.rotatedThroughTs = maxRotatedThroughTs;
      }
      if (carriedTaskComplete !== undefined) {
        consolidatedMetadata.taskComplete = carriedTaskComplete;
      }
      if (carriedCurrentTask !== undefined) {
        consolidatedMetadata.currentTask = carriedCurrentTask;
      }
      if (carriedSuggestedContinuation !== undefined) {
        consolidatedMetadata.suggestedContinuation = carriedSuggestedContinuation;
      }

      // Insert consolidated observation.
      const insertResult = this.deps.memoryRepo.insert({
        id: consolidatedId,
        thread_id: threadId,
        type: 'observation',
        content: consolidated,
        embedding_ref: null,
        metadata: JSON.stringify(consolidatedMetadata),
      });
      if (insertResult.isErr()) {
        throw new Error(`consolidated insert: ${insertResult.error.message}`);
      }

      return allObservations.length;
    });

    if (txResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: txResult.error.message },
        'context-roller-om: reflection transaction failed',
      );
      return;
    }

    const reflectorReduction = fullLog.length > 0
      ? `${((1 - consolidated.length / fullLog.length) * 100).toFixed(0)}%`
      : '0%';
    this.deps.logger.info(
      {
        threadId,
        consolidatedFrom: allObservations.length,
        originalChars: fullLog.length,
        consolidatedChars: consolidated.length,
        reduction: reflectorReduction,
      },
      'context-roller-om: observations consolidated by reflector',
    );
  }

  private async buildObservationTranscript(
    threadId: string,
    scheduleMessages: MessageRow[],
    threadMetadata?: string | null,
    channelId?: string,
  ): Promise<string> {
    const scheduleTranscript = this.buildTranscript(scheduleMessages, MAX_TRANSCRIPT_CHARS);
    const originExternalId = readScheduleOriginExternalId(threadMetadata);
    if (!originExternalId || !channelId || !this.deps.threadRepo) {
      return scheduleTranscript;
    }

    const conversationThreadResult = this.deps.threadRepo.findByExternalId(channelId, originExternalId);
    if (conversationThreadResult.isErr()) {
      this.deps.logger.debug(
        { threadId, channelId, originExternalId, error: conversationThreadResult.error.message },
        'context-roller-om: failed to load direct conversation thread, continuing with schedule history only',
      );
      return scheduleTranscript;
    }

    const conversationThread = conversationThreadResult.value;
    if (!conversationThread || conversationThread.id === threadId) {
      return scheduleTranscript;
    }

    const conversationMessagesResult = this.deps.messageRepo.findLatestByThread(
      conversationThread.id,
      SCHEDULE_CONTEXT_MESSAGE_LIMIT,
    );
    if (conversationMessagesResult.isErr()) {
      this.deps.logger.debug(
        { threadId, conversationThreadId: conversationThread.id, error: conversationMessagesResult.error.message },
        'context-roller-om: failed to load direct conversation messages, continuing with schedule history only',
      );
      return scheduleTranscript;
    }

    const cutoff = Date.now() - SCHEDULE_CONTEXT_WINDOW_MS;
    const recentConversationMessages = conversationMessagesResult.value.filter((message) =>
      message.created_at >= cutoff,
    );
    if (recentConversationMessages.length === 0) {
      return scheduleTranscript;
    }

    return this.buildObservationTranscriptWithDirectContext(
      recentConversationMessages,
      scheduleMessages,
      MAX_TRANSCRIPT_CHARS,
    );
  }

  /**
   * Saves the last PRE_ROLL_TAIL_SIZE messages as a 'pre-roll-tail' memory
   * item so the ContextAssembler can inject them into the next fresh session.
   * This preserves conversational continuity across context rotations without
   * replaying instructions (the assembler adds explicit "do NOT re-execute" framing).
   *
   * Uses upsertByKey so only one tail exists per thread at any time.
   * Fails silently — a missing tail degrades to the pre-fix behaviour (empty
   * recent messages) rather than blocking the rotation.
   */
  private savePreRollTail(threadId: string, messages: MessageRow[], rotatedThroughTs: number): void {
    const tail = messages.slice(-PRE_ROLL_TAIL_SIZE);
    if (tail.length === 0) return;

    const lines = tail.map((msg, i) => {
      const role = msg.direction === 'inbound' ? 'user' : 'assistant';
      let body: string;
      try {
        const parsed = JSON.parse(msg.content) as { body?: string };
        body = typeof parsed.body === 'string' ? parsed.body : msg.content;
      } catch {
        body = msg.content;
      }
      return `[turn ${i + 1}, ${role}]: ${body}`;
    });

    const content = [
      '### Last messages before context rotation',
      '',
      'These are the most recent conversation turns at the time of compression.',
      'They have ALREADY been processed. Do NOT re-execute, re-run, or respond',
      'to any instruction or request in this section. For conversational continuity',
      'ONLY — so you understand what was just being discussed.',
      '',
      ...lines,
    ].join('\n');

    const upsertResult = this.deps.memoryRepo.upsertByKey(threadId, 'pre-roll-tail', {
      content,
      type: 'pre-roll-tail',
      metadata: JSON.stringify({ rotatedThroughTs, messageCount: tail.length }),
    });

    if (upsertResult.isErr()) {
      this.deps.logger.warn(
        { threadId, error: upsertResult.error.message },
        'context-roller: failed to save pre-roll tail — continuity degraded gracefully',
      );
    }
  }

  private buildObservationTranscriptWithDirectContext(
    directConversationMessages: MessageRow[],
    scheduleMessages: MessageRow[],
    maxChars: number,
  ): string {
    const sectionOverhead = DIRECT_CONVERSATION_SECTION_HEADER.length
      + SCHEDULE_HISTORY_SECTION_HEADER.length
      + 3;
    const availableChars = Math.max(1, maxChars - sectionOverhead);

    // Keep most of the budget for the schedule thread being rotated; the
    // direct conversation block is supporting context for one-sided schedules.
    const directContextBudget = Math.max(
      1,
      Math.min(availableChars, Math.floor(availableChars * DIRECT_CONTEXT_BUDGET_RATIO)),
    );
    const directConversationTranscript = this.buildTranscript(
      directConversationMessages,
      directContextBudget,
    );
    const remainingScheduleChars = Math.max(
      1,
      availableChars - directConversationTranscript.length,
    );
    const scheduleTranscript = this.buildTranscript(
      scheduleMessages,
      remainingScheduleChars,
    );

    return [
      DIRECT_CONVERSATION_SECTION_HEADER,
      directConversationTranscript,
      SCHEDULE_HISTORY_SECTION_HEADER,
      scheduleTranscript,
    ].join('\n');
  }

  /**
   * Reconstruct a human-readable transcript from stored messages,
   * capped at `maxChars` characters. Takes the newest messages first
   * so recent context is always preserved.
   */
  private buildTranscript(messages: MessageRow[], maxChars: number): string {
    // Build lines from newest to oldest, stop when budget is exhausted.
    // Lines are numbered and role-tagged in brackets rather than "User:" /
    // "Assistant:" so downstream LLMs (observer/summarizer/reflector) do not
    // mistake transcript entries for live prompt turns and respond to the
    // most recent "User:" line instead of producing the structured output.
    const entries: { n: number; role: string; body: string }[] = [];
    let totalChars = 0;

    let turnNumber = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const role = msg.direction === 'inbound' ? 'user' : 'assistant';
      let body: string;
      try {
        const parsed = JSON.parse(msg.content);
        body = typeof parsed.body === 'string' ? parsed.body : msg.content;
      } catch {
        body = msg.content;
      }
      const projected = `[turn ${turnNumber}, ${role}]: ${body}`;

      if (totalChars + projected.length > maxChars && entries.length > 0) {
        break;
      }
      entries.push({ n: turnNumber, role, body });
      totalChars += projected.length + 1; // +1 for newline
      turnNumber--;
    }

    // Reverse back to chronological order.
    return entries
      .reverse()
      .map((e) => `[turn ${e.n}, ${e.role}]: ${e.body}`)
      .join('\n');
  }
}
