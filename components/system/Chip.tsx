import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Mono chip for infrastructure and module names (payment_intent, Pyth, Walrus). */
export default function Chip({
  children,
  className,
  tone = 'default',
  ghost,
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'teal' | 'green';
  /** De-emphasised placeholder ("more corridors"): dashed border and muted text, still AA-readable. */
  ghost?: boolean;
}) {
  const toneClass = {
    default: 'border-[var(--line)] bg-[var(--surface)] text-[var(--text-2)]',
    teal: 'border-[var(--teal-300)] bg-[var(--surface)] text-[var(--teal-700)]',
    green: 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok-text)]',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[var(--r-pill)] border px-2 py-[3px] font-mono text-[12px] leading-none tracking-[0.02em]',
        toneClass,
        ghost && 'border-dashed bg-transparent text-[var(--text-muted)]',
        className,
      )}
    >
      {children}
    </span>
  );
}
