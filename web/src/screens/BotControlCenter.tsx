import { useMemo, useState } from 'react';
import { formatMoney, formatVolume, type RecoveryTask } from '@sentinal/shared';
import { api } from '../api';
import { LogFeed } from '../components/LogFeed';
import { PositionsTable } from '../components/PositionsTable';
import { Card, Chip, EmptyState, Money, StatTile } from '../components/ui';
import { useTerminal } from '../store';

function uptime(from: number | null): string {
  if (!from) return '—';
  const seconds = Math.floor((Date.now() - from) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`;
}

function RecoveryRow({ task }: { task: RecoveryTask }) {
  const tone = task.status === 'armed' ? 'profit' : task.status === 'fired' ? 'cobalt' : task.status === 'cancelled' ? 'neutral' : 'warn';
  return (
    <li className="flex flex-col gap-1 border-t border-[var(--color-line)] px-4 py-2.5 text-xs first:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Chip tone={tone}>{task.status}</Chip>
          <span className="font-medium text-ink">
            L{task.layer + 1} · {task.side.toUpperCase()} {formatVolume(task.volume)}
          </span>
        </div>
        <span className="tabular text-[var(--color-ink-dim)]">deficit {formatMoney(task.deficit)}</span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[var(--color-ink-muted)]">
        <span className="min-w-0 truncate">{task.holdReason || 'ready — projected net clears the deficit'}</span>
        <span className="tabular shrink-0">
          proj <Money value={task.projectedNet} />
        </span>
      </div>
    </li>
  );
}

export function BotControlCenter() {
  const { accounts, positions, config, stats, recoveries, logs } = useTerminal();
  const [tab, setTab] = useState<string>('all');
  const [busy, setBusy] = useState(false);

  const shown = useMemo(
    () => (tab === 'all' ? positions : positions.filter((p) => p.accountId === tab)),
    [positions, tab],
  );

  const copyLogs = useMemo(() => logs.filter((l) => l.level === 'copy' || l.level === 'trade'), [logs]);
  const winRate = stats && stats.wins + stats.losses > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0;
  const botLegs = positions.filter((p) => p.origin === 'bot' || p.origin === 'recovery');

  const control = async (action: 'start' | 'stop' | 'flatten') => {
    setBusy(true);
    try {
      if (action === 'start') await api.startBot();
      else if (action === 'stop') await api.stopBot(false);
      else await api.stopBot(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card
        title="Execution engine"
        subtitle={`${config.strategy} · ${config.execution} · ${config.symbol}`}
        actions={
          <div className="flex gap-2">
            <button className="btn btn-primary px-3 py-1.5 text-xs" disabled={busy || stats?.running} onClick={() => void control('start')}>
              Arm
            </button>
            <button className="btn px-3 py-1.5 text-xs" disabled={busy || !stats?.running} onClick={() => void control('stop')}>
              Disarm
            </button>
            <button className="btn btn-sell px-3 py-1.5 text-xs" disabled={busy} onClick={() => void control('flatten')}>
              Flatten
            </button>
          </div>
        }
        bodyClass="p-4 space-y-3"
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <StatTile
            label="Status"
            value={stats?.running ? 'ARMED' : 'IDLE'}
            tone={stats?.running ? 'profit' : 'neutral'}
            sub={stats?.running ? `up ${uptime(stats.startedAt)}` : 'engine disarmed'}
          />
          <StatTile
            label="Bot legs"
            value={`${botLegs.length}/${config.maxConcurrentPositions}`}
            tone="cobalt"
            sub={`${config.maxPositionsPerDirection}/side · ${config.entriesPerSignal} per signal`}
          />
          <StatTile label="Signals" value={stats?.signalsEvaluated ?? 0} sub={stats?.lastSignal?.reason ?? '—'} />
          <StatTile
            label="Win rate"
            value={`${winRate.toFixed(0)}%`}
            sub={stats ? `${stats.wins}W / ${stats.losses}L` : undefined}
            tone={winRate >= 50 ? 'profit' : 'loss'}
          />
          <StatTile label="Net P/L" value={<Money value={stats?.netProfit ?? 0} />} sub={`${stats?.tradesClosed ?? 0} closed`} />
          <StatTile
            label="Pending deficit"
            value={formatMoney(stats?.pendingDeficit ?? 0)}
            tone={(stats?.pendingDeficit ?? 0) > 0 ? 'gold' : 'neutral'}
            sub={config.zeroLoss.enabled ? 'zero-loss armed' : 'zero-loss off'}
          />
        </div>

        {stats?.haltReason && (
          <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">
            Engine halted — {stats.haltReason}. Guards reset at the next trading day.
          </div>
        )}
      </Card>

      <Card title="Linked terminals" subtitle="Multi-broker book" bodyClass="p-3">
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.map((account) => {
            const accountPositions = positions.filter((p) => p.accountId === account.id);
            const floating = accountPositions.reduce((sum, p) => sum + p.profit, 0);
            return (
              <div key={account.id} className="card-flush p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{account.name}</p>
                    <p className="tabular truncate text-[0.6875rem] text-[var(--color-ink-muted)]">
                      {account.login} · {account.server}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Chip tone={account.role === 'master' ? 'cobalt' : account.role === 'slave' ? 'gold' : 'neutral'}>
                      {account.role}
                    </Chip>
                    <Chip tone={account.connected ? 'profit' : 'loss'}>{account.connected ? 'online' : 'offline'}</Chip>
                  </div>
                </div>
                <div className="tabular mt-2.5 grid grid-cols-3 gap-2 border-t border-[var(--color-line)] pt-2 text-xs">
                  <div>
                    <p className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Equity</p>
                    <p className="font-medium">{formatMoney(account.equity)}</p>
                  </div>
                  <div>
                    <p className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Floating</p>
                    <Money value={floating} />
                  </div>
                  <div>
                    <p className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Legs</p>
                    <p className="font-medium">{accountPositions.length}</p>
                  </div>
                </div>
                <div className="mt-2.5 flex gap-2">
                  <button
                    className="btn btn-ghost flex-1 px-2 py-1 text-[0.6875rem]"
                    onClick={() => setTab(account.id)}
                  >
                    Inspect
                  </button>
                  <button
                    className="btn btn-ghost flex-1 px-2 py-1 text-[0.6875rem]"
                    onClick={() => void api.closeAll({ accountId: account.id })}
                  >
                    Close all
                  </button>
                </div>
                {account.connectionError && (
                  <p className="mt-2 text-[0.6875rem] leading-snug text-loss">{account.connectionError}</p>
                )}
              </div>
            );
          })}
          {accounts.length === 0 && (
            <EmptyState title="No terminals linked" hint="Add a broker on the Connect Broker screen to begin." />
          )}
        </div>
      </Card>

      <Card
        title="Position management"
        subtitle={`${shown.length} leg(s) shown`}
        actions={
          <div className="flex max-w-full gap-1 overflow-x-auto">
            <button
              className={`btn px-2.5 py-1 text-[0.6875rem] ${tab === 'all' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTab('all')}
            >
              All
            </button>
            {accounts.map((account) => (
              <button
                key={account.id}
                className={`btn whitespace-nowrap px-2.5 py-1 text-[0.6875rem] ${tab === account.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setTab(account.id)}
              >
                {account.name}
              </button>
            ))}
          </div>
        }
        bodyClass="max-h-[420px] overflow-hidden"
      >
        <PositionsTable
          positions={shown}
          accounts={accounts}
          showAccount={tab === 'all'}
          onClose={async (id) => {
            await api.closePosition(id);
          }}
        />
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card
          title="Zero-loss recovery queue"
          subtitle="Recoveries release only when the projected net clears the deficit"
          actions={<Chip tone={config.zeroLoss.enabled ? 'profit' : 'neutral'}>{config.zeroLoss.enabled ? 'armed' : 'disabled'}</Chip>}
          bodyClass="max-h-80 overflow-auto p-0"
        >
          {recoveries.length === 0 ? (
            <EmptyState
              title="Queue empty"
              hint="Losing trades are pooled into a deficit here; the engine postpones the recovery until it projects a net-positive close."
            />
          ) : (
            <ul>
              {recoveries.slice(0, 25).map((task) => (
                <RecoveryRow key={`${task.id}-${task.status}-${task.createdAt}`} task={task} />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Copy-trade & execution log" subtitle="Master → follower replication" bodyClass="max-h-80 overflow-hidden p-0">
          <LogFeed logs={copyLogs} accounts={accounts} limit={80} />
        </Card>
      </div>
    </div>
  );
}
