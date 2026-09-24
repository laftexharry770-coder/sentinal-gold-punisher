import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MetaApiAccountSummary, type ProvisionInput } from '../api';
import type { SessionState } from '../backend/session';
import { Logo } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';
import { NumberField, Segmented, TextField, Toggle } from '../components/ui';

const STATE_LABEL: Record<string, { text: string; tone: string }> = {
  DEPLOYED: { text: 'running', tone: 'text-profit' },
  DEPLOYING: { text: 'starting', tone: 'text-warn' },
  UNDEPLOYED: { text: 'stopped — starts on connect', tone: 'text-[var(--color-ink-muted)]' },
  CREATED: { text: 'new — starts on connect', tone: 'text-[var(--color-ink-muted)]' },
  DRAFT: { text: 'needs a password in MetaApi', tone: 'text-loss' },
};

/** A quiet price line for the brand panel — drawn once, not data. */
function PriceSketch() {
  const points: [number, number][] = [];
  let y = 150;
  for (let i = 0; i <= 48; i++) {
    const x = i * 12.5;
    y += Math.sin(i * 0.55) * 7 + Math.cos(i * 1.7) * 5 - 1.6;
    points.push([x, Math.max(28, Math.min(190, y))]);
  }
  const line = points.map(([x, py], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const area = `${line} L600 220 L0 220 Z`;
  return (
    <svg viewBox="0 0 600 220" preserveAspectRatio="none" className="h-40 w-full" aria-hidden="true">
      <defs>
        <linearGradient id="sketch-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--color-ice)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--color-ice)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[55, 110, 165].map((gy) => (
        <line key={gy} x1="0" x2="600" y1={gy} y2={gy} stroke="var(--color-line)" strokeDasharray="3 6" />
      ))}
      <path d={area} fill="url(#sketch-fill)" />
      <path d={line} fill="none" stroke="var(--color-ice)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const FACTS: { title: string; body: string }[] = [
  { title: "Your broker's prices", body: 'Quotes, history, balances and positions come from your accounts through MetaApi.' },
  { title: 'Orders only when you arm them', body: 'Fills are simulated against real quotes until you switch real orders on.' },
  { title: 'Keys stay on this device', body: 'Your MetaApi token is kept in this browser and sent only to MetaApi.' },
];

function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-[var(--color-line)] bg-[var(--color-surface)] px-12 py-10 lg:flex xl:px-16">
      <Logo />
      <div className="max-w-lg">
        <p className="eyebrow">XAUUSD · MetaTrader 4 and 5</p>
        <h1 className="mt-3 text-[2.125rem] font-semibold leading-[1.15] tracking-[-0.025em] text-ink">
          Automated gold trading on your own MetaTrader accounts.
        </h1>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--color-ink-dim)]">
          Burst, a model that learns the market as it trades, and as many of your own expert advisors as you like — on a master
          account, copied to every follower.
        </p>
        <ul className="mt-8 space-y-4">
          {FACTS.map((f) => (
            <li key={f.title} className="flex gap-3">
              <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-ice)]/15 text-[var(--color-ice)]">
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true">
                  <path d="m2.5 6.2 2.2 2.2 4.8-4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span>
                <span className="block text-sm font-semibold text-ink">{f.title}</span>
                <span className="block text-[0.8125rem] leading-relaxed text-[var(--color-ink-muted)]">{f.body}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="-mx-12 -mb-10 xl:-mx-16">
        <PriceSketch />
      </div>
    </aside>
  );
}

/** Adds a MetaTrader login to the MetaApi account behind the token. */
function AddAccount({ token, onAdded }: { token: string; onAdded: (account: MetaApiAccountSummary) => void }) {
  const [form, setForm] = useState<ProvisionInput>({ name: '', login: '', password: '', server: '', platform: 'mt5' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ProvisionInput>(key: K, value: ProvisionInput[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await api.provisionMetaApiAccount(token, { ...form, login: form.login.trim(), server: form.server.trim(), name: form.name.trim() });
      // The password has done its job; nothing keeps it here.
      setForm({ name: '', login: '', password: '', server: '', platform: form.platform });
      onAdded(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MetaApi did not add the account.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-well)] p-3.5">
      <p className="text-xs leading-relaxed text-[var(--color-ink-dim)]">
        The login, password and server exactly as MetaTrader shows them. MetaApi checks them with your broker, then keeps them
        on its servers — this browser keeps nothing.
      </p>
      <Segmented
        label="Platform"
        value={form.platform}
        onChange={(platform) => set('platform', platform)}
        options={[
          { value: 'mt5', label: 'MetaTrader 5' },
          { value: 'mt4', label: 'MetaTrader 4' },
        ]}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Login" value={form.login} onChange={(v) => set('login', v)} inputMode="numeric" placeholder="411285151" />
        <TextField label="Name (optional)" value={form.name} onChange={(v) => set('name', v)} placeholder="Exness main" />
      </div>
      <TextField label="Server" value={form.server} onChange={(v) => set('server', v)} placeholder="Exness-MT5Real9" hint="As in MetaTrader's login window, e.g. Exness-MT5Real9 or ICMarketsSC-MT5-2." />
      <TextField label="Password" secret value={form.password} onChange={(v) => set('password', v)} placeholder="••••••••" hint="The trading password. An investor password connects read-only: prices and positions, but no orders." />
      {error && <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">{error}</p>}
      <button
        className="btn btn-primary w-full py-2"
        disabled={busy || !form.login.trim() || !form.server.trim() || !form.password}
        onClick={() => void submit()}
      >
        {busy ? 'MetaApi is checking with the broker…' : 'Add to MetaApi'}
      </button>
    </div>
  );
}

/**
 * The terminal's gate. Until a MetaApi session exists the app shows no
 * prices, no chart and no accounts — only this screen.
 */
export function SignIn({ session }: { session: SessionState }) {
  const saved = api.savedCredentials();
  const [token, setToken] = useState(saved?.token ?? '');
  const [accounts, setAccounts] = useState<MetaApiAccountSummary[] | null>(null);
  const [masterId, setMasterId] = useState(saved?.masterId ?? '');
  const [followerIds, setFollowerIds] = useState<string[]>(saved?.followerIds ?? []);
  const [symbol, setSymbol] = useState(saved?.symbol ?? '');
  const [multiplier, setMultiplier] = useState(1);
  const [remember, setRemember] = useState(Boolean(saved));
  // Real orders are never on unless the operator turns them on, every session.
  const [liveExecution, setLiveExecution] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<'load' | 'connect' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  const connecting = session.status === 'connecting' || busy === 'connect';
  const sessionError = session.status === 'locked' ? session.error : null;
  const shown = error ?? sessionError;

  const loadAccounts = useCallback(
    async (value = token) => {
      if (!value.trim()) return;
      setBusy('load');
      setError(null);
      try {
        const list = await api.listMetaApiAccounts(value);
        setAccounts(list);
        setMasterId((prev) => (list.some((a) => a.id === prev) ? prev : list[0]?.id ?? ''));
        setFollowerIds((prev) => prev.filter((id) => list.some((a) => a.id === id)));
        if (list.length === 0) setAdding(true);
      } catch (err) {
        setAccounts(null);
        setError(err instanceof Error ? err.message : 'MetaApi did not answer.');
      } finally {
        setBusy(null);
      }
    },
    [token],
  );

  // A remembered token lists its accounts straight away.
  useEffect(() => {
    if (saved?.token) void loadAccounts(saved.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFollower = (id: string) =>
    setFollowerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const master = accounts?.find((a) => a.id === masterId);
  const followers = followerIds.filter((id) => id !== masterId);

  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      await api.connectBroker({ token, masterId, followerIds: followers, symbol: symbol.trim(), remember, liveExecution, followerMultiplier: multiplier });
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
    <div className="grid min-h-[100dvh] lg:grid-cols-2">
      <BrandPanel />
      <div className="app-scroll relative flex max-h-[100dvh] flex-col">
        <div className="flex items-center justify-between px-5 pt-5 lg:justify-end lg:px-10">
          <div className="lg:hidden">
            <Logo />
          </div>
          <ThemeToggle />
        </div>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-5 pb-10 pt-8 lg:px-0">
          <div className="mb-1">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Connect your accounts</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-ink-muted)]">Sign in with a MetaApi token, then choose a master and its followers.</p>
          </div>

          <section className="card p-5 sm:p-6">
            <h3 className="text-sm font-semibold text-ink">MetaApi</h3>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--color-ink-muted)]">
              Sentinal trades your MetaTrader accounts through MetaApi's cloud terminals. Paste the API access token from{' '}
              <a className="text-ink underline decoration-[var(--color-ice)]/60 underline-offset-2" href="https://app.metaapi.cloud/token" target="_blank" rel="noreferrer">
                app.metaapi.cloud
              </a>
              , then pick the master account and the accounts that copy it.
            </p>

            <div className="mt-4 space-y-3">
              <TextField
                label="MetaApi token"
                secret
                showCount
                inputRef={tokenRef}
                value={token}
                onChange={(value) => {
                  setToken(value);
                  setAccounts(null);
                }}
                placeholder="eyJhbGciOiJSUzUxMiIs…"
                hint="Stays in this browser and is sent only to MetaApi."
              />
              <button className="btn w-full py-2" disabled={!token.trim() || busy !== null || connecting} onClick={() => void loadAccounts()}>
                {busy === 'load' ? 'Reading your accounts…' : accounts ? 'Reload accounts' : 'Show my MetaTrader accounts'}
              </button>
            </div>

            {accounts && (
              <div className="mt-4 space-y-3">
                {accounts.length > 0 && (
                  <div>
                    <p className="label">Master and followers</p>
                    <ul className="space-y-2">
                      {accounts.map((account) => {
                        const isMaster = account.id === masterId;
                        const isFollower = !isMaster && followerIds.includes(account.id);
                        const state = STATE_LABEL[account.state] ?? { text: account.state.toLowerCase(), tone: 'text-[var(--color-ink-muted)]' };
                        return (
                          <li
                            key={account.id}
                            className={`rounded-xl border px-3.5 py-3 transition-colors ${
                              isMaster ? 'border-[var(--color-ice)]/60 bg-[var(--color-ice)]/[0.06]' : isFollower ? 'border-profit/40 bg-profit/[0.05]' : 'border-[var(--color-line)] bg-[var(--color-well)]'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-ink">{account.name}</p>
                                <p className="tabular truncate text-[0.6875rem] text-[var(--color-ink-muted)]">
                                  {account.platform.toUpperCase()} · {account.login} · {account.server}
                                  {account.region ? ` · ${account.region}` : ''}
                                </p>
                                <p className={`mt-0.5 text-[0.6875rem] ${state.tone}`}>{state.text}</p>
                              </div>
                              <div className="flex shrink-0 flex-col gap-1.5">
                                <button
                                  className={`btn px-2.5 py-1 text-[0.6875rem] ${isMaster ? 'btn-primary' : 'btn-ghost'}`}
                                  onClick={() => {
                                    setMasterId(account.id);
                                    setFollowerIds((prev) => prev.filter((id) => id !== account.id));
                                  }}
                                >
                                  {isMaster ? 'Master' : 'Make master'}
                                </button>
                                {!isMaster && (
                                  <button className={`btn px-2.5 py-1 text-[0.6875rem] ${isFollower ? 'btn-buy' : 'btn-ghost'}`} onClick={() => toggleFollower(account.id)}>
                                    {isFollower ? 'Follower ✓' : 'Follow'}
                                  </button>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                <button className="btn btn-ghost w-full py-1.5 text-xs" onClick={() => setAdding((v) => !v)}>
                  {adding ? 'Hide' : '+ Add a MetaTrader account to MetaApi'}
                </button>
                {adding && (
                  <AddAccount
                    token={token}
                    onAdded={(account) => {
                      setAccounts((prev) => [...(prev ?? []), account]);
                      if (!masterId) setMasterId(account.id);
                      setAdding(false);
                    }}
                  />
                )}

                {master && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <TextField label="Gold symbol" value={symbol} onChange={setSymbol} placeholder="auto-detect" hint="Blank finds the broker's gold (XAUUSD, XAUUSDm, GOLD…)." />
                      <NumberField label="Follower lot ×" value={multiplier} onChange={setMultiplier} step={0.1} min={0.01} hint="Copies trade the master's lot times this." />
                    </div>
                    <Toggle label="Stay signed in on this device" hint="Keeps the token and your choices in this browser." checked={remember} onChange={setRemember} />
                    <Toggle
                      label="Send real orders to MetaTrader"
                      hint="Off: fills are simulated against your broker's real quotes. On: the bot trades the master and every follower."
                      checked={liveExecution}
                      onChange={setLiveExecution}
                    />
                    {liveExecution && (
                      <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
                        Live trading is armed. Once you start the bot it sends orders to {master.login} on {master.server}
                        {followers.length > 0 ? ` and ${followers.length} follower account(s)` : ''}. Check the caps on Settings before
                        starting it.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {connecting && session.status === 'connecting' && (
              <p className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-well)] px-3 py-2 text-xs text-[var(--color-ink-dim)]">
                <span className="h-2 w-2 rounded-full bg-warn live-dot" /> {session.step}
              </p>
            )}

            {shown && <p className="mt-3 rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs leading-relaxed text-loss">{shown}</p>}

            {accounts && (
              <button className="btn btn-primary mt-4 w-full py-2.5" disabled={!master || connecting || busy !== null} onClick={() => void connect()}>
                {connecting ? 'Connecting…' : `Connect${followers.length ? ` master + ${followers.length} follower(s)` : ''}`}
              </button>
            )}
          </section>

          <section className="card-flush p-4">
            <h3 className="text-sm font-semibold text-ink">No MetaApi account to hand?</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-ink-dim)]">
              Demo mode runs the same engine — strategy uploads included — against a simulated gold feed. Every figure in it is invented.
            </p>
            <button className="btn mt-3 w-full py-2" disabled={busy !== null || connecting} onClick={() => void demo()}>
              {busy === 'demo' ? 'Starting…' : 'Explore demo mode'}
            </button>
          </section>

          <section className="card-flush flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">Trading volatility digits instead?</h3>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">
                Matches, differs, even/odd and over/under live in Sentinal Deriv Bot.
              </p>
            </div>
            <a className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs" href="https://laftexharry770-coder.github.io/Sentinal-Deriv-Bot/" rel="noreferrer">
              Open
            </a>
          </section>

          <p className="px-1 text-center text-[0.6875rem] leading-relaxed text-[var(--color-ink-muted)]">
            Prices, history, balances and positions always come from your broker through MetaApi. Whether orders reach it is the switch
            above.
          </p>
        </div>
      </div>
    </div>
  );
}
