import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExpertSlot, StrategyInfo, StrategyInput } from '@sentinal/shared';
import sampleExpert from '../../../mql5/samples/Sentinal.mq5?raw';
import { api, type AddedExpert, type StrategyFile } from '../api';
import { ANGEL_BOT, isAngelBot } from '../bundledStrategies';
import { useTerminal } from '../store';
import { readStrategyFile } from '../strategyFiles';
import { BuiltinSwitch } from './StrategySwitch';
import { toast } from './Toast';
import { Card, Chip, Switch, Toggle } from './ui';

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

/** One EA's own inputs, grouped the way its source groups them. */
function ExpertInputs({ slot }: { slot: ExpertSlot }) {
  const strategy = slot.info;
  const [draft, setDraft] = useState<Record<string, Value>>(slot.inputs);
  const [timeframe, setTimeframe] = useState(slot.timeframe);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched) return;
    setDraft(slot.inputs);
    setTimeframe(slot.timeframe);
  }, [slot.inputs, slot.timeframe, touched]);

  const groups = useMemo(() => {
    const map = new Map<string, StrategyInput[]>();
    for (const input of strategy.inputs) {
      const key = input.group || 'Inputs';
      map.set(key, [...(map.get(key) ?? []), input]);
    }
    return [...map.entries()];
  }, [strategy.inputs]);

  const valueOf = (input: StrategyInput): Value | null => (input.name in draft ? draft[input.name]! : input.defaultValue);
  const dirty = JSON.stringify(draft) !== JSON.stringify(slot.inputs) || timeframe !== slot.timeframe;
  const tfId = `ea-tf-${slot.id}`;

  const apply = async () => {
    setSaving(true);
    try {
      await api.configureExpert(slot.id, { inputs: draft, timeframe });
      setTouched(false);
      toast(strategy.status === 'running' ? `${strategy.name} restarted with the new inputs` : `${strategy.name}: inputs saved`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Inputs were not saved', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_1fr] sm:items-end">
        <div>
          <label className="label" htmlFor={tfId}>
            Chart timeframe
          </label>
          <select
            id={tfId}
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
          The chart this EA is attached to, as in MetaTrader: its <span className="font-mono">_Period</span>, and the bars a new-bar check waits for.
        </p>
      </div>

      {groups.map(([group, inputs]) => (
        <fieldset key={group} className="rounded-xl border border-[var(--color-line)] bg-black/25 p-3.5">
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
        <button
          className="btn btn-ghost px-3 py-1.5 text-xs"
          disabled={saving}
          onClick={() => {
            setTouched(true);
            setDraft({});
          }}
        >
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
/* The library                                                          */
/* ------------------------------------------------------------------ */

const STATUS_DOT: Record<StrategyInfo['status'], string> = {
  running: 'bg-profit live-dot',
  waiting: 'bg-warn',
  idle: 'bg-[#4a4f57]',
  stopped: 'bg-[#4a4f57]',
  failed: 'bg-loss',
};

/** One line on how an EA is doing, in words. */
export function expertLine(slot: ExpertSlot, botRunning: boolean): string {
  const info = slot.info;
  if (info.status === 'failed') return info.detail ?? 'stopped with an error';
  if (!slot.enabled) return 'switched off';
  if (slot.kind === 'ex5') return botRunning ? 'copying what it trades in your MetaTrader' : 'runs in your MetaTrader — copied while the bot runs';
  if (info.status === 'waiting') return info.detail ?? 'loading history';
  if (info.status === 'running') {
    const speed = info.lastTickMs !== null ? ` · ${info.lastTickMs < 1 ? info.lastTickMs.toFixed(3) : info.lastTickMs.toFixed(1)} ms per tick` : '';
    return `running · ${info.ticks.toLocaleString()} ticks${speed}`;
  }
  const tf = TIMEFRAMES.find((t) => t.value === slot.timeframe)?.label ?? `TF ${slot.timeframe}`;
  return `ready · ${info.inputs.length} inputs · ${tf} — starts with the bot`;
}

function ExpertRow({ slot, botRunning, open, onToggleOpen }: { slot: ExpertSlot; botRunning: boolean; open: boolean; onToggleOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const info = slot.info;
  const warnings = info.diagnostics.filter((d) => d.severity === 'warning');
  const panelText = [...info.panel, ...(info.comment ? [info.comment] : [])].join('\n');

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.setExpertEnabled(slot.id, enabled);
      toast(`${info.name} ${enabled ? (botRunning ? 'started' : 'switched on — it runs with the bot') : 'switched off'}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not switch it', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${slot.fileName} from the library?${slot.enabled && botRunning ? ' It stops now; its open positions stay open.' : ''}`)) return;
    setBusy(true);
    try {
      await api.removeExpert(slot.id);
      toast(`${slot.fileName} removed`, 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove it', 'error');
      setBusy(false);
    }
  };

  return (
    <li className={`rounded-xl border bg-[#0e1116]/80 transition-colors ${slot.enabled ? 'border-[var(--color-flame)]/35' : 'border-[var(--color-line)]'}`}>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${slot.enabled ? STATUS_DOT[info.status] : 'bg-[#4a4f57]'}`} aria-hidden="true" />
        <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={open} onClick={onToggleOpen}>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold text-ink">{info.name}</span>
            <span className="rounded-md border border-[var(--color-line)] px-1.5 py-px font-mono text-[0.625rem] text-[var(--color-ink-muted)]">
              {slot.kind === 'ex5' ? '.ex5 · mirror' : '.mq5'}
            </span>
            {slot.bundled && <span className="rounded-md border border-gold/40 px-1.5 py-px text-[0.625rem] font-semibold text-gold">built in</span>}
          </span>
          <span className={`mt-0.5 block truncate text-[0.6875rem] ${info.status === 'failed' ? 'text-loss' : 'text-[var(--color-ink-muted)]'}`}>{expertLine(slot, botRunning)}</span>
        </button>
        <Switch checked={slot.enabled} disabled={busy} label={`Run ${info.name}`} onChange={(v) => void setEnabled(v)} />
        <button type="button" className="shrink-0 rounded-lg p-1 text-[var(--color-ink-muted)] hover:text-ink" aria-label={open ? `Close ${info.name}` : `Open ${info.name}`} onClick={onToggleOpen}>
          <svg viewBox="0 0 20 20" fill="none" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true">
            <path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-[var(--color-line)] px-3.5 py-3.5 text-xs leading-relaxed text-[var(--color-ink-dim)]">
          {slot.kind === 'ex5' ? (
            <>
              <p>
                Compiled code runs only inside MetaTrader. Attach <span className="font-semibold text-ink">{slot.fileName}</span> to the master
                account's chart in your MT5 (desktop or VPS) with Algo Trading on: while it is switched on here and the bot runs, every
                position it opens is copied to the followers the moment MetaApi reports it.
              </p>
              {info.fingerprint && <p className="break-all font-mono text-[0.625rem] text-[var(--color-ink-muted)]">SHA-256 {info.fingerprint}</p>}
            </>
          ) : (
            <>
              {isAngelBot(slot.fileName) && (
                <p>
                  Its buy stop and sell stop are placed on every follower at the same prices and moved with the master's. At the default 0.10 lot
                  each position moves $10 per $1 of gold — lower <span className="font-mono">InpLots</span> below for a small account.
                </p>
              )}
              {panelText && (
                <details className="rounded-xl border border-[var(--color-line)] bg-black/30 px-3.5 py-2.5" open={info.status === 'running'}>
                  <summary className="cursor-pointer text-xs font-semibold text-[var(--color-ink-dim)]">Status panel</summary>
                  <pre className="tabular mt-2 overflow-x-auto whitespace-pre text-[0.6875rem] leading-relaxed">{panelText}</pre>
                </details>
              )}
              {info.inputs.length > 0 ? <ExpertInputs slot={slot} /> : <p className="text-[var(--color-ink-muted)]">This EA declares no inputs.</p>}
              {warnings.length > 0 && (
                <details className="rounded-xl border border-warn/30 bg-warn/[0.05] px-3.5 py-2.5">
                  <summary className="cursor-pointer text-xs font-semibold text-warn">{warnings.length} compiler note(s)</summary>
                  <ul className="tabular mt-2 space-y-1 text-[0.6875rem]">
                    {warnings.map((d, i) => (
                      <li key={i}>
                        {d.file}:{d.line} — {d.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          <div className="flex justify-end">
            <button className="btn btn-ghost px-3 py-1.5 text-xs text-loss" disabled={busy} onClick={() => void remove()}>
              Remove from library
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** What one upload did, file by file. */
function UploadResults({ results }: { results: AddedExpert[] }) {
  return (
    <ul className="space-y-2">
      {results.map((r, i) => {
        const failed = r.outcome.kind === 'mql5' && !r.outcome.result.ok ? r.outcome.result : null;
        return (
          <li key={i} className={`rounded-xl border px-3.5 py-2.5 text-xs ${failed || !r.id ? 'border-loss/40 bg-loss/[0.07]' : 'border-profit/30 bg-profit/[0.05]'}`}>
            <p className={`font-semibold ${failed || !r.id ? 'text-loss' : 'text-profit'}`}>
              {r.fileName}
              {' — '}
              {failed
                ? 'did not compile, so it was not added'
                : !r.id
                  ? 'not added'
                  : r.outcome.kind === 'mql5'
                    ? `added, ${r.outcome.result.ok ? r.outcome.result.inputs.length : 0} input(s)`
                    : 'added — mirrored from your MetaTrader'}
            </p>
            {failed && (
              <ul className="tabular mt-1.5 max-h-40 space-y-1 overflow-auto text-[0.6875rem] text-[var(--color-ink-dim)]">
                {failed.diagnostics
                  .filter((d) => d.severity === 'error')
                  .map((d, j) => (
                    <li key={j}>
                      <span className="text-loss">error</span> {d.file}:{d.line} — {d.message}
                    </li>
                  ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The built-in model and the EA library, changeable at any time. Any number
 * of EAs can be kept; every one switched on runs on the master at the same
 * time as the others (and the built-in model, unless it is off), each with
 * its own inputs, and each OrderSend still reaches every follower at once.
 */
export function StrategyCard() {
  const { experts, stats, config } = useTerminal();
  const running = stats?.running ?? false;
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [results, setResults] = useState<AddedExpert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const on = experts.filter((e) => e.enabled);
  const hasAngel = experts.some((e) => isAngelBot(e.fileName));

  const add = async (files: StrategyFile[], options?: { enabled?: boolean }) => {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const added = await api.addExperts(files, options);
      setResults(added);
      const ok = added.filter((a) => a.id);
      if (ok.length > 0) toast(`${ok.length} EA${ok.length > 1 ? 's' : ''} added${running && options?.enabled !== false ? ' and started' : ''}`);
      if (ok.length < added.length) toast(`${added.length - ok.length} file(s) did not compile`, 'error');
      if (ok.length === 1) setOpenId(ok[0]!.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The files could not be added');
    } finally {
      setBusy(false);
    }
  };

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const accepted = [...list].filter((f) => /\.(mq5|mqh|ex5)$/i.test(f.name));
    if (accepted.length === 0) {
      setError('Choose .mq5 or .ex5 files (and any .mqh headers the .mq5 files include).');
      return;
    }
    await add(await Promise.all(accepted.map(readStrategyFile)));
  };

  return (
    <Card
      title="Strategy"
      subtitle="The built-in model and your EA library — change either any time"
      actions={
        <div className="flex items-center gap-1.5">
          <Chip tone="gold">{config.strategy === 'none' ? 'EAs only' : config.strategy === 'ai' ? 'AI' : config.strategy === 'burst' ? 'Burst' : config.strategy}</Chip>
          <Chip tone={on.length > 0 ? 'profit' : 'neutral'}>{on.length} EA{on.length === 1 ? '' : 's'} on</Chip>
        </div>
      }
      bodyClass="p-4 space-y-5"
    >
      <BuiltinSwitch />

      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label !mb-0">EA library</p>
          <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">
            {experts.length === 0 ? 'Empty' : `${experts.length} kept · ${on.length} switched on${on.length > 1 ? ' — they run together' : ''}`}
          </p>
        </div>

        <div
          className="dropzone flex flex-col items-center justify-center gap-2 px-4 py-5 text-center"
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
          <p className="text-sm font-semibold text-ink">Drop EAs here — as many as you like</p>
          <p className="max-w-md text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">
            Several .mq5 files at once (with the .mqh headers they include), and compiled .ex5 files. Each becomes its own EA, switched on;
            every EA switched on runs on the master together, and each order still goes to every follower in the same instant.
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

        {error && <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">{error}</p>}
        {results && <UploadResults results={results} />}

        {experts.length > 0 ? (
          <ul className="space-y-2">
            {experts.map((slot) => (
              <ExpertRow key={slot.id} slot={slot} botRunning={running} open={openId === slot.id} onToggleOpen={() => setOpenId((id) => (id === slot.id ? null : slot.id))} />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-[var(--color-line)] px-3.5 py-4 text-center text-xs text-[var(--color-ink-muted)]">
            No EAs yet. Drop your .mq5 or .ex5 files above, or add one of these.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {!hasAngel && (
            <button className="btn btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => void add([ANGEL_BOT], { enabled: false })}>
              Add Angel Bot
            </button>
          )}
          <button
            className="btn btn-ghost px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() => void add([{ name: 'Sentinal.mq5', content: sampleExpert, encoding: 'text' }], { enabled: false })}
          >
            Add sample EA
          </button>
        </div>
      </div>
    </Card>
  );
}
