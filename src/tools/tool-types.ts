/**
 * Core type definitions for the Talon tool system.
 *
 * Tools are host-mediated: the sandbox agent requests an action, the host
 * validates it against persona policy, executes it (or proxies it to an MCP
 * server), and returns the result to the agent.
 *
 * Every tool invocation is gated by the capability-based policy engine before
 * execution. Side effects are recorded in the audit log.
 */

// ---------------------------------------------------------------------------
// Execution location
// ---------------------------------------------------------------------------

/**
 * Where the tool's implementation runs.
 *
 * - `host`    — runs directly in the talond process (most built-in tools)
 * - `sandbox` — runs inside the agent container (file I/O, shell commands)
 * - `mcp`     — proxied to an external MCP server via the host MCP client
 */
export type ExecutionLocation = 'host' | 'sandbox' | 'mcp';

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

/**
 * Static descriptor for a registered tool.
 *
 * The manifest is the source of truth for what capabilities a tool requires
 * and where it executes. It is registered once at startup and consulted by
 * the policy engine on every tool call.
 */
export interface ToolManifest {
  /** Unique tool identifier (e.g. `channel.send`, `memory.read`). */
  name: string;
  /** Human-readable description for logging and approval UIs. */
  description: string;
  /**
   * Capability labels that must be granted to the persona before this tool
   * may be called. Labels follow the pattern `<domain>.<action>:<scope>`
   * (e.g. `fs.read:workspace`, `net.http:egress`).
   */
  capabilities: string[];
  /** JSON Schema describing the accepted parameter shape. Optional — used for validation. */
  parameterSchema?: unknown;
  /** Where the tool's implementation runs. */
  executionLocation: ExecutionLocation;
}

// ---------------------------------------------------------------------------
// Policy decision
// ---------------------------------------------------------------------------

/**
 * Outcome produced by the policy engine for a tool call request.
 *
 * - `allow`            — proceed without operator intervention
 * - `deny`             — reject immediately (missing capability or default-deny)
 * - `require_approval` — block execution until an approval workflow authorizes it
 */
export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

// ---------------------------------------------------------------------------
// Tool call request / result
// ---------------------------------------------------------------------------

/**
 * Inbound tool call request from a sandbox agent.
 *
 * Carries all context needed to evaluate policy, execute the tool, and
 * record the outcome in the audit log.
 */
export interface ToolCallRequest {
  /** Unique identifier for this specific invocation (correlates request and result). */
  requestId: string;
  /** Tool name matching a registered {@link ToolManifest}. */
  tool: string;
  /** Arguments forwarded to the tool implementation. */
  args: Record<string, unknown>;
  /** The durable run identifier for the agent turn that produced this call. */
  runId: string;
  /** Conversation thread the run belongs to. */
  threadId: string;
  /** Persona that owns the run. */
  personaId: string;
}

/**
 * Result returned to the sandbox agent after host-side tool execution.
 *
 * On `success` the `result` field carries the tool output.
 * On `error` the `error` field carries a human-readable message.
 * On `timeout` neither field is populated.
 */
export interface ToolCallResult {
  /** Matches the {@link ToolCallRequest.requestId} this result belongs to. */
  requestId: string;
  /** Tool name, echoed from the request for log correlation. */
  tool: string;
  /** Terminal status of the invocation. */
  status: 'success' | 'error' | 'timeout';
  /** Tool output on success. Shape is tool-specific and opaque to the transport. */
  result?: unknown;
  /** Human-readable error message when status is `error`. */
  error?: string;
}
