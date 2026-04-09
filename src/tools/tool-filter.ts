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
 *
 * Some entries support dynamic expansion via an `expand()` function.
 * The `skill.exec` capability prefix maps to one MCP tool per script-enabled
 * skill (e.g., `contentful_exec`, `git_flow_exec`), computed at agent-run
 * start from the persona's loaded skills.
 */

import type { ResolvedCapabilities } from '../personas/persona-types.js';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Tool expansion context (for dynamic 1-to-many capability mapping)
// ---------------------------------------------------------------------------

/**
 * Context provided to registry entries with dynamic `expand()` functions.
 * Passed by the agent bootstrap code at run start.
 */
export interface ToolExpansionContext {
  personaId: string;
  capabilities: { allow: string[]; requireApproval: string[] };
  loadedSkills: ReadonlyArray<{
    manifest: { name: string; sandbox?: { workdir: string } };
    /** Non-null means the skill has been sandbox-staged and is exec-capable. */
    stagedSandbox: Record<string, unknown> | null;
  }>;
}

// ---------------------------------------------------------------------------
// Capability-to-tool mapping
// ---------------------------------------------------------------------------

/**
 * A single entry in the host tool registry.
 */
export interface HostToolRegistryEntry {
  /** Capability prefix that grants access to this tool. */
  capabilityPrefix: string;
  /** Internal dot-notation tool name used by the bridge dispatcher. */
  internalName: string;
  /** MCP-style underscore tool name used in the MCP server protocol. */
  mcpName: string;
  /**
   * Optional dynamic expansion function. When present, returns an array of
   * MCP tool names derived from the expansion context (e.g., loaded skills).
   * When absent, the entry maps to its single static `mcpName`.
   */
  expand?: (ctx: ToolExpansionContext) => string[];
}

/**
 * Single source of truth for the host tool registry.
 *
 * Each entry maps: capability prefix → internal name → MCP name.
 * The capability prefix is the `domain.action` part of a capability label
 * (e.g., `channel.send` from `channel.send:TalonMain`).
 *
 * Adding a new host tool requires only a single entry here.
 */
export const HOST_TOOL_REGISTRY: ReadonlyArray<HostToolRegistryEntry> = [
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
  {
    capabilityPrefix: 'skill.exec',
    internalName: 'skill.exec',
    mcpName: 'skill_exec',
    expand: (ctx: ToolExpansionContext): string[] => {
      const log = pino({ level: 'warn', name: 'tool-filter' });
      const names: string[] = [];
      const seen = new Map<string, string>(); // mcpName → original skill name

      // Collect all capability labels that grant skill.exec access
      const allLabels = [...ctx.capabilities.allow, ...ctx.capabilities.requireApproval];
      const grantedScopes = new Set<string>();
      let hasWildcard = false;

      for (const label of allLabels) {
        const colonIndex = label.indexOf(':');
        const prefix = colonIndex === -1 ? label : label.slice(0, colonIndex);
        if (prefix !== 'skill.exec') continue;

        if (colonIndex === -1) {
          // bare `skill.exec` — no scope, treat as no wildcard grant
          continue;
        }
        const scope = label.slice(colonIndex + 1);
        if (scope === '*') {
          hasWildcard = true;
        } else {
          grantedScopes.add(scope);
        }
      }

      for (const skill of ctx.loadedSkills) {
        // Only include skills with a sandbox block AND non-null stagedSandbox
        if (!skill.manifest.sandbox || skill.stagedSandbox == null) continue;

        const skillName = skill.manifest.name;

        // Check if persona has skill.exec:<skillName> or skill.exec:*
        if (!hasWildcard && !grantedScopes.has(skillName)) continue;

        const mcpName = sanitizeSkillNameForMcp(skillName);

        // Collision detection
        const existing = seen.get(mcpName);
        if (existing != null) {
          log.warn(
            { mcpName, existingSkill: existing, skippedSkill: skillName },
            'Skill MCP name collision: %s already registered by skill %s, skipping %s',
            mcpName, existing, skillName,
          );
          continue;
        }

        seen.set(mcpName, skillName);
        skillExecMcpToSkillName.set(mcpName, skillName);
        names.push(mcpName);
      }

      return names;
    },
  },
];

// ---------------------------------------------------------------------------
// Skill name sanitization and reverse lookup
// ---------------------------------------------------------------------------

/**
 * Sanitize a skill name for use as an MCP tool name.
 *
 * Lowercases the name, replaces hyphens with underscores, and appends `_exec`.
 * Example: `git-flow` → `git_flow_exec`, `contentful` → `contentful_exec`.
 */
export function sanitizeSkillNameForMcp(skillName: string): string {
  return skillName.toLowerCase().replace(/-/g, '_') + '_exec';
}

/**
 * Reverse lookup map: MCP tool name → original skill name.
 *
 * Built during `expand()` calls. Consumers can use `getSkillNameForMcpTool()`
 * to look up the original skill name for a given MCP exec tool name.
 */
const skillExecMcpToSkillName = new Map<string, string>();

/**
 * Look up the original skill name for an MCP exec tool name.
 *
 * Returns `null` if the MCP name is not a known skill exec tool.
 * The map is populated during `expand()` calls in `filterAllowedMcpTools()`.
 */
export function getSkillNameForMcpTool(mcpName: string): string | null {
  return skillExecMcpToSkillName.get(mcpName) ?? null;
}

/**
 * Reset the skill exec reverse lookup map. Intended for use at the start
 * of a new agent run or in tests.
 */
export function resetSkillExecLookup(): void {
  skillExecMcpToSkillName.clear();
}

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
 *
 * When `expansionContext` is provided, registry entries with an `expand()`
 * function use it to produce dynamic MCP tool names (e.g., one per
 * script-enabled skill). When omitted, entries with `expand()` are skipped
 * for backward compatibility.
 */
export function filterAllowedMcpTools(
  capabilities: ResolvedCapabilities,
  expansionContext?: ToolExpansionContext,
): string[] {
  const allowedMcpNames = new Set<string>();

  const allLabels = [...capabilities.allow, ...capabilities.requireApproval];

  for (const label of allLabels) {
    const prefix = extractCapabilityPrefix(label);
    if (prefix === null) continue;

    for (const entry of HOST_TOOL_REGISTRY) {
      if (entry.capabilityPrefix !== prefix) continue;

      if (entry.expand) {
        // Dynamic entry — only expand when context is provided
        if (expansionContext) {
          for (const name of entry.expand(expansionContext)) {
            allowedMcpNames.add(name);
          }
        }
        // When no context, skip this entry entirely (backward compat)
      } else {
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
