/**
 * Clock formatting for the terminal.
 *
 * Every time on screen is the reader's own, written the way a clock is read
 * aloud: 4:07 pm, not 16:07. Intl does the work, so the twelve/twenty-four
 * hour choice and the AM/PM wording follow the browser's locale where that
 * differs, and the timezone is whatever the machine is set to.
 */

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const TIME_WITH_SECONDS = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** 4:07 pm — for axis labels and anywhere seconds are noise. */
export function formatClock(time: number | Date): string {
  return TIME.format(time);
}

/** 4:07:52 pm — for a log, where the order of events matters. */
export function formatClockWithSeconds(time: number | Date): string {
  return TIME_WITH_SECONDS.format(time);
}

/** 13 Aug — for the day boundary on a chart axis. */
export function formatDay(time: number | Date): string {
  return DAY.format(time);
}

/**
 * The timezone these times are in, e.g. "Africa/Nairobi". Shown where a clock
 * might be compared against someone else's screen.
 */
export function timeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
}
