'use client';

import { cn } from '@/lib/utils';

export type PillOption<T extends string> = { value: T; label: string };

/**
 * Segmented pill toggle: white group, active segment white-on-ink. Buttons
 * carry aria-pressed so screen readers hear the state; arrow keys move
 * between segments.
 */
export default function PillToggle<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex rounded-[var(--r-pill)] border border-[var(--line)] bg-[var(--surface)] p-1', className)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const index = options.findIndex((option) => option.value === value);
        const next = event.key === 'ArrowRight' ? (index + 1) % options.length : (index - 1 + options.length) % options.length;
        onChange(options[next].value);
        event.preventDefault();
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-[36px] rounded-[var(--r-pill)] px-4 text-[14px] font-semibold transition-colors duration-[var(--dur-ui)] ease-[var(--ease-out)]',
              'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]',
              active ? 'bg-[var(--signal)] text-[var(--signal-contrast)]' : 'text-[var(--text-2)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
