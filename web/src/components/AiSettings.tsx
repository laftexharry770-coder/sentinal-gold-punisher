import { useState } from 'react';
import { formatMoney, getSymbolSpec, riskSizedLeg, type AiConfig } from '@sentinal/shared';
import { REVIEW_MODELS } from '@sentinal/engine';
import { api } from '../api';
import { useTerminal } from '../store';
import { toast } from './Toast';
import { Card, Chip, NumberField, TextField, Toggle } from './ui';

/** The Anthropic key: kept in this browser only (standalone), or the server's own. */
function ClaudeKey() {
  const { ai } = useTerminal();
  const state = api.claudeKey();
  const configured = ai?.claude.configured ?? state.configured;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  if (state.where === 'server') {
    return (
      <p className="rounded-xl border border-[var(--color-line)] bg-[#0e1116] px-3.5 py-3 text-xs leading-relaxed text-[var(--color-ink-dim)]">
        {configured
          ? 'The execution server has an Anthropic API key (ANTHROPIC_API_KEY): Claude can review the AI.'
          : 'Set ANTHROPIC_API_KEY in the execution server’s environment to let Claude review the AI.'}
      </p>
    );
  }

  const save = async (next: string | null) => {
    setBusy(true);
    try {
      await api.setClaudeKey(next);
      setValue('');
      toast(next ? 'Anthropic key kept in this browser' : 'Anthropic key removed', next ? 'success' : 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the key', 'error');
    } finally {
      setBusy(false);
    }
  };

  const looksWrong = value.trim().length > 0 && !value.trim().startsWith('sk-ant-');
  return (
    <div className="space-y-2">
      <TextField
        label={configured ? 'Anthropic API key — saved' : 'Anthropic API key'}
        value={value}
        onChange={setValue}
        secret
        placeholder={configured ? '•••••••• (enter a new one to replace it)' : 'sk-ant-…'}
        error={looksWrong ? 'Anthropic keys start with sk-ant-' : null}
        hint="Kept in this browser only and sent only to Anthropic. Reviews are billed to this key."
      />
      <div className="flex flex-wrap justify-end gap-2">
        {configured && (
          <button className="btn btn-ghost px-3 py-1.5 text-xs text-loss" disabled={busy} onClick={() => void save(null)}>
            Remove key
          </button>
        )}
        <button className="btn btn-primary px-3.5 py-1.5 text-xs" disabled={busy || !value.trim() || looksWrong} onClick={() => void save(value.trim())}>
          {busy ? 'Saving…' : configured ? 'Replace key' : 'Save key'}
        </button>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-[var(--color-line)] bg-[#0e1116]/70 p-3.5">
      <legend className="px-1.5 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-[var(--color-flame)]">{title}</legend>
      {note && <p className="mb-3 text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">{note}</p>}
      {children}
    </fieldset>
  );
}

/**
 * How the AI trades, directs Burst and guards the EAs, and how Claude
 * reviews it. Edits are drafts until applied, like the rest of Settings.
 */
export function AiCard({
  draft,
  onChange,
  dirty,
  saving,
  onSave,
  equity,
}: {
  draft: AiConfig;
  onChange: (next: AiConfig) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  equity: number;
}) {
  const { ai, config } = useTerminal();
  const set = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => onChange({ ...draft, [key]: value });
  const setClaude = <K extends keyof AiConfig['claude']>(key: K, value: AiConfig['claude'][K]) => onChange({ ...draft, claude: { ...draft.claude, [key]: value } });
  const reading = ai?.reading ?? null;
  const atr = reading && reading.atr > 0 ? reading.atr : null;

  // What one AI trade would be on this account, at today's volatility.
  const spec = getSymbolSpec(config.symbol);
  const stop = atr ? draft.slAtr * atr : null;
  const sized = stop && equity > 0 ? riskSizedLeg(spec, equity, Math.min(draft.riskPercent, draft.maxRiskPercent), stop, draft.rrMin) : null;
  const models = REVIEW_MODELS.some((m) => m.id === draft.claude.model) ? REVIEW_MODELS : [...REVIEW_MODELS, { id: draft.claude.model, label: draft.claude.model, note: 'custom' }];

  return (
    <Card
      title="AI"
      subtitle="Its own trades, its direction for Burst, its guard over your EAs — and Claude's reviews"
      actions={
        <div className="flex items-center gap-2">
          {dirty && <Chip tone="warn">unsaved</Chip>}
          <button className="btn btn-primary px-3 py-1.5 text-xs" disabled={!dirty || saving} onClick={onSave}>
            {saving ? 'Saving…' : 'Apply'}
          </button>
        </div>
      }
      bodyClass="p-4 space-y-4"
    >
      <p className="rounded-xl border border-[var(--color-flame)]/30 bg-[var(--color-flame)]/[0.06] px-3.5 py-3 text-xs leading-relaxed text-[var(--color-ink-dim)]">
        The AI reads every quote and one-minute bar, classifies the market, and weighs eight experts by how often each has been right in
        that kind of market, learning from every bar and every trade it closes. It turns their vote into a calibrated probability and trades
        only above the bar you set — which it raises by itself after losses and in markets where it keeps losing. It cannot see the future:
        on a market with no pattern it learns to stay out.
      </p>

      <Section title="Its own trades" note="Used when the AI is the built-in model.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <NumberField
            label="Minimum probability"
            value={Math.round(draft.minProbability * 100)}
            onChange={(v) => set('minProbability', Math.min(0.95, Math.max(0.5, v / 100)))}
            step={1}
            min={50}
            max={95}
            suffix="%"
            hint="It trades only when it gives the move at least this."
          />
          <NumberField label="Risk per trade" value={draft.riskPercent} onChange={(v) => set('riskPercent', Math.max(0.01, v))} step={0.1} min={0.01} suffix="%" hint="Share of equity lost if the stop is hit." />
          <NumberField
            label="Risk cap"
            value={draft.maxRiskPercent}
            onChange={(v) => set('maxRiskPercent', Math.max(0.01, v))}
            step={0.1}
            min={0.01}
            suffix="%"
            hint="Neither Claude nor a broker's minimum lot may take it past this."
          />
          <NumberField label="Positions at once" value={draft.maxPositions} onChange={(v) => set('maxPositions', Math.max(1, Math.round(v)))} step={1} min={1} max={10} />
          <NumberField label="Stop" value={draft.slAtr} onChange={(v) => set('slAtr', v)} step={0.1} min={0.3} suffix="ATR" hint="Wider in trends and volatile markets, tighter in ranges." />
          <NumberField label="Target from" value={draft.rrMin} onChange={(v) => set('rrMin', v)} step={0.1} min={0.5} suffix="R" hint="At the lowest confidence that trades…" />
          <NumberField label="Target up to" value={draft.rrMax} onChange={(v) => set('rrMax', v)} step={0.1} min={0.5} suffix="R" hint="…and at full confidence." />
          <NumberField label="Daily loss limit" value={draft.dailyLossPercent} onChange={(v) => set('dailyLossPercent', Math.max(0, v))} step={0.5} min={0} suffix="%" hint="Of the day's opening balance. 0 = off." />
          <NumberField label="Break-even at" value={draft.breakevenAtr} onChange={(v) => set('breakevenAtr', Math.max(0, v))} step={0.1} min={0} suffix="ATR" hint="0 = off." />
          <NumberField label="Trail from" value={draft.trailStartAtr} onChange={(v) => set('trailStartAtr', Math.max(0, v))} step={0.1} min={0} suffix="ATR" hint="0 = off." />
          <NumberField label="Trail distance" value={draft.trailAtr} onChange={(v) => set('trailAtr', v)} step={0.1} min={0.2} suffix="ATR" />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Toggle label="Close when it turns against a trade" hint="If it gives the other side a firm probability before the trade is safely in profit." checked={draft.exitOnFlip} onChange={(v) => set('exitOnFlip', v)} />
          <Toggle label="Trade volatile markets" hint="Off: it stays out while volatility is far above normal." checked={draft.tradeVolatile} onChange={(v) => set('tradeVolatile', v)} />
        </div>
        <p className="mt-3 rounded-xl border border-[var(--color-line)] bg-black/25 px-3.5 py-2.5 text-xs leading-relaxed text-[var(--color-ink-dim)]">
          {sized && stop && atr ? (
            <>
              Now (ATR {atr.toFixed(2)}, {formatMoney(equity)} equity) a trade would be{' '}
              <span className="tabular font-semibold text-ink">{sized.volume.toFixed(2)} lot</span> with its stop {stop.toFixed(2)} away, risking{' '}
              <span className="tabular font-semibold text-loss">{formatMoney(sized.riskUsd)}</span>
              {sized.minLotExceedsRisk && sized.riskUsd > (equity * draft.maxRiskPercent) / 100 ? (
                <span className="text-loss"> — more than the {draft.maxRiskPercent}% cap at the broker's minimum lot, so it would not trade</span>
              ) : null}
              .
            </>
          ) : (
            'Once it has read the market, this shows what one trade would be on your account.'
          )}
        </p>
      </Section>

      <Section title="Guarding your EAs" note="While an EA runs, the AI can refuse its new entries. Exits, stop changes and cancels are never blocked.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Toggle label="Guard the EAs" checked={draft.guardEas} onChange={(v) => set('guardEas', v)} />
          <NumberField
            label="Refuse entries at danger"
            value={Math.round(draft.guardDanger * 100)}
            onChange={(v) => set('guardDanger', Math.min(1, Math.max(0.1, v / 100)))}
            step={5}
            min={10}
            max={100}
            suffix="%"
            hint="Volatility, spread blow-outs, price jumps."
          />
          <NumberField
            label="…or when it gives the other side"
            value={Math.round(draft.guardAgainst * 100)}
            onChange={(v) => set('guardAgainst', Math.min(0.99, Math.max(0.5, v / 100)))}
            step={1}
            min={50}
            max={99}
            suffix="%"
          />
        </div>
      </Section>

      <Section title="Learning">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NumberField
            label="Prediction horizon"
            value={draft.horizonBars}
            onChange={(v) => set('horizonBars', Math.max(1, Math.round(v)))}
            step={1}
            min={1}
            max={60}
            suffix="bars"
            hint="Each prediction is scored this many one-minute bars later."
          />
          <NumberField
            label="Learning rate"
            value={draft.learningRate}
            onChange={(v) => set('learningRate', Math.min(2, Math.max(0.01, v)))}
            step={0.05}
            min={0.01}
            max={2}
            hint="How fast weight moves to the experts that were right. Higher adapts faster and forgets faster."
          />
        </div>
      </Section>

      <Section title="Claude's review" note="Every so often Claude reads the AI's settings, its accuracy, its results per kind of market and the last hour of bars, and tunes it — only ever within your limits.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Toggle label="Review automatically" hint="On a timer while the AI trades or directs Burst, and after a number of AI trades." checked={draft.claude.enabled} onChange={(v) => setClaude('enabled', v)} />
          <Toggle label="Apply suggestions at once" hint="Off: each one waits for your approval on the Control screen." checked={draft.claude.autoApply} onChange={(v) => setClaude('autoApply', v)} />
          <div>
            <label className="label" htmlFor="ai-model">
              Model
            </label>
            <select id="ai-model" className="field" value={draft.claude.model} onChange={(e) => setClaude('model', e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Every" value={draft.claude.intervalMin} onChange={(v) => setClaude('intervalMin', Math.max(0, Math.round(v)))} step={5} min={0} suffix="min" hint="0 = no timer." />
            <NumberField label="And after" value={draft.claude.afterTrades} onChange={(v) => setClaude('afterTrades', Math.max(0, Math.round(v)))} step={1} min={0} suffix="trades" hint="0 = off." />
          </div>
        </div>
        <div className="mt-4">
          <ClaudeKey />
        </div>
      </Section>
    </Card>
  );
}
