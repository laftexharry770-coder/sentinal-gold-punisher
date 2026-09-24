import { useEffect, useState } from 'react';
import { formatMoney, type AccountState, type CopySettings, type DispatchReport } from '@sentinal/shared';
import { api, type MetaApiAccountSummary, type NewAccountPayload } from '../api';
import type { SessionState } from '../backend/session';
import { toast } from '../components/Toast';
import { Card, Chip, EmptyState, NumberField, Segmented, TextField, Toggle } from '../components/ui';
import { useTerminal } from '../store';

const PROVIDER_LABEL: Record<AccountState['provider'], string> = {
  sim: 'Simulated',
  metaapi: 'MetaApi',
};

/** Copy routing editor shown on every follower account. */
function CopyRouting({ account, masters }: { account: AccountState; masters: AccountState[] }) {
  const [draft, setDraft] = useState<CopySettings>(account.copy);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof CopySettings>(key: K, value: CopySettings[K]) => {
    setSaved(false);
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAccount(account.id, { copy: draft });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 border-t border-[var(--color-line)] pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Copy from</label>
          <select
            className="field"
            value={draft.masterId ?? ''}
            onChange={(e) => set('masterId', e.target.value || null)}
          >
            <option value="">— none —</option>
            {masters.map((master) => (
              <option key={master.id} value={master.id}>
                {master.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Lot sizing</label>
          <select
            className="field"
            value={draft.sizing}
            onChange={(e) => set('sizing', e.target.value as CopySettings['sizing'])}
          >
            <option value="multiplier">Multiplier of master lot</option>
            <option value="fixed">Fixed lot per leg</option>
            <option value="balance-ratio">Balance ratio</option>
          </select>
        </div>
        {draft.sizing === 'multiplier' && (
          <NumberField label="Multiplier" value={draft.multiplier} onChange={(v) => set('multiplier', v)} step={0.1} min={0.01} suffix="×" />
        )}
        {draft.sizing === 'fixed' && (
          <NumberField label="Fixed lot" value={draft.fixedLot} onChange={(v) => set('fixedLot', v)} step={0.01} min={0.01} suffix="lot" />
        )}
        <NumberField label="Max lot" value={draft.maxLot} onChange={(v) => set('maxLot', v)} step={0.01} min={0.01} suffix="lot" />
        <NumberField
          label="Max slippage"
          value={draft.maxSlippage}
          onChange={(v) => set('maxSlippage', v)}
          step={0.05}
          min={0}
          suffix="$"
          hint="Mirrored legs filled beyond this deviation are cancelled."
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle label="Copy enabled" checked={draft.enabled} onChange={(v) => set('enabled', v)} />
        <Toggle label="Reverse direction" hint="Mirror the master inverted." checked={draft.reverse} onChange={(v) => set('reverse', v)} />
        <Toggle label="Copy stop loss" checked={draft.copyStopLoss} onChange={(v) => set('copyStopLoss', v)} />
        <Toggle label="Copy take profit" checked={draft.copyTakeProfit} onChange={(v) => set('copyTakeProfit', v)} />
        <Toggle label="Copy closes" checked={draft.copyCloses} onChange={(v) => set('copyCloses', v)} />
      </div>

      <div className="flex items-center justify-end gap-2">
        {saved && <Chip tone="profit">routing saved</Chip>}
        <button className="btn btn-primary px-3 py-1.5 text-xs" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save routing'}
        </button>
      </div>
    </div>
  );
}

function AccountCard({ account, masters }: { account: AccountState; masters: AccountState[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const unlink = async () => {
    const note = account.provider === 'metaapi' ? ' Its positions stay open at the broker; Sentinal stops copying to it.' : '';
    if (!window.confirm(`Unlink ${account.name}?${note}`)) return;
    setBusy(true);
    try {
      await api.removeAccount(account.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'not unlinked', 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (role: AccountState['role']) => {
    await api.updateAccount(account.id, { role });
  };

  const everyTick = async () => {
    if (!window.confirm(`Switch ${account.name} to tick-by-tick quotes? MetaApi restarts its server for the account, which drops the connection for about a minute. Positions are not affected.`)) return;
    setBusy(true);
    try {
      await api.streamEveryTick(account.id);
      toast(`${account.name} now streams every tick`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'MetaApi refused the change', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-ink">{account.name}</h3>
            <Chip tone={account.connected ? 'profit' : 'loss'}>{account.connected ? 'connected' : 'offline'}</Chip>
          </div>
          <p className="tabular mt-0.5 truncate text-xs text-[var(--color-ink-muted)]">
            {PROVIDER_LABEL[account.provider]} · {account.platform.toUpperCase()} · {account.login} · {account.server} · {account.symbol}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {account.accountType !== 'sim' && <Chip tone={account.accountType === 'real' ? 'loss' : 'neutral'}>{account.accountType}</Chip>}
            <Chip tone="neutral">
              {account.avgLatencyMs === null ? 'no orders yet' : `ack ${account.lastLatencyMs} ms · avg ${account.avgLatencyMs} ms`}
            </Chip>
            {account.quoteIntervalSec !== null && (
              <Chip tone={account.quoteIntervalSec === 0 ? 'profit' : 'warn'}>
                {account.quoteIntervalSec === 0 ? 'every tick' : `quotes each ${account.quoteIntervalSec}s`}
              </Chip>
            )}
          </div>
        </div>
        <div className="w-full shrink-0 sm:w-60">
          <Segmented
            value={account.role}
            onChange={(role) => void changeRole(role)}
            options={[
              { value: 'master', label: 'Master' },
              { value: 'slave', label: 'Follower' },
              { value: 'standalone', label: 'Solo' },
            ]}
          />
        </div>
      </div>

      <dl className="tabular mt-3 grid grid-cols-2 gap-3 border-t border-[var(--color-line)] pt-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Balance</dt>
          <dd className="font-medium">{formatMoney(account.balance)}</dd>
        </div>
        <div>
          <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Equity</dt>
          <dd className="font-medium">{formatMoney(account.equity)}</dd>
        </div>
        <div>
          <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Free margin</dt>
          <dd className="font-medium">{formatMoney(account.freeMargin)}</dd>
        </div>
        <div>
          <dt className="text-[0.625rem] uppercase text-[var(--color-ink-muted)]">Open legs</dt>
          <dd className="font-medium">{account.openPositions}</dd>
        </div>
      </dl>

      {account.connectionError && (
        <p className="mt-2 rounded-lg border border-loss/40 bg-loss/10 px-2.5 py-1.5 text-[0.6875rem] text-loss">
          {account.connectionError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost px-3 py-1.5 text-xs" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide routing' : 'Copy routing'}
          </button>
          {account.provider === 'metaapi' && account.quoteIntervalSec !== null && account.quoteIntervalSec > 0 && (
            <button className="btn btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => void everyTick()}>
              Stream every tick
            </button>
          )}
        </div>
        <button className="btn btn-ghost px-3 py-1.5 text-xs text-loss" disabled={busy} onClick={() => void unlink()}>
          {busy ? 'Unlinking…' : 'Unlink'}
        </button>
      </div>

      {open && <CopyRouting account={account} masters={masters.filter((m) => m.id !== account.id)} />}
    </div>
  );
}

/** Followers from the MetaApi token the session signed in with. */
function MetaApiFollowers() {
  const { accounts } = useTerminal();
  const [list, setList] = useState<MetaApiAccountSummary[] | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      // An empty token means "the session's own".
      .listMetaApiAccounts('')
      .then((l) => !cancelled && setList(l))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'MetaApi did not answer'));
    return () => {
      cancelled = true;
    };
  }, [accounts.length]);

  const linked = new Set(accounts.map((a) => a.metaApiId).filter(Boolean));
  const available = (list ?? []).filter((a) => !linked.has(a.id));

  const add = async (account: MetaApiAccountSummary) => {
    setBusy(account.id);
    setError(null);
    try {
      await api.addMetaApiFollower(account.id, { sizing: 'multiplier', multiplier });
      toast(`${account.name} is copying the master`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'not linked');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Add a follower" subtitle="Another MetaTrader account on your MetaApi token" bodyClass="p-4 space-y-3">
      <NumberField label="Lot multiplier" value={multiplier} onChange={setMultiplier} step={0.1} min={0.01} suffix="×" hint="A copy trades the master's lot times this; change it later under Copy routing." />
      {list === null && !error && <p className="text-xs text-[var(--color-ink-muted)]">Reading your MetaApi accounts…</p>}
      {list !== null && available.length === 0 && (
        <p className="text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Every account on this token is linked. Add more MetaTrader logins to MetaApi from the sign-in screen or at app.metaapi.cloud.
        </p>
      )}
      <ul className="space-y-2">
        {available.map((account) => (
          <li key={account.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[#0e1116] px-3.5 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{account.name}</p>
              <p className="tabular truncate text-[0.6875rem] text-[var(--color-ink-muted)]">
                {account.platform.toUpperCase()} · {account.login} · {account.server}
              </p>
            </div>
            <button className="btn btn-primary shrink-0 px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void add(account)}>
              {busy === account.id ? 'Linking…' : 'Copy master'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-loss">{error}</p>}
    </Card>
  );
}

function DispatchLog({ reports, accounts }: { reports: DispatchReport[]; accounts: AccountState[] }) {
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  return (
    <Card title="Copy latency" subtitle="Each order, and how fast every account's broker answered" bodyClass="max-h-96 overflow-auto p-0">
      {reports.length === 0 ? (
        <EmptyState title="No orders dispatched yet" hint="When the bot or an EA trades, each order and its copies are timed here." />
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {reports.map((r) => (
            <li key={r.id} className="px-4 py-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">
                  {r.action.toUpperCase()} {r.side ? r.side.toUpperCase() : ''} {r.symbol}
                </span>
                <span className="tabular text-[var(--color-ink-muted)]">
                  sent to all in {r.sendSpreadMs < 1 ? `${Math.round(r.sendSpreadMs * 1000)} µs` : `${r.sendSpreadMs.toFixed(1)} ms`} ·{' '}
                  {new Date(r.time).toLocaleTimeString()}
                </span>
              </div>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {r.legs.map((leg, i) => (
                  <li key={`${leg.accountId}-${i}`}>
                    <Chip tone={leg.ok ? (leg.role === 'master' ? 'gold' : 'profit') : 'loss'}>
                      {name(leg.accountId)} {leg.ok ? `${leg.ackMs ?? '—'} ms` : leg.error ?? 'rejected'}
                    </Chip>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ConnectBroker({ session }: { session: SessionState }) {
  const { accounts, dispatches } = useTerminal();
  const masters = accounts.filter((a) => a.role === 'master');
  const live = session.status === 'live';

  const [form, setForm] = useState<NewAccountPayload>({
    name: '',
    login: '',
    server: '',
    provider: 'sim',
    broker: 'Sentinal Markets',
    role: accounts.length === 0 ? 'master' : 'slave',
    leverage: 500,
    initialBalance: 10_000,
  });
  const [copyMasterId, setCopyMasterId] = useState('');
  const [multiplier, setMultiplier] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const payload: NewAccountPayload = {
        ...form,
        copy:
          form.role === 'slave'
            ? {
                enabled: true,
                masterId: copyMasterId || masters[0]?.id || null,
                sizing: 'multiplier',
                multiplier,
              }
            : undefined,
      };
      const account = await api.addAccount(payload);
      setOk(`${account.name} linked`);
      setForm((prev) => ({ ...prev, name: '', login: '', server: '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'link failed');
    } finally {
      setBusy(false);
    }
  };

  const valid = form.name.trim() && form.login.trim() && form.server.trim();

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-3">
        <Card
          title="Linked accounts"
          subtitle={`${accounts.length} account(s) · ${masters.length} master(s)`}
          bodyClass="p-3 space-y-3"
        >
          {accounts.length === 0 ? (
            <EmptyState
              title="No broker linked yet"
              hint="Link a master account to run the engine, then attach followers to mirror every leg it opens."
            />
          ) : (
            accounts.map((account) => <AccountCard key={account.id} account={account} masters={masters} />)
          )}
        </Card>

        <DispatchLog reports={dispatches} accounts={accounts} />

        <Card title="How copying works" bodyClass="p-4 text-xs leading-relaxed text-[var(--color-ink-dim)] space-y-2">
          <p>
            The strategy trades the <span className="font-semibold text-ink">master</span>. Each order it sends goes to the master and to
            every follower in the same instant — followers never wait to hear that the master filled. Each copy uses the follower's
            own gold symbol and sizing rule, and money stops become the same price level on every account.
          </p>
          <p>
            Trades that start in MetaTrader itself — an .ex5 EA or a manual trade on the master — are copied the moment MetaApi reports
            them. Closes, partial closes and stop changes follow the same path, and copies are re-matched to their master after a reload.
          </p>
          <p className="text-[var(--color-ink-muted)]">
            No copier can make latency zero: each broker still takes its own round trip to fill. The copy latency card shows exactly
            what that costs, order by order.
          </p>
        </Card>
      </div>

      {live ? (
        <MetaApiFollowers />
      ) : (
      <Card title="Add a follower" subtitle="Simulated mirror account" bodyClass="p-4 space-y-3">
        <TextField
          label="Display name"
          value={form.name}
          onChange={(name) => setForm((prev) => ({ ...prev, name }))}
          placeholder="Follower B"
        />
        <TextField
          label="Login"
          value={form.login}
          onChange={(login) => setForm((prev) => ({ ...prev, login }))}
          placeholder="51204418"
        />
        <TextField
          label="Server"
          value={form.server}
          onChange={(server) => setForm((prev) => ({ ...prev, server }))}
          placeholder="Demo-Server"
        />

        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Leverage"
            value={form.leverage ?? 500}
            onChange={(leverage) => setForm((prev) => ({ ...prev, leverage: Math.round(leverage) }))}
            step={100}
            min={1}
            suffix=":1"
          />
          <NumberField
            label="Start balance"
            value={form.initialBalance ?? 10000}
            onChange={(initialBalance) => setForm((prev) => ({ ...prev, initialBalance }))}
            step={500}
            min={0}
            suffix="$"
          />
        </div>

        <Segmented
          label="Role"
          value={form.role}
          onChange={(role) => setForm((prev) => ({ ...prev, role }))}
          options={[
            { value: 'master', label: 'Master' },
            { value: 'slave', label: 'Follower' },
            { value: 'standalone', label: 'Solo' },
          ]}
        />

        {form.role === 'slave' && (
          <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[#0e1116] p-3">
            <div>
              <label className="label">Follow master</label>
              <select className="field" value={copyMasterId} onChange={(e) => setCopyMasterId(e.target.value)}>
                <option value="">
                  {masters.length > 0 ? `${masters[0]?.name} (default master)` : 'no master available'}
                </option>
                {masters.map((master) => (
                  <option key={master.id} value={master.id}>
                    {master.name}
                  </option>
                ))}
              </select>
            </div>
            <NumberField label="Lot multiplier" value={multiplier} onChange={setMultiplier} step={0.1} min={0.01} suffix="×" />
          </div>
        )}

        {error && <p className="text-xs text-loss">{error}</p>}
        {ok && <p className="text-xs text-profit">{ok}</p>}

        <button className="btn btn-primary w-full py-2.5" disabled={!valid || busy} onClick={() => void submit()}>
          {busy ? 'Linking…' : 'Link account'}
        </button>
      </Card>
      )}
    </div>
  );
}
