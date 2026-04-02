import { describe, expect, it } from 'vitest';
import { buildTimeContext } from '../../../src/core/time-context.js';

/**
 * Helper: build a Date at a specific local wall-clock time regardless of the
 * test runner's timezone. We set year/month/day/hour/minute in local time so
 * the assertions don't depend on a specific UTC offset.
 */
function localDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  return d;
}

describe('buildTimeContext', () => {
  it('rounds down to 10-minute window', () => {
    const result = buildTimeContext(localDate(2026, 4, 2, 14, 37));
    expect(result).toContain('between 14:30 and 14:40');
  });

  it('handles exact boundary', () => {
    const result = buildTimeContext(localDate(2026, 4, 2, 14, 30));
    expect(result).toContain('between 14:30 and 14:40');
  });

  it('handles hour rollover', () => {
    const result = buildTimeContext(localDate(2026, 4, 2, 17, 53));
    expect(result).toContain('between 17:50 and 18:00');
  });

  it('includes day name and date', () => {
    const now = localDate(2026, 4, 2, 10, 15);
    const result = buildTimeContext(now);
    const expectedDay = now.toLocaleDateString('en', { weekday: 'long' });
    expect(result).toContain(expectedDay);
    expect(result).toContain('2026-04-02');
  });

  it('includes timezone info', () => {
    const result = buildTimeContext(new Date());
    expect(result).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  it('is stable within same 10-minute window', () => {
    const a = buildTimeContext(localDate(2026, 4, 2, 14, 31));
    const b = buildTimeContext(localDate(2026, 4, 2, 14, 39));
    expect(a).toBe(b);
  });

  it('changes at window boundary', () => {
    const a = buildTimeContext(localDate(2026, 4, 2, 14, 39));
    const b = buildTimeContext(localDate(2026, 4, 2, 14, 40));
    expect(a).not.toBe(b);
  });

  it('handles midnight crossing with correct dates', () => {
    const now = localDate(2026, 4, 2, 23, 55);
    const result = buildTimeContext(now);
    // Window is 23:50–00:00, spanning two days
    expect(result).toContain('between 23:50 and 00:00');
    expect(result).toContain('2026-04-02');
    expect(result).toContain('2026-04-03');
    // Should use "from ... to ..." instead of "on" for cross-day windows
    expect(result).toMatch(/from .* to /);
  });

  it('does not show two dates for same-day windows', () => {
    const result = buildTimeContext(localDate(2026, 4, 2, 14, 30));
    expect(result).toContain('on ');
    expect(result).not.toMatch(/from .* to /);
  });
});
