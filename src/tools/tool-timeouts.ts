/** Default maximum time a host-tool roundtrip may take over the MCP bridge. */
export const HOST_TOOLS_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Extra transport headroom so a tool can return a structured timeout first. */
export const HOST_TOOLS_TIMEOUT_GRACE_MS = 5_000;

/**
 * Default synchronous wait budget for persona.send await_reply.
 *
 * Must stay below HOST_TOOLS_REQUEST_TIMEOUT_MS so the tool can
 * return a structured timeout result before the transport layer gives up.
 */
export const PERSONA_SEND_DEFAULT_MAX_WAIT_MS =
  HOST_TOOLS_REQUEST_TIMEOUT_MS - HOST_TOOLS_TIMEOUT_GRACE_MS;

/** Maximum supported sync wait for persona.send and persona.task_status. */
export const PERSONA_TASK_WAIT_MAX_MS = 30 * 60 * 1000;

export function resolvePersonaTaskWaitMs(requestedMs?: unknown, fallbackMs?: number): number {
  if (typeof requestedMs !== 'number' || !Number.isInteger(requestedMs) || requestedMs <= 0) {
    return fallbackMs ?? PERSONA_SEND_DEFAULT_MAX_WAIT_MS;
  }

  return Math.min(requestedMs, PERSONA_TASK_WAIT_MAX_MS);
}

export function getHostToolRequestTimeoutMs(
  normalizedToolName: string,
  args: Record<string, unknown>,
): number {
  if (normalizedToolName === 'persona.send') {
    return resolvePersonaTaskWaitMs(args.timeout_ms) + HOST_TOOLS_TIMEOUT_GRACE_MS;
  }

  if (normalizedToolName === 'persona.task_status') {
    return resolvePersonaTaskWaitMs(args.wait_ms, 0) + HOST_TOOLS_TIMEOUT_GRACE_MS;
  }

  return HOST_TOOLS_REQUEST_TIMEOUT_MS;
}
