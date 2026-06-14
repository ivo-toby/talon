/**
 * Tool filtering based on persona capabilities.
 *
 * Maps capability labels from persona config to MCP tool names and provides
 * functions to determine which host tools a persona is allowed to use.
 *
 * Capability format: `<domain>.<action>` or `<domain>.<action>:<scope>`
 * Tool name format (MCP): `schedule_manage`, `channel_send`, etc.
 * Tool name format (internal): `schedule.manage`, `channel.send`, etc.
 *
 * The mapping uses the domain + action portion of the capability label to
 * expose known host tool names. Execution-time policy can also evaluate the
 * scope portion (after `:`) when the requested tool target is known.
 */

import type { ResolvedCapabilities } from '../personas/persona-types.js';
import type { PolicyDecision } from './tool-types.js';

// ---------------------------------------------------------------------------
// Capability-to-tool mapping
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the host tool registry.
 *
 * Each entry maps: capability prefix → internal name → MCP name.
 * The capability prefix is the `domain.action` part of a capability label
 * (e.g., `channel.send` from `channel.send:TalonMain`).
 *
 * Adding a new host tool requires only a single entry here.
 */
export const HOST_TOOL_REGISTRY: ReadonlyArray<{
  /** Capability prefix that grants access to this tool. */
  capabilityPrefix: string;
  /** Internal dot-notation tool name used by the bridge dispatcher. */
  internalName: string;
  /** MCP-style underscore tool name used in the MCP server protocol. */
  mcpName: string;
}> = [
  { capabilityPrefix: 'schedule.manage', internalName: 'schedule.manage', mcpName: 'schedule_manage' },
  { capabilityPrefix: 'channel.send', internalName: 'channel.send', mcpName: 'channel_send' },
  { capabilityPrefix: 'persona.send', internalName: 'persona.send', mcpName: 'persona_send' },
  { capabilityPrefix: 'persona.send', internalName: 'persona.task_status', mcpName: 'persona_task_status' },
  { capabilityPrefix: 'persona.send', internalName: 'persona.list', mcpName: 'persona_list' },
  { capabilityPrefix: 'memory.access', internalName: 'memory.access', mcpName: 'memory_access' },
  { capabilityPrefix: 'net.http', internalName: 'net.http', mcpName: 'net_http' },
  { capabilityPrefix: 'db.query', internalName: 'db.query', mcpName: 'db_query' },
  { capabilityPrefix: 'execution.env', internalName: 'execution.env', mcpName: 'execution_env' },
  { capabilityPrefix: 'subagent.invoke', internalName: 'subagent.invoke', mcpName: 'subagent_invoke' },
  { capabilityPrefix: 'subagent.background', internalName: 'subagent.background', mcpName: 'background_agent' },
];

/** Derived lookup: MCP tool name → internal tool name. Used by bridge and MCP server. */
export const MCP_TO_INTERNAL = new Map(
  HOST_TOOL_REGISTRY.map((e) => [e.mcpName, e.internalName]),
);

/** All known host tool names (internal format). */
export const ALL_HOST_TOOLS = HOST_TOOL_REGISTRY.map((e) => e.internalName);

/** Set of all known capability prefixes (domain.action). Used for validation. */
export const KNOWN_CAPABILITY_PREFIXES = new Set(
  HOST_TOOL_REGISTRY.map((e) => e.capabilityPrefix),
);

// ---------------------------------------------------------------------------
// Capability descriptions (used by CLI tooling)
// ---------------------------------------------------------------------------

/**
 * Human-readable descriptions of all capability labels, grouped by tool.
 *
 * Used by `talonctl list-capabilities` and `set-capabilities` for display
 * and validation. Add new entries here when adding new host tools.
 */
export const CAPABILITY_DESCRIPTIONS: ReadonlyArray<{
  /** The tool's capability prefix (matches HOST_TOOL_REGISTRY capabilityPrefix). */
  toolPrefix: string;
  /** MCP tool name for display. */
  mcpName: string;
  /** Individual capability labels with descriptions. */
  labels: ReadonlyArray<{ label: string; description: string }>;
}> = [
  {
    toolPrefix: 'memory.access',
    mcpName: 'memory_access',
    labels: [
      { label: 'memory.access:thread', description: 'Read and write per-thread memory items' },
    ],
  },
  {
    toolPrefix: 'net.http',
    mcpName: 'net_http',
    labels: [
      { label: 'net.http:egress', description: 'Make outbound HTTP requests' },
    ],
  },
  {
    toolPrefix: 'channel.send',
    mcpName: 'channel_send',
    labels: [
      { label: 'channel.send:*', description: 'Send messages to any channel' },
    ],
  },
  {
    toolPrefix: 'persona.send',
    mcpName: 'persona_send',
    labels: [
      { label: 'persona.send:*', description: 'Send tasks to any persona and discover available personas for delegation' },
    ],
  },
  {
    toolPrefix: 'schedule.manage',
    mcpName: 'schedule_manage',
    labels: [
      { label: 'schedule.manage:own', description: 'Create/update/delete schedules' },
    ],
  },
  {
    toolPrefix: 'db.query',
    mcpName: 'db_query',
    labels: [
      { label: 'db.query:own', description: 'Query the database (read-only)' },
    ],
  },
  {
    toolPrefix: 'execution.env',
    mcpName: 'execution_env',
    labels: [
      { label: 'execution.env', description: 'Manage isolated Sprite execution environments' },
    ],
  },
  {
    toolPrefix: 'subagent.invoke',
    mcpName: 'subagent_invoke',
    labels: [
      { label: 'subagent.invoke', description: 'Invoke sub-agents synchronously' },
    ],
  },
  {
    toolPrefix: 'subagent.background',
    mcpName: 'background_agent',
    labels: [
      { label: 'subagent.background', description: 'Launch background agent tasks' },
    ],
  },
];

/** All known capability labels (flat list). Used for validation. */
export const ALL_CAPABILITY_LABELS = CAPABILITY_DESCRIPTIONS.flatMap(
  (tool) => tool.labels.map((l) => l.label),
);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extracts the `domain.action` prefix from a capability label.
 *
 * Examples:
 *   - `channel.send:TalonMain` → `channel.send`
 *   - `fs.read:workspace` → `fs.read`
 *   - `memory.access` → `memory.access`
 *
 * Returns `null` if the label does not match the expected format.
 */
export function extractCapabilityPrefix(label: string): string | null {
  return parseCapabilityLabel(label)?.prefix ?? null;
}

interface ParsedCapabilityLabel {
  prefix: string;
  scope: string | null;
}

function parseCapabilityLabel(label: string): ParsedCapabilityLabel | null {
  const colonIndex = label.indexOf(':');
  const prefix = colonIndex === -1 ? label : label.slice(0, colonIndex);

  // Must match `word.word` pattern.
  if (!/^\w+\.\w+$/.test(prefix)) {
    return null;
  }

  return {
    prefix,
    scope: colonIndex === -1 ? null : label.slice(colonIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Given resolved capabilities, returns the set of MCP tool names (underscore
 * format) that the persona is allowed to use.
 *
 * A tool is exposed if its corresponding capability prefix appears in either
 * the `allow` or `requireApproval` list. Tools in `requireApproval` remain
 * discoverable so the agent can see that they exist, but execution must still
 * be gated at dispatch time.
 *
 * If capabilities are empty (both allow and requireApproval are empty arrays),
 * no host tools are exposed — this is the secure default.
 */
export function filterAllowedMcpTools(capabilities: ResolvedCapabilities): string[] {
  const allowedMcpNames = new Set<string>();

  const allLabels = [...capabilities.allow, ...capabilities.requireApproval];

  for (const label of allLabels) {
    const prefix = extractCapabilityPrefix(label);
    if (prefix === null) continue;

    for (const entry of HOST_TOOL_REGISTRY) {
      if (entry.capabilityPrefix === prefix) {
        allowedMcpNames.add(entry.mcpName);
      }
    }
  }

  return [...allowedMcpNames];
}

/**
 * Given resolved capabilities, returns the set of internal (dot-notation)
 * tool names that the persona is allowed to use.
 *
 * Same logic as `filterAllowedMcpTools` but returns dot-notation names.
 */
export function filterAllowedTools(capabilities: ResolvedCapabilities): string[] {
  const allowedTools = new Set<string>();

  const allLabels = [...capabilities.allow, ...capabilities.requireApproval];

  for (const label of allLabels) {
    const prefix = extractCapabilityPrefix(label);
    if (prefix === null) continue;

    for (const entry of HOST_TOOL_REGISTRY) {
      if (entry.capabilityPrefix === prefix) {
        allowedTools.add(entry.internalName);
      }
    }
  }

  return [...allowedTools];
}

/**
 * Checks whether a specific tool (internal dot-notation name) is allowed
 * by the given capabilities. Uses direct lookup instead of recomputing the
 * full allowed set on each call.
 *
 * @deprecated Use `getToolPolicyDecision` for execution-time checks so
 * approval-gated tools are not treated as directly allowed.
 */
export function isToolAllowed(toolName: string, capabilities: ResolvedCapabilities): boolean {
  const allLabels = [...capabilities.allow, ...capabilities.requireApproval];

  for (const label of allLabels) {
    const prefix = extractCapabilityPrefix(label);
    if (prefix === null) continue;

    const hasMatch = HOST_TOOL_REGISTRY.some(
      (entry) => entry.capabilityPrefix === prefix && entry.internalName === toolName,
    );
    if (hasMatch) return true;
  }

  return false;
}

/**
 * Returns the execution policy decision for a host tool.
 *
 * - `allow` when the requested tool/scope is backed by an `allow` capability
 * - `require_approval` when it is backed by a `requireApproval` capability
 * - `deny` when no matching capability is present
 *
 * For scoped tools, exact target labels take precedence over broader `*` or
 * unscoped labels. Approval-required exact scopes fail closed even when a
 * broader allow exists.
 */
export function getToolPolicyDecision(
  toolName: string,
  capabilities: ResolvedCapabilities,
  requestedScope?: string,
): PolicyDecision {
  const toolPrefixes = getToolCapabilityPrefixes(toolName);
  if (toolPrefixes.length === 0) {
    return 'deny';
  }

  const allowMatch = getBestScopeMatch(capabilities.allow, toolPrefixes, requestedScope);
  const approvalMatch = getBestScopeMatch(capabilities.requireApproval, toolPrefixes, requestedScope);

  if (requestedScope === undefined) {
    if (approvalMatch !== 'none') return 'require_approval';
    if (allowMatch !== 'none') return 'allow';
    return 'deny';
  }

  if (approvalMatch === 'exact') return 'require_approval';
  if (allowMatch === 'exact') return 'allow';
  if (approvalMatch === 'broad') return 'require_approval';
  if (allowMatch === 'broad') return 'allow';
  return 'deny';
}

type ScopeMatch = 'none' | 'broad' | 'exact';

function getToolCapabilityPrefixes(toolName: string): string[] {
  return HOST_TOOL_REGISTRY
    .filter((entry) => entry.internalName === toolName)
    .map((entry) => entry.capabilityPrefix);
}

function getBestScopeMatch(
  labels: readonly string[],
  toolPrefixes: readonly string[],
  requestedScope: string | undefined,
): ScopeMatch {
  let best: ScopeMatch = 'none';

  for (const label of labels) {
    const parsed = parseCapabilityLabel(label);
    if (parsed === null || !toolPrefixes.includes(parsed.prefix)) continue;

    if (requestedScope === undefined) {
      return 'broad';
    }

    if (parsed.scope === requestedScope) {
      return 'exact';
    }

    if ((parsed.scope === null || parsed.scope === '*') && best === 'none') {
      best = 'broad';
    }
  }

  return best;
}
