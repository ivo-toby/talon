/**
 * Utilities for working with schedule thread metadata.
 *
 * Schedule threads carry `{ kind: 'schedule', originExternalId: '<live chat id>' }`
 * in their metadata so outbound routing can deliver to the originating user
 * rather than using the synthetic schedule external_id.
 */

/**
 * Parses schedule thread metadata and returns the originExternalId if present.
 * Returns null for non-schedule threads or unparseable metadata.
 */
export function readScheduleOriginExternalId(
  metadataJson: string | null | undefined,
): string | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    if (parsed && parsed.kind === 'schedule' && typeof parsed.originExternalId === 'string') {
      return parsed.originExternalId;
    }
  } catch {
    /* ignore — treat unparseable metadata as absent */
  }
  return null;
}

/** Prefix of the synthetic external ID of a dedicated schedule execution thread. */
const SCHEDULE_THREAD_PREFIX = 'schedule:';

/**
 * The provider-side recipient a thread's own output can be delivered to, or
 * null when it has none.
 *
 * A live conversation thread is its own recipient. A dedicated schedule
 * thread is not: its external ID is a synthetic `schedule:…` marker, and its
 * recipient is the chat (or topic) recorded as `originExternalId`. A schedule
 * thread without an origin — created from the CLI, or a legacy thread whose
 * origin was never recorded — has no recipient at all. Returning null for it
 * keeps the synthetic ID away from connectors, which would otherwise ask the
 * provider to address a chat that does not exist.
 */
export function resolveThreadRecipient(thread: {
  external_id: string;
  metadata: string | null | undefined;
}): string | null {
  const recipient = readScheduleOriginExternalId(thread.metadata) ?? thread.external_id;
  return recipient.startsWith(SCHEDULE_THREAD_PREFIX) ? null : recipient;
}
