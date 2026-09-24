import { useEffect, useState } from 'react';
import { api, type SavedStrategyInfo } from '../api';
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

type Choice = 'burst' | 'ea';

/**
 * Burst or the uploaded EA — whichever the operator picks, at any time. The
 * EA stays saved while Burst trades, so switching back needs no upload.
 */
export function StrategySwitch({ compact = false }: { compact?: boolean }) {
  const { config, stats, strategy } = useTerminal();
  const [saved, refresh] = useSavedStrategy();
  const [busy, setBusy] = useState<Choice | null>(null);
  const running = stats?.running ?? false;

  const current: Choice | 'other' =
    config.source === 'builtin' ? (config.strategy === 'burst' ? 'burst' : 'other') : 'ea';

  const choose = async (choice: Choice) => {
    if (choice === current) return;
    if (running && !window.confirm('Switching strategy stops the bot. Open positions stay open. Switch now?')) return;
    setBusy(choice);
    try {
      if (choice === 'burst') {
        await api.useBuiltinStrategy('burst');
        toast('Burst strategy selected');
      } else {
        const outcome = await api.useSavedStrategy();
        if (outcome.kind === 'mql5' && !outcome.result.ok) toast(`${saved?.fileName ?? 'The EA'} did not compile`, 'error');
        else toast(`${saved?.fileName ?? 'EA'} selected`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not switch', 'error');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const eaName = strategy?.source !== 'builtin' && strategy?.fileName ? strategy.fileName : saved?.fileName ?? null;
  const options: { id: Choice; label: string; hint: string; disabled?: boolean }[] = [
    { id: 'burst', label: 'Burst', hint: 'like the video' },
    {
      id: 'ea',
      label: eaName ?? 'Your EA',
      hint: eaName ? (saved?.kind === 'ex5' || strategy?.source === 'mirror' ? '.ex5 · mirror' : 'uploaded .mq5') : 'upload in Settings',
      disabled: !eaName,
    },
  ];

  return (
    <div className={compact ? '' : 'space-y-1.5'}>
      {!compact && <p className="label">Strategy in use</p>}
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Strategy in use">
        {options.map((o) => {
          const active = current === o.id;
          return (
            <button
              key={o.id}
              role="radio"
              aria-checked={active}
              disabled={o.disabled || busy !== null}
              onClick={() => void choose(o.id)}
              className={`rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-45 ${
                active
                  ? 'border-[var(--color-flame)]/70 bg-[var(--color-flame)]/[0.08]'
                  : 'border-[var(--color-line)] bg-[#0e1116] hover:border-[#39404a]'
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-[var(--color-flame)]' : 'bg-[#4a4f57]'}`} />
                <span className="truncate text-sm font-semibold text-ink">{busy === o.id ? 'Switching…' : o.label}</span>
              </span>
              <span className="mt-0.5 block truncate pl-4 text-[0.6875rem] text-[var(--color-ink-muted)]">{o.hint}</span>
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
