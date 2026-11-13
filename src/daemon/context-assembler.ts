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
import type { ImageDescriptor } from '../images/image-types.js';
import type { Finding } from '../images/finding-types.js';
import {
  IMAGE_CONTEXT_BUDGET,
  IMAGE_CONTEXT_FRAMING,
  renderImageDescriptor,
  renderFinding,
} from '../images/image-context-projection.js';

export interface ContextAssemblerDeps {
  messageRepo: Pick<MessageRepository, 'findLatestByThread' | 'findLatestByThreadSince'>;
  memoryRepo: Pick<MemoryRepository, 'findByThread'>;
}

// ---------------------------------------------------------------------------
// Image-aware context (ADR-0002: docs/adr/0002-image-context-placement.md)
//
// Placement contract:
// - Current-message Image descriptors are appended to the LIVE provider prompt
//   once, with their message (`renderLiveImageDescriptors`). Provider history
//   then contains them naturally; resumed turns never repeat an inventory.
// - The full Image descriptor inventory and Finding projections are built ONLY
//   when foreground history is injected into a FRESH session (here) or for
//   context rotation (ContextRoller). Resumed sessions discover older
//   Images/Findings through the capability-gated `image_lookup` tool.
// - Live and fresh-history descriptors share ONE count/character budget
//   (newest 20 descriptors, ≤1 000 chars each, ≤8 000 aggregate), consumed
//   live-first. The Finding budget (newest 10, ≤2 000 each, ≤8 000 aggregate)
//   is separate; both count toward the enclosing context budget. All limits
//   are the frozen TASK-015 literals in IMAGE_CONTEXT_BUDGET.
// ---------------------------------------------------------------------------

/**
 * Refreshed raw material for image-aware context injection.
 *
 * Implemented by the daemon wiring against the TASK-001 `ImageAccess` port and
 * the canonical Finding store. Contract for every method:
 * - Thread-scoped: only the requesting thread's records are returned.
 * - Availability is REFRESHED before descriptors are returned (expiry first,
 *   then file existence), exactly as `ImageAccess.resolveImage` does.
 * - `processing` descriptors are internal; callers filter them defensively,
 *   but implementations should not return them from listings.
 * - Queries are INDEPENDENT of any message-rotation cutoff: Images and
 *   Findings that predate the newest summary, Findings from failed runs, and
 *   Findings that arrive while a summarizer is running must all be visible.
 * - Never returns pixel bytes, local paths, staging references, or download
 *   credentials (descriptors and Findings carry none by construction).
 */
export interface ImageContextSource {
  /** Images owned by one (thread, message), source order, refreshed. */
  resolveMessageDescriptors(request: {
    threadId: string;
    messageId: string;
  }): Promise<ImageDescriptor[]>;
  /** The thread's non-Processing Image descriptor inventory, refreshed. */
  listThreadDescriptors(threadId: string): Promise<ImageDescriptor[]>;
  /** The thread's canonical Findings, independent of message cutoffs. */
  listThreadFindings(threadId: string): Promise<Finding[]>;
}

/** Section header of the live current-message descriptor block. */
export const LIVE_IMAGE_SECTION_HEADER =
  '[Images attached to this message; state shown is current at delivery]';

/**
 * The live descriptor block rendered for one image-bearing message, plus the
 * budget it consumed. Passing this block into {@link projectImageHistory} is
 * what makes the shared descriptor budget live-first: the fresh inventory
 * skips these Image IDs and fills only the remaining count/characters.
 */
export interface LiveImageDescriptorBlock {
  /** Rendered block appended after the stored message text; '' when empty. */
  text: string;
  /** Selected Image IDs in source order (excluded from fresh inventory). */
  imageIds: string[];
  selectedCount: number;
  /** Characters consumed from the shared aggregate (includes the header). */
  consumedChars: number;
  omittedCount: number;
}

export const EMPTY_LIVE_BLOCK: LiveImageDescriptorBlock = Object.freeze({
  text: '',
  imageIds: [],
  selectedCount: 0,
  consumedChars: 0,
  omittedCount: 0,
});

/** Non-Processing descriptors in stable source order (message ordinal). */
export function orderLiveDescriptors(
  descriptors: readonly ImageDescriptor[],
  threadId: string,
): ImageDescriptor[] {
  return descriptors
    .filter((d) => d.threadId === threadId && d.state !== 'processing')
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Render the current-message descriptor block for the LIVE provider prompt.
 *
 * Entries follow source order and consume the shared descriptor budget first
 * (count ≤ {@link IMAGE_CONTEXT_BUDGET}.descriptorMaxCount, per-entry ≤
 * descriptorMaxChars via {@link renderImageDescriptor}, aggregate ≤
 * descriptorAggregateChars including this header and any omission notice).
 * Entries that no longer fit are omitted whole — never clipped IDs/state —
 * and remain discoverable through the fresh inventory or `image_lookup`.
 * The omission notice names `image_lookup` only when `imageLookupExposed`
 * reflects the persona's actual filtered tool exposure.
 *
 * The live block additionally reserves the maximum fixed text the history
 * projection (`projectImageHistory`) can emit for the same exposure — its
 * section headers plus its omission notice — so the COMBINED live + inventory
 * aggregate can never exceed `descriptorAggregateChars`, even when the
 * inventory side has entries but no room renders them (its framing and
 * omission notice are still emitted).
 */
export function renderLiveImageDescriptors(
  descriptors: readonly ImageDescriptor[],
  imageLookupExposed: boolean,
): LiveImageDescriptorBlock {
  const budget = IMAGE_CONTEXT_BUDGET;
  const framing = IMAGE_CONTEXT_FRAMING;
  const omissionNotice = imageLookupExposed
    ? framing.imageOmissionNoticeWithLookup
    : framing.imageOmissionNotice;

  // Maximum fixed history-side framing under the same exposure: section
  // headers + its omission notice + their separators.
  const historyFramingReserve =
    framing.imageSectionHeader.length + 1 + framing.inventorySectionHeader.length + 1 + omissionNotice.length + 1;

  // Reserve the live header, the worst-case omission notice, and the
  // history-side fixed framing above, all before any entry.
  let remaining =
    budget.descriptorAggregateChars -
    (LIVE_IMAGE_SECTION_HEADER.length + 2 + omissionNotice.length + 1) -
    historyFramingReserve;
  let countLeft = budget.descriptorMaxCount;
  const lines: string[] = [];
  const imageIds: string[] = [];
  let omitted = 0;

  for (const descriptor of descriptors) {
    if (countLeft <= 0) {
      omitted += 1;
      continue;
    }
    const cap = Math.min(budget.descriptorMaxChars, remaining - 1);
    const line = cap >= 0 ? renderImageDescriptor(descriptor, cap) : null;
    if (line === null) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    imageIds.push(descriptor.imageId);
    remaining -= line.length + 1;
    countLeft -= 1;
  }

  if (lines.length === 0) {
    return EMPTY_LIVE_BLOCK;
  }
  const sections = [`${LIVE_IMAGE_SECTION_HEADER}\n${lines.join('\n')}`];
  if (omitted > 0) {
    sections.push(omissionNotice);
  }
  const text = sections.join('\n');
  return {
    text,
    imageIds,
    selectedCount: lines.length,
    consumedChars: text.length + 1,
    omittedCount: omitted,
  };
}

/**
 * Bounded Image/Finding history projection for fresh-session replay and
 * context rotation. Mirrors `projectImageContext`
 * (src/images/image-context-projection.ts) but emits ONLY the inventory and
 * Findings sections: the live current-message lines are delivered separately
 * with their message and are excluded here by {@link
 * LiveImageDescriptorBlock.imageIds}.
 *
 * The live block's count/character consumption is subtracted from the shared
 * descriptor budget first (live-first priority); remaining inventory entries
 * are selected newest-first (receipt descending, then ID ascending). Findings
 * keep their separate budget: selected newest-first, presented
 * chronologically. Framing and omission notices count toward the aggregates;
 * the notice names `image_lookup` only when actually exposed. Returns ''
 * when there is nothing to project and nothing was omitted.
 */
export function projectImageHistory(request: {
  live: LiveImageDescriptorBlock;
  inventoryDescriptors: readonly ImageDescriptor[];
  findings: readonly Finding[];
  imageLookupExposed: boolean;
}): string {
  const budget = IMAGE_CONTEXT_BUDGET;
  const framing = IMAGE_CONTEXT_FRAMING;
  const imageNotice = request.imageLookupExposed
    ? framing.imageOmissionNoticeWithLookup
    : framing.imageOmissionNotice;
  const liveIds = new Set(request.live.imageIds);

  const inventory = request.inventoryDescriptors
    .filter((d) => d.state !== 'processing' && !liveIds.has(d.imageId))
    .sort((a, b) => {
      if (b.receivedAt !== a.receivedAt) return b.receivedAt - a.receivedAt;
      return a.imageId < b.imageId ? -1 : 1;
    });

  // Shared budget, live consumed first. Reserve the exact framing this
  // projection emits (section headers + the exposure-matching notice).
  let remaining =
    request.live.consumedChars > 0
      ? budget.descriptorAggregateChars - request.live.consumedChars
      : budget.descriptorAggregateChars;
  remaining -=
    framing.imageSectionHeader.length +
    1 +
    framing.inventorySectionHeader.length +
    1 +
    imageNotice.length +
    1;
  let countLeft = Math.max(0, budget.descriptorMaxCount - request.live.selectedCount);

  const inventoryLines: string[] = [];
  let omittedImages = 0;
  for (const descriptor of inventory) {
    if (countLeft <= 0) {
      omittedImages += 1;
      continue;
    }
    const cap = Math.min(budget.descriptorMaxChars, remaining - 1);
    const line = cap >= 0 ? renderImageDescriptor(descriptor, cap) : null;
    if (line === null) {
      omittedImages += 1;
      continue;
    }
    inventoryLines.push(line);
    remaining -= line.length + 1;
    countLeft -= 1;
  }

  let descriptorsText = '';
  if (inventoryLines.length > 0 || omittedImages > 0) {
    const lines: string[] = [framing.imageSectionHeader];
    if (inventoryLines.length > 0) {
      lines.push(framing.inventorySectionHeader, ...inventoryLines);
    }
    if (omittedImages > 0) {
      lines.push(imageNotice);
    }
    descriptorsText = `${lines.join('\n')}\n`;
  }

  // Findings: separate budget, selected newest-first, presented
  // chronologically — identical policy to projectImageContext.
  const candidates = [...request.findings].sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.findingId < b.findingId ? -1 : 1;
  });
  let findingsRemaining =
    budget.findingAggregateChars -
    (framing.findingSectionHeader.length +
      1 +
      framing.findingOmissionNoticeWithLookup.length +
      1);
  let findingCountLeft = budget.findingMaxCount;
  const selected: Array<{ finding: Finding; block: string }> = [];
  for (const finding of candidates) {
    if (findingCountLeft <= 0) {
      continue;
    }
    const cap = Math.min(budget.findingMaxChars, findingsRemaining - 1);
    const block = cap >= 0 ? renderFinding(finding, cap) : null;
    if (block === null) {
      continue;
    }
    selected.push({ finding, block });
    findingsRemaining -= block.length + 1;
    findingCountLeft -= 1;
  }
  const omittedFindings = request.findings.length - selected.length;

  let findingsText = '';
  if (selected.length > 0 || omittedFindings > 0) {
    selected.sort((a, b) => {
      if (a.finding.createdAt !== b.finding.createdAt) {
        return a.finding.createdAt - b.finding.createdAt;
      }
      return a.finding.findingId < b.finding.findingId ? -1 : 1;
    });
    const lines: string[] = [framing.findingSectionHeader, ...selected.map((entry) => entry.block)];
    if (omittedFindings > 0) {
      lines.push(
        request.imageLookupExposed
          ? framing.findingOmissionNoticeWithLookup
          : framing.findingOmissionNotice,
      );
    }
    findingsText = `${lines.join('\n')}\n`;
  }

  return [descriptorsText, findingsText].filter((section) => section.length > 0).join('\n\n');
}

/** Image replay material supplied by the caller (AgentRunner) per run. */
export interface AssembleImageContext {
  /** Live block already appended to the prompt for this run's message. */
  live: LiveImageDescriptorBlock;
  /** Refreshed current-thread inventory (live IDs excluded by projection). */
  inventoryDescriptors: readonly ImageDescriptor[];
  /** Canonical current-thread Findings (independent of message cutoffs). */
  findings: readonly Finding[];
  /** Actual `image_lookup` exposure from the persona's filtered tool set. */
  imageLookupExposed: boolean;
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
    options: { excludeMessageId?: string; images?: AssembleImageContext } = {},
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

    // 3. Image descriptor inventory + Finding projections (fresh sessions
    // only — this assembler is never consulted on resumed turns). Raw
    // material is fetched by the caller; this stays a synchronous, pure
    // projection within the shared live-first budgets (ADR-0002).
    if (options.images) {
      const imageSection = projectImageHistory(options.images);
      if (imageSection.length > 0) {
        sections.push(imageSection);
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
