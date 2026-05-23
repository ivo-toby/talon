/**
 * Talon-local A2A type definitions.
 *
 * These interfaces normalize what Talon needs from the A2A protocol without
 * leaking raw SDK types throughout the daemon. The SDK types from @a2a-js/sdk
 * are used at the transport boundary (server/client) but internal code uses
 * these stable Talon types.
 */

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

/** Maps a loaded persona to an A2A-discoverable agent card. */
export interface A2AAgentCard {
  /** Stable ID derived from persona name. */
  id: string;
  /** Display name for the persona. */
  name: string;
  /** Short description from persona frontmatter or generated fallback. */
  description: string;
  /** Internal route path, e.g. /a2a/agents/software-engineer */
  url: string;
  /** Protocol version. */
  version: string;
  /** Skills this persona has registered. */
  skills: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  /** Supported input content types (M1: text only). */
  defaultInputModes: string[];
  /** Supported output content types (M1: text only). */
  defaultOutputModes: string[];
  /** Talon-specific metadata about the underlying persona. */
  metadata: {
    personaName: string;
    model: string;
    systemPromptFile?: string;
    skills: string[];
    capabilities: {
      allow: string[];
      requireApproval: string[];
    };
    internalOnly: true;
  };
}

// ---------------------------------------------------------------------------
// Task Payload (stored in QueueItem.payload)
// ---------------------------------------------------------------------------

/** Payload stored in the collaboration queue item for A2A tasks. */
export interface A2ATaskPayload {
  /** Discriminant to distinguish A2A tasks from other collaboration items. */
  kind: 'a2a_task';
  /** The A2A task ID (also the a2a_tasks row primary key). */
  taskId: string;
  /** The persona that originated this task. */
  sourcePersona: string;
  /** The persona that should execute this task. */
  targetPersona: string;
  /** The thread context in which this task runs. */
  sourceThreadId: string;
  /** DB ID of the target persona (for AgentRunner lookup). */
  personaId: string;
  /** Normalized text body of the task. */
  content: string;
  /** Optional message ID for context threading. */
  messageId?: string;
  /** Parent task ID for tracing delegation chains. */
  parentTaskId?: string;
  /** Current hop depth in the delegation chain. */
  hopCount: number;
  /** Unix epoch ms when this task was submitted. */
  submittedAt: number;
  /** Task routing and control metadata. */
  metadata: {
    agentCardId: string;
    traceId?: string;
    maxHops: number;
    queueType: 'collaboration';
  };
}

// ---------------------------------------------------------------------------
// Task Status
// ---------------------------------------------------------------------------

/** A2A task lifecycle states. */
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Durable status record for an A2A task. */
export interface A2ATaskStatus {
  taskId: string;
  state: A2ATaskState;
  sourcePersona: string;
  targetPersona: string;
  threadId: string;
  queueItemId?: string;
  runId?: string;
  submittedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: {
    text: string;
  };
  error?: {
    code: string;
    message: string;
  };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  };
}

// ---------------------------------------------------------------------------
// Database row (internal)
// ---------------------------------------------------------------------------

/** Raw database row for the a2a_tasks table. */
export interface A2ATaskRow {
  id: string;
  source_persona: string;
  target_persona: string;
  thread_id: string;
  queue_item_id: string | null;
  run_id: string | null;
  state: A2ATaskState;
  request_payload: string; // JSON: A2ATaskPayload
  result_payload: string | null; // JSON: { text: string }
  error_code: string | null;
  error_message: string | null;
  hop_count: number;
  parent_task_id: string | null;
  submitted_at: number;
  updated_at: number;
  completed_at: number | null;
}

// ---------------------------------------------------------------------------
// Constants — default A2A limits
// ---------------------------------------------------------------------------
//
// These are the built-in defaults used when no `a2a:` block is present in
// talond.yaml. They are also the source of truth for `A2AConfigSchema`'s
// defaults in `core/config/config-schema.ts` — keep them in sync.

/** Default maximum hop count before rejecting a task to prevent infinite loops. */
export const MAX_HOPS = 4;

/** Default maximum number of concurrent active A2A tasks per target persona. */
export const MAX_CONCURRENT_PER_TARGET = 1;

/** Default max queue retry attempts for A2A collaboration items. */
export const DEFAULT_A2A_MAX_ATTEMPTS = 3;

/** Runtime A2A limits resolved from config. Defaults mirror the constants above. */
export interface A2ALimits {
  maxHops: number;
  maxConcurrentPerTarget: number;
  maxAttempts: number;
}

/** Returns A2ALimits populated with the built-in defaults. */
export function defaultA2ALimits(): A2ALimits {
  return {
    maxHops: MAX_HOPS,
    maxConcurrentPerTarget: MAX_CONCURRENT_PER_TARGET,
    maxAttempts: DEFAULT_A2A_MAX_ATTEMPTS,
  };
}
