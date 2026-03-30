/**
 * Tool instruction loader — injects per-tool behavioral guidance into
 * the system prompt based on the persona's allowed capabilities.
 *
 * Each host tool capability prefix may have a companion markdown file in
 * `templates/tool-instructions/<capability.prefix>.md`. Files are loaded
 * once at startup and cached. At runtime, only instructions for tools the
 * persona is actually allowed to use are included in the prompt.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_TOOL_REGISTRY } from './tool-filter.js';

// Reverse lookup: MCP tool name → capability prefix.
const MCP_TO_PREFIX = new Map<string, string>(
  HOST_TOOL_REGISTRY.map((e): [string, string] => [e.mcpName, e.capabilityPrefix]),
);

/**
 * Reads all `.md` files from the given directory and returns a map
 * keyed by filename (without extension) → file content.
 *
 * Missing or empty files are silently ignored.
 */
export function loadToolInstructions(dir: string): Map<string, string> {
  const cache = new Map<string, string>();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory doesn't exist — return empty cache.
    return cache;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const key = entry.slice(0, -3); // strip .md
    try {
      const content = readFileSync(join(dir, entry), 'utf-8').trim();
      if (content) {
        cache.set(key, content);
      }
    } catch {
      // Unreadable file — skip silently.
    }
  }

  return cache;
}

/**
 * Given the cached instruction map and a list of allowed MCP tool names,
 * returns the concatenated instruction blocks for the persona's tools.
 *
 * Each matched instruction file is included as-is (it should start with
 * its own `##` heading). Duplicate capability prefixes are deduplicated
 * (e.g. `persona_send` and `persona_list` both map to `persona.send`).
 */
export function resolveToolInstructions(
  cache: Map<string, string>,
  allowedMcpTools: string[],
): string {
  if (cache.size === 0) return '';

  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const mcpName of allowedMcpTools) {
    const prefix = MCP_TO_PREFIX.get(mcpName);
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);

    const content = cache.get(prefix);
    if (content) {
      blocks.push(content);
    }
  }

  return blocks.join('\n\n');
}
