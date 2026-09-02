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
    positive: 'text-[var(--ok)]',
    pending: 'text-[var(--warn)]',
    negative: 'text-[var(--error)]',
  }[tone];

  return (
    <div className={cn('grid gap-1', className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {loading || value == null ? (
          <Skeleton variant="money" />
        ) : (
          <span className={cn('whitespace-nowrap font-sans text-[24px] font-semibold leading-none tabular-nums tracking-[-0.02em] md:text-[28px]', toneClass)}>{value}</span>
        )}
        {currency ? (
          <span className="whitespace-nowrap font-mono text-[12px] font-medium uppercase tracking-[0.04em] text-[var(--text-muted)]">{currency}</span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium tracking-[0.01em] text-[var(--text-2)]">{label}</span>
        {action}
      </div>
      {sub ? <div className="text-[13px] text-[var(--text-muted)]">{sub}</div> : null}
    </div>
  );
}
