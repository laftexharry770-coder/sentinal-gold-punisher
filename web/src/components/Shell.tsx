import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoney, formatPrice } from '@sentinal/shared';
import { api } from '../api';
import type { SessionState } from '../backend/session';
import { startBotNow, stopBotNow } from './botActions';
import { onInstallAvailability, promptInstall } from '../pwa';
import { useTerminal } from '../store';
import { Logo } from './Logo';
import { ThemeSwitch, ThemeToggle } from './ThemeToggle';

export type ScreenId = 'control' | 'dashboard' | 'bot' | 'settings' | 'brokers';

type ScreenDef = { id: ScreenId; label: string; short: string; icon: ReactNode };

export const SCREENS: ScreenDef[] = [
  {
    id: 'control',
    label: 'MT5 control',
    short: 'Control',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" style={{ height: 18, width: 18 }}>
        <path d="M3.5 13.5a6.5 6.5 0 1 1 13 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="m10 13.5 3.2-4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="10" cy="13.5" r="1.3" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'dashboard',
    label: 'Chart & trades',
    short: 'Chart',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-4.5 w-4.5" style={{ height: 18, width: 18 }}>
        <path d="M3 16V8m4.5 8V4M12 16v-5m4.5 5V6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'bot',
    label: 'Bot control center',
    short: 'Bot',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" style={{ height: 18, width: 18 }}>
        <rect x="3.5" y="6.5" width="13" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 3.4v3.1M7.4 11h.01M12.6 11h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Trade settings',
    short: 'Settings',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" style={{ height: 18, width: 18 }}>
        <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2 4.8 4.8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: 'brokers',
    label: 'Accounts & copying',
    short: 'Accounts',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" style={{ height: 18, width: 18 }}>
        <path
          d="M8.4 11.6 6 14a2.8 2.8 0 1 1-4-4l2.4-2.4M11.6 8.4 14 6a2.8 2.8 0 1 1 4 4l-2.4 2.4M7.6 12.4l4.8-4.8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

/** Live XAUUSD quote with a flash on each print, as an MT5 market watch does. */
function QuoteStrip() {
  const { quote, previousQuote } = useTerminal();
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!quote || !previousQuote) return;
    const direction = quote.bid > previousQuote.bid ? 'up' : quote.bid < previousQuote.bid ? 'down' : null;
    if (!direction) return;
    setFlash(direction);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setFlash(null), 520);
    return () => window.clearTimeout(timerRef.current);
  }, [quote, previousQuote]);

  if (!quote) {
    return <div className="tabular text-sm text-[var(--color-ink-muted)]">Awaiting feed…</div>;
  }

  const spread = quote.ask - quote.bid;
  const tone = flash === 'up' ? 'text-profit' : flash === 'down' ? 'text-loss' : 'text-ink';

  return (
    <div className="flex items-center gap-2.5">
      <span className="rounded-lg bg-gold/12 px-2 py-1 text-[0.6875rem] font-semibold tracking-wide text-gold">{quote.symbol}</span>
      <div className="leading-tight">
        <span className={`tabular block text-[1.0625rem] font-semibold transition-colors ${tone}`}>{formatPrice(quote.bid)}</span>
        <span className="tabular block text-[0.6875rem] text-[var(--color-ink-muted)]">
          ask {formatPrice(quote.ask)} · spread {spread.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function InstallButton() {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => onInstallAvailability(setAvailable), []);
  if (!available) return null;

  return (
    <button
      className="btn btn-ghost hidden px-2.5 py-2 text-xs sm:inline-flex"
      disabled={busy}
      title="Install Sentinal MT5 as an app"
      onClick={() => {
        setBusy(true);
        void promptInstall().finally(() => setBusy(false));
      }}
    >
      <svg viewBox="0 0 20 20" fill="none" style={{ height: 15, width: 15 }} aria-hidden="true">
        <path d="M10 3.5v8.4m0 0 3-3m-3 3-3-3M4 14.5v1a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-1"
          stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Install
    </button>
  );
}

/** Names the data source, so simulated figures are never mistaken for live ones. */
function SessionBadge({ session }: { session: SessionState }) {
  const [busy, setBusy] = useState(false);
  if (session.status !== 'live' && session.status !== 'demo') return null;

  const demo = session.status === 'demo';
  const live = session.status === 'live' && session.execution === 'broker';
  const label = demo ? 'Demo data' : `${session.broker.broker} · ${session.broker.login}`;
  const tone = demo ? 'border-warn/30 bg-warn/10 text-warn' : 'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]';

  return (
    <div className="hidden items-center gap-2 xl:flex">
      <span className={`chip ${tone}`}>
        {!demo && <span className="h-1.5 w-1.5 rounded-full bg-profit" />}
        {label}
      </span>
      {session.status === 'live' && (
        <span
          className={`chip ${live ? 'border-loss/35 bg-loss/10 text-loss' : 'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]'}`}
          title={live ? 'Orders are sent to MetaTrader' : 'Orders fill locally against broker prices'}
        >
          {live ? 'Real orders' : 'Paper orders'}
        </span>
      )}
      <button
        className="btn btn-ghost px-2.5 py-1.5 text-xs"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api.signOut().finally(() => setBusy(false));
        }}
      >
        {demo ? 'Exit demo' : 'Sign out'}
      </button>
    </div>
  );
}

function BotSwitch() {
  const { strategy, stats, accounts } = useTerminal();
  const [busy, setBusy] = useState(false);
  const running = stats?.running ?? false;

  const toggle = async () => {
    setBusy(true);
    try {
      if (running) await stopBotNow(false);
      else await startBotNow();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={() => void toggle()}
      disabled={busy || accounts.length === 0}
      className={`btn ${running ? 'btn-stop' : 'btn-primary'} px-3.5 py-2`}
      title={accounts.length === 0 ? 'Link a broker account first' : undefined}
    >
      {running ? (
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true">
          <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M6.5 4.8v10.4a.8.8 0 0 0 1.2.7l8.3-5.2a.8.8 0 0 0 0-1.4L7.7 4.1a.8.8 0 0 0-1.2.7Z" fill="currentColor" />
        </svg>
      )}
      {running ? 'Stop bot' : 'Start bot'}
      {strategy && running && (
        <span className="hidden max-w-[9rem] truncate text-[0.6875rem] font-medium opacity-80 sm:inline">{strategy.name}</span>
      )}
    </button>
  );
}

export function Shell({
  screen,
  onNavigate,
  session,
  children,
}: {
  screen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  session: SessionState;
  children: ReactNode;
}) {
  const { connected, portfolio, stats, strategy } = useTerminal();
  const active = SCREENS.find((s) => s.id === screen);

  return (
    <div className="app-shell flex bg-transparent">
      {/* Sidebar — desktop */}
      <aside className="app-scroll hidden w-64 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-5 lg:flex">
        <div className="px-1.5">
          <Logo />
        </div>
        <p className="eyebrow mt-8 px-3">Workspace</p>
        <nav className="mt-2 flex flex-col gap-0.5">
          {SCREENS.map((item) => {
            const on = item.id === screen;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={on ? 'page' : undefined}
                className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[0.875rem] font-medium transition-colors ${
                  on ? 'bg-[var(--color-surface-2)] text-ink' : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)] hover:text-ink'
                }`}
              >
                {on && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-[var(--color-ice)]" />}
                <span className={on ? 'text-[var(--color-ice)]' : ''}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto space-y-3 pt-6">
          <div className="card-flush px-3.5 py-3">
            <p className="text-[0.75rem] text-[var(--color-ink-muted)]">Portfolio equity</p>
            <p className="tabular mt-1 text-xl font-semibold tracking-[-0.02em] text-ink">{portfolio ? formatMoney(portfolio.equity) : '—'}</p>
            <p className="tabular mt-0.5 text-[0.71875rem] text-[var(--color-ink-muted)]">
              {portfolio ? `${portfolio.openPositions} open · ${portfolio.accounts} account${portfolio.accounts === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 px-1 text-[0.71875rem] text-[var(--color-ink-muted)]">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-profit live-dot' : 'bg-loss'}`} />
            {connected ? (session.status === 'demo' ? 'Simulated feed' : 'MetaApi feed live') : 'Reconnecting…'}
          </div>
          {session.status === 'live' && (
            <p className="px-1 text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">
              {session.execution === 'broker'
                ? 'Orders go to MetaTrader through MetaApi. Positions shown are the ones on your accounts.'
                : "Prices and balance are your broker's. Orders fill locally against them — nothing reaches MetaTrader."}
            </p>
          )}
          <ThemeSwitch compact />
        </div>
      </aside>

      {/* Main column */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-base)]/80 px-4 py-3 backdrop-blur-md lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <div className="lg:hidden">
              <Logo />
            </div>
            <div className="hidden min-w-0 lg:block">
              <h1 className="truncate text-[1.0625rem] font-semibold text-ink">{active?.label}</h1>
              <p className="flex items-center gap-1.5 text-[0.75rem] text-[var(--color-ink-muted)]">
                <span className={`h-1.5 w-1.5 rounded-full ${stats?.running ? 'bg-profit live-dot' : 'bg-[var(--color-ink-faint)]'}`} />
                {stats?.running ? `Running ${strategy?.name ?? 'the bot'}` : 'Bot stopped'}
                {stats?.haltReason ? ` · ${stats.haltReason}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:block">
              <QuoteStrip />
            </div>
            <SessionBadge session={session} />
            <InstallButton />
            <ThemeToggle className="lg:hidden" />
            <BotSwitch />
          </div>
        </header>

        <div className="sm:hidden">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2">
            <QuoteStrip />
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-profit live-dot' : 'bg-loss'}`} />
          </div>
        </div>

        <main className="app-scroll min-h-0 flex-1 px-3 pb-28 pt-4 sm:px-5 lg:px-8 lg:pb-8 lg:pt-6">{children}</main>
      </div>

      {/* Bottom tabs — mobile */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-line)] bg-[var(--color-surface)]/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
        <div className="flex">
          {SCREENS.map((item) => {
            const on = item.id === screen;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={on ? 'page' : undefined}
                className={`relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[0.65625rem] font-semibold transition-colors ${
                  on ? 'text-[var(--color-ice)]' : 'text-[var(--color-ink-muted)]'
                }`}
              >
                {on && <span className="absolute top-0 h-[2px] w-8 rounded-full bg-[var(--color-ice)]" />}
                {item.icon}
                {item.short}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
