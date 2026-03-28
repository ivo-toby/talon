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
 * match against known host tool names. The scope portion (after `:`) is
 * ignored for tool-level filtering — it is used for finer-grained access
 * control within handlers (e.g., which channels can be sent to).
 */

import type { ResolvedCapabilities } from '../personas/persona-types.js';

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
const HOST_TOOL_REGISTRY: ReadonlyArray<{
  /** Capability prefix that grants access to this tool. */
  capabilityPrefix: string;
  /** Internal dot-notation tool name used by the bridge dispatcher. */
  internalName: string;
  /** MCP-style underscore tool name used in the MCP server protocol. */
  mcpName: string;
}> = [
  { capabilityPrefix: 'schedule.manage', internalName: 'schedule.manage', mcpName: 'schedule_manage' },
  { capabilityPrefix: 'channel.send', internalName: 'channel.send', mcpName: 'channel_send' },
  { capabilityPrefix: 'memory.access', internalName: 'memory.access', mcpName: 'memory_access' },
  { capabilityPrefix: 'net.http', internalName: 'net.http', mcpName: 'net_http' },
  { capabilityPrefix: 'db.query', internalName: 'db.query', mcpName: 'db_query' },
  { capabilityPrefix: 'subagent.invoke', internalName: 'subagent.invoke', mcpName: 'subagent_invoke' },
  { capabilityPrefix: 'subagent.background', internalName: 'subagent.background', mcpName: 'background_agent' },
];

/** Derived lookup: capability prefix → internal tool name. */
const CAPABILITY_TO_TOOL = new Map(
  HOST_TOOL_REGISTRY.map((e) => [e.capabilityPrefix, e.internalName]),
);

/** Derived lookup: internal tool name → MCP tool name. */
const TOOL_TO_MCP = new Map(
  HOST_TOOL_REGISTRY.map((e) => [e.internalName, e.mcpName]),
);

/** Derived lookup: MCP tool name → internal tool name. Used by bridge and MCP server. */
export const MCP_TO_INTERNAL = new Map(
  HOST_TOOL_REGISTRY.map((e) => [e.mcpName, e.internalName]),
);

/** All known host tool names (internal format). */
export const ALL_HOST_TOOLS = HOST_TOOL_REGISTRY.map((e) => e.internalName);

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
      { label: 'db.read:own', description: 'Query the database (read-only)' },
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
  const colonIndex = label.indexOf(':');
  const prefix = colonIndex === -1 ? label : label.slice(0, colonIndex);

  // Must match `word.word` pattern.
  if (/^\w+\.\w+$/.test(prefix)) {
    return prefix;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Given resolved capabilities, returns the set of MCP tool names (underscore
 * format) that the persona is allowed to use.
 *
 * A tool is allowed if its corresponding capability prefix appears in either
 * the `allow` or `requireApproval` list. Tools in `requireApproval` are still
 * exposed (the agent can call them), but future enforcement at the bridge
 * level can gate execution with an approval step.
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

    const toolName = CAPABILITY_TO_TOOL.get(prefix);
    if (toolName === undefined) continue;

    const mcpName = TOOL_TO_MCP.get(toolName);
    if (mcpName !== undefined) {
      allowedMcpNames.add(mcpName);
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

    const toolName = CAPABILITY_TO_TOOL.get(prefix);
    if (toolName !== undefined) {
      allowedTools.add(toolName);
    }
  }

  return [...allowedTools];
}

/**
 * Checks whether a specific tool (internal dot-notation name) is allowed
 * by the given capabilities. Uses direct lookup instead of recomputing the
 * full allowed set on each call.
 */
export function isToolAllowed(toolName: string, capabilities: ResolvedCapabilities): boolean {
  const allLabels = [...capabilities.allow, ...capabilities.requireApproval];

  for (const label of allLabels) {
    const prefix = extractCapabilityPrefix(label);
    if (prefix === null) continue;

    const mappedToolName = CAPABILITY_TO_TOOL.get(prefix);
    if (mappedToolName === toolName) {
      return true;
    }
  }

  return false;
}
