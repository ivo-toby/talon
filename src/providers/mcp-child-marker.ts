/**
 * Shared env marker stamped on every stdio MCP child Talon spawns.
 *
 * Lives in its own tiny module so every provider (and the daemon-boot
 * orphan reaper) can reference the same string without pulling in the
 * openai-compatible wrapper or the daemon-side cleanup logic.
 *
 * See https://github.com/ivo-toby/talon/issues/210.
 */

/** Env var name set to "1" on every stdio MCP subprocess. */
export const MCP_CHILD_MARKER_ENV = 'TALON_MCP_CHILD';

/**
 * Merge the marker into an MCP server's env block. Always returns a new
 * object — callers should pass the existing env unchanged.
 */
export function stampMcpChildMarker(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return { ...(env ?? {}), [MCP_CHILD_MARKER_ENV]: '1' };
}
