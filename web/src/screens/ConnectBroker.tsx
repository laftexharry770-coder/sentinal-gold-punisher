import { useEffect, useState } from 'react';
import { formatMoney, type AccountState, type CopySettings } from '@sentinal/shared';
import { api, type NewAccountPayload } from '../api';
import type { DerivMt5Account } from '../broker/derivClient';
import { Card, Chip, EmptyState, NumberField, Segmented, TextField, Toggle } from '../components/ui';
import { useTerminal } from '../store';

const PROVIDER_LABEL: Record<AccountState['provider'], string> = {
  sim: 'Simulated',
  deriv: 'Deriv',
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
    setBusy(true);
    try {
      await api.removeAccount(account.id);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (role: AccountState['role']) => {
    await api.updateAccount(account.id, { role });
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
            {PROVIDER_LABEL[account.provider]} · {account.login} · {account.server}
          </p>
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

      <div className="mt-3 flex items-center justify-between gap-2">
        <button className="btn btn-ghost px-3 py-1.5 text-xs" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide routing' : 'Copy routing'}
        </button>
        <button className="btn btn-ghost px-3 py-1.5 text-xs text-loss" disabled={busy} onClick={() => void unlink()}>
          {busy ? 'Unlinking…' : 'Unlink'}
        </button>
      </div>

      {open && <CopyRouting account={account} masters={masters.filter((m) => m.id !== account.id)} />}
    </div>
  );
}

/**
 * The MetaTrader 5 accounts Deriv holds for this user.
 *
 * Shown because they are real money the operator has, and labelled as not
 * tradable from here because Deriv's API manages MT5 accounts but has no call
 * that places an order on one. Saying so on the screen is better than leaving
 * somebody to discover it by arming a bot that never fires.
 */
function Mt5Accounts() {
  const [accounts, setAccounts] = useState<DerivMt5Account[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .mt5Accounts()
      .then((list) => !cancelled && setAccounts(list))
      .catch(() => !cancelled && setAccounts([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (accounts !== null && accounts.length === 0) return null;

  return (
    <Card
      title="Your Deriv MT5 accounts"
      subtitle={accounts ? `${accounts.length} reported by Deriv` : 'Asking Deriv…'}
      bodyClass="p-3 space-y-2"
    >
      {accounts === null ? (
        <p className="px-1 py-2 text-xs text-[var(--color-ink-muted)]">Reading your MT5 accounts…</p>
      ) : (
        accounts.map((account) => (
          <div key={`${account.login}-${account.server}`} className="card-flush px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tabular text-sm font-semibold text-ink">{account.login}</span>
                  <Chip tone={account.accountType === 'demo' ? 'neutral' : 'gold'}>
                    {account.accountType || 'mt5'}
                  </Chip>
                  {account.marketType && <Chip tone="neutral">{account.marketType}</Chip>}
                </div>
                <p className="mt-0.5 text-[0.6875rem] text-[var(--color-ink-muted)]">{account.server}</p>
              </div>
              <div className="tabular shrink-0 text-right">
                <div className="text-sm font-semibold text-ink">{formatMoney(account.balance)}</div>
                <div className="text-[0.6875rem] text-[var(--color-ink-muted)]">{account.currency}</div>
              </div>
            </div>
          </div>
        ))
      )}
      <p className="px-1 pt-1 text-[0.6875rem] leading-relaxed text-[var(--color-ink-muted)]">
        Shown for reference only. Deriv's API manages MT5 accounts but has no call that places an order on
        one, so the bot cannot trade these — its live orders go to the Deriv account you signed in with.
        Trading an MT5 account needs a MetaTrader bridge.
      </p>
    </Card>
  );
}

export function ConnectBroker() {
  const { accounts } = useTerminal();
  const masters = accounts.filter((a) => a.role === 'master');

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
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-3">
        <Card
          title="Linked accounts"
          subtitle={`${accounts.length} terminal(s) · ${masters.length} master(s)`}
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

        <Mt5Accounts />

        <Card title="How routing works" bodyClass="p-4 text-xs leading-relaxed text-[var(--color-ink-dim)] space-y-2">
          <p>
            The engine trades the <span className="font-semibold text-ink">master</span> account. Every leg it opens —
            including each leg of a multi-entry burst and every zero-loss recovery leg — is mirrored onto each connected
            follower using that follower's own sizing rule.
          </p>
          <p>
            Followers can invert direction, keep or drop the master's stop and target, and cancel a mirrored fill when
            slippage exceeds their tolerance. Closes propagate too, so a basket exit on the master flattens the
            followers in the same pass.
          </p>
          <p className="text-[var(--color-ink-muted)]">
            Your <span className="font-semibold text-ink">Deriv</span> account is linked at sign-in, and it is the only
            account that can place real orders. Followers added here are simulated: they mirror the master's legs
            against Deriv's live prices so you can see how a routing rule would have behaved, without staking money on
            it.
          </p>
        </Card>
      </div>

      <Card title="Add a follower" subtitle="Simulated mirror account" bodyClass="p-4 space-y-3">
        <TextField
          label="Display name"
          value={form.name}
          onChange={(name) => setForm((prev) => ({ ...prev, name }))}
          placeholder="Sentinal Master"
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
          placeholder="ICMarketsSC-Live04"
        />
        <TextField
          label="Broker"
          value={form.broker ?? ''}
          onChange={(broker) => setForm((prev) => ({ ...prev, broker }))}
          placeholder="IC Markets"
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
          <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[#0a1220] p-3">
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
    </div>
  );
}
