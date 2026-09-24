import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfig, StrategyInfo, StrategyInput } from '@sentinal/shared';
import sampleExpert from '../../../mql5/samples/Sentinal.mq5?raw';
import { api, type StrategyFile, type StrategyLoadOutcome } from '../api';
import { readStrategyFile } from '../strategyFiles';
import { StrategySwitch, useSavedStrategy } from './StrategySwitch';
import { toast } from './Toast';
import { Card, Chip, Toggle } from './ui';

/* ------------------------------------------------------------------ */
/* Timeframes and input values                                         */
/* ------------------------------------------------------------------ */

export const TIMEFRAMES: { value: number; label: string }[] = [
  { value: 1, label: 'M1' },
  { value: 2, label: 'M2' },
  { value: 3, label: 'M3' },
  { value: 5, label: 'M5' },
  { value: 10, label: 'M10' },
  { value: 15, label: 'M15' },
  { value: 30, label: 'M30' },
  { value: 16385, label: 'H1' },
  { value: 16386, label: 'H2' },
  { value: 16388, label: 'H4' },
  { value: 16396, label: 'H12' },
  { value: 16408, label: 'D1' },
  { value: 32769, label: 'W1' },
  { value: 49153, label: 'MN1' },
];

type Value = string | number | boolean;

/** PERIOD_H4 → H4, PERIOD_CURRENT → the chart's own. */
function timeframeLabel(name: string, label: string): string {
  if (name === 'PERIOD_CURRENT') return 'Chart timeframe';
  return name.startsWith('PERIOD_') ? name.slice(7) : label || name;
}

/** "=== Trend adaptation ===" as a heading. */
function groupTitle(group: string): string {
  return group.replace(/^[\s=\-*#]+|[\s=\-*#]+$/g, '') || 'Inputs';
}

/** MQL5 colours are 0x00BBGGRR; the colour picker wants #rrggbb. */
function colorToHex(value: number): string {
  const r = value & 0xff;
  const g = (value >> 8) & 0xff;
  const b = (value >> 16) & 0xff;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function hexToColor(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff);
}

function toLocalInput(seconds: number): string {
  if (!seconds) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 16);
}

function InputRow({ input, value, onChange }: { input: StrategyInput; value: Value | null; onChange: (value: Value) => void }) {
  const id = `ea-${input.name}`;
  const label = (
    <label className="label !normal-case !tracking-normal !text-[0.75rem] !font-medium !text-[var(--color-ink-dim)]" htmlFor={id}>
      {input.label}
      {input.label !== input.name && <span className="ml-1.5 font-mono text-[0.625rem] text-[var(--color-ink-muted)]">{input.name}</span>}
    </label>
  );

  switch (input.kind) {
    case 'bool':
      return <Toggle label={input.label} hint={input.label !== input.name ? input.name : undefined} checked={Boolean(value)} onChange={onChange} />;
    case 'enum':
    case 'timeframe': {
      const options = input.options?.length
        ? input.options.map((o) => ({ value: o.value, label: input.kind === 'timeframe' ? timeframeLabel(o.name, o.label) : o.label || o.name }))
        : input.kind === 'timeframe'
          ? [{ value: 0, label: 'Chart timeframe' }, ...TIMEFRAMES]
          : [];
      return (
        <div>
          {label}
          <select id={id} className="field" value={Number(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case 'color':
      return (
        <div>
          {label}
          <input id={id} type="color" className="field h-10 p-1" value={colorToHex(Number(value ?? 0))} onChange={(e) => onChange(hexToColor(e.target.value))} />
        </div>
      );
    case 'datetime':
      return (
        <div>
          {label}
          <input
            id={id}
            type="datetime-local"
            className="field"
            value={toLocalInput(Number(value ?? 0))}
            onChange={(e) => onChange(e.target.value ? Math.floor(Date.parse(`${e.target.value}:00Z`) / 1000) : 0)}
          />
        </div>
      );
    case 'string':
      return (
        <div>
          {label}
          <input id={id} className="field" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    default:
      return (
        <div>
          {label}
          <input
            id={id}
            type="number"
            className="field tabular"
            step={input.kind === 'int' ? 1 : 'any'}
            value={value === null || value === undefined ? '' : Number(value)}
            onChange={(e) => onChange(input.kind === 'int' ? Math.trunc(Number(e.target.value)) : Number(e.target.value))}
          />
        </div>
      );
  }
}

/** The EA's own inputs, grouped the way its source groups them. */
function ExpertInputs({ strategy, config }: { strategy: StrategyInfo; config: BotConfig }) {
  const [draft, setDraft] = useState<Record<string, Value>>(config.expertInputs);
  const [timeframe, setTimeframe] = useState(config.expertTimeframe);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched) return;
    setDraft(config.expertInputs);
    setTimeframe(config.expertTimeframe);
  }, [config.expertInputs, config.expertTimeframe, touched]);

  const groups = useMemo(() => {
    const map = new Map<string, StrategyInput[]>();
    for (const input of strategy.inputs) {
      const key = input.group || 'Inputs';
      map.set(key, [...(map.get(key) ?? []), input]);
    }
    return [...map.entries()];
  }, [strategy.inputs]);

  const valueOf = (input: StrategyInput): Value | null => (input.name in draft ? draft[input.name]! : input.defaultValue);
  const changed = Object.keys(draft).length > 0 && JSON.stringify(draft) !== JSON.stringify(config.expertInputs);
  const dirty = changed || timeframe !== config.expertTimeframe;

  const apply = async () => {
    setSaving(true);
    try {
      await api.configureExpert({ inputs: draft, timeframe });
      setTouched(false);
      toast(strategy.status === 'running' ? `${strategy.name} restarted with the new inputs` : 'Inputs saved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Inputs were not saved', 'error');
    } finally {
      setSaving(false);
    }
  };

  const defaults = () => {
    setTouched(true);
    setDraft({});
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_1fr] sm:items-end">
        <div>
          <label className="label" htmlFor="ea-timeframe">
            Chart timeframe
          </label>
          <select
            id="ea-timeframe"
            className="field"
            value={timeframe}
            onChange={(e) => {
              setTouched(true);
              setTimeframe(Number(e.target.value));
            }}
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf.value} value={tf.value}>
                {tf.label}
              </option>
            ))}
          </select>
        </div>
        <p className="text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">
          The chart the EA is attached to, as in MetaTrader: its <span className="font-mono">_Period</span>, and the bars a new-bar check waits for.
        </p>
      </div>

      {groups.map(([group, inputs]) => (
        <fieldset key={group} className="rounded-xl border border-[var(--color-line)] bg-[#0e1116]/70 p-3.5">
          <legend className="px-1.5 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-[var(--color-flame)]">{groupTitle(group)}</legend>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {inputs.map((input) => (
              <InputRow
                key={input.name}
                input={input}
                value={valueOf(input)}
                onChange={(value) => {
                  setTouched(true);
                  setDraft((prev) => ({ ...prev, [input.name]: value }));
                }}
              />
            ))}
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button className="btn btn-ghost px-3 py-1.5 text-xs" disabled={saving} onClick={defaults}>
          Source defaults
        </button>
        <button className="btn btn-primary px-3.5 py-1.5 text-xs" disabled={saving || (!dirty && !touched)} onClick={() => void apply()}>
          {saving ? 'Applying…' : strategy.status === 'running' ? 'Apply and restart EA' : 'Apply inputs'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

const SOURCE_LABEL: Record<StrategyInfo['source'], string> = {
  builtin: 'Built-in model',
  mql5: 'MQL5 expert (.mq5)',
  mirror: 'MetaTrader EA (.ex5)',
};

const STATUS_TONE: Record<StrategyInfo['status'], 'profit' | 'neutral' | 'loss' | 'warn'> = {
  running: 'profit',
  idle: 'neutral',
  stopped: 'neutral',
  failed: 'loss',
  waiting: 'warn',
};

/**
 * What the bot trades with, changeable at any time: drop in an .mq5 (with the
 * .mqh files it includes) to run it here, an .ex5 to copy what it does in
 * MetaTrader, or go back to the built-in models.
 */
export function StrategyCard({ strategy, config }: { strategy: StrategyInfo | null; config: BotConfig }) {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [outcome, setOutcome] = useState<StrategyLoadOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const source = strategy?.source ?? config.source;
  const [saved, refreshSaved] = useSavedStrategy();

  const load = async (files: StrategyFile[]) => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await api.loadStrategy(files);
      setOutcome(result);
      if (result.kind === 'ex5') toast(`${result.info.name} loaded — mirror mode`);
      else if (result.result.ok) toast(`${result.result.name} compiled — ${result.result.inputs.length} inputs`);
      else toast(`${files.find((f) => /\.mq5$/i.test(f.name))?.name ?? 'The EA'} did not compile`, 'error');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The files could not be loaded');
    } finally {
      setBusy(false);
    }
  };

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const accepted = [...list].filter((f) => /\.(mq5|mqh|ex5)$/i.test(f.name));
    if (accepted.length === 0) {
      setError('Choose an .mq5 or .ex5 file (and any .mqh headers the .mq5 includes).');
      return;
    }
    await load(await Promise.all(accepted.map(readStrategyFile)));
  };

  const forget = async () => {
    if (!saved) return;
    if (!window.confirm(`Remove ${saved.fileName} from this ${saved.active ? 'terminal? Burst takes over as the strategy.' : 'terminal?'}`)) return;
    setBusy(true);
    try {
      await api.forgetSavedStrategy();
      setOutcome(null);
      toast(`${saved.fileName} removed`, 'info');
    } finally {
      setBusy(false);
      refreshSaved();
    }
  };

  const failed = outcome?.kind === 'mql5' && !outcome.result.ok ? outcome.result : null;
  const warnings = strategy?.diagnostics.filter((d) => d.severity === 'warning') ?? [];

  return (
    <Card
      title="Strategy"
      subtitle="What the bot trades with — change it any time"
      actions={
        <div className="flex items-center gap-1.5">
          <Chip tone="gold">{source === 'builtin' && config.strategy === 'burst' ? 'Burst' : SOURCE_LABEL[source]}</Chip>
          {strategy && <Chip tone={STATUS_TONE[strategy.status]}>{strategy.status}</Chip>}
        </div>
      }
      bodyClass="p-4 space-y-4"
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div
          className="dropzone flex flex-col items-center justify-center gap-2 px-4 py-6 text-center"
          data-active={dragging}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void onFiles(e.dataTransfer.files);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 text-[var(--color-flame)]" aria-hidden="true">
            <path d="M12 15.5V4.5m0 0-4 4m4-4 4 4M5 15v2.5A2 2 0 0 0 7 19.5h10a2 2 0 0 0 2-2V15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="text-sm font-semibold text-ink">Drop your EA here</p>
          <p className="text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">
            .mq5 source (plus any .mqh it includes), or a compiled .ex5 — e.g. Angel_Bot.mq5
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".mq5,.mqh,.ex5"
            multiple
            className="hidden"
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button className="btn btn-primary mt-1 px-4 py-2 text-xs" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Compiling…' : 'Choose files'}
          </button>
        </div>

        <div className="space-y-2.5 rounded-xl border border-[var(--color-line)] bg-[#0e1116]/70 p-3.5 text-xs leading-relaxed text-[var(--color-ink-dim)]">
          <StrategySwitch />
          {source === 'builtin' && (
            <p>
              {config.strategy === 'burst'
                ? 'Burst is trading: bursts of small positions in the trend’s direction, each taking profit at the broker, the next burst as soon as the last closes. Its settings are below.'
                : `The built-in ${config.strategy} model is trading. Its settings are below.`}
              {saved && !saved.active && (
                <span className="mt-1 block text-[var(--color-ink-muted)]">
                  {saved.fileName} stays saved — pick it above to switch back.
                </span>
              )}
            </p>
          )}
          {source === 'mql5' && strategy && (
            <>
              <p>
                <span className="font-semibold text-ink">{strategy.fileName}</span> runs inside Sentinal on the master account: its
                OrderSend goes to the master and every follower in the same instant.
              </p>
              <p className="tabular text-[var(--color-ink-muted)]">
                {strategy.inputs.length} inputs · {strategy.ticks.toLocaleString()} ticks processed
                {strategy.lastTickMs !== null ? ` · ${strategy.lastTickMs.toFixed(3)} ms per OnTick` : ''}
              </p>
            </>
          )}
          {source === 'mirror' && strategy && (
            <>
              <p>
                <span className="font-semibold text-ink">{strategy.fileName}</span> is compiled code, and compiled EAs only run inside
                MetaTrader. Attach it to the master account's chart in your MT5 (desktop or VPS) with Algo Trading on, then start the
                bot here: every position it opens is copied to the followers the moment MetaApi reports it.
              </p>
              {strategy.fingerprint && (
                <p className="break-all font-mono text-[0.625rem] text-[var(--color-ink-muted)]">SHA-256 {strategy.fingerprint}</p>
              )}
              <p className="text-[var(--color-ink-muted)]">
                Have the .mq5? Upload it instead and the EA runs here, with no MetaTrader terminal to keep open.
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {saved && (
              <button className="btn btn-ghost px-3 py-1.5 text-xs text-loss" disabled={busy} onClick={() => void forget()}>
                Remove {saved.fileName}
              </button>
            )}
            <button
              className="btn btn-ghost px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={() => void load([{ name: 'Sentinal.mq5', content: sampleExpert, encoding: 'text' }])}
            >
              Load sample EA
            </button>
          </div>
        </div>
      </div>

      {error && <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">{error}</p>}

      {failed && (
        <div className="rounded-xl border border-loss/40 bg-loss/[0.07] p-3.5">
          <p className="text-xs font-semibold text-loss">{failed.name} did not compile — the previous strategy is still in place.</p>
          <ul className="tabular mt-2 max-h-48 space-y-1 overflow-auto text-[0.6875rem] text-[var(--color-ink-dim)]">
            {failed.diagnostics.map((d, i) => (
              <li key={i}>
                <span className={d.severity === 'error' ? 'text-loss' : 'text-warn'}>{d.severity}</span> {d.file}:{d.line} — {d.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && source === 'mql5' && (
        <details className="rounded-xl border border-warn/30 bg-warn/[0.05] px-3.5 py-2.5">
          <summary className="cursor-pointer text-xs font-semibold text-warn">{warnings.length} compiler note(s)</summary>
          <ul className="tabular mt-2 space-y-1 text-[0.6875rem] text-[var(--color-ink-dim)]">
            {warnings.map((d, i) => (
              <li key={i}>
                {d.file}:{d.line} — {d.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {strategy?.status === 'failed' && strategy.detail && (
        <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">{strategy.detail}</p>
      )}

      {source === 'mql5' && strategy && strategy.inputs.length > 0 && <ExpertInputs strategy={strategy} config={config} />}
    </Card>
  );
}
