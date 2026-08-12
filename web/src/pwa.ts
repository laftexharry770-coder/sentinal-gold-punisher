/**
 * Installable-app plumbing.
 *
 * Registration is deliberately conditional: the same bundle is also published
 * as a single self-contained file with no sibling sw.js, and a service worker
 * cannot be registered from file:// at all. Both cases would only produce a
 * console error, so they are skipped.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!location.protocol.startsWith('http')) return;
  // The manifest link is stripped from the single-file build, so its presence
  // marks the hosted variant that actually ships a worker.
  if (!document.querySelector('link[rel="manifest"]')) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(new URL('sw.js', location.href), { scope: './' }).catch(() => {
      /* offline support is an enhancement — the app runs fine without it */
    });
  });
}

export interface InstallPrompt {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type InstallListener = (available: boolean) => void;

let deferred: InstallPrompt | null = null;
const listeners = new Set<InstallListener>();

function announce(): void {
  for (const listener of listeners) listener(deferred !== null);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Holding the event lets the app offer installation in its own UI.
    event.preventDefault();
    deferred = event as unknown as InstallPrompt;
    announce();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    announce();
  });
}

export function onInstallAvailability(listener: InstallListener): () => void {
  listeners.add(listener);
  listener(deferred !== null);
  return () => listeners.delete(listener);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  announce();
  return outcome === 'accepted';
}

/** True when the app is running in its own window rather than a browser tab. */
export function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}
