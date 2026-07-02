/**
 * Core type definitions for the Talon sub-agent system.
 *
 * Sub-agents are lightweight, single-purpose AI agents that the main daemon
 * can spawn to handle specific tasks (e.g. memory grooming, summarisation,
 * content generation). Each sub-agent is a directory containing a manifest
 * (subagent.yaml), prompt fragments, and a run function.
 *
 * Sub-agents run inside the daemon process but with their own model instance,
 * system prompt, and capability-gated service access.
 */

import type { Result } from 'neverthrow';
import type { LanguageModel } from 'ai';
import type { JSONObject } from '@ai-sdk/provider';
import type pino from 'pino';
import type { SubAgentError } from '../core/errors/error-types.js';
import type { MemoryRepository } from '../core/database/repositories/memory-repository.js';
import type { ScheduleRepository } from '../core/database/repositories/schedule-repository.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { MessageRepository } from '../core/database/repositories/message-repository.js';
import type { RunRepository } from '../core/database/repositories/run-repository.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * The parsed contents of a sub-agent's `subagent.yaml` manifest file.
 *
 * Declares metadata, model configuration, capability requirements, and
 * operational constraints for a single sub-agent.
 */
export interface SubAgentManifest {
  /** Unique sub-agent identifier (e.g. `memory-groomer`, `summariser`). */
  name: string;
  /** Semantic version string (e.g. `0.1.0`). */
  version: string;
  /** Human-readable description of what this sub-agent does. */
  description: string;
  /** Model configuration for this sub-agent. */
  model: {
    /** AI provider identifier (e.g. `anthropic`, `openai`, `google`). */
    provider: string;
    /** Model name as understood by the provider (e.g. `claude-haiku-4-5-20251001`). */
    name: string;
    /** Maximum output tokens per generation. */
    maxTokens: number;
  };
  /**
   * Capability labels required for this sub-agent to run.
   * Labels follow the pattern `<domain>.<action>:<scope>` or
   * `<domain>.<action>`.
   */
  requiredCapabilities: string[];
  /** Filesystem paths that the sub-agent is allowed to access. */
  rootPaths: string[];
  /** Maximum wall-clock time (ms) before the sub-agent run is aborted. */
  timeoutMs: number;
  /** Environment variables that must be set for this sub-agent to load. */
  requiresEnv: string[];
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Repository and infrastructure services injected into a sub-agent at runtime.
 *
 * All repositories are provided — the capability check happens at the runner
 * level (before invocation), not at the type level. Sub-agents are authored
 * code, so we trust them to use only what they declared in their manifest.
 * Docker sandboxing (Phase 4) adds the hard isolation layer.
 */
export interface SubAgentServices {
  /** Thread-scoped memory (facts, summaries, notes). */
  memory: MemoryRepository;
  /** Cron/interval/one-shot schedule management. */
  schedules: ScheduleRepository;
  /** Persona configuration and metadata. */
  personas: PersonaRepository;
  /** Channel configuration and metadata. */
  channels: ChannelRepository;
  /** Conversation thread state. */
  threads: ThreadRepository;
  /** Per-thread message history. */
  messages: MessageRepository;
  /** Agent run tracking and token accounting. */
  runs: RunRepository;
  /** Durable message queue. */
  queue: QueueRepository;
  /** Structured logger scoped to the sub-agent. */
  logger: pino.Logger;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The runtime context provided to a sub-agent's run function.
 *
 * Contains everything the sub-agent needs to execute: the resolved model
 * instance, a system prompt assembled from prompt fragments, and access
 * to the injected services.
 */
export interface SubAgentContext {
  /** The thread this sub-agent run is associated with. */
  threadId: string;
  /** The persona that triggered (or owns) this sub-agent run. */
  personaId: string;
  /** Assembled system prompt built from the sub-agent's prompt fragments. */
  systemPrompt: string;
  /** Resolved AI SDK model instance ready for generation. */
  model: LanguageModel;
  /** Maximum output tokens per generation (from config override or manifest's model.maxTokens). */
  maxOutputTokens: number;
  /** Filesystem paths the sub-agent is allowed to access, from the manifest. */
  rootPaths: string[];
  /** Injected repository and infrastructure services. */
  services: SubAgentServices;
  /**
   * OTEL telemetry config forwarded to AI SDK `experimental_telemetry`.
   * When `isEnabled` is true, `generateText`/`generateObject` calls emit child
   * spans that appear under the parent `subagent:<name>` observation in LangFuse.
   * The AI SDK uses the ambient OTEL context (AsyncLocalStorage), so no
   * traceparent needs to be threaded manually — just enabling it is enough.
   */
  telemetry: { isEnabled: boolean };
  /**
   * Abort signal from the runner's timeout controller.
   * Sub-agents should pass this to AI SDK calls (`generateText`, `generateObject`)
   * so that timed-out requests are cancelled promptly, enabling failover.
   */
  abortSignal?: AbortSignal;
  /**
   * Provider-specific options to forward to the AI SDK call, keyed by provider
   * name. Comes from the active model entry's `providerOptions` in the subagent
   * override config, wrapped under that entry's provider name. Example shape:
   *   { ollama: { chat_template_kwargs: { enable_thinking: false } } }
   * Subagents should forward this verbatim to generateText / generateObject.
   */
  providerOptions?: Record<string, JSONObject>;
}

// ---------------------------------------------------------------------------
// Input / Output
// ---------------------------------------------------------------------------

/** Arbitrary key-value input passed to a sub-agent run. */
export interface SubAgentInput {
  [key: string]: unknown;
}

/**
 * The result returned by a sub-agent after successful execution.
 *
 * Every successful run must provide a human-readable summary.
 * Structured data and token usage are optional.
 */
export interface SubAgentResult {
  /** Human-readable summary of what the sub-agent accomplished. */
  summary: string;
  /** Optional structured data produced by the sub-agent. */
  data?: Record<string, unknown>;
  /** Optional token usage and cost for this run. */
  usage?: {
    /** Number of input tokens consumed. */
    inputTokens: number;
    /** Number of output tokens generated. */
    outputTokens: number;
    /** Estimated cost in USD. */
    costUsd: number;
  };
}

// ---------------------------------------------------------------------------
// Run function
// ---------------------------------------------------------------------------

/**
 * The signature of a sub-agent's run function.
 *
 * Accepts a fully-resolved context and arbitrary input. Returns a
 * `Result<SubAgentResult, SubAgentError>` following the project's
 * neverthrow convention for typed error handling across module boundaries.
 */
export type SubAgentRunFn = (
  ctx: SubAgentContext,
  input: SubAgentInput,
) => Promise<Result<SubAgentResult, SubAgentError>>;

// ---------------------------------------------------------------------------
// Loaded sub-agent
// ---------------------------------------------------------------------------

/**
 * A sub-agent after all files have been read from disk and validated.
 *
 * The loader resolves the manifest, reads prompt fragments, and binds the
 * run function so the orchestrator can invoke it directly.
 */
export interface LoadedSubAgent {
  /** The validated manifest from subagent.yaml. */
  manifest: SubAgentManifest;
  /** Contents of each prompt fragment file, in concatenation order. */
  promptContents: string[];
  /** The sub-agent's entry-point run function. */
  run: SubAgentRunFn;
  /** Absolute path to the sub-agent's root directory on disk. */
  rootDir: string;
}
