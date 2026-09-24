import type { ReactNode } from 'react';
import { useTheme, type ThemePref } from '../theme';

const Sun = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
    <circle cx="10" cy="10" r="3.4" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10 2.5v1.6M10 15.9v1.6M17.5 10h-1.6M4.1 10H2.5M15.3 4.7l-1.1 1.1M5.8 14.2l-1.1 1.1M15.3 15.3l-1.1-1.1M5.8 5.8 4.7 4.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const Moon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
    <path d="M16.2 12.3A6.6 6.6 0 0 1 7.7 3.8a6.6 6.6 0 1 0 8.5 8.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);
const Monitor = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
    <rect x="2.8" y="3.8" width="14.4" height="9.6" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
    <path d="M7.5 16.5h5M10 13.4v3.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/** One button: flips between light and dark. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [, setPref, theme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className={`btn btn-ghost h-9 w-9 p-0 ${className}`} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => setPref(next)}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}

const OPTIONS: { value: ThemePref; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'System', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
];

/** System, light or dark — System follows the device. */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const [pref, setPref] = useTheme();
  return (
    <div className="flex rounded-xl border border-[var(--color-line)] bg-[var(--color-well)] p-1" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={pref === o.value}
          title={o.label}
          onClick={() => setPref(o.value)}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${
            pref === o.value ? 'segment-on' : 'text-[var(--color-ink-muted)] hover:text-ink'
          }`}
        >
          {o.icon}
          {!compact && o.label}
        </button>
      ))}
    </div>
  );
}
