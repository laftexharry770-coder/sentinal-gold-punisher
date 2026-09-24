import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'sentinal.theme.v1';
const listeners = new Set<() => void>();

export function themePref(): ThemePref {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const pref = raw ? (JSON.parse(raw) as unknown) : 'system';
    return pref === 'light' || pref === 'dark' ? pref : 'system';
  } catch {
    return 'system';
  }
}

function systemTheme(): Theme {
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(pref: ThemePref = themePref()): Theme {
  return pref === 'system' ? systemTheme() : pref;
}

/** Puts the theme on the page: the data-theme attribute every colour reads, and the browser chrome. */
export function applyTheme(pref: ThemePref = themePref()): void {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f2f4f8' : '#0a0d12');
  for (const listener of listeners) listener();
}

export function setThemePref(pref: ThemePref): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(pref));
  } catch {
    /* private window: the choice lasts this visit */
  }
  applyTheme(pref);
}

/** Follows the device when the preference is System. */
export function watchSystemTheme(): () => void {
  const query = globalThis.matchMedia?.('(prefers-color-scheme: light)');
  if (!query) return () => undefined;
  const onChange = () => {
    if (themePref() === 'system') applyTheme('system');
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** The preference, a setter, and the theme it resolves to right now. */
export function useTheme(): [ThemePref, (pref: ThemePref) => void, Theme] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return [themePref(), setThemePref, resolveTheme()];
}
