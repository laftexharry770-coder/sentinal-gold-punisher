import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AI_REGIME_LABELS, burstSize, formatMoney, formatPrice, type AccountState, type AiStatus, type BotConfig, type ExpertSlot, type StrategyInfo } from '@sentinal/shared';
import { api } from '../api';
import type { SessionState } from '../backend/session';
import { AiPanel } from '../components/AiPanel';
import { startBotNow, stopBotNow } from '../components/botActions';
import { StrategySwitch } from '../components/StrategySwitch';
import { toast } from '../components/Toast';
import { Money } from '../components/ui';
import { useTerminal } from '../store';

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

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

/** Recent price in ice, over a dashed line at where the window opened. */
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
          <stop offset="0%" stopColor="var(--color-ice)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-ice)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2={width} y1={base} y2={base} style={{ stroke: 'var(--color-ink-muted)' }} strokeOpacity="0.55" strokeWidth="1" strokeDasharray="3 4" />
      <polygon points={`0,${height} ${line} ${width},${height}`} fill="url(#live-fill)" />
      <polyline points={line} fill="none" stroke="var(--color-ice)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(points.length - 1)} cy={y(last)} r="3.4" fill={up ? 'var(--color-profit)' : 'var(--color-loss)'} />
    </svg>
  );
}

type CheckState = 'ok' | 'wait' | 'off' | 'bad';

const DOT: Record<CheckState, string> = {
  ok: 'bg-profit live-dot',
  wait: 'bg-warn',
  off: 'bg-[var(--color-ink-faint)]',
  bad: 'bg-loss',
};

const STATE_LABEL: Record<CheckState, string> = { ok: 'working', wait: 'waiting', off: 'off', bad: 'problem' };

function Check({ icon, title, detail, state }: { icon: ReactNode; title: string; detail: string; state: CheckState }) {
  return (
    <li className="well flex items-start gap-3 px-3 py-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-ice)]/10 text-[var(--color-ice)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[0.8125rem] font-semibold text-ink">{title}</span>
          <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} role="img" aria-label={STATE_LABEL[state]} />
        </span>
        <span className="mt-0.5 line-clamp-2 text-[0.71875rem] leading-snug text-[var(--color-ink-muted)]" title={detail}>
          {detail}
        </span>
      </span>
    </li>
  );
}

/** A figure in the hero strip: a quiet label over a tabular number. */
function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.75rem] text-[var(--color-ink-muted)]">{label}</p>
      <p className="tabular mt-0.5 truncate text-[0.9375rem] font-semibold text-ink">{children}</p>
    </div>
  );
}

const ACCOUNT_TYPE: Record<AccountState['accountType'], string> = {
  real: 'Live',
  demo: 'Demo',
  contest: 'Contest',
  sim: 'Simulated',
};

/** What is making the decisions, in one line: the built-in model (or the AI's read) and every EA switched on. */
function strategyLine(strategy: StrategyInfo | null, experts: ExpertSlot[], ai: AiStatus | null, config: BotConfig, running: boolean): { state: CheckState; detail: string } {
  const on = experts.filter((e) => e.enabled);
  const failed = on.find((e) => e.info.status === 'failed');
  if (failed) return { state: 'bad', detail: `${failed.info.name}: ${failed.info.detail ?? 'stopped with an error'}` };
  const parts: string[] = [];
  const reading = ai?.reading;
  if (config.strategy === 'ai' || (config.strategy === 'burst' && config.burst.direction === 'ai')) {
    if (reading && reading.ready) {
      const p = Math.max(reading.probabilityUp, 1 - reading.probabilityUp);
      parts.push(`AI: ${reading.probabilityUp >= 0.5 ? 'BUY' : 'SELL'} ${(p * 100).toFixed(0)}% (needs ${(reading.threshold * 100).toFixed(0)}%) · ${AI_REGIME_LABELS[reading.regime].toLowerCase()}`);
    } else {
      parts.push(`AI ${reading?.warmup ?? 'warming up'}`);
    }
  }
  if (config.strategy !== 'none' && config.strategy !== 'ai' && strategy) {
    parts.push(`${strategy.name}${running && strategy.detail ? `: ${strategy.detail}` : ''}`);
  }
  if (on.length > 0) {
    const ticking = on.filter((e) => e.info.status === 'running');
    parts.push(running ? `${ticking.length}/${on.length} EA${on.length > 1 ? 's' : ''} running (${on.map((e) => e.info.name).join(', ')})` : `${on.length} EA${on.length > 1 ? 's' : ''} on`);
  }
  if (parts.length === 0) return { state: 'off', detail: 'Nothing chosen — pick Burst or the AI, or switch on an EA' };
  if (!running) return { state: 'off', detail: `${parts.join(' · ')} — stopped` };
  if (on.some((e) => e.info.status === 'waiting')) return { state: 'wait', detail: parts.join(' · ') };
  return { state: 'ok', detail: parts.join(' · ') };
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
  const { accounts, quote, quoteAt, candles, stats, strategy, dispatches, positions, config, experts, ai } = useTerminal();
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
            config.strategy === 'none'
              ? 'Stops set by the EAs'
              : config.strategy === 'ai'
                ? `AI: stop ${config.ai.slAtr} ATR · target ${config.ai.rrMin}–${config.ai.rrMax}R · ${config.ai.riskPercent}% risk`
                : config.strategy === 'burst'
                  ? `TP +${config.burst.takeProfitPrice.toFixed(2)} on every position${config.burst.stopLossPrice ? ` · SL ${config.burst.stopLossPrice.toFixed(2)}` : ' · no stop loss'}`
                  : `SL ${formatMoney(config.stopLossUsd)} · TP ${formatMoney(config.takeProfitUsd)} per leg`
          }${spread !== null ? ` · spread ${spread.toFixed(2)}` : ''}${master.quoteIntervalSec !== null ? (master.quoteIntervalSec === 0 ? ' · every tick' : ` · quotes each ${master.quoteIntervalSec}s`) : ''}`,
        };
  const scoring = strategyLine(strategy, experts, ai, config, running);

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

  const deciders = [
    ...(config.strategy !== 'none' ? [config.strategy === 'ai' ? 'the AI' : strategy?.name ?? 'Sentinal'] : []),
    ...experts.filter((e) => e.enabled).map((e) => e.info.name),
  ];
  const strategyName = deciders.length === 0 ? 'nothing' : deciders.length <= 2 ? deciders.join(' and ') : `${deciders.slice(0, -1).join(', ')} and ${deciders[deciders.length - 1]}`;
  const monitoring = running
    ? `${strategyName.charAt(0).toUpperCase()}${strategyName.slice(1)} ${deciders.length > 1 ? 'are' : 'is'} monitoring your ${live ? 'live' : demo ? 'demo' : 'paper'} account`
    : deciders.length === 0
      ? 'Pick Burst or the AI, or switch on an EA, then start the bot'
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

  const first = points[0];
  const last = points[points.length - 1];
  const change = first !== undefined && last !== undefined && points.length > 1 ? last - first : null;
  const accountLine = master
    ? [master.broker, master.login, master.server, `${ACCOUNT_TYPE[master.accountType]} ${master.platform === 'mt4' ? 'MT4' : 'MT5'}`].filter(Boolean).join(' · ')
    : 'No account linked';

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 pb-6 lg:space-y-5">
      {/* Account and bot, at a glance */}
      <section className="card overflow-hidden">
        <div className="flex flex-col gap-6 p-5 sm:p-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`chip ${master?.connected ? 'border-profit/30 bg-profit/10 text-profit' : 'border-warn/30 bg-warn/10 text-warn'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${master?.connected ? 'bg-profit live-dot' : 'bg-warn'}`} />
                {master?.connected ? `Connected to ${connectedTo}` : master?.connectionError ?? 'Connecting…'}
              </span>
              <span className={`chip ${live ? 'border-loss/35 bg-loss/10 text-loss' : 'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]'}`}>
                {demo ? 'Simulated' : live ? 'Real orders' : 'Paper orders'}
              </span>
              {master?.avgLatencyMs !== null && master?.avgLatencyMs !== undefined && (
                <span className="chip tabular border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]">
                  broker ack {master.avgLatencyMs} ms
                </span>
              )}
            </div>
            <p className="mt-5 text-[0.8125rem] text-[var(--color-ink-muted)]">Equity</p>
            <p className="tabular mt-1 text-[2.25rem] font-semibold leading-none tracking-[-0.03em] text-ink sm:text-[2.75rem]">
              {master ? formatMoney(master.equity) : '—'}
            </p>
            <div className="mt-5 grid grid-cols-3 gap-4 sm:flex sm:gap-8">
              <Figure label="Balance">{master ? formatMoney(master.balance) : '—'}</Figure>
              <Figure label="Floating">
                <Money value={floating} />
              </Figure>
              <Figure label="Open">{botPositions.length}</Figure>
            </div>
          </div>

          <div className="flex w-full flex-col gap-3 lg:w-auto lg:max-w-sm lg:items-end">
            <div className="lg:text-right">
              <p className="flex items-center gap-2 text-sm lg:justify-end">
                <span className={`h-2 w-2 rounded-full ${running ? 'bg-profit live-dot' : 'bg-[var(--color-ink-faint)]'}`} />
                <span className={running ? 'font-semibold text-ink' : 'font-semibold text-[var(--color-ink-dim)]'}>{running ? 'Bot running' : 'Bot stopped'}</span>
              </p>
              <p className="mt-1 text-[0.8125rem] leading-snug text-[var(--color-ink-muted)]">{monitoring}</p>
              {stats?.haltReason && <p className="mt-1 text-[0.8125rem] text-loss">{stats.haltReason}</p>}
            </div>
            <div className="grid grid-cols-2 gap-2.5 lg:flex">
              <button className="btn btn-primary px-6 py-3 text-sm" disabled={running || busy !== null || !master} onClick={() => void start()}>
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M6.5 4.8v10.4a.8.8 0 0 0 1.2.7l8.3-5.2a.8.8 0 0 0 0-1.4L7.7 4.1a.8.8 0 0 0-1.2.7Z" fill="currentColor" />
                </svg>
                {busy === 'start' ? 'Starting…' : 'Start bot'}
              </button>
              <button className="btn btn-stop px-6 py-3 text-sm" disabled={!running || busy !== null} onClick={() => void stop()}>
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true">
                  <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" />
                </svg>
                {busy === 'stop' ? 'Stopping…' : 'Stop bot'}
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-line)] bg-[var(--color-surface-2)] px-5 py-3 sm:px-6">
          <p className="tabular min-w-0 truncate text-[0.75rem] text-[var(--color-ink-muted)]">{accountLine}</p>
          <button
            className="shrink-0 text-[0.75rem] font-semibold text-[var(--color-ink-muted)] transition-colors hover:text-loss disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void remove()}
          >
            {demo ? 'Leave demo' : 'Disconnect'}
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:gap-5">
        {/* Live analysis */}
        <section className="card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="panel-head">
                <PulseIcon /> Live analysis
              </h2>
              <p className="mt-0.5 text-[0.75rem] text-[var(--color-ink-muted)]">Every light reports something measured</p>
            </div>
            {quote && (
              <div className="text-right">
                <p className="tabular text-base font-semibold text-ink">{formatPrice((quote.bid + quote.ask) / 2)}</p>
                {change !== null && (
                  <p className={`tabular text-[0.75rem] font-medium ${change >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {change >= 0 ? '+' : '−'}
                    {Math.abs(change).toFixed(2)}
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="mt-4">
            <LiveLine points={points} />
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            <Check icon={<TargetIcon />} title="Reading market" detail={market.detail} state={market.state} />
            <Check icon={<DialIcon />} title="Stops and risk" detail={stops.detail} state={stops.state} />
            <Check icon={<BrainIcon />} title="Scoring signals" detail={scoring.detail} state={scoring.state} />
            <Check icon={<LinkIcon />} title="Copying to followers" detail={copying.detail} state={copying.state} />
          </ul>
        </section>

        {/* What trades */}
        <section className="card p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="panel-head">
              <RobotIcon /> Strategy
            </h2>
            <button className="text-[0.75rem] font-semibold text-[var(--color-ice)] hover:underline hover:underline-offset-4" onClick={onOpenSettings}>
              Settings
            </button>
          </div>

          <div className="mt-4">
            <StrategySwitch onManage={onOpenSettings} />
          </div>

          {config.strategy === 'burst' && master && (
            <div className="well tabular mt-3 px-3.5 py-2.5 text-[0.75rem] leading-relaxed text-[var(--color-ink-dim)]">
              Next burst: <span className="font-semibold text-ink">{burstCount} × {config.burst.lot.toFixed(2)}</span>{' '}
              {config.burst.direction === 'ai' ? "the AI's way" : config.burst.direction === 'trend' ? 'with the trend' : config.burst.direction.toUpperCase()} · TP +
              {config.burst.takeProfitPrice.toFixed(2)}
              {config.burst.stopLossPrice ? ` · SL ${config.burst.stopLossPrice.toFixed(2)}` : ' · no stop loss'}
              {burstCount > 0 && (
                <span className="block text-[var(--color-ink-muted)]">
                  +{formatMoney(burstCount * config.burst.lot * 100 * config.burst.takeProfitPrice)} if it reaches take profit ·{' '}
                  <span className="text-loss">a {(master.balance / (burstCount * config.burst.lot * 100)).toFixed(2)} move against it costs the whole balance</span>
                </span>
              )}
            </div>
          )}

          {experts
            .filter((e) => e.enabled && (e.info.panel.length > 0 || e.info.comment))
            .map((e) => (
              <details key={e.id} className="well mt-3 px-3.5 py-2.5" open={running}>
                <summary className="cursor-pointer text-[0.75rem] font-semibold text-[var(--color-ink-dim)]">{e.info.name} — status panel</summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre font-mono text-[0.6875rem] leading-relaxed text-[var(--color-ink-dim)]">
                  {[...e.info.panel, ...(e.info.comment ? [e.info.comment] : [])].join('\n')}
                </pre>
              </details>
            ))}
        </section>
      </div>

      <AiPanel onOpenSettings={onOpenSettings} />

      {followers.length > 0 && (
        <section className="card p-5">
          <h2 className="panel-head">
            <LinkIcon /> Copy followers
          </h2>
          <ul className="mt-3 divide-y divide-[var(--color-line)]">
            {followers.map((f) => (
              <li key={f.id} className="flex items-center gap-3 py-3">
                <span className={`h-2 w-2 shrink-0 rounded-full ${f.connected ? 'bg-profit' : 'bg-loss'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{f.name}</span>
                  <span className="tabular block truncate text-[0.71875rem] text-[var(--color-ink-muted)]">
                    {f.login} · {f.server} · {f.symbol} · ×{f.copy.sizing === 'multiplier' ? f.copy.multiplier : f.copy.sizing === 'fixed' ? `${f.copy.fixedLot} lot` : 'balance'}
                  </span>
                </span>
                <span className="tabular shrink-0 text-right text-[0.71875rem] text-[var(--color-ink-dim)]">
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
