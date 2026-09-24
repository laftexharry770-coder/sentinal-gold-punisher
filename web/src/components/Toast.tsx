import { useEffect, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener(items);
}

/** Shows a short confirmation at the bottom of the screen. */
export function toast(text: string, tone: ToastTone = 'success', ms = 2600): void {
  const item: ToastItem = { id: (seq += 1), tone, text };
  items = [...items.slice(-2), item];
  publish();
  setTimeout(() => {
    items = items.filter((i) => i.id !== item.id);
    publish();
  }, ms);
}

const ICON: Record<ToastTone, ReactNode> = {
  success: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] shrink-0" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="#101216" />
      <path d="m6.2 10.3 2.4 2.4 5.2-5.3" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] shrink-0" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="#d93a5b" />
      <path d="M10 5.6v5.2M10 14.1v.1" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] shrink-0" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="#101216" />
      <path d="M10 9v5M10 5.9v.1" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

/** The stack of toasts; mounted once at the root of the app. */
export function Toaster() {
  const [shown, setShown] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setShown);
    return () => {
      listeners.delete(setShown);
    };
  }, []);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6"
    >
      {shown.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`} role="status">
          {ICON[item.tone]}
          <span className="min-w-0 truncate">{item.text}</span>
        </div>
      ))}
    </div>
  );
}
