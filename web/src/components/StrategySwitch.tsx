import { useState } from 'react';
import type { BotConfig, ExpertSlot } from '@sentinal/shared';
import { api } from '../api';
import { useTerminal } from '../store';
import { toast } from './Toast';
import { Switch } from './ui';

type Builtin = 'burst' | 'ai' | 'none';

const CHOICES: { id: Builtin; label: string; hint: string }[] = [
  { id: 'burst', label: 'Burst', hint: 'like the video' },
  { id: 'ai', label: 'AI', hint: 'learns, then decides' },
  { id: 'none', label: 'Off', hint: 'EAs only' },
];

/**
 * The built-in model that trades beside the EAs: Burst, the AI, or none.
 * Changing it while the bot runs disarms it first — a new model never
 * inherits a running book.
 */
export function BuiltinSwitch({ compact = false }: { compact?: boolean }) {
  const { config, stats } = useTerminal();
  const [busy, setBusy] = useState<Builtin | null>(null);
  const running = stats?.running ?? false;
  const current: Builtin | 'other' = config.strategy === 'burst' || config.strategy === 'ai' || config.strategy === 'none' ? config.strategy : 'other';

  const choose = async (choice: Builtin) => {
    if (choice === current) return;
    if (running && !window.confirm('Changing the built-in model stops the bot. Open positions stay open. Change it now?')) return;
    setBusy(choice);
    try {
      await api.useBuiltinStrategy(choice as BotConfig['strategy']);
      toast(choice === 'none' ? 'Built-in model off — your EAs trade alone' : `${CHOICES.find((c) => c.id === choice)!.label} selected`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not switch', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={compact ? '' : 'space-y-1.5'}>
      {!compact && <p className="label">Built-in model</p>}
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Built-in model">
        {CHOICES.map((o) => {
          const active = current === o.id;
          return (
            <button
              key={o.id}
              role="radio"
              aria-checked={active}
              disabled={busy !== null}
              onClick={() => void choose(o.id)}
              title={o.label}
              className={`min-w-0 rounded-xl border px-2 py-2.5 text-left transition-colors disabled:opacity-45 sm:px-2.5 ${
                active
                  ? 'border-[var(--color-ice)]/70 bg-[var(--color-ice)]/[0.08]'
                  : 'border-[var(--color-line)] bg-[var(--color-well)] hover:border-[var(--color-line-strong)]'
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-[var(--color-ice)]' : 'bg-[var(--color-ink-faint)]'}`} />
                <span className="truncate text-[0.8125rem] font-semibold text-ink sm:text-sm">{busy === o.id ? 'Switching…' : o.label}</span>
              </span>
              <span className="mt-0.5 block truncate text-[0.6875rem] text-[var(--color-ink-muted)] sm:pl-4">{o.hint}</span>
            </button>
          );
        })}
      </div>
      {current === 'other' && (
        <p className="text-[0.6875rem] text-[var(--color-ink-muted)]">A different built-in model is selected in Settings ({config.strategy}).</p>
      )}
    </div>
  );
}

const DOT: Record<ExpertSlot['info']['status'], string> = {
  running: 'bg-profit live-dot',
  waiting: 'bg-warn',
  idle: 'bg-[var(--color-ink-faint)]',
  stopped: 'bg-[var(--color-ink-faint)]',
  failed: 'bg-loss',
};

/** The EAs, each with its own switch — started or stopped at once, even while the bot runs. */
export function ExpertSwitches({ limit = 6, onManage }: { limit?: number; onManage?: () => void }) {
  const { experts, stats } = useTerminal();
  const [busy, setBusy] = useState<string | null>(null);
  const running = stats?.running ?? false;
  const shown = experts.slice(0, limit);

  const toggle = async (slot: ExpertSlot, enabled: boolean) => {
    setBusy(slot.id);
    try {
      await api.setExpertEnabled(slot.id, enabled);
      toast(`${slot.info.name} ${enabled ? (running ? 'started' : 'on — runs with the bot') : 'off'}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not switch it', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[0.75rem] font-semibold text-[var(--color-ink-dim)]">Expert advisors</p>
        {onManage && (
          <button className="text-[0.6875rem] font-semibold text-[var(--color-ink-muted)] underline decoration-[var(--color-ice)]/50 underline-offset-4" onClick={onManage}>
            {experts.length === 0 ? 'Add EAs' : 'Manage'}
          </button>
        )}
      </div>
      {experts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] px-3 py-2.5 text-[0.75rem] text-[var(--color-ink-muted)]">
          No EAs in the library — add as many .mq5 or .ex5 files as you like in Settings.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]/70 rounded-xl border border-[var(--color-line)] bg-[var(--color-well)]">
          {shown.map((slot) => (
            <li key={slot.id} className="flex items-center gap-3 px-3 py-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${slot.enabled ? DOT[slot.info.status] : 'bg-[var(--color-ink-faint)]'}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.8125rem] font-semibold text-ink">{slot.info.name}</span>
                <span className={`block truncate text-[0.6875rem] ${slot.info.status === 'failed' ? 'text-loss' : 'text-[var(--color-ink-muted)]'}`}>
                  {slot.info.status === 'failed'
                    ? slot.info.detail ?? 'stopped with an error'
                    : !slot.enabled
                      ? slot.kind === 'ex5'
                        ? '.ex5 · off'
                        : 'off'
                      : slot.kind === 'ex5'
                        ? running
                          ? 'copying from your MetaTrader'
                          : '.ex5 · on'
                        : slot.info.status === 'running'
                          ? `running · ${slot.info.ticks.toLocaleString()} ticks`
                          : running
                            ? 'starting…'
                            : 'on — runs with the bot'}
                </span>
              </span>
              <Switch checked={slot.enabled} disabled={busy !== null} label={`Run ${slot.info.name}`} onChange={(v) => void toggle(slot, v)} />
            </li>
          ))}
          {experts.length > shown.length && (
            <li className="px-3 py-2 text-[0.6875rem] text-[var(--color-ink-muted)]">+{experts.length - shown.length} more in Settings</li>
          )}
        </ul>
      )}
    </div>
  );
}

/** The Control screen's strategy block: the built-in model, then the EAs beside it. */
export function StrategySwitch({ onManage }: { onManage?: () => void }) {
  return (
    <div className="space-y-3">
      <BuiltinSwitch compact />
      <ExpertSwitches onManage={onManage} />
    </div>
  );
}
