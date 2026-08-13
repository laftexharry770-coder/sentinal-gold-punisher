import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  baseRateConfidence,
  measureOutcome,
  summariseOutcomes,
  type BaseRate,
  type Candle,
  type EventOutcome,
} from '@sentinal/shared';
import { api } from '../api';
import { Card, Chip, EmptyState, TextField } from '../components/ui';
import {
  CalendarError,
  LOCAL_TIMEZONE,
  fetchCalendar,
  fetchPastOccurrences,
  formatCountdown,
  formatLocalDay,
  formatLocalTime,
  isSameLocalDay,
  type CalendarEvent,
  type Impact,
} from '../news/calendar';
import { useTerminal } from '../store';

const KEY_STORAGE = 'sentinal.calendar.key';
/** Window the base rate measures after each release. */
const WINDOW_MS = 60 * 60 * 1000;

const IMPACT_TONE: Record<Impact, 'loss' | 'warn' | 'neutral'> = {
  high: 'loss',
  medium: 'warn',
  low: 'neutral',
};

const IMPACT_LABEL: Record<Impact, string> = {
  high: 'High impact',
  medium: 'Medium impact',
  low: 'Low impact',
};

function BaseRateView({ rate, symbol }: { rate: BaseRate; symbol: string }) {
  const confidence = baseRateConfidence(rate);

  if (confidence === 'none') {
    return (
      <p className="text-[0.6875rem] leading-relaxed text-[var(--color-ink-muted)]">
        Not enough past releases with price history to say what {symbol} did before.
      </p>
    );
  }

  const higher = Math.round(rate.higherPercent ?? 0);
  const lower = 100 - higher;

  return (
    <div className="space-y-1.5">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
        <div className="bg-profit" style={{ width: `${higher}%` }} />
        <div className="bg-loss" style={{ width: `${lower}%` }} />
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]">
        In the last <span className="tabular font-semibold text-ink">{rate.samples}</span> releases,{' '}
        {symbol} closed <span className="tabular font-semibold text-profit">higher {higher}%</span> of the
        time an hour later ({rate.higher} up / {rate.lower} down), moving{' '}
        <span className="tabular font-semibold text-ink">±{rate.averageAbsMove.toFixed(2)}</span> on average.
        {confidence === 'weak' && (
          <span className="text-warn"> Few samples — treat this as thin evidence.</span>
        )}
      </p>
    </div>
  );
}

function EventRow({
  event,
  rate,
  symbol,
}: {
  event: CalendarEvent;
  rate: BaseRate | undefined;
  symbol: string;
}) {
  const today = isSameLocalDay(event.time);
  const past = event.time < Date.now();

  return (
    <li className="border-t border-[var(--color-line)] px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular text-sm font-semibold text-ink">{formatLocalTime(event.time)}</span>
            <Chip tone={IMPACT_TONE[event.impact]}>{IMPACT_LABEL[event.impact]}</Chip>
            {today && !past && <Chip tone="cobalt">today</Chip>}
          </div>
          <p className="mt-1 text-sm leading-snug text-ink">{event.title}</p>
          <p className="tabular mt-0.5 text-[0.6875rem] text-[var(--color-ink-muted)]">
            {formatLocalDay(event.time)} · {formatCountdown(event.time)} · {event.currency}
          </p>
        </div>
        <dl className="tabular grid shrink-0 grid-cols-3 gap-3 text-xs">
          <div>
            <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Actual</dt>
            <dd className={event.actual ? 'font-semibold text-ink' : 'text-[var(--color-ink-muted)]'}>
              {event.actual ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Forecast</dt>
            <dd>{event.forecast ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Previous</dt>
            <dd>{event.previous ?? '—'}</dd>
          </div>
        </dl>
      </div>

      {/* The base rate is only worth the screen space on the day it matters. */}
      {today && event.impact !== 'low' && (
        <div className="mt-2.5 rounded-lg border border-[var(--color-line)] bg-[#0a1220] px-3 py-2.5">
          {rate ? (
            <BaseRateView rate={rate} symbol={symbol} />
          ) : (
            <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">Measuring past releases…</p>
          )}
        </div>
      )}
    </li>
  );
}

export function News() {
  const { config } = useTerminal();
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? '');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [rates, setRates] = useState<Record<string, BaseRate>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchCalendar(apiKey);
      setEvents(list);
      setLoadedAt(Date.now());
    } catch (err) {
      setEvents([]);
      setError(
        err instanceof CalendarError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not load the calendar.',
      );
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Base rates for today's releases, measured against the broker's own price
   * history for past occurrences of the same event.
   */
  useEffect(() => {
    const todays = events.filter((event) => isSameLocalDay(event.time) && event.impact !== 'low');
    if (todays.length === 0) return;

    let cancelled = false;
    void (async () => {
      // The upcoming window holds no history, so past releases are fetched
      // separately before anything is measured.
      const history = await fetchPastOccurrences(apiKey, todays.map((event) => event.title)).catch(
        () => [] as CalendarEvent[],
      );

      const next: Record<string, BaseRate> = {};
      for (const event of todays) {
        const past = history
          .filter((other) => other.title === event.title && other.time < Date.now() - WINDOW_MS)
          .slice(-12);

        const outcomes: EventOutcome[] = [];
        for (const occurrence of past) {
          const candles: Candle[] = await api
            .historyAround(occurrence.time - WINDOW_MS, occurrence.time + 2 * WINDOW_MS)
            .catch(() => []);
          const outcome = measureOutcome(candles, occurrence.time, WINDOW_MS);
          if (outcome) outcomes.push(outcome);
        }
        next[event.id] = summariseOutcomes(outcomes);
      }
      if (!cancelled) setRates(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [events, apiKey]);

  const grouped = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const day = formatLocalDay(event.time);
      map.set(day, [...(map.get(day) ?? []), event]);
    }
    return [...map.entries()];
  }, [events]);

  return (
    <div className="space-y-3">
      <Card
        title="Economic calendar"
        subtitle={`Times shown in ${LOCAL_TIMEZONE}`}
        actions={
          <div className="flex items-center gap-2">
            {loadedAt && <Chip tone="neutral">updated {formatLocalTime(loadedAt)}</Chip>}
            <button className="btn btn-ghost px-3 py-1.5 text-xs" disabled={loading} onClick={() => void load()}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        }
        bodyClass="p-4 space-y-3"
      >
        <p className="text-xs leading-relaxed text-[var(--color-ink-muted)]">
          US releases that move gold, from Trading Economics. Impact is their own grading. The guest key
          covers a limited set of countries; a paid key widens it.
        </p>
        <p className="rounded-lg border border-[var(--color-line)] bg-[#0a1220] px-3 py-2 text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]">
          On the day of a release this screen shows a <span className="font-semibold text-ink">base rate</span>:
          how often {config.symbol} closed higher an hour after past releases of the same event, measured
          from your broker's price history. It describes what happened before and is
          {' '}<span className="font-semibold text-ink">not a forecast</span> — it does not say which way the
          next print will go, and no honest source can.
        </p>
        <div className="max-w-sm">
          <TextField
            label="Trading Economics key"
            type="password"
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              localStorage.setItem(KEY_STORAGE, value);
            }}
            placeholder="guest:guest"
            hint="Left empty the guest key is used. Stored in this browser only."
          />
        </div>
        {error && (
          <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs leading-relaxed text-loss">
            {error}
          </p>
        )}
      </Card>

      {grouped.length === 0 && !loading && !error && (
        <Card bodyClass="p-0">
          <EmptyState
            title="No releases in the window"
            hint="Nothing gold-relevant is scheduled in the next week, or the calendar returned nothing."
          />
        </Card>
      )}

      {grouped.map(([day, dayEvents]) => (
        <Card key={day} title={day} subtitle={`${dayEvents.length} release(s)`} bodyClass="p-0">
          <ul>
            {dayEvents.map((event) => (
              <EventRow key={event.id} event={event} rate={rates[event.id]} symbol={config.symbol} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
