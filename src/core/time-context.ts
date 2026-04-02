/**
 * Generates a cache-friendly time context string for system prompts.
 *
 * Instead of an exact timestamp (which changes every second and busts prompt
 * caches), this produces a 10-minute window:
 *
 *   "Current time: between 17:50 and 18:00 on Wednesday 2026-04-02 (CEST, UTC+02:00)"
 *
 * The window is stable for 10 minutes, allowing provider-side prompt caching
 * to work effectively while still giving the agent useful time awareness.
 *
 * When the window crosses midnight, the end date advances to the next day so
 * the agent gets consistent today/tomorrow reasoning.
 */

const WINDOW_MINUTES = 10;

export function buildTimeContext(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');

  // Round down to nearest WINDOW_MINUTES boundary.
  const floorMinutes = Math.floor(now.getMinutes() / WINDOW_MINUTES) * WINDOW_MINUTES;

  // Build start of window from `now` with minutes floored and seconds zeroed.
  const start = new Date(now);
  start.setMinutes(floorMinutes, 0, 0);

  // Build end of window by adding WINDOW_MINUTES. This correctly handles
  // hour rollover AND midnight crossing (the Date object advances the day).
  const end = new Date(start);
  end.setMinutes(start.getMinutes() + WINDOW_MINUTES);

  const rangeStart = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const rangeEnd = `${pad(end.getHours())}:${pad(end.getMinutes())}`;

  const formatDate = (d: Date): string => {
    const dayName = d.toLocaleDateString('en', { weekday: 'long' });
    return `${dayName} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // When start and end fall on different days, show both dates.
  const startDate = formatDate(start);
  const endDate = formatDate(end);
  const dateStr = startDate === endDate ? `on ${startDate}` : `from ${startDate} to ${endDate}`;

  // Timezone.
  const offsetMin = now.getTimezoneOffset();
  const offsetSign = offsetMin <= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMin);
  const utcOffset = `UTC${offsetSign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
  const tzAbbr =
    Intl.DateTimeFormat('en', { timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';

  return `Current time: between ${rangeStart} and ${rangeEnd} ${dateStr} (${tzAbbr}, ${utcOffset}). If you need precise time you can use the bash-tool.`;
}
