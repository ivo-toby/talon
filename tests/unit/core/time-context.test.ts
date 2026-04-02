import { describe, expect, it } from 'vitest';
import { buildTimeContext } from '../../../src/core/time-context.js';

describe('buildTimeContext', () => {
  it('rounds down to 10-minute window', () => {
    // 14:37 → window 14:30–14:40
    const now = new Date('2026-04-02T14:37:00+02:00');
    const result = buildTimeContext(now);
    expect(result).toContain('between 14:30 and 14:40');
  });

  it('handles exact boundary', () => {
    // 14:30:00 → window 14:30–14:40
    const now = new Date('2026-04-02T14:30:00+02:00');
    const result = buildTimeContext(now);
    expect(result).toContain('between 14:30 and 14:40');
  });

  it('handles hour rollover', () => {
    // 17:53 → window 17:50–18:00
    const now = new Date('2026-04-02T17:53:00+02:00');
    const result = buildTimeContext(now);
    expect(result).toContain('between 17:50 and 18:00');
  });

  it('includes day name and date', () => {
    const now = new Date('2026-04-02T10:15:00+02:00');
    const result = buildTimeContext(now);
    expect(result).toContain('Thursday');
    expect(result).toContain('2026-04-02');
  });

  it('includes timezone info', () => {
    const result = buildTimeContext(new Date());
    // Should contain UTC offset like UTC+02:00 or UTC-05:00
    expect(result).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  it('is stable within same 10-minute window', () => {
    const a = buildTimeContext(new Date('2026-04-02T14:31:00+02:00'));
    const b = buildTimeContext(new Date('2026-04-02T14:39:59+02:00'));
    expect(a).toBe(b);
  });

  it('changes at window boundary', () => {
    const a = buildTimeContext(new Date('2026-04-02T14:39:59+02:00'));
    const b = buildTimeContext(new Date('2026-04-02T14:40:00+02:00'));
    expect(a).not.toBe(b);
  });
});
