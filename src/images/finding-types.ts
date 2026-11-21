/**
 * Shared Finding vocabulary: the canonical Finding DTO and its reported-usage
 * shape.
 *
 * These are contracts only — no storage, vision runtime, or lookup transport
 * lives here. The persistence port is `FindingRepository`
 * (src/core/database/repositories/finding-repository.ts); projections and the
 * `image.lookup` tool consume the DTO below.
 *
 * Terminology (see CONTEXT.md):
 * - An **Inspection** is a question submitted to the vision subagent about one
 *   or more Images in the current conversation thread.
 * - A **Finding** is the recorded answer of a successful Inspection, including
 *   its question, referenced Image IDs, extracted text, and uncertainty. A
 *   Finding remains available after the referenced Images' Normalized files
 *   become unavailable.
 *
 * A Finding is exact, not a summary: `answer`, `extractedText`, and
 * `uncertainty` are stored and returned verbatim. Absent optional fields mean
 * the producing model reported nothing — they are never invented, defaulted,
 * or guessed. A Finding carries no pixel bytes, local paths, staging
 * references, or media credentials, and it never exists as a synthetic message:
 * canonical Findings live in their own durable store, not in message or
 * `tool_results` history.
 */

// ---------------------------------------------------------------------------
// Reported usage
// ---------------------------------------------------------------------------

/**
 * Token usage exactly as the producing model reported it.
 *
 * Each field is a non-negative integer count, or absent when the model did not
 * report that counter. Absent means unknown — usage is never estimated,
 * extrapolated, or fabricated.
 */
export interface FindingTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ---------------------------------------------------------------------------
// Canonical Finding
// ---------------------------------------------------------------------------

/**
 * One canonical Finding: the recorded result of a single successful Inspection.
 *
 * - `findingId` is globally unique; it is addressed without knowing the thread,
 *   message, or queue state.
 * - `threadId` and `runId` are trusted provenance supplied by Talon's tool
 *   context, never extracted from model output.
 * - `imageIds` are the source Images in the order the Inspection listed them.
 *   The Findings of Rejected or Unavailable Images stay readable: availability
 *   is an Image property and never gates Finding retrieval.
 * - `createdAt` is Unix epoch milliseconds on Talon's local clock at durable
 *   admission of the Finding — the chronological key every Finding listing and
 *   keyset pagination sorts by (creation descending, then id ascending).
 * - `modelName` is the winning model: the vision-chain entry whose attempt
 *   actually produced this answer, which may differ from the run's foreground
 *   model.
 */
export interface Finding {
  /** Globally unique Finding ID. */
  findingId: string;
  /** The single conversation thread that owns this Finding. */
  threadId: string;
  /** The run whose trusted tool context carried the Inspection. */
  runId: string;
  /** Source Image IDs in the Inspection's own order. Nonempty and distinct. */
  imageIds: readonly string[];
  /** The Inspection question, verbatim. Nonempty. */
  question: string;
  /** The winning model's answer, verbatim. Nonempty. */
  answer: string;
  /** Text the model reported extracting from the Images; absent means none. */
  extractedText?: string;
  /**
   * The model's own uncertainty statement, verbatim. Absent means the model
   * reported none. There is deliberately no closed enum here: the contract
   * defines no fixed uncertainty vocabulary, and inventing one would restate
   * the model's words as something it never said.
   */
  uncertainty?: string;
  /** Unix epoch milliseconds of durable creation on the local clock. */
  createdAt: number;
  /** The vision model that actually produced this answer (winning attempt). */
  modelName: string;
  /** Reported token usage; absent fields are unknown, never zero-filled. */
  usage?: FindingTokenUsage;
}
