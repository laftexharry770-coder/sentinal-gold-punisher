import { useEffect, useMemo, useState } from 'react';
import { formatMoney, getSymbolSpec, riskSizedLeg, type BotConfig } from '@sentinal/shared';
import { api } from '../api';
import { StrategyCard } from '../components/StrategyPanel';
import { toast } from '../components/Toast';
import { Card, Chip, NumberField, Segmented, Toggle } from '../components/ui';
import { useTerminal } from '../store';

type Draft = BotConfig;

/** What the current account would trade under these settings, right now. */
function SizingPreview({ draft, equity }: { draft: Draft; equity: number }) {
  const spec = getSymbolSpec(draft.symbol);
  const sized = riskSizedLeg(spec, equity, draft.riskPercent, draft.stopDistance, draft.rewardRatio);
  const bookRisk = sized.riskUsd * draft.maxConcurrentPositions;

  if (equity <= 0) {
    return (
      <p className="rounded-xl border border-[var(--color-line)] bg-[#0e1116] px-3.5 py-3 text-xs text-[var(--color-ink-muted)]">
        Connect a broker to see the size these settings produce for your account.
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[#0e1116] px-3.5 py-3 text-xs text-[var(--color-ink-dim)]">
      On {formatMoney(equity)} of equity each leg is{' '}
      <span className="tabular font-semibold text-ink">{sized.volume.toFixed(2)} lots</span>, risking{' '}
      <span className="tabular font-semibold text-loss">{formatMoney(sized.stopLossUsd)}</span> against{' '}
      <span className="tabular font-semibold text-profit">{formatMoney(sized.takeProfitUsd)}</span>. A full
      book of {draft.maxConcurrentPositions} legs risks{' '}
      <span className="tabular font-semibold text-loss">{formatMoney(bookRisk)}</span> (
      {((bookRisk / equity) * 100).toFixed(1)}% of equity).
      {sized.minLotExceedsRisk && (
        <span className="mt-1.5 block text-warn">
          The broker minimum of {spec.minLot} lots risks more than {draft.riskPercent}% here — legs use the
          minimum, so the real risk per leg is {formatMoney(sized.riskUsd)}.
        </span>
      )}
    </div>
  );
}

/** How an order reaches the followers — the part of copying the operator controls. */
function DispatchCard() {
  const { config, dispatches, accounts } = useTerminal();
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<BotConfig['dispatch']>) => {
    setBusy(true);
    try {
      await api.saveBotConfig({ dispatch: { ...config.dispatch, ...patch } });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'not saved', 'error');
    } finally {
      setBusy(false);
    }
  };
  const recent = dispatches.slice(0, 20);
  const spread = recent.length ? recent.reduce((sum, d) => sum + d.sendSpreadMs, 0) / recent.length : null;
  const followerAcks = recent.flatMap((d) => d.legs.filter((l) => l.role === 'follower' && l.ackMs !== null).map((l) => l.ackMs as number));
  const avgAck = followerAcks.length ? followerAcks.reduce((a, b) => a + b, 0) / followerAcks.length : null;

  return (
    <Card
      title="Copy dispatch"
      subtitle="How each order reaches the master and its followers"
      actions={<Chip tone={config.dispatch.mode === 'simultaneous' ? 'profit' : 'neutral'}>{config.dispatch.mode}</Chip>}
      bodyClass="p-4 space-y-4"
    >
      <Segmented
        label="Dispatch"
        value={config.dispatch.mode}
        onChange={(mode) => void save({ mode })}
        options={[
          { value: 'simultaneous', label: 'Simultaneous — all accounts at once' },
          { value: 'after-fill', label: 'After the master fills' },
        ]}
      />
      <Toggle
        label="Cancel orphaned copies"
        hint="If the master's broker rejects an order the followers already filled, close those copies at once."
        checked={config.dispatch.cancelOrphans}
        disabled={busy || config.dispatch.mode !== 'simultaneous'}
        onChange={(cancelOrphans) => void save({ cancelOrphans })}
      />
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-[var(--color-line)] bg-[#0e1116] px-3.5 py-3">
          <p className="label">Send gap, master → last follower</p>
          <p className="tabular text-lg font-semibold text-ink">{spread === null ? '—' : `${spread < 1 ? spread.toFixed(3) : spread.toFixed(1)} ms`}</p>
          <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">average of the last {recent.length || 'few'} orders</p>
        </div>
        <div className="rounded-xl border border-[var(--color-line)] bg-[#0e1116] px-3.5 py-3">
          <p className="label">Follower broker answer</p>
          <p className="tabular text-lg font-semibold text-ink">{avgAck === null ? '—' : `${Math.round(avgAck)} ms`}</p>
          <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">
            {accounts.filter((a) => a.role === 'slave').length} follower(s) · network + broker execution
          </p>
        </div>
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-[var(--color-ink-muted)]">
        Simultaneous dispatch sends one order to every account in the same instant, so a copy never waits for the master's fill:
        the gap between accounts is the time to write a request on an open socket — microseconds. What remains is each broker's own
        round trip, which no software removes; running Sentinal next to MetaApi's region (see README) keeps it smallest.
      </p>
    </Card>
  );
}

export function TradeSettings() {
  const { config, stats, portfolio, strategy } = useTerminal();
  const [draft, setDraft] = useState<Draft>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // Server state wins until the operator starts editing.
  useEffect(() => {
    if (!touched) setDraft(config);
  }, [config, touched]);

  const dirty = useMemo(() => {
    const strip = ({ enabled: _e, symbol: _s, source: _src, expertInputs: _i, expertTimeframe: _t, dispatch: _d, ...rest }: Draft) => rest;
    return JSON.stringify(strip(draft)) !== JSON.stringify(strip(config));
  }, [draft, config]);
  const builtin = config.source === 'builtin';

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setTouched(true);
    setSaved(false);
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const setZeroLoss = <K extends keyof Draft['zeroLoss']>(key: K, value: Draft['zeroLoss'][K]) => {
    setTouched(true);
    setSaved(false);
    setDraft((prev) => ({ ...prev, zeroLoss: { ...prev.zeroLoss, [key]: value } }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // The strategy card and the session own these; a stale draft must not undo them.
      const { enabled: _enabled, symbol: _symbol, source: _source, expertInputs: _inputs, expertTimeframe: _tf, dispatch: _dispatch, ...patch } = draft;
      await api.saveBotConfig(patch);
      setSaved(true);
      setTouched(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setDraft(config);
    setTouched(false);
    setSaved(false);
  };

  const maxRisk = draft.stopLossUsd * draft.maxConcurrentPositions;
  const maxTarget = draft.takeProfitUsd * draft.maxConcurrentPositions;

  return (
    <div className="space-y-3 pb-4">
      <StrategyCard strategy={strategy} config={config} />

      <DispatchCard />

      {!builtin && (
        <p className="rounded-xl border border-[var(--color-flame)]/30 bg-[var(--color-flame)]/[0.06] px-3.5 py-3 text-xs leading-relaxed text-[var(--color-ink-dim)]">
          {config.source === 'mql5' ? 'Your EA' : 'The EA in MetaTrader'} decides entries, lot sizes, stops and exits. The built-in model
          settings below are kept for when you switch back; <span className="text-ink">Session guards</span> still apply to the EA — when a
          daily limit trips, its orders are refused the way MetaTrader refuses them with Algo Trading off.
        </p>
      )}

      <div className={builtin ? 'space-y-3' : 'space-y-3 opacity-60'}>
      <Card
        title="Built-in model"
        subtitle={`${config.symbol} · dollar-based risk`}
        actions={
          <div className="flex items-center gap-2">
            {dirty && <Chip tone="warn">unsaved</Chip>}
            {saved && !dirty && <Chip tone="profit">saved</Chip>}
            <button className="btn btn-ghost px-3 py-1.5 text-xs" disabled={!dirty || saving} onClick={reset}>
              Reset
            </button>
            <button className="btn btn-primary px-3 py-1.5 text-xs" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Apply'}
            </button>
          </div>
        }
        bodyClass="p-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        <div>
          <label className="label">Strategy model</label>
          <select
            className="field"
            value={draft.strategy}
            onChange={(e) => set('strategy', e.target.value as Draft['strategy'])}
          >
            <option value="adaptive-scalp">Adaptive scalp (trend pullback)</option>
            <option value="momentum">Momentum breakout</option>
            <option value="mean-reversion">Mean reversion</option>
          </select>
          <p className="mt-1 text-[0.6875rem] text-[var(--color-ink-muted)]">
            Adaptive scalp is the shipped default: it leans on the fast/slow spread and enters on pullbacks.
          </p>
        </div>

        <Segmented
          label="Execution mode"
          value={draft.execution}
          onChange={(value) => set('execution', value)}
          options={[
            { value: 'intrabar', label: 'Intrabar / immediate' },
            { value: 'bar-close', label: 'On bar close' },
          ]}
        />

        <NumberField
          label="Signal threshold"
          value={draft.minSignalStrength}
          onChange={(v) => set('minSignalStrength', v)}
          step={0.05}
          min={0}
          max={1}
          hint="Minimum model confidence before any leg fires."
        />
      </Card>

      <Card
        title="Position sizing"
        subtitle="How big each leg is, and what it risks"
        actions={<Chip tone={draft.sizing === 'risk-percent' ? 'accent' : 'neutral'}>
          {draft.sizing === 'risk-percent' ? 'Adaptive' : 'Fixed lot'}
        </Chip>}
        bodyClass="p-4 space-y-4"
      >
        <Segmented
          label="Sizing mode"
          value={draft.sizing}
          onChange={(value) => set('sizing', value)}
          options={[
            { value: 'risk-percent', label: 'Risk % of equity' },
            { value: 'fixed', label: 'Fixed lot' },
          ]}
        />

        {draft.sizing === 'risk-percent' && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <NumberField
                label="Risk per leg"
                value={draft.riskPercent}
                onChange={(v) => set('riskPercent', v)}
                step={0.05}
                min={0.01}
                max={100}
                suffix="%"
                hint="Share of live equity risked if the stop is hit."
              />
              <NumberField
                label="Stop distance"
                value={draft.stopDistance}
                onChange={(v) => set('stopDistance', v)}
                step={0.1}
                min={0.01}
                suffix="price"
                hint="How far price moves against the leg before the stop."
              />
              <NumberField
                label="Target ratio"
                value={draft.rewardRatio}
                onChange={(v) => set('rewardRatio', v)}
                step={0.1}
                min={0.1}
                suffix="× stop"
                hint="0.5 takes half the stop as profit; 2 takes twice."
              />
            </div>
            <SizingPreview draft={draft} equity={portfolio?.equity ?? 0} />
          </>
        )}
      </Card>

      <Card
        title="Fixed risk per leg"
        subtitle="Used when sizing is set to fixed lot"
        bodyClass={`p-4 grid gap-4 md:grid-cols-3 ${draft.sizing === 'risk-percent' ? 'opacity-50' : ''}`}
      >
        <NumberField
          label="Lot size"
          value={draft.lotSize}
          onChange={(v) => set('lotSize', v)}
          step={0.01}
          min={0.01}
          suffix="lot"
          hint="0.01 is the broker minimum on XAUUSD."
        />
        <NumberField
          label="Stop loss"
          value={draft.stopLossUsd}
          onChange={(v) => set('stopLossUsd', v)}
          step={0.5}
          min={0}
          suffix="$"
          hint={`≈ ${(draft.stopLossUsd / (draft.lotSize * 100)).toFixed(2)} price move at ${draft.lotSize} lots.`}
        />
        <NumberField
          label="Take profit"
          value={draft.takeProfitUsd}
          onChange={(v) => set('takeProfitUsd', v)}
          step={0.5}
          min={0}
          suffix="$"
          hint={`≈ ${(draft.takeProfitUsd / (draft.lotSize * 100)).toFixed(2)} price move at ${draft.lotSize} lots.`}
        />
      </Card>

      <Card
        title="Multi-position execution"
        subtitle="How many trades the engine may run at the same time"
        actions={<Chip tone="accent">{draft.entriesPerSignal} legs / signal</Chip>}
        bodyClass="p-4 space-y-4"
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <NumberField
            label="Max concurrent positions"
            value={draft.maxConcurrentPositions}
            onChange={(v) => set('maxConcurrentPositions', Math.max(1, Math.round(v)))}
            step={1}
            min={1}
            max={100}
            hint="Hard cap on simultaneously open bot legs."
          />
          <NumberField
            label="Max per direction"
            value={draft.maxPositionsPerDirection}
            onChange={(v) => set('maxPositionsPerDirection', Math.max(1, Math.round(v)))}
            step={1}
            min={1}
            max={100}
            hint="Longs and shorts are capped separately."
          />
          <NumberField
            label="Entries per signal"
            value={draft.entriesPerSignal}
            onChange={(v) => set('entriesPerSignal', Math.max(1, Math.round(v)))}
            step={1}
            min={1}
            max={20}
            hint="Legs fired together on one qualified signal."
          />
          <NumberField
            label="Entry spacing"
            value={draft.entrySpacingUsd}
            onChange={(v) => set('entrySpacingUsd', v)}
            step={0.05}
            min={0}
            suffix="$"
            hint="Minimum gold-price distance from the nearest same-side leg."
          />
          <NumberField
            label="Signal cooldown"
            value={draft.signalCooldownMs}
            onChange={(v) => set('signalCooldownMs', Math.max(0, Math.round(v)))}
            step={500}
            min={0}
            suffix="ms"
            hint="Pause between two entry bursts."
          />
          <NumberField
            label="Max spread"
            value={draft.maxSpread}
            onChange={(v) => set('maxSpread', v)}
            step={0.05}
            min={0}
            suffix="$"
            hint="Entries pause while the spread is wider than this."
          />
        </div>

        <Toggle
          label="Allow hedging"
          hint="Permit long and short legs to be open at the same time."
          checked={draft.allowHedging}
          onChange={(v) => set('allowHedging', v)}
        />

        <div className="rounded-xl border border-[var(--color-line)] bg-[#0e1116] px-3.5 py-3 text-xs text-[var(--color-ink-dim)]">
          At full book the engine holds{' '}
          <span className="tabular font-semibold text-ink">
            {(draft.maxConcurrentPositions * draft.lotSize).toFixed(2)} lots
          </span>{' '}
          across {draft.maxConcurrentPositions} legs — risking{' '}
          <span className="tabular font-semibold text-loss">{formatMoney(maxRisk)}</span> against{' '}
          <span className="tabular font-semibold text-profit">{formatMoney(maxTarget)}</span> of targets.
        </div>
      </Card>

      <Card title="Basket management" subtitle="Close every leg together on a combined result" bodyClass="p-4 grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <Toggle
            label="Basket take profit"
            hint="Flatten the whole book once combined float reaches the target."
            checked={draft.basketTakeProfitUsd !== null}
            onChange={(v) => set('basketTakeProfitUsd', v ? 6 : null)}
          />
          {draft.basketTakeProfitUsd !== null && (
            <NumberField
              label="Combined target"
              value={draft.basketTakeProfitUsd}
              onChange={(v) => set('basketTakeProfitUsd', v)}
              step={0.5}
              min={0}
              suffix="$"
            />
          )}
        </div>
        <div className="space-y-3">
          <Toggle
            label="Basket stop loss"
            hint="Emergency flatten when the combined float falls through this figure."
            checked={draft.basketStopLossUsd !== null}
            onChange={(v) => set('basketStopLossUsd', v ? 25 : null)}
          />
          {draft.basketStopLossUsd !== null && (
            <NumberField
              label="Combined stop"
              value={draft.basketStopLossUsd}
              onChange={(v) => set('basketStopLossUsd', v)}
              step={1}
              min={0}
              suffix="$"
            />
          )}
        </div>
      </Card>

      <Card
        title="Zero-loss recovery"
        subtitle="Postponed recovery legs sized to clear the running deficit"
        actions={
          <Chip tone={draft.zeroLoss.enabled ? 'profit' : 'neutral'}>
            {stats ? `deficit ${formatMoney(stats.pendingDeficit)}` : 'idle'}
          </Chip>
        }
        bodyClass="p-4 space-y-4"
      >
        <Toggle
          label="Enable zero-loss postponement"
          hint="Recovery legs are held back until their projected close clears the deficit plus the minimum profit."
          checked={draft.zeroLoss.enabled}
          onChange={(v) => setZeroLoss('enabled', v)}
        />

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <NumberField
            label="Recovery multiplier"
            value={draft.zeroLoss.recoveryMultiplier}
            onChange={(v) => setZeroLoss('recoveryMultiplier', v)}
            step={0.05}
            min={1}
            disabled={!draft.zeroLoss.enabled}
            hint="Safety factor applied on top of the exact break-even size."
          />
          <NumberField
            label="Max recovery layers"
            value={draft.zeroLoss.maxRecoveryLayers}
            onChange={(v) => setZeroLoss('maxRecoveryLayers', Math.max(1, Math.round(v)))}
            step={1}
            min={1}
            max={10}
            disabled={!draft.zeroLoss.enabled}
            hint="Also the number of legs a single recovery may be split across."
          />
          <NumberField
            label="Minimum net profit"
            value={draft.zeroLoss.minNetProfitUsd}
            onChange={(v) => setZeroLoss('minNetProfitUsd', v)}
            step={0.05}
            min={0}
            suffix="$"
            disabled={!draft.zeroLoss.enabled}
            hint="A recovery only fires when it projects at least this much on top of the deficit."
          />
          <NumberField
            label="Max recovery lot"
            value={draft.zeroLoss.maxRecoveryLot}
            onChange={(v) => setZeroLoss('maxRecoveryLot', v)}
            step={0.01}
            min={0.01}
            suffix="lot"
            disabled={!draft.zeroLoss.enabled}
            hint="Per-leg ceiling; larger requirements are split across layers."
          />
          <NumberField
            label="Deficit pause threshold"
            value={draft.zeroLoss.maxDeficitUsd}
            onChange={(v) => setZeroLoss('maxDeficitUsd', v)}
            step={1}
            min={0}
            suffix="$"
            disabled={!draft.zeroLoss.enabled}
            hint="Above this outstanding deficit, fresh entries pause until it is worked off."
          />
        </div>

        <Toggle
          label="Require aligned signal"
          hint="Hold the recovery until price action agrees with its direction."
          checked={draft.zeroLoss.requireSignalAlignment}
          onChange={(v) => setZeroLoss('requireSignalAlignment', v)}
          disabled={!draft.zeroLoss.enabled}
        />
      </Card>

      </div>

      <Card title="Session guards" subtitle="Daily circuit breakers" bodyClass="p-4 grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <Toggle
            label="Daily loss limit"
            checked={draft.maxDailyLossUsd !== null}
            onChange={(v) => set('maxDailyLossUsd', v ? 60 : null)}
            hint="Halts new entries for the rest of the day."
          />
          {draft.maxDailyLossUsd !== null && (
            <NumberField
              label="Loss limit"
              value={draft.maxDailyLossUsd}
              onChange={(v) => set('maxDailyLossUsd', v)}
              step={5}
              min={0}
              suffix="$"
            />
          )}
        </div>
        <div className="space-y-3">
          <Toggle
            label="Daily trade cap"
            checked={draft.maxDailyTrades !== null}
            onChange={(v) => set('maxDailyTrades', v ? 400 : null)}
            hint="Stops the engine after this many fills today."
          />
          {draft.maxDailyTrades !== null && (
            <NumberField
              label="Trade cap"
              value={draft.maxDailyTrades}
              onChange={(v) => set('maxDailyTrades', Math.max(1, Math.round(v)))}
              step={10}
              min={1}
            />
          )}
        </div>
      </Card>

      {error && <p className="text-xs text-loss">{error}</p>}

      {/* Only surfaces while there are pending edits, so it never covers content idly. */}
      {dirty && (
        <div className="sticky bottom-20 z-20 flex justify-end gap-2 lg:bottom-2">
          <button className="btn btn-ghost px-4 py-2 text-xs" disabled={saving} onClick={reset}>
            Discard
          </button>
          <button className="btn btn-primary px-4 py-2 text-xs" disabled={saving} onClick={() => void save()}>
            {saving ? 'Applying…' : 'Apply settings'}
          </button>
        </div>
      )}
    </div>
  );
}
