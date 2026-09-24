import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { burstSize, formatMoney, formatPrice, type AccountState, type StrategyInfo } from '@sentinal/shared';
import { api } from '../api';
import type { SessionState } from '../backend/session';
import { startBotNow, stopBotNow } from '../components/botActions';
import { StrategySwitch } from '../components/StrategySwitch';
import { toast } from '../components/Toast';
import { Money } from '../components/ui';
import { useTerminal } from '../store';

/* ------------------------------------------------------------------ */
/* Icons, drawn to match the reference panel                           */
/* ------------------------------------------------------------------ */

const ServerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
    <rect x="3.5" y="4" width="17" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
    <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
    <path d="M7 7.25h.01M7 16.75h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

const RobotIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
    <rect x="4" y="7.5" width="16" height="11.5" rx="3" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 3.5v4M9 13h.01M15 13h.01M2.5 12v3M21.5 12v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const PulseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
    <path d="M2.5 12h4l2.5-6 4.5 12 2.5-6h5.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
    <path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10h6.6L14 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TargetIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden="true">
    <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const DialIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden="true">
    <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="10" cy="10" r="4.2" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 2" />
  </svg>
);

const BrainIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden="true">
    <path d="M7.5 4.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1 4.6A2.5 2.5 0 0 0 7.5 15.5V4.5ZM12.5 4.5A2.5 2.5 0 0 1 15 7a2.5 2.5 0 0 1 1 4.6 2.5 2.5 0 0 1-3.5 3.9V4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

const LinkIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden="true">
    <path d="M8.4 11.6 6 14a2.8 2.8 0 1 1-4-4l2.4-2.4M11.6 8.4 14 6a2.8 2.8 0 1 1 4 4l-2.4 2.4M7.6 12.4l4.8-4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The price line of the reference panel: flame on black, over a dashed open line. */
function LiveLine({ points }: { points: number[] }) {
  if (points.length < 2) {
    return <div className="grid h-[112px] place-items-center text-xs text-[var(--color-ink-muted)]">Waiting for quotes…</div>;
  }
  const width = 320;
  const height = 112;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(1e-9, max - min);
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => height - 10 - ((v - min) / span) * (height - 20);
  const line = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const base = y(points[0]!);
  const last = points[points.length - 1]!;
  const up = last >= points[0]!;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-[112px] w-full" role="img" aria-label="Recent price">
      <defs>
        <linearGradient id="live-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-flame)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-flame)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2={width} y1={base} y2={base} stroke="#8b8f97" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="3 4" />
      <polygon points={`0,${height} ${line} ${width},${height}`} fill="url(#live-fill)" />
      <polyline points={line} fill="none" stroke="var(--color-flame)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(points.length - 1)} cy={y(last)} r="3.4" fill={up ? 'var(--color-profit)' : 'var(--color-loss)'} />
    </svg>
  );
}

type CheckState = 'ok' | 'wait' | 'off' | 'bad';

const DOT: Record<CheckState, string> = {
  ok: 'bg-profit live-dot',
  wait: 'bg-warn',
  off: 'bg-[#4a4f57]',
  bad: 'bg-loss',
};

function Check({ icon, title, detail, state }: { icon: ReactNode; title: string; detail: string; state: CheckState }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="text-[var(--color-flame)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.8125rem] font-medium text-ink">{title}</span>
        <span className="block truncate text-[0.6875rem] text-[var(--color-ink-muted)]">{detail}</span>
      </span>
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} aria-label={state} />
    </li>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="panel-field-label">{label}</p>
      <p className="panel-field-value">{value}</p>
    </div>
  );
}

const ACCOUNT_TYPE: Record<AccountState['accountType'], string> = {
  real: 'Live',
  demo: 'Demo',
  contest: 'Contest',
  sim: 'Simulated',
};

function strategyLine(strategy: StrategyInfo | null, running: boolean): { state: CheckState; detail: string } {
  if (!strategy) return { state: 'off', detail: 'No strategy loaded' };
  if (strategy.status === 'failed') return { state: 'bad', detail: strategy.detail ?? `${strategy.name} stopped with an error` };
  if (!running) return { state: 'off', detail: `${strategy.name} — stopped` };
  if (strategy.status === 'waiting') return { state: 'wait', detail: strategy.detail ?? `${strategy.name} is loading history` };
  if (strategy.source === 'mql5') {
    const speed = strategy.lastTickMs !== null ? ` · ${strategy.lastTickMs < 1 ? strategy.lastTickMs.toFixed(3) : strategy.lastTickMs.toFixed(1)} ms per tick` : '';
    return { state: 'ok', detail: `${strategy.name}: ${strategy.ticks.toLocaleString()} ticks read${speed}` };
  }
  if (strategy.source === 'mirror') return { state: 'ok', detail: `Copying ${strategy.name} from your MetaTrader` };
  return { state: 'ok', detail: `${strategy.name}: ${strategy.ticks.toLocaleString()} signals scored${strategy.detail ? ` · ${strategy.detail}` : ''}` };
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

/**
 * The one-screen control panel: connection, the MT5 account, what the bot
 * is doing right now, and the two buttons that start and stop it. Every
 * light on it reports something measured — nothing here is decoration.
 */
export function ControlPanel({ session, onOpenSettings }: { session: SessionState; onOpenSettings: () => void }) {
  const { accounts, quote, quoteAt, candles, stats, strategy, dispatches, positions, config } = useTerminal();
  const [busy, setBusy] = useState<'start' | 'stop' | 'remove' | null>(null);
  const now = useNow();

  const master = accounts.find((a) => a.role === 'master') ?? accounts[0];
  const followers = accounts.filter((a) => a.role === 'slave');
  const running = stats?.running ?? false;
  const demo = session.status === 'demo';
  const live = session.status === 'live' && session.execution === 'broker';

  const points = useMemo(() => {
    const closes = candles.slice(-48).map((c) => c.close);
    if (quote) closes.push((quote.bid + quote.ask) / 2);
    return closes;
  }, [candles, quote]);

  const quoteAge = quoteAt ? Math.max(0, (now - quoteAt) / 1000) : null;
  const market: { state: CheckState; detail: string } = !quote
    ? { state: 'wait', detail: 'Waiting for the first quote' }
    : quoteAge !== null && quoteAge > 20
      ? { state: 'wait', detail: `${quote.symbol}: no quote for ${Math.round(quoteAge)}s — market closed or stream paused` }
      : { state: 'ok', detail: `${quote.symbol} ${formatPrice(quote.bid)} / ${formatPrice(quote.ask)} · ${quoteAge !== null && quoteAge < 1 ? 'just now' : `${Math.round(quoteAge ?? 0)}s ago`}` };

  const spread = quote ? quote.ask - quote.bid : null;
  const stops: { state: CheckState; detail: string } = !master
    ? { state: 'off', detail: 'No account linked' }
    : !master.connected
      ? { state: 'bad', detail: master.connectionError ?? 'Account offline' }
      : {
          state: 'ok',
          detail: `${
            config.source !== 'builtin'
              ? 'Stops set by the EA'
              : config.strategy === 'burst'
                ? `TP +${config.burst.takeProfitPrice.toFixed(2)} on every position${config.burst.stopLossPrice ? ` · SL ${config.burst.stopLossPrice.toFixed(2)}` : ' · no stop loss'}`
                : `SL ${formatMoney(config.stopLossUsd)} · TP ${formatMoney(config.takeProfitUsd)} per leg`
          }${spread !== null ? ` · spread ${spread.toFixed(2)}` : ''}${master.quoteIntervalSec !== null ? (master.quoteIntervalSec === 0 ? ' · every tick' : ` · quotes each ${master.quoteIntervalSec}s`) : ''}`,
        };
  const scoring = strategyLine(strategy, running);

  const lastCopy = dispatches.find((d) => d.legs.some((l) => l.role === 'follower'));
  const onlineFollowers = followers.filter((f) => f.connected).length;
  const copying: { state: CheckState; detail: string } =
    followers.length === 0
      ? { state: 'off', detail: 'No followers linked — add them under Accounts' }
      : onlineFollowers < followers.length
        ? { state: 'wait', detail: `${onlineFollowers} of ${followers.length} followers connected` }
        : {
            state: 'ok',
            detail: lastCopy
              ? `${followers.length} follower(s) · last copy left ${lastCopy.sendSpreadMs < 1 ? '<1' : lastCopy.sendSpreadMs.toFixed(1)} ms after the master's order`
              : `${followers.length} follower(s) connected, ready to copy`,
          };

  const strategyName = strategy?.name ?? 'Sentinal';
  const monitoring = running
    ? `${strategyName} is monitoring your ${live ? 'live' : demo ? 'demo' : 'paper'} account`
    : `Start the bot to let ${strategyName} trade`;

  const start = async () => {
    setBusy('start');
    await startBotNow();
    setBusy(null);
  };
  const stop = async () => {
    setBusy('stop');
    await stopBotNow(false);
    setBusy(null);
  };
  const remove = async () => {
    const message = demo
      ? 'Leave demo mode?'
      : 'Disconnect this MT5 account from Sentinal? Open positions stay open at your broker; the bot stops watching them.';
    if (!window.confirm(message)) return;
    setBusy('remove');
    try {
      await api.signOut();
      toast(demo ? 'Demo closed' : 'Account disconnected', 'info');
    } finally {
      setBusy(null);
    }
  };

  const connectedTo = session.status === 'live' ? session.broker.broker : demo ? 'the demo market' : '—';
  const burstCount = master ? burstSize(master.balance, config.burst.positionsPerStep, config.burst.balanceStep, config.burst.maxPositions) : 0;
  const botPositions = positions.filter((p) => p.accountId === master?.id);
  const floating = botPositions.reduce((sum, p) => sum + p.profit, 0);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 pb-6">
      {/* Connection */}
      <header className="px-1 pt-1">
        <p className={`text-2xl font-extrabold tracking-wide ${master?.connected ? 'text-[#2bd26b]' : 'text-warn'}`}>
          {master?.connected ? 'CONNECTED' : 'CONNECTING'}
        </p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-muted)]">
          {master?.connected ? `Connected to ${connectedTo}` : master?.connectionError ?? 'Reaching your broker…'}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span className={`chip ${live ? 'border-loss/50 bg-loss/12 text-loss' : 'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]'}`}>
            {demo ? 'Simulated' : live ? 'Real orders' : 'Paper orders'}
          </span>
          {master?.avgLatencyMs !== null && master?.avgLatencyMs !== undefined && (
            <span className="chip border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]">
              broker ack {master.avgLatencyMs} ms
            </span>
          )}
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* MT5 account */}
        <section className="card p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="panel-head">
              <ServerIcon /> {master?.platform === 'mt4' ? 'MT4' : 'MT5'} Account
            </h2>
            <button
              className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-stop)] disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              <TrashIcon /> Remove
            </button>
          </div>

          {master ? (
            <div className="mt-5 space-y-4">
              <Field label="Broker" value={master.broker} />
              <Field label="Login" value={master.login} />
              <Field label="Server" value={master.server} />
              <Field label="Account type" value={ACCOUNT_TYPE[master.accountType]} />
              <div className="grid grid-cols-3 gap-3 border-t border-[var(--color-line)] pt-4">
                <div>
                  <p className="panel-field-label">Balance</p>
                  <p className="tabular mt-1 text-sm font-semibold text-ink">{formatMoney(master.balance)}</p>
                </div>
                <div>
                  <p className="panel-field-label">Equity</p>
                  <p className="tabular mt-1 text-sm font-semibold text-ink">{formatMoney(master.equity)}</p>
                </div>
                <div>
                  <p className="panel-field-label">Floating</p>
                  <p className="mt-1 text-sm font-semibold">
                    <Money value={floating} />
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-[var(--color-ink-muted)]">No account linked.</p>
          )}
        </section>

        {/* Live analysis */}
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-[0.8125rem] font-bold uppercase tracking-wide text-[#2bd26b]">
            <PulseIcon /> Live analysis
          </h2>
          <div className="mt-3 overflow-hidden rounded-xl bg-black/40">
            <LiveLine points={points} />
          </div>
          <ul className="mt-2 divide-y divide-[var(--color-line)]/60">
            <Check icon={<TargetIcon />} title="Reading market" detail={market.detail} state={market.state} />
            <Check icon={<DialIcon />} title="Calibrating stop loss" detail={stops.detail} state={stops.state} />
            <Check icon={<BrainIcon />} title="Scoring signals" detail={scoring.detail} state={scoring.state} />
            <Check icon={<LinkIcon />} title="Copying to followers" detail={copying.detail} state={copying.state} />
          </ul>
          <p className="mt-3 text-center text-xs text-[var(--color-ink-dim)]">{monitoring}</p>
        </section>
      </div>

      {/* Bot control */}
      <section className="card p-5">
        <h2 className="panel-head">
          <RobotIcon /> Bot control
        </h2>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-ink">Bot Status</p>
            <p className="mt-1 flex items-center gap-2 text-sm">
              <span className={`h-2 w-2 rounded-full ${running ? 'bg-profit live-dot' : 'bg-[#4a4f57]'}`} />
              <span className={running ? 'font-semibold text-profit' : 'text-[var(--color-ink-muted)]'}>
                {running ? 'Running' : 'Stopped'}
              </span>
              {stats?.haltReason && <span className="text-xs text-loss">· {stats.haltReason}</span>}
            </p>
          </div>
          <button className="text-right text-xs font-semibold text-[var(--color-ink-muted)] underline decoration-[var(--color-flame)]/50 underline-offset-4" onClick={onOpenSettings}>
            Strategy settings
          </button>
        </div>

        <div className="mt-4">
          <StrategySwitch compact />
        </div>

        {config.source === 'builtin' && config.strategy === 'burst' && master && (
          <p className="tabular mt-3 rounded-xl border border-[var(--color-line)] bg-black/30 px-3.5 py-2.5 text-[0.75rem] leading-relaxed text-[var(--color-ink-dim)]">
            Next burst: <span className="font-semibold text-ink">{burstCount} × {config.burst.lot.toFixed(2)}</span>{' '}
            {config.burst.direction === 'trend' ? 'with the trend' : config.burst.direction.toUpperCase()} · TP +{config.burst.takeProfitPrice.toFixed(2)}
            {config.burst.stopLossPrice ? ` · SL ${config.burst.stopLossPrice.toFixed(2)}` : ' · no stop loss'}
            {burstCount > 0 && (
              <span className="block text-[var(--color-ink-muted)]">
                +{formatMoney(burstCount * config.burst.lot * 100 * config.burst.takeProfitPrice)} if it reaches take profit ·{' '}
                <span className="text-loss">a {(master.balance / (burstCount * config.burst.lot * 100)).toFixed(2)} move against it costs the whole balance</span>
              </span>
            )}
          </p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button className="btn btn-go py-3.5 text-sm font-bold uppercase tracking-wide" disabled={running || busy !== null || !master} onClick={() => void start()}>
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
              <path d="M16 10a6 6 0 1 1-2.2-4.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {busy === 'start' ? 'Starting…' : 'Start bot'}
          </button>
          <button className="btn btn-stop py-3.5 text-sm font-bold uppercase tracking-wide" disabled={!running || busy !== null} onClick={() => void stop()}>
            <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
              <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
            {busy === 'stop' ? 'Stopping…' : 'Stop bot'}
          </button>
        </div>

        {strategy && (strategy.panel.length > 0 || strategy.comment) && (
          <details className="mt-4 rounded-xl border border-[var(--color-line)] bg-black/30 px-3.5 py-2.5" open={running}>
            <summary className="cursor-pointer text-xs font-semibold text-[var(--color-ink-dim)]">{strategy.name} — status panel</summary>
            <pre className="tabular mt-2 overflow-x-auto whitespace-pre text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]">
              {[...strategy.panel, ...(strategy.comment ? [strategy.comment] : [])].join('\n')}
            </pre>
          </details>
        )}
      </section>

      {followers.length > 0 && (
        <section className="card p-5">
          <h2 className="panel-head">
            <LinkIcon /> Copy followers
          </h2>
          <ul className="mt-3 divide-y divide-[var(--color-line)]/70">
            {followers.map((f) => (
              <li key={f.id} className="flex items-center gap-3 py-2.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${f.connected ? 'bg-profit' : 'bg-loss'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{f.name}</span>
                  <span className="tabular block truncate text-[0.6875rem] text-[var(--color-ink-muted)]">
                    {f.login} · {f.server} · {f.symbol} · ×{f.copy.sizing === 'multiplier' ? f.copy.multiplier : f.copy.sizing === 'fixed' ? `${f.copy.fixedLot} lot` : 'balance'}
                  </span>
                </span>
                <span className="tabular shrink-0 text-right text-[0.6875rem] text-[var(--color-ink-dim)]">
                  {f.avgLatencyMs !== null ? `${f.avgLatencyMs} ms` : '—'}
                  <span className="block text-[var(--color-ink-muted)]">{f.openPositions} open</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
