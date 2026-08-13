import { useMemo, useState } from 'react';
import { formatMoney, formatPrice, formatVolume } from '@sentinal/shared';
import { api } from '../api';
import { CandleChart, Sparkline } from '../components/CandleChart';
import { LogFeed } from '../components/LogFeed';
import { PositionsTable } from '../components/PositionsTable';
import { Card, Chip, EmptyState, Money, NumberField, StatTile } from '../components/ui';
import { useTerminal } from '../store';

/** Manual order ticket — fires several legs at once, same as the bot burst. */
function QuickTrade() {
  const { accounts, config, quote } = useTerminal();
  const [accountId, setAccountId] = useState('');
  const [volume, setVolume] = useState(config.lotSize);
  // The ticket opens with the same burst size the engine uses.
  const [legs, setLegs] = useState(config.entriesPerSignal);
  const [stopLossUsd, setStopLossUsd] = useState(config.stopLossUsd);
  const [takeProfitUsd, setTakeProfitUsd] = useState(config.takeProfitUsd);
  const [busy, setBusy] = useState<'buy' | 'sell' | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const target = accountId || accounts.find((a) => a.role === 'master')?.id || accounts[0]?.id || '';

  const fire = async (side: 'buy' | 'sell') => {
    if (!target) return;
    setBusy(side);
    setFeedback(null);
    try {
      const result = await api.order({
        accountId: target,
        side,
        volume,
        legs,
        stopLossUsd,
        takeProfitUsd,
      });
      setFeedback({
        tone: 'ok',
        text: `${result.opened.length} × ${side.toUpperCase()} ${formatVolume(volume)} filled${
          result.errors.length ? ` · ${result.errors.length} rejected` : ''
        }`,
      });
    } catch (error) {
      setFeedback({ tone: 'err', text: error instanceof Error ? error.message : 'order failed' });
    } finally {
      setBusy(null);
    }
  };

  const notional = quote ? volume * legs * 100 * quote.ask : 0;

  return (
    <Card
      title="Quick trade"
      subtitle="Multi-leg market execution"
      actions={<Chip tone="cobalt">{legs} legs</Chip>}
      bodyClass="p-4 space-y-3"
    >
      <div>
        <label className="label">Account</label>
        <select className="field" value={target} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} · {formatMoney(account.equity)}
            </option>
          ))}
          {accounts.length === 0 && <option value="">No accounts linked</option>}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Lot / leg" value={volume} onChange={setVolume} step={0.01} min={0.01} suffix="lot" />
        <NumberField label="Legs" value={legs} onChange={(v) => setLegs(Math.max(1, Math.round(v)))} step={1} min={1} max={50} />
        <NumberField label="Stop loss" value={stopLossUsd} onChange={setStopLossUsd} step={0.5} min={0} suffix="$" />
        <NumberField label="Take profit" value={takeProfitUsd} onChange={setTakeProfitUsd} step={0.5} min={0} suffix="$" />
      </div>

      <p className="tabular text-[0.6875rem] text-[var(--color-ink-muted)]">
        Total {formatVolume(volume * legs)} lots · notional {formatMoney(notional)} · risk{' '}
        {formatMoney(stopLossUsd * legs)}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-buy" disabled={!target || busy !== null} onClick={() => void fire('buy')}>
          {busy === 'buy' ? 'Filling…' : `Buy ${quote ? formatPrice(quote.ask) : ''}`}
        </button>
        <button className="btn btn-sell" disabled={!target || busy !== null} onClick={() => void fire('sell')}>
          {busy === 'sell' ? 'Filling…' : `Sell ${quote ? formatPrice(quote.bid) : ''}`}
        </button>
      </div>

      {feedback && (
        <p className={`text-xs ${feedback.tone === 'ok' ? 'text-profit' : 'text-loss'}`}>{feedback.text}</p>
      )}
    </Card>
  );
}

export function Dashboard() {
  const { candles, quote, positions, accounts, portfolio, stats, equityCurve, config, logs, history } = useTerminal();

  const floating = useMemo(() => positions.reduce((sum, p) => sum + p.profit, 0), [positions]);
  const equityPoints = useMemo(() => equityCurve.map((p) => p.equity), [equityCurve]);
  const longs = positions.filter((p) => p.side === 'buy').length;
  const shorts = positions.length - longs;

  const closeAll = async (side?: 'buy' | 'sell') => {
    await api.closeAll(side ? { side } : {});
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          label="Equity"
          value={portfolio ? formatMoney(portfolio.equity) : '—'}
          sub={portfolio ? `balance ${formatMoney(portfolio.balance)}` : undefined}
        />
        <StatTile
          label="Floating P/L"
          value={<Money value={floating} />}
          tone="neutral"
          sub={`${longs} long · ${shorts} short`}
        />
        <StatTile
          label="Open legs"
          value={`${positions.length}`}
          tone="cobalt"
          sub={`cap ${config.maxConcurrentPositions} · ${config.entriesPerSignal}/signal`}
        />
        <StatTile
          label="Session P/L"
          value={<Money value={stats?.netProfit ?? 0} />}
          sub={stats ? `${stats.wins}W / ${stats.losses}L · ${stats.tradesOpened} fired` : undefined}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card
          title="XAUUSD · M1"
          subtitle={quote ? `bid ${formatPrice(quote.bid)} / ask ${formatPrice(quote.ask)}` : 'awaiting feed'}
          actions={
            <div className="flex items-center gap-1.5">
              <Chip tone="gold">Gold</Chip>
              <Chip tone={stats?.running ? 'profit' : 'neutral'}>{stats?.running ? 'Live' : 'Idle'}</Chip>
            </div>
          }
          className="self-start"
          bodyClass="p-2"
        >
          <div className="chart-well overflow-hidden">
            <CandleChart candles={candles} quote={quote} positions={positions} height={360} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 pb-1 pt-2 text-[0.6875rem] text-[var(--color-ink-muted)]">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-[var(--color-cobalt)]" /> live mid
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-profit" /> long entries
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-loss" /> short entries
            </span>
            <span className="hidden text-[var(--color-ink-muted)]/70 sm:inline">
              drag to pan · scroll or pinch to zoom · double-tap to return
            </span>
            {stats?.lastSignal && (
              <span className="ml-auto">
                signal: {stats.lastSignal.side ? stats.lastSignal.side.toUpperCase() : 'flat'} ·{' '}
                {stats.lastSignal.reason} ({Math.round(stats.lastSignal.strength * 100)}%)
              </span>
            )}
          </div>
        </Card>

        <div className="space-y-3">
          <QuickTrade />
          <Card title="Equity curve" subtitle="5-second samples" bodyClass="px-2 pb-2 pt-3">
            {equityPoints.length > 1 ? (
              <>
                <Sparkline points={equityPoints} height={70} />
                <div className="tabular flex justify-between px-2 pt-2 text-[0.6875rem] text-[var(--color-ink-muted)]">
                  <span>{formatMoney(Math.min(...equityPoints))}</span>
                  <span>{formatMoney(Math.max(...equityPoints))}</span>
                </div>
              </>
            ) : (
              <EmptyState title="Collecting samples…" />
            )}
          </Card>
        </div>
      </div>

      <Card
        title="Open positions"
        subtitle={`${positions.length} leg(s) across ${accounts.length} account(s)`}
        actions={
          <div className="flex gap-2">
            <button className="btn btn-ghost px-2.5 py-1.5 text-xs" onClick={() => void closeAll('buy')}>
              Close longs
            </button>
            <button className="btn btn-ghost px-2.5 py-1.5 text-xs" onClick={() => void closeAll('sell')}>
              Close shorts
            </button>
            <button className="btn px-2.5 py-1.5 text-xs" onClick={() => void closeAll()}>
              Close all
            </button>
          </div>
        }
        bodyClass="max-h-[380px] overflow-hidden"
      >
        <PositionsTable
          positions={positions}
          accounts={accounts}
          showAccount
          onClose={async (id) => {
            await api.closePosition(id);
          }}
        />
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Recent fills" subtitle="Closed trades, newest first" bodyClass="max-h-72 overflow-auto p-0">
          {history.length === 0 ? (
            <EmptyState title="No closed trades yet" />
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {history.slice(0, 40).map((trade) => (
                <li key={`${trade.id}-${trade.closeTime}`} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={trade.side === 'buy' ? 'font-semibold text-profit' : 'font-semibold text-loss'}>
                      {trade.side.toUpperCase()}
                    </span>
                    <span className="tabular text-[var(--color-ink-dim)]">
                      {formatVolume(trade.volume)} @ {formatPrice(trade.openPrice)} → {formatPrice(trade.closePrice)}
                    </span>
                    <Chip tone={trade.reason === 'tp' || trade.reason === 'basket-tp' ? 'profit' : trade.reason === 'sl' ? 'loss' : 'neutral'}>
                      {trade.reason}
                    </Chip>
                  </div>
                  <Money value={trade.netProfit} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Terminal log" subtitle="Execution, copy and recovery events" bodyClass="max-h-72 overflow-hidden p-0">
          <LogFeed logs={logs} accounts={accounts} limit={60} />
        </Card>
      </div>
    </div>
  );
}
