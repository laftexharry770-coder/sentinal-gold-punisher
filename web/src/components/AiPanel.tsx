import { useEffect, useState } from 'react';
import { AI_REGIME_LABELS, type AiReading, type AiReview, type AiStatus } from '@sentinal/shared';
import { api } from '../api';
import { useTerminal } from '../store';
import { toast } from './Toast';

const SparkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
    <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7L4.5 10.9 10.1 9 12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    <path d="M18.5 16.5 19.3 18.7 21.5 19.5 19.3 20.3 18.5 22.5 17.7 20.3 15.5 19.5 17.7 18.7 18.5 16.5Z" fill="currentColor" />
  </svg>
);

const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/**
 * Chance of up against chance of down, with the bar the AI must clear on
 * each side shaded: the marker has to sit inside a shaded end before it
 * trades that way.
 */
function ProbabilityMeter({ reading }: { reading: AiReading }) {
  const p = reading.probabilityUp;
  const t = reading.threshold;
  const lean = p >= 0.5 ? 'buy' : 'sell';
  const pSide = Math.max(p, 1 - p);
  const clears = reading.ready && pSide >= t;
  const tone = !reading.ready || pSide < 0.52 ? 'text-[var(--color-ink-dim)]' : lean === 'buy' ? 'text-profit' : 'text-loss';
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className={`tabular text-[1.65rem] font-extrabold leading-none tracking-tight ${tone}`}>
            {!reading.ready ? 'Learning' : pSide < 0.52 ? 'No edge' : `${lean.toUpperCase()} ${pct(pSide)}`}
          </p>
          <p className="mt-1 text-[0.75rem] text-[var(--color-ink-muted)]">
            {!reading.ready
              ? reading.warmup
              : clears
                ? `clears the ${pct(t)} it asks for`
                : `needs ${pct(t)} before it trades`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[0.71875rem] font-medium text-[var(--color-ink-muted)]">Confidence</p>
          <p className="tabular text-sm font-semibold text-ink">{pct(reading.confidence)}</p>
        </div>
      </div>
      <div className="relative mt-3 h-3 rounded-full bg-gradient-to-r from-loss/35 via-[var(--color-surface-3)] to-profit/35" role="img" aria-label={`Chance price is higher: ${pct(p)}`}>
        {/* The zones the AI trades in. */}
        <span className="absolute inset-y-0 left-0 rounded-l-full bg-loss/45" style={{ width: `${(1 - t) * 100}%` }} />
        <span className="absolute inset-y-0 right-0 rounded-r-full bg-profit/45" style={{ width: `${(1 - t) * 100}%` }} />
        <span className="absolute inset-y-[-3px] left-1/2 w-px bg-[var(--color-ink-muted)]/70" />
        <span
          className={`absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--color-surface)] shadow-[0_0_0_1px_var(--color-line-strong)] transition-[left] duration-500 ${
            lean === 'buy' ? 'bg-profit' : 'bg-loss'
          } ${reading.ready ? '' : 'opacity-40'}`}
          style={{ left: `${p * 100}%` }}
        />
      </div>
      <div className="tabular mt-1.5 flex justify-between text-[0.6875rem] text-[var(--color-ink-muted)]">
        <span>SELL {pct(1 - p)}</span>
        <span>50%</span>
        <span>BUY {pct(p)}</span>
      </div>
    </div>
  );
}

function ExpertBars({ reading }: { reading: AiReading }) {
  const maxWeight = Math.max(...reading.experts.map((e) => e.weight), 0.001);
  return (
    <ul className="space-y-2">
      {reading.experts.map((e) => {
        const share = e.weight / maxWeight;
        const width = Math.abs(e.score) * 50;
        return (
          <li key={e.name} className="grid grid-cols-[6.5rem_minmax(0,1fr)_3.25rem] items-center gap-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_3.25rem_3.5rem]">
            <span className="truncate text-[0.75rem] text-[var(--color-ink-dim)]" title={e.label}>
              {e.label}
            </span>
            <span className="relative h-2 rounded-full bg-[var(--color-surface-3)]" role="img" aria-label={`${e.label}: ${e.score >= 0 ? 'bullish' : 'bearish'} ${Math.round(Math.abs(e.score) * 100)}%, weight ${pct(e.weight)}`}>
              <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--color-ink-muted)]/50" />
              <span
                className={`absolute inset-y-0 rounded-full ${e.score >= 0 ? 'bg-profit' : 'bg-loss'}`}
                style={{
                  left: e.score >= 0 ? '50%' : `${50 - width}%`,
                  width: `${width}%`,
                  opacity: 0.3 + 0.7 * share,
                }}
              />
            </span>
            <span className="tabular text-right text-[0.6875rem] text-[var(--color-ink-dim)]" title="Share of the vote in this kind of market">
              {pct(e.weight)}
            </span>
            <span className="tabular hidden text-right text-[0.6875rem] text-[var(--color-ink-muted)] sm:block" title="How often its direction was right">
              {e.hitRate === null ? '—' : pct(e.hitRate)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DangerMeter({ reading }: { reading: AiReading }) {
  const level = reading.danger.level;
  const segments = 10;
  const lit = Math.round(level * segments);
  const color = level >= 0.7 ? 'bg-loss' : level >= 0.4 ? 'bg-warn' : 'bg-profit';
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.71875rem] font-medium text-[var(--color-ink-muted)]">Danger</span>
        <span className={`tabular text-[0.75rem] font-semibold ${level >= 0.7 ? 'text-loss' : level >= 0.4 ? 'text-warn' : 'text-profit'}`}>
          {level >= 0.7 ? 'High' : level >= 0.4 ? 'Raised' : 'Calm'}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1" aria-hidden="true">
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full ${i < lit ? color : 'bg-[var(--color-surface-3)]'}`} />
        ))}
      </div>
      <p className="mt-1.5 text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">
        {reading.danger.reasons.length > 0 ? reading.danger.reasons.join(' · ') : `spread ${reading.spreadRatio.toFixed(1)}× its average · volatility ${reading.volatilityRatio.toFixed(1)}× normal`}
      </p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-well)] px-3 py-2.5">
      <p className="text-[0.71875rem] font-medium text-[var(--color-ink-muted)]">{label}</p>
      <p className="tabular mt-1 text-base font-semibold leading-none text-ink">{value}</p>
      {sub && <p className="mt-1 truncate text-[0.6875rem] text-[var(--color-ink-muted)]">{sub}</p>}
    </div>
  );
}

function ReviewView({ review, now }: { review: AiReview; now: number }) {
  const [open, setOpen] = useState(false);
  if (review.error) {
    return (
      <p className="text-[0.75rem] leading-relaxed text-loss">
        Review failed {ago(review.time, now)}: {review.error}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className={`text-[0.8125rem] leading-relaxed text-[var(--color-ink-dim)] ${open ? '' : 'line-clamp-3'}`}>{review.assessment || 'No comment.'}</p>
      {review.assessment.length > 180 && (
        <button className="text-[0.6875rem] font-semibold text-[var(--color-ink-muted)] underline underline-offset-4" onClick={() => setOpen((v) => !v)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
      {review.changes.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {review.changes.map((c) => (
            <li key={c} className={`chip ${review.applied ? 'border-profit/40 bg-profit/10 text-profit' : 'border-warn/40 bg-warn/10 text-warn'}`}>
              {c}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">No changes.</p>
      )}
      <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">
        {review.model} · {ago(review.time, now)}
        {review.inputTokens !== null && review.outputTokens !== null ? ` · ${review.inputTokens.toLocaleString()} in / ${review.outputTokens.toLocaleString()} out tokens` : ''}
      </p>
    </div>
  );
}

function ClaudeBlock({ ai, onOpenSettings }: { ai: AiStatus; onOpenSettings: () => void }) {
  const { config } = useTerminal();
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const claude = config.ai.claude;
  const last = ai.reviews[0] ?? null;

  const act = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name);
    try {
      await fn();
      if (done) toast(done);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-well)] p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[0.8125rem] font-semibold text-ink">
          <span className={`h-2 w-2 rounded-full ${ai.claude.busy ? 'bg-warn live-dot' : ai.claude.configured && claude.enabled ? 'bg-profit' : 'bg-[var(--color-ink-faint)]'}`} />
          Claude's review
        </p>
        <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">
          {!ai.claude.configured
            ? 'no API key'
            : ai.claude.busy
              ? 'reviewing now…'
              : ai.claude.nextReviewAt
                ? `next at ${clock(ai.claude.nextReviewAt)}`
                : claude.enabled
                  ? 'on — reviews while the AI trades'
                  : 'automatic reviews off'}
        </p>
      </div>

      {ai.pausedUntil && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/[0.07] px-3 py-2">
          <p className="text-[0.75rem] text-warn">New AI entries paused by the review until {clock(ai.pausedUntil)}</p>
          <button className="btn btn-ghost px-2.5 py-1 text-[0.6875rem]" disabled={busy !== null} onClick={() => void act('resume', () => api.resumeAi(), 'AI entries resumed')}>
            Resume now
          </button>
        </div>
      )}

      {ai.pending && (
        <div className="mt-3 space-y-2 rounded-lg border border-warn/40 bg-warn/[0.05] p-3">
          <p className="text-[0.8125rem] font-semibold text-warn">Suggestion waiting for you</p>
          <ReviewView review={ai.pending} now={now} />
          <div className="flex gap-2">
            <button className="btn btn-primary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void act('approve', () => api.approveAiSuggestion(), 'Suggestion applied')}>
              Apply
            </button>
            <button className="btn btn-ghost px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void act('dismiss', () => api.dismissAiSuggestion())}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="mt-3">
        {!ai.claude.configured ? (
          <p className="text-[0.75rem] leading-relaxed text-[var(--color-ink-muted)]">
            With an Anthropic API key, Claude reads the AI's results every so often and tunes its settings — within the limits you set.{' '}
            <button className="font-semibold text-ink underline decoration-[var(--color-ice)]/60 underline-offset-4" onClick={onOpenSettings}>
              Add a key in Settings
            </button>
          </p>
        ) : last && !ai.pending ? (
          <ReviewView review={last} now={now} />
        ) : !ai.pending ? (
          <p className="text-[0.75rem] text-[var(--color-ink-muted)]">No review yet.</p>
        ) : null}
      </div>

      {ai.claude.configured && (
        <div className="mt-3 flex justify-end">
          <button
            className="btn btn-ghost px-3 py-1.5 text-xs"
            disabled={busy !== null || ai.claude.busy}
            onClick={() =>
              void act('review', async () => {
                const review = await api.reviewAi();
                if (review?.error) throw new Error(review.error);
              })
            }
          >
            {busy === 'review' || ai.claude.busy ? 'Reviewing…' : 'Review now'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The AI, laid open: what kind of market it reads, how sure it is and which
 * way, which of its experts it is listening to and why, how dangerous the
 * tape looks, what it has learned so far — and Claude's latest review.
 */
export function AiPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { ai, config, experts } = useTerminal();
  const reading = ai?.reading ?? null;
  const role =
    config.strategy === 'ai'
      ? 'The AI is trading'
      : config.strategy === 'burst' && config.burst.direction === 'ai'
        ? 'The AI directs Burst'
        : 'The AI is advising';
  const guarding = config.ai.guardEas && experts.some((e) => e.enabled);

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-head">
          <SparkIcon /> AI analysis
        </h2>
        {reading && (
          <span className="chip border-[var(--color-ice)]/40 bg-[var(--color-ice)]/10 text-[var(--color-ice)]">{AI_REGIME_LABELS[reading.regime]}</span>
        )}
      </div>
      <p className="mt-1 text-[0.75rem] text-[var(--color-ink-muted)]">
        {role}
        {guarding ? ' · guarding your EAs' : ''}. It measures and learns; it cannot see the future, and it says how sure it is.
      </p>

      {!reading ? (
        <p className="mt-4 text-sm text-[var(--color-ink-muted)]">Waiting for the market…</p>
      ) : (
        <div className="mt-4 space-y-5">
          <ProbabilityMeter reading={reading} />

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <p className="text-[0.71875rem] font-medium text-[var(--color-ink-muted)]">Its experts</p>
                <p className="tabular text-[0.625rem] text-[var(--color-ink-muted)]">
                  sell ← vote → buy · weight<span className="hidden sm:inline"> · right</span>
                </p>
              </div>
              <ExpertBars reading={reading} />
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-[0.71875rem] font-medium text-[var(--color-ink-muted)]">Why</p>
                <ul className="mt-1.5 space-y-1.5">
                  {reading.reasons.map((r) => (
                    <li key={r} className="flex gap-2 text-[0.75rem] leading-snug text-[var(--color-ink-dim)]">
                      <span className="mt-[0.4rem] h-1 w-1 shrink-0 rounded-full bg-[var(--color-ice)]" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <DangerMeter reading={reading} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Stat label="Bars learned" value={reading.learning.samples.toLocaleString()} sub={`ATR ${reading.atr.toFixed(2)} · ADX ${reading.adx.toFixed(0)}`} />
            <Stat label="Direction right" value={pct(reading.learning.accuracy)} sub="recent predictions" />
            <Stat label="Confident calls" value={pct(reading.learning.confidentAccuracy)} sub="right, when sure" />
            <Stat
              label="AI trades"
              value={reading.learning.trades.toLocaleString()}
              sub={
                reading.learning.trades > 0
                  ? `${pct(reading.learning.winRate)} won · ${(reading.learning.expectancyR ?? 0) >= 0 ? '+' : ''}${(reading.learning.expectancyR ?? 0).toFixed(2)}R avg`
                  : 'none closed yet'
              }
            />
          </div>

          {ai && ai.guard.vetoes > 0 && (
            <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-well)] px-3.5 py-2.5 text-[0.75rem] text-[var(--color-ink-dim)]">
              EA guard refused <span className="font-semibold text-ink">{ai.guard.vetoes}</span> entr{ai.guard.vetoes === 1 ? 'y' : 'ies'}
              {ai.guard.last ? ` · last: ${ai.guard.last}` : ''}
            </p>
          )}

          {ai && <ClaudeBlock ai={ai} onOpenSettings={onOpenSettings} />}
        </div>
      )}
    </section>
  );
}
