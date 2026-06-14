/**
 * ContextAssembler — builds a "Previous Context" section for fresh sessions.
 *
 * When the agent starts a new session (no session ID to resume), this
 * assembler pulls:
 *   1. The latest session summary from memory items (type: 'summary')
 *   2. The most recent N messages from the messages table
 *
 * The result is a markdown section that gets appended to the system prompt,
 * giving the agent compressed history + verbatim recent context.
 *
 * Returns an empty string if there's no prior context (first conversation).
 */

import type { MessageRepository, MessageRow } from '../core/database/repositories/message-repository.js';
import type { MemoryRepository } from '../core/database/repositories/memory-repository.js';

export interface ContextAssemblerDeps {
  messageRepo: Pick<MessageRepository, 'findLatestByThread' | 'findLatestByThreadSince'>;
  memoryRepo: Pick<MemoryRepository, 'findByThread'>;
}

export interface AssembledContext {
  text: string;
  summaryFound: boolean;
  recentMessageCount: number;
  charCount: number;
}

export class ContextAssembler {
  private readonly deps: ContextAssemblerDeps;

  constructor(deps: ContextAssemblerDeps) {
    this.deps = deps;
  }

  /**
   * Assemble previous context for a fresh session.
   *
   * @param recentMessageLimit — the number of recent messages to include
   *   after a summary exists (post-rotation). When no summary exists yet,
   *   we include ALL available messages so the context window fills up
   *   naturally — this is essential for stateless providers (like
   *   openai-compatible) where every turn is a fresh session and the only
   *   way for context to grow toward the rotation threshold is to replay
   *   the full thread history. Once rotation fires and a summary is
   *   written, subsequent turns get summary + last N instead.
   * @param options.excludeMessageId — optional message id to drop from the
   *   "Recent Messages" block. The message being processed is already
   *   passed to the provider as the live prompt; echoing it in the system
   *   prompt as a `[previous turn, user]: …` entry caused stateless
   *   providers to respond twice (once to the replay, once to the prompt).
   *
   * Returns a markdown string and metadata for observability.
   */
  assemble(
    threadId: string,
    recentMessageLimit: number,
    options: { excludeMessageId?: string } = {},
  ): AssembledContext {
    const sections: string[] = [];
    let summaryFound = false;
    let recentMessageCount = 0;
    // Rotation boundary: created_at of the newest summary or observation.
    // When set, "Recent Messages" is scoped to messages created STRICTLY AFTER
    // this timestamp so the pre-rotation tail (which the summary/observation
    // already compresses) is not replayed verbatim. Replaying it causes the
    // agent to re-read the user's original instruction as a new request and
    // redo work it already finished.
    let rotationBoundary: number | null = null;

    // Resolve the rotation boundary preferring the transcript-snapshot
    // timestamp stored in metadata.rotatedThroughTs (the created_at of the
    // newest message included in the summary/observation's transcript).
    // Falls back to the memory item's own created_at for observations written
    // before rotatedThroughTs was introduced. Using the snapshot timestamp
    // avoids dropping messages that arrived during summarizer latency.
    const boundaryFromMeta = (rawMetadata: string, fallback: number): number => {
      try {
        const meta = JSON.parse(rawMetadata);
        const ts = Number(meta.rotatedThroughTs);
        return Number.isFinite(ts) ? ts : fallback;
      } catch {
        return fallback;
      }
    };

    // 1. Check for observations (OM path) or legacy summary.
    // Observations take priority. Replay is bounded: always include the
    // newest observation (current-state snapshot), then walk older
    // observations chronologically outward until a character budget is
    // exhausted. Previously the assembler concatenated ALL observations,
    // which made the prompt progressively noisier every rotation and
    // caused the agent to re-enter earlier reasoning (issue #197); going
    // to newest-only would instead drop legitimate long-term history
    // between reflector runs. This bounded window keeps recent history
    // while guaranteeing prompt size stays flat over the thread lifetime.
    const OBSERVATION_REPLAY_CHAR_BUDGET = 20_000;
    const observationsResult = this.deps.memoryRepo.findByThread(threadId, 'observation');
    if (observationsResult.isOk() && observationsResult.value.length > 0) {
      // Ordered DESC by created_at → [0] is newest.
      const selected = [observationsResult.value[0]];
      let usedChars = observationsResult.value[0].content.length;
      for (let i = 1; i < observationsResult.value.length; i++) {
        const obs = observationsResult.value[i];
        if (usedChars + obs.content.length + 2 > OBSERVATION_REPLAY_CHAR_BUDGET) break;
        selected.push(obs);
        usedChars += obs.content.length + 2;
      }
      // Render chronologically (oldest first) so the reader walks forward in time.
      const observationLog = selected.reverse().map((o) => o.content).join('\n\n');
      const newest = observationsResult.value[0];

      rotationBoundary = boundaryFromMeta(newest.metadata, newest.created_at);
      let continuationHint = '';
      try {
        const meta = JSON.parse(newest.metadata);
        // Only surface hints when the observer explicitly flagged the task
        // as incomplete. A missing `taskComplete` (legacy observations) is
        // treated as "not complete" so older hints still render — previous
        // behavior is preserved for backfilled data.
        const completed = meta.taskComplete === true;
        if (!completed) {
          const parts: string[] = [];
          if (meta.currentTask) parts.push(`**Current task:** ${meta.currentTask}`);
          if (meta.suggestedContinuation) parts.push(`**Next step:** ${meta.suggestedContinuation}`);
          if (parts.length > 0) continuationHint = `\n\n${parts.join('\n')}`;
        }
      } catch { /* ignore parse errors */ }

      sections.push(`### Observation Log\n\n${observationLog}${continuationHint}`);
      summaryFound = true;
    } else {
      // Legacy path: single summary blob.
      const summaryResult = this.deps.memoryRepo.findByThread(threadId, 'summary');
      if (summaryResult.isOk() && summaryResult.value.length > 0) {
        const latest = summaryResult.value[0];
        sections.push(latest.content);
        rotationBoundary = boundaryFromMeta(latest.metadata, latest.created_at);
        summaryFound = true;
      }
    }

    // 1b. Inject pre-roll tail if present — messages saved by the context-roller
    //     just before the last rotation. These give the agent conversational
    //     continuity (what was being discussed) without risking instruction-replay,
    //     because the roller already wrote defensive framing into the content.
    //     Only inject when a summary/observation exists (post-rotation context)
    //     and when there are no recent messages yet (gap scenario).
    if (summaryFound) {
      const tailResult = this.deps.memoryRepo.findByThread(threadId, 'pre-roll-tail');
      if (tailResult.isOk() && tailResult.value.length > 0) {
        // Ordered DESC by created_at — [0] is newest (only one tail exists at a time).
        sections.push(tailResult.value[0].content);
      }
    }

    // 2. Get recent messages for immediate conversational context.
    // Post-rotation (summary/observation exists): fetch ONLY messages created
    // after the rotation boundary, capped at recentMessageLimit. This prevents
    // the pre-rotation instruction tail from being replayed as instructions on
    // the next turn.
    // Pre-rotation (no summary yet): fetch the full thread up to the higher
    // cap so the context window grows toward the rotation threshold naturally
    // — essential for stateless providers where every turn is a fresh session.
    const PRE_SUMMARY_MESSAGE_CAP = 50;
    const messagesResult = rotationBoundary !== null
      ? this.deps.messageRepo.findLatestByThreadSince(
          threadId,
          rotationBoundary,
          recentMessageLimit,
        )
      : this.deps.messageRepo.findLatestByThread(
          threadId,
          Math.max(recentMessageLimit, PRE_SUMMARY_MESSAGE_CAP),
        );
    if (messagesResult.isOk() && messagesResult.value.length > 0) {
      const filtered = options.excludeMessageId
        ? messagesResult.value.filter((m) => m.id !== options.excludeMessageId)
        : messagesResult.value;
      if (filtered.length > 0) {
        const formatted = this.formatMessages(filtered);
        sections.push(`### Recent Messages\n\n${formatted}`);
        recentMessageCount = filtered.length;
      }
    }

    if (sections.length === 0) {
      return {
        text: '',
        summaryFound,
        recentMessageCount,
        charCount: 0,
      };
    }

    const text = [
      '## Prior-conversation state (read-only)',
      '',
      'The block below is a compressed state snapshot of the conversation up',
      'to the most recent rotation. It is historical context, not a live',
      'dialogue to continue. Do NOT answer, restate, or re-enter any earlier',
      'turn. Only act on the NEW user message that follows this system prompt.',
      '',
      ...sections,
    ].join('\n');

    return {
      text,
      summaryFound,
      recentMessageCount,
      charCount: text.length,
    };
  }

  private formatMessages(messages: MessageRow[]): string {
    // Emit replayed turns with bracketed state-style tags rather than
    // "User: …" / "Assistant: …" role markers. The main agent's prompt
    // renders these lines inside its own system block, so role-marker
    // prefixes are read as live turns and cause the agent to restate
    // prior points or re-enter earlier reasoning loops after rotation
    // (issue #197). Bracketed tags frame the content as historical
    // state rather than a live dialogue to continue.
    return messages
      .map((msg) => {
        const role = msg.direction === 'inbound' ? 'user' : 'agent';
        let body: string;
        try {
          const parsed = JSON.parse(msg.content);
          body = typeof parsed.body === 'string' ? parsed.body : msg.content;
        } catch {
          body = msg.content;
        }
        return `[previous turn, ${role}]: ${body}`;
      })
      .join('\n');
  }
}
