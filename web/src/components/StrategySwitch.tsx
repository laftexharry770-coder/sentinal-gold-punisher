import { useEffect, useState } from 'react';
import { api, type SavedStrategyInfo } from '../api';
import { ANGEL_BOT, isAngelBot } from '../bundledStrategies';
import { useTerminal } from '../store';
import { toast } from './Toast';

/** The uploaded EA kept in storage, refreshed whenever the strategy changes. */
export function useSavedStrategy(): [SavedStrategyInfo | null, () => void] {
  const { strategy } = useTerminal();
  const [saved, setSaved] = useState<SavedStrategyInfo | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void api
      .savedStrategy()
      .then((s) => !cancelled && setSaved(s))
      .catch(() => !cancelled && setSaved(null));
    return () => {
      cancelled = true;
    };
  }, [strategy?.source, strategy?.fileName, strategy?.loadedAt, nonce]);
  return [saved, () => setNonce((n) => n + 1)];
}

type Choice = 'burst' | 'angel' | 'ea';

/**
 * Burst, Angel Bot or the uploaded EA — whichever the operator picks, at any
 * time. The EA stays saved while Burst trades, so switching back needs no
 * upload; Angel Bot ships with the terminal and needs none at all.
 */
export function StrategySwitch({ compact = false }: { compact?: boolean }) {
  const { config, stats, strategy } = useTerminal();
  const [saved, refresh] = useSavedStrategy();
  const [busy, setBusy] = useState<Choice | null>(null);
  const running = stats?.running ?? false;

  const current: Choice | 'other' =
    config.source === 'builtin'
      ? config.strategy === 'burst'
        ? 'burst'
        : 'other'
      : config.source === 'mql5' && isAngelBot(strategy?.fileName)
        ? 'angel'
        : 'ea';

  // The EA slot shows the operator's own upload; Angel Bot has its own button.
  const eaName =
    strategy?.source !== 'builtin' && strategy?.fileName && !isAngelBot(strategy.fileName)
      ? strategy.fileName
      : saved && !isAngelBot(saved.fileName)
        ? saved.fileName
        : null;

  const choose = async (choice: Choice) => {
    if (choice === current) return;
    const notes: string[] = [];
    if (running) notes.push('Switching strategy stops the bot. Open positions stay open.');
    if (choice === 'angel' && eaName) notes.push(`Angel Bot takes the place of ${eaName} as your saved EA — upload ${eaName} again to go back to it.`);
    if (notes.length > 0 && !window.confirm(`${notes.join('\n\n')}\n\nSwitch now?`)) return;
    setBusy(choice);
    try {
      if (choice === 'burst') {
        await api.useBuiltinStrategy('burst');
        toast('Burst strategy selected');
      } else if (choice === 'angel') {
        // Always the bundled copy: it carries the fix v1.10 lacks. Inputs set
        // for an Angel Bot saved earlier come along.
        const inputs = saved && isAngelBot(saved.fileName) ? config.expertInputs : {};
        const outcome = await api.loadStrategy([ANGEL_BOT]);
        if (outcome.kind === 'mql5' && !outcome.result.ok) {
          toast('Angel Bot did not compile', 'error');
        } else {
          if (Object.keys(inputs).length > 0) await api.configureExpert({ inputs, timeframe: config.expertTimeframe });
          toast('Angel Bot selected');
        }
      } else {
        const outcome = await api.useSavedStrategy();
        if (outcome.kind === 'mql5' && !outcome.result.ok) toast(`${eaName ?? 'The EA'} did not compile`, 'error');
        else toast(`${eaName ?? 'EA'} selected`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not switch', 'error');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const options: { id: Choice; label: string; hint: string; disabled?: boolean }[] = [
    { id: 'burst', label: 'Burst', hint: 'like the video' },
    { id: 'angel', label: 'Angel Bot', hint: 'stop brackets' },
    {
      id: 'ea',
      label: eaName ?? 'Your EA',
      hint: eaName
        ? saved?.kind === 'ex5' || (current === 'ea' && strategy?.source === 'mirror')
          ? '.ex5 · mirror'
          : 'uploaded .mq5'
        : 'none uploaded',
      disabled: !eaName,
    },
  ];

  return (
    <div className={compact ? '' : 'space-y-1.5'}>
      {!compact && <p className="label">Strategy in use</p>}
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Strategy in use">
        {options.map((o) => {
          const active = current === o.id;
          return (
            <button
              key={o.id}
              role="radio"
              aria-checked={active}
              disabled={o.disabled || busy !== null}
              onClick={() => void choose(o.id)}
              title={o.label}
              className={`min-w-0 rounded-xl border px-2 py-2.5 text-left transition-colors disabled:opacity-45 sm:px-2.5 ${
                active
                  ? 'border-[var(--color-flame)]/70 bg-[var(--color-flame)]/[0.08]'
                  : 'border-[var(--color-line)] bg-[#0e1116] hover:border-[#39404a]'
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-[var(--color-flame)]' : 'bg-[#4a4f57]'}`} />
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
