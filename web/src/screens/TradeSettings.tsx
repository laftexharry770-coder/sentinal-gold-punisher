import { useEffect, useMemo, useState } from 'react';
import { formatMoney, type BotConfig } from '@sentinal/shared';
import { api } from '../api';
import { Card, Chip, NumberField, Segmented, Toggle } from '../components/ui';
import { useTerminal } from '../store';

type Draft = BotConfig;

export function TradeSettings() {
  const { config, stats } = useTerminal();
  const [draft, setDraft] = useState<Draft>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // Server state wins until the operator starts editing.
  useEffect(() => {
    if (!touched) setDraft(config);
  }, [config, touched]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config]);

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
      await api.saveBotConfig(draft);
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
      <Card
        title="Strategy profile"
        subtitle="XAUUSD exclusive · dollar-based risk"
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

      <Card title="Risk per leg" subtitle="Dollar-based stop and target" bodyClass="p-4 grid gap-4 md:grid-cols-3">
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
        actions={<Chip tone="cobalt">{draft.entriesPerSignal} legs / signal</Chip>}
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

        <div className="rounded-xl border border-[var(--color-line)] bg-[#0a1220] px-3.5 py-3 text-xs text-[var(--color-ink-dim)]">
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
