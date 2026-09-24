/** The shield mark and wordmark, used by the shell and the sign-in screen. */
export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-11 w-11 rounded-[13px]' : 'h-9 w-9 rounded-[11px]';
  return (
    <div className="flex items-center gap-3">
      <div className={`relative grid shrink-0 place-items-center bg-[var(--color-ice)] text-[var(--color-on-ice)] ${box}`}>
        <svg viewBox="0 0 24 24" fill="none" className={size === 'lg' ? 'h-6 w-6' : 'h-5 w-5'} aria-hidden="true">
          <path d="M12 3 5.2 5.7v5.8c0 4.1 2.8 7.8 6.8 9 4-1.2 6.8-4.9 6.8-9V5.7L12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M8.8 12.3 11 14.5l4.3-4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="leading-tight">
        <p className={`flex items-center gap-1.5 font-semibold tracking-[-0.01em] text-ink ${size === 'lg' ? 'text-lg' : 'text-[0.9375rem]'}`}>
          Sentinal
          <span className="rounded-md border border-[var(--color-line-strong)] px-1 py-px text-[0.625rem] font-semibold leading-none text-[var(--color-ink-dim)]">MT5</span>
        </p>
        <p className="text-[0.71875rem] text-[var(--color-ink-muted)]">Gold Punisher</p>
      </div>
    </div>
  );
}
