import { useState } from 'react';
import { api } from '../api';
import { METAAPI_REGIONS, type MetaApiRegion } from '../broker/metaapiClient';
import { TextField, Toggle } from '../components/ui';
import type { SessionState } from '../backend/session';

/**
 * The terminal's gate. Until a broker session exists the app shows no prices,
 * no chart and no accounts — only this screen.
 */
export function SignIn({ session }: { session: SessionState }) {
  const saved = api.savedCredentials();
  const [token, setToken] = useState(saved?.token ?? '');
  const [accountId, setAccountId] = useState(saved?.accountId ?? '');
  const [region, setRegion] = useState<MetaApiRegion>(saved?.region ?? 'new-york');
  const [symbol, setSymbol] = useState(saved?.symbol ?? 'XAUUSD');
  const [remember, setRemember] = useState(Boolean(saved));
  const [busy, setBusy] = useState<'connect' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connecting = session.status === 'connecting' || busy === 'connect';
  const sessionError = session.status === 'locked' ? session.error : null;
  const shown = error ?? sessionError;
  const ready = token.trim().length > 0 && accountId.trim().length > 0;

  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      await api.connectBroker({ token, accountId, region, symbol, remember });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect.');
    } finally {
      setBusy(null);
    }
  };

  const demo = async () => {
    setBusy('demo');
    try {
      await api.startDemo();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-5 px-5 py-10">
      <header className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-cobalt-bright)] to-[var(--color-cobalt-deep)] shadow-[0_10px_24px_-12px_rgba(59,130,246,0.95)]">
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
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
          <h1 className="text-lg font-extrabold tracking-tight text-ink">
            SENTINAL <span className="text-[var(--color-cobalt-bright)]">MT5</span>
          </h1>
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-muted)]">
            Gold Punisher
          </p>
        </div>
      </header>

      <section className="card p-5">
        <h2 className="text-sm font-semibold text-ink">Connect your broker</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          The terminal stays empty until it can read your account. Sign in with a MetaApi token and the
          id of the MT5 account you provisioned there — that is how a browser reaches MetaTrader.
        </p>

        <div className="mt-4 space-y-3">
          <TextField
            label="MetaApi token"
            type="password"
            value={token}
            onChange={setToken}
            placeholder="eyJhbGciOi…"
            hint="Stays in this browser. Sent only to MetaApi, never anywhere else."
          />
          <TextField
            label="MetaApi account id"
            value={accountId}
            onChange={setAccountId}
            placeholder="0f3c9d18-…"
          />
          <div>
            <label className="label">Region</label>
            <select
              className="field"
              value={region}
              onChange={(event) => setRegion(event.target.value as MetaApiRegion)}
            >
              {METAAPI_REGIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <TextField label="Symbol" value={symbol} onChange={setSymbol} placeholder="XAUUSD" />
          <Toggle
            label="Stay signed in on this device"
            hint="Keeps the token in this browser's storage so the app reconnects itself."
            checked={remember}
            onChange={setRemember}
          />
        </div>

        {shown && (
          <p className="mt-3 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs leading-relaxed text-loss">
            {shown}
          </p>
        )}

        <button
          className="btn btn-primary mt-4 w-full py-2.5"
          disabled={!ready || connecting || busy !== null}
          onClick={() => void connect()}
        >
          {connecting ? 'Connecting…' : 'Connect and open terminal'}
        </button>
      </section>

      <section className="card-flush p-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-muted)]">
          No broker to hand?
        </h3>
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-ink-dim)]">
          Demo mode runs the same engine against a simulated gold feed. Every figure in it is invented —
          it is for trying the controls, not for reading the market.
        </p>
        <button
          className="btn mt-3 w-full py-2"
          disabled={busy !== null || connecting}
          onClick={() => void demo()}
        >
          {busy === 'demo' ? 'Starting…' : 'Explore demo mode'}
        </button>
      </section>

      <p className="px-1 text-center text-[0.6875rem] leading-relaxed text-[var(--color-ink-muted)]">
        Live prices, balance and equity come from your broker. Order routing needs the server build —
        in this browser build, fills are simulated against the real prices.
      </p>
    </div>
  );
}
