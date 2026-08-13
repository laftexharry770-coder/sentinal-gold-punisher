/**
 * Economic calendar from Trading Economics.
 *
 * Their API answers with a guest key for a limited slice of countries, which is
 * enough for the US releases that move gold; a paid key widens it. The key is
 * held in this browser and sent only to Trading Economics.
 */
export type Impact = 'high' | 'medium' | 'low';

export interface CalendarEvent {
  id: string;
  /** Release time as an absolute instant; rendered in the viewer's timezone. */
  time: number;
  country: string;
  currency: string;
  title: string;
  impact: Impact;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}

export class CalendarError extends Error {}

interface RawEvent {
  CalendarId?: string | number;
  Date?: string;
  Country?: string;
  Category?: string;
  Event?: string;
  Importance?: number | string;
  Actual?: string | number | null;
  Forecast?: string | number | null;
  Previous?: string | number | null;
  Currency?: string;
}

/** Trading Economics grades importance 1–3; anything else is treated as low. */
function toImpact(value: RawEvent['Importance']): Impact {
  const n = Number(value);
  if (n >= 3) return 'high';
  if (n === 2) return 'medium';
  return 'low';
}

/**
 * Releases that actually move gold: US macro, Fed policy, and the inflation and
 * labour prints the metal reprices on. Filtering here keeps the screen about
 * XAUUSD rather than listing every country's data.
 */
const GOLD_RELEVANT = /(fed|fomc|interest rate|cpi|inflation|non.?farm|payroll|unemployment|jobless|gdp|pce|retail sales|ppi|treasury|powell|dollar|ism|consumer confidence|michigan)/i;

const COUNTRIES = ['united states'];

function normalise(raw: RawEvent, index: number): CalendarEvent | null {
  const time = raw.Date ? new Date(raw.Date).getTime() : Number.NaN;
  if (!Number.isFinite(time)) return null;
  const title = String(raw.Event ?? raw.Category ?? '').trim();
  if (!title) return null;

  const text = (value: RawEvent['Actual']): string | null => {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  };

  return {
    id: String(raw.CalendarId ?? `${time}-${index}`),
    time,
    country: String(raw.Country ?? 'United States'),
    currency: String(raw.Currency ?? 'USD'),
    title,
    impact: toImpact(raw.Importance),
    actual: text(raw.Actual),
    forecast: text(raw.Forecast),
    previous: text(raw.Previous),
  };
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Upcoming releases, plus the last day of results so the screen can show what
 * has just printed. Times come back as instants and are formatted locally.
 */
export async function fetchCalendar(apiKey: string, daysAhead = 7): Promise<CalendarEvent[]> {
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const key = apiKey.trim() || 'guest:guest';

  const url =
    `https://api.tradingeconomics.com/calendar/country/${encodeURIComponent(COUNTRIES.join(','))}` +
    `/${isoDate(from)}/${isoDate(to)}?c=${encodeURIComponent(key)}&f=json`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new CalendarError(
      `Could not reach the calendar (${err instanceof Error ? err.message : 'network error'}). ` +
        'The browser may be blocked from calling Trading Economics directly.',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new CalendarError('Trading Economics rejected the key. The guest key only covers a few countries.');
  }
  if (!response.ok) {
    throw new CalendarError(`Calendar request failed (${response.status}).`);
  }

  const body = (await response.json()) as RawEvent[] | { message?: string };
  if (!Array.isArray(body)) {
    throw new CalendarError(String((body as { message?: string }).message ?? 'Unexpected calendar response.'));
  }

  return body
    .map(normalise)
    .filter((event): event is CalendarEvent => event !== null)
    .filter((event) => event.impact === 'high' || GOLD_RELEVANT.test(event.title))
    .sort((a, b) => a.time - b.time);
}

/**
 * Past occurrences of named events, for base rates.
 *
 * The upcoming window is only a week wide, so it can never supply the history a
 * base rate needs; this asks for a separate, older range and keeps only the
 * events being measured.
 */
export async function fetchPastOccurrences(
  apiKey: string,
  titles: string[],
  monthsBack = 24,
): Promise<CalendarEvent[]> {
  if (titles.length === 0) return [];

  const to = new Date(Date.now() - 60 * 60 * 1000);
  const from = new Date(to.getTime() - monthsBack * 30 * 24 * 60 * 60 * 1000);
  const key = apiKey.trim() || 'guest:guest';
  const wanted = new Set(titles.map((title) => title.toLowerCase()));

  const url =
    `https://api.tradingeconomics.com/calendar/country/${encodeURIComponent(COUNTRIES.join(','))}` +
    `/${isoDate(from)}/${isoDate(to)}?c=${encodeURIComponent(key)}&f=json`;

  const response = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);
  if (!response || !response.ok) return [];

  const body = (await response.json().catch(() => null)) as RawEvent[] | null;
  if (!Array.isArray(body)) return [];

  return body
    .map(normalise)
    .filter((event): event is CalendarEvent => event !== null)
    .filter((event) => wanted.has(event.title.toLowerCase()))
    .sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------------------ */
/* Local time formatting                                               */
/* ------------------------------------------------------------------ */

export const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function formatLocalTime(time: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(time);
}

export function formatLocalDay(time: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(time);
}

/** "in 2h 15m" / "45m ago", so the operator does not do the arithmetic. */
export function formatCountdown(time: number, now = Date.now()): string {
  const deltaMinutes = Math.round((time - now) / 60000);
  const ahead = deltaMinutes >= 0;
  const total = Math.abs(deltaMinutes);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;

  const parts = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return ahead ? `in ${parts}` : `${parts} ago`;
}

export function isSameLocalDay(time: number, reference = Date.now()): boolean {
  const a = new Date(time);
  const b = new Date(reference);
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}
