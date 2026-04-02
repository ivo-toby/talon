/** Maximum time a host-tool roundtrip may take over the MCP bridge. */
export const HOST_TOOLS_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Default synchronous wait budget for persona.send await_reply.
 *
 * Must stay comfortably below HOST_TOOLS_REQUEST_TIMEOUT_MS so the tool can
 * return a structured timeout result before the transport layer gives up.
 */
export const PERSONA_SEND_DEFAULT_MAX_WAIT_MS = 90_000;
