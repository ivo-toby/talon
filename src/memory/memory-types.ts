/**
 * Type definitions for the per-thread memory subsystem.
 *
 * Defines the layered memory model: transcript (DB messages), working memory
 * (recent window), thread notebook (filesystem files), structured memory
 * (DB memory_items), and vector memory (not implemented in v1).
 */

// ---------------------------------------------------------------------------
// Memory layer enum
// ---------------------------------------------------------------------------

/** Identifies the storage layer a piece of memory comes from. */
export enum MemoryLayer {
  /** Full conversation history stored in the DB messages table. */
  Transcript = 'transcript',
  /** Recent message window injected into agent prompts. */
  WorkingMemory = 'working',
  /** Filesystem files in the thread's memory/ directory (CLAUDE.md, etc.). */
  ThreadNotebook = 'notebook',
  /** Structured facts, summaries, and notes in the DB memory_items table. */
  StructuredMemory = 'structured',
  /** Vector embeddings — not implemented in v1. */
  VectorMemory = 'vector',
}

// ---------------------------------------------------------------------------
// MemoryItem
// ---------------------------------------------------------------------------

/** A single structured memory entry scoped to a thread. */
export interface MemoryItem {
  /** UUID primary key. */
  id: string;
  /** Thread this memory belongs to. */
  threadId: string;
  /** Semantic type of the memory entry. */
  type: 'fact' | 'summary' | 'note' | 'embedding_ref' | 'observation';
  /** Human-readable (or LLM-generated) content. */
  content: string;
  /** Arbitrary key/value metadata (e.g. source run ID, persona name). */
  metadata: Record<string, unknown>;
  /** Unix epoch milliseconds when this item was first created. */
  createdAt: number;
  /** Unix epoch milliseconds when this item was last modified. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// ThreadContext
// ---------------------------------------------------------------------------

/**
 * Fully assembled context for an agent run.
 *
 * Combines all memory layers into a single object that the context builder
 * hands off to the prompt formatter.
 */
export interface ThreadContext {
  /** Recent messages from the DB transcript, oldest-first. */
  transcript: Array<{
    direction: 'inbound' | 'outbound';
    content: string;
    createdAt: number;
  }>;
  /** Notebook files from the thread's memory/ directory — filename -> content. */
  notebookFiles: Record<string, string>;
  /** Structured memory items (facts, summaries, notes) from the DB. */
  structuredMemory: MemoryItem[];
  /** System prompt text for the persona assigned to this thread. */
  personaSystemPrompt: string;
}
