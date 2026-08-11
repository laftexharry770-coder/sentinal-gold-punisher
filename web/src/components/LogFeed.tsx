import type { AccountState, LogEntry, LogLevel } from '@sentinal/shared';
import { EmptyState } from './ui';

const LEVEL_STYLE: Record<LogLevel, { dot: string; text: string; label: string }> = {
  info: { dot: 'bg-[var(--color-ink-muted)]', text: 'text-[var(--color-ink-dim)]', label: 'INFO' },
  success: { dot: 'bg-profit', text: 'text-profit', label: 'OK' },
  warn: { dot: 'bg-warn', text: 'text-warn', label: 'WARN' },
  error: { dot: 'bg-loss', text: 'text-loss', label: 'ERR' },
  trade: { dot: 'bg-[var(--color-cobalt-bright)]', text: 'text-[var(--color-cobalt-bright)]', label: 'EXEC' },
  copy: { dot: 'bg-gold', text: 'text-gold', label: 'COPY' },
};

function clock(time: number): string {
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

export function LogFeed({
  logs,
  accounts,
  limit = 120,
}: {
  logs: LogEntry[];
  accounts: AccountState[];
  limit?: number;
}) {
  if (logs.length === 0) {
    return <EmptyState title="Terminal idle" hint="Execution, copy-trade and recovery events stream in here." />;
  }

  return (
    <ul className="h-full space-y-0.5 overflow-auto p-2 text-xs">
      {logs.slice(0, limit).map((entry) => {
        const style = LEVEL_STYLE[entry.level];
        const account = entry.accountId ? accounts.find((a) => a.id === entry.accountId) : null;
        return (
          <li
            key={entry.id}
            className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-2)]/70"
          >
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
            <span className="tabular shrink-0 text-[var(--color-ink-muted)]">{clock(entry.time)}</span>
            <span className={`shrink-0 text-[0.625rem] font-bold tracking-wider ${style.text}`}>{style.label}</span>
            <span className="min-w-0 flex-1 leading-relaxed text-[var(--color-ink-dim)]">
              {account && <span className="mr-1 font-medium text-ink">[{account.name}]</span>}
              {entry.message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
