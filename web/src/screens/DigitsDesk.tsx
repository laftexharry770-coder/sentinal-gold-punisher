import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  breakEvenPayout,
  expectedValue,
  fairWinChance,
  lastDigit,
  readUniformity,
  tallyDigits,
  uniformityChiSquared,
  zScore,
  type DigitContract,
  type DigitStats,
} from '@sentinal/shared';
import { api } from '../api';
import { DIGIT_CONTRACT_NAMES, type DerivSymbolInfo } from '../broker/derivClient';
import { Card, Chip, NumberField } from '../components/ui';

/** Ticks kept per symbol. Wide enough for the chi-squared to mean something. */
const WINDOW = 500;
/** Symbols watched at once, to stay inside Deriv's per-connection subscriptions. */
const MAX_WATCHED = 8;

const CONTRACTS: { id: DigitContract; label: string; barrier: boolean }[] = [
  { id: 'matches', label: 'Matches', barrier: true },
  { id: 'differs', label: 'Differs', barrier: true },
  { id: 'even', label: 'Even', barrier: false },
  { id: 'odd', label: 'Odd', barrier: false },
  { id: 'over', label: 'Over', barrier: true },
  { id: 'under', label: 'Under', barrier: true },
];

interface Feed {
  digits: number[];
  quote: number;
  decimals: number;
}

/** The bar of ten, with the expected 10% marked so a reader can see the noise. */
function Distribution({ stats }: { stats: DigitStats }) {
  const peak = Math.max(0.0001, ...stats.frequency);

  return (
    <div className="flex items-end gap-1" style={{ height: 92 }}>
      {stats.frequency.map((share, digit) => {
        const z = zScore(stats.counts[digit] ?? 0, stats.total, 0.1);
        const notable = Math.abs(z) >= 2;
        return (
          <div key={digit} className="flex flex-1 flex-col items-center gap-1">
            <span className="tabular text-[0.5625rem] text-[var(--color-ink-muted)]">
              {(share * 100).toFixed(0)}
            </span>
            <div className="relative flex w-full flex-1 items-end">
              {/* Where a uniform generator would put the top of every bar. */}
              <span
                aria-hidden
                className="absolute inset-x-0 border-t border-dashed border-[var(--color-ink-muted)]/35"
                style={{ bottom: `${(0.1 / peak) * 100}%` }}
              />
              <div
                className={`w-full rounded-sm ${
                  notable ? 'bg-[var(--color-brass)]' : 'bg-[var(--color-surface-3)]'
                }`}
                style={{ height: `${Math.max(2, (share / peak) * 100)}%` }}
              />
            </div>
            <span
              className={`tabular text-[0.625rem] font-semibold ${
                stats.last === digit ? 'text-[var(--color-brass-bright)]' : 'text-[var(--color-ink-dim)]'
              }`}
            >
              {digit}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The digits desk.
 *
 * Deriv's volatility indices come from a random number generator, so this
 * screen measures and never forecasts. It shows what a window of ticks
 * contained, whether that is unusual for chance, and what Deriv actually pays
 * — which is the only number that decides whether a contract is worth taking.
 */
export function DigitsDesk() {
  const [symbols, setSymbols] = useState<DerivSymbolInfo[]>([]);
  const [watched, setWatched] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [feeds, setFeeds] = useState<Record<string, Feed>>({});
  const [error, setError] = useState<string | null>(null);

  const [contract, setContract] = useState<DigitContract>('even');
  const [barrier, setBarrier] = useState(5);
  const [stake, setStake] = useState(1);
  const [ticks, setTicks] = useState(1);
  const [quotePayout, setQuotePayout] = useState<number | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<string | null>(null);

  const stops = useRef(new Map<string, () => void>());

  useEffect(() => {
    let cancelled = false;
    void api
      .digitSymbols()
      .then((list) => {
        if (cancelled) return;
        setSymbols(list);
        const open = list.filter((entry) => entry.open).slice(0, MAX_WATCHED);
        setWatched(open.map((entry) => entry.symbol));
        setActive(open[0]?.symbol ?? null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Could not list symbols.'));
    return () => {
      cancelled = true;
    };
  }, []);

  // One subscription per watched symbol, torn down as the set changes.
  useEffect(() => {
    const running = stops.current;

    for (const [symbol, stop] of [...running.entries()]) {
      if (!watched.includes(symbol)) {
        stop();
        running.delete(symbol);
      }
    }

    for (const symbol of watched) {
      if (running.has(symbol)) continue;
      const info = symbols.find((entry) => entry.symbol === symbol);
      const decimals = info && info.pip > 0 ? Math.max(0, Math.round(-Math.log10(info.pip))) : 2;
      // Registered immediately so a second pass cannot subscribe twice while
      // the first is still in flight.
      running.set(symbol, () => {});
      void api
        .streamDigits(symbol, (quote) => {
          setFeeds((prev) => {
            const feed = prev[symbol] ?? { digits: [], quote: 0, decimals };
            const digits = [...feed.digits, lastDigit(quote, decimals)];
            if (digits.length > WINDOW) digits.splice(0, digits.length - WINDOW);
            return { ...prev, [symbol]: { digits, quote, decimals } };
          });
        })
        .then((stop) => {
          if (running.has(symbol)) running.set(symbol, stop);
          else stop();
        })
        .catch(() => running.delete(symbol));
    }

    return () => {
      for (const stop of running.values()) stop();
      running.clear();
    };
  }, [watched, symbols]);

  const activeFeed = active ? feeds[active] : undefined;
  const stats = useMemo(() => tallyDigits(activeFeed?.digits ?? []), [activeFeed]);
  const uniformity = readUniformity(stats);

  const needsBarrier = CONTRACTS.find((c) => c.id === contract)?.barrier ?? false;
  const chance = fairWinChance(contract, barrier);
  const fairPayout = breakEvenPayout(contract, barrier);
  const edge = quotePayout !== null && stake > 0 ? expectedValue(contract, barrier, quotePayout / stake) : null;

  const order = useCallback(
    () => ({
      symbol: active ?? '',
      contract: DIGIT_CONTRACT_NAMES[contract] ?? 'DIGITEVEN',
      barrier,
      stake,
      ticks,
      currency: 'USD',
    }),
    [active, contract, barrier, stake, ticks],
  );

  // Deriv's payout is asked for whenever the ticket changes, so the edge shown
  // is the real one rather than an assumption.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setQuotePayout(null);
    const timer = window.setTimeout(() => {
      void api
        .digitProposal(order())
        .then((proposal) => !cancelled && setQuotePayout(proposal.payout))
        .catch(() => !cancelled && setQuotePayout(null));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, order]);

  const buy = async () => {
    setPlacing(true);
    setPlaced(null);
    setError(null);
    try {
      const result = await api.buyDigit(order());
      setPlaced(`${result.longcode || 'Contract bought'} — paid ${result.buyPrice.toFixed(2)}, pays ${result.payout.toFixed(2)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deriv refused the contract.');
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-3">
        <Card
          title="Markets"
          subtitle={`${watched.length} of ${symbols.length} streaming · ${WINDOW}-tick window`}
          bodyClass="p-2"
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {watched.map((symbol) => {
              const feed = feeds[symbol];
              const local = tallyDigits(feed?.digits ?? []);
              const info = symbols.find((entry) => entry.symbol === symbol);
              return (
                <button
                  key={symbol}
                  onClick={() => setActive(symbol)}
                  className={`card-flush px-3 py-2.5 text-left transition-colors ${
                    active === symbol ? 'border-[var(--color-brass)]/55' : 'hover:border-[#39404a]'
                  }`}
                >
                  <div className="truncate text-[0.6875rem] font-semibold text-ink">
                    {info?.displayName ?? symbol}
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <span className="tabular text-sm text-[var(--color-ink-dim)]">
                      {feed ? feed.quote.toFixed(feed.decimals) : '—'}
                    </span>
                    <span className="tabular text-lg font-semibold leading-none text-[var(--color-brass-bright)]">
                      {local.last ?? '—'}
                    </span>
                  </div>
                  <div className="tabular mt-1 text-[0.625rem] text-[var(--color-ink-muted)]">
                    {local.total > 0
                      ? `${Math.round((local.even / local.total) * 100)}% even · ${local.total} ticks`
                      : 'waiting…'}
                  </div>
                </button>
              );
            })}
          </div>

          {symbols.length > watched.length && (
            <div className="mt-2 flex flex-wrap gap-1.5 px-1 pb-1">
              {symbols
                .filter((entry) => !watched.includes(entry.symbol))
                .slice(0, 24)
                .map((entry) => (
                  <button
                    key={entry.symbol}
                    className="btn btn-ghost px-2 py-1 text-[0.625rem]"
                    disabled={watched.length >= MAX_WATCHED}
                    title={watched.length >= MAX_WATCHED ? `Watching the maximum of ${MAX_WATCHED}` : undefined}
                    onClick={() => setWatched((prev) => [...prev, entry.symbol])}
                  >
                    + {entry.displayName}
                  </button>
                ))}
            </div>
          )}
        </Card>

        <Card
          title={active ? (symbols.find((s) => s.symbol === active)?.displayName ?? active) : 'Digit distribution'}
          subtitle={stats.total > 0 ? `last ${stats.total} ticks` : 'waiting for ticks'}
          actions={
            <Chip
              tone={
                uniformity === 'very-unusual' ? 'loss' : uniformity === 'unusual' ? 'warn' : 'neutral'
              }
            >
              {uniformity === 'insufficient' ? 'too few ticks' : uniformity.replace('-', ' ')}
            </Chip>
          }
          bodyClass="p-4 space-y-3"
        >
          <Distribution stats={stats} />

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: 'Even', value: stats.total ? `${Math.round((stats.even / stats.total) * 100)}%` : '—' },
              { label: 'Odd', value: stats.total ? `${Math.round((stats.odd / stats.total) * 100)}%` : '—' },
              { label: 'Parity run', value: `${stats.parityStreak}` },
              { label: 'χ²', value: stats.total ? uniformityChiSquared(stats).toFixed(1) : '—' },
            ].map((tile) => (
              <div key={tile.label} className="card-flush px-3 py-2">
                <div className="text-[0.625rem] uppercase tracking-[0.08em] text-[var(--color-ink-muted)]">
                  {tile.label}
                </div>
                <div className="tabular mt-0.5 text-sm font-semibold text-ink">{tile.value}</div>
              </div>
            ))}
          </div>

          {/*
            The honest part. These indices are generated, not traded, so the
            window above describes the past and carries nothing about the next
            tick. Saying so beside the numbers is the whole point of showing
            them.
          */}
          <p className="rounded-lg border border-[var(--color-line)] bg-[#0e1116] px-3 py-2.5 text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]">
            These are Deriv's synthetic indices: a random number generator, audited as such, not a market.
            Each digit is an independent draw, so a hot digit or a long parity run is a fact about the ticks
            above and tells you nothing about the next one. The dashed line marks the 10% chance alone
            produces; bars reaching past it are the noise you would expect, not an edge.{' '}
            <span className="text-ink">
              χ² over 16.9 would be unusual for a fair generator — it still would not make the next digit
              predictable.
            </span>
          </p>
        </Card>
      </div>

      <div className="space-y-3">
        <Card title="Contract" subtitle="Priced by Deriv before you buy" bodyClass="p-4 space-y-3">
          <div>
            <label className="label">Type</label>
            <div className="grid grid-cols-3 gap-1.5">
              {CONTRACTS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setContract(option.id)}
                  className={`btn px-2 py-1.5 text-xs ${
                    contract === option.id ? 'btn-primary' : 'btn-ghost'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {needsBarrier && (
            <div>
              <label className="label">Digit</label>
              <div className="grid grid-cols-10 gap-1">
                {Array.from({ length: 10 }, (_, digit) => (
                  <button
                    key={digit}
                    onClick={() => setBarrier(digit)}
                    className={`tabular rounded-md border py-1.5 text-xs font-semibold transition-colors ${
                      barrier === digit
                        ? 'border-[var(--color-brass)] bg-[var(--color-brass)]/18 text-[var(--color-brass-bright)]'
                        : 'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]'
                    }`}
                  >
                    {digit}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Stake" value={stake} onChange={setStake} step={1} min={0.35} suffix="$" />
            <NumberField label="Ticks" value={ticks} onChange={(v) => setTicks(Math.round(v))} step={1} min={1} max={10} />
          </div>

          <dl className="space-y-1.5 rounded-lg border border-[var(--color-line)] bg-[#0e1116] px-3 py-2.5 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-ink-muted)]">Chance of winning</dt>
              <dd className="tabular font-semibold text-ink">{(chance * 100).toFixed(0)}%</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-ink-muted)]">Deriv pays</dt>
              <dd className="tabular font-semibold text-ink">
                {quotePayout === null ? '…' : `$${quotePayout.toFixed(2)}`}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-ink-muted)]">Break-even payout</dt>
              <dd className="tabular text-[var(--color-ink-dim)]">
                {Number.isFinite(fairPayout) ? `$${(fairPayout * stake).toFixed(2)}` : '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-[var(--color-line)] pt-1.5">
              <dt className="text-[var(--color-ink-muted)]">Expected return</dt>
              <dd className={`tabular font-semibold ${edge === null ? 'text-[var(--color-ink-dim)]' : edge < 0 ? 'text-loss' : 'text-profit'}`}>
                {edge === null ? '…' : `${(edge * 100).toFixed(1)}% per trade`}
              </dd>
            </div>
          </dl>

          {edge !== null && edge < 0 && (
            <p className="text-[0.6875rem] leading-relaxed text-[var(--color-ink-muted)]">
              Deriv pays less than the break-even figure, so every contract of this kind loses{' '}
              <span className="tabular text-loss">{(-edge * 100).toFixed(1)}%</span> of its stake on average.
              That is the house margin; no entry timing changes it, because the digits are independent.
            </p>
          )}

          {placed && (
            <p className="rounded-lg border border-profit/40 bg-profit/10 px-3 py-2 text-xs leading-relaxed text-profit">
              {placed}
            </p>
          )}
          {error && (
            <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs leading-relaxed text-loss">
              {error}
            </p>
          )}

          <button
            className="btn btn-primary w-full py-2.5"
            disabled={!active || placing || stake <= 0}
            onClick={() => void buy()}
          >
            {placing ? 'Sending…' : `Buy ${CONTRACTS.find((c) => c.id === contract)?.label}${needsBarrier ? ` ${barrier}` : ''}`}
          </button>
        </Card>

        <Card title="Watchlist" subtitle={`up to ${MAX_WATCHED} at once`} bodyClass="p-3 space-y-1.5">
          {watched.map((symbol) => (
            <div key={symbol} className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-[var(--color-ink-dim)]">
                {symbols.find((entry) => entry.symbol === symbol)?.displayName ?? symbol}
              </span>
              <button
                className="btn btn-ghost px-2 py-0.5 text-[0.625rem]"
                onClick={() => setWatched((prev) => prev.filter((s) => s !== symbol))}
              >
                Stop
              </button>
            </div>
          ))}
          {watched.length === 0 && (
            <p className="px-1 py-2 text-xs text-[var(--color-ink-muted)]">
              Nothing streaming. Add a market above.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
