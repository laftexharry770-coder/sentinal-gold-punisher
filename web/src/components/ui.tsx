import type { ReactNode } from 'react';
import { formatMoney } from '@sentinal/shared';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClass = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={`card flex min-h-0 flex-col ${className}`}>
      {/* Header actions wrap under the title when the row runs out of room. */}
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
          <div className="min-w-0 flex-1 basis-40">
            {title && <h2 className="truncate text-[0.8125rem] font-semibold tracking-wide text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 truncate text-xs text-[var(--color-ink-muted)]">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClass || 'p-4'}`}>{children}</div>
    </section>
  );
}

export function Chip({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'cobalt' | 'profit' | 'loss' | 'gold' | 'warn';
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: 'border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-ink-dim)]',
    cobalt: 'border-cobalt/40 bg-cobalt/12 text-[var(--color-cobalt-bright)]',
    profit: 'border-profit/40 bg-profit/12 text-profit',
    loss: 'border-loss/40 bg-loss/12 text-loss',
    gold: 'border-gold/40 bg-gold/12 text-gold',
    warn: 'border-warn/40 bg-warn/12 text-warn',
  };
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'profit' | 'loss' | 'cobalt' | 'gold';
  icon?: ReactNode;
}) {
  const colors: Record<string, string> = {
    neutral: 'text-ink',
    profit: 'text-profit',
    loss: 'text-loss',
    cobalt: 'text-[var(--color-cobalt-bright)]',
    gold: 'text-gold',
  };
  return (
    <div className="card-flush px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-muted)]">
          {label}
        </span>
        {icon}
      </div>
      <div className={`tabular mt-1.5 text-[1.35rem] font-semibold leading-none ${colors[tone]}`}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-[var(--color-ink-muted)]">{sub}</div>}
    </div>
  );
}

export function Money({ value, showSign = true }: { value: number; showSign?: boolean }) {
  const tone = value > 0 ? 'text-profit' : value < 0 ? 'text-loss' : 'text-[var(--color-ink-dim)]';
  const sign = showSign && value > 0 ? '+' : '';
  return <span className={`tabular ${tone}`}>{`${sign}${formatMoney(value)}`}</span>;
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start justify-between gap-4 rounded-xl border border-[var(--color-line)] bg-[#0a1220] px-3.5 py-3 ${
        disabled ? 'opacity-50' : 'cursor-pointer hover:border-[#294066]'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-[var(--color-ink-muted)]">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-cobalt bg-cobalt/80' : 'border-[var(--color-line)] bg-[#16233b]'
        }`}
      >
        <span
          className="absolute rounded-full bg-white transition-all"
          style={{ height: 18, width: 18, left: checked ? 22 : 2, top: 2 }}
        />
      </button>
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  step = 0.01,
  min,
  max,
  suffix,
  hint,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="relative">
        <input
          type="number"
          className="field tabular pr-12"
          value={value ?? ''}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-[var(--color-ink-muted)]">
            {suffix}
          </span>
        )}
      </div>
      {hint && <p className="mt-1 text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">{hint}</p>}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type={type}
        className="field"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="mt-1 text-[0.6875rem] leading-snug text-[var(--color-ink-muted)]">{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div>
      {label && <span className="label">{label}</span>}
      <div className="flex rounded-xl border border-[var(--color-line)] bg-[#0a1220] p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${
              option.value === value
                ? 'bg-cobalt text-white shadow-[0_8px_20px_-12px_rgba(59,130,246,0.9)]'
                : 'text-[var(--color-ink-muted)] hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      {icon}
      <p className="text-sm font-medium text-[var(--color-ink-dim)]">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-[var(--color-ink-muted)]">{hint}</p>}
    </div>
  );
}
