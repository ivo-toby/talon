/**
 * `talonctl list-capabilities` command.
 *
 * Prints all available capability labels grouped by host tool.
 */

import { CAPABILITY_DESCRIPTIONS } from '../../tools/tool-filter.js';

/**
 * Formats all available capabilities as a human-readable string.
 */
export function formatCapabilities(): string {
  const lines: string[] = ['Available capability labels:', ''];

  for (const tool of CAPABILITY_DESCRIPTIONS) {
    lines.push(`  Tool: ${tool.toolPrefix} (${tool.mcpName})`);
    for (const { label, description } of tool.labels) {
      lines.push(`    ${label.padEnd(28)} ${description}`);
    }
    lines.push('');
  }

  lines.push('Usage: Add labels to `capabilities.allow` in your persona config.');
  lines.push('       Run `talonctl set-capabilities --persona <name> --add <labels>` to modify.');
  lines.push('Example: talonctl set-capabilities --persona assistant --allow "memory.access:thread,net.http:egress"');

  return lines.join('\n');
}

/**
 * CLI entrypoint for `talonctl list-capabilities`.
 */
export function listCapabilities(): void {
  console.log(formatCapabilities());
}

/**
 * CLI command handler (matches Commander action signature).
 */
export async function listCapabilitiesCommand(): Promise<void> {
  listCapabilities();
}
