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
export function readScheduleOriginExternalId(metadataJson: string | null | undefined): string | null {
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
