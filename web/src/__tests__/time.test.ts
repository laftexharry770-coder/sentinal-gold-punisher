import { describe, expect, it } from 'vitest';
import { formatClock, formatClockWithSeconds, formatDay, timeZoneName } from '../time';

/** 2026-08-13T16:07:52Z — an afternoon, so a 24-hour slip is visible. */
const AFTERNOON = new Date('2026-08-13T16:07:52Z');

/** Local midnight and midday, whatever timezone the machine is set to. */
const localAt = (hour: number, minute = 0) => {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
};

describe('formatClock', () => {
  it('writes a twelve-hour clock with a meridiem', () => {
    expect(formatClock(AFTERNOON)).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM|am|pm)$/i);
  });

  it('never prints an hour above 12, at any hour of the day', () => {
    for (let hour = 0; hour < 24; hour++) {
      const printed = formatClock(localAt(hour));
      const [printedHour] = printed.split(':');
      expect(Number(printedHour)).toBeGreaterThanOrEqual(1);
      expect(Number(printedHour)).toBeLessThanOrEqual(12);
    }
  });

  it('reads midnight and midday the way a person says them', () => {
    expect(formatClock(localAt(0))).toMatch(/^12:00\s?(AM|am)$/i);
    expect(formatClock(localAt(12))).toMatch(/^12:00\s?(PM|pm)$/i);
  });

  it('uses the local timezone, not UTC', () => {
    // The one thing a chart axis must not do is show someone else's clock.
    const expected = AFTERNOON.getHours() % 12 || 12;
    expect(Number(formatClock(AFTERNOON).split(':')[0])).toBe(expected);
  });
});

describe('formatClockWithSeconds', () => {
  it('carries seconds, so log lines order visibly', () => {
    expect(formatClockWithSeconds(AFTERNOON)).toMatch(/^\d{1,2}:\d{2}:\d{2}\s?(AM|PM|am|pm)$/i);
  });
});

describe('formatDay', () => {
  it('names the day and month without a year', () => {
    expect(formatDay(AFTERNOON)).toMatch(/\d{1,2}/);
    expect(formatDay(AFTERNOON)).not.toMatch(/2026/);
  });
});

describe('timeZoneName', () => {
  it('returns something nameable rather than an empty string', () => {
    expect(timeZoneName().length).toBeGreaterThan(0);
  });
});
