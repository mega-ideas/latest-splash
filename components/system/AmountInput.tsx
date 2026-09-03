'use client';

import { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * Money input: 16px minimum so iOS never zooms, decimal keyboard, tabular
 * numerals, visible label, helper below, error below the field.
 */
export default function AmountInput({
  label,
  value,
  onChange,
  currency = 'USD',
  helper,
  error,
  placeholder = '0.00',
  disabled,
  autoFocus,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  currency?: string;
  helper?: string;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  return (
    <div className={cn('grid gap-2', className)}>
      <label htmlFor={id} className="text-[14px] font-semibold text-[var(--text)]">
        {label}
      </label>
      <div
        className={cn(
          'flex h-14 items-center gap-3 rounded-[var(--r-sm)] border bg-[var(--surface)] px-4 transition-colors duration-[var(--dur-ui)]',
          'focus-within:border-[var(--teal-600)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--teal-500)]',
          error ? 'border-[var(--error)]' : 'border-[var(--line)]',
          disabled && 'opacity-60',
        )}
      >
        <span className="font-mono text-[13px] font-medium uppercase tracking-[0.04em] text-[var(--text-muted)]">{currency}</span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ''))}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : helper ? helperId : undefined}
          className="min-w-0 flex-1 bg-transparent text-right font-sans text-[24px] font-semibold tabular-nums text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-[13px] font-medium text-[var(--error-text)]">
          {error}
        </p>
      ) : helper ? (
        <p id={helperId} className="text-[13px] text-[var(--text-muted)]">
          {helper}
        </p>
      ) : null}
    </div>
  );
}
