import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Skeleton } from './Skeleton';

/**
 * Money figure with truthful labelling. Order is always amount > currency >
 * label; numerals are tabular so columns of stats do not jitter.
 */
export default function Stat({
  label,
  value,
  currency,
  sub,
  tone = 'default',
  loading,
  action,
  className,
}: {
  label: string;
  value: string | null | undefined;
  /** Truthful asset label: "USD claim", "USDC", "USDY". Never "USD" for a token balance. */
  currency?: string;
  sub?: ReactNode;
  tone?: 'default' | 'positive' | 'pending' | 'negative';
  loading?: boolean;
  action?: ReactNode;
  className?: string;
}) {
  const toneClass = {
    default: 'text-[var(--text)]',
    positive: 'text-[var(--ok-text)]',
    pending: 'text-[var(--warn-text)]',
    negative: 'text-[var(--error-text)]',
  }[tone];

  return (
    <div className={cn('grid gap-1', className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {loading || value == null ? (
          <Skeleton variant="money" />
        ) : (
          <span className={cn('whitespace-nowrap font-mono text-[22px] font-medium leading-none tabular-nums md:text-[24px]', toneClass)}>{value}</span>
        )}
        {currency ? (
          <span className="whitespace-nowrap font-mono text-[11px] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{currency}</span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10.5px] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">{label}</span>
        {action}
      </div>
      {sub ? <div className="text-[12px] text-[var(--text-muted)]">{sub}</div> : null}
    </div>
  );
}
