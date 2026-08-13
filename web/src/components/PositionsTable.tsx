import { useState } from 'react';
import { formatPrice, formatVolume, type AccountState, type Position } from '@sentinal/shared';
import { Chip, EmptyState, Money } from './ui';

const ORIGIN_TONE: Record<Position['origin'], 'accent' | 'gold' | 'neutral' | 'warn'> = {
  bot: 'accent',
  recovery: 'gold',
  copy: 'neutral',
  manual: 'warn',
};

function timeAgo(from: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function PositionsTable({
  positions,
  accounts,
  onClose,
  showAccount = false,
}: {
  positions: Position[];
  accounts: AccountState[];
  onClose: (id: string) => Promise<void> | void;
  showAccount?: boolean;
}) {
  const [closing, setClosing] = useState<string | null>(null);

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  const handleClose = async (id: string) => {
    setClosing(id);
    try {
      await onClose(id);
    } finally {
      setClosing(null);
    }
  };

  if (positions.length === 0) {
    return (
      <EmptyState
        title="No open positions"
        hint="Arm the bot or fire a manual multi-leg order — every open leg appears here with its live result."
      />
    );
  }

  return (
    <div className="h-full overflow-auto">
      {/* Desktop / tablet */}
      <table className="hidden w-full min-w-[720px] border-collapse text-sm md:table">
        <thead className="sticky top-0 z-10 bg-[var(--color-surface)]">
          <tr className="text-left text-[0.6875rem] uppercase tracking-[0.06em] text-[var(--color-ink-muted)]">
            <th className="px-3 py-2 font-semibold">Ticket</th>
            {showAccount && <th className="px-3 py-2 font-semibold">Account</th>}
            <th className="px-3 py-2 font-semibold">Symbol</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="px-3 py-2 text-right font-semibold">Volume</th>
            <th className="px-3 py-2 text-right font-semibold">Entry</th>
            <th className="px-3 py-2 text-right font-semibold">Current</th>
            <th className="px-3 py-2 text-right font-semibold">S/L</th>
            <th className="px-3 py-2 text-right font-semibold">T/P</th>
            <th className="px-3 py-2 text-right font-semibold">Age</th>
            <th className="px-3 py-2 text-right font-semibold">Profit</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr
              key={position.id}
              className="border-t border-[var(--color-line)] transition-colors hover:bg-[var(--color-surface-2)]/60"
            >
              <td className="tabular px-3 py-2 text-xs text-[var(--color-ink-dim)]">#{position.ticket}</td>
              {showAccount && (
                <td className="px-3 py-2 text-xs text-[var(--color-ink-dim)]">{accountName(position.accountId)}</td>
              )}
              <td className="px-3 py-2 font-medium text-gold">{position.symbol}</td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className={position.side === 'buy' ? 'font-semibold text-profit' : 'font-semibold text-loss'}>
                    {position.side.toUpperCase()}
                  </span>
                  <Chip tone={ORIGIN_TONE[position.origin]}>
                    {position.origin === 'recovery' ? `REC L${position.recoveryLayer + 1}` : position.origin}
                  </Chip>
                </div>
              </td>
              <td className="tabular px-3 py-2 text-right">{formatVolume(position.volume)}</td>
              <td className="tabular px-3 py-2 text-right">{formatPrice(position.openPrice)}</td>
              <td className="tabular px-3 py-2 text-right">{formatPrice(position.currentPrice)}</td>
              <td className="tabular px-3 py-2 text-right text-[var(--color-ink-muted)]">
                {position.stopLoss ? formatPrice(position.stopLoss) : '—'}
              </td>
              <td className="tabular px-3 py-2 text-right text-[var(--color-ink-muted)]">
                {position.takeProfit ? formatPrice(position.takeProfit) : '—'}
              </td>
              <td className="tabular px-3 py-2 text-right text-xs text-[var(--color-ink-muted)]">
                {timeAgo(position.openTime)}
              </td>
              <td className="px-3 py-2 text-right font-semibold">
                <Money value={position.profit} />
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  className="btn btn-ghost px-2 py-1 text-xs"
                  disabled={closing === position.id}
                  onClick={() => void handleClose(position.id)}
                >
                  {closing === position.id ? '…' : 'Close'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile */}
      <ul className="space-y-2 p-3 md:hidden">
        {positions.map((position) => (
          <li key={position.id} className="card-flush p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={position.side === 'buy' ? 'font-semibold text-profit' : 'font-semibold text-loss'}>
                    {position.side.toUpperCase()}
                  </span>
                  <span className="font-medium text-gold">{position.symbol}</span>
                  <span className="tabular text-xs text-[var(--color-ink-muted)]">
                    {formatVolume(position.volume)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Chip tone={ORIGIN_TONE[position.origin]}>
                    {position.origin === 'recovery' ? `REC L${position.recoveryLayer + 1}` : position.origin}
                  </Chip>
                  {showAccount && <Chip>{accountName(position.accountId)}</Chip>}
                  <span className="tabular text-[0.6875rem] text-[var(--color-ink-muted)]">
                    #{position.ticket} · {timeAgo(position.openTime)}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-base font-semibold">
                  <Money value={position.profit} />
                </div>
                <button
                  className="btn btn-ghost mt-1.5 px-2 py-1 text-xs"
                  disabled={closing === position.id}
                  onClick={() => void handleClose(position.id)}
                >
                  {closing === position.id ? '…' : 'Close'}
                </button>
              </div>
            </div>
            <dl className="tabular mt-2.5 grid grid-cols-4 gap-2 border-t border-[var(--color-line)] pt-2 text-xs">
              <div>
                <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Entry</dt>
                <dd>{formatPrice(position.openPrice)}</dd>
              </div>
              <div>
                <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Now</dt>
                <dd>{formatPrice(position.currentPrice)}</dd>
              </div>
              <div>
                <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">S/L</dt>
                <dd>{position.stopLoss ? formatPrice(position.stopLoss) : '—'}</dd>
              </div>
              <div>
                <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">T/P</dt>
                <dd>{position.takeProfit ? formatPrice(position.takeProfit) : '—'}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
