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
 */

const WINDOW_MINUTES = 10;

export function buildTimeContext(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');

  // Round down to nearest WINDOW_MINUTES boundary.
  const floorMinutes = Math.floor(now.getMinutes() / WINDOW_MINUTES) * WINDOW_MINUTES;
  const ceilMinutes = floorMinutes + WINDOW_MINUTES;

  const hours = now.getHours();
  const rangeStart = `${pad(hours)}:${pad(floorMinutes)}`;

  // Handle hour rollover (e.g. 17:50 → 18:00).
  const endHours = ceilMinutes >= 60 ? hours + 1 : hours;
  const endMinutes = ceilMinutes >= 60 ? 0 : ceilMinutes;
  const rangeEnd = `${pad(endHours % 24)}:${pad(endMinutes)}`;

  // Date parts.
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const dayName = now.toLocaleDateString('en', { weekday: 'long' });

  // Timezone.
  const offsetMin = now.getTimezoneOffset();
  const offsetSign = offsetMin <= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMin);
  const utcOffset = `UTC${offsetSign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
  const tzAbbr = Intl.DateTimeFormat('en', { timeZoneName: 'short' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';

  return `Current time: between ${rangeStart} and ${rangeEnd} on ${dayName} ${year}-${month}-${day} (${tzAbbr}, ${utcOffset})`;
}
