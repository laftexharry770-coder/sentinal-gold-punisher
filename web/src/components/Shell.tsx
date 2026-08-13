import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoney, formatPrice } from '@sentinal/shared';
import { api } from '../api';
import type { SessionState } from '../backend/session';
import { onInstallAvailability, promptInstall } from '../pwa';
import { useTerminal } from '../store';

export type ScreenId = 'dashboard' | 'bot' | 'settings' | 'brokers';

export const SCREENS: { id: ScreenId; label: string; short: string; icon: ReactNode }[] = [
  {
    id: 'dashboard',
    label: 'Trading Dashboard',
    short: 'Chart',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-4.5 w-4.5" style={{ height: 18, width: 18 }}>
        <path d="M3 16V8m4.5 8V4M12 16v-5m4.5 5V6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'bot',
    label: 'Bot Control Center',
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
    label: 'Trade Settings',
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
    label: 'Connect Broker',
    short: 'Brokers',
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

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brass-bright)] to-[var(--color-brass-deep)] shadow-[0_10px_24px_-12px_rgba(192,139,60,0.75)]">
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
          <path
            d="M12 2.8 4.8 5.6v6.1c0 4.3 2.9 8.3 7.2 9.5 4.3-1.2 7.2-5.2 7.2-9.5V5.6L12 2.8Z"
            stroke="white"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M9 12.2l2.2 2.3L15.4 10" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="leading-tight">
        <p className="text-sm font-extrabold tracking-tight text-ink">
          SENTINAL <span className="text-[var(--color-brass-bright)]">MT5</span>
        </p>
        <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-muted)]">
          Gold Punisher
        </p>
      </div>
    </div>
  );
}

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
    <div className="flex items-center gap-3">
      <div className="leading-tight">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-bold tracking-wide text-gold">XAUUSD</span>
          <span className={`tabular text-lg font-semibold transition-colors ${tone}`}>{formatPrice(quote.bid)}</span>
        </div>
        <div className="tabular text-[0.6875rem] text-[var(--color-ink-muted)]">
          ask {formatPrice(quote.ask)} · spread {spread.toFixed(2)}
        </div>
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
  const label = demo ? 'Demo data' : `${session.broker.broker} · live`;
  const tone = demo ? 'border-warn/40 bg-warn/10 text-warn' : 'border-profit/40 bg-profit/10 text-profit';

  return (
    <div className="hidden items-center gap-2 md:flex">
      <span className={`chip ${tone}`}>{label}</span>
      {session.status === 'live' && (
        <span
          className={`chip ${live ? 'border-loss/50 bg-loss/15 text-loss' : 'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]'}`}
          title={live ? 'Orders are sent to your broker' : 'Orders fill locally against broker prices'}
        >
          {live ? 'Live orders' : 'Paper orders'}
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
  const { config, stats, accounts } = useTerminal();
  const [busy, setBusy] = useState(false);
  const running = stats?.running ?? false;

  const toggle = async () => {
    setBusy(true);
    try {
      if (running) await api.stopBot(false);
      else await api.startBot();
    } catch {
      /* the log feed surfaces server-side rejections */
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={() => void toggle()}
      disabled={busy || accounts.length === 0}
      className={`btn ${running ? 'btn-sell' : 'btn-primary'} px-3 py-2`}
      title={accounts.length === 0 ? 'Link a broker account first' : undefined}
    >
      <span className={`h-2 w-2 rounded-full ${running ? 'bg-[#1a0409]' : 'bg-white/90 live-dot'}`} />
      {running ? 'Disarm' : 'Arm bot'}
      <span className="hidden text-[0.6875rem] font-medium opacity-80 sm:inline">
        {config.entriesPerSignal}×/signal
      </span>
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
  const { connected, portfolio, stats } = useTerminal();
  const active = SCREENS.find((s) => s.id === screen);

  return (
    <div className="app-shell flex bg-transparent">
      {/* Sidebar — desktop */}
      <aside className="app-scroll hidden w-60 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]/70 px-4 py-5 backdrop-blur lg:flex">
        <Logo />
        <nav className="mt-7 flex flex-col gap-1">
          {SCREENS.map((item) => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                item.id === screen
                  ? 'bg-[var(--color-brass)]/12 text-[var(--color-brass-bright)] shadow-[inset_0_0_0_1px_rgba(192,139,60,0.3)]'
                  : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)] hover:text-ink'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-auto space-y-2 pt-6">
          <div className="card-flush px-3 py-2.5">
            <p className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-muted)]">
              Portfolio equity
            </p>
            <p className="tabular mt-1 text-lg font-semibold text-ink">
              {portfolio ? formatMoney(portfolio.equity) : '—'}
            </p>
            <p className="tabular mt-0.5 text-[0.6875rem] text-[var(--color-ink-muted)]">
              {portfolio ? `${portfolio.openPositions} open · ${portfolio.accounts} account(s)` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 px-1 text-[0.6875rem] text-[var(--color-ink-muted)]">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-profit live-dot' : 'bg-loss'}`} />
            {connected ? (session.status === 'demo' ? 'Simulated feed' : 'Broker feed live') : 'Reconnecting…'}
          </div>
          {session.status === 'live' && (
            <p className="px-1 text-[0.625rem] leading-snug text-[var(--color-ink-muted)]">
              {session.execution === 'broker'
                ? "Orders are sent to your broker. Positions shown are the ones on your account."
                : "Prices and balance are your broker's. Orders fill locally against them — nothing reaches MetaTrader."}
            </p>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-base)]/85 px-4 py-2.5 backdrop-blur-md lg:px-6">
          {/* A hairline of brass under the masthead, the way a rule sits under one. */}
          <span aria-hidden className="brass-rule pointer-events-none absolute inset-x-0 bottom-[-1px] h-px" />
          <div className="flex min-w-0 items-center gap-4">
            <div className="lg:hidden">
              <Logo />
            </div>
            <div className="hidden min-w-0 lg:block">
              <h1 className="truncate text-sm font-semibold text-ink">{active?.label}</h1>
              <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">
                {stats?.running ? 'Engine armed — intrabar execution' : 'Engine idle'}
                {stats?.haltReason ? ` · ${stats.haltReason}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:block">
              <QuoteStrip />
            </div>
            <SessionBadge session={session} />
            <InstallButton />
            <BotSwitch />
          </div>
        </header>

        <div className="sm:hidden">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-surface)]/60 px-4 py-2">
            <QuoteStrip />
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-profit live-dot' : 'bg-loss'}`} />
          </div>
        </div>

        <main className="app-scroll min-h-0 flex-1 px-3 pb-28 pt-3 sm:px-4 lg:px-6 lg:pb-6">{children}</main>
      </div>

      {/* Bottom tabs — mobile */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-line)] bg-[var(--color-base)]/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
        <div className="flex">
          {SCREENS.map((item) => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[0.625rem] font-semibold transition-colors ${
                item.id === screen ? 'text-[var(--color-brass-bright)]' : 'text-[var(--color-ink-muted)]'
              }`}
            >
              {item.icon}
              {item.short}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
