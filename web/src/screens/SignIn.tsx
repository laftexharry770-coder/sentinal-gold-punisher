import { useState } from 'react';
import { api } from '../api';
import { DEFAULT_APP_ID, DEFAULT_SYMBOL } from '../broker/derivClient';
import { TextField, Toggle } from '../components/ui';
import type { SessionState } from '../backend/session';

/** Deriv's usual multiplier ladder for gold; the account's own list wins on connect. */
const MULTIPLIERS = [20, 40, 60, 100, 150, 200];

/**
 * The terminal's gate. Until a Deriv session exists the app shows no prices,
 * no chart and no accounts — only this screen.
 */
export function SignIn({ session }: { session: SessionState }) {
  const saved = api.savedCredentials();
  const [token, setToken] = useState(saved?.token ?? '');
  const [appId, setAppId] = useState(saved?.appId ?? DEFAULT_APP_ID);
  const [symbol, setSymbol] = useState(saved?.symbol ?? DEFAULT_SYMBOL);
  const [multiplier, setMultiplier] = useState(saved?.multiplier ?? 100);
  const [remember, setRemember] = useState(Boolean(saved));
  // Live routing is never on unless the operator turns it on, every session.
  const [liveExecution, setLiveExecution] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connecting = session.status === 'connecting' || busy === 'connect';
  const sessionError = session.status === 'locked' ? session.error : null;
  const shown = error ?? sessionError;
  const ready = token.trim().length > 0;

  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      await api.connectBroker({ token, appId, symbol, multiplier, remember, liveExecution });
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
        <h2 className="text-sm font-semibold text-ink">Connect Deriv</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          The terminal stays empty until it can read your account. Create a token under{' '}
          <span className="text-ink">Settings → API token</span> on Deriv with the{' '}
          <span className="text-ink">Read</span> scope, plus <span className="text-ink">Trade</span> if you
          want the bot to place orders.
        </p>

        <div className="mt-4 space-y-3">
          <TextField
            label="Deriv API token"
            type="password"
            value={token}
            onChange={setToken}
            placeholder="a1b2c3d4e5f6g7h8"
            hint="Stays in this browser. Sent only to Deriv, never anywhere else."
          />
          <TextField
            label="Symbol"
            value={symbol}
            onChange={setSymbol}
            placeholder={DEFAULT_SYMBOL}
            hint="Deriv's name for spot gold. Leave as is unless your account lists it differently."
          />
          <div>
            <label className="label" htmlFor="deriv-multiplier">
              Multiplier
            </label>
            <select
              id="deriv-multiplier"
              className="field"
              value={multiplier}
              onChange={(event) => setMultiplier(Number(event.target.value))}
            >
              {MULTIPLIERS.map((option) => (
                <option key={option} value={option}>
                  {option}×
                </option>
              ))}
            </select>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--color-ink-muted)]">
              Deriv trades gold as multiplier contracts, so this is what a lot costs: a higher multiplier
              stakes less money for the same exposure. If your account does not offer this value the
              nearest one it does offer is used.
            </p>
          </div>
          <TextField
            label="App id"
            value={appId}
            onChange={setAppId}
            placeholder={DEFAULT_APP_ID}
            hint="Deriv's shared app id works. Register your own at api.deriv.com for higher rate limits."
          />
          <Toggle
            label="Stay signed in on this device"
            hint="Keeps the token in this browser's storage so the app reconnects itself."
            checked={remember}
            onChange={setRemember}
          />
          <Toggle
            label="Send orders to Deriv"
            hint="Off: fills are simulated against Deriv's real prices. On: the bot buys real contracts on this account."
            checked={liveExecution}
            onChange={setLiveExecution}
          />
        </div>

        {liveExecution && (
          <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            Live trading is armed. Once the bot is running it will buy and sell real {multiplier}×
            multiplier contracts on this Deriv account — up to its concurrent-position cap, each one
            staking real money. Try it on a Deriv demo account first, and check the caps on Trade
            Settings before arming the bot.
          </p>
        )}

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
          No Deriv account to hand?
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
        Prices, history, balance and open contracts always come from Deriv. Whether orders reach it is
        the switch above.
      </p>
    </div>
  );
}
